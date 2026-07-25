// Deepsmoke — CO-OP (DIG TOGETHER): all Star Multiplayer SDK wiring lives here.
// main.js touches only thin hooks (createCoopClient); the singleplayer loop is untouched.
//
// Model (Phase 1.1 — host-authoritative edits, Phase 1.2 — host-owned chest state):
//   - mp.start() runs at load (top level in main.js) — the room exists from frame one,
//     but nothing co-op happens until a player opts into the lobby (mp.me.inLobby).
//   - The lobby is just synced flags: mp.me.inLobby / mp.me.ready, roster from mp.players.
//   - 'begin' (guarded action) bumps shared.digId + rolls shared.seed; every lobby member's
//     client sees digId advance and launches startRun(seed) — identical seeded world.
//   - ALL world edits flow through MSG actions. onAction handlers run on the HOST with the
//     sender's synced state in context — that's where validation lives (digId, distance,
//     placeable-id whitelist, occupancy). Invalid requests are rejected silently and logged.
//   - Confirmed edits land in shared.edits ("x,y,z" -> -1 air | blockId placed/filled); the
//     SDK broadcasts shared to everyone; tick() reconciles each client's voxel copy to it.
//   - Clients predict locally (break/place/fill applies immediately) and record the value
//     they expect; reconciliation re-applies any cell whose confirmed value differs.
//     Full rollback of REJECTED predictions is deferred (roadmap: optional/low).
//
// Chest sync (1.2):
//   - shared.chests[k] = { size: 18|36, lockedBy: playerId|0, slots: { [i]: {id,n}|0 } }
//     slots is a SPARSE OBJECT (empty = 0 sentinel; keys are never deleted — SDK-safe).
//     A broken chest is tombstoned to { size: 0 } (never deleted) by the break handler.
//   - Opening a chest takes a host-granted LOCK (one editor at a time; stale locks from
//     players who left the dig are stolen). While locked, the opener streams MOVE deltas
//     (slot index -> stack|0) which the host validates against the ITEMS registry.
//   - Everyone else's tick() converges their local container copy to shared.chests, so
//     contents are consistent when the next player walks up.
import { createMultiplayer } from '/star-sdk/v1/multiplayer.js';
import * as THREE from 'three';
import { createMateMechRig } from './player-models.js';
import { BLOCK, SY } from './world.js';
import { ITEMS } from './inventory.js';

export const mp = createMultiplayer();

// ---- message types — one shared enum for host handlers AND client senders ----
export const MSG = {
  BEGIN: 'begin',                    // lobby -> launch a shared dig
  BLOCK_BREAK_REQUEST: 'blkBreak',   // { ks: ["x,y,z",...], digId } (batch: drill=1, blast carve=many)
  BLOCK_PLACE_REQUEST: 'blkPlace',   // { k: "x,y,z", b: blockId, digId }
  BLOCK_FILL_REQUEST: 'blkFill',     // { ks, b, digId } — cave-in rubble settling (air -> ROCK)
  CHEST_OPEN_REQUEST: 'chestOpen',   // { k, digId, size } — take the edit lock (host may reject: busy)
  CHEST_MOVE_REQUEST: 'chestMove',   // { k, digId, moves: [{ i, s: {id,n}|0 }] } ��� lock holder only
  CHEST_CLOSE: 'chestClose',         // { k, digId } — release the lock
  SKY_WEATHER_REQUEST: 'skyWx',      // { digId, biome } — roll the next shared weather front (host-guarded)
};

// One roll table for solo AND the host handler — kind from a biome + a [0,1) roll.
export function rollWeather(biome, r) {
  if (biome === 'desert') return r < 0.72 ? 'clear' : r < 0.88 ? 'rain' : 'storm';
  if (biome === 'mountain' || biome === 'floating_islands') return r < 0.5 ? 'snow' : r < 0.72 ? 'clear' : r < 0.9 ? 'rain' : 'storm';
  if (biome === 'valley') return r < 0.42 ? 'clear' : r < 0.78 ? 'rain' : r < 0.9 ? 'snow' : 'storm';
  return r < 0.48 ? 'clear' : r < 0.82 ? 'rain' : r < 0.93 ? 'storm' : 'snow';
}

