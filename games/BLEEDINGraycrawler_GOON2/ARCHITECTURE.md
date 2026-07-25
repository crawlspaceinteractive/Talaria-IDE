# GOBLIN DUNGEON — Architecture

## Files
- `index.html` — Layout, HUD, canvas, overlay. Press Start 2P font.
- `main.js` — Game loop, state, projectiles, ambience, pause menu, MIDI wiring, MenuNav, touch callbacks. ~2600 lines.
- `midi.js` — MidiPlayer class: loads .mid files via FileReader, synthesizes via Web Audio + midi-player-js CDN.
- `raycaster.js` — DDA raycaster, wall hit detection.
- `renderer.js` — Draws walls, floor/ceil, sprites, weapon bob, hat brim overlay.
- `player.js` — Player state: health, ammo, speed, weapon equip.
- `mapgen.js` — Procedural dungeon via seeded RNG. Themes, secret walls, pickups, boss/abomination flags.
- `enemies.js` — EnemyManager: AI (patrol/chase/attack), animation frames, death sprites, boss.
- `shop.js` — Shop UI on canvas: WEAPONS / UPGRADES / HATS / CONTINUE tabs. Payments SDK for hat.
- `assets.js` — All image/audio URL constants, SpriteAtlas (128×128 precache), loader helpers.
- `input.js` — InputManager: keyboard + mouse + gamepad unified input. `lastInputType` tracking for touch auto-hide.
- `gamepad.js` — GamepadManager: rAF-polling Gamepad API wrapper. BTN/AXIS constants.
- `keybinds.js` — KeybindManager singleton + buildKeybindUI(). Persisted to localStorage.
- `touch.js` — TouchControls: dual-joystick HUD overlay, WPN▲/▼ buttons, PAUSE/MAP callback buttons.
- `modeditor.js` — ModEditor: hot-swap textures/sprites/audio, font loader, localStorage persistence.

## Console Notification System (main.js)
- `showMessage(text, duration)` → pushes a line into `#console-log` DOM element
- Lines stack (max 4), auto-fade via setTimeout, colour-coded by keyword (crit/warn/info/default green)
- `#console-log` positioned above HUD (bottom:82px), height:64px, CRT scanline bg visible only when `has-content`

## Culling (renderer.js + enemies.js)
- `_inFrustum(dx,dy,angle,maxDist)` — shared helper: dist² check + angle check, returns sa or null
- Per-type max distances: enemy 26, decor 18, pickup 20, torch 10, portal 28, plasma 24
- `_computeTorchLight` and `_drawTorchFloorHalos` use frustum cull
- `enemies.getVisible()` pre-culls by dist² (alive≤26, dead≤16) before renderer

## LOS-gated AI (enemies.js)
- `EnemyManager(map, level, raycaster)` — raycaster passed from main.js initLevel()
- `_checkLOS(e, px, py, dist)` — runs raycaster.hasLOS(); returns true if LOS confirmed OR `e.losMemory > 0`
- `e.losMemory` — float seconds; set to `LOS_MEMORY_SECS` (3s) on LOS confirmation; decremented each frame
- Enemies beyond `LOS_MAX_DIST` (28 tiles) are always dormant
- Enemies within 2.5 tiles always active regardless of LOS (melee proximity)

## Enemy Spawn Validation (mapgen.js)
- `_isOpenFloor(wx, wy, radius)` — 5-layer check including AABB closest-point to walls
- `_placeEnemyInRoom` uses correct per-class radius (goblin=0.45, boss=1.05, abom=1.15)
- 60 random attempts then deterministic 0.5-step grid scan fallback

## Gamepad & Keybinds (gamepad.js, keybinds.js, input.js)
- `GamepadManager` (gamepad.js) — rAF-polling Gamepad API wrapper. `BTN` / `AXIS` constants exported.
- `KeybindManager` (keybinds.js) — singleton `keybinds`. Maps logical actions → `{ keys[], gpBtn }`. Persisted to `localStorage['goblin_keybinds_v1']`. `buildChecker(keys, gp, padIndex)` returns `(action)=>bool`.
- `buildKeybindUI(container, km, gp)` (keybinds.js) — interactive remap editor. Used in pause Controls screen and main menu Controls panel.
- `InputManager.tick()` — called once per frame before update(). Rebuilds action checker, updates `_gpFwd/Back/Left/Right` from left stick/d-pad, `gpTurnX` from right stick, edge-triggered `gpWpnNext/Prev/MenuUp/Down/Sel/Back/Pause/Map`.
- `InputManager.lastInputType` — `'touch' | 'keyboard' | 'gamepad'`. Updated on any input event. Controls TouchControls visibility.

## Weapon Scroll
- **Keyboard**: `[` (prev) / `]` (next) by default (keybind remappable)
- **Gamepad**: LB (prev) / RB (next) — edge-triggered in `input.tick()` via `gpWpnPrev/gpWpnNext`
- **Touch**: WPN▲ / WPN▼ buttons on bottom-left of HUD → `touchControls.onWeaponPrev/Next` callbacks → `_scrollWeapon(±1)`
- `_scrollWeapon(dir)` — wraps through owned weapons, calls `showMessage` + `updateHUD()`

