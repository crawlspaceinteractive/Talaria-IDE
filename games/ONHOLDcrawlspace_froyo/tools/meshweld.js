/**
 * meshweld.js — Corner-averaging / vertex-welding + inter-island magnetization
 *
 * MODULES
 * -------
 *  weldBlockCorners      — within one island: average coincident corners into poly verts
 *  averageGroupCorners   — alias for weldBlockCorners
 *  getWeldedTopVerts     — unique top-face verts after welding
 *  getAllWeldedVerts      — all unique welded verts
 *
 *  magnetizeIslandEdges  — CROSS-ISLAND: snap edge verts that are near each other in
 *                          XZ toward their shared XZ centroid, preserving each island's
 *                          relative Y heights so ramps form naturally.
 *
 * ─── Corner slot order (matches buildCube in renderer.js) ───────────────────
 *   0  top    NW  (-sx, +sy, -sz)
 *   1  top    NE  (+sx, +sy, -sz)
 *   2  top    SE  (+sx, +sy, +sz)
 *   3  top    SW  (-sx, +sy, +sz)
 *   4  bottom NW  (-sx, -sy, -sz)
 *   5  bottom NE  (+sx, -sy, -sz)
 *   6  bottom SE  (+sx, -sy, +sz)
 *   7  bottom SW  (-sx, -sy, +sz)
 */

// ─── Corner extraction ────────────────────────────────────────────────────────

/**
 * Return the 8 AABB corners of a block in world space.
 * Block record must have: wx, wy, wz (world-space centre) and sx, sy, sz (half-extents).
 *
 * @param {{ wx:number, wy:number, wz:number, sx:number, sy:number, sz:number }} block
 * @returns {Array<{x:number, y:number, z:number}>}
 */
export function getBlockCorners(block) {
  const { wx, wy, wz, sx, sy, sz } = block;
  return [
    { x: wx - sx, y: wy + sy, z: wz - sz }, // 0 top NW
    { x: wx + sx, y: wy + sy, z: wz - sz }, // 1 top NE
    { x: wx + sx, y: wy + sy, z: wz + sz }, // 2 top SE
    { x: wx - sx, y: wy + sy, z: wz + sz }, // 3 top SW
    { x: wx - sx, y: wy - sy, z: wz - sz }, // 4 bot NW
    { x: wx + sx, y: wy - sy, z: wz - sz }, // 5 bot NE
    { x: wx + sx, y: wy - sy, z: wz + sz }, // 6 bot SE
    { x: wx - sx, y: wy - sy, z: wz + sz }, // 7 bot SW
  ];
}

// ─── Core welding algorithm ───────────────────────────────────────────────────

/**
 * Weld / average corners from a group of blocks within ONE island.
 * Corners within `threshold` world units of each other (all 3 axes) are
 * merged into a single averaged poly vert.
 *
 * @param {Array<object>} blocks   — world-space block records (wx,wy,wz,sx,sy,sz)
 * @param {number}        threshold
 *
 * @returns {{
 *   verts:     Float32Array,   // [x0,y0,z0, x1,y1,z1, …]
 *   cornerMap: Uint16Array,    // blocks.length*8 → vert index
 *   vertCount: number,
 * }}
 */
export function weldBlockCorners(blocks, threshold = 0.5) {
  const nBlocks = blocks.length;
  const totalCorners = nBlocks * 8;

  const raw = new Array(totalCorners);
  for (let b = 0; b < nBlocks; b++) {
    const corners = getBlockCorners(blocks[b]);
    for (let s = 0; s < 8; s++) {
      const idx = b * 8 + s;
      raw[idx] = { x: corners[s].x, y: corners[s].y, z: corners[s].z, origIdx: idx };
    }
  }

  // Sort by X then Y then Z for linear sweep clustering
  raw.sort((a, b) => {
    const dx = a.x - b.x;
    if (dx !== 0) return dx;
    const dy = a.y - b.y;
    if (dy !== 0) return dy;
    return a.z - b.z;
  });

  // Union-Find (path-compressed)
  const parent = new Int32Array(totalCorners);
  for (let i = 0; i < totalCorners; i++) parent[i] = i;

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  for (let i = 0; i < totalCorners; i++) {
    const ci = raw[i];
    for (let j = i + 1; j < totalCorners; j++) {
      const cj = raw[j];
      if (cj.x - ci.x > threshold) break;
      if (Math.abs(cj.y - ci.y) <= threshold && Math.abs(cj.z - ci.z) <= threshold) {
        union(ci.origIdx, cj.origIdx);
      }
    }
  }

  const clusterMembers = new Map();
  for (let i = 0; i < totalCorners; i++) {
    const r = find(i);
    if (!clusterMembers.has(r)) clusterMembers.set(r, []);
    clusterMembers.get(r).push(i);
  }

  const vertCount = clusterMembers.size;
  const verts = new Float32Array(vertCount * 3);
  const rootToVert = new Map();
  let vi = 0;
  for (const [root, members] of clusterMembers) {
    let ax = 0, ay = 0, az = 0;
    const n = members.length;
    for (let m = 0; m < n; m++) {
      const origIdx = members[m];
      const bi = (origIdx / 8) | 0;
      const si = origIdx - bi * 8; // origIdx % 8 without modulo
      const pos = getBlockCorners(blocks[bi])[si];
      ax += pos.x; ay += pos.y; az += pos.z;
    }
    const rn = 1.0 / n; // one division per cluster, not per member
    verts[vi * 3]     = ax * rn;
    verts[vi * 3 + 1] = ay * rn;
    verts[vi * 3 + 2] = az * rn;
    rootToVert.set(root, vi);
    vi++;
  }

  const cornerMap = new Uint16Array(totalCorners);
  for (let i = 0; i < totalCorners; i++) {
    cornerMap[i] = rootToVert.get(find(i));
  }

  return { verts, cornerMap, vertCount };
}

