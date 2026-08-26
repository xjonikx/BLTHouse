/* Atmosphere realtime — SEPARATE Supabase project (own WebSocket / GoTrueClient).
 * Live people: Presence over WebSocket (channel.track).
 * Durable furniture + last poses: SQL tables + postgres_changes over WebSocket.
 * Never uses channel.send() broadcast (that path falls back to REST and spams warnings). */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};
  const SUBSCRIBE_TIMEOUT_MS = 12000;
  const ACTOR_UPSERT_MS = 400;

  function atmosphereUrl() {
    const c = cfg();
    return String(c.atmosphereSupabaseUrl || "").trim();
  }
  function atmosphereKey() {
    const c = cfg();
    return String(c.atmosphereSupabaseAnonKey || "").trim();
  }

  function enabled() {
    return !!(atmosphereUrl() && atmosphereKey() && window.supabase);
  }

  let client = null;
  let channel = null;
  let houseId = "";
  let onUpdate = null;
  let subscribed = false;
  let actorUpsertTimer = null;
  let pendingActorRow = null;

  function getClient() {
    if (!enabled()) return null;
    if (client) return client;
    client = window.supabase.createClient(atmosphereUrl(), atmosphereKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "blt-house-atmosphere-auth",
      },
      realtime: { params: { eventsPerSecond: 40 } },
    });
    return client;
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

  function emitLayoutFromRow(row) {
    if (!onUpdate || !row) return;
    onUpdate({
      kind: "layout",
      layout: {
        houseId: row.house_id,
        rev: Number(row.rev || 0) || Date.now(),
        ts: Number(row.rev || Date.now()),
        rooms: row.rooms || {},
      },
    });
  }

  async function loadLayoutFromSql() {
    const sb = getClient();
    if (!sb || !houseId) return null;
    const { data, error } = await sb
      .from("blt_atm_layout")
      .select("house_id,rev,rooms,updated_at")
      .eq("house_id", houseId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function upsertLayoutToSql(snap) {
    const sb = getClient();
    if (!sb || !houseId) throw new Error("atmosphere_not_ready");
    const rev = Number(snap.rev || snap.ts || Date.now()) || Date.now();
    const rooms = snap.rooms && typeof snap.rooms === "object" ? snap.rooms : {};
    const { data, error } = await sb
      .from("blt_atm_layout")
      .upsert(
        {
          house_id: houseId,
          rev: rev,
          rooms: rooms,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "house_id" }
      )
      .select("house_id,rev,rooms")
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function flushActorUpsert() {
    const row = pendingActorRow;
    pendingActorRow = null;
    actorUpsertTimer = null;
    if (!row || !houseId) return;
    const sb = getClient();
    if (!sb) return;
    try {
      await sb.from("blt_atm_actors").upsert(
        {
          house_id: houseId,
          login: String(row.login).toLowerCase(),
          display: row.display || row.login,
          pose: row.pose || "here",
          object: row.object || "",
          room: row.room || "",
          x: row.x != null ? Number(row.x) : null,
          y: row.y != null ? Number(row.y) : null,
          ts: Number(row.ts || Date.now()),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "house_id,login" }
      );
    } catch (e) {}
  }

  function scheduleActorUpsert(row) {
    pendingActorRow = row;
    if (actorUpsertTimer) return;
    actorUpsertTimer = setTimeout(function () {
      flushActorUpsert();
    }, ACTOR_UPSERT_MS);
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

      // Seed durable layout from SQL (furniture survives refresh / empty Presence).
      try {
        const layoutRow = await loadLayoutFromSql();
        if (layoutRow) emitLayoutFromRow(layoutRow);
        else if (onUpdate) {
          onUpdate({
            kind: "layout",
            layout: { houseId: houseId, rev: 0, ts: Date.now(), rooms: {}, empty: true },
          });
        }
      } catch (e) {
        // Tables missing until atmosphere.sql is applied — Presence still works.
      }

      subscribed = false;
      channel = sb.channel("blt-house-atm:" + houseId, {
        config: {
          presence: { key: login || "guest-" + Math.random().toString(16).slice(2, 8) },
        },
      });

      // Durable layout / actor rows → WebSocket (postgres_changes), not broadcast REST.
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "blt_atm_layout", filter: "house_id=eq." + houseId },
        function (payload) {
          const row = payload.new || payload.old;
          if (row && payload.eventType !== "DELETE") emitLayoutFromRow(row);
        }
      );

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
      if (actorUpsertTimer) {
        clearTimeout(actorUpsertTimer);
        actorUpsertTimer = null;
      }
      pendingActorRow = null;
      if (channel) {
        try { await channel.unsubscribe(); } catch (e) {}
        channel = null;
      }
    },

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
        // Persist last pose/xy (SQL). Live peers still get Presence WS.
        scheduleActorUpsert({
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

      // Local flavor toast (peers see pose via Presence sync — no broadcast REST).
      if (onUpdate && payload.idle !== true && row.pose && row.pose !== "here") {
        onUpdate({
          kind: "flavor",
          event: {
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
          },
        });
      }

      return { ok: true, idle: !!payload.idle };
    },

    async publishLayout(payload) {
      if (!houseId) throw new Error("realtime_not_connected");
      const row = await upsertLayoutToSql(
        Object.assign({ ts: Date.now(), houseId: houseId }, payload || {})
      );
      // Self-apply immediately; peers get postgres_changes over the same WS channel.
      if (row) emitLayoutFromRow(row);
      return { ok: true, layout: row };
    },

    async fetchLayout() {
      const row = await loadLayoutFromSql();
      return row
        ? { ok: true, houseId: row.house_id, rev: Number(row.rev || 0), rooms: row.rooms || {} }
        : { ok: true, houseId: houseId, rev: 0, rooms: {}, empty: true };
    },
  };
})();