## Menu Navigation (main.js — MenuNav class)
- `MenuNav` class registered in main.js, singleton `menuNav`
- `menuNav.register(id, btns[], onBack)` — register a named screen with its focusable buttons
- `menuNav.activate(id, startIdx)` — show focus ring on first/specified button
- `menuNav.deactivate()` — clear all focus decorations (called when entering gameplay)
- Focus style: `.menu-nav-focused` → white glow outline injected via `<style id="menu-nav-style">`
- **Keyboard**: ArrowUp/W = up, ArrowDown/S = down, Enter/Space = click, Escape = onBack
- **Gamepad**: D-pad up/down or left-stick, A = select, B = back — via `menuNav.tickGamepad(input)` called each frame
- Named screens: `main-menu`, `main-options`, `main-controls`, `pause-main`, `pause-options`, `pause-controls`, `pause-confirm`

## Touch Controls (touch.js)
- `TouchControls` constructed with `(container, input)`. Only mounts DOM if device has touch support.
- Left joystick zone (left 38%) → WASD keys synthetic held state
- Right joystick zone (right 38%) → `input._touchTurnX` → fed into `input.mouseDX` each rAF frame
- FIRE / USE buttons → `input.keys['shoot']` / `input.keys['e']` held state
- WPN▲ / WPN▼ buttons → `onWeaponPrev` / `onWeaponNext` callbacks (one-shot on touchstart)
- PAUSE / MAP buttons → `onPause` / `onMap` callbacks (direct state toggle, bypasses keyboard dispatch)
- `syncVisibility(phase, paused)` — call each frame; hides HUD if `lastInputType !== 'touch'` or not in active play

## Sprite Atlas (assets.js)
- `ATLAS_SPRITE_SIZE = 128` — all non-wall sprites scaled to 128×128 at precache time
- `FULL_RES_KEYS` Set — wall/floor textures + multi-frame spritesheets kept as original HTMLImageElement
- `SpriteAtlas` class — packs sprites into square grid canvas, `get(key)` returns 128×128 canvas proxy
- `_makeAtlasProxy(canvas)` — adds `.complete`/`.naturalWidth`/`.naturalHeight` so renderer guards work
- `precacheTextures()` — hot-swaps `spriteAssets` + `weaponSpriteAssets` entries in-place with 128×128 canvases

## Key State (main.js)
- `state.phase` → `'menu' | 'playing' | 'shop' | 'intermission' | 'dead'`
- `state.intermission` → `{ phase:'stats'|'entering', timer, stats, nextLevel, nextLabel, goToShop, scanlineOffset }`
- `state.levelStats` → `{ kills, goldEarned, secretsFound, timeStart }` — reset each `initLevel()`
- `state.paused` → shows/hides pause menu (HTML overlay, not canvas)
- `audioVolumes` → `{fx, music, ambience, menuMusic}` — live-adjustable via pause menu sliders

## Audio Architecture
- **FX**: HTMLAudioElement clones (cloneAudio), scaled by `audioVolumes.fx`
- **Ambience**: Web Audio API BufferSource loop, gain node = `audioVolumes.ambience`
- **MIDI**: midi-player-js (CDN) for event parsing → Web Audio oscillator synth
- **Intro Jingle**: HTMLAudioElement with 2s fade-start, hard stop at 10s

## Mod Editor (modeditor.js, z-index:16)
- `ModEditor` class constructed in main.js after assets load
- Receives `{ assets, weaponSprites, hatBrimImgRef, originalUrls }` — all live Image refs
- 40+ named slots (textures, enemies, weapons, props, hat, puddles) — each can hot-swap `.src` of the live Image
- Validation: PNG-only, power-of-two dims, ≤2MB. Font loader via `<link>` inject.
- Persistence: base64 data-URLs stored in `localStorage['goblin_dungeon_mods']`

## Pause Menu (pause-menu div, z-index:20)
- Built once (lazy), shown/hidden on ESC or gamepad START
- Sliders: FX / MUSIC / AMBIENCE with live feedback
- MIDI section: file picker → MidiPlayer.loadFile → play/pause/stop controls
- Sub-screens: main, options, controls (keybind editor), quit confirm
- All sub-screens registered with `menuNav` for keyboard/gamepad navigation

## Projectile System (main.js — `updateProjectiles`)
- Step-trace loop: `steps = ceil(moveDist / 0.45)` sub-steps per frame — prevents wall tunneling
- Each step checks `map.isWall(nx, ny)`; on hit → `spawnHitEffect`, `bolt.alive = false`
- OOB clamp for player (in movement): `_clampToMap` using `map.width/height`, margin 0.3 — enforced even in noclip

## Inner Face Culling (raycaster.js — `_dda`)
- `prevMapX/prevMapY` tracked through DDA steps + space-skip strides
- On wall hit: `if (map.isWall(prevMapX, prevMapY)) continue` — skips faces interior to solid geometry
- Prevents noclip/OOB from rendering hollow wall interiors

## Cheat Console (main.js)
- `_cheatBuffer` — rolling 8-char input buffer, fed from keydown when phase='playing'
- `iddqd` — toggles god mode (`_cheatActive`). `idkfa` — gives all weapons + gem keys + max ammo.
- Score multiplier = 0 on cheat activation.

## Leaderboard / Mod Data Wipe
- On death (`showOverlay('dead')`): `localStorage.removeItem('goblin_dungeon_mods')` runs before `leaderboard.submit(score)`
