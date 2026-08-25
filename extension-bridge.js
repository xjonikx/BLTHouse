/* BLTHouse Pages: click → Worker queue → game; gold via /state after action */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function queueBase() {
    return String(cfg().ebsUrl || cfg().queueUrl || "").replace(/\/$/, "");
  }

  function newActionId() {
    try {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return "a" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  async function enqueueAction(messageObj) {
    const base = queueBase();
    if (!base) throw new Error("ebsUrl/queueUrl not set in config.js");
    const channel = String(cfg().broadcasterId || cfg().channel || "default");
    const twitch = window.BLTHouseTwitch || {};
    const res = await fetch(base + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        id: messageObj.id || messageObj.actionId || "",
        actionId: messageObj.id || messageObj.actionId || "",
        action: messageObj.action,
        houseId: messageObj.houseId,
        viewer: (twitch.user && twitch.user.login) || messageObj.viewer || "",
        twitchToken: twitch.token || "",
        target: messageObj.target || "",
        value: messageObj.value || "",
        message: messageObj,
      }),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* raw */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ("queue " + res.status + ": " + text));
      err.code = data.error || String(res.status);
      err.body = data;
      throw err;
    }
    return { ok: true, via: "queue", data, actionId: (data && data.queued) || messageObj.id };
  }

  async function publishLocal(messageObj) {
    const c = cfg();
    const base = (c.localGameApi || "").replace(/\/$/, "");
    const res = await fetch(base + "/api/extension/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageObj),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("local " + res.status);
    return { ok: true, via: "local", data, actionId: messageObj.id };
  }

  window.BLTHouseExtPublishAction = async function (action, extra) {
    const route = (typeof parseRoute === "function" && parseRoute()) || {};
    const twitch = window.BLTHouseTwitch || {};
    const actionId = (extra && (extra.id || extra.actionId || extra.clientActionId)) || newActionId();
    const messageObj = Object.assign(
      {
        v: 1,
        kind: "action",
        id: actionId,
        actionId: actionId,
        action: action,
        houseId: route.houseId || "",
        viewer: (twitch.user && twitch.user.login) || route.viewer || "",
        target: "",
        value: "",
        ts: Math.floor(Date.now() / 1000),
      },
      extra || {},
      { id: actionId, actionId: actionId }
    );

    const c = cfg();

    // When Worker URL is configured, NEVER fall back to localGameApi after a failed/
    // timed-out enqueue — the command may already be accepted (idempotent retry only).
    if (queueBase()) {
      return await enqueueAction(messageObj);
    }

    if (c.localGameApi) {
      return await publishLocal(messageObj);
    }

    throw new Error("No queueUrl/ebsUrl in config.js");
  };

  window.BLTHouseExtFetchState = async function (houseId, viewer) {
    const base = queueBase();
    if (!base || !houseId) return null;
    const twitch = window.BLTHouseTwitch || {};
    const who = (twitch.user && twitch.user.login) || viewer || "";
    const qs = new URLSearchParams({ house: houseId });
    if (who) qs.set("viewer", who);
    const res = await fetch(base + "/state?" + qs.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.house) return null;
    return {
      house: data.house,
      ts: data.ts || 0,
      lastActionId: data.lastActionId || "",
    };
  };

  /**
   * Wait for confirmation of a specific command when actionId is provided.
   * Falls back to ts change only when actionId is omitted (legacy callers).
   */
  window.BLTHouseExtWaitState = async function (houseId, prevTsOrOpts, timeoutMs, viewer) {
    let prevTs = null;
    let actionId = "";
    let limit = 8000;
    let who = viewer || "";
    if (prevTsOrOpts && typeof prevTsOrOpts === "object") {
      prevTs = prevTsOrOpts.prevTs != null ? prevTsOrOpts.prevTs : null;
      actionId = prevTsOrOpts.actionId || prevTsOrOpts.lastActionId || "";
      limit = prevTsOrOpts.timeoutMs || timeoutMs || 8000;
      who = prevTsOrOpts.viewer || viewer || "";
    } else {
      prevTs = prevTsOrOpts;
      limit = timeoutMs || 8000;
    }

    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < limit) {
      last = await window.BLTHouseExtFetchState(houseId, who);
      if (last && last.house) {
        if (actionId) {
          if (String(last.lastActionId || "") === String(actionId)) return last.house;
        } else if (prevTs == null || last.ts !== prevTs) {
          return last.house;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return last && last.house ? last.house : null;
  };

  window.BLTHouseExtListHouses = async function () {
    const base = queueBase();
    if (!base) return [];
    const res = await fetch(base + "/houses", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return (data && data.houses) || [];
  };

  window.BLTHouseExtFetchPresence = async function (houseId, opts) {
    const base = queueBase();
    if (!base || !houseId) return null;
    opts = opts || {};
    const q = new URLSearchParams();
    q.set("house", houseId);
    q.set("_", String(Date.now()));
    if (opts.since != null) q.set("since", String(opts.since));
    if (opts.wait != null) q.set("wait", String(opts.wait));
    const res = await fetch(base + "/presence?" + q.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  };

  window.BLTHouseExtPublishPresence = async function (payload) {
    const base = queueBase();
    if (!base) throw new Error("ebsUrl not set");
    const twitch = window.BLTHouseTwitch || {};
    if (!twitch.token) throw new Error("login_required");
    const route = (typeof parseRoute === "function" && parseRoute()) || {};
    const res = await fetch(base + "/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        houseId: route.houseId || "",
        twitchToken: twitch.token || "",
      }, payload || {})),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* raw */ }
    if (!res.ok) {
      const err = new Error(data.error || ("presence " + res.status));
      err.code = data.error || String(res.status);
      err.body = data;
      throw err;
    }
    return data;
  };

  window.BLTHouseExtFetchLayout = async function (houseId, opts) {
    const base = queueBase();
    if (!base || !houseId) return null;
    opts = opts || {};
    const q = new URLSearchParams();
    q.set("house", houseId);
    q.set("_", String(Date.now()));
    if (opts.since != null) q.set("since", String(opts.since));
    if (opts.wait != null) q.set("wait", String(opts.wait));
    const res = await fetch(base + "/layout?" + q.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  };

  window.BLTHouseExtPublishLayout = async function (payload) {
    const base = queueBase();
    if (!base) throw new Error("ebsUrl not set");
    const twitch = window.BLTHouseTwitch || {};
    if (!twitch.token) throw new Error("login_required");
    const route = (typeof parseRoute === "function" && parseRoute()) || {};
    const res = await fetch(base + "/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        houseId: route.houseId || "",
        twitchToken: twitch.token || "",
      }, payload || {})),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* raw */ }
    if (!res.ok) {
      const err = new Error(data.error || ("layout " + res.status));
      err.code = data.error || String(res.status);
      err.body = data;
      throw err;
    }
    return data;
  };
})();
