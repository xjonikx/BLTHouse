/* BLTHouse Pages bridge: click → queue → game; after action pull /state for gold/level */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function queueBase() {
    return String(cfg().ebsUrl || cfg().queueUrl || "").replace(/\/$/, "");
  }

  async function enqueueAction(messageObj) {
    const base = queueBase();
    if (!base) throw new Error("ebsUrl/queueUrl not set in config.js");
    const channel = String(cfg().broadcasterId || cfg().channel || "default");
    const res = await fetch(base + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        action: messageObj.action,
        houseId: messageObj.houseId,
        viewer: messageObj.viewer,
        target: messageObj.target || "",
        value: messageObj.value || "",
        message: messageObj,
      }),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { /* raw */ }
    if (!res.ok) throw new Error("queue " + res.status + ": " + text);
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
    const messageObj = Object.assign(
      {
        v: 1,
        kind: "action",
        action: action,
        houseId: route.houseId || "",
        viewer: route.viewer || localStorage.getItem("blt_house_viewer") || "",
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

  /** Public GET /state — { house, ts } filled by game after actions. */
  window.BLTHouseExtFetchState = async function (houseId) {
    const base = queueBase();
    if (!base || !houseId) return null;
    const res = await fetch(base + "/state?house=" + encodeURIComponent(houseId), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !data.house) return null;
    return { house: data.house, ts: data.ts || 0 };
  };

  /** Wait until Worker house JSON timestamp changes (not campaign-day revision). */
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
})();
