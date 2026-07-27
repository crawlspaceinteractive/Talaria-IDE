# Froyo Engine — Architecture

## Concept
PS1-style software-rasterized 3D platformer. CPU does ALL rendering into a
640×400 ImageData buffer — no WebGL for visuals.

## File Map

| File | Role |
|---|---|
| `index.html` | Shell; mounts `#game-root`, loads `main.js` as module |
| `main.js` | DOM builder, CRT bezel, boots `FroyoGame`, gamepad badge |
| `game.js` | Orchestrator: state machine (MENU/GAMEPLAY/PAUSE/…), per-frame tick, render call |
| `renderer.js` | **Software rasterizer**: `project()`, `drawTriangle()`, `buildCube()`, `buildTrapezoid()`, `buildTriPrism()`, `buildOrientedPlank()`, `buildBillboard()`, `buildVoidPlane()`, biome deco builders (`buildTree/Pine/Spire/Mushroom/Cactus/Gemstone/Lantern`), sky, fog, font, present |
| `geometry.js` | **GLB-only**: `loadGLBMesh()`, `buildMeshTris()`, `extractMeshData()`. Three.js loaded from CDN **only** for GLB parsing. World geometry does NOT use this. |
| `physics.js` | Player movement, gravity, jump tokens, platform AABB collision |
| `camera.js` | Camera follow, orbit, pitch, `castLookRay()` |
| `state.js` | Bitwise player state flags (`STATE.*`), `resolveBitwise()`, `resolveDiscrete()` |
| `input.js` | Keyboard + Gamepad `InputController`, `BTN_FLAGS` |
| `world.js` | **Voronoi parent-child world gen v3**: IslandF (2× scale) at origin as Voronoi parent; child islands spawned via angular sector rejection-sampling. Inner ring 3–5.5×S, outer ring 6–9×S. Exports `voronoiCells` array. `stepMovingPlatforms()` unchanged. |
| `luts.js` | Pre-baked lookup tables: trig, scale-at-depth, physics params, jump reach |
| `ps1fx.js` | Color helpers: `rgba()`, `quantize15()`, `shade()`, `tint()` |
| `breath.js` | Ice breath particle system: `fireBreath()`, `stepBreath()`, `stepBreakables()`. Collision radii tuned to object sizes. Enemies use `e.hitRadius` field. |
| `portal.js` | Portal trigger, warp transition animation |
| `hud.js` | HUD draw calls — all panels scaled to 160×100 (half original size). Uses scale-1 font only. |
| `enemyai.js` | Enemy AI with boss/regular distinction. Boss: 6 HP, 3-shot spread, slow chase. Regular: 2 HP, single shot, player-scale. |
| `persistence.js` | `loadSave()`, `writeSave()`, `downloadFroyoFile()` |
| `frustum.js` | Wide-angle view frustum culling |
| `islandatlas.js` | **Full GLB island model loader v2**: IslandF → `_PORTAL.model` (portal island, separate); A/B/C/D/E/G → `ISLAND_MODELS[]` (child islands). Exports `ISLAND_MODELS`, `getPortalIslandModel()`, `PORTAL_ISLAND_MODEL` (_PORTAL container), `loadIslandAtlas()`, `isAtlasReady()`, `getAtlasProgress()`. |

## Key State Shapes

```
player: { x,y,z, vx,vy,vz, yaw, jumpTokens:2|1|0, _wantJump, _glideArmed,
          grounded, state:STATE bitmask, squash, yawVel }

camera: { x,y,z, yaw, pitch, targetX/Y/Z, targetYaw, targetPitch,
          autoPitch, lookPitch, fovMul, lookAtX/Y/Z }

meshData (from geometry.js): { vertices:Float32Array, normals:Float32Array,
                                indices:Uint32Array }  — local space, flat
```

## Render Pipeline (per frame)
1. `clearSky()` — fill buf32 with gradient + stars + clouds
2. Build triangle list:
   - `buildVoidPlane()` — animated void/water plane at Y=-22 (NEW v0.2.0)
   - Moving platform beacons (NEW v0.2.0)
   - Platform blocks (all world shapes via pure-JS builders in renderer.js)
   - Biome decorations: trees, pines, spires, mushrooms, cacti, gemstones, lanterns (NEW v0.2.0)
   - Crystals → shadow (blob, scales with height) → enemies → portal → player
   - Player rendered as GLB mesh via `buildMeshTris()` (geometry.js), falling back to `buildBillboard()`
3. `drawTriangle()` for each tri (fog, dither, 15-bit quantize) — depth-buffer, no sort
4. Particle pass (`drawPixelW`) — breath + wind zone swirl (NEW v0.2.0)
5. `drawHUD()` → `present()` (putImageData)

## v0.2.0 New Systems

- **Moving platforms**: `platform.moving=true`, oscillate on X or Z axis via `stepMovingPlatforms(world, frame)` called each tick before physics
- **Wind zones**: `world.windZones[]` — push player.vx/vz when airborne within radius; swirling dot particles mark them visually; "WIND!" HUD flash
- **Biome decorations**: `world.decorations[]` — each island emits 1-2 type-matched decors; rendered as compound geometry shapes
- **Void plane**: large flat quad at Y=-22, animated wave color each frame
- **Two new island shapes**: CRESCENT (3-block U shape), CROSS (hub+4 arms)

## Three.js Integration (geometry.js — GLB ONLY)
- Three.js imported via dynamic `import()` from jsDelivr CDN — **no canvas**
- Used exclusively to parse `.glb` player model files
- World platforms / shapes use NO Three.js at all (pure math in renderer.js)
- `threeReady()` → Promise; resolves once THREE + GLTFLoader available; also creates internal `PerspectiveCamera` (FOV 80°, aspect 1.6)
- `syncThreeCamera(engineCam)` → call once per frame before `buildMeshTris`; pushes engine camera pos/yaw/pitch/fovMul into the Three.js camera matrices
- `loadGLBMesh(url)` → merges all child meshes, returns flat typed arrays
- `buildMeshTris()` → projects vertices via `vector.project(threeCamera)` (NDC → screen px), flat-shaded, painter's-algo tris

## Jump System
- `jumpTokens`: 2 (grounded) → 1 (first jump) → 0 (double jump)
- Restored to 2 on landing (`physics.js`)
- Gate in `physics.js` checks `jumpTokens` count, NOT state flags (prevents infinite jump bug)
- Glide armed separately via `_glideArmed` latch after both tokens spent
