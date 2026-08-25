/* Atmosphere realtime via Supabase (WebSocket). */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  const SUBSCRIBE_TIMEOUT_MS = 8000;

  function enabled() {
    const c = cfg();
    return !!(
      c.supabaseUrl &&
      c.supabaseAnonKey &&
      window.supabase
    );
  }

  let client = null;
  let channel = null;
  let houseId = "";
  let onUpdate = null;

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
            eventsPerSecond: 40,
          },
        },
      }
    );

    return client;
  }

  function applyPresenceState(state) {
    const actors = {};

    Object.keys(state || {}).forEach((key) => {
      const metas =
        (state[key] && state[key].metas) || [];

      const m =
        metas[metas.length - 1];

      if (!m || !m.login) return;

      actors[
        String(m.login).toLowerCase()
      ] = {
        login: m.login,
        display: m.display || m.login,
        pose: m.pose || "here",
        object: m.object || "",
        room: m.room || "",
        x:
          m.x != null
            ? Number(m.x)
            : null,
        y:
          m.y != null
            ? Number(m.y)
            : null,
        ts:
          Number(m.ts || Date.now()),
      };
    });

    return actors;
  }

  function emitActors() {
    if (!onUpdate || !channel) return;

    try {
      const actors = applyPresenceState(
        channel.presenceState()
      );

      onUpdate({
        kind: "actors",
        actors,
      });
    } catch (e) {
      console.warn(
        "BLTHouseRealtime emitActors",
        e
      );
    }
  }

  window.BLTHouseRealtime = {
    enabled,

    async connect(hid, handlers) {
      /*
       * Сначала отключаем старый канал.
       * Это важно при повторном запуске / смене дома.
       */
      await this.disconnect();

      onUpdate =
        handlers &&
        typeof handlers.onUpdate === "function"
          ? handlers.onUpdate
          : null;

      houseId = hid || "";

      if (!enabled() || !houseId) {
        return false;
      }

      const sb = getClient();

      if (!sb) {
        return false;
      }

      const twitch =
        window.BLTHouseTwitch || {};

      const login =
        (twitch.user &&
          twitch.user.login) ||
        "";

      const display =
        (twitch.user &&
          twitch.user.display) ||
        login;

      /*
       * Создание канала тоже может бросить исключение.
       * В таком случае приложение должно продолжить
       * работу через Worker fallback.
       */
      try {
        channel = sb.channel(
          "blt-house:" + houseId,
          {
            config: {
              broadcast: {
                self: true,
                ack: false,
              },

              presence: {
                key:
                  login ||
                  (
                    "guest-" +
                    Math.random()
                      .toString(16)
                      .slice(2, 8)
                  ),
              },
            },
          }
        );
      } catch (e) {
        console.warn(
          "BLTHouseRealtime channel creation failed",
          e
        );

        channel = null;
        return false;
      }

      /*
       * Broadcast: flavor
       */
      try {
        channel.on(
          "broadcast",
          { event: "flavor" },
          ({ payload }) => {
            if (!onUpdate) return;

            try {
              onUpdate({
                kind: "flavor",
                event: payload,
              });
            } catch (e) {
              console.warn(
                "BLTHouseRealtime flavor handler",
                e
              );
            }
          }
        );
      } catch (e) {
        console.warn(
          "BLTHouseRealtime flavor listener",
          e
        );
      }

      /*
       * Broadcast: layout
       */
      try {
        channel.on(
          "broadcast",
          { event: "layout" },
          ({ payload }) => {
            if (!onUpdate) return;

            try {
              onUpdate({
                kind: "layout",
                layout: payload,
              });
            } catch (e) {
              console.warn(
                "BLTHouseRealtime layout handler",
                e
              );
            }
          }
        );
      } catch (e) {
        console.warn(
          "BLTHouseRealtime layout listener",
          e
        );
      }

      /*
       * Presence events.
       */
      try {
        channel.on(
          "presence",
          { event: "sync" },
          () => emitActors()
        );

        channel.on(
          "presence",
          { event: "join" },
          () => emitActors()
        );

        channel.on(
          "presence",
          { event: "leave" },
          () => emitActors()
        );
      } catch (e) {
        console.warn(
          "BLTHouseRealtime presence listeners",
          e
        );
      }

      /*
       * КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ:
       *
       * Старый код делал:
       *
       *   await new Promise(...)
       *
       * без timeout.
       *
       * Поэтому если Supabase не отвечал,
       * вся startAtmosphere() зависала навсегда.
       *
       * Теперь:
       *
       * SUBSCRIBED       -> true
       * CHANNEL_ERROR    -> false
       * TIMED_OUT        -> false
       * CLOSED           -> false
       * 8 секунд тишины  -> false
       */
      const subscribed =
        await new Promise((resolve) => {
          let finished = false;

          const finish = (value) => {
            if (finished) return;

            finished = true;

            clearTimeout(
              timeout
            );

            resolve(
              !!value
            );
          };

          const timeout =
            setTimeout(() => {
              console.warn(
                "BLTHouseRealtime: subscribe timeout"
              );

              finish(false);
            }, SUBSCRIBE_TIMEOUT_MS);

          try {
            channel.subscribe(
              (status) => {
                console.log(
                  "BLTHouseRealtime channel:",
                  status
                );

                /*
                 * Самое важное:
                 *
                 * Не ждём channel.track().
                 *
                 * Даже если track зависнет или
                 * Supabase отклонит Presence,
                 * подключение Realtime уже состоялось.
                 */
                if (
                  status ===
                  "SUBSCRIBED"
                ) {
                  finish(true);

                  /*
                   * Presence отправляем отдельно.
                   * Ошибка track НЕ должна ломать connect().
                   */
                  if (login && channel) {
                    Promise.resolve(
                      channel.track({
                        login,
                        display,
                        pose: "here",
                        object: "",
                        room: "",
                        ts: Date.now(),
                      })
                    ).catch((e) => {
                      console.warn(
                        "BLTHouseRealtime presence track failed",
                        e
                      );
                    });
                  }

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
                  console.warn(
                    "BLTHouseRealtime channel failed:",
                    status
                  );

                  finish(false);
                }
              }
            );
          } catch (e) {
            console.warn(
              "BLTHouseRealtime subscribe failed",
              e
            );

            finish(false);
          }
        });

      /*
       * Supabase не подключился.
       *
       * Не оставляем мёртвый channel.
       * Возвращаем false — index.html сможет
       * использовать Worker fallback.
       */
      if (!subscribed) {
        try {
          if (channel) {
            await channel.unsubscribe();
          }
        } catch (e) {}

        channel = null;

        return false;
      }

      /*
       * Realtime подключён.
       * Показываем первоначальное состояние Presence.
       */
      emitActors();

      return true;
    },

    async disconnect() {
      const oldChannel = channel;

      channel = null;

      if (oldChannel) {
        try {
          await oldChannel.unsubscribe();
        } catch (e) {
          console.warn(
            "BLTHouseRealtime unsubscribe",
            e
          );
        }
      }
    },

    async publishFlavor(payload) {
      if (!channel) {
        throw new Error(
          "realtime_not_connected"
        );
      }

      const twitch =
        window.BLTHouseTwitch || {};

      const login =
        (twitch.user &&
          twitch.user.login) ||
        "";

      if (!login) {
        throw new Error(
          "login_required"
        );
      }

      const display =
        twitch.user.display ||
        login;

      const input =
        payload || {};

      const row = Object.assign(
        {
          login,
          display,
          pose: "here",
          object: "",
          room: "",
          text: "",
          x: null,
          y: null,
          ts: Date.now(),
          id:
            input.eventId ||
            input.id ||
            ("e" + Date.now()),
        },
        input
      );

      if (input.eventId) {
        row.id = input.eventId;
      }

      /*
       * Presence.track is rate-limited on Free.
       *
       * Track on moves, but never block flavor
       * broadcast on Presence.
       */
      const now = Date.now();

      const posChanged =
        (
          row.x != null &&
          row.x !== this._lastTrackX
        ) ||
        (
          row.y != null &&
          row.y !== this._lastTrackY
        );

      const shouldTrack =
        input.idle === true ||
        !this._lastTrackAt ||
        now - this._lastTrackAt >
          2500 ||
        this._lastTrackPose !==
          row.pose ||
        (
          posChanged &&
          now -
            (
              this._lastTrackAt ||
              0
            ) >
            400
        );

      if (shouldTrack) {
        this._lastTrackAt = now;
        this._lastTrackPose =
          row.pose;
        this._lastTrackX =
          row.x;
        this._lastTrackY =
          row.y;

        try {
          await Promise.resolve(
            channel.track({
              login,
              display,
              pose: row.pose,
              object:
                row.object || "",
              room:
                row.room || "",
              x: row.x,
              y: row.y,
              ts: row.ts,
            })
          );
        } catch (e) {
          /*
           * Presence throttle / error must not
           * prevent broadcast.
           */
        }
      }

      /*
       * "here" / idle event.
       */
      if (
        input.idle === true ||
        row.pose === "here"
      ) {
        /*
         * Idle with coordinates:
         * broadcast current position.
         */
        if (
          row.x != null &&
          row.y != null &&
          input.idle === true
        ) {
          try {
            await channel.send({
              type: "broadcast",
              event: "flavor",
              payload: {
                id:
                  row.id ||
                  ("here-" + now),
                login,
                display,
                pose: "here",
                object: "",
                room:
                  row.room || "",
                x: row.x,
                y: row.y,
                text:
                  display +
                  " · здесь",
                ts: row.ts,
              },
            });
          } catch (e) {}
        }

        emitActors();

        return {
          ok: true,
          idle: true,
        };
      }

      /*
       * Normal flavor event.
       */
      const msg = {
        id: row.id,
        login,
        display,
        pose: row.pose,
        object:
          row.object || "",
        room:
          row.room || "",
        x: row.x,
        y: row.y,
        text:
          row.text ||
          (
            display +
            " · " +
            row.pose +
            (
              row.object
                ? " · " +
                  row.object
                : ""
            )
          ),
        ts: row.ts,
      };

      await channel.send({
        type: "broadcast",
        event: "flavor",
        payload: msg,
      });

      return {
        ok: true,
        event: msg,
      };
    },

    async publishLayout(payload) {
      if (!channel) {
        throw new Error(
          "realtime_not_connected"
        );
      }

      const row = Object.assign(
        {
          ts: Date.now(),
          houseId,
        },
        payload || {}
      );

      await channel.send({
        type: "broadcast",
        event: "layout",
        payload: row,
      });

      return {
        ok: true,
        layout: row,
      };
    },
  };
})();