// ─── Convenience alias ────────────────���───────────────────────────────────────
export const averageGroupCorners = weldBlockCorners;

// ─── Top-face hull extractor ──────────────────────────────────────────────────

/**
 * Extract the unique top-face poly vertices for a group of blocks after welding.
 */
export function getWeldedTopVerts(blocks, threshold = 0.5) {
  const { verts, cornerMap, vertCount } = weldBlockCorners(blocks, threshold);
  const seen = new Set();
  const result = [];

  for (let b = 0; b < blocks.length; b++) {
    for (let s = 0; s < 4; s++) {
      const vi = cornerMap[b * 8 + s];
      if (seen.has(vi)) continue;
      seen.add(vi);
      result.push({
        x: verts[vi * 3],
        y: verts[vi * 3 + 1],
        z: verts[vi * 3 + 2],
      });
    }
  }
  return result;
}

/**
 * Extract all unique welded verts (top + sides + bottom) as {x,y,z} objects.
 */
export function getAllWeldedVerts(blocks, threshold = 0.5) {
  const { verts, vertCount } = weldBlockCorners(blocks, threshold);
  const result = new Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    result[i] = { x: verts[i * 3], y: verts[i * 3 + 1], z: verts[i * 3 + 2] };
  }
  return result;
}

function getIslandBlocksForMagnetization(island) {
  if (island.blocks && island.blocks.length > 0) return island.blocks;
  if (!island.glbModel) return [];

  const scaleMul = island.glbScaleMul ?? 1.0;
  const wx = island.glbWorldX ?? island.x;
  const wz = island.glbWorldZ ?? island.z;
  const wy = island.glbWorldY ?? (island.y - island.sy);

  return [{
    wx,
    wy,
    wz,
    sx: island.sx,
    sy: island.glbModel.topY * scaleMul,
    sz: island.sz,
    _isGlbIsland: true,
    _island: island,
  }];
}

// ─── Inter-island magnetization ───────────────────────────────────────────────

/**
 * magnetizeIslandEdges
 *
 * Given a list of islands (each with a `blocks` array of world-space blocks),
 * this function finds block corners from DIFFERENT islands whose XZ positions
 * are within `xzRadius` world units of each other, and snaps them to their
 * shared XZ centroid — BUT PRESERVES each corner's original Y value.
 *
 * The result: adjacent island edges "magnetize" together in the horizontal
 * plane, closing gaps so bridges and land connect smoothly, while the height
 * difference between islands is retained for natural ramps and steps.
 *
 * This MUTATES the `wx`/`wz` of each block in-place (not `wy` — height is
 * never touched). The `wx`/`wz` fields are what the renderer reads, so the
 * visual result is immediate.
 *
 * Algorithm:
 *   1. Collect every top-face corner (slots 0–3) from every block in every island.
 *      (Top corners are the walkable surface — these are the ones that matter
 *       for land/bridge connectivity. Bottom corners are pulled along for free
 *       since they move with the block centre.)
 *   2. Sort by XZ.
 *   3. For each corner, find all corners from OTHER islands within xzRadius in XZ.
 *   4. Group them into clusters (Union-Find, XZ-distance only).
 *   5. For each cluster: compute XZ centroid, snap all member corners' blocks'
 *      centres to pull the corner to that centroid — keeping Y intact.
 *   6. The block is an AABB, so we can only move the entire block's centre.
 *      We apply the XZ delta of each corner (relative to its block centre) to
 *      the block centre itself, which shifts the whole block in XZ.
 *      To avoid double-shifting when multiple corners of the same block are
 *      magnetized, we accumulate the largest single delta per block.
 *
 * @param {Array<{ blocks: Array<{wx,wy,wz,sx,sy,sz,...}> }>} islands
 * @param {number} xzRadius   — magnetization pull radius in world units (XZ only)
 */
