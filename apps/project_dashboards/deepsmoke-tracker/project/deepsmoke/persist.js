// Deepsmoke — 1.4 persistence layer: VERSIONED world snapshots in IndexedDB
// (localStorage fallback for private-mode / IDB failure).
//
// Division of labor:
//   - upgrades.js profile (localStorage, small, sync) keeps camp projects, forge
//     (Tub) upgrade tiers, grubLoyalty, blueprints, campChest mirror, playerName.
//   - THIS module keeps the BIG per-world data: seed + edit diff (every world.set
//     vs the seeded generation — chunks regenerate deterministically, so a diff IS
//     the chunk save) + chest contents + player/run state.
//
// Save format (extensible, versioned — bump SAVE_VERSION and add a step in
// migrate() when the shape changes in future phases):
//   { slot, v, when, mode: 'solo'|'coop', seed, digId?,
//     edits: { "x,y,z": blockId }            // 0 = air
//     chests: { "x,y,z": { size, salvage, slots: [{id,n}|0, ...] } }
//     player: { x,y,z,yaw,pitch, fuel, cans, bag: [{id,n}|0 x36], ores: {copper..gold} }
//     grub: { x,y,z, fuel, cans }
//     run: { score, relicScore, depotStock, hauler: { built, carts, slots, } } }
//
// Triggers (wired in main.js): periodic autosave during play (solo journal, or the
// host-confirmed mp.shared state in co-op — every client can snapshot it since the
// SDK replicates shared to all), plus save on quit/pagehide; snapshot deleted on a
// deliberate END DIG (run banked and over).

export const SAVE_VERSION = 1;
export const SLOT_SOLO = 'solo';
export const SLOT_COOP = 'coop';

const DB_NAME = 'deepsmoke_saves';
const DB_VER = 1;
const STORE = 'snapshots';
const LS_PREFIX = 'ds_snap_'; // fallback keys

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'slot' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

// Version gate + stepwise upgrades. Records from a NEWER build are ignored
// (never guess at a future shape); older ones upgrade v -> v+1 -> ... here.
function migrate(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.v !== 'number' || rec.v < 1 || rec.v > SAVE_VERSION) return null;
  // if (rec.v === 1) { ...upgrade to 2...; rec.v = 2; }
  return rec;
}

export async function saveSnapshot(slot, data) {
  const rec = { ...data, slot, v: SAVE_VERSION, when: Date.now() };
  const db = await openDB();
  if (db) {
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = res;
        tx.onerror = tx.onabort = () => rej(tx.error);
      });
      return true;
    } catch { /* fall through to localStorage */ }
  }
  try { localStorage.setItem(LS_PREFIX + slot, JSON.stringify(rec)); return true; } catch { return false; }
}

export async function loadSnapshot(slot) {
  const db = await openDB();
  if (db) {
    try {
      const rec = await new Promise((res, rej) => {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(slot);
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => rej(rq.error);
      });
      const m = migrate(rec);
      if (m) return m;
    } catch { /* fall through */ }
  }
  try { return migrate(JSON.parse(localStorage.getItem(LS_PREFIX + slot))); } catch { return null; }
}

export async function deleteSnapshot(slot) {
  const db = await openDB();
  if (db) {
    try {
      await new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(slot);
        tx.oncomplete = res;
        tx.onerror = tx.onabort = () => rej(tx.error);
      });
    } catch { /* best effort */ }
  }
  try { localStorage.removeItem(LS_PREFIX + slot); } catch { /* best effort */ }
}

// Newest record across slots — menu CONTINUE looks at solo AND coop snapshots
// (a co-op snapshot resumes as a solo dig of the same seeded world).
export async function latestSnapshot(slots = [SLOT_SOLO, SLOT_COOP]) {
  let best = null;
  for (const s of slots) {
    const r = await loadSnapshot(s);
    if (r && (!best || (r.when || 0) > (best.when || 0))) best = r;
  }
  return best;
}

// Every saved world (IDB records + localStorage fallbacks, deduped by slot,
// version-gated, newest first) — powers the WORLDS menu (load/delete rows).
export async function listSnapshots() {
  const out = new Map();
  const db = await openDB();
  if (db) {
    try {
      const all = await new Promise((res, rej) => {
        const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
      for (const rec of all) {
        const m = migrate(rec);
        if (m && m.slot) out.set(m.slot, m);
      }
    } catch { /* fall through to localStorage */ }
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LS_PREFIX)) continue;
      try {
        const m = migrate(JSON.parse(localStorage.getItem(key)));
        if (m && m.slot && !out.has(m.slot)) out.set(m.slot, m);
      } catch { /* skip corrupt record */ }
    }
  } catch { /* no localStorage */ }
  return [...out.values()].sort((a, b) => (b.when || 0) - (a.when || 0));
}

// Fresh slot key for a newly created world.
export function newWorldSlot() {
  return 'w_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 46656).toString(36);
}

// ---------- serialization helpers (keep main.js wiring thin) ----------

// dense game-side containers Map ("x,y,z" -> { slots: [{id,n}|null] }) -> packed
export function packChests(containers, salvageKeys) {
  const out = {};
  for (const [k, c] of containers) {
    out[k] = {
      size: c.slots.length,
      salvage: salvageKeys && salvageKeys.has(k) ? 1 : 0,
      slots: c.slots.map(s => (s ? { id: s.id, n: s.n } : 0)),
    };
  }
  return out;
}

// co-op mp.shared.chests (sparse slots, size:0 tombstones) -> same packed shape
export function packSharedChests(sharedChests) {
  const out = {};
  for (const k in (sharedChests || {})) {
    const c = sharedChests[k];
    if (!c || !c.size) continue; // tombstone — chest was broken
    const slots = Array(c.size).fill(0);
    const src = c.slots || {};
    for (let i = 0; i < c.size; i++) {
      const s = src[i];
      if (s) slots[i] = { id: s.id, n: s.n };
    }
    out[k] = { size: c.size, salvage: 0, slots };
  }
  return out;
}

// co-op mp.shared.edits (-1 = air, >0 = placed id) -> journal shape (0 = air)
export function packSharedEdits(sharedEdits) {
  const out = {};
  for (const k in (sharedEdits || {})) {
    const v = sharedEdits[k];
    out[k] = v === -1 ? 0 : v;
  }
  return out;
}

// journal Map -> plain object for the record
export function packEdits(journal) {
  const out = {};
  for (const [k, v] of journal) out[k] = v;
  return out;
}
