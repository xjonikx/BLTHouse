/* BLTHouse Extension bridge: Pages face → Extension PubSub → game */
(function () {
  const cfg = () => window.BLT_HOUSE_EXT || {};

  function b64url(bytes) {
    let s = btoa(String.fromCharCode.apply(null, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
    return s.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  function b64urlStr(str) {
    return b64url(new TextEncoder().encode(str));
  }
  function decodeSecret(b64) {
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new TextEncoder().encode(b64);
    }
  }

  async function signJwt(payload, secretB64) {
    const header = b64urlStr(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64urlStr(JSON.stringify(payload));
    const data = new TextEncoder().encode(header + "." + body);
    const key = await crypto.subtle.importKey(
      "raw",
      decodeSecret(secretB64),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    return header + "." + body + "." + b64url(sig);
  }

  async function publishHelixDirect(messageObj) {
    const c = cfg();
    const exp = Math.floor(Date.now() / 1000) + 60;
    const jwt = await signJwt(
      {
        exp,
        user_id: c.broadcasterId,
        role: "external",
        channel_id: c.broadcasterId,
        pubsub_perms: { send: ["broadcast"] },
      },
      c.extensionSecret
    );
    const res = await fetch("https://api.twitch.tv/helix/extensions/pubsub", {
      method: "POST",
      headers: {
        "Client-Id": c.extensionClientId,
        Authorization: "Bearer " + jwt,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: JSON.stringify(messageObj),
        broadcaster_id: c.broadcasterId,
        target: ["broadcast"],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error("Helix " + res.status + ": " + text);
    return { ok: true, via: "helix-direct", text };
  }

  async function publishViaEbs(messageObj) {
    const c = cfg();
    const res = await fetch(c.ebsUrl.replace(/\/$/, ""), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: messageObj,
        broadcaster_id: c.broadcasterId,
        client_id: c.extensionClientId,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error("EBS " + res.status + ": " + text);
    return { ok: true, via: "ebs", text };
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
    const { houseId, viewer } = (typeof parseRoute === "function" && parseRoute()) || {};
    const messageObj = Object.assign(
      {
        v: 1,
        kind: "action",
        action: action,
        houseId: houseId || "",
        viewer: viewer || localStorage.getItem("blt_house_viewer") || "",
        target: "",
        value: "",
        ts: Math.floor(Date.now() / 1000),
      },
      extra || {}
    );

    const c = cfg();
    const errors = [];

    if (c.preferPubSub !== false && c.ebsUrl) {
      try {
        return await publishViaEbs(messageObj);
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }

    if (c.extensionSecret && c.extensionClientId && c.broadcasterId) {
      try {
        return await publishHelixDirect(messageObj);
      } catch (e) {
        errors.push("helix: " + (e.message || e));
      }
    }

    if (c.localGameApi) {
      try {
        return await publishLocal(messageObj);
      } catch (e) {
        errors.push("local: " + (e.message || e));
      }
    }

    throw new Error(errors.join(" | ") || "No publish path configured (ebsUrl / secret / localGameApi)");
  };

  // Twitch.ext listen for state snapshots when running inside Extension iframe
  function hookTwitchExt() {
    if (!window.Twitch || !window.Twitch.ext) return;
    window.Twitch.ext.onAuthorized(function () {
      window.Twitch.ext.listen("broadcast", function (_target, _contentType, message) {
        try {
          const msg = typeof message === "string" ? JSON.parse(message) : message;
          if (msg && (msg.kind === "state" || msg.kind === "house_state") && msg.house) {
            if (typeof normalize === "function") {
              window.house = normalize(msg.house);
              if (typeof renderAll === "function") renderAll();
              if (typeof showApp === "function") showApp();
            }
          }
        } catch (e) {
          console.warn("ext state parse", e);
        }
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hookTwitchExt);
  else hookTwitchExt();
})();
