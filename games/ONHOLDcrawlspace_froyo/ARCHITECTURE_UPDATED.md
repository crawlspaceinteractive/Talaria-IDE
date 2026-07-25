# crawlspaceEngine — Architecture

## Concept

crawlspaceEngine is a browser-based software-rendered retro 3D engine. The main renderer writes directly into a low-resolution `ImageData` buffer and presents that buffer through a pixel-scaled canvas. The architecture favors deterministic data, typed arrays, lookup tables, conservative culling, and simple module boundaries over a framework-heavy runtime.

The current game layer is a PS1-style floating-island platformer, but the engine layer now contains reusable systems for rendering, GLB ingestion, textures, input, camera, audio, state, profiling, and presentation.

## Runtime boot

1. `index.html` creates the document shell and loads `main.js` as an ES module.
2. `main.js` waits for `DOMContentLoaded`, finds `#game-root`, and injects a fullscreen shell containing a 320×200 canvas.
3. `main.js` constructs `FroyoGame(canvas)` from `./game/game.js`.
4. The touch overlay is created with `createTouchOverlay(shell, game.input)`.
5. Hidden file inputs are wired for scene JSON imports and `.froyo` save imports.
6. `game.start()` begins the game loop.
7. On unload, `game.stop()` is called.

The optional CRT overlay exists in `crt.js`. The current uploaded `main.js` keeps the CRT initialization commented out, so the canvas path is the active presentation path.

## Module map

### Browser shell

| File | Role |
|---|---|
| `index.html` | Minimal HTML shell; mounts `#game-root`; loads `main.js`; links `global.css`. |
| `global.css` | Fullscreen black background and monospace defaults. |
| `main.js` | Canvas creation, game boot, touch overlay, scene/save file input hooks. |

### Rendering and presentation

| File | Role |
|---|---|
| `renderer.js` | Core CPU rasterizer and procedural geometry builders. Owns sky clear, projection, clipping, fog, triangle rasterization, textured triangles, pixels, text, rectangles, and final canvas presentation. |
| `geometry.js` | GLB support layer. Loads GLBs through Three.js, extracts flat typed arrays, converts mesh data into engine triangle records, supports island palettes/textures, and provides cached static mesh rendering. |
| `textureloader.js` | CPU texture loading and nearest-neighbor sampling. Converts images to canvas `ImageData`, caches by URL/wrap mode, supports wrap/clamp addressing and tint multiplication. |
| `ps1fx.js` | Packed color helpers and PS1-style effects: ordered 4×4 Bayer dither, 15-bit quantization, integer shade/tint blending. |
| `crt.js` | Optional Three.js post-process overlay. Samples the game canvas and applies scanlines, shadow mask, blur/softness, sharpness, color mode, and sweep uniforms. |
| `frustum.js` | Conservative six-plane sphere-frustum culling using widened cull angles and camera yaw/pitch. |
| `profiler.js` | Lightweight runtime counters for frame time and triangle flow. |

### Runtime control

| File | Role |
|---|---|
| `input.js` | Merges keyboard and gamepad state into `BTN_FLAGS`, movement axes, and camera-orbit axes. Preserves keydown pulses so sub-frame taps are not lost. |
| `gamepad.js` | Standalone Gamepad API manager: connection events, default mappings, deadzones, button/axis queries, remapping, chords, vibration, and polling. |
| `touch.js` | Touch-only virtual joystick and action buttons mapped into the same input controller used by keyboard/gamepad. |
| `state.js` | Resolves bitwise player state from input/grounding/jump tokens, then maps flags to discrete movement and jump modes. |
| `luts.js` | Shared constants and lookup tables for resolution, projection scale, trig, movement, camera, physics, animation, jumps, breath, warp, and dither. |
| `camera.js` | Third-person camera state, look-ahead raycast, follow target, smoothed yaw/pitch/FOV, and movement-mode offsets. |
| `audio.js` | Procedural SFX via Web Audio oscillator/noise bursts and streamed looping BGM through an `HTMLAudioElement`. |

### Game layer

