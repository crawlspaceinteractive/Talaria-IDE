# Checkpoint — Phase 1.4 Persistence Layer (foundation LANDED, main.js wiring SPECCED)

## Completed this session
- **persist.js (NEW, complete)** — versioned IndexedDB snapshot store (`deepsmoke_saves`/`snapshots`, keyPath `slot`) with localStorage fallback (`ds_snap_*`). Exports: `SAVE_VERSION=1`, `SLOT_SOLO='solo'`, `SLOT_COOP='coop'`, `saveSnapshot(slot,data)`, `loadSnapshot(slot)` (version-gated via `migrate()` — future-version records return null, older versions upgrade stepwise), `deleteSnapshot(slot)`, `latestSnapshot([slots])` (newest across solo+coop), and packing helpers: `packChests(containersMap, salvageKeys)`, `packSharedChests(mp.shared.chests)` (sparse→dense, skips size:0 tombstones), `packSharedEdits(mp.shared.edits)` (-1→0), `packEdits(journalMap)`.
- **world.js** — persistence hooks: `addEdit` takes optional `id`; genChunk applies new `'set'` edit type (`data=e.id`, bedrock-guarded); new `applySavedEdit(x,y,z,id)` (direct `set` if chunk exists, else defers via pre-gen overlay so saved edits land when chunks generate — entrance edits apply first, saved edits after, correct order by insertion); return object now exposes `seed` + `applySavedEdit`.
- **upgrades.js** — profile gains reserved 1.4 fields `grubLoyalty:0` + `blueprints:{}` (defaulted in loadProfile for old saves + fresh default). Camp projects / Tub forge tiers / campChest / playerName already persisted here — spec task "persist camp tier, Tub upgrades, Grub loyalty, blueprints" is now fully covered at the profile level.

## REMAINING: main.js wiring (execute exactly — do NOT re-derive)

Design decision (respects star-multiplayer-sdk rule "never check who the host is"): in co-op, EVERY client periodically snapshots the **host-confirmed replicated state** (`mp.shared.edits`/`mp.shared.chests`) to `SLOT_COOP` — that IS the "host save" (host-validated) and "clients can snapshot" in one mechanism. Solo journals its own edits to `SLOT_SOLO`. Resume is always a SOLO dig (coop snapshot resumes as solo world of same seed — lobby-shared resume is a future phase).

1. **Import** in main.js: `import { SLOT_SOLO, SLOT_COOP, saveSnapshot, loadSnapshot, deleteSnapshot, latestSnapshot, packChests, packSharedChests, packSharedEdits, packEdits } from './persist.js';`

2. **Edit journal**: add run-scoped `let editJournal = new Map();`. In `startRun` immediately after `world = createWorld(...)` (line ~1338):
   ```js
   editJournal = resumeRec ? new Map(Object.entries(resumeRec.edits || {}).map(([k, v]) => [k, v | 0])) : new Map();
   const baseSet = world.set;
   world.set = (x, y, z, id) => {
     baseSet(x, y, z, id);
     editJournal.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, id | 0);
   };
   ```
   This wrapper catches EVERY edit from every module (player.js drill/place, partner.js grub drilling, main.js carves/cave-ins/chest placement, coop reconciliation) — no per-callsite wiring.

3. **startRun(coopSeed, resumeRec)** (add 2nd param):
   - `world = createWorld(scene, textures, coopSeed ?? resumeRec?.seed)`.
   - After journal wrap, if `resumeRec`: `for (const [k,v] of editJournal) { const [x,y,z] = k.split(',').map(Number); world.applySavedEdit(x,y,z,v); }`
   - AFTER the existing `containers.clear(); ... placeCampChest()` block, if `resumeRec`: restore containers from `resumeRec.chests` (`containers.set(k, { slots: c.slots.map(s => s ? {id:s.id,n:s.n} : null), rev: 0 })`; re-add `salvageKeys.add(k)` where `c.salvage`; then `persistCampChest()`). Restore `hauler` from `resumeRec.run.hauler` (built/carts/slots; if `built` call `ensureHaulerChest()` + `npcs.setHaulerState(false, hauler.carts, true)`). Restore `score/relicScore/depotStock` from `resumeRec.run`. Restore player: `player.ent.pos.set(p.x,p.y,p.z)`, `player.yaw = p.yaw; player.pitch = p.pitch || 0`, `player.fuel = Math.min(player.fuelMax, p.fuel)`, `player.cans = p.cans`, bag slots (`player.bag.slots` fill from `p.bag`, `player.bag.rev++`), `player.inv.ores` from `p.ores`. Restore grub pos/fuel/cans (`grub.ent.pos.set`, grub.fuel, grub.cans — check partner.js exposes fuel; if not, `grub.revive(fuel)`). Then `world.update(player.ent.pos, true)` to force-gen chunks at the resume point (prevents falling through ungenerated ground), and `hud.say('GRUB', 'Right where we left off, boss!')`.
   - NOTE: only restore player/grub state for `resumeRec.mode === 'solo'` records? NO — restore for both; coop snapshots carry the local player's own state at save time.

