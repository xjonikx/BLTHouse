/* Atmosphere realtime via Supabase (shared client — one WebSocket). */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};
  const SUBSCRIBE_TIMEOUT_MS = 12000;

  function enabled() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  let channel = null;
  let houseId = "";
  let onUpdate = null;

  function getClient() {
    if (window.BLTHouseSupabaseGetClient) return window.BLTHouseSupabaseGetClient();
    if (!enabled()) return null;
    const c = cfg();
    return window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 12 } },
    });
  }

  function subscribeWithTimeout(ch, ms) {
    ms = ms || SUBSCRIBE_TIMEOUT_MS;
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (ok) {
        if (done) return;
        done = true;
        resolve(!!ok);
      };
      const timer = setTimeout(function () { finish(false); }, ms);
      ch.subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          finish(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          finish(false);
        }
      });
    });
  }

  function applyPresenceState(state) {
    const actors = {};
    Object.keys(state || {}).forEach(function (key) {
      const metas = (state[key] && state[key].metas) || [];
      const m = metas[metas.length - 1];
      if (!m || !m.login) return;
      actors[String(m.login).toLowerCase()] = {
        login: m.login,
        display: m.display || m.login,
        pose: m.pose || "here",
        object: m.object || "",
        room: m.room || "",
        x: m.x != null ? Number(m.x) : null,
        y: m.y != null ? Number(m.y) : null,
        ts: Number(m.ts || Date.now()),
      };
    });
    return actors;
  }

  function emitActors() {
    if (!onUpdate || !channel) return;
    onUpdate({ kind: "actors", actors: applyPresenceState(channel.presenceState()) });
  }

  window.BLTHouseRealtime = {
    enabled: enabled,

    async connect(hid, handlers) {
      onUpdate = handlers && handlers.onUpdate;
      houseId = hid || "";
      await this.disconnect();
      if (!enabled() || !houseId) return false;

      const sb = getClient();
      if (!sb) return false;

      const twitch = window.BLTHouseTwitch || {};
      const login = (twitch.user && twitch.user.login) || "";
      const display = (twitch.user && twitch.user.display) || login;

      channel = sb.channel("blt-house:" + houseId, {
        config: {
          broadcast: { self: true, ack: false },
          presence: { key: login || "guest-" + Math.random().toString(16).slice(2, 8) },
        },
      });

      channel.on("broadcast", { event: "flavor" }, function (msg) {
        if (onUpdate) onUpdate({ kind: "flavor", event: msg.payload });
      });

      channel.on("broadcast", { event: "layout" }, function (msg) {
        if (onUpdate) onUpdate({ kind: "layout", layout: msg.payload });
      });

      channel.on("presence", { event: "sync" }, function () { emitActors(); });
      channel.on("presence", { event: "join" }, function () { emitActors(); });
      channel.on("presence", { event: "leave" }, function () { emitActors(); });

      const ok = await subscribeWithTimeout(channel);
      if (ok && login) {
        try {
          await channel.track({
            login: login,
            display: display,
            pose: "here",
            object: "",
            room: "",
            ts: Date.now(),
          });
        } catch (e) {}
      }
      if (ok) emitActors();
      return ok;
    },

    async disconnect() {
      if (channel) {
        try { await channel.unsubscribe(); } catch (e) {}
        channel = null;
      }
    },

    async publishFlavor(payload) {
      if (!channel) throw new Error("realtime_not_connected");
      const twitch = window.BLTHouseTwitch || {};
      const login = (twitch.user && twitch.user.login) || "";
      if (!login) throw new Error("login_required");
      const display = twitch.user.display || login;
      const row = Object.assign({
        login: login,
        display: display,
        pose: "here",
        object: "",
        room: "",
        text: "",
        x: null,
        y: null,
        ts: Date.now(),
        id: payload.eventId || payload.id || "e" + Date.now(),
      }, payload || {});
      if (payload && payload.eventId) row.id = payload.eventId;

      const now = Date.now();
      const posChanged =
        (row.x != null && row.x !== this._lastTrackX) ||
        (row.y != null && row.y !== this._lastTrackY);
      const shouldTrack =
        payload.idle === true ||
        !this._lastTrackAt ||
        now - this._lastTrackAt > 2500 ||
        this._lastTrackPose !== row.pose ||
        (posChanged && now - (this._lastTrackAt || 0) > 400);
      if (shouldTrack) {
        this._lastTrackAt = now;
        this._lastTrackPose = row.pose;
        this._lastTrackX = row.x;
        this._lastTrackY = row.y;
        channel.track({
          login: login,
          display: display,
          pose: row.pose,
          object: row.object || "",
          room: row.room || "",
          x: row.x,
          y: row.y,
          ts: row.ts,
        }).catch(function () {});
      }

      if (payload.idle === true || row.pose === "here") {
        if (row.x != null && row.y != null && payload.idle === true) {
          try {
            await channel.send({
              type: "broadcast",
              event: "flavor",
              payload: {
                id: row.id || "here-" + now,
                login: login,
                display: display,
                pose: "here",
                object: "",
                room: row.room || "",
                x: row.x,
                y: row.y,
                text: display + " · здесь",
                ts: row.ts,
              },
            });
          } catch (e) {}
        }
        emitActors();
        return { ok: true, idle: true };
      }

      const msg = {
        id: row.id,
        login: login,
        display: display,
        pose: row.pose,
        object: row.object || "",
        room: row.room || "",
        x: row.x,
        y: row.y,
        text: row.text || (display + " · " + row.pose + (row.object ? " · " + row.object : "")),
        ts: row.ts,
      };
      await channel.send({ type: "broadcast", event: "flavor", payload: msg });
      return { ok: true, event: msg };
    },

    async publishLayout(payload) {
      if (!channel) throw new Error("realtime_not_connected");
      const row = Object.assign({ ts: Date.now(), houseId: houseId }, payload || {});
      await channel.send({ type: "broadcast", event: "layout", payload: row });
      return { ok: true, layout: row };
    },
  };
})();
