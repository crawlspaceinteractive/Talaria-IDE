# Agent Instructions for froyo-enginev3

## What this project is
- A browser-based PS1-style game engine / game project written in plain JavaScript.
- Uses a full CPU software rasterizer that renders into a `ImageData` buffer.
- No package manager or build system is present; this is a static web project.

## How to run locally
- From the repository root, start a static server:
  ```bash
  python3 -m http.server 8000
  ```
- Open the game in a browser at:
  ```text
  http://127.0.0.1:8000/index.html
  ```
- `scene-editor.html` is an optional editor prototype for scene/export testing.

## Key files to inspect first
- `README.md` — local workflow and model requirements
- `ARCHITECTURE.md` — engine structure, render pipeline, world gen, and camera system
- `DESIGN.md` — design decisions, rendering architecture, island generation, collision, and gameplay systems
- `index.html` / `main.js` — bootstrap and DOM setup
- `game.js` — main orchestrator and frame loop
- `renderer.js` — software rasterizer, procedural geometry builders, draw pipeline
- `geometry.js` — GLB mesh parsing and mesh triangle assembly
- `world.js` — procedural island generation and world layout
- `physics.js` — player movement, collision, jump logic
- `camera.js` — camera follow/orbit and look ray handling
- `islandatlas.js` — GLB island model loading and atlas management
- `input.js` — keyboard + gamepad input handling
- `breath.js` — ice breath particle/effect logic
- `hud.js` — HUD rendering
- `persistence.js` — save/load and export support

## Important project conventions
- No WebGL is used for the main rendering path.
- Three.js is imported dynamically only in `geometry.js` to parse `.glb` files.
- Procedural world geometry and renderer builders live in `renderer.js`.
- GLB model rendering is integrated through `buildMeshTris()` after parsing in `geometry.js`.
- The engine relies on deterministic world generation with seeded PRNG and ring-based island layout.
- There is no test suite or package configuration; use the browser and console for validation.

## Notes for AI agents
- Preserve existing documentation and link to it rather than duplicating entire sections.
- When adding or fixing behavior, follow the project’s CPU rasterizer / software-rendering architecture.
- Prefer minimal changes that respect the existing engine flow and state shape.
- Use `README.md`, `ARCHITECTURE.md`, and `DESIGN.md` as authoritative references for architecture and design decisions.

## References
- [README.md](README.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DESIGN.md](DESIGN.md)