| File | Role |
|---|---|
| `game.js` | Game orchestrator: mode/state machine, tick loop, subsystem calls, asset handoff, render assembly. |
| `world.js` | Deterministic world generation. Current checkpoint uses a Voronoi portal-island layout. |
| `physics.js` | Player movement, gravity, jump token handling, procedural collision, GLB face collision, scaled collision support. |
| `islandatlas.js` | Island GLB loading and registry. Current checkpoint separates IslandF as the portal island and A/B/C/D/E/G as child islands. |
| `breath.js` | Ice breath particles, freeze/shatter interactions, breakables. |
| `portal.js` | Portal trigger and warp transition behavior. |
| `hud.js` | HUD drawing on top of the software-rendered frame. |
| `enemyai.js` | Enemy and boss behavior. |
| `persistence.js` | Save/load and `.froyo` export/import support. |

## Render data model

The renderer owns a compact render target:

```js
{
  canvas,
  ctx,
  image,
  buf32,
  zbuf,
  tris
}
```

- `buf32` is the 32-bit packed canvas buffer.
- `zbuf` stores per-pixel depth.
- `tris` is the frame-local triangle list built by procedural and GLB paths.
- Color values are packed in ABGR form for direct canvas writes.

## Projection model

Projection is engine-native:

1. World-space vertices are transformed into camera space using camera position, yaw, and pitch.
2. Near-plane clipping occurs at `NEAR_Z = 0.4`.
3. Camera-space points are projected to 320×200 screen coordinates through `scaleAtX()` and `scaleAtY()` from `luts.js`.
4. Screen coordinates are integer-snapped, producing intentional PS1-style vertex jitter.

`geometry.js` uses the same projection convention as `renderer.js`. Three.js is used to parse GLB files, not to project or draw them.

## Rendering pipeline

A typical frame is assembled as follows:

1. The game layer clears frame counters and updates camera/frustum state.
2. `clearSky()` fills the framebuffer with a sky gradient, stars, and cloud masks.
3. World/game systems append triangle records into `rd.tris`:
   - procedural platforms and blocks,
   - bridges and oriented planks,
   - void/water plane,
   - decorations such as trees, pines, spires, mushrooms, cacti, gemstones, and lanterns,
   - GLB meshes through `buildMeshTris()` or cached island meshes through `buildMeshTrisFromCache()`,
   - billboards and simple effects where appropriate.
4. The triangle path clips near-plane geometry and rejects invalid triangles.
5. `drawTriangle()` rasterizes opaque/color triangles with a depth buffer, fog lookup/cache, ordered dither, and 15-bit quantization.
6. `drawTexturedTriangle()` rasterizes textured triangles with affine UV interpolation, nearest-neighbor CPU texture sampling, tinting, depth, fog, and quantization.
7. Particles and one-off world pixels use `drawPixelW()`.
8. HUD/text/rect helpers draw 2D overlays.
9. `present()` writes the `ImageData` to the canvas and can apply warp/fade post effects.
10. Optional CRT presentation can sample the canvas texture in a separate overlay when enabled.

## GLB mesh pipeline

`geometry.js` provides two related paths:

### Dynamic mesh path

- `threeReady()` imports Three.js and `GLTFLoader` from CDN.
- `loadGLBMesh()` parses a GLB scene.
- `extractMeshData()` walks geometry attributes into flat typed arrays: vertices, normals, indices, and optional colors/UVs/material texture hints.
- `buildMeshTris()` transforms, lights, colors, clips, and emits triangle records each frame.

### Static island cache path

- `precacheIslandColors()` pre-applies scale/yaw and resolves island color/texture zones.
- `buildMeshTrisFromCache()` performs only camera-space transform, clipping, projection, and triangle emission per frame.

This keeps static island geometry cheaper than reprocessing full model color/material decisions every frame.

## Texture pipeline

`textureloader.js` loads browser images into CPU-readable RGBA buffers:

