/* BLT House: Pages ↔ Supabase Postgres/Realtime (preferred over Cloudflare Worker poll). */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function enabled() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  let client = null;
  let stateChannel = null;
  let stateHouseId = "";
  let stateHandlers = null;
  let lastStateRow = null;

  function getClient() {
    if (!enabled()) return null;
    if (client) return client;
    const c = cfg();
    client = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 20 } },
    });
    return client;
  }

  function channelKey() {
    return String(cfg().broadcasterId || cfg().channel || "default");
  }

  function pickHouseFromRow(row, viewer) {
    if (!row) return null;
    const owner = String(row.owner_player_id || "").toLowerCase();
    const who = String(viewer || "").toLowerCase();
    const isOwner = !!(who && owner && who === owner);
    const house = isOwner
      ? (row.owner_house || row.public_house)
      : (row.public_house || row.owner_house);
    if (!house) return null;
    return {
      house,
      ts: Number(row.ts || 0) || 0,
      lastActionId: row.last_action_id || "",
      ownerPlayerId: row.owner_player_id || "",
    };
  }

  function emitState(row) {
    lastStateRow = row;
    if (!stateHandlers || !stateHandlers.onState) return;
    const twitch = window.BLTHouseTwitch || {};
    const viewer = (twitch.user && twitch.user.login) || "";
    const packed = pickHouseFromRow(row, viewer);
    if (packed) stateHandlers.onState(packed);
  }

  window.BLTHouseSupabaseQueue = {
    enabled,

    async enqueueAction(messageObj) {
      const sb = getClient();
      if (!sb) throw new Error("supabase_not_configured");
      const twitch = window.BLTHouseTwitch || {};
      const login = (twitch.user && twitch.user.login) || messageObj.viewer || "";
      if (!login) {
        const err = new Error("login_required");
        err.code = "login_required";
        throw err;
      }
      const id = messageObj.id || messageObj.actionId || ("a" + Date.now());
      const row = {
        id: String(id),
        channel: channelKey(),
        house_id: String(messageObj.houseId || ""),
        viewer: String(login).toLowerCase(),
        action: String(messageObj.action || ""),
        target: String(messageObj.target || ""),
        value: String(messageObj.value || ""),
        status: "pending",
        payload: messageObj,
      };
      const { data, error } = await sb.from("blt_house_actions").insert(row).select("id").maybeSingle();
      if (error) {
        const err = new Error(error.message || "enqueue_failed");
        err.code = error.code || "enqueue_failed";
        err.body = error;
        throw err;
      }
      return { ok: true, via: "supabase", actionId: (data && data.id) || id, queued: (data && data.id) || id };
    },

    async fetchState(houseId, viewer) {
      const sb = getClient();
      if (!sb || !houseId) return null;
      const { data, error } = await sb
        .from("blt_house_state")
        .select("house_id,owner_player_id,ts,last_action_id,public_house,owner_house")
        .eq("house_id", houseId)
        .maybeSingle();
      if (error || !data) return null;
      return pickHouseFromRow(data, viewer);
    },

    async waitState(houseId, opts) {
      opts = opts || {};
      const actionId = opts.actionId || "";
      const prevTs = opts.prevTs != null ? opts.prevTs : null;
      const limit = opts.timeoutMs || 10000;
      const viewer = opts.viewer || "";
      const t0 = Date.now();
      let last = lastStateRow && lastStateRow.house_id === houseId ? pickHouseFromRow(lastStateRow, viewer) : null;
      while (Date.now() - t0 < limit) {
        if (last && last.house) {
          if (actionId && String(last.lastActionId || "") === String(actionId)) return last.house;
          if (!actionId && (prevTs == null || last.ts !== prevTs)) return last.house;
        }
        const packed = await this.fetchState(houseId, viewer);
        if (packed) {
          last = packed;
          if (actionId && String(packed.lastActionId || "") === String(actionId)) return packed.house;
          if (!actionId && (prevTs == null || packed.ts !== prevTs)) return packed.house;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return last && last.house ? last.house : null;
    },

    async subscribeState(houseId, handlers) {
      await this.unsubscribeState();
      stateHandlers = handlers || null;
      stateHouseId = houseId || "";
      const sb = getClient();
      if (!sb || !stateHouseId) return false;

      // Seed once
      try {
        const twitch = window.BLTHouseTwitch || {};
        const packed = await this.fetchState(stateHouseId, (twitch.user && twitch.user.login) || "");
        if (packed && handlers && handlers.onState) handlers.onState(packed);
      } catch (e) {}

      stateChannel = sb
        .channel("blt-house-state:" + stateHouseId)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "blt_house_state", filter: "house_id=eq." + stateHouseId },
          (payload) => {
            const row = payload.new || payload.record || null;
            if (row) emitState(row);
          }
        );

      await new Promise((resolve) => {
        stateChannel.subscribe((status) => {
          if (status === "SUBSCRIBED") resolve(true);
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") resolve(false);
        });
      });
      return true;
    },

    async unsubscribeState() {
      if (stateChannel) {
        try { await stateChannel.unsubscribe(); } catch (e) {}
        stateChannel = null;
      }
      stateHouseId = "";
    },
  };
})();
