/* Twitch Implicit OAuth — no secret in the page. Worker checks the user token on /action. */
(function () {
  const KEY = "blt_twitch_token";
  const USER_KEY = "blt_twitch_user";

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

  function readHashToken() {
    const hash = (location.hash || "").replace(/^#/, "");
    const qs = new URLSearchParams(hash);
    const token = qs.get("access_token");
    if (!token) return null;
    history.replaceState({}, "", location.pathname + location.search);
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

    async init() {
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
      const redir = redirectUri();
      const url =
        "https://id.twitch.tv/oauth2/authorize" +
        "?client_id=" + encodeURIComponent(id) +
        "&redirect_uri=" + encodeURIComponent(redir) +
        "&response_type=token" +
        "&scope=" +
        "&force_verify=false";
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
