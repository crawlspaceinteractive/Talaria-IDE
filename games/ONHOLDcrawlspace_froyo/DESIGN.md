# Froyo Engine — Design Document

## Concept
A PS1-style 3D platformer where a frozen-yogurt character hops between floating
islands in a candy-colored sky, freezing sun enemies with ice breath and
collecting crystals to open a portal to the next world.

## Core Mechanic
Double-jump + glide traversal across a procedurally generated ring of islands.
Ice-breath weapon freezes, then shatters enemies. Boss on the farthest island
requires three freeze-thaw cycles to defeat.

## Art Style
320×200 software-rasterized canvas; intentional PS1 vertex-jitter, Bayer
4×4 dither, 15-bit color quantization, distance fog. GLB models for characters
and islands; pure-JS geometry builders for decorations, bridges, and the void
plane. Palette: candy pastels, rich jewel-tone sky, warm orange/brown earth.

---

## Design Decisions

### Rendering Architecture
- **Full CPU software rasterizer** — no WebGL for visuals. All rendering writes
  directly into a `320×200 Uint32Array` (`ImageData` buffer) then
  `putImageData` to a 2D canvas at the end of each frame. This is a deliberate
  authenticity choice: real PS1 rendering was CPU-driven.
- **Two distinct geometry pipelines**:
  - *Procedural builder path* (`renderer.js`) — cubes, trapezoids, triangular
    prisms, oriented planks, billboards. Pure JS math, zero allocations in the
    hot loop.
  - *GLB mesh path* (`geometry.js`) — used for the player, enemies, boss, sun,
    cherry, bridges, and island models. Three.js is imported *only* for parsing
    `.glb` files; it is never used for projection or rendering.
- **Engine-native projection for GLB models** — `buildMeshTris` re-implements
  the same `toCameraSpace + scaleAtX/Y` transform used by the procedural path.
  This guarantees GLB geometry lands exactly where the procedural geometry does.
  (An earlier approach used `vector.project(threeCamera)` which caused a subtle
  but visible mismatch.)
- **`syncThreeCamera()` removed from per-frame path** — it was computing full
  Three.js projection matrices every frame even after the switch to engine-native
  projection. Kept as a no-op for API compatibility.
- **Island geometry precache** (`precacheIslandColors` / `buildMeshTrisFromCache`)
  — For static islands, color decisions (green top, brown gradient sides) and
  yaw+scale vertex transforms are pre-computed once into a `Float32Array` of
  10 floats per triangle. Per-frame rendering then only does camera-space
  transform + near-plane clip, cutting the per-island per-frame work
  significantly.
- **Per-island frustum pre-cull** — a dot-product check against camera forward
  skips all triangle work for islands clearly behind the camera.
- **Distance cull**: GLB islands beyond 180 world units are skipped entirely.
- **Depth sort** (`tris.sort()`) applied before rasterization so painter's
  algorithm correctly orders overlapping transparent-ish geometry; the per-pixel
  depth buffer handles the common opaque case.
- **Fixed-point arithmetic** — renderer scanline loop and physics accumulation
  both use 16.16 fixed-point integers. JS engines JIT these to native integer
  ops, avoiding float rounding noise and GC pressure in the hot path.
- **PS1 aesthetic**: integer vertex snap (vertex jitter), Bayer 4×4 dither,
  15-bit color quantization at pixel write, distance fog blending toward a
  lavender `FOG_COLOR`.

### Color Modes (geometry.js `buildMeshTris`)
Each GLB object uses a named `colorMode` to control how its triangles are
shaded, overriding or supplementing the model's own vertex colors:

