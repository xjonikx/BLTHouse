import { createRevisionGuard, applyIfNewer, shouldApply } from "../shared/revisions.js";
import { isOwnerNow } from "../shared/routing.js";

/** Bannerlord game state — never mutated by atmosphere. */
export class GameStore {
  constructor() {
    this.house = null;
    this.guard = createRevisionGuard();
    this.listeners = new Set();
    this.pendingCommands = new Map();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.house);
  }

  applyPanelHouse(raw) {
    if (!raw || typeof raw !== "object") return this.house;
    const owner = String(raw.ownerPlayerId || raw.OwnerPlayerId || raw.ownerName || "").toLowerCase();
    const login = String(window.BLTHouseTwitch?.user?.login || "").toLowerCase();
    const isOwner = !!(login && owner && login === owner);
    const h = Object.assign({}, raw);
    h.isOwnerViewer = isOwner;
    if (!isOwner) {
      delete h.gold;
      delete h.Gold;
      delete h.heroInventory;
      delete h.HeroInventory;
    }
    this.house = h;
    return h;
  }

  applySnapshot(snap) {
    if (!snap?.house) return false;
    const rev = Number(snap.gameRevision ?? snap.ts ?? 0);
    if (!shouldApply(this.guard, "gameRevision", rev) && this.house) return false;
    applyIfNewer(this.guard, {
      gameRevision: rev,
      updatedAt: snap.updatedAt ?? snap.ts,
    });
    this.applyPanelHouse(snap.house);
    if (snap.lastProcessedCommandId) {
      const cmd = this.pendingCommands.get(snap.lastProcessedCommandId);
      if (cmd) {
        cmd.status = "completed";
        cmd.completedAt = Date.now();
      }
    }
    this.emit();
    return true;
  }

  trackCommand(commandId) {
    this.pendingCommands.set(commandId, {
      commandId,
      status: "queued",
      createdAt: Date.now(),
    });
    while (this.pendingCommands.size > 40) {
      const first = this.pendingCommands.keys().next().value;
      this.pendingCommands.delete(first);
    }
    return commandId;
  }

  ownerNow() {
    return isOwnerNow(this.house);
  }
}