const EDIT_AIR = -1;                    // shared.edits value: cell broken to air
const REACH = 12;                       // single-edit validation radius (raycast reach 4.5 + pos-sync lag slack)
const CARVE_REACH = 40;                 // batch breaks/fills (blast/crater/cave-in) — may resolve after the player runs
const CARVE_MAX = 220;                  // hard cap per batch request
const MOVES_MAX = 12;                   // hard cap per chest-move request (client chunks diffs)
const PLAYER_NAME_MAX = 18;
const NAME_TAG_Y = 2.95;
const NAME_TAG_HEIGHT = 0.46;
const PLACEABLE = new Set(Object.values(ITEMS).map(i => i.block).filter(b => typeof b === 'number'));

function parseKey(k) {
  if (typeof k !== 'string') return null;
  const p = k.split(',');
  if (p.length !== 3) return null;
  const x = +p[0], y = +p[1], z = +p[2];
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return null;
  if (y < 0 || y >= SY) return null;
  return { x, y, z };
}
// sender must be in THIS dig and near the cell — pos comes from the host's synced player state
function senderOk(player, shared, digId, cell, reach) {
  if (!player || player.coopState !== 'digging' || player.digId !== shared.digId) return false;
  if (digId !== shared.digId) return false;
  if (typeof player.x !== 'number') return false;
  const dx = cell.x + 0.5 - player.x, dy = cell.y + 0.5 - player.y, dz = cell.z + 0.5 - player.z;
  return dx * dx + dy * dy + dz * dz <= reach * reach;
}
const reject = (what, why) => console.debug(`[coop] rejected ${what}: ${why}`); // silent to players, loud to devtools
const sanitizePlayerName = (raw, fallback = 'MINER') => {
  const base = (typeof raw === 'string' ? raw : '').trim().replace(/\s+/g, ' ');
  const clipped = (base || fallback || 'MINER').slice(0, PLAYER_NAME_MAX);
  return clipped || 'MINER';
};
const playerLabel = p => sanitizePlayerName(p?.playerName, `MINER ${((p?.index ?? 0) + 1)}`);

function buildNameTag(name) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const label = sanitizePlayerName(name);
  const W = 512;
  const H = 128;
  canvas.width = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '700 56px "Pixelify Sans", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const pad = 34;
  const textW = ctx.measureText(label).width;
  const boxW = Math.min(W - 8, Math.max(200, Math.ceil(textW) + pad * 2));
  const boxX = (W - boxW) * 0.5;
  const boxY = 20;
  const boxH = H - boxY * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = '#ffd873';
  ctx.lineWidth = 4;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 10;
  ctx.strokeText(label, W * 0.5, H * 0.5 + 2);
  ctx.fillText(label, W * 0.5, H * 0.5 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  const aspect = boxW / boxH;
  sprite.scale.set(NAME_TAG_HEIGHT * aspect, NAME_TAG_HEIGHT, 1);
  sprite.position.set(0, NAME_TAG_Y, 0);
  return { label, sprite, material, texture };
}

function disposeNameTag(tag) {
  if (!tag) return;
  if (tag.sprite?.parent) tag.sprite.parent.remove(tag.sprite);
  tag.material?.dispose();
  tag.texture?.dispose();
}

// mp.me / mp.players / mp.shared may only be touched after mp.start() resolves.
// The render loop begins before that (mp.client fires init immediately), so every
// accessor below is gated on this flag — safe no-ops until the room is live.
let started = false;
export function startCoop() {
  return mp.start({ maxPlayers: 4, minPlayersToStart: 1 }).then(() => { started = true; });
}

