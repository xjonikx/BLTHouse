import { GameBridge } from "./bridge.js";

export class GameCommands {
  /** @param {import('./store.js').GameStore} store */
  constructor(store) {
    this.store = store;
    this.bridge = new GameBridge();
  }

  async publish(action, extra) {
    const route = window.parseRoute?.() || { houseId: "" };
    const twitch = window.BLTHouseTwitch || {};
    const commandId = this.store.trackCommand(
      extra?.commandId || crypto.randomUUID?.() || "cmd-" + Date.now()
    );
    const prevRev = this.store.guard.gameRevision;
    const messageObj = Object.assign(
      {
        v: 2,
        kind: "action",
        domain: "bannerlord",
        commandId,
        action,
        houseId: route.houseId || extra?.houseId || "",
        viewer: (twitch.user && twitch.user.login) || "",
        target: "",
        value: "",
      },
      extra || {}
    );
    const result = await this.bridge.enqueueAction(messageObj);
    const pending = this.store.pendingCommands.get(commandId);
    if (pending) pending.status = "queued";
    return { commandId, prevGameRevision: prevRev, result };
  }

  async waitResult(commandId, prevGameRevision, houseId, viewer) {
    const snap = await this.bridge.waitForCommand(houseId, commandId, prevGameRevision, 12000, viewer);
    if (snap?.house) this.store.applySnapshot(snap);
    return snap;
  }
}
