import { AtmosphereApi } from "./api.js";
import { RealtimeNotify } from "./realtime.js";
import { newId, sleep } from "../shared/util.js";
import { parseRoute, twitchLoggedIn } from "../shared/routing.js";

/**
 * Single atmosphere sync coordinator.
 * Worker+D1 = source of truth. Supabase = notify-only transport (no dual state write).
 */
export class AtmosphereSync {
  constructor(store) {
    this.store = store;
    this.api = new AtmosphereApi();
    this.realtime = new RealtimeNotify(this);
    this.houseId = "";
    this.running = false;
    this._seeded = false;
    this.diagnostics = {
      worker: "unknown",
      realtime: "disabled",
      status: "idle",
    };
  }

  async start(houseId) {
    this.houseId = houseId || parseRoute().houseId;
    if (!this.houseId || this.running) return;
    this.running = true;
    this.store.joinedAt = Date.now();
    await this.realtime.connect(this.houseId);
    await this.announceHere();
    this.pollLoop();
  }

  stop() {
    this.running = false;
    this.realtime.disconnect();
  }

  cursors() {
    return {
      presenceRevision: this.store.guard.presenceRevision,
      atmosphereRevision: this.store.guard.atmosphereRevision,
      furnitureRevision: this.store.guard.furnitureRevision,
    };
  }

  async fetchSnapshot(opts = {}) {
    const snap = await this.api.fetchSnapshot(this.houseId, Object.assign({}, this.cursors(), opts));
    if (!snap) return null;
    this.store.applySnapshot(snap, { seedOnly: !this._seeded && opts.seedOnly !== false, force: opts.force });
    this._seeded = true;
    this.diagnostics.worker = "connected";
    this.diagnostics.status = "synced";
    return snap;
  }

  async onNotify(revisions) {
    if (!revisions) return;
    const need =
      Number(revisions.atmosphereRevision || 0) > this.store.guard.atmosphereRevision ||
      Number(revisions.presenceRevision || 0) > this.store.guard.presenceRevision ||
      Number(revisions.furnitureRevision || 0) > this.store.guard.furnitureRevision;
    if (need) await this.fetchSnapshot({ wait: 0, force: false });
  }

  async pollLoop() {
    while (this.running) {
      try {
        const wait = this._seeded ? 2500 : 0;
        await this.fetchSnapshot({ wait, seedOnly: !this._seeded });
        if (twitchLoggedIn()) await this.heartbeat();
        if (!wait) await sleep(400);
      } catch {
        this.diagnostics.worker = "error";
        await sleep(1000);
      }
    }
  }

  async announceHere() {
    if (!twitchLoggedIn()) return;
    const u = window.BLTHouseTwitch.user;
    const login = String(u.login || "").toLowerCase();
    const mine = this.store.presence.actors[login] || {};
    await this.api.postPresence({
      heartbeat: true,
      login,
      display: u.display || login,
      room: window.currentTab || "common",
      pose: mine.pose || "here",
      object: mine.object || "",
      x: mine.x ?? null,
      y: mine.y ?? null,
    }).catch(() => {});
  }

  async heartbeat() {
    if (!twitchLoggedIn()) return;
    if (Date.now() - (window.__bltPresenceBeat || 0) < 8000) return;
    window.__bltPresenceBeat = Date.now();
    await this.announceHere();
  }

  async publishEvent(type, payload) {
    const envelope = {
      eventId: newId("ev-"),
      type,
      actorId: String(window.BLTHouseTwitch?.user?.login || "").toLowerCase(),
      timestamp: Date.now(),
      payload,
    };
    const res = await this.api.postEvent(envelope);
    if (res) this.store.applySnapshot(this._responseToSnapshot(res), { force: true });
    await this.realtime.notifyRevisions(this.houseId, {
      atmosphereRevision: this.store.guard.atmosphereRevision,
      presenceRevision: this.store.guard.presenceRevision,
    });
    return envelope.eventId;
  }

  async moveFurniture({ furnitureId, room, x, y, baseRevision }) {
    const res = await this.api.postFurnitureCommand({
      furnitureId,
      room,
      x,
      y,
      baseRevision: baseRevision ?? this.store.guard.furnitureRevision,
    });
    if (res?.furniture) {
      Object.assign(this.store.furniture, res.furniture);
      if (res.furnitureRevision) this.store.guard.furnitureRevision = Number(res.furnitureRevision);
    }
    await this.realtime.notifyRevisions(this.houseId, {
      furnitureRevision: this.store.guard.furnitureRevision,
    });
    return res;
  }

  _responseToSnapshot(res) {
    if (res.presence || res.furniture) return res;
    return {
      presence: { actors: res.actors || {} },
      events: res.events || (res.event ? [res.event] : []),
      presenceRevision: res.presenceRevision || res.rev || 0,
      atmosphereRevision: res.atmosphereRevision || res.eventRev || res.rev || 0,
      furnitureRevision: res.furnitureRevision || res.layout?.rev || 0,
      furniture: res.furniture || {},
      updatedAt: res.updatedAt || Date.now(),
    };
  }
}
