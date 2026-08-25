import { cfg } from "../shared/util.js";

/**
 * Supabase is notify-only: broadcasts revision pointers, never authoritative state.
 */
export class RealtimeNotify {
  /** @param {import('./sync.js').AtmosphereSync} sync */
  constructor(sync) {
    this.sync = sync;
    this.client = null;
    this.channel = null;
    this.houseId = "";
  }

  enabled() {
    const c = cfg();
    return !!(c.supabaseUrl && c.supabaseAnonKey && window.supabase);
  }

  async connect(houseId) {
    this.houseId = houseId;
    await this.disconnect();
    if (!this.enabled() || !houseId) {
      this.sync.diagnostics.realtime = "disabled";
      return false;
    }
    if (!this.client) {
      this.client = window.supabase.createClient(cfg().supabaseUrl, cfg().supabaseAnonKey, {
        realtime: { params: { eventsPerSecond: 20 } },
      });
    }
    this.channel = this.client.channel("blt-house-notify:" + houseId, {
      config: { broadcast: { self: false, ack: false } },
    });
    this.channel.on("broadcast", { event: "atmosphere_notify" }, ({ payload }) => {
      this.sync.onNotify(payload);
    });
    await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 4000);
      this.channel.subscribe((status) => {
        if (status === "SUBSCRIBED") { clearTimeout(to); resolve(true); }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(to); resolve(false);
        }
      });
    });
    this.sync.diagnostics.realtime = "connected";
    return true;
  }

  async disconnect() {
    if (this.channel) {
      try { await this.channel.unsubscribe(); } catch { /* ignore */ }
      this.channel = null;
    }
  }

  async notifyRevisions(houseId, revisions) {
    if (!this.channel) return;
    try {
      await this.channel.send({
        type: "broadcast",
        event: "atmosphere_notify",
        payload: Object.assign({ houseId, ts: Date.now() }, revisions),
      });
    } catch { /* optional transport */ }
  }
}