// Founding room state — runs exactly once per room.
mp.init(({ shared }) => {
  shared.digId = 0;  // bumps every time a co-op dig launches
  shared.seed = 0;   // world seed of the current dig
  shared.edits = {}; // "x,y,z" -> EDIT_AIR (broken) | blockId (placed/filled) : confirmed diffs vs the seeded world
  shared.chests = {}; // "x,y,z" -> { size, lockedBy, slots } : host-owned chest inventories (1.2)
  // ONE sky for the crew: day/night is pure derivation (start + elapsed mp.now() since `at`
  // — zero ongoing traffic, no clock skew since mp.now() is the shared wall clock), weather
  // fronts are host-rolled via SKY_WEATHER_REQUEST.
  shared.sky = { start: 0, at: 0, weather: 'clear', windX: 0.8, windZ: 0.25, wUntil: 0, seq: 0 };
});

// Launch a co-op dig: every lobby member must be ready, and no crew dig may be running.
mp.onAction(MSG.BEGIN, (_d, { shared, players }) => {
  const crew = Object.values(players).filter(p => p.inLobby);
  if (!crew.length || crew.some(p => !p.ready)) return;
  for (const id in players) {
    const p = players[id];
    if (p.coopState === 'digging' && p.digId === shared.digId) return; // dig in progress
  }
  shared.digId = (shared.digId || 0) + 1;
  shared.seed = Math.floor(mp.random() * 1000000) + 1;
  shared.edits = {};
  shared.chests = {};
  // stamp the shared sky epoch — every client derives the same time-of-day from it
  shared.sky = {
    start: mp.random() * 0.85,               // time-of-day at dig launch (0..1 of the cycle)
    at: mp.now(),                            // shared-clock epoch the cycle runs from
    weather: 'clear',
    windX: (mp.random() * 2 - 1) * 1.9,
    windZ: (mp.random() * 2 - 1) * 1.33,
    wUntil: mp.now() + (55 + mp.random() * 95) * 1000, // when the first front may roll
    seq: ((shared.sky && shared.sky.seq) || 0) + 1,
  };
});

// HOST-VALIDATED weather roll: any digging client whose clock sees the current front
// expire may request the next one — the FIRST valid request past wUntil wins, the rest
// are idempotent no-ops. The whole crew converges on shared.sky (one weather timeline).
mp.onAction(MSG.SKY_WEATHER_REQUEST, (d, { shared, player, playerId }) => {
  if (!d) return reject('skyWx', 'malformed');
  if (!player || player.coopState !== 'digging' || player.digId !== shared.digId || d.digId !== shared.digId)
    return reject('skyWx', `sender check failed (from ${playerId})`);
  const sky = shared.sky;
  if (!sky || !sky.at) return reject('skyWx', 'no sky epoch (dig not begun)');
  if (mp.now() < (sky.wUntil || 0)) return; // a fresh front already rolled — ignore
  const kind = rollWeather(typeof d.biome === 'string' ? d.biome : 'plains', mp.random());
  const gust = kind === 'storm' ? 3 : kind === 'snow' ? 1.3 : 1.9;
  sky.weather = kind;
  sky.windX = (mp.random() * 2 - 1) * gust;
  sky.windZ = (mp.random() * 2 - 1) * gust * 0.7;
  sky.wUntil = mp.now() + (55 + mp.random() * 95) * 1000;
  sky.seq = (sky.seq || 0) + 1;
});

// HOST-VALIDATED break(s). Batch: the drill sends 1 key, blast carves send many.
mp.onAction(MSG.BLOCK_BREAK_REQUEST, (d, { shared, player, playerId }) => {
  if (!d || !Array.isArray(d.ks)) return reject('break', 'malformed');
  if (d.ks.length > CARVE_MAX) return reject('break', `batch too big (${d.ks.length}) from ${playerId}`);
  const reach = d.ks.length > 1 ? CARVE_REACH : REACH;
  for (const k of d.ks) {
    const cell = parseKey(k);
    if (!cell) { reject('break', `bad key ${k}`); continue; }
    if (!senderOk(player, shared, d.digId, cell, reach)) { reject('break', `sender check failed for ${k} from ${playerId}`); continue; }
    if (shared.edits[k] === EDIT_AIR) continue; // already air — idempotent
    shared.edits[k] = EDIT_AIR;
    // breaking a chest cell tombstones its host-owned inventory (never delete shared keys)
    const ch = shared.chests && shared.chests[k];
    if (ch && ch.size) shared.chests[k] = { size: 0, lockedBy: 0, slots: {} };
  }
});

