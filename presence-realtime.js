/* Atmosphere = SEPARATE Supabase project (own WebSocket).
 * Truth = SQL only (blt_atm_layout + blt_atm_actors).
 * Sync = postgres_changes only. No Presence, no poll, no broadcast REST. */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};
  const SUBSCRIBE_TIMEOUT_MS = 12000;
  const ACTOR_WRITE_MS = 120;

  function atmosphereUrl() {
    return String((cfg().atmosphereSupabaseUrl) || "").trim();
  }
  function atmosphereKey() {
    return String((cfg().atmosphereSupabaseAnonKey) || "").trim();
  }

  function enabled() {
    return !!(atmosphereUrl() && atmosphereKey() && window.supabase);
  }

  let client = null;
  let channel = null;
  let houseId = "";
  let onUpdate = null;
  let connected = false;
  let selfLogin = "";
  let actorWriteTimer = null;
  let pendingActor = null;

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

  function rowToActor(row) {
    if (!row || !row.login) return null;
    return {
      login: row.login,
      display: row.display || row.login,
      pose: row.pose || "here",
      object: row.object || "",
      room: row.room || "",
      x: row.x != null ? Number(row.x) : null,
      y: row.y != null ? Number(row.y) : null,
      ts: Number(row.ts || Date.now()),
      online: row.online !== false,
    };
  }

  function emitLayoutRow(row) {
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

  function emitActorRow(row) {
    if (!onUpdate || !row) return;
    const actor = rowToActor(row);
    if (!actor) return;
    onUpdate({ kind: "actor", actor: actor });
  }

  function emitActorsMap(rows) {
    if (!onUpdate) return;
    const actors = {};
    (rows || []).forEach(function (row) {
      const a = rowToActor(row);
      if (!a || !a.online) return;
      actors[String(a.login).toLowerCase()] = a;
    });
    onUpdate({ kind: "actors", actors: actors });
  }

  async function loadLayout() {
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

  async function loadOnlineActors() {
    const sb = getClient();
    if (!sb || !houseId) return [];
    const { data, error } = await sb
      .from("blt_atm_actors")
      .select("house_id,login,display,pose,object,room,x,y,ts,online,updated_at")
      .eq("house_id", houseId)
      .eq("online", true);
    if (error) throw error;
    return data || [];
  }

  async function upsertLayout(snap) {
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

  async function upsertActorNow(row) {
    const sb = getClient();
    if (!sb || !houseId || !row || !row.login) return null;
    const payload = {
      house_id: houseId,
      login: String(row.login).toLowerCase(),
      display: row.display || row.login,
      pose: row.pose || "here",
      object: row.object || "",
      room: row.room || "",
      x: row.x != null ? Number(row.x) : null,
      y: row.y != null ? Number(row.y) : null,
      ts: Number(row.ts || Date.now()),
      online: row.online !== false,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb
      .from("blt_atm_actors")
      .upsert(payload, { onConflict: "house_id,login" })
      .select("house_id,login,display,pose,object,room,x,y,ts,online")
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  function flushActorWrite() {
    const row = pendingActor;
    pendingActor = null;
    actorWriteTimer = null;
    if (!row) return;
    upsertActorNow(row).catch(function () {});
  }

  function queueActorWrite(row, immediate) {
    pendingActor = row;
    if (immediate) {
      if (actorWriteTimer) {
        clearTimeout(actorWriteTimer);
        actorWriteTimer = null;
      }
      flushActorWrite();
      return;
    }
    if (actorWriteTimer) return;
    actorWriteTimer = setTimeout(flushActorWrite, ACTOR_WRITE_MS);
  }

  window.BLTHouseRealtime = {
    enabled: enabled,

    async connect(hid, handlers) {
      onUpdate = handlers && handlers.onUpdate;
      houseId = hid || "";
      await this.disconnect(false);
      if (!enabled() || !houseId) return false;

      const sb = getClient();
      if (!sb) return false;

      const twitch = window.BLTHouseTwitch || {};
      selfLogin = String((twitch.user && twitch.user.login) || "").toLowerCase();
      const display = (twitch.user && twitch.user.display) || selfLogin;

      channel = sb.channel("blt-atm-sql:" + houseId);
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "blt_atm_layout", filter: "house_id=eq." + houseId },
        function (payload) {
          if (payload.eventType === "DELETE") return;
          if (payload.new) emitLayoutRow(payload.new);
        }
      );
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "blt_atm_actors", filter: "house_id=eq." + houseId },
        function (payload) {
          if (payload.eventType === "DELETE") {
            if (payload.old && payload.old.login) {
              onUpdate && onUpdate({
                kind: "actor",
                actor: { login: payload.old.login, online: false, ts: Date.now() },
              });
            }
            return;
          }
          if (payload.new) emitActorRow(payload.new);
        }
      );

      const ok = await subscribeWithTimeout(channel);
      connected = !!ok;
      if (!ok) return false;

      try {
        const layoutRow = await loadLayout();
        if (layoutRow) emitLayoutRow(layoutRow);
        else if (onUpdate) {
          onUpdate({
            kind: "layout",
            layout: { houseId: houseId, rev: 0, ts: Date.now(), rooms: {}, empty: true },
          });
        }
      } catch (e) {}

      try {
        const rows = await loadOnlineActors();
        emitActorsMap(rows);
      } catch (e) {
        emitActorsMap([]);
      }

      if (selfLogin) {
        try {
          const me = await upsertActorNow({
            login: selfLogin,
            display: display,
            pose: "here",
            object: "",
            room: "",
            x: null,
            y: null,
            ts: Date.now(),
            online: true,
          });
          if (me) emitActorRow(me);
        } catch (e) {}
      }

      return true;
    },

    async disconnect(setOffline) {
      if (setOffline !== false && selfLogin && houseId) {
        try {
          await upsertActorNow({
            login: selfLogin,
            display: selfLogin,
            pose: "here",
            online: false,
            ts: Date.now(),
          });
        } catch (e) {}
      }
      connected = false;
      if (actorWriteTimer) {
        clearTimeout(actorWriteTimer);
        actorWriteTimer = null;
      }
      pendingActor = null;
      if (channel) {
        try { await channel.unsubscribe(); } catch (e) {}
        channel = null;
      }
    },

    async publishFlavor(payload) {
      if (!connected || !houseId) throw new Error("realtime_not_connected");
      const twitch = window.BLTHouseTwitch || {};
      const login = String((twitch.user && twitch.user.login) || "").toLowerCase();
      if (!login) throw new Error("login_required");
      const display = (twitch.user && twitch.user.display) || login;
      const row = {
        login: login,
        display: display,
        pose: (payload && payload.pose) || "here",
        object: (payload && payload.object) || "",
        room: (payload && payload.room) || "",
        x: payload && payload.x != null ? Number(payload.x) : null,
        y: payload && payload.y != null ? Number(payload.y) : null,
        ts: Date.now(),
        online: true,
      };

      // Local flavor toast only for non-idle (UI); peers get SQL change.
      if (onUpdate && payload && payload.idle !== true && row.pose && row.pose !== "here") {
        onUpdate({
          kind: "flavor",
          event: {
            id: (payload && (payload.eventId || payload.id)) || ("e" + Date.now()),
            login: login,
            display: display,
            pose: row.pose,
            object: row.object,
            room: row.room,
            x: row.x,
            y: row.y,
            text: (payload && payload.text) || (display + " · " + row.pose + (row.object ? " · " + row.object : "")),
            ts: row.ts,
          },
        });
      }

      const immediate = !(payload && payload.idle === true);
      queueActorWrite(row, immediate);
      return { ok: true, idle: !!(payload && payload.idle) };
    },

    async publishLayout(payload) {
      if (!houseId) throw new Error("realtime_not_connected");
      const row = await upsertLayout(Object.assign({ ts: Date.now(), houseId: houseId }, payload || {}));
      if (row) emitLayoutRow(row);
      return { ok: true, layout: row };
    },

    isConnected: function () {
      return !!connected;
    },
  };

  window.addEventListener("beforeunload", function () {
    if (!selfLogin || !houseId || !client) return;
    try {
      // best-effort offline flag (beacon-style via sync XHR not available; fire upsert)
      client.from("blt_atm_actors").upsert(
        {
          house_id: houseId,
          login: selfLogin,
          display: selfLogin,
          pose: "here",
          online: false,
          ts: Date.now(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "house_id,login" }
      );
    } catch (e) {}
  });
})();
