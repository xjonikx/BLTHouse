/**
 * BLTHouse sync layer (Atmosphere + Game).
 * Registers bridges immediately; does NOT own UI boot.
 * Panel (index.html) still does refresh/render — this only syncs.
 */
import { GameStore } from "../game/store.js";
import { GameCommands } from "../game/commands.js";
import { GameBridge } from "../game/bridge.js";
import { AtmosphereStore } from "../atmosphere/store.js";
import { AtmosphereSync } from "../atmosphere/sync.js";
import { buildFurnitureCatalog, atmosphereActions, bannerlordActions, inferType } from "../atmosphere/objects.js";
import { parseRoute, isQueueMode, twitchLoggedIn, isOwnerNow } from "../shared/routing.js";
import { esc, cssEsc, newId } from "../shared/util.js";

const gameStore = new GameStore();
const gameBridge = new GameBridge();
const gameCommands = new GameCommands(gameStore);
const atmosphereStore = new AtmosphereStore();
const atmosphereSync = new AtmosphereSync(atmosphereStore);

window.parseRoute = parseRoute;
window.isQueueMode = isQueueMode;
window.twitchLoggedIn = twitchLoggedIn;
window.isOwnerNow = () => {
  try {
    if (typeof window.house !== "undefined" && window.house) return isOwnerNow(window.house);
  } catch { /* ignore */ }
  return gameStore.ownerNow();
};

window.BLTHouseGame = { store: gameStore, commands: gameCommands, bridge: gameBridge };
window.BLTHouseAtmosphere = {
  store: atmosphereStore,
  sync: atmosphereSync,
  objects: { buildFurnitureCatalog, atmosphereActions, bannerlordActions, inferType },
  async start(houseId) {
    const hid = houseId || parseRoute().houseId;
    if (!hid || !isQueueMode()) return;
    if (atmosphereSync.running) return;
    await atmosphereSync.start(hid);
  },
};

window.BLTHouseExtPublishAction = (action, extra) => gameCommands.publish(action, extra);

window.BLTHouseExtFetchState = async (houseId, viewer) => {
  const snap = await gameBridge.fetchState(houseId, viewer);
  if (!snap) return null;
  return {
    house: snap.house,
    ts: snap.gameRevision || snap.updatedAt || 0,
    gameRevision: snap.gameRevision,
    lastProcessedCommandId: snap.lastProcessedCommandId || "",
  };
};

window.BLTHouseExtWaitState = async (houseId, prevTs, timeoutMs, viewer) => {
  const snap = await gameBridge.waitForCommand(houseId, null, prevTs, timeoutMs, viewer);
  return snap?.house || null;
};