1. `loadTexture(url, opts)` returns a cached texture object or `null` on failure.
2. Images are drawn to an offscreen canvas with smoothing disabled.
3. `getImageData()` exposes raw pixel data.
4. `sampleTextureNearest(tex, u, v)` performs wrap or clamp addressing.
5. `tintTexelRGBA()` multiplies sampled texels by a packed tint color.

Textures are sampled in software. The renderer deliberately uses affine interpolation rather than perspective-correct interpolation to preserve the retro wobble/warp aesthetic.

## Camera and culling

`camera.js` owns the third-person camera object:

- position, target position, yaw, target yaw,
- pitch, target pitch, auto pitch, manual look pitch,
- FOV multiplier and target FOV multiplier,
- smoothed look-at point and instantaneous look-at target.

`castLookRay()` marches from the player muzzle forward along player yaw and stores a look-at target. `updateCamera()` follows the player using movement-mode offsets and lag curves from `luts.js`, derives auto-pitch toward the smoothed look-at point, and eases yaw/pitch/FOV.

`frustum.js` rebuilds six world-space planes each frame using camera position, yaw, and pitch. `sphereInFrustum()` returns false only when a sphere is entirely outside one plane, making the culler conservative by design.

## Input pipeline

Input resolves into a shared shape:

```js
{
  mask,
  prevMask,
  axisX,
  axisY,
  orbitX,
  orbitY
}
```

- Keyboard maps WASD/arrows to movement, Space to A/jump, J/K/L to face buttons, Shift/Ctrl to LT/RT, Enter/Escape to Start, Tab to Select, and Q/E to camera orbit.
- Gamepads use `GamepadManager` and the browser Gamepad API, including left stick, D-pad fallback, right-stick camera orbit/pitch, shoulder buttons, triggers, and haptics.
- Touch controls update the same input controller through virtual joystick/action UI.

`state.js` consumes the input layer and resolves:

- bitwise flags such as WALK, CHARGE, JUMP, DOUBLE_JUMP, GLIDE, HIT, FROZEN, DEAD,
- movement modes such as IDLE, WALK, CHARGE, AIRBORNE, GLIDE,
- jump modes such as GROUNDED, JUMPING, DOUBLE_JUMP, FALLING.

The jump system is token-driven. `jumpTokens` replaces older boolean double-jump state and prevents infinite-jump edge cases.

## Audio pipeline

`audio.js` uses lazy Web Audio initialization to respect browser autoplay policies.

- SFX are generated procedurally with oscillator bursts and filtered noise.
- Individual sound functions cover jump, double jump, ice breath, crystal/crate break, enemy freeze/death, player hit, enemy shot, wind, portal open, collect, and landing.
- FX volume is controlled separately from BGM volume.
- BGM streams from `./game/music/background.mp3` through an `HTMLAudioElement`, optionally routed through Web Audio gain.

## World-generation checkpoint

The current checkpoint moves world layout away from fixed ring arrays and toward a Voronoi parent-child model:

- IslandF is loaded as the dedicated portal island.
- Child islands are A/B/C/D/E/G.
- `buildPortalIsland()` places IslandF at the origin with `glbScaleMul = 2.0`.
- Inner and outer child bands are sampled through angular sectors.
- `world.voronoiCells` is exported for debugging/visualization.
- Render and physics paths apply `glbScaleMul` so the portal island's visuals and collision remain consistent.

## Performance strategy

- Render at 320×200 and scale with CSS.
- Use typed arrays for framebuffers, depth buffers, geometry, colors, and lookup tables.
- Use lookup tables for trig, projection scale, fog, physics modes, and effect curves.
- Integer-snap projected vertices for both performance and style.
- Cache fog/color bands and static island mesh data.
- Use conservative frustum culling to skip off-camera work without popping visible geometry.
- Keep the hot raster path allocation-light.

## Current architectural constraints

- The main renderer is CPU-only.
- Three.js is a loader/support dependency, not the primary renderer.
- The runtime is plain ES modules with no package manager in the current snapshot.
- Browser validation is the primary test method.
- Module paths in the flattened upload may differ from the repository layout; the browser entry point expects `./game/game.js` and `./engine/touch.js` from `main.js`.