4. **buildSnapshot()** helper in main.js:
   ```js
   function buildSnapshot() {
     if (!world || !player) return null;
     const coopLive = coop.active;
     return {
       mode: coopLive ? 'coop' : 'solo',
       seed: world.seed,
       edits: coopLive ? packSharedEdits(mp.shared.edits) : packEdits(editJournal),
       chests: coopLive ? { ...packChests(containers, salvageKeys), ...packSharedChests(mp.shared.chests) } : packChests(containers, salvageKeys),
       player: { x: player.ent.pos.x, y: player.ent.pos.y, z: player.ent.pos.z, yaw: player.yaw, pitch: player.pitch, fuel: player.fuel, cans: player.cans, bag: player.bag.slots.map(s => s ? { id: s.id, n: s.n } : 0), ores: { ...player.inv.ores } },
       grub: { x: grub.ent.pos.x, y: grub.ent.pos.y, z: grub.ent.pos.z, fuel: grub.fuel, cans: grub.cans },
       run: { score, relicScore, depotStock, hauler: hauler ? { built: hauler.built, carts: hauler.carts, slots: hauler.slots.map(s => s ? { id: s.id, n: s.n } : 0) } : null },
     };
   }
   const snapshotNow = () => { const s = buildSnapshot(); if (s) saveSnapshot(coop.active ? SLOT_COOP : SLOT_SOLO, s).catch(() => {}); };
   ```
   (mp.shared access is safe — only called while a run is live, after startCoop resolved.)

5. **Triggers**:
   - Periodic: in the rAF loop, `saveTimer += dt; if (state === 'play' && saveTimer > 20) { saveTimer = 0; snapshotNow(); }`.
   - `quitToMenu()`: call `snapshotNow()` BEFORE `coop.endDig()` (endDig flips `coop.active` → would misroute slot) and before `disposeRun()`.
   - END DIG (deliberate run end — find the PACK "END DIG" handler / `endRun`-equivalent around the win/score screen): `deleteSnapshot(coop.active ? SLOT_COOP : SLOT_SOLO)` — banked run is over, no stale CONTINUE.
   - `window.addEventListener('pagehide', snapshotNow)` + `document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') snapshotNow(); })` (guard `state === 'play'`).

6. **Menu CONTINUE**: `menuHTML()` is at line ~455, `wireScreen()` at ~534. Add module-level `let resumeAvailable = null;` refreshed via `latestSnapshot().then(r => { resumeAvailable = r; if (screenMode === 'menu') showMenu(); })` on init AND when returning to menu. In `menuHTML()`, render a `CONTINUE DIG` btn-cobalt (id `btn-continue`) under START DIG only when `resumeAvailable`. In `wireScreen()`: `s.addEventListener('click', () => { audio.play('click'); startRun(undefined, resumeAvailable); })`. Keep gamepad focus list working (buttons are auto-discovered? check how wireScreen collects focusables — mirror the START DIG pattern at line ~545).

7. **Verify**: `node --check` main.js/world.js/upgrades.js/persist.js. Then in-browser: dig, place chest with loot, break blocks, reload → CONTINUE restores tunnels + chest + bag + position. Also still owed from earlier phases: 2-player in-browser playtest (chest sync + mate mechs + nametags).

8. **Docs**: update ARCHITECTURE.md (persist.js entry exists — extend main.js line), DESIGN.md journal (mark 1.4 landed).

## Gotchas
- `world.set` on an ungenerated chunk is a silent no-op — that's why resume MUST use `world.applySavedEdit`, never raw `set`.
- Journal stores raw block ids (0 = AIR). Coop `shared.edits` uses -1 for air — `packSharedEdits` converts; never mix formats.
- Don't journal-wrap before seeding the journal from the resume record (wrap order in step 2/3 above is already correct: seed → wrap → replay).
- placeCampChest runs during startRun and seeds from profile.campChest; resume container restore then overwrites with the snapshot copy and re-persists — intended (snapshot and profile are saved at the same moments, equal or snapshot-newer).
- grub fuel setter: partner.js — verify `grub.fuel` is writable; else use `grub.revive(fuel)`.
