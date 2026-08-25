import { createRevisionGuard, applyIfNewer, shouldApply } from "../shared/revisions.js";

/** Ephemeral presence + event stream + authoritative furniture map. */
export class AtmosphereStore {
  constructor() {
    this.guard = createRevisionGuard();
    this.presence = { actors: {} };
    this.events = [];
    this.furniture = {};
    this.seenEventIds = new Set();
    this.liveLog = [];
    this.joinedAt = Date.now();
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind) {
    for (const fn of this.listeners) fn(kind, this);
  }

  applySnapshot(snap, opts = {}) {
    if (!snap) return false;
    const changed = applyIfNewer(this.guard, {
      atmosphereRevision: snap.atmosphereRevision,
      presenceRevision: snap.presenceRevision,
      furnitureRevision: snap.furnitureRevision,
      updatedAt: snap.updatedAt,
    });

    if (snap.presence?.actors) {
      const pr = Number(snap.presenceRevision || 0);
      if (shouldApply(this.guard, "presenceRevision", pr) || opts.force) {
        this._mergeActors(snap.presence.actors);
      }
    }

    if (snap.furniture && typeof snap.furniture === "object") {
      const fr = Number(snap.furnitureRevision || 0);
      if (shouldApply(this.guard, "furnitureRevision", fr) || opts.force) {
        Object.assign(this.furniture, snap.furniture);
      }
    }

    const events = Array.isArray(snap.events) ? snap.events : [];
    for (const ev of events) this.ingestEvent(ev, opts);

    if (changed || events.length) this.emit("snapshot");
    return true;
  }

  _mergeActors(incoming) {
    const next = Object.assign({}, this.presence.actors);
    Object.keys(incoming || {}).forEach((k) => {
      const a = incoming[k];
      const cur = next[k];
      const rev = Number(a.revision ?? a.presenceRevision ?? a.ts ?? 0);
      const curRev = Number(cur?.revision ?? cur?.presenceRevision ?? cur?.ts ?? 0);
      if (!cur || rev >= curRev) next[k] = Object.assign({}, cur || {}, a);
    });
    const now = Date.now();
    Object.keys(next).forEach((k) => {
      if (now - Number(next[k].lastSeen ?? next[k].ts ?? 0) > 65000) delete next[k];
    });
    this.presence.actors = next;
  }

  ingestEvent(ev, opts = {}) {
    if (!ev) return;
    const id = String(ev.eventId || ev.id || "");
    if (!id || this.seenEventIds.has(id)) return;
    this.seenEventIds.add(id);
    const seq = Number(ev.sequence || 0);
    const ar = Number(ev.atmosphereRevision || this.guard.atmosphereRevision || 0);
    if (seq && this.guard.atmosphereRevision && seq > this.guard.atmosphereRevision + 1) {
      this.emit("gap", { expected: this.guard.atmosphereRevision + 1, got: seq });
    }
    if (ar > this.guard.atmosphereRevision) this.guard.atmosphereRevision = ar;

    if (opts.seedOnly && Number(ev.timestamp || ev.ts || 0) + 500 < this.joinedAt) return;

    const payload = ev.payload || ev;
    const login = String(ev.actorId || payload.login || "").toLowerCase();
    if (login) {
      this.presence.actors[login] = Object.assign({}, this.presence.actors[login] || {}, {
        login,
        display: payload.display || login,
        pose: payload.pose || "here",
        object: payload.object || "",
        room: payload.room || "",
        x: payload.x != null ? Number(payload.x) : this.presence.actors[login]?.x,
        y: payload.y != null ? Number(payload.y) : this.presence.actors[login]?.y,
        lastSeen: Date.now(),
        revision: Number(ev.presenceRevision || this.guard.presenceRevision || 0),
      });
    }

    const text = ev.text || payload.text || [payload.display || login, payload.pose, payload.object].filter(Boolean).join(" · ");
    this.liveLog.push({ id, text, ts: Number(ev.timestamp || ev.ts || Date.now()) });
    while (this.liveLog.length > 12) this.liveLog.shift();
    while (this.seenEventIds.size > 120) {
      this.seenEventIds.delete(this.seenEventIds.values().next().value);
    }
    this.emit("event", ev);
  }

  furniturePosition(id) {
    return this.furniture[id] || null;
  }
}
