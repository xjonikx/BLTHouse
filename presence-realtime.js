/* Atmosphere realtime: Presence = sync plane; Broadcast = optional flavor log.
 * ALWAYS uses the single shared Supabase client from supabase-queue.js (one WebSocket). */
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
  let subscribed = false;

  function getClient() {
    // One GoTrueClient / one Realtime socket for the whole page.
    if (window.BLTHouseSupabaseGetClient) return window.BLTHouseSupabaseGetClient();
    return null;
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

  /** Fire-and-forget broadcast over WS only. Never await REST fallback (that freezes clicks). */
  function broadcastBestEffort(event, payload) {
    if (!channel || !subscribed) return;
    try {
      const p = channel.send({ type: "broadcast", event: event, payload: payload });
      if (p && typeof p.then === "function") p.catch(function () {});
    } catch (e) {}
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

      subscribed = false;
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
      subscribed = !!ok;
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
      subscribed = false;
      if (channel) {
        try { await channel.unsubscribe(); } catch (e) {}
        channel = null;
      }
    },

    /**
     * Sync plane = Presence.track (WS). Broadcast is optional flavor text only.
     * Never blocks on REST fallback — that was freezing floor/object clicks.
     */
    async publishFlavor(payload) {
      if (!channel || !subscribed) throw new Error("realtime_not_connected");
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
      const sameIdle =
        payload.idle === true &&
        this._lastTrackPose === row.pose &&
        row.x === this._lastTrackX &&
        row.y === this._lastTrackY &&
        this._lastTrackAt &&
        now - this._lastTrackAt < 2000;

      if (!sameIdle) {
        this._lastTrackAt = now;
        this._lastTrackPose = row.pose;
        this._lastTrackX = row.x;
        this._lastTrackY = row.y;
        await channel.track({
          login: login,
          display: display,
          pose: row.pose,
          object: row.object || "",
          room: row.room || "",
          x: row.x,
          y: row.y,
          ts: row.ts,
        });
      }

      emitActors();

      // Optional: flavor log / animate for peers. Presence already carries x/y/pose.
      if (payload.idle !== true && row.pose && row.pose !== "here") {
        broadcastBestEffort("flavor", {
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
        });
      }

      return { ok: true, idle: !!payload.idle };
    },

    async publishLayout(payload) {
      if (!channel || !subscribed) throw new Error("realtime_not_connected");
      const row = Object.assign({ ts: Date.now(), houseId: houseId }, payload || {});
      broadcastBestEffort("layout", row);
      return { ok: true, layout: row };
    },
  };
})();
