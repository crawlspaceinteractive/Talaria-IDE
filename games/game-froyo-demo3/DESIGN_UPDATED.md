# crawlspaceEngine — Design Document

## Direction

crawlspaceEngine is a software-rendered retro 3D engine with a reference platformer layered on top. It began as the Froyo/Sundae Isles game, but the current architecture is better described as an engine runtime: rendering, GLB ingestion, texture sampling, input, camera, audio, state, profiling, and post-processing are split into reusable modules.

The reference game still provides the immediate design target: a PS1-style floating-island platformer with traversal, ice breath, enemies, collectible crystals, portals, and procedural island layouts. The engine should remain general enough to support other low-poly retro game types without rewriting the renderer.

## Design pillars

### CPU-first rendering

The primary visual path is a CPU software rasterizer. The engine writes to a 320×200 `ImageData` buffer and presents it through a pixel-scaled canvas. This keeps the renderer deterministic, hackable, and visually aligned with PS1-era limitations.

### Retro authenticity over physical correctness

Visual choices intentionally favor retro-console artifacts:

- integer-snapped screen vertices,
- affine texture mapping,
- nearest-neighbor texture sampling,
- ordered Bayer dithering,
- 15-bit color quantization,
- simple directional lighting,
- distance fog,
- low internal resolution.

Artifacts are features. Wobble, chunky pixels, dither, and quantized color are part of the engine identity.

### Modular plain-JS runtime

The project avoids a build system and keeps systems in ES modules. Runtime services should remain easy to inspect, copy, fork, and adapt.

### Engine with a reference game

The docs should treat Froyo/Sundae Isles as the current game layer, not as the whole engine. The engine layer should remain usable for other projects built around the same software-rendered retro stack.

## Rendering design

### Resolution and projection

The engine renders internally at 320×200. `luts.js` defines:

- `SCREEN_W = 320`,
- `SCREEN_H = 200`,
- asymmetric focal lengths approximating ~100° horizontal and ~80° vertical FOV,
- projection scale lookup tables for X and Y,
- trig lookup tables for degree-based camera/entity math.

The renderer transforms world points into camera space, clips against the near plane, then projects with `scaleAtX()` and `scaleAtY()`. Projection outputs integer screen positions, which creates deliberate PS1-style vertex jitter.

### Triangle path

`renderer.js` owns the main triangle path:

- `clearSky()` draws sky gradient, stars, and simple clouds.
- `buildFace()` and procedural builders emit clipped triangle records.
- `drawTriangle()` rasterizes filled triangles with depth, fog, dither, and quantization.
- `drawTexturedTriangle()` adds affine UV interpolation and CPU texture sampling.
- `drawPixelW()` handles world-space particles and pixel effects.
- `drawText()` and `drawRect()` support HUD/UI overlays.
- `present()` writes the final `ImageData` and can apply warp/fade effects.

### Procedural geometry

The renderer includes builders for common low-poly shapes:

- cubes,
- trapezoids,
- triangular prisms,
- oriented planks,
- billboards,
- island tapers,
- void/water plane,
- trees,
- pines,
- spires,
- mushrooms,
- cacti,
- gemstones,
- lanterns.

These are pure JavaScript geometry emitters and do not depend on Three.js.

### GLB geometry

`geometry.js` handles GLB support. Three.js is imported dynamically to parse GLB files, but projection and rendering remain engine-native.

Key decisions:

- GLB models are converted into flat typed arrays.
- Mesh projection uses the same camera-space math as procedural geometry.
- `syncThreeCamera()` remains for compatibility, but drawing does not depend on Three.js projection.
- Island meshes can be precached so static color/texture zone decisions do not repeat every frame.
- Mesh color modes support player, enemy/sun, cherry, bridge, island, sky dome, sky ring, and experimental sun-zone rendering behaviors.

### Texture design

`textureloader.js` provides CPU textures:

- image loading through browser `Image`,
- offscreen canvas extraction into RGBA data,
- cached texture promises by URL/wrap mode,
- nearest-neighbor sampling,
- wrap/clamp addressing,
- tint multiplication.

The textured triangle path keeps affine interpolation instead of perspective correction. This is both cheaper and more visually consistent with PS1-era texture warping.

### Color and post effects

`ps1fx.js` centralizes color helpers:

- ABGR packing for direct canvas writes,
- 15-bit color quantization,
- 4×4 Bayer ordered dithering,
- integer shade/tint blending.

`crt.js` provides an optional presentation layer using Three.js shader rendering. It samples the game canvas and applies CRT-style scanlines, shadow mask, softness, sharpening, color mode, and sweep effects. The current `main.js` keeps this disabled by default.

## Camera design

The camera is a state-driven third-person follow camera.

Movement modes select offsets and FOV behavior from lookup tables:

- idle,
- walk,
- charge,
- airborne,
- glide.

The camera tracks:

- position and target position,
- yaw and target yaw,
- pitch and target pitch,
- FOV multiplier,
- automatic pitch,
- manual look pitch,
- smoothed look-at point.

`castLookRay()` looks ahead from the player muzzle and sets a target point in the world. `updateCamera()` then smooths toward that look point and derives auto-pitch, so the camera looks ahead of the player instead of only at the body/feet.

## Input design

