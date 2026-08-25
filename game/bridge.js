import { queueBase, newId, cfg } from "../shared/util.js";
import { parseRoute } from "../shared/routing.js";

export class GameBridge {
  async enqueueAction(messageObj) {
    const base = queueBase();
    if (!base) throw new Error("ebsUrl not set");
    const channel = String(cfg().broadcasterId || cfg().channel || "default");
    const twitch = window.BLTHouseTwitch || {};
    const commandId = messageObj.commandId || messageObj.id || newId("cmd-");
    const body = {
      channel,
      commandId,
      action: messageObj.action,
      houseId: messageObj.houseId,
      viewer: (twitch.user && twitch.user.login) || messageObj.viewer || "",
      twitchToken: twitch.token || "",
      target: messageObj.target || "",
      value: messageObj.value || "",
      message: Object.assign({ v: 2, kind: "action", commandId }, messageObj),
    };
    const res = await fetch(base + "/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "queue " + res.status);
      err.code = data.error || String(res.status);
      err.body = data;
      throw err;
    }
    return { ok: true, commandId, data };
  }

  async fetchState(houseId, viewer) {
    const base = queueBase();
    if (!base || !houseId) return null;
    const twitch = window.BLTHouseTwitch || {};
    const who = (twitch.user && twitch.user.login) || viewer || "";
    const qs = new URLSearchParams({ house: houseId });
    if (who) qs.set("viewer", who);
    const res = await fetch(base + "/state?" + qs.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data?.house) return null;
    return {
      house: data.house,
      gameRevision: Number(data.gameRevision ?? data.ts ?? 0),
      lastProcessedCommandId: data.lastProcessedCommandId || "",
      updatedAt: Number(data.updatedAt ?? data.ts ?? 0),
    };
  }

  async waitForCommand(houseId, commandId, prevGameRevision, timeoutMs, viewer) {
    const t0 = Date.now();
    const limit = timeoutMs || 12000;
    while (Date.now() - t0 < limit) {
      const snap = await this.fetchState(houseId, viewer);
      if (!snap) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (commandId && snap.lastProcessedCommandId === commandId) return snap;
      if (prevGameRevision != null && snap.gameRevision > prevGameRevision) return snap;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.fetchState(houseId, viewer);
  }
}