export function magnetizeIslandEdges(islands, xzRadius = 12.0) {
  if (islands.length < 2) return;

  // Build flat list of edge corners: only top-face corners (slots 0–3)
  // that belong to a block on the OUTER EDGE of its island (we use all top
  // corners; the inner ones will naturally not match anything across islands).
  //
  // Each entry: { wx, wz, origY, islandIdx, blockRef }
  // where origY is the corner's Y (block.wy + block.sy for top corners).
  const edgeCorners = [];

  for (let ii = 0; ii < islands.length; ii++) {
    const island = islands[ii];
    const islandBlocks = getIslandBlocksForMagnetization(island);
    if (!islandBlocks || islandBlocks.length === 0) continue;
    for (const block of islandBlocks) {
      // Skip non-box blocks (shapes without standard half-extents)
      if (block.sx === undefined || block.sy === undefined || block.sz === undefined) continue;
      if (block.shape) continue; // trap/tri prisms use different geometry

      const topY = block.wy + block.sy;
      // Top corners in XZ: NW, NE, SE, SW
      edgeCorners.push({ wx: block.wx - block.sx, wz: block.wz - block.sz, origY: topY, islandIdx: ii, blockRef: block });
      edgeCorners.push({ wx: block.wx + block.sx, wz: block.wz - block.sz, origY: topY, islandIdx: ii, blockRef: block });
      edgeCorners.push({ wx: block.wx + block.sx, wz: block.wz + block.sz, origY: topY, islandIdx: ii, blockRef: block });
      edgeCorners.push({ wx: block.wx - block.sx, wz: block.wz + block.sz, origY: topY, islandIdx: ii, blockRef: block });
    }
  }

  const n = edgeCorners.length;
  if (n < 2) return;

  // Sort by WX for linear sweep
  edgeCorners.sort((a, b) => a.wx - b.wx);

  // Union-Find over corners (XZ distance only, cross-island only)
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  for (let i = 0; i < n; i++) {
    const ci = edgeCorners[i];
    for (let j = i + 1; j < n; j++) {
      const cj = edgeCorners[j];
      if (cj.wx - ci.wx > xzRadius) break; // sorted by wx — early exit
      // Only magnetize across different islands
      if (ci.islandIdx === cj.islandIdx) continue;
      const dz = Math.abs(cj.wz - ci.wz);
      if (dz <= xzRadius) {
        union(i, j);
      }
    }
  }

  // Collect clusters: root → list of corner indices
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }

  // For each cluster with members from ≥2 different islands: compute XZ centroid
  // and apply the shift to each involved block's wx/wz.
  // We accumulate per-block the XZ deltas and apply the one with largest magnitude
  // to avoid fighting between corners of the same block.
  //
  // Key insight: a corner at (block.wx ± block.sx, block.wz ± block.sz) is
  // at a fixed offset from the block centre. Shifting the BLOCK CENTRE by Δ
  // moves ALL corners of the block by Δ — which is what we want (the whole
  // block slides in XZ, keeping its shape and height).

  // blockDelta: WeakMap block → { dx, dz, mag } (largest magnitude shift wins)
  const blockDelta = new Map(); // use block identity

  for (const [, members] of clusters) {
    if (members.length < 2) continue;

    // Check cross-island membership
    const islandSet = new Set(members.map(i => edgeCorners[i].islandIdx));
    if (islandSet.size < 2) continue; // all same island — skip

    // XZ centroid of all corners in this cluster
    let cx = 0, cz = 0;
    for (const i of members) {
      cx += edgeCorners[i].wx;
      cz += edgeCorners[i].wz;
    }
    cx /= members.length;
    cz /= members.length;

    for (const i of members) {
      const ec = edgeCorners[i];
      const block = ec.blockRef;

      // The corner sits at (block.wx + cornerOffX, block.wz + cornerOffZ).
      // cornerOffX = ec.wx - block.wx, etc.
      // To move the corner to (cx, cz) we shift block centre by:
      //   dx = cx - ec.wx
      //   dz = cz - ec.wz
      const dx = cx - ec.wx;
      const dz = cz - ec.wz;
      const mag = dx * dx + dz * dz;

      // Accumulate: keep the shift with the largest magnitude (most significant pull)
      const prev = blockDelta.get(block);
      if (!prev || mag > prev.mag) {
        blockDelta.set(block, { dx, dz, mag });
      }
    }
  }

  // Apply accumulated shifts to block world centres
  // Clamp the shift to at most xzRadius so one bad pair can't drag islands far away.
  const maxShift = xzRadius * 0.5; // conservative: pull at most halfway
  for (const [block, delta] of blockDelta) {
    const clamp = (v) => Math.max(-maxShift, Math.min(maxShift, v));
    const dx = clamp(delta.dx);
    const dz = clamp(delta.dz);

    if (block._isGlbIsland) {
      const island = block._island;
      island.x += dx;
      island.z += dz;
      if (island.glbWorldX !== null && island.glbWorldX !== undefined) island.glbWorldX += dx;
      if (island.glbWorldZ !== null && island.glbWorldZ !== undefined) island.glbWorldZ += dz;
      if (island.moving) {
        island.originX += dx;
        island.originZ += dz;
      }
    } else {
      block.wx += dx;
      block.wz += dz;
    }
  }
}