// HOST-VALIDATED placement: digId + distance + placeable whitelist + occupancy (first placement
// wins a contested cell — a later request may not overwrite someone's confirmed block; break it first).
// NOTE: inventory ownership is still client-enforced — host-side inventory authority is future work.
mp.onAction(MSG.BLOCK_PLACE_REQUEST, (d, { shared, player, playerId }) => {
  if (!d) return reject('place', 'malformed');
  const cell = parseKey(d.k);
  if (!cell) return reject('place', `bad key ${d.k}`);
  if (!PLACEABLE.has(d.b)) return reject('place', `id ${d.b} not placeable (from ${playerId})`);
  if (!senderOk(player, shared, d.digId, cell, REACH)) return reject('place', `sender check failed for ${d.k} from ${playerId}`);
  const cur = shared.edits[d.k];
  if (cur !== undefined && cur !== EDIT_AIR) return reject('place', `cell ${d.k} already holds a confirmed placement`);
  shared.edits[d.k] = d.b;
});

// HOST-VALIDATED fill batch: cave-in rubble settling (air -> ROCK). Confirmed placements win
// contested cells (rubble never eats someone's chest/panel); everything else converges to rock.
mp.onAction(MSG.BLOCK_FILL_REQUEST, (d, { shared, player, playerId }) => {
  if (!d || !Array.isArray(d.ks)) return reject('fill', 'malformed');
  if (d.b !== BLOCK.ROCK) return reject('fill', `block ${d.b} not fillable (from ${playerId})`);
  if (d.ks.length > CARVE_MAX) return reject('fill', `batch too big (${d.ks.length}) from ${playerId}`);
  for (const k of d.ks) {
    const cell = parseKey(k);
    if (!cell) { reject('fill', `bad key ${k}`); continue; }
    if (!senderOk(player, shared, d.digId, cell, CARVE_REACH)) { reject('fill', `sender check failed for ${k} from ${playerId}`); continue; }
    const cur = shared.edits[k];
    if (cur !== undefined && cur !== EDIT_AIR) continue; // confirmed placement stays
    shared.edits[k] = d.b;
  }
});

// CHEST LOCK GRANT. Lazily creates host chest state on first open (or after a tombstone —
// a freshly re-placed chest starts empty). A lock held by a player who is no longer in this
// dig is stale and gets stolen; a lock held by an active digger rejects the request (busy).
mp.onAction(MSG.CHEST_OPEN_REQUEST, (d, { shared, player, playerId, players }) => {
  if (!d) return reject('chestOpen', 'malformed');
  const cell = parseKey(d.k);
  if (!cell) return reject('chestOpen', `bad key ${d.k}`);
  if (!senderOk(player, shared, d.digId, cell, REACH)) return reject('chestOpen', `sender check failed for ${d.k} from ${playerId}`);
  if (!shared.chests) shared.chests = {};
  let c = shared.chests[d.k];
  if (!c || !c.size) {
    c = { size: d.size === 36 ? 36 : 18, lockedBy: 0, slots: {} };
    shared.chests[d.k] = c;
  }
  if (c.lockedBy && c.lockedBy !== playerId) {
    const holder = players[c.lockedBy];
    if (holder && holder.coopState === 'digging' && holder.digId === shared.digId) {
      return reject('chestOpen', `chest ${d.k} busy (locked by ${c.lockedBy})`);
    }
    // holder left the dig — steal the stale lock
  }
  c.lockedBy = playerId;
});

