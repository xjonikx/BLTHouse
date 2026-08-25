export function parseRoute() {
  const p = new URLSearchParams(location.search);
  const hash = (location.hash || "").replace(/^#/, "");
  const hp = hash.startsWith("house/") ? hash.slice(6).split("/") : [];
  return {
    houseId: p.get("house") || p.get("houseId") || hp[0] || "",
    viewer: p.get("viewer") || hp[1] || "",
  };
}

export function isQueueMode() {
  return !!(window.BLT_HOUSE_EXT?.ebsUrl || window.BLT_HOUSE_EXT?.queueUrl);
}

export function twitchLoggedIn() {
  return !!(window.BLTHouseTwitch?.token && window.BLTHouseTwitch?.user?.login);
}

export function isOwnerNow(house) {
  const login = String(window.BLTHouseTwitch?.user?.login || "").toLowerCase();
  const owner = String(house?.ownerPlayerId || house?.OwnerPlayerId || "").toLowerCase();
  return !!(login && owner && login === owner);
}
