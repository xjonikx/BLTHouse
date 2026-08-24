/* BLTHouse Pages: click → Worker queue → game; gold via /state after action */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function queueBase() {
    return String(cfg().ebsUrl || cfg().queueUrl || "").replace(/\/$/, "");
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
    return { ok: true, via: "queue", data };
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
    return { ok: true, via: "local", data };
  }

  window.BLTHouseExtPublishAction = async function (action, extra) {
    const route = (typeof parseRoute === "function" && parseRoute()) || {};
    const twitch = window.BLTHouseTwitch || {};
    const messageObj = Object.assign(
      {
        v: 1,
        kind: "action",
        action: action,
        houseId: route.houseId || "",
        viewer: (twitch.user && twitch.user.login) || route.viewer || "",
        target: "",
        value: "",
        ts: Math.floor(Date.now() / 1000),
      },
      extra || {}
    );

    const c = cfg();
    const errors = [];

    if (queueBase()) {
      try {
        return await enqueueAction(messageObj);
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }

    if (c.localGameApi) {
      try {
        return await publishLocal(messageObj);
      } catch (e) {
        errors.push("local: " + (e.message || e));
      }
    }

    throw new Error(errors.join(" | ") || "No queueUrl/ebsUrl in config.js");
  };

  window.BLTHouseExtFetchState = async function (houseId) {
    const base = queueBase();
    if (!base || !houseId) return null;
    const res = await fetch(base + "/state?house=" + encodeURIComponent(houseId), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.house) return null;
    return { house: data.house, ts: data.ts || 0 };
  };

  window.BLTHouseExtWaitState = async function (houseId, prevTs, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || 8000;
    let last = null;
    while (Date.now() - t0 < limit) {
      last = await window.BLTHouseExtFetchState(houseId);
      if (last && last.house && (prevTs == null || last.ts !== prevTs)) return last.house;
      await new Promise((r) => setTimeout(r, 400));
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
})();