// CHEST MOVE DELTAS — lock holder only. Each move sets one slot to a validated stack or empty.
mp.onAction(MSG.CHEST_MOVE_REQUEST, (d, { shared, player, playerId }) => {
  if (!d || !Array.isArray(d.moves)) return reject('chestMove', 'malformed');
  if (d.moves.length > MOVES_MAX) return reject('chestMove', `batch too big (${d.moves.length}) from ${playerId}`);
  const cell = parseKey(d.k);
  if (!cell) return reject('chestMove', `bad key ${d.k}`);
  const c = shared.chests && shared.chests[d.k];
  if (!c || !c.size) return reject('chestMove', `no chest at ${d.k}`);
  if (c.lockedBy !== playerId) return reject('chestMove', `${playerId} doesn't hold the lock on ${d.k}`);
  if (!senderOk(player, shared, d.digId, cell, REACH)) return reject('chestMove', `sender check failed for ${d.k} from ${playerId}`);
  for (const m of d.moves) {
    if (!m || !Number.isInteger(m.i) || m.i < 0 || m.i >= c.size) { reject('chestMove', `bad slot index from ${playerId}`); continue; }
    if (!m.s) { c.slots[m.i] = 0; continue; }
    const item = ITEMS[m.s.id];
    if (!item) { reject('chestMove', `unknown item ${m.s.id} from ${playerId}`); continue; }
    if (!Number.isInteger(m.s.n) || m.s.n < 1 || m.s.n > (item.stack || 1)) { reject('chestMove', `bad count ${m.s.n} for ${m.s.id} from ${playerId}`); continue; }
    c.slots[m.i] = { id: m.s.id, n: m.s.n };
  }
});

// CHEST LOCK RELEASE — only the holder can release (non-holders are silently ignored).
mp.onAction(MSG.CHEST_CLOSE, (d, { shared, playerId }) => {
  const c = d && shared.chests && shared.chests[d.k];
  if (c && c.lockedBy === playerId) c.lockedBy = 0;
});

const MATE_SUITS = [0x1E3A8A, 0xB33A2A, 0x2E8A3A, 0x8A2AB0]; // suit color by seat
const REMOTE_LERP_RATE = 14;
const TAU = Math.PI * 2;
const clamp01 = t => t < 0 ? 0 : (t > 1 ? 1 : t);
function shortAngleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// dense (game-side) slot helpers — containers are { slots: Array({id,n}|null), rev }
const cloneSlots = slots => slots.map(s => (s ? { id: s.id, n: s.n } : null));
const slotEq = (a, b) => (!a && !b) || (!!a && !!b && a.id === b.id && a.n === b.n);

