/**
 * BLTHouse Sync Worker v2 — atmosphere + game domains separated.
 * Deploy from new-web/worker/ (replace existing ebs-worker.js on Cloudflare).
 *
 * Atmosphere: D1 authoritative (presence, events, furniture, monotonic revisions)
 * Game: KV queue + state (Bannerlord authoritative)
 * Realtime: client uses Supabase notify-only; Worker is source of truth.
 */
const memHits = new Map();
const twitchMem = new Map();
const waiters = { presence: new Map(), layout: new Map(), atmosphere: new Map(), action: new Map() };
let d1SchemaOk = false;

function kv(env) {
  const cand = env && (env.QUEUE || env.KV || env.HOUSE || env.BLTHOUSE);
  return cand && typeof cand.get === "function" ? cand : null;
}
function d1(env) {
  const db = env && (env.DB || env.PRESENCE_DB);
  return db && typeof db.prepare === "function" ? db : null;
}
function d1Session(env) {
  const db = d1(env);
  return db && typeof db.withSession === "function" ? db.withSession("first-primary") : db;
}
function clean(s) { return String(s ?? "").trim(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cors(env, request) {
  const origin = clean(env.ALLOWED_ORIGIN) || request?.headers?.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Queue-Secret",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, status, env, request) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, cors(env, request)),
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, request) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/") {
        return json({
          ok: true, service: "blt-house-sync-v2", kv: !!kv(env), d1: !!d1(env),
          routes: ["/action", "/poll", "/state", "/presence", "/layout", "/atmosphere/snapshot", "/atmosphere/presence", "/atmosphere/event", "/atmosphere/furniture"],
        }, 200, env, request);
      }
      if (request.method === "POST" && path === "/action") return enqueue(request, env);
      if (request.method === "GET" && path === "/poll") return poll(request, env, url);
      if (request.method === "POST" && path === "/state") return putState(request, env);
      if (request.method === "GET" && path === "/state") return getState(request, env, url);
      if (request.method === "GET" && path === "/houses") return listHouses(request, env);
      if (request.method === "GET" && path === "/presence") return getPresenceLegacy(request, env, url);
      if (request.method === "POST" && path === "/presence") return postPresenceLegacy(request, env);
      if (request.method === "GET" && path === "/layout") return getLayoutLegacy(request, env, url);
      if (request.method === "POST" && path === "/layout") return postLayoutLegacy(request, env);
      if (request.method === "GET" && path === "/atmosphere/snapshot") return getAtmosphereSnapshot(request, env, url);
      if (request.method === "POST" && path === "/atmosphere/presence") return postAtmospherePresence(request, env);
      if (request.method === "POST" && path === "/atmosphere/event") return postAtmosphereEvent(request, env);
      if (request.method === "POST" && path === "/atmosphere/furniture") return postAtmosphereFurniture(request, env);
      return json({ ok: false, error: "not found" }, 404, env, request);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500, env, request);
    }
  },
};

