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

// ─── Global API for panel UI (legacy render functions) ─────────────────────
window.parseRoute = parseRoute;
window.isQueueMode = isQueueMode;
window.twitchLoggedIn = twitchLoggedIn;
window.isOwnerNow = () => gameStore.ownerNow();

window.BLTHouseGame = { store: gameStore, commands: gameCommands, bridge: gameBridge };
window.BLTHouseAtmosphere = { store: atmosphereStore, sync: atmosphereSync, objects: { buildFurnitureCatalog, atmosphereActions, bannerlordActions, inferType } };
window.BLTHouseExtPublishAction = (action, extra) => gameCommands.publish(action, extra);
window.BLTHouseExtFetchState = (houseId, viewer) => gameBridge.fetchState(houseId, viewer);
window.BLTHouseExtWaitState = async (houseId, prevTs, timeoutMs, viewer) => {
  const snap = await gameBridge.waitForCommand(houseId, null, prevTs, timeoutMs, viewer);
  return snap?.house || null;
};

// Single-path atmosphere publish (Worker authoritative; Supabase notify-only)
window.__bltPublishPresence = async (payload) => {
  if (payload?.idle || payload?.heartbeat || payload?.pose === "here") {
    return atmosphereSync.api.postPresence(Object.assign({ heartbeat: true }, payload));
  }
  await atmosphereSync.publishEvent(payload?.type || "flavor", payload);
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
  return { ok: true, rooms, rev: snap.furnitureRevision, furnitureRevision: snap.furnitureRevision };
};
window.BLTHouseExtPublishLayout = async (payload) => {
  if (payload.reset) return { ok: true };
  const positions = payload.positions || {};
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

// Cache: UI prefs only, not authoritative layout
window.getLayoutCacheKey = (houseId) => "blt_ui_cache_" + (houseId || "default");

function bindRenderPipeline() {
  atmosphereStore.onChange((kind) => {
    if (typeof window.renderPresenceOnly === "function") window.renderPresenceOnly();
    if (kind === "snapshot" && typeof window.applyLayoutToScene === "function") {
      window.applyLayoutToScene(window.currentTab);
    }
    if (typeof window.updateSyncDiagnostics === "function") window.updateSyncDiagnostics();
  });
  gameStore.onChange(() => {
    if (typeof window.renderHeader === "function") window.renderHeader();
    if (typeof window.renderSide === "function") window.renderSide();
    if (typeof window.updateSyncDiagnostics === "function") window.updateSyncDiagnostics();
  });
}

async function bootGame() {
  const { houseId } = parseRoute();
  if (!houseId) return;
  const snap = await gameBridge.fetchState(houseId, window.BLTHouseTwitch?.user?.login);
  if (snap) gameStore.applySnapshot({ house: snap.house, gameRevision: snap.gameRevision, lastProcessedCommandId: snap.lastProcessedCommandId, updatedAt: snap.updatedAt });
}

async function bootAtmosphere() {
  const { houseId } = parseRoute();
  if (!houseId || !isQueueMode()) return;
  await atmosphereSync.start(houseId);
}

export async function initApp() {
  bindRenderPipeline();
  if (window.BLTHouseTwitch) await window.BLTHouseTwitch.init();
  if (typeof window.updateAuthUi === "function") window.updateAuthUi();
  await bootGame();
  if (typeof window.refresh === "function") await window.refresh(true);
  if (isQueueMode()) {
    if (typeof window.setSync === "function") window.setSync(true, typeof window.defaultSyncLabel === "function" ? window.defaultSyncLabel() : "Онлайн");
    if (typeof window.setFooter === "function") {
      window.setFooter(isOwnerNow()
        ? "Владелец · очередь в игру"
        : (twitchLoggedIn() ? "Гость · кликай объекты" : "Просмотр · войди Twitch"));
    }
    await bootAtmosphere();
  }
  window.__bltReady = true;
}

// Panel script loads after — wait for DOM
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initApp().catch(console.error));
} else {
  initApp().catch(console.error);
}

export { esc, cssEsc, newId, gameStore, atmosphereStore, atmosphereSync, gameCommands };