// Browser-side co-op client — created inside mp.client (needs the scene).
export function createCoopClient(scene) {
  const mates = new Map();   // playerId -> { rig, tx, ty, tz, yaw, inited, label, tag }
  const applied = new Map(); // edit key -> value already applied to MY world copy (prediction + confirmations)
  let active = false, digId = 0, lastSeenDig = 0;
  let myName = 'MINER';

  // chest hooks + open state (Phase 1.2)
  let getContainerFn = null;      // (k, size) -> container (main.js containers map)
  let onRemoteChestChange = null; // (k) -> void, fired when a remote edit lands locally
  let openChest = null;           // { k, container, snapshot, onLockLost } — the ONE chest I hold the lock on

  function applyMyName() {
    if (!started) return;
    const clean = sanitizePlayerName(myName);
    if (mp.me.playerName !== clean) mp.me.playerName = clean;
  }

  function setMateNameTag(mate, nextLabel) {
    const clean = sanitizePlayerName(nextLabel);
    if (mate.label === clean) return;
    disposeNameTag(mate.tag);
    const tag = buildNameTag(clean);
    if (tag) mate.rig.grp.add(tag.sprite);
    mate.tag = tag;
    mate.label = clean;
  }

  function clearMates() {
    for (const mate of mates.values()) {
      disposeNameTag(mate.tag);
      scene.remove(mate.rig.grp);
      mate.rig.dispose();
    }
    mates.clear();
  }

  // Diff my open container against the last-sent snapshot -> chunked CHEST_MOVE_REQUESTs.
  function sendChestDiff() {
    if (!openChest) return;
    const { k, container, snapshot } = openChest;
    const moves = [];
    for (let i = 0; i < container.slots.length; i++) {
      const s = container.slots[i] || null;
      if (slotEq(s, snapshot[i])) continue;
      moves.push({ i, s: s ? { id: s.id, n: s.n } : 0 });
      snapshot[i] = s ? { id: s.id, n: s.n } : null;
    }
    for (let off = 0; off < moves.length; off += MOVES_MAX) {
      mp.action(MSG.CHEST_MOVE_REQUEST, { k, digId, moves: moves.slice(off, off + MOVES_MAX) });
    }
  }

  return {
    mp,
    get active() { return active; },
    setPlayerName(name) {
      myName = sanitizePlayerName(name);
      applyMyName();
      return myName;
    },
    get playerName() { return myName; },

    // ----- lobby -----
    joinLobby() {
      if (!started) return;
      applyMyName();
      mp.me.inLobby = true;
      mp.me.ready = false;
      lastSeenDig = mp.shared.digId || 0; // never hop into a dig already underway
    },
    get inLobby() { return started && !!mp.me.inLobby; },
    leaveLobby() { if (!started) return; mp.me.inLobby = false; mp.me.ready = false; },
    toggleReady() { if (!started) return; mp.me.ready = !mp.me.ready; },
    roster() { return started ? mp.players.filter(p => p.inLobby) : []; },
    begin() { if (started) mp.action(MSG.BEGIN); },
    invite() { return started ? mp.copyInvite() : Promise.resolve(false); },
    get inviteUrl() { return started ? mp.inviteUrl : ''; },
    get myId() { return started ? mp.me.id : null; },
    get myReady() { return started && !!mp.me.ready; },

    // ----- dig launch (polled from the main loop) -----
    get digLaunched() { return started && !!mp.me.inLobby && (mp.shared.digId || 0) > lastSeenDig; },
    acceptDig() {
      digId = lastSeenDig = mp.shared.digId || 0;
      active = true;
      applied.clear();
      openChest = null;
      clearMates();
      applyMyName();
      mp.me.ready = false;
      mp.me.digId = digId;
      mp.me.coopState = 'digging';
      return mp.shared.seed || 1;
    },

    // ----- in-dig hooks (all no-ops unless a co-op dig is live) -----
    // I broke a block (already air in MY world — prediction) -> request confirmation.
    reportBreak(cell) {
      if (!active) return;
      const k = `${cell.x},${cell.y},${cell.z}`;
      applied.set(k, EDIT_AIR);
      mp.action(MSG.BLOCK_BREAK_REQUEST, { ks: [k], digId });
    },
    // A blast/crater vaporized many cells at once (already applied locally).
    reportCarve(cells) {
      if (!active || !cells || !cells.length) return;
      const ks = [];
      for (const c of cells.slice(0, CARVE_MAX)) {
        const k = `${c.x},${c.y},${c.z}`;
        applied.set(k, EDIT_AIR);
        ks.push(k);
      }
      mp.action(MSG.BLOCK_BREAK_REQUEST, { ks, digId });
    },
    // Cave-in rubble settled into air cells (already applied locally) -> sync the fill.
    reportFill(cells, blockId) {
      if (!active || !cells || !cells.length) return;
      const ks = [];
      for (const c of cells.slice(0, CARVE_MAX)) {
        const k = `${c.x},${c.y},${c.z}`;
        applied.set(k, blockId);
        ks.push(k);
      }
      mp.action(MSG.BLOCK_FILL_REQUEST, { ks, b: blockId, digId });
    },
    // I placed a block (already set in MY world — prediction) -> request confirmation.
    reportPlace(cell, blockId) {
      if (!active) return;
      const k = `${cell.x},${cell.y},${cell.z}`;
      applied.set(k, blockId);
      mp.action(MSG.BLOCK_PLACE_REQUEST, { k, b: blockId, digId });
    },

    // ----- chest sync (Phase 1.2) -----
    // main.js provides: getContainer(k, size) -> its containers-map entry (creating if
    // needed), and onRemoteChange(k) for side effects (e.g. camp-chest persistence).
    bindChests(getContainer, onRemoteChange) {
      getContainerFn = getContainer;
      onRemoteChestChange = onRemoteChange || null;
    },
    // Try to open chest k with my local container. Returns:
    //   'solo' — not in a co-op dig, use the container as-is
    //   'busy' — an active crewmate holds the lock, don't open
    //   'ok'   — lock requested; container adopted the confirmed contents (if any)
    chestOpen(k, container, onLockLost) {
      if (!active) return 'solo';
      const sc = (mp.shared.chests || {})[k];
      if (sc && sc.lockedBy && sc.lockedBy !== mp.me.id) {
        const holder = mp.players.find(p => p.id === sc.lockedBy);
        if (holder && holder.coopState === 'digging' && holder.digId === digId) return 'busy';
      }
      if (sc && sc.size) {
        // adopt the confirmed contents (shared is already replicated locally — no waiting)
        if (container.slots.length !== sc.size) container.slots = Array(sc.size).fill(null);
        const slots = sc.slots || {};
        for (let i = 0; i < sc.size; i++) {
          const s = slots[i];
          container.slots[i] = s ? { id: s.id, n: s.n } : null;
        }
        container.rev++;
        openChest = { k, container, snapshot: cloneSlots(container.slots), onLockLost: onLockLost || null };
        mp.action(MSG.CHEST_OPEN_REQUEST, { k, digId, size: container.slots.length });
      } else {
        // first opener: seed shared from my local copy (actions are ordered — open lands first)
        openChest = { k, container, snapshot: Array(container.slots.length).fill(null), onLockLost: onLockLost || null };
        mp.action(MSG.CHEST_OPEN_REQUEST, { k, digId, size: container.slots.length });
        sendChestDiff();
      }
      return 'ok';
    },
    // The open panel mutated the chest -> stream the delta.
    chestChanged(k) {
      if (!active || !openChest || openChest.k !== k) return;
      sendChestDiff();
    },
    // The panel closed -> flush any final delta and release the lock.
    chestClosed(k) {
      if (!active) return;
      if (openChest && openChest.k === k) { sendChestDiff(); openChest = null; }
      mp.action(MSG.CHEST_CLOSE, { k, digId }); // host ignores non-holders
    },

    // ----- sky sync (day/night + weather through the host) -----
    // Pure derivation from the host-stamped epoch: same time-of-day on every
    // client with ZERO ongoing traffic (mp.now() is the shared wall clock).
    sky(daySec = 420) {
      if (!active) return null;
      const s = mp.shared.sky;
      if (!s || !s.at) return null;
      const elapsed = Math.max(0, mp.now() - s.at) / 1000;
      return {
        time: ((s.start || 0) + elapsed / daySec) % 1,
        weather: s.weather || 'clear',
        windX: typeof s.windX === 'number' ? s.windX : 0.8,
        windZ: typeof s.windZ === 'number' ? s.windZ : 0.25,
        seq: s.seq || 0,
        due: mp.now() >= (s.wUntil || 0), // current front expired — someone should request a roll
      };
    },
    requestWeatherRoll(biome) {
      if (!active) return;
      mp.action(MSG.SKY_WEATHER_REQUEST, { digId, biome: String(biome || 'plains').slice(0, 24) });
    },

    tick(world, player, dt = 1 / 60) {
      if (!active) return;
      const pos = player.ent.pos;
      const blend = clamp01(1 - Math.exp(-REMOTE_LERP_RATE * Math.min(0.1, Math.max(0, dt))));
      // 1) my suit position for the crew (mp.me is live; SDK smooths the remotes)
      mp.me.x = pos.x; mp.me.y = pos.y; mp.me.z = pos.z; mp.me.yaw = player.yaw || 0;
      applyMyName();
      // 2) reconcile MY voxels to the confirmed edit set (breaks AND placements) near me
      const edits = mp.shared.edits || {};
      for (const k in edits) {
        const v = edits[k];
        if (applied.get(k) === v) continue; // already at the confirmed value
        const p3 = k.split(',');
        const x = +p3[0], y = +p3[1], z = +p3[2];
        if (Math.abs(x - pos.x) > 24 || Math.abs(z - pos.z) > 24) continue; // apply once streamed in
        const want = v === EDIT_AIR ? BLOCK.AIR : v;
        if (world.get(x, y, z) !== want) world.set(x, y, z, want);
        applied.set(k, v);
      }
      // 3) draw crew mates as FULL third-person mechs (suit + drill + visible pilot,
      //    posed by the same playerModelPoses as the first-person view)
      const seen = new Set();
      for (const p of mp.others) {
        if (p.coopState !== 'digging' || p.digId !== digId || p.x === undefined) continue;
        seen.add(p.id);
        let mate = mates.get(p.id);
        if (!mate) {
          const rig = createMateMechRig({ tint: MATE_SUITS[(p.index ?? 0) % MATE_SUITS.length] });
          scene.add(rig.grp);
          mate = { rig, tx: p.x, ty: p.y || 0, tz: p.z || 0, yaw: p.yaw || 0, inited: false, label: '', tag: null };
          mates.set(p.id, mate);
        }
        setMateNameTag(mate, playerLabel(p));
        mate.tx = p.x;
        mate.ty = p.y || 0;
        mate.tz = p.z || 0;
        mate.yaw = p.yaw || 0;

        const grp = mate.rig.grp;
        if (!mate.inited) {
          grp.position.set(mate.tx, mate.ty, mate.tz);
          grp.rotation.y = mate.yaw;
          mate.inited = true;
        } else {
          const prevX = grp.position.x, prevZ = grp.position.z;
          grp.position.x += (mate.tx - grp.position.x) * blend;
          grp.position.y += (mate.ty - grp.position.y) * blend;
          grp.position.z += (mate.tz - grp.position.z) * blend;
          grp.rotation.y += shortAngleDelta(grp.rotation.y, mate.yaw) * blend; // mech pose yawDeg 180 flips the model like FP
          const sp = Math.hypot(grp.position.x - prevX, grp.position.z - prevZ) / Math.max(dt, 1e-4);
          mate.rig.setAnim(sp > 0.5 ? 'walk' : 'idle', { fade: 0.15 }); // repeated same-intent is safe (grub AI does it per-frame)
        }
        mate.rig.updateAnim(dt);
      }
      for (const [id, mate] of mates) {
        if (!seen.has(id)) {
          disposeNameTag(mate.tag);
          scene.remove(mate.rig.grp);
          mate.rig.dispose();
          mates.delete(id);
        }
      }
      // 4) chest sync
      const chests = mp.shared.chests || {};
      // a) lock loss: the host stole my stale lock for someone else (I left/idled out of the dig
      //    state briefly, or a race) — force-close my panel via the callback.
      if (openChest) {
        const sc = chests[openChest.k];
        if (sc && sc.lockedBy && sc.lockedBy !== mp.me.id) {
          const lost = openChest;
          openChest = null;
          if (lost.onLockLost) lost.onLockLost(lost.k);
        }
      }
      // b) converge every other confirmed chest into my local containers map
      if (getContainerFn) {
        for (const k in chests) {
          const sc = chests[k];
          if (!sc || !sc.size) continue;                 // tombstone (chest was broken)
          if (openChest && openChest.k === k) continue;  // I'm the editor of this one
          const cont = getContainerFn(k, sc.size);
          if (!cont) continue;
          let changed = false;
          if (cont.slots.length !== sc.size) { cont.slots = Array(sc.size).fill(null); changed = true; }
          const slots = sc.slots || {};
          for (let i = 0; i < sc.size; i++) {
            const s = slots[i] || null;
            if (slotEq(cont.slots[i], s)) continue;
            cont.slots[i] = s ? { id: s.id, n: s.n } : null;
            changed = true;
          }
          if (changed) {
            cont.rev++;
            if (onRemoteChestChange) onRemoteChestChange(k);
          }
        }
      }
    },
    endDig() {
      if (!active) return;
      active = false;
      mp.me.coopState = 'menu';
      mp.me.digId = 0;
      mp.me.inLobby = false; // back through DIG TOGETHER to crew up again
      applyMyName();
      clearMates();
      applied.clear();
      openChest = null;
    },
  };
}
