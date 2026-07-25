# crawlspaceEngine

A browser-based retro 3D engine focused on software-rendered PS1-era visuals, modular runtime systems, and game-specific worlds built on top of plain JavaScript modules.

The current reference project is still rooted in the original Froyo/Sundae Isles platformer, but the codebase has moved beyond a single game prototype. Rendering, input, camera, texture sampling, audio, profiling, state handling, and presentation effects are now separated into reusable engine modules.

## What it does

crawlspaceEngine renders a low-resolution 3D scene into a CPU-owned `ImageData` buffer, then presents that buffer through a scaled HTML canvas. WebGL is not used for the main game renderer. Three.js is used only where needed for support tasks such as GLB parsing and the optional CRT presentation shader.

Core capabilities include:

- CPU software rasterization at 320×200.
- Engine-native projection for procedural and GLB geometry.
- PS1-style integer vertex snap, affine texture interpolation, ordered Bayer dithering, 15-bit color quantization, and distance fog.
- GLB model loading through Three.js, converted into engine-owned typed arrays.
- CPU-side texture loading, nearest-neighbor sampling, wrapping/clamping, and tinting.
- Conservative frustum culling for large world scenes.
- Third-person camera follow/orbit with movement-mode offsets, FOV smoothing, look-ahead ray targeting, and manual pitch support.
- Keyboard, touch, and gamepad input paths unified into bitwise input flags and analog movement axes.
- Procedural Web Audio sound effects plus streamed background music.
- Runtime profiler counters for frame timing and triangle statistics.
- Deterministic world-generation support, including the current Voronoi portal-island layout.

## Run locally

No package manager, bundler, or build step is required.

```bash
python3 -m http.server 8000
```

Open:

```text
http://127.0.0.1:8000/index.html
```

The project expects to be served from a static HTTP server because it uses ES modules and loads local assets through browser APIs.

## Browser entry point

`index.html` mounts a single `#game-root` element and loads `main.js` as a module. `main.js` creates the fullscreen 320×200 game canvas, boots `FroyoGame`, attaches the touch overlay, and wires hidden file inputs for map/save imports.

The CRT overlay path exists in `crt.js`, but the current uploaded `main.js` has CRT initialization commented out. The game still runs directly through the pixelated canvas.

## Engine modules

| File | Purpose |
|---|---|
| `main.js` | Browser shell, canvas creation, game boot, file-input hooks, touch overlay hookup. |
| `renderer.js` | CPU software rasterizer, sky clear, triangle drawing, fog, dither/quantization path, procedural geometry builders, HUD text helpers, present step. |
| `geometry.js` | GLB loading/parsing through Three.js, typed-array mesh extraction, engine-native mesh projection, island color/texture handling, cached static mesh path. |
| `textureloader.js` | CPU texture loader/sampler using an offscreen canvas and raw RGBA image data. |
| `ps1fx.js` | Packed ABGR color helpers, 15-bit quantization, ordered dithering, shade/tint operations. |
| `luts.js` | Resolution constants, focal tables, trig tables, movement/camera/physics lookup tables, animation and effect tables. |
| `camera.js` | Third-person camera state, look-ahead raycast, movement-mode camera offsets, pitch/FOV smoothing. |
| `frustum.js` | Six-plane conservative sphere frustum culling. |
| `input.js` | Keyboard and gamepad sampling merged into bitwise button flags and axes. |
| `gamepad.js` | Reusable Gamepad API manager with mappings, deadzones, event dispatch, chord checks, and vibration support. |
| `touch.js` | Mobile touch overlay with virtual joystick and action buttons. |
| `state.js` | Bitwise player-state resolution and discrete movement/jump mode selection. |
| `audio.js` | Procedural Web Audio SFX and streamed looping BGM. |
| `crt.js` | Optional Three.js shader overlay for CRT scanlines, shadow mask, softness, sweep, and source sharpening. |
| `profiler.js` | Per-frame timing and triangle counters. |

Game-layer modules referenced by the docs include `game.js`, `world.js`, `physics.js`, `islandatlas.js`, `breath.js`, `portal.js`, `hud.js`, `enemyai.js`, and `persistence.js`. These sit above the engine modules and are responsible for the current reference game behavior.

## Assets

The local setup loads assets from repository-relative paths. Current model expectations include player/enemy/sky/bridge/island GLBs and a background music file at:

```text
./game/music/background.mp3
```

The current world-generation checkpoint describes seven island GLBs where IslandF is treated as the dedicated portal island and A/B/C/D/E/G are child-island candidates.

## Development notes

- Keep rendering code CPU-first. Do not replace the main visual path with WebGL.
- Three.js should remain a support dependency, not the primary renderer.
- Prefer typed arrays and cache-friendly data structures in hot paths.
- Keep projection math consistent between procedural geometry and GLB meshes.
- Use `luts.js` for shared constants and lookup tables rather than scattering gameplay/render constants through modules.
- Validate changes in the browser and console; there is no test suite or package configuration in the current project snapshot.

## Related docs

- `ARCHITECTURE.md` — runtime architecture, module boundaries, and pipeline flow.
- `DESIGN.md` — engine design goals, visual philosophy, gameplay/reference-world design, and tradeoffs.
- `AGENTS.md` — practical instructions for AI/code agents working in the repo.