Input is normalized into bitwise flags and analog axes.

### Keyboard

Default keyboard layout:

- WASD / arrow keys: movement,
- Space: A / jump,
- J: X / ice breath,
- K: B,
- L: Y,
- Shift: LT / glide hold,
- Ctrl: RT / charge hold,
- Enter or Escape: Start,
- Tab: Select,
- Q/E: camera orbit.

Keyboard pulses are preserved until sampling so a quick keydown/keyup inside a single frame can still be detected as `justPressed`.

### Gamepad

`gamepad.js` is a reusable controller manager. It supports:

- connection/disconnection events,
- button and axis polling,
- default button names,
- stick deadzones,
- remapping,
- chords,
- vibration/haptics,
- right-stick camera orbit/pitch.

### Touch

`touch.js` mounts a touch-only overlay with:

- virtual joystick,
- jump/action/start buttons,
- multi-touch pointer tracking,
- resize-aware placement.

Touch input feeds the same controller state used by keyboard and gamepad.

## State and movement design

`state.js` separates bitwise state flags from discrete movement/jump modes.

Bitwise flags include:

- WALK,
- CHARGE,
- JUMP,
- DOUBLE_JUMP,
- GLIDE,
- HIT,
- FROZEN,
- DEAD.

Discrete movement modes include:

- IDLE,
- WALK,
- CHARGE,
- AIRBORNE,
- GLIDE.

Jump modes include:

- GROUNDED,
- JUMPING,
- DOUBLE_JUMP,
- FALLING.

The jump system uses `jumpTokens`:

- `2` means grounded/full jump resource,
- `1` means first jump spent and double jump available,
- `0` means both jumps spent and glide can be armed.

This replaces older boolean jump-state approaches and prevents edge cases where state flags alone could allow infinite jumps.

## Audio design

`audio.js` uses two audio paths:

### Procedural SFX

Sound effects are generated with Web Audio oscillator bursts and filtered noise. This keeps effects code-only and lightweight.

Implemented events include:

- jump,
- double jump,
- ice breath,
- crystal break,
- crate break,
- enemy frozen,
- enemy death,
- player hit,
- enemy shot,
- wind,
- portal open,
- collect,
- land.

### Background music

BGM streams from `./game/music/background.mp3` through an `HTMLAudioElement`. When Web Audio is available, the element is routed through a gain node so BGM volume can be managed consistently with SFX volume.

## World design

The current checkpoint replaces the older fixed ring layout with a Voronoi portal-island design.

### Portal island

- IslandF is loaded separately from the normal child-island pool.
- It acts as the central portal island and world hub.
- It is spawned at the origin.
- It uses `glbScaleMul = 2.0` in the current checkpoint.
- Render and physics both apply the scale multiplier.
- The portal island is kept visible as a landmark with relaxed culling.

### Child islands

- A/B/C/D/E/G are treated as child-island models.
- Child islands are distributed through angular Voronoi-style sectors.
- Inner sectors occupy the closer band around the portal island.
- Outer sectors occupy a farther band.
- Sampling uses rejection within sectors to reduce overlap and clumping.
- `world.voronoiCells` is exported for debug visualization/future tooling.

### Future world direction

The checkpoint notes possible future expansion toward multiple parent islands, secondary Voronoi sites, and dynamic child reassignment. That should remain a future-design note rather than documented as current behavior until implemented.

## Collision design

The game layer uses both procedural and GLB collision.

- Procedural block collision uses AABB-style top landing and side push-out.
- GLB island collision uses face data and narrow-phase checks.
- Current portal-island scaling requires collision to multiply face vertices and AABB bounds by `glbScaleMul`.
- Moving platforms are handled before physics so player carry deltas can be applied consistently.

## Frustum and visibility design

`frustum.js` is conservative by design.

- It builds six planes each frame from camera position/yaw/pitch.
- Horizontal and vertical cull angles are wider than the visual FOV.
- `sphereInFrustum()` only rejects objects entirely outside a plane.
- This reduces visible pop-in at the cost of allowing some extra work near the screen edges.

## Profiler design

`profiler.js` tracks per-frame counters:

- frame index,
- triangles in,
- triangles culled,
- triangles clipped,
- triangles subdivided,
- triangles drawn,
- frame start time,
- frame duration.

The profiler is intentionally lightweight and can be called from hot paths without introducing a heavyweight diagnostics dependency.

## Reference game design

The current reference game remains a PS1-style floating-island platformer:

- double-jump and glide traversal,
- ice breath attack,
- enemies and boss behavior,
- collectibles,
- portal progression,
- biome/deco variety,
- bridges and moving platforms,
- wind zones,
- save/load support.

The design docs should keep this game-specific material clearly separate from engine-level architecture. The engine should not be described as only a frozen-yogurt game anymore.

## Design constraints

- Do not make WebGL the primary renderer.
- Preserve the CPU framebuffer pipeline.
- Keep Three.js limited to GLB loading/support and optional presentation effects.
- Keep input/state paths unified across keyboard, gamepad, and touch.
- Keep lookup-table-driven behavior centralized in `luts.js`.
- Prefer deterministic, inspectable systems over hidden framework behavior.
- Keep module boundaries simple enough for AI agents and human modders to reason about quickly.
