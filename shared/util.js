/** @typedef {{ x: number, y: number }} Point */

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function cssEsc(s) {
  try {
    return window.CSS?.escape ? CSS.escape(String(s ?? "")) : String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  } catch {
    return String(s ?? "");
  }
}

export function clean(s) {
  return String(s ?? "").trim();
}

export function newId(prefix = "") {
  try {
    if (crypto?.randomUUID) return prefix + crypto.randomUUID();
  } catch { /* ignore */ }
  return prefix + "e" + Date.now() + "-" + Math.random().toString(16).slice(2, 10);
}

export function cfg() {
  return window.BLT_HOUSE_EXT || {};
}

export function queueBase() {
  return String(cfg().ebsUrl || cfg().queueUrl || "").replace(/\/$/, "");
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