// ─── Schema ───────────────────────────────────────────────────────────────
async function ensureSchema(env) {
  const db = d1Session(env);
  if (!db) return null;
  if (!d1SchemaOk) {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS atmosphere_meta (
        house_id TEXT PRIMARY KEY,
        atmosphere_revision INTEGER NOT NULL DEFAULT 0,
        presence_revision INTEGER NOT NULL DEFAULT 0,
        furniture_revision INTEGER NOT NULL DEFAULT 0,
        game_revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS presence_actors (
        house_id TEXT NOT NULL, login TEXT NOT NULL, display TEXT, room TEXT,
        pose TEXT, object TEXT, x REAL, y REAL, last_seen INTEGER NOT NULL,
        PRIMARY KEY (house_id, login)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS atmosphere_events (
        event_id TEXT PRIMARY KEY, house_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        actor_id TEXT, type TEXT, event_json TEXT NOT NULL, created_at INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS atmosphere_furniture (
        house_id TEXT NOT NULL, furniture_id TEXT NOT NULL, room TEXT,
        x REAL, y REAL, state TEXT, meta_json TEXT,
        PRIMARY KEY (house_id, furniture_id)
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_atmo_events_house_seq ON atmosphere_events (house_id, sequence)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS layout_state (
        house_id TEXT PRIMARY KEY, rooms_json TEXT NOT NULL, ts INTEGER NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS presence_events (
        id TEXT PRIMARY KEY, house_id TEXT NOT NULL, login TEXT, display TEXT, pose TEXT,
        object TEXT, room TEXT, text TEXT, x REAL, y REAL, ts INTEGER NOT NULL
      )`),
    ]);
    d1SchemaOk = true;
  }
  return db;
}

async function ensureMeta(db, houseId) {
  await db.prepare(
    "INSERT OR IGNORE INTO atmosphere_meta (house_id, atmosphere_revision, presence_revision, furniture_revision, game_revision, updated_at) VALUES (?, 0, 0, 0, 0, ?)"
  ).bind(houseId, Date.now()).run();
  return db.prepare("SELECT * FROM atmosphere_meta WHERE house_id = ?").bind(houseId).first();
}

async function bumpRevision(db, houseId, field) {
  const now = Date.now();
  await ensureMeta(db, houseId);
  await db.prepare(
    `UPDATE atmosphere_meta SET ${field} = ${field} + 1, updated_at = ? WHERE house_id = ?`
  ).bind(now, houseId).run();
  return db.prepare("SELECT * FROM atmosphere_meta WHERE house_id = ?").bind(houseId).first();
}

// ─── Atmosphere snapshot ────────────────────────────────────────────────────
async function buildAtmosphereSnapshot(env, houseId) {
  const db = await ensureSchema(env);
  const now = Date.now();
  if (!db) return { houseId, presence: { actors: {} }, events: [], furniture: {}, updatedAt: now };

  const meta = (await ensureMeta(db, houseId)) || {};
  const actorRows = await db.prepare(
    "SELECT login, display, room, pose, object, x, y, last_seen FROM presence_actors WHERE house_id = ? AND last_seen > ?"
  ).bind(houseId, now - 60000).all();
  const actors = {};
  for (const r of actorRows.results || []) {
    actors[String(r.login).toLowerCase()] = {
      login: r.login, display: r.display, room: r.room, pose: r.pose, object: r.object,
      x: r.x != null ? Number(r.x) : null, y: r.y != null ? Number(r.y) : null,
      lastSeen: Number(r.last_seen), presenceRevision: meta.presence_revision,
    };
  }

  const evRows = await db.prepare(
    "SELECT event_id, sequence, actor_id, type, event_json, created_at FROM atmosphere_events WHERE house_id = ? ORDER BY sequence DESC LIMIT 24"
  ).bind(houseId).all();
  const events = ((evRows.results || []).reverse()).map((r) => {
    let parsed = {};
    try { parsed = JSON.parse(r.event_json); } catch { parsed = {}; }
    return Object.assign({ eventId: r.event_id, sequence: r.sequence, actorId: r.actor_id, type: r.type, timestamp: r.created_at }, parsed);
  });

  const furnRows = await db.prepare(
    "SELECT furniture_id, room, x, y, state, meta_json FROM atmosphere_furniture WHERE house_id = ?"
  ).bind(houseId).all();
  const furniture = {};
  for (const r of furnRows.results || []) {
    let metaJson = {};
    try { metaJson = JSON.parse(r.meta_json || "{}"); } catch { metaJson = {}; }
    furniture[r.furniture_id] = {
      id: r.furniture_id, room: r.room, x: Number(r.x), y: Number(r.y),
      state: r.state, ...metaJson,
    };
  }

  return {
    houseId,
    ok: true,
    atmosphereRevision: Number(meta.atmosphere_revision || 0),
    presenceRevision: Number(meta.presence_revision || 0),
    furnitureRevision: Number(meta.furniture_revision || 0),
    updatedAt: Number(meta.updated_at || now),
    presence: { actors },
    events,
    furniture,
  };
}

async function waitAtmosphere(env, houseId, cursors, waitMs) {
  let snap = await buildAtmosphereSnapshot(env, houseId);
  const changed =
    snap.atmosphereRevision > (cursors.sinceAtmosphere || 0) ||
    snap.presenceRevision > (cursors.sincePresence || 0) ||
    snap.furnitureRevision > (cursors.sinceFurniture || 0);
  if (changed || waitMs <= 0) return snap;
  return new Promise((resolve) => {
    let done = false;
    const key = houseId;
    const finish = (s) => { if (done) return; done = true; clearTimeout(to); waiters.atmosphere.get(key)?.delete(onWake); resolve(s || snap); };
    const onWake = (s) => finish(s);
    if (!waiters.atmosphere.has(key)) waiters.atmosphere.set(key, new Set());
    waiters.atmosphere.get(key).add(onWake);
    const to = setTimeout(() => finish(snap), waitMs);
  });
}

function notifyAtmosphere(houseId, snap) {
  const set = waiters.atmosphere.get(houseId);
  if (!set) return;
  for (const fn of set) { try { fn(snap); } catch { /* ignore */ } }
  set.clear();
}

async function getAtmosphereSnapshot(request, env, url) {
  const houseId = clean(url.searchParams.get("house"));
  if (!houseId) return json({ ok: false, error: "missing house" }, 400, env, request);
  const cursors = {
    sinceAtmosphere: Number(url.searchParams.get("sinceAtmosphere") || 0),
    sincePresence: Number(url.searchParams.get("sincePresence") || 0),
    sinceFurniture: Number(url.searchParams.get("sinceFurniture") || 0),
  };
  const wait = Math.min(2500, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  const snap = await waitAtmosphere(env, houseId, cursors, wait);
  return json(snap, 200, env, request);
}

async function postAtmospherePresence(request, env) {
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const houseId = clean(body.houseId);
  const gate = await twitchGateAny(env, clean(body.twitchToken));
  if (!gate.ok) return json({ ok: false, error: gate.error }, 403, env, request);
  if (!houseId) return json({ ok: false, error: "missing houseId" }, 400, env, request);
  const db = await ensureSchema(env);
  if (!db) return json({ ok: false, error: "d1_required" }, 503, env, request);
  const now = Date.now();
  const meta = await bumpRevision(db, houseId, "presence_revision");
  await db.prepare(
    `INSERT INTO presence_actors (house_id, login, display, room, pose, object, x, y, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(house_id, login) DO UPDATE SET
       display=excluded.display, room=excluded.room, pose=excluded.pose, object=excluded.object,
       x=COALESCE(excluded.x, presence_actors.x), y=COALESCE(excluded.y, presence_actors.y), last_seen=excluded.last_seen`
  ).bind(
    houseId, gate.login, clean(body.display || gate.display).slice(0, 40),
    clean(body.room || "").slice(0, 24), clean(body.pose || "here").slice(0, 40),
    clean(body.object || "").slice(0, 60),
    body.x != null ? Number(body.x) : null, body.y != null ? Number(body.y) : null, now
  ).run();
  const snap = await buildAtmosphereSnapshot(env, houseId);
  notifyAtmosphere(houseId, snap);
  return json({ ok: true, presenceRevision: meta.presence_revision, updatedAt: now, presence: snap.presence }, 200, env, request);
}

async function postAtmosphereEvent(request, env) {
  if (!rateOk(request)) return json({ ok: false, error: "rate limit" }, 429, env, request);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const houseId = clean(body.houseId);
  const gate = await twitchGateAny(env, clean(body.twitchToken));
  if (!gate.ok) return json({ ok: false, error: gate.error }, 403, env, request);
  if (!houseId) return json({ ok: false, error: "missing houseId" }, 400, env, request);
  const db = await ensureSchema(env);
  if (!db) return json({ ok: false, error: "d1_required" }, 503, env, request);
  const now = Date.now();
  const eventId = clean(body.eventId || crypto.randomUUID());
  const metaA = await bumpRevision(db, houseId, "atmosphere_revision");
  const metaP = await bumpRevision(db, houseId, "presence_revision");
  const payload = body.payload || body;
  const envelope = {
    version: 1, eventId, houseId, actorId: gate.login, type: clean(body.type || "flavor"),
    sequence: metaA.atmosphere_revision, timestamp: now,
    atmosphereRevision: metaA.atmosphere_revision, presenceRevision: metaP.presence_revision,
    payload: Object.assign({ login: gate.login, display: gate.display, pose: payload.pose, object: payload.object, room: payload.room, x: payload.x, y: payload.y }, payload),
  };
  await db.prepare(
    "INSERT OR IGNORE INTO atmosphere_events (event_id, house_id, sequence, actor_id, type, event_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(eventId, houseId, metaA.atmosphere_revision, gate.login, envelope.type, JSON.stringify(envelope), now).run();
  await db.prepare(
    `INSERT INTO presence_actors (house_id, login, display, room, pose, object, x, y, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(house_id, login) DO UPDATE SET display=excluded.display, room=excluded.room, pose=excluded.pose,
       object=excluded.object, x=COALESCE(excluded.x, presence_actors.x), y=COALESCE(excluded.y, presence_actors.y), last_seen=excluded.last_seen`
  ).bind(houseId, gate.login, gate.display, clean(payload.room || ""), clean(payload.pose || "here"),
    clean(payload.object || ""), payload.x != null ? Number(payload.x) : null, payload.y != null ? Number(payload.y) : null, now).run();
  const snap = await buildAtmosphereSnapshot(env, houseId);
  notifyAtmosphere(houseId, snap);
  return json({ ok: true, event: envelope, atmosphereRevision: metaA.atmosphere_revision, presenceRevision: metaP.presence_revision, updatedAt: now }, 200, env, request);
}

async function postAtmosphereFurniture(request, env) {
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const houseId = clean(body.houseId);
  const gate = await twitchGateOk(env, clean(body.twitchToken), houseId);
  if (!gate.ok) return json({ ok: false, error: gate.error }, 403, env, request);
  const db = await ensureSchema(env);
  if (!db) return json({ ok: false, error: "d1_required" }, 503, env, request);
  const metaRow = await ensureMeta(db, houseId);
  const currentRev = Number(metaRow.furniture_revision || 0);
  const baseRevision = Number(body.baseRevision || 0);
  if (baseRevision && baseRevision !== currentRev) {
    const snap = await buildAtmosphereSnapshot(env, houseId);
    return json({ ok: false, error: "conflict", furnitureRevision: currentRev, furniture: snap.furniture }, 409, env, request);
  }
  const fid = clean(body.furnitureId);
  if (!fid) return json({ ok: false, error: "missing furnitureId" }, 400, env, request);
  await db.prepare(
    `INSERT INTO atmosphere_furniture (house_id, furniture_id, room, x, y, state, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(house_id, furniture_id) DO UPDATE SET room=excluded.room, x=excluded.x, y=excluded.y, state=excluded.state, meta_json=excluded.meta_json`
  ).bind(houseId, fid, clean(body.room || "common"), Number(body.x), Number(body.y), clean(body.state || ""), JSON.stringify(body.metadata || {})).run();
  const meta = await bumpRevision(db, houseId, "furniture_revision");
  // Legacy layout mirror for old clients
  await syncLegacyLayout(db, env, houseId);
  const snap = await buildAtmosphereSnapshot(env, houseId);
  notifyAtmosphere(houseId, snap);
  return json({ ok: true, furnitureRevision: meta.furniture_revision, furniture: snap.furniture, updatedAt: Date.now() }, 200, env, request);
}

async function syncLegacyLayout(db, env, houseId) {
  const furnRows = await db.prepare("SELECT furniture_id, room, x, y FROM atmosphere_furniture WHERE house_id = ?").bind(houseId).all();
  const rooms = {};
  for (const r of furnRows.results || []) {
    const room = r.room || "common";
    rooms[room] = rooms[room] || {};
    rooms[room]["object:" + r.furniture_id] = { x: Number(r.x), y: Number(r.y) };
  }
  const ts = Date.now();
  await db.prepare(
    "INSERT INTO layout_state (house_id, rooms_json, ts) VALUES (?, ?, ?) ON CONFLICT(house_id) DO UPDATE SET rooms_json=excluded.rooms_json, ts=excluded.ts"
  ).bind(houseId, JSON.stringify(rooms), ts).run();
}

// ─── Legacy compat ──────────────────────────────────────────────────────────
async function getPresenceLegacy(request, env, url) {
  const houseId = clean(url.searchParams.get("house"));
  if (!houseId) return json({ ok: false, error: "missing house" }, 400, env, request);
  const since = Number(url.searchParams.get("since") || 0);
  const wait = Math.min(2500, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  const cursors = { sincePresence: since, sinceAtmosphere: since, sinceFurniture: 0 };
  const snap = await waitAtmosphere(env, houseId, cursors, wait);
  const layout = await loadLegacyLayout(env, houseId);
  const events = (snap.events || []).map((e) => ({
    id: e.eventId, login: e.actorId || e.payload?.login, display: e.payload?.display,
    pose: e.payload?.pose, object: e.payload?.object, room: e.payload?.room,
    x: e.payload?.x, y: e.payload?.y, text: e.payload?.text, ts: e.timestamp,
  }));
  return json({
    ok: true, houseId, via: "d1", rev: snap.presenceRevision, eventRev: snap.atmosphereRevision,
    ts: snap.updatedAt, actors: snap.presence?.actors || {}, events, layout,
  }, 200, env, request);
}

async function postPresenceLegacy(request, env) {
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const idle = body.idle === true || body.heartbeat === true || clean(body.pose) === "here";
  if (idle) {
    body.heartbeat = true;
    return postAtmospherePresence(request, env);
  }
  body.type = "flavor";
  body.payload = {
    pose: body.pose, object: body.object, room: body.room, x: body.x, y: body.y,
    display: body.display, eventId: body.eventId,
  };
  return postAtmosphereEvent(request, env);
}

async function loadLegacyLayout(env, houseId) {
  const db = await ensureSchema(env);
  if (db) {
    const row = await db.prepare("SELECT rooms_json, ts FROM layout_state WHERE house_id = ?").bind(houseId).first();
    if (row?.rooms_json) {
      let rooms = {}; try { rooms = JSON.parse(row.rooms_json); } catch { rooms = {}; }
      return { houseId, rev: Number(row.ts) || 0, ts: Number(row.ts) || 0, rooms };
    }
  }
  return { houseId, rev: 0, ts: 0, rooms: {} };
}

async function getLayoutLegacy(request, env, url) {
  const houseId = clean(url.searchParams.get("house"));
  if (!houseId) return json({ ok: false, error: "missing house" }, 400, env, request);
  const layout = await loadLegacyLayout(env, houseId);
  const snap = await buildAtmosphereSnapshot(env, houseId);
  return json({ ok: true, ...layout, rev: snap.furnitureRevision || layout.rev, furnitureRevision: snap.furnitureRevision }, 200, env, request);
}

async function postLayoutLegacy(request, env) {
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const houseId = clean(body.houseId);
  const gate = await twitchGateOk(env, clean(body.twitchToken), houseId);
  if (!gate.ok) return json({ ok: false, error: gate.error }, 403, env, request);
  const room = clean(body.room || "common");
  const positions = body.positions || {};
  const db = await ensureSchema(env);
  if (!db) return json({ ok: false, error: "d1_required" }, 503, env, request);
  for (const key of Object.keys(positions)) {
    const idx = key.indexOf(":");
    const fid = idx >= 0 ? key.slice(idx + 1) : key;
    const p = positions[key];
    await db.prepare(
      `INSERT INTO atmosphere_furniture (house_id, furniture_id, room, x, y, state, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(house_id, furniture_id) DO UPDATE SET room=excluded.room, x=excluded.x, y=excluded.y`
    ).bind(houseId, fid, room, Number(p.x), Number(p.y), "", "{}").run();
  }
  await bumpRevision(db, houseId, "furniture_revision");
  await syncLegacyLayout(db, env, houseId);
  const snap = await buildAtmosphereSnapshot(env, houseId);
  notifyAtmosphere(houseId, snap);
  const layout = await loadLegacyLayout(env, houseId);
  return json({ ok: true, rooms: layout.rooms, rev: snap.furnitureRevision, furnitureRevision: snap.furnitureRevision }, 200, env, request);
}

// ─── Game queue + state (unchanged semantics, + gameRevision) ───────────────
async function enqueue(request, env) {
  if (!rateOk(request)) return json({ ok: false, error: "rate limit" }, 429, env, request);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const channel = clean(body.channel || body.broadcasterId || "default");
  const houseId = clean(body.houseId || body.message?.houseId);
  const gate = await twitchGateOk(env, clean(body.twitchToken || ""), houseId);
  if (!gate.ok) return json({ ok: false, error: gate.error }, 403, env, request);
  const commandId = clean(body.commandId || body.message?.commandId || body.message?.id || crypto.randomUUID());
  const item = {
    v: 2, kind: "action", domain: "bannerlord", commandId, id: commandId,
    channel, action: clean(body.action || body.message?.action), houseId,
    viewer: gate.login, target: clean(body.target || ""), value: clean(body.value || ""),
    ts: Math.floor(Date.now() / 1000), status: "queued",
  };
  if (!item.action || !item.houseId) return json({ ok: false, error: "missing fields" }, 400, env, request);
  const list = await loadActions(env, channel);
  list.push(item);
  while (list.length > 100) list.shift();
  await saveActions(env, channel, list);
  notifyWaiters("action", channel);
  return json({ ok: true, commandId, queued: commandId, depth: list.length }, 200, env, request);
}

async function waitActions(env, channel, waitMs) {
  let list = await loadActions(env, channel);
  if (list.length) return list;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(to);
      waiters.action.get(channel)?.delete(onWake);
      resolve();
    };
    const onWake = () => finish();
    if (!waiters.action.has(channel)) waiters.action.set(channel, new Set());
    waiters.action.get(channel).add(onWake);
    const to = setTimeout(finish, waitMs);
  });
  return loadActions(env, channel);
}

async function poll(request, env, url) {
  const auth = authCheck(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401, env, request);
  const channel = clean(url.searchParams.get("channel") || "default");
  const waitMs = Math.min(8000, Math.max(0, Number(url.searchParams.get("wait") || 0)));
  let list = await loadActions(env, channel);
  if (!list.length && waitMs > 0) list = await waitActions(env, channel, waitMs);
  if (list.length) await saveActions(env, channel, []);
  return json({ ok: true, actions: list }, 200, env, request);
}

async function putState(request, env) {
  const auth = authCheck(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401, env, request);
  let body; try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400, env, request); }
  const houseId = clean(body.houseId);
  if (!houseId) return json({ ok: false, error: "missing houseId" }, 400, env, request);
  const incomingRev = Number(body.gameRevision ?? body.ts ?? Date.now());
  const existing = await loadState(env, houseId);
  if (existing && Number(existing.gameRevision ?? existing.ts ?? 0) > incomingRev) {
    return json({ ok: true, ignored: true, gameRevision: existing.gameRevision }, 200, env, request);
  }
  const payload = {
    houseId,
    ownerPlayerId: clean(body.ownerPlayerId || body.house?.ownerPlayerId),
    gameRevision: incomingRev,
    ts: incomingRev,
    updatedAt: Date.now(),
    lastProcessedCommandId: clean(body.lastProcessedCommandId || body.lastActionId || ""),
    house: body.house,
    publicHouse: body.publicHouse || body.house,
    ownerHouse: body.ownerHouse || body.house,
  };
  await saveState(env, houseId, payload);
  await touchHouseIndex(env, houseId, body.house);
  const db = await ensureSchema(env);
  if (db) {
    await ensureMeta(db, houseId);
    await db.prepare("UPDATE atmosphere_meta SET game_revision = ?, updated_at = ? WHERE house_id = ? AND game_revision < ?")
      .bind(incomingRev, Date.now(), houseId, incomingRev).run();
  }
  return json({ ok: true, gameRevision: payload.gameRevision }, 200, env, request);
}

async function getState(request, env, url) {
  const houseId = clean(url.searchParams.get("house"));
  const viewer = clean(url.searchParams.get("viewer")).toLowerCase();
  if (!houseId) return json({ ok: false, error: "missing house" }, 400, env, request);
  const payload = await loadState(env, houseId);
  if (!payload) return json({ ok: false, error: "no state" }, 404, env, request);
  const owner = clean(payload.ownerPlayerId || payload.ownerHouse?.ownerPlayerId || payload.publicHouse?.ownerPlayerId).toLowerCase();
  const isOwner = !!viewer && viewer === owner;
  const chosen = isOwner ? (payload.ownerHouse || payload.house) : (payload.publicHouse || payload.house);
  return json({
    ok: true, house: chosen, gameRevision: payload.gameRevision ?? payload.ts,
    lastProcessedCommandId: payload.lastProcessedCommandId || "",
    updatedAt: payload.updatedAt ?? payload.ts, ts: payload.ts,
  }, 200, env, request);
}

async function listHouses(request, env) {
  return json({ ok: true, houses: await loadHouseIndex(env) }, 200, env, request);
}

// ─── Shared helpers (KV, auth, twitch) ────────────────────────────────────
function notifyWaiters(kind, key) {
  const set = waiters[kind]?.get(key);
  if (!set) return;
  for (const fn of set) { try { fn(); } catch { /* ignore */ } }
  set.clear();
}
function rateOk(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "x";
  const now = Date.now();
  let arr = (memHits.get(ip) || []).filter((t) => now - t < 10000);
  if (arr.length >= 40) return false;
  arr.push(now); memHits.set(ip, arr); return true;
}
function authCheck(request, env) {
  const secret = clean(env.QUEUE_SECRET || env.EXTENSION_SECRET || "");
  if (!secret) return { ok: false, error: "secret_not_configured" };
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const tok = m ? clean(m[1]) : clean(request.headers.get("X-Queue-Secret") || "");
  return tok === secret ? { ok: true } : { ok: false, error: "unauthorized" };
}
async function twitchUser(env, token) {
  const clientId = clean(env.TWITCH_CLIENT_ID);
  const t = clean(token);
  if (!clientId || !t) return null;
  const mem = twitchMem.get(t);
  if (mem?.exp > Date.now()) return mem.user;
  const res = await fetch("https://api.twitch.tv/helix/users", { headers: { Authorization: "Bearer " + t, "Client-Id": clientId } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const user = data?.data?.[0] || null;
  if (user) twitchMem.set(t, { user, exp: Date.now() + 280000 });
  return user;
}
async function twitchGateAny(env, token) {
  const user = await twitchUser(env, token);
  if (!user) return { ok: false, error: "login_required" };
  return { ok: true, login: clean(user.login).toLowerCase(), display: user.display_name || user.login };
}
async function twitchGateOk(env, token, houseId) {
  const g = await twitchGateAny(env, token);
  if (!g.ok) return g;
  const st = houseId ? await loadState(env, houseId) : null;
  const owner = clean(st?.ownerPlayerId || st?.ownerHouse?.ownerPlayerId || st?.publicHouse?.ownerPlayerId).toLowerCase();
  if (owner && owner !== g.login) return { ok: false, error: "not_owner" };
  return g;
}
async function loadActions(env, channel) {
  const raw = await getJson(env, "actions:" + channel);
  return Array.isArray(raw) ? raw : [];
}
async function saveActions(env, channel, list) {
  await putJson(env, "actions:" + channel, list, 3600);
}
async function loadState(env, houseId) {
  return getJson(env, "state:" + houseId);
}
async function saveState(env, houseId, payload) {
  await putJson(env, "state:" + houseId, payload, 86400);
}
async function getJson(env, key) {
  const store = kv(env);
  if (!store) return null;
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function putJson(env, key, obj, ttl) {
  const store = kv(env);
  if (store) await store.put(key, JSON.stringify(obj), { expirationTtl: ttl });
}
async function loadHouseIndex(env) {
  const raw = await getJson(env, "houses:index");
  return Array.isArray(raw) ? raw : [];
}
async function touchHouseIndex(env, houseId, house) {
  const list = await loadHouseIndex(env);
  const next = { houseId, owner: clean(house?.ownerPlayerId), name: clean(house?.displayName) || houseId, ts: Date.now() };
  const i = list.findIndex((x) => x.houseId === houseId);
  if (i >= 0) list[i] = next; else list.unshift(next);
  while (list.length > 50) list.pop();
  await putJson(env, "houses:index", list, 86400 * 7);
}
