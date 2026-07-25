# Agent Instructions for crawlspaceEngine

## Project identity

This repository is a browser-based retro 3D engine and reference game written in plain JavaScript ES modules.

The engine is no longer best described as only the original Froyo/Sundae Isles game. Treat it as a reusable software-rendered runtime with a platformer built on top.

## How to run

From the repository root:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/index.html
```

There is no package manager, bundler, or build step in the current snapshot.

## First files to inspect

Start with these files when making changes:

- `index.html` — browser shell.
- `main.js` — canvas setup, game boot, touch overlay, map/save import hooks.
- `game.js` — game orchestrator and frame loop.
- `renderer.js` — CPU rasterizer and procedural geometry builders.
- `geometry.js` — GLB loading/parsing and engine-native mesh triangle generation.
- `textureloader.js` — CPU image texture loading and nearest-neighbor sampling.
- `ps1fx.js` — color packing, dithering, quantization, shade/tint helpers.
- `luts.js` — shared constants and lookup tables.
- `camera.js` — third-person camera and look-ahead targeting.
- `frustum.js` — conservative sphere-frustum culling.
- `input.js` — unified keyboard/gamepad sampling.
- `gamepad.js` — reusable controller manager with remapping/deadzones/haptics.
- `touch.js` — mobile virtual controls.
- `state.js` — bitwise and discrete player-state resolution.
- `audio.js` — procedural SFX and BGM playback.
- `profiler.js` — frame and triangle counters.
- `world.js` — deterministic world generation.
- `physics.js` — player motion and collision.
- `islandatlas.js` — island GLB loading and registry.

## Important architecture rules

- The main renderer is CPU-only and writes into `ImageData`.
- Do not replace the primary render path with WebGL.
- Three.js is allowed for GLB parsing and optional CRT presentation support, not for normal scene rendering.
- Procedural geometry belongs in `renderer.js` or game-layer builders that feed the renderer.
- GLB mesh conversion belongs in `geometry.js`.
- Texture loading/sampling belongs in `textureloader.js`.
- Shared constants, movement modes, camera offsets, physics rows, and effect tables belong in `luts.js`.
- Input should flow through the existing keyboard/gamepad/touch abstraction and resolve into shared button flags/axes.
- Player state should flow through `state.js` rather than ad-hoc flags scattered across systems.

## Current world-generation model

Do not document or implement the old fixed two-ring world layout as the current architecture.

The current checkpoint uses a Voronoi portal-island model:

- IslandF is the dedicated central portal island.
- A/B/C/D/E/G are child-island models.
- IslandF is spawned at the origin and scaled via `glbScaleMul`.
- Child islands are placed through angular sector sampling.
- `world.voronoiCells` exists for debug/visualization.
- Render and physics paths must respect the same `glbScaleMul`.

If the implementation changes again, update `README.md`, `ARCHITECTURE.md`, and `DESIGN.md` together.

## Style and implementation guidance

- Prefer minimal, local changes.
- Preserve the low-resolution PS1 aesthetic.
- Keep hot paths allocation-light.
- Prefer typed arrays, lookup tables, and cached data where appropriate.
- Avoid adding build tooling unless explicitly requested.
- Do not duplicate long design explanations across files; link to the canonical doc when possible.
- Update docs when changing module boundaries, render flow, input flow, asset paths, or world-generation behavior.

## Validation

There is no automated test suite in the current snapshot. Validate changes by running the static server, opening the browser, and checking console output plus visible behavior.

For rendering changes, verify:

- sky/background clears correctly,
- geometry still clips at the near plane,
- depth ordering still behaves,
- dither/quantization still apply,
- textured triangles sample correctly,
- frustum culling does not visibly pop objects.

For input changes, verify keyboard, gamepad, and touch paths still resolve into the same button flags and axes.

## Documentation ownership

- `README.md` should explain what the project is and how to run it.
- `ARCHITECTURE.md` should describe how the runtime is built and how data flows.
- `DESIGN.md` should explain why systems behave the way they do.
- `AGENTS.md` should give practical instructions for future AI/code agents.
