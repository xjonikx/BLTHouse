/* Atmosphere realtime via Supabase (WebSocket). Game queue stays on Cloudflare Worker. */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function enabled() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  let client = null;
  let channel = null;
  let houseId = "";
  let onUpdate = null;

  function getClient() {
    if (!enabled()) return null;
    if (client) return client;
    const c = cfg();
    client = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 40 } },
    });
    return client;
  }

  function applyPresenceState(state) {
    const actors = {};
    Object.keys(state || {}).forEach((key) => {
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
    const actors = applyPresenceState(channel.presenceState());
    onUpdate({ kind: "actors", actors });
  }

  window.BLTHouseRealtime = {
    enabled,

    async connect(hid, handlers) {
      onUpdate = handlers && handlers.onUpdate;
      houseId = hid || "";
      await this.disconnect();
      if (!enabled() || !houseId) return false;

      const sb = getClient();
      const twitch = window.BLTHouseTwitch || {};
      const login = (twitch.user && twitch.user.login) || "";
      const display = (twitch.user && twitch.user.display) || login;

      channel = sb.channel("blt-house:" + houseId, {
        config: {
          broadcast: { self: true, ack: false },
          presence: { key: login || ("guest-" + Math.random().toString(16).slice(2, 8)) },
        },
      });

      channel.on("broadcast", { event: "flavor" }, ({ payload }) => {
        if (onUpdate) onUpdate({ kind: "flavor", event: payload });
      });

      channel.on("broadcast", { event: "layout" }, ({ payload }) => {
        if (onUpdate) onUpdate({ kind: "layout", layout: payload });
      });

      channel.on("presence", { event: "sync" }, () => emitActors());
      channel.on("presence", { event: "join" }, () => emitActors());
      channel.on("presence", { event: "leave" }, () => emitActors());

      await new Promise((resolve) => {
        channel.subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            if (login) {
              await channel.track({
                login,
                display,
                pose: "here",
                object: "",
                room: "",
                ts: Date.now(),
              });
            }
            resolve(true);
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            resolve(false);
          }
        });
      });

      emitActors();
      return true;
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
        login,
        display,
        pose: "here",
        object: "",
        room: "",
        text: "",
        x: null,
        y: null,
        ts: Date.now(),
        id: payload.eventId || payload.id || ("e" + Date.now()),
      }, payload || {});
      if (payload && payload.eventId) row.id = payload.eventId;

      // Presence.track is rate-limited on Free — still track on real moves (x/y change)
      // so other clients see position via presence sync, not only broadcast.
      const now = Date.now();
      const posChanged =
        (row.x != null && row.x !== this._lastTrackX) ||
        (row.y != null && row.y !== this._lastTrackY);
      const shouldTrack =
        payload.idle === true ||
        !this._lastTrackAt ||
        now - this._lastTrackAt > 8000 ||
        this._lastTrackPose !== row.pose ||
        (posChanged && now - (this._lastTrackAt || 0) > 1500);
      if (shouldTrack) {
        this._lastTrackAt = now;
        this._lastTrackPose = row.pose;
        this._lastTrackX = row.x;
        this._lastTrackY = row.y;
        try {
          await channel.track({
            login,
            display,
            pose: row.pose,
            object: row.object || "",
            room: row.room || "",
            x: row.x,
            y: row.y,
            ts: row.ts,
          });
        } catch (e) {
          /* presence throttle — broadcast still OK */
        }
      }

      if (payload.idle === true || row.pose === "here") {
        // Idle still broadcasts nothing heavy; emit local actors. For "here" after walk, also broadcast coords once.
        if (row.x != null && row.y != null && payload.idle === true) {
          try {
            await channel.send({
              type: "broadcast",
              event: "flavor",
              payload: {
                id: row.id || ("here-" + now),
                login,
                display,
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
        login,
        display,
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
      const row = Object.assign({ ts: Date.now(), houseId }, payload || {});
      await channel.send({ type: "broadcast", event: "layout", payload: row });
      return { ok: true, layout: row };
    },
  };
})();
