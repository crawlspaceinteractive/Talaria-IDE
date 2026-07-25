# Checkpoint — Voronoi Portal Island Refactor

## Completed
1. **islandatlas.js v2.0** — IslandF is now a dedicated portal island loaded
   separately from child islands (A–E, G). Exports:
   - `ISLAND_MODELS[]` — child islands only (6 models, excludes F)
   - `_PORTAL` container object + `getPortalIslandModel()` — IslandF entry
   - Progress tracks 7 total loads (IslandF first, then A/B/C/D/E/G)

2. **world.js v3.0** — Full Voronoi parent-child spawning system:
   - `buildPortalIsland()` places IslandF at origin, scaled 2× (glbScaleMul=2.0)
   - `buildVoronoiSectors(rand, n, innerR, outerR)` — angular cell partition
   - `sampleInSector(rand, sector, ...)` — rejection sampling within each cell
   - Inner ring: 5–6 sectors @ 3.0–5.5 × S world units (scaled DOWN ~40%)
   - Outer ring: 4–5 sectors @ 6.0–9.0 × S world units (scaled DOWN ~40%)
   - Removed old 2-ring array; replaced with Voronoi sector loop
   - `voronoiCells` exported on world object for debug/visualization

3. **game.js** — Two patches:
   - Precache: `effectiveScale = p.glbModel.scale * (p.glbScaleMul ?? 1.0)`
   - Render: same `effectiveScale` applied; portal island cullDist = 999 (always visible)

4. **physics.js** — One patch:
   - Face vertices multiplied by `scaleMul = p.glbScaleMul ?? 1.0`
   - AABB top/bot also scaled by `scaleMul`

## What Remains / Next Steps
- **Visual test**: Confirm IslandF appears massive at center and children are
  tightly clustered around it. May need to tweak PORTAL_SCALE_MUL (currently 2.0)
  and ring distances (3.0–9.0 × S) after visual inspection.
- **Voronoi visualization** (optional): Draw sector boundaries in debug mode using
  `world.voronoiCells` to show the angular territories.
- **Multi-parent Voronoi** (future): Add 2–3 sub-parent islands as secondary Voronoi
  sites using Fortune's algorithm via d3-delaunay CDN; children re-assign to nearest
  parent each frame via `getClosestParent()`.
- **Portal placement**: Currently portal floats above IslandF's portalY. May want to
  anchor it to a specific feature on IslandF's mesh.
- **Fallback check**: If atlas not loaded when `generateWorld()` runs, procedural
  tiered parent island is used — should regenerate world after atlas loads.

## Key File Changes
| File | Change |
|---|---|
| `islandatlas.js` | IslandF → `_PORTAL.model`; others → `ISLAND_MODELS[]` |
| `world.js` | Voronoi sector spawning; buildPortalIsland with 2× scale |
| `game.js` | glbScaleMul in precache + render; portal island always visible |
| `physics.js` | Face coords × scaleMul for 2× portal island collision |
