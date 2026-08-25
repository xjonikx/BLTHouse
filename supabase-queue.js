/* BLT House: Pages ↔ Supabase Postgres + Realtime (state) + REST fetch with strip on legacy rows. */
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

  const FETCH_TIMEOUT_MS = 10000;
  const SUBSCRIBE_TIMEOUT_MS = 8000;

  function getClient() {
    if (!enabled()) return null;
    if (client) return client;

    const c = cfg();

    client = window.supabase.createClient(
      c.supabaseUrl,
      c.supabaseAnonKey,
      {
        realtime: {
          params: {
            eventsPerSecond: 20,
          },
        },
      }
    );

    return client;
  }

  function channelKey() {
    return String(
      cfg().broadcasterId ||
      cfg().channel ||
      "default"
    );
  }

  /**
   * Fetch with a hard timeout so a broken/stalled Supabase request
   * can never block page initialization forever.
   */
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      try {
        controller.abort();
      } catch (e) {}
    }, timeoutMs || FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...(options || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Strip a top-level JSON array field using bracket matching
   *  (avoids OOM parse of huge ShopItems).
   */
  function stripJsonArrayField(text, field) {
    const key = '"' + field + '"';
    let out = String(text || "");
    let idx = 0;

    while (idx < out.length) {
      const k = out.indexOf(key, idx);
      if (k < 0) break;

      const colon = out.indexOf(":", k + key.length);
      if (colon < 0) break;

      let i = colon + 1;

      while (i < out.length && /\s/.test(out[i])) {
        i++;
      }

      if (out[i] !== "[") {
        idx = i + 1;
        continue;
      }

      let depth = 0;
      let j = i;

      for (; j < out.length; j++) {
        const c = out[j];

        if (c === "[") {
          depth++;
        } else if (c === "]") {
          depth--;

          if (depth === 0) {
            j++;
            break;
          }
        } else if (c === '"') {
          j++;

          while (j < out.length) {
            if (out[j] === "\\") {
              j += 2;
              continue;
            }

            if (out[j] === '"') {
              break;
            }

            j++;
          }
        }
      }

      out = out.slice(0, i) + "[]" + out.slice(j);
      idx = i + 2;
    }

    return out;
  }

  /** Strip legacy megabyte arrays before JSON.parse on HTTP GET only. */
  function stripHeavyStateJson(text) {
    let out = String(text || "");

    if (out.length > 100000) {
      out = stripJsonArrayField(out, "ShopItems");
      out = stripJsonArrayField(out, "shopItems");
    }

    if (out.length > 280000) {
      out = stripJsonArrayField(out, "StorageItems");
      out = stripJsonArrayField(out, "storageItems");

      out = stripJsonArrayField(out, "HeroInventory");
      out = stripJsonArrayField(out, "heroInventory");

      out = stripJsonArrayField(out, "History");
      out = stripJsonArrayField(out, "history");
    }

    return out;
  }

  const ARRAY_CAPS = {
    ShopItems: 180,
    shopItems: 180,

    StorageItems: 90,
    storageItems: 90,

    StorageGoods: 90,
    storageGoods: 90,

    HeroInventory: 90,
    heroInventory: 90,

    History: 35,
    history: 35,
  };

  function capArray(arr, max) {
    if (!Array.isArray(arr)) return arr;
    return arr.length > max ? arr.slice(0, max) : arr;
  }

  function neuterHouseInPlace(h) {
    if (!h || typeof h !== "object") return h;

    for (const key of Object.keys(ARRAY_CAPS)) {
      if (Array.isArray(h[key])) {
        h[key] = capArray(h[key], ARRAY_CAPS[key]);
      }
    }

    return h;
  }

  function neuterShopInRow(row) {
    if (!row) return row;

    if (row.owner_house) {
      neuterHouseInPlace(row.owner_house);
    }

    if (row.public_house) {
      neuterHouseInPlace(row.public_house);
    }

    return row;
  }

  function pickHouseFromRow(row, viewer) {
    if (!row) return null;

    neuterShopInRow(row);

    const owner = String(
      row.owner_player_id || ""
    ).toLowerCase();

    const who = String(
      viewer || ""
    ).toLowerCase();

    const isOwner = !!(
      who &&
      owner &&
      who === owner
    );

    const house = isOwner
      ? (row.owner_house || row.public_house)
      : (row.public_house || row.owner_house);

    if (!house) return null;

    neuterHouseInPlace(house);

    return {
      house,
      ts: Number(row.ts || 0) || 0,
      lastActionId: row.last_action_id || "",
      ownerPlayerId: row.owner_player_id || "",
    };
  }

  function emitState(row) {
    lastStateRow = row;

    if (!stateHandlers || !stateHandlers.onState) {
      return;
    }

    const twitch = window.BLTHouseTwitch || {};

    const viewer =
      (twitch.user && twitch.user.login) || "";

    const packed = pickHouseFromRow(row, viewer);

    if (packed) {
      try {
        stateHandlers.onState(packed);
      } catch (e) {
        console.warn(
          "BLTHouseSupabaseQueue onState",
          e
        );
      }
    }
  }

  /**
   * REST GET — strip legacy fat JSON before parse
   * (first load / waitState).
   *
   * Realtime stays as-is.
   */
  async function fetchStateRaw(houseId, viewer) {
    const c = cfg();

    if (
      !c.supabaseUrl ||
      !c.supabaseAnonKey ||
      !houseId
    ) {
      return null;
    }

    const url =
      String(c.supabaseUrl).replace(/\/$/, "") +
      "/rest/v1/blt_house_state?house_id=eq." +
      encodeURIComponent(houseId) +
      "&select=house_id,owner_player_id,ts,last_action_id,public_house,owner_house";

    let res;

    try {
      res = await fetchWithTimeout(
        url,
        {
          headers: {
            apikey: c.supabaseAnonKey,
            Authorization:
              "Bearer " + c.supabaseAnonKey,
            Accept: "application/json",
          },
          cache: "no-store",
        },
        FETCH_TIMEOUT_MS
      );
    } catch (e) {
      if (e && e.name === "AbortError") {
        console.warn(
          "blt state fetch timeout"
        );
      } else {
        console.warn(
          "blt state fetch failed",
          e
        );
      }

      return null;
    }

    if (!res.ok) {
      return null;
    }

    let text;

    try {
      text = await res.text();
    } catch (e) {
      console.warn(
        "blt state response read failed",
        e
      );
      return null;
    }

    if (
      !text ||
      text === "[]" ||
      text === "null"
    ) {
      return null;
    }

    text = stripHeavyStateJson(text);

    let rows;

    try {
      rows = JSON.parse(text);
    } catch (e) {
      console.warn(
        "blt state parse",
        e
      );
      return null;
    }

    const row =
      Array.isArray(rows)
        ? rows[0]
        : rows;

    lastStateRow = row;

    return pickHouseFromRow(
      row,
      viewer
    );
  }

  window.BLTHouseSupabaseQueue = {
    enabled,

    async enqueueAction(messageObj) {
      const sb = getClient();

      if (!sb) {
        throw new Error(
          "supabase_not_configured"
        );
      }

      const twitch =
        window.BLTHouseTwitch || {};

      const login =
        (twitch.user && twitch.user.login) ||
        messageObj.viewer ||
        "";

      if (!login) {
        const err =
          new Error("login_required");

        err.code = "login_required";

        throw err;
      }

      const id =
        messageObj.id ||
        messageObj.actionId ||
        ("a" + Date.now());

      const row = {
        id: String(id),

        channel: channelKey(),

        house_id: String(
          messageObj.houseId || ""
        ),

        viewer: String(
          login
        ).toLowerCase(),

        action: String(
          messageObj.action || ""
        ),

        target: String(
          messageObj.target || ""
        ),

        value: String(
          messageObj.value || ""
        ),

        status: "pending",

        payload: messageObj,
      };

      const {
        data,
        error,
      } = await sb
        .from("blt_house_actions")
        .insert(row)
        .select("id")
        .maybeSingle();

      if (error) {
        const err =
          new Error(
            error.message ||
            "enqueue_failed"
          );

        err.code =
          error.code ||
          "enqueue_failed";

        err.body = error;

        throw err;
      }

      return {
        ok: true,
        via: "supabase",
        actionId:
          (data && data.id) || id,
        queued:
          (data && data.id) || id,
      };
    },

    async fetchState(houseId, viewer) {
      try {
        return await fetchStateRaw(
          houseId,
          viewer
        );
      } catch (e) {
        console.warn(
          "fetchStateRaw",
          e
        );

        return null;
      }
    },

    async waitState(houseId, opts) {
      opts = opts || {};

      const actionId =
        opts.actionId || "";

      const prevTs =
        opts.prevTs != null
          ? opts.prevTs
          : null;

      const limit =
        opts.timeoutMs ||
        10000;

      const viewer =
        opts.viewer || "";

      const t0 = Date.now();

      let last =
        lastStateRow &&
        lastStateRow.house_id === houseId
          ? pickHouseFromRow(
              lastStateRow,
              viewer
            )
          : null;

      while (
        Date.now() - t0 < limit
      ) {
        if (last && last.house) {
          if (
            actionId &&
            String(
              last.lastActionId || ""
            ) === String(actionId)
          ) {
            return last.house;
          }

          if (
            !actionId &&
            (
              prevTs == null ||
              last.ts !== prevTs
            )
          ) {
            return last.house;
          }
        }

        const packed =
          await this.fetchState(
            houseId,
            viewer
          );

        if (packed) {
          last = packed;

          if (
            actionId &&
            String(
              packed.lastActionId || ""
            ) === String(actionId)
          ) {
            return packed.house;
          }

          if (
            !actionId &&
            (
              prevTs == null ||
              packed.ts !== prevTs
            )
          ) {
            return packed.house;
          }
        }

        await new Promise(
          (resolve) =>
            setTimeout(resolve, 400)
        );
      }

      return last && last.house
        ? last.house
        : null;
    },

    async subscribeState(
      houseId,
      handlers
    ) {
      await this.unsubscribeState();

      stateHandlers =
        handlers || null;

      stateHouseId =
        houseId || "";

      const sb =
        getClient();

      if (
        !sb ||
        !stateHouseId
      ) {
        return false;
      }

      /*
       * First get current state through REST.
       * Failure here must NOT prevent Realtime
       * from being initialized.
       */
      try {
        const twitch =
          window.BLTHouseTwitch || {};

        const packed =
          await this.fetchState(
            stateHouseId,
            (
              twitch.user &&
              twitch.user.login
            ) || ""
          );

        if (
          packed &&
          handlers &&
          handlers.onState
        ) {
          try {
            handlers.onState(
              packed
            );
          } catch (e) {
            console.warn(
              "BLTHouseSupabaseQueue initial onState",
              e
            );
          }
        }
      } catch (e) {
        console.warn(
          "BLTHouseSupabaseQueue initial state",
          e
        );
      }

      /*
       * Create Realtime channel.
       */
      try {
        stateChannel = sb
          .channel(
            "blt-house-state:" +
            stateHouseId
          )
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "blt_house_state",
              filter:
                "house_id=eq." +
                stateHouseId,
            },
            (payload) => {
              const row =
                payload &&
                (
                  payload.new ||
                  payload.record ||
                  null
                );

              if (row) {
                emitState(row);
              }
            }
          );
      } catch (e) {
        console.warn(
          "BLTHouseSupabaseQueue channel creation failed",
          e
        );

        stateChannel = null;
        stateHouseId = "";

        return false;
      }

      /*
       * IMPORTANT:
       *
       * Never wait forever for Supabase.
       * SUBSCRIBED -> true
       * error/timeout/closed -> false
       * 8 seconds without any status -> false
       */
      const result =
        await new Promise(
          (resolve) => {
            let finished = false;

            const timer =
              setTimeout(
                () => {
                  if (finished) {
                    return;
                  }

                  console.warn(
                    "BLTHouseSupabaseQueue: state channel subscribe timeout"
                  );

                  finish(false);
                },
                SUBSCRIBE_TIMEOUT_MS
              );

            function finish(value) {
              if (finished) {
                return;
              }

              finished = true;

              clearTimeout(
                timer
              );

              resolve(
                !!value
              );
            }

            try {
              stateChannel.subscribe(
                (status) => {
                  console.log(
                    "BLTHouseSupabaseQueue state channel:",
                    status
                  );

                  if (
                    status ===
                    "SUBSCRIBED"
                  ) {
                    finish(true);
                    return;
                  }

                  if (
                    status ===
                      "CHANNEL_ERROR" ||
                    status ===
                      "TIMED_OUT" ||
                    status ===
                      "CLOSED"
                  ) {
                    finish(false);
                  }
                }
              );
            } catch (e) {
              console.warn(
                "BLTHouseSupabaseQueue subscribe failed",
                e
              );

              finish(false);
            }
          }
        );

      /*
       * If Realtime did not connect,
       * clean the failed channel.
       *
       * Do NOT leave a dead channel around.
       */
      if (!result) {
        try {
          if (stateChannel) {
            await stateChannel.unsubscribe();
          }
        } catch (e) {}

        stateChannel = null;
        stateHouseId = "";

        return false;
      }

      return true;
    },

    async unsubscribeState() {
      if (stateChannel) {
        try {
          await stateChannel.unsubscribe();
        } catch (e) {
          console.warn(
            "BLTHouseSupabaseQueue unsubscribe",
            e
          );
        }

        stateChannel = null;
      }

      stateHouseId = "";
    },
  };
})();