window.BLTHouseExtListHouses = async function () {
  const base = String((window.BLT_HOUSE_EXT || {}).ebsUrl || "").replace(/\/$/, "");
  if (!base) return [];
  const res = await fetch(base + "/houses", { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return (data && data.houses) || [];
};

window.BLTHouseExtFetchPresence = async (houseId, opts) => {
  const snap = await atmosphereSync.api.fetchSnapshot(houseId, {
    sincePresence: opts?.since || 0,
    sinceAtmosphere: opts?.since || 0,
    wait: opts?.wait || 0,
  });
  if (!snap) return null;
  const actors = snap.presence?.actors || {};
  const events = (snap.events || []).map((e) => ({
    id: e.eventId || e.id,
    login: e.actorId || e.payload?.login,
    display: e.payload?.display,
    pose: e.payload?.pose,
    object: e.payload?.object,
    room: e.payload?.room,
    x: e.payload?.x,
    y: e.payload?.y,
    text: e.payload?.text || e.text,
    ts: e.timestamp || e.ts,
  }));
  const rooms = {};
  Object.values(snap.furniture || {}).forEach((f) => {
    const room = f.room || "common";
    rooms[room] = rooms[room] || {};
    rooms[room]["object:" + f.id] = { x: f.x, y: f.y };
  });
  return {
    ok: true,
    houseId,
    actors,
    events,
    rev: snap.presenceRevision || 0,
    eventRev: snap.atmosphereRevision || 0,
    ts: snap.updatedAt || Date.now(),
    layout: { rooms, rev: snap.furnitureRevision || 0 },
    furniture: snap.furniture,
    presenceRevision: snap.presenceRevision,
    atmosphereRevision: snap.atmosphereRevision,
    furnitureRevision: snap.furnitureRevision,
  };
};

window.__bltPublishPresence = async (payload) => {
  if (payload?.idle || payload?.heartbeat || payload?.pose === "here") {
    const data = await atmosphereSync.api.postPresence(Object.assign({ heartbeat: true }, payload));
    return data;
  }
  await atmosphereSync.publishEvent(payload?.type || "flavor", payload || {});
  return atmosphereSync.fetchSnapshot({ wait: 0, force: true });
};
window.BLTHouseExtPublishPresence = window.__bltPublishPresence;

window.BLTHouseExtFetchLayout = async (houseId, opts) => {
  const snap = await atmosphereSync.api.fetchSnapshot(houseId, {
    sinceFurniture: opts?.since || 0,
    wait: opts?.wait || 0,
  });
  if (!snap) return null;
  const rooms = {};
  Object.values(snap.furniture || {}).forEach((f) => {
    rooms[f.room || "common"] = rooms[f.room || "common"] || {};
    rooms[f.room || "common"]["object:" + f.id] = { x: f.x, y: f.y };
  });
  return { ok: true, rooms, rev: snap.furnitureRevision, furnitureRevision: snap.furnitureRevision, furniture: snap.furniture };
};

window.BLTHouseExtPublishLayout = async (payload) => {
  if (payload?.reset) {
    return { ok: true, furnitureRevision: atmosphereStore.guard.furnitureRevision };
  }
  const positions = payload?.positions || {};
  for (const key of Object.keys(positions)) {
    const idx = key.indexOf(":");
    const furnitureId = idx >= 0 ? key.slice(idx + 1) : key;
    const p = positions[key];
    await atmosphereSync.moveFurniture({
      furnitureId,
      room: payload.room || window.currentTab || "common",
      x: p.x,
      y: p.y,
      baseRevision: atmosphereStore.guard.furnitureRevision,
    });
  }
  return { ok: true, furnitureRevision: atmosphereStore.guard.furnitureRevision };
};

window.getLayoutCacheKey = (houseId) => "blt_ui_cache_" + (houseId || "default");

function mirrorPresenceToPanel() {
  try {
    if (typeof window.presence !== "object") return;
    window.presence.actors = Object.assign({}, atmosphereStore.presence.actors);
    if (Array.isArray(atmosphereStore.liveLog)) {
      window.liveLog = atmosphereStore.liveLog.slice();
    }
    window.seenEventIds = atmosphereStore.seenEventIds;
  } catch { /* panel not ready */ }
}

function bindRenderPipeline() {
  atmosphereStore.onChange((kind) => {
    try {
      mirrorPresenceToPanel();
      if (kind === "gap" && atmosphereSync.houseId) {
        atmosphereSync.fetchSnapshot({ wait: 0, force: true }).catch(() => {});
        return;
      }
      if (window.house && typeof window.renderPresenceOnly === "function") {
        window.renderPresenceOnly();
      }
      if (kind === "snapshot" && window.house && typeof window.applyLayoutToScene === "function") {
        const rooms = {};
        Object.values(atmosphereStore.furniture || {}).forEach((f) => {
          rooms[f.room || "common"] = rooms[f.room || "common"] || {};
          rooms[f.room || "common"]["object:" + f.id] = { x: f.x, y: f.y };
        });
        if (typeof window.mergeLayoutRooms === "function") window.mergeLayoutRooms(rooms);
        window.applyLayoutToScene(window.currentTab);
      }
      if (typeof window.updateSyncDiagnostics === "function") window.updateSyncDiagnostics();
    } catch { /* ignore */ }
  });
}

bindRenderPipeline();
window.__bltSyncReady = true;
window.__bltReady = true;

/** Called by panel after house is loaded */
window.__bltStartAtmosphere = async function (houseId) {
  try {
    await window.BLTHouseAtmosphere.start(houseId);
    if (typeof window.updateSyncDiagnostics === "function") window.updateSyncDiagnostics();
  } catch (e) {
    console.warn("atmosphere start", e);
  }
};

export { esc, cssEsc, newId, gameStore, atmosphereStore, atmosphereSync, gameCommands };
