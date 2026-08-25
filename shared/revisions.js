/**
 * Client-side revision guards — never use timestamp as ordering primitive.
 */
export function createRevisionGuard() {
  return {
    gameRevision: 0,
    atmosphereRevision: 0,
    presenceRevision: 0,
    furnitureRevision: 0,
    updatedAt: 0,
  };
}

export function applyIfNewer(guard, incoming) {
  if (!incoming || typeof incoming !== "object") return false;
  let changed = false;
  const fields = ["gameRevision", "atmosphereRevision", "presenceRevision", "furnitureRevision"];
  for (const f of fields) {
    const next = Number(incoming[f] ?? incoming[f.replace("Revision", "_revision")] ?? 0);
    if (next > Number(guard[f] || 0)) {
      guard[f] = next;
      changed = true;
    }
  }
  const ts = Number(incoming.updatedAt ?? incoming.updated_at ?? 0);
  if (ts >= guard.updatedAt) guard.updatedAt = ts;
  return changed;
}

export function shouldApply(guard, field, revision) {
  const rev = Number(revision || 0);
  if (!rev) return true;
  return rev >= Number(guard[field] || 0);
}