| Mode | Usage | Effect |
|---|---|---|
| `"froyo"` | Player | Bottom half forced orange (#FF8C00); top uses vertex colors |
| `"flatRed"` | Cherry | Every triangle solid red, lit by face normal |
| `"sunVertex"` | Sun enemy + boss | Uses GLB vertex colors; bright triangles blended toward vivid yellow; dark triangles (sunglasses) kept dark (brightness threshold 0.35) |
| `"flatYellow"` | (legacy sun) | Flat yellow — replaced by `sunVertex` |
| `"flatBrown"` | Bridge GLB | Warm brown (160,100,50) — uniform on all faces |
| `"island"` | Island GLBs | Face-normal Y > 0.55 → flat green; otherwise gradient chocolate-brown (bottom) to sandy-brown (top) |
| `"skyDome"` | SkyDome GLB | Y-gradient orange (bottom/horizon) → purple (top) |
| `"skyRing"` | SkyboxRing GLB | Flat lit purple, parallax-rotates with camera yaw |
| `"sunZone"` | (experimental) | Yellow inside bounding sphere, black on rays |

**Why `sunVertex` over `flatYellow`**: The sun model encodes sunglasses,
pupils, and face detail as dark vertex-colored triangles. `flatYellow` overwrote
everything, destroying those features. `sunVertex` reads the actual vertex
colors and applies a brightness gate so dark triangles stay dark while the sun
body is pushed toward vivid yellow.

### Island System
- **7 user-provided GLB island models** (A–G) are loaded by `islandatlas.js`.
  Each is auto-scaled to fit a 22×22 world-unit footprint (`TARGET_HALF_W/D`).
- **Mixed island generation**: 6 of 16 `SHAPE_BUILDERS` slots are `shapeGLBModel`
  (dominant); the remaining slots are procedural shapes (slab, pillar, stepped,
  L-shape, ledge-stack, trapezoid, crescent, cross) which serve as variety and
  as a graceful fallback if GLB loading fails.
- **Overlap guard**: before placing each island, the generator checks a
  footprint registry (`placedIslands`) and retries up to 4 times to avoid
  islands stacking. Minimum separation: 6 world units between edges.
- **Rotation pool**: `usedGLBModels` Set prevents the same GLB model appearing
  twice in a row; the oldest half of the set is cleared once it exceeds half
  the pool size.

### Collision System
- **GLB face collision** (narrow-phase) in `physics.js`:
  - Broad-phase AABB first (halfW/halfD/topY) to skip distant islands cheaply.
  - Narrow-phase iterates every triangle in the model's pre-scaled `faces`
    Float32Array (built once by `islandatlas.js`).
  - **Landing surfaces** (face normal Y > 0.25): barycentric interpolation on
    the XZ plane finds the exact face Y under the player's feet. Tight epsilon
    (±0.005) prevents sliding off edges.
  - **Vertical walls** (|normalY| < 0.65): plane-distance push-out with a
    slightly wider barycentric tolerance (±0.15) so the player doesn't clip
    through wall faces.
- **Procedural block collision** uses AABB (`testAABB`) with a separate
  top-landing and side push-out path.
- Moving platforms carry the player by recording `dvx`/`dvz` deltas;
  `stepMovingPlatforms` is called each tick before physics.

### World Generation
- **Deterministic PRNG** — Mulberry32 seeded per world. Identical seed always
  produces identical layout.
- **Two-ring layout** — ring 1 (5–7 islands, 40–72 world units out) and ring 2
  (4–6 islands, 80–120 units out). All gameplay content is in the rings; the
  parent island is a hub.
- **Parent island** — 3-tier stepped structure (base → mid → top). Player
  spawns on the base top. Portal lives at the apex.
- **Boss placement** — one boss enemy (6 HP, 3-shot spread) is placed on the
  farthest ring-2 island. Regular enemies (2 HP) appear on every 3rd ring-2
  island.
- **Biome palettes** — 6 biomes (grass, ice, sand, bubblegum, jungle, golden)
  cycle by island index. Each biome gets type-matched decorations (e.g. ice →
  spires + gemstones; jungle → pine + tree).
- **Moving platforms** — block-based islands on ring 2 can oscillate on X or Z
  axis. Moving is disabled for GLB model islands (face collision and moving
  platforms conflict; would require per-frame face retransform).
- **Wind zones** — placed between every 3rd island pair; push airborne player
  laterally. Visual swirl particles mark the zone.
- **Bridge pass** — runs after island placement. All island pairs within
  `BRIDGE_MAX_GAP` (80 units) and `BRIDGE_MAX_YDIFF` (24 units) get an arc of
  oriented planks. Bridge endpoints are pulled to the island edge (not center)
  to avoid clipping the GLB geometry.
- **Magnetization pass** (`meshweld.js`) — after layout, nearby block-island
  edges are nudged toward each other so they visually connect. Applied before
  physics platforms are finalized.

### Loading Screen
- Dual-phase loading: **bar 1** fills as the 7 island GLBs download (sequential
  fetch, one at a time); **bar 2** fills as the geometry color cache is
  pre-baked (`precacheIslandColors` called for each loaded model). A bouncing
  Froyo sprite annotates the loading screen.
- The two-phase design means bar 2 is at 0% during the download phase — a known
  UX quirk; a unified single bar blending (60% download + 40% bake) would be
  cleaner.

### Camera System
- Third-person orbit: camera follows player position with lerp, maintains a
  fixed distance and height offset.
- Pitch auto-adjusts toward a target based on player vertical velocity (look up
  on ascent, down on descent).
- `castLookRay` — used for look-at targeting (not yet wired to gameplay).
- SkyDome + SkyboxRing rotate with `camera.yaw * parallelFactor` to create a
  cheap parallax sky illusion.

### Jump System
- `jumpTokens: 2` (grounded) → `1` (first jump) → `0` (double jump).
- Token gate is in `physics.js` checking the count directly; state-flag checks
  alone caused an infinite-jump bug in an earlier version.
- Glide (`STATE.GLIDE`) is armed separately by `_glideArmed` latch after both
  tokens are spent; uses a reduced gravity row in `PHYSICS_LUT`.
- Floaty ascent: a separate `RISE_GRAVITY_FP` (0.008) applies while `vy > 0`
  and ungrounded, giving a floaty feel on the way up. Normal gravity (0.030)
  kicks in on descent.

### Enemy / Boss Design
- Both regular enemies and the boss use the sun-with-sunglasses GLB (`sunVertex`
  colorMode). The boss uses the same mesh but at 2× scale and with 6 HP.
- Hitbox radius is stored per-enemy (`hitRadius`): 2.0 for regulars (matches
  billboard half-width), 5.5 for the boss.
- `breath.js` collision checks radial distance against `e.hitRadius`; frozen
  enemies are shattered on second breath impact after a freeze timer expires.

### Audio
- Background music: user-provided MP3 ("Fire Village — Nekroturge") looped.
- Web Audio API managed by `audio.js`; volume tuned separately for BGM vs SFX.

### Persistence
- `persistence.js` — `loadSave` / `writeSave` via `localStorage`; optional
  binary `.froyo` file export (`downloadFroyoFile`) for sharing runs.
