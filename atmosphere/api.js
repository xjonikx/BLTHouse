import { queueBase, newId } from "../shared/util.js";
import { parseRoute } from "../shared/routing.js";

export class AtmosphereApi {
  base() {
    return queueBase();
  }

  async fetchSnapshot(houseId, cursors = {}) {
    const base = this.base();
    if (!base || !houseId) return null;
    const q = new URLSearchParams({ house: houseId });
    if (cursors.presenceRevision != null) q.set("sincePresence", String(cursors.presenceRevision));
    if (cursors.atmosphereRevision != null) q.set("sinceAtmosphere", String(cursors.atmosphereRevision));
    if (cursors.furnitureRevision != null) q.set("sinceFurniture", String(cursors.furnitureRevision));
    if (cursors.wait != null) q.set("wait", String(cursors.wait));
    q.set("_", String(Date.now()));
    let res = await fetch(base + "/atmosphere/snapshot?" + q.toString(), { cache: "no-store" });
    if (!res.ok) {
      // Backward compat with legacy worker
      res = await fetch(base + "/presence?" + new URLSearchParams({
        house: houseId,
        since: String(cursors.presenceRevision || 0),
        wait: String(cursors.wait || 0),
        _: String(Date.now()),
      }), { cache: "no-store" });
      if (!res.ok) return null;
      const legacy = await res.json().catch(() => null);
      return legacy ? this._legacyToSnapshot(legacy) : null;
    }
    return res.json().catch(() => null);
  }

  _legacyToSnapshot(legacy) {
    return {
      ok: true,
      presence: { actors: legacy.actors || {}, revision: legacy.rev || 0 },
      events: legacy.events || [],
      furniture: legacy.layout?.rooms ? this._roomsToFurniture(legacy.layout.rooms) : {},
      furnitureRevision: legacy.layout?.rev || 0,
      atmosphereRevision: legacy.eventRev || legacy.rev || 0,
      presenceRevision: legacy.rev || 0,
      updatedAt: legacy.ts || Date.now(),
    };
  }

  _roomsToFurniture(rooms) {
    const out = {};
    Object.keys(rooms || {}).forEach((room) => {
      Object.keys(rooms[room] || {}).forEach((key) => {
        const idx = key.indexOf(":");
        if (idx < 0 || !key.startsWith("object:")) return;
        const id = key.slice(idx + 1);
        const p = rooms[room][key];
        out[id] = { id, room, x: p.x, y: p.y };
      });
    });
    return out;
  }

  async postPresence(payload) {
    const base = this.base();
    const twitch = window.BLTHouseTwitch || {};
    if (!base || !twitch.token) throw new Error("login_required");
    const route = parseRoute();
    const res = await fetch(base + "/atmosphere/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        houseId: route.houseId,
        twitchToken: twitch.token,
        heartbeat: true,
      }, payload)),
    });
    if (!res.ok) {
      // legacy
      return fetch(base + "/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ houseId: route.houseId, twitchToken: twitch.token, idle: payload.heartbeat === true }, payload)),
      }).then((r) => r.json());
    }
    return res.json();
  }

  async postEvent(envelope) {
    const base = this.base();
    const twitch = window.BLTHouseTwitch || {};
    if (!base || !twitch.token) throw new Error("login_required");
    const route = parseRoute();
    const res = await fetch(base + "/atmosphere/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        houseId: route.houseId,
        twitchToken: twitch.token,
        version: 1,
        eventId: envelope.eventId || newId("ev-"),
        domain: "atmosphere",
      }, envelope)),
    });
    if (!res.ok) {
      return fetch(base + "/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({
          houseId: route.houseId,
          twitchToken: twitch.token,
          idle: false,
          eventId: envelope.eventId,
          pose: envelope.payload?.pose,
          object: envelope.payload?.object,
          room: envelope.payload?.room,
          x: envelope.payload?.x,
          y: envelope.payload?.y,
        }, envelope.payload || {})),
      }).then((r) => r.json());
    }
    return res.json();
  }

  async postFurnitureCommand(cmd) {
    const base = this.base();
    const twitch = window.BLTHouseTwitch || {};
    if (!base || !twitch.token) throw new Error("login_required");
    const route = parseRoute();
    const res = await fetch(base + "/atmosphere/furniture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        houseId: route.houseId,
        twitchToken: twitch.token,
        commandId: cmd.commandId || newId("furn-"),
        type: "move_furniture",
      }, cmd)),
    });
    if (!res.ok) {
      const positions = {};
      if (cmd.furnitureId) positions["object:" + cmd.furnitureId] = { x: cmd.x, y: cmd.y };
      return fetch(base + "/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          houseId: route.houseId,
          twitchToken: twitch.token,
          room: cmd.room,
          positions,
        }),
      }).then((r) => r.json());
    }
    return res.json();
  }
}
