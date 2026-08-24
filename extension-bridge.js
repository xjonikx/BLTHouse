/* BLTHouse Pages bridge: click → Cloudflare queue → game poll (no Twitch Extension, no chat) */
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

  window.BLTHouseExtFetchState = async function () { return null; };
})();
