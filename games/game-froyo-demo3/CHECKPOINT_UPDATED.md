# Checkpoint — Documentation Rewrite

## Completed

- Rewrote `README.md` around the current crawlspaceEngine identity instead of the old froyo-engine-only framing.
- Rewrote `ARCHITECTURE.md` to reflect the uploaded engine modules: CPU renderer, GLB pipeline, texture loader, PS1 effects, frustum culling, input/gamepad/touch, camera, audio, state, LUTs, CRT overlay, and profiler.
- Rewrote `DESIGN.md` to separate engine-level design from the current Froyo/Sundae Isles reference game.
- Rewrote `AGENTS.md` with current module responsibilities, architecture rules, and the Voronoi portal-island checkpoint.

## Source of truth used

- Uploaded JavaScript engine modules in `/mnt/data`.
- Current markdown docs.
- Current Voronoi portal-island checkpoint.

## Notes

- The current `main.js` has CRT initialization commented out. The docs describe `crt.js` as optional, not active-by-default.
- The uploaded source snapshot did not include every game-layer file, so `game.js`, `world.js`, `physics.js`, `islandatlas.js`, and related game modules are documented from the existing docs/checkpoint rather than newly inspected source.
