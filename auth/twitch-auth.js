/* Twitch Implicit OAuth — no secret in the page. Worker checks the user token on /action. */
(function () {
  const KEY = "blt_twitch_token";
  const USER_KEY = "blt_twitch_user";
  const RETURN_KEY = "blt_house_return";

  function cfg() {
    return window.BLT_HOUSE_EXT || {};
  }

  function clientId() {
    return String(cfg().twitchClientId || "").trim();
  }

  function redirectUri() {
    const c = cfg().twitchRedirectUri;
    if (c) return String(c).replace(/\/$/, "") + "/";
    const u = new URL(location.href);
    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/index\.html$/i, "").replace(/404\.html$/i, "");
    if (!path.endsWith("/")) path += "/";
    return u.origin + path;
  }

  function houseFromLocation() {
    const qs = new URLSearchParams(location.search);
    let house = qs.get("house") || "";
    const path = location.pathname || "";
    const m = path.match(/\/house\/([^\/\?#]+)/i);
    if (m) house = decodeURIComponent(m[1]);
    const hash = (location.hash || "").replace(/^#/, "");
    if (!house && hash.indexOf("house=") >= 0) {
      const hqs = new URLSearchParams(hash.indexOf("?") >= 0 ? hash.slice(hash.indexOf("?") + 1) : hash);
      house = hqs.get("house") || house;
    }
    return {
      house: house,
      viewer: qs.get("viewer") || "",
    };
  }

  function rememberReturn() {
    const r = houseFromLocation();
    if (!r.house) return;
    const search =
      "?house=" + encodeURIComponent(r.house) +
      (r.viewer ? "&viewer=" + encodeURIComponent(r.viewer) : "");
    try { sessionStorage.setItem(RETURN_KEY, search); } catch (e) {}
  }

  function b64url(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function unb64url(str) {
    const pad = str.replace(/-/g, "+").replace(/_/g, "/");
    const full = pad + "===".slice((pad.length + 3) % 4);
    return decodeURIComponent(escape(atob(full)));
  }

  function encodeState() {
    rememberReturn();
    const r = houseFromLocation();
    try {
      return b64url(JSON.stringify({ h: r.house, v: r.viewer, t: Date.now() }));
    } catch (e) {
      return "";
    }
  }

  function applyState(raw) {
    if (!raw) return;
    try {
      const s = JSON.parse(unb64url(raw));
      if (s && s.h) {
        const search =
          "?house=" + encodeURIComponent(s.h) +
          (s.v ? "&viewer=" + encodeURIComponent(s.v) : "");
        sessionStorage.setItem(RETURN_KEY, search);
      }
    } catch (e) {}
  }

  function cleanUrlAfterLogin() {
    const base = new URL(redirectUri());
    const search = (function () {
      try { return sessionStorage.getItem(RETURN_KEY) || ""; } catch (e) { return ""; }
    })() || location.search || "";
    const next = base.pathname + (search.charAt(0) === "?" ? search : search ? "?" + search : "");
    const now = location.pathname + location.search;
    if (now !== next) {
      history.replaceState({}, "", next);
    } else {
      history.replaceState({}, "", location.pathname + location.search);
    }
  }

  function readHashToken() {
    const hash = (location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    const qs = new URLSearchParams(hash);
    const token = qs.get("access_token");
    const state = qs.get("state");
    if (state) applyState(state);
    if (!token) return null;
    cleanUrlAfterLogin();
    return token;
  }

  async function helixUser(token) {
    const id = clientId();
    if (!id || !token) return null;
    const res = await fetch("https://api.twitch.tv/helix/users", {
      headers: { Authorization: "Bearer " + token, "Client-Id": id },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const u = data && data.data && data.data[0];
    if (!u) return null;
    return { id: u.id, login: String(u.login || "").toLowerCase(), display: u.display_name || u.login };
  }

  window.BLTHouseTwitch = {
    user: null,
    token: null,

    rememberReturn: rememberReturn,

    async init() {
      rememberReturn();
      let token = readHashToken() || sessionStorage.getItem(KEY) || "";
      if (token) {
        const user = await helixUser(token);
        if (user) {
          this.token = token;
          this.user = user;
          sessionStorage.setItem(KEY, token);
          sessionStorage.setItem(USER_KEY, JSON.stringify(user));
          return user;
        }
        sessionStorage.removeItem(KEY);
        sessionStorage.removeItem(USER_KEY);
      }
      this.token = null;
      this.user = null;
      return null;
    },

    login() {
      const id = clientId();
      if (!id) {
        alert("В config.js нет twitchClientId. Создай Twitch Application и пропиши Client ID.");
        return;
      }
      rememberReturn();
      const redir = redirectUri();
      const state = encodeState();
      const url =
        "https://id.twitch.tv/oauth2/authorize" +
        "?client_id=" + encodeURIComponent(id) +
        "&redirect_uri=" + encodeURIComponent(redir) +
        "&response_type=token" +
        "&scope=" +
        "&force_verify=false" +
        (state ? "&state=" + encodeURIComponent(state) : "");
      location.href = url;
    },

    logout() {
      this.token = null;
      this.user = null;
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(USER_KEY);
    },

    isOwner(house) {
      const login = this.user && this.user.login;
      if (!login || !house) return false;
      const owner = String(house.ownerPlayerId || house.OwnerPlayerId || "").toLowerCase();
      return !!owner && owner === login;
    },
  };
})();
