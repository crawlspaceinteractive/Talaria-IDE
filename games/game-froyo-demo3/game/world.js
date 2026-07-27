/**
 * world.js — Floating islands generator v3.0 (Voronoi Parent-Child)
 *
 *   PORTAL ISLAND (IslandF) anchors the world as the Voronoi PARENT:
 *     - Massive GLB (IslandF) at centre, scaled 2x normal
 *     - Player spawns here; portal sits on top
 *     - Acts as the single Voronoi site for the centre cell
 *
 *   CHILD ISLANDS seed outward from the parent using a Voronoi/angular
 *   cell partition (one angular sector per child = Voronoi territory):
 *     - Each child "belongs" to the parent if it is the closest site (always
 *       true in a one-parent layout — child cells are simply angular wedges)
 *     - Children are spawned via rejection sampling inside their sector
 *     - Tighter world spread: ring distances cut down considerably
 *     - Carry collectibles, enemies, and breakables
 *     - Biome decorations, moving platforms, wind zones
 *
 *   Output world:
 *     platforms[]   : { x, y, z, sx, sz, color, side, type, blocks? }
 *     spawn         : { x, y, z }
 *     portal        : { x, y, z, target, radius }
 *     crystals[]    : { x, y, z, broken, shatterT }
 *     enemies[]     : { x, y, z, frozen, frozenT, hp, bobPhase }
 *     breakables[]  : { x, y, z, broken, shatterT }
 *     decorations[] : { x, y, z, type, pal, scale }
 *     windZones[]   : { x, z, radius, strength, angle }
 *     voronoiCells  : Array<{ angle, arcHalf, minR, maxR, children:[] }>
 */
import { JUMP_REACH_LUT, PLATFORM_HEIGHT_LUT } from "../engine/luts.js";
import { weldBlockCorners, averageGroupCorners, getWeldedTopVerts, getAllWeldedVerts, magnetizeIslandEdges } from "../tools/meshweld.js";
import { ISLAND_MODELS, PORTAL_ISLAND_MODEL, getPortalIslandModel, isAtlasReady } from "./islandatlas.js";

// Re-export so any importer of world.js can also access the weld helpers.
export { weldBlockCorners, averageGroupCorners, getWeldedTopVerts, getAllWeldedVerts, magnetizeIslandEdges };

// ─── Deterministic PRNG (Mulberry32) ─────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Color palettes ────────────────────────────────────────────────────────
const PALETTES = [
  { top: 0xff5b8d3a, side: 0xff5a3a2a, biome: "grass"      },
  { top: 0xffffffff, side: 0xff4a75c8, biome: "ice"        },
  { top: 0xffd9bf77, side: 0xff5a3a1a, biome: "sand"       },
  { top: 0xffff99ff, side: 0xffb050c0, biome: "bubblegum"  },
  { top: 0xff80e880, side: 0xff2a6a2a, biome: "jungle"     },
  { top: 0xffffb050, side: 0xff9a5a10, biome: "golden"     },
];

const PARENT_TOP  = 0xff3aaa5b;
const PARENT_SIDE = 0xff2a5a3a;

// ─── Scale constant ──────────────────────────────────────────────────────────
const S = 8.0;

// ─── Shape generators ────────────────────────────────────────────────────────
function shapeSlab(rand, pal) {
  const sx = (1.4 + rand() * 1.8) * S;
  const sz = (1.4 + rand() * 1.8) * S;
  const sy = (0.28 + rand() * 0.2) * S;
  return {
    blocks: [{ ox: 0, oy: 0, oz: 0, sx, sy, sz, top: pal.top, side: pal.side }],
    topY: sy, halfW: sx, halfD: sz,
  };
}

function shapePillar(rand, pal) {
  const sx = (0.55 + rand() * 0.5) * S;
  const sz = (0.55 + rand() * 0.5) * S;
  const sy = (0.6 + rand() * 0.7) * S;
  return {
    blocks: [{ ox: 0, oy: 0, oz: 0, sx, sy, sz, top: pal.top, side: pal.side }],
    topY: sy, halfW: sx, halfD: sz,
  };
}

function shapeStepped(rand, pal) {
  const bsx = (1.8 + rand() * 1.2) * S;
  const bsz = (1.8 + rand() * 1.2) * S;
  const bsy = 0.25 * S;
  const tsx = bsx * (0.45 + rand() * 0.2);
  const tsz = bsz * (0.45 + rand() * 0.2);
  const tsy = (0.25 + rand() * 0.2) * S;
  const tOy = bsy + tsy;
  const offX = (rand() - 0.5) * (bsx - tsx) * 0.6;
  const offZ = (rand() - 0.5) * (bsz - tsz) * 0.6;
  return {
    blocks: [
      { ox: 0, oy: 0, oz: 0, sx: bsx, sy: bsy, sz: bsz, top: pal.side, side: pal.side },
      { ox: offX, oy: tOy, oz: offZ, sx: tsx, sy: tsy, sz: tsz, top: pal.top, side: pal.side },
    ],
    topY: tOy + tsy, halfW: bsx, halfD: bsz,
  };
}

function shapeLShape(rand, pal) {
  const sy = (0.3 + rand() * 0.2) * S;
  const armA_sx = (1.0 + rand() * 0.8) * S;
  const armA_sz = (0.5 + rand() * 0.4) * S;
  const armB_sx = (0.5 + rand() * 0.4) * S;
  const armB_sz = (1.0 + rand() * 0.8) * S;
  const ox = armA_sx;
  const oz = -armB_sz;
  return {
    blocks: [
      { ox: 0,  oy: 0, oz: 0,  sx: armA_sx, sy, sz: armA_sz, top: pal.top, side: pal.side },
      { ox: ox, oy: 0, oz: oz, sx: armB_sx, sy, sz: armB_sz, top: pal.top, side: pal.side },
    ],
    topY: sy, halfW: armA_sx + armB_sx, halfD: armA_sz + armB_sz,
  };
}

function shapeLedgeStack(rand, pal) {
  const n = 2 + (rand() < 0.4 ? 1 : 0);
  const blocks = [];
  let maxW = 0, maxD = 0, highestTop = 0;
  for (let i = 0; i < n; i++) {
    const sx = (0.7 + rand() * 0.9) * S;
    const sz = (0.7 + rand() * 0.9) * S;
    const sy = (0.18 + rand() * 0.12) * S;
    const ox = (rand() - 0.5) * 1.5 * S * i;
    const oz = (rand() - 0.5) * 1.5 * S * i;
    const oy = i * (0.35 + rand() * 0.2) * S;
    blocks.push({ ox, oy, oz, sx, sy, sz, top: pal.top, side: pal.side });
    maxW = Math.max(maxW, Math.abs(ox) + sx);
    maxD = Math.max(maxD, Math.abs(oz) + sz);
    highestTop = Math.max(highestTop, oy + sy);
  }
  return { blocks, topY: highestTop, halfW: maxW, halfD: maxD };
}

function shapeColumnPair(rand, pal) {
  const sx = (0.4 + rand() * 0.3) * S;
  const sz = (0.4 + rand() * 0.3) * S;
  const sy = (0.55 + rand() * 0.55) * S;
  const gap = (0.9 + rand() * 0.7) * S;
  return {
    blocks: [
      { ox: -gap, oy: 0, oz: 0, sx, sy, sz, top: pal.top, side: pal.side },
      { ox:  gap, oy: 0, oz: 0, sx, sy, sz, top: pal.top, side: pal.side },
    ],
    topY: sy, halfW: gap + sx, halfD: sz,
  };
}

function shapeTrapezoid(rand, pal) {
  const sx = (1.2 + rand() * 1.6) * S;
  const sz = (1.2 + rand() * 1.6) * S;
  const sy = (0.3 + rand() * 0.35) * S;
  const topScale = 0.35 + rand() * 0.40;
  const yaw = (rand() * 360) | 0;
  return {
    blocks: [{ ox: 0, oy: 0, oz: 0, sx, sy, sz, topScale, yaw, shape: "trap", top: pal.top, side: pal.side }],
    topY: sy * 2, halfW: sx, halfD: sz,
  };
}

function shapeTriPrism(rand, pal) {
  const r = (1.0 + rand() * 1.6) * S;
  const sy = (0.22 + rand() * 0.28) * S;
  const yaw = (rand() * 360) | 0;
  return {
    blocks: [{
      ox: 0, oy: 0, oz: 0, r, sy, yaw, shape: "tri",
      top: pal.top, side: pal.side, sx: r * 0.87, sz: r * 0.87,
    }],
    topY: sy * 2, halfW: r * 0.87, halfD: r * 0.87,
  };
}

function shapeCrescent(rand, pal) {
  const sy = (0.25 + rand() * 0.2) * S;
  const wing = (0.8 + rand() * 0.6) * S;
  const armH = (0.8 + rand() * 0.5) * S;
  const gap  = (0.3 + rand() * 0.3) * S;
  return {
    blocks: [
      { ox: -(wing + gap), oy: 0, oz: 0, sx: wing, sy, sz: (0.6 + rand() * 0.4) * S, top: pal.top, side: pal.side },
      { ox:  (wing + gap), oy: 0, oz: 0, sx: wing, sy, sz: (0.6 + rand() * 0.4) * S, top: pal.top, side: pal.side },
      { ox: 0, oy: 0, oz: armH, sx: wing * 0.5, sy, sz: (0.5 + rand() * 0.3) * S,   top: pal.top, side: pal.side },
    ],
    topY: sy, halfW: wing * 2 + gap, halfD: armH + S,
  };
}

function shapeCross(rand, pal) {
  const sy = (0.22 + rand() * 0.18) * S;
  const hub = (0.5 + rand() * 0.3) * S;
  const arm = (1.0 + rand() * 0.8) * S;
  const aw  = (0.3 + rand() * 0.2) * S;
  return {
    blocks: [
      { ox: 0, oy: 0, oz: 0,    sx: hub, sy, sz: hub,  top: pal.top, side: pal.side },
      { ox: 0, oy: 0, oz: -arm, sx: aw,  sy, sz: arm,  top: pal.top, side: pal.side },
      { ox: 0, oy: 0, oz:  arm, sx: aw,  sy, sz: arm,  top: pal.top, side: pal.side },
      { ox:-arm,oy: 0, oz: 0,   sx: arm, sy, sz: aw,   top: pal.top, side: pal.side },
      { ox: arm,oy: 0, oz: 0,   sx: arm, sy, sz: aw,   top: pal.top, side: pal.side },
    ],
    topY: sy, halfW: hub + arm, halfD: hub + arm,
  };
}

// ── GLB child-island shape builder (uses non-portal models) ──────────────────
function shapeGLBModel(rand, pal, usedModels) {
  if (!isAtlasReady() || ISLAND_MODELS.length === 0) {
    return shapeSlab(rand, pal);
  }
  let model;
  let attempts = 0;
  do {
    model = ISLAND_MODELS[(rand() * ISLAND_MODELS.length) | 0];
    attempts++;
  } while (usedModels && usedModels.has(model) && attempts < 8);

  if (usedModels) {
    usedModels.add(model);
    if (usedModels.size > Math.max(2, (ISLAND_MODELS.length >> 1))) {
      const arr = Array.from(usedModels);
      usedModels.clear();
      for (let k = arr.length >> 1; k < arr.length; k++) usedModels.add(arr[k]);
    }
  }

  return {
    blocks: [],
    topY:   model.topY,
    halfW:  model.halfW,
    halfD:  model.halfD,
    glbModel: model,
  };
}

const SHAPE_BUILDERS = [
  shapeGLBModel, shapeGLBModel, shapeGLBModel,
  shapeGLBModel, shapeGLBModel, shapeGLBModel,
  shapeSlab, shapeSlab,
  shapePillar,
  shapeStepped,
  shapeLShape,
  shapeLedgeStack,
  shapeTrapezoid, shapeTrapezoid,
  shapeCrescent,
  shapeCross,
];

// ─── Portal island (IslandF) builder ─────────────────────────────────────────
// Returns a platform record using the dedicated portal GLB model at 2x scale.
// Falls back to a large procedural tiered island if atlas not yet loaded.
function buildPortalIsland() {
  const _portalModel = getPortalIslandModel();
  if (isAtlasReady() && _portalModel) {
    const model = _portalModel;
    // Portal island uses 2× the normal TARGET_HALF scale for a massive presence
    const PORTAL_SCALE_MUL = 2.0;
    const scaledHalfW = model.halfW * PORTAL_SCALE_MUL;
    const scaledHalfD = model.halfD * PORTAL_SCALE_MUL;
    const scaledTopY  = model.topY  * PORTAL_SCALE_MUL;

    return {
      x: 0, y: scaledTopY, z: 0,
      sx: scaledHalfW, sz: scaledHalfD,
      sy: scaledTopY,
      color: PARENT_TOP, side: PARENT_SIDE,
      type: "parent",
      blocks: [],
      topY: scaledTopY,
      portalY: scaledTopY,
      // Carry the GLB model reference with overridden scale
      glbModel: model,
      glbName: model.id || null,
      glbWorldX: 0,
      glbWorldY: 0,
      glbWorldZ: 0,
      glbScaleMul: PORTAL_SCALE_MUL,  // renderer reads this to apply 2x
      isPortalIsland: true,
    };
  }

  // Fallback: procedural tiered island
  const baseW = 5.5 * S, baseD = 5.5 * S, baseH = 0.5 * S;
  const midW  = 3.2 * S, midD  = 3.2 * S, midH  = 0.35 * S;
  const midCY = baseH + midH;
  const topW  = 1.8 * S, topD  = 1.8 * S, topH  = 0.3 * S;
  const topCY = baseH + midH * 2 + topH;

  const blocks = [
    { ox: 0, oy: 0,     oz: 0, sx: baseW, sy: baseH, sz: baseD, top: PARENT_TOP,  side: PARENT_SIDE },
    { ox: 0, oy: midCY, oz: 0, sx: midW,  sy: midH,  sz: midD,  top: 0xff4a8a3a, side: PARENT_SIDE },
    { ox: 0, oy: topCY, oz: 0, sx: topW,  sy: topH,  sz: topD,  top: PARENT_TOP,  side: PARENT_SIDE },
  ];

  return {
    x: 0, y: baseH, z: 0,
    sx: baseW, sz: baseD,
    sy: baseH,
    color: PARENT_TOP, side: PARENT_SIDE,
    type: "parent",
    blocks: blocks.map(b => ({ ...b, wx: b.ox, wy: b.oy, wz: b.oz })),
    topY: baseH,
    portalY: topCY + topH,
    isPortalIsland: true,
  };
}

// ─── Bridge generator ────────────────────────────────────────────────────────
const BRIDGE_MAX_GAP   = 10 * S;
const BRIDGE_MAX_YDIFF =  3 * S;
const BRIDGE_MIN_GAP   =  3 * S;

function buildBridge(rand, x0, y0, z0, x1, y1, z1, pal) {
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.1) return [];

  const plankW = (0.55 + rand() * 0.2) * S;
  const plankH = (0.08 + rand() * 0.04) * S;
  const plankL = (0.45 + rand() * 0.15) * S;
  const spacing = plankL * 1.6;
  const count = Math.max(1, Math.round(dist / spacing));
  const nx = dx / dist, nz = dz / dist;
  const px = -nz, pz = nx;
  const yMid = (y0 + y1) * 0.5 - plankH;

  const planks = [];
  for (let i = 0; i <= count; i++) {
    const t = count === 0 ? 0.5 : i / count;
    const wx = x0 + dx * t, wz = z0 + dz * t;
    const arc = Math.sin(t * Math.PI) * 0.6 * S;
    const wy = yMid - arc;
    const hx = Math.abs(nx * plankL) + Math.abs(px * plankW);
    const hz = Math.abs(nz * plankL) + Math.abs(pz * plankW);
    planks.push({
      x: wx, y: wy + plankH, z: wz,
      sx: Math.max(hx, 0.4 * S),
      sz: Math.max(hz, 0.4 * S),
      color: pal.top, side: pal.side, biome: pal.biome, type: "bridge",
      blocks: [{
        wx, wy, wz,
        sx: Math.max(hx, 0.4 * S), sy: plankH, sz: Math.max(hz, 0.4 * S),
        top: pal.top, side: pal.side,
        _axisNX: nx, _axisNZ: nz, _plankL: plankL, _plankW: plankW,
      }],
    });
  }
  return planks;
}

// ─── Biome decorations ────────────────────────────────────────────────────────
function placeDecorations(rand, biome, ix, iy, iz, walkY, halfW, halfD, count, parentIslandIndex) {
  const decors = [];
  for (let k = 0; k < count; k++) {
    const ox = (rand() - 0.5) * halfW * 1.5;
    const oz = (rand() - 0.5) * halfD * 1.5;
    let type;
    switch (biome) {
      case "grass":     type = rand() < 0.6 ? "tree"     : "gemstone"; break;
      case "ice":       type = rand() < 0.7 ? "spire"    : "gemstone"; break;
      case "sand":      type = rand() < 0.6 ? "cactus"   : "gemstone"; break;
      case "bubblegum": type = rand() < 0.6 ? "mushroom" : "lantern";  break;
      case "jungle":    type = rand() < 0.5 ? "pine"     : "tree";     break;
      case "golden":    type = rand() < 0.5 ? "lantern"  : "gemstone"; break;
      default:          type = "gemstone";
    }
    const scale = 0.7 + rand() * 0.6;
    decors.push({
      x: ix + ox, y: walkY, z: iz + oz,
      type, biome, scale,
      localOffsetX: ox,
      localOffsetZ: oz,
      parentIslandIndex,
    });
  }
  return decors;
}

// ─── Decoration island magnetization helpers ─────────────────────────────────
function getDecorationPositionOnIsland(decoration, island) {
  const ix = island.glbWorldX ?? island.x;
  const iz = island.glbWorldZ ?? island.z;
  return {
    x: ix + decoration.localOffsetX,
    z: iz + decoration.localOffsetZ,
  };
}

function findNearestIslandForDecoration(decoration, islands, maxRadius = 40) {
  const xCandidates = [];
  for (const island of islands) {
    const ix = island.glbWorldX ?? island.x;
    if (Math.abs(decoration.x - ix) <= maxRadius) xCandidates.push(island);
  }
  let nearest = null;
  let bestDist = Infinity;
  for (const island of xCandidates) {
    const iz = island.glbWorldZ ?? island.z;
    const dx = decoration.x - (island.glbWorldX ?? island.x);
    const dz = decoration.z - iz;
    if (Math.abs(dz) > maxRadius) continue;
    const dist2 = dx * dx + dz * dz;
    if (dist2 < bestDist) {
      bestDist = dist2;
      nearest = island;
    }
  }
  return bestDist <= maxRadius * maxRadius ? nearest : null;
}

function magnetizeDecorationsToIslands(decorations, islands) {
  const kept = [];
  for (const d of decorations) {
    let island = islands.find(p => p._childIndex === d.parentIslandIndex);
    if (island) {
      const { x: px, z: pz } = getDecorationPositionOnIsland(d, island);
      const dx = d.x - px;
      const dz = d.z - pz;
      if (Math.sqrt(dx * dx + dz * dz) > 40) {
        island = null;
      }
    }
    if (!island) {
      island = findNearestIslandForDecoration(d, islands, 40);
    }
    if (!island) continue;
    d.parentIslandIndex = island._childIndex;
    const pos = getDecorationPositionOnIsland(d, island);
    d.x = pos.x;
    d.z = pos.z;
    kept.push(d);
  }
  decorations.length = 0;
  decorations.push(...kept);
}

// ─── Moving platform builder ──────────────────────────────────────────────────
function assignMoving(rand, platform) {
  platform.moving    = true;
  platform.moveAxis  = rand() < 0.5 ? "x" : "z";
  platform.moveAmp   = (2.0 + rand() * 4.0) * S;
  platform.moveSpeed = 0.012 + rand() * 0.018;
  platform.movePhase = rand() * Math.PI * 2;
  platform.originX   = platform.x;
  platform.originZ   = platform.z;
  for (const b of platform.blocks) {
    b._originWx = b.wx;
    b._originWz = b.wz;
  }
}

// ─── Wind zone builder ────────────────────────────────────────────────────────
function buildWindZones(rand, islandCentres) {
  const zones = [];
  for (let i = 0; i < islandCentres.length; i += 3) {
    const ic   = islandCentres[i];
    const next = islandCentres[(i + 1) % islandCentres.length];
    const mx   = (ic.x + next.x) * 0.5;
    const mz   = (ic.z + next.z) * 0.5;
    const dx   = next.x - ic.x, dz = next.z - ic.z;
    const angle = Math.atan2(dx, dz);
    zones.push({
      x: mx, z: mz,
      radius:   (3.0 + rand() * 3.0) * S,
      strength: 0.018 + rand() * 0.022,
      angle,
    });
  }
  return zones;
}

// ─── Voronoi helper — Euclidean distance (squared for perf) ──────────────────
// In this single-parent layout, every child is always "owned" by the one portal
// site. We use angular Voronoi sectors as territory boundaries.

/**
 * Partition [0, 2π) into `n` equal angular cells, each slightly jittered.
 * Returns array of { angle (cell centre), arcHalf, minR, maxR }.
 */
function buildVoronoiSectors(rand, n, innerR, outerR) {
  const sectors = [];
  const baseStep = (Math.PI * 2) / n;
  const baseOffset = rand() * Math.PI * 2;
  for (let i = 2; i < n; i++) {
    const angle   = baseOffset + baseStep * i + (rand() - 0.5) * baseStep * 0.35;
    const arcHalf = baseStep * 0.5 * (0.85 + rand() * 0.15);
    const minR    = innerR * (0.75 + rand() * 0.25);
    const maxR    = outerR * (0.85 + rand() * 0.15);
    sectors.push({ angle, arcHalf, minR, maxR, children: [] });
  }
  return sectors;
}

/**
 * Rejection-sample a point (ix, iz) that lies within a given angular sector
 * and is not overlapping already-placed islands.
 *
 * Formula:
 *   r = minR + rand() * (maxR - minR)
 *   θ = sectorAngle + (rand()*2-1) * arcHalf
 *   ix = cos(θ) * r, iz = sin(θ) * r
 *   Accept if getClosestParent({x:0,z:0}, point) == this parent (always true
 *   in single-parent layout) AND no overlap.
 */
function sampleInSector(rand, sector, placedIslands, estHW, estHD, maxTries) {
  const { angle, arcHalf, minR, maxR } = sector;
  for (let t = 0; t < maxTries; t++) {
    const r   = minR + rand() * (maxR - minR);
    const th  = angle + (rand() * 2 - 1) * arcHalf;
    const ix  = Math.cos(th) * r;
    const iz  = Math.sin(th) * r;
    if (!_islandOverlaps(placedIslands, ix, iz, estHW, estHD)) {
      return { ix, iz };
    }
    // Expand radius slightly and retry
    sector.minR = Math.min(sector.minR * 2.05, maxR);
  }
  // Fallback — use sector centre at midR
  const r  = (minR + maxR) * 0.5;
  const ix = Math.cos(angle) * r;
  const iz = Math.sin(angle) * r;
  return { ix, iz };
}

function _islandOverlaps(placedIslands, cx, cz, hw, hd) {
  const MIN_SEP = 10.0;
  for (const placed of placedIslands) {
    const dx = Math.abs(cx - placed.cx);
    const dz = Math.abs(cz - placed.cz);
    if (dx < hw + placed.hw + MIN_SEP && dz < hd + placed.hd + MIN_SEP) return true;
  }
  return false;
}

// ─── Main generator ──────────────────────────────────────────────────────────

export function generateWorld(seed = 1337) {
  const rand = mulberry32(seed);
  const platforms   = [];
  const crystals    = [];
  const enemies     = [];
  const breakables  = [];
  const decorations = [];

  // ── Portal Island (IslandF) — the Voronoi parent ────────────────────────
  const portalIsland = buildPortalIsland();
  // Player spawns on top of the portal island
  const spawn = { x: 0, y: portalIsland.topY + 1.0, z: 0 };

  platforms.push(portalIsland);

  // Portal sits elevated above the portal island surface
  const portal = {
    x: 0,
    y: portalIsland.portalY + 0.6 * S,
    z: 0,
    target: { ...spawn },
    radius: 1.0 * S,
  };

  // Register the portal island footprint so children don't overlap it
  const placedIslands = [{ cx: 0, cz: 0, hw: portalIsland.sx, hd: portalIsland.sz }];
  const usedGLBModels = new Set();

  // ── Voronoi sectors ─────────────────────────────────────────────────────
  // Two concentric rings of sectors (scaled DOWN from old layout).
  // Inner ring: 6 sectors, dist 3–5.5×S
  // Outer ring: 5 sectors, dist 6–9×S
  const INNER_COUNT  = 1 + ((rand() * 2) | 0);  // 5–6
  const OUTER_COUNT  = 20 + ((rand() * 2) | 0);  // 4–5

  const innerSectors = buildVoronoiSectors(rand, INNER_COUNT, 3.0 * S, 5.5 * S);
  const outerSectors = buildVoronoiSectors(rand, OUTER_COUNT, 6.0 * S, 9.0 * S);

  const allSectors  = [...innerSectors, ...outerSectors];
  const islandCentres = [];
  const deferredBlockCollision = [];

  let islandIndex = 0;

  for (const sector of allSectors) {
    const isOuter = outerSectors.includes(sector);

    // Sample position within this Voronoi cell
    const { ix, iz } = sampleInSector(rand, sector, placedIslands, 22, 22, 6);

    const heightIdx = 1 + ((rand() * 7) | 0);
    const iy = PLATFORM_HEIGHT_LUT[Math.min(heightIdx, PLATFORM_HEIGHT_LUT.length - 1)];

    const pal  = PALETTES[islandIndex % PALETTES.length];
    const shapeBuilder = SHAPE_BUILDERS[(rand() * SHAPE_BUILDERS.length) | 0];
    const shape = shapeBuilder(rand, pal, usedGLBModels);

    const worldBlocks = shape.blocks.map(b => ({
      ...b, biome: pal.biome, wx: ix + b.ox, wy: iy + b.oy, wz: iz + b.oz,
    }));

    const walkY   = iy + shape.topY;
    const sy_phys = shape.topY;

    const WELD_THRESH = 0.4;
    const weldableBlocks = worldBlocks.filter(b =>
      b.sx !== undefined && b.sy !== undefined && b.sz !== undefined && !b.shape
    );
    const weldResult = weldableBlocks.length >= 2
      ? averageGroupCorners(weldableBlocks, WELD_THRESH)
      : null;

    // Only outer-ring block islands get moving platforms
    const isMoving = !shape.glbModel && isOuter && islandIndex % 4 === 2;

    const plat = {
      x: ix, y: walkY, z: iz,
      sx: shape.halfW, sz: shape.halfD,
      sy: sy_phys,
      color: pal.top, side: pal.side,
      type: "island",
      blocks: worldBlocks,
      weld: weldResult,
      biome: pal.biome,
      glbModel:  shape.glbModel  ?? null,
      glbName:   shape.glbModel  ? shape.glbModel.id : null,
      glbWorldX: shape.glbModel  ? ix : null,
      glbWorldY: shape.glbModel  ? iy : null,
      glbWorldZ: shape.glbModel  ? iz : null,
      _childIndex: islandIndex,
      // Voronoi metadata
      voronoiSector: sector,
    };

    if (isMoving) assignMoving(rand, plat);

    platforms.push(plat);
    placedIslands.push({ cx: ix, cz: iz, hw: shape.halfW, hd: shape.halfD });
    sector.children.push(plat);

    if (!shape.glbModel && worldBlocks.length > 1) {
      deferredBlockCollision.push(worldBlocks);
    }

    // ── Populate ────────────────────────────────────────────────────────
    if (islandIndex % 2 === 0) {
      const count = 1 + ((rand() * 2) | 0);
      for (let k = 0; k < count; k++) {
        const ox = (rand() - 0.5) * shape.halfW * 1.4;
        const oz = (rand() - 0.5) * shape.halfD * 1.4;
        crystals.push({
          x: ix + ox, y: walkY + 0.65 * S, z: iz + oz,
          broken: false, shatterT: 0,
        });
      }
    }

    if (isOuter && islandIndex % 3 === 2) {
      enemies.push({
        x: ix + (rand() - 0.5) * 0.5 * S,
        y: walkY + 0.5 * S,
        z: iz + (rand() - 0.5) * 0.5 * S,
        frozen: false, frozenT: 0, hp: 2,
        bobPhase: rand() * 6.28,
        boss: false,
        hitRadius: 2.0,
      });
    }

    if (isOuter && rand() < 0.45) {
      breakables.push({
        x: ix + (rand() - 0.5) * shape.halfW * 0.9,
        y: walkY + 0.4 * S,
        z: iz + (rand() - 0.5) * shape.halfD * 0.9,
        broken: false, shatterT: 0,
      });
    }

    const decorCount = 1 + ((rand() * 2) | 0);
    const newDecors = placeDecorations(rand, pal.biome, ix, iy, iz, walkY, shape.halfW, shape.halfD, decorCount, islandIndex);
    for (const d of newDecors) decorations.push(d);

    islandCentres.push({ x: ix, y: walkY, z: iz, pal, halfW: shape.halfW, halfD: shape.halfD });
    islandIndex++;
  }

  // ── Magnetization pass ─────────────────────────────────────────────────
  {
    const childIslands = platforms.filter(p => p.type === "island" && ((p.blocks && p.blocks.length > 0) || p.glbModel));
    const MAG_RADIUS = 6 * 8;
    magnetizeIslandEdges(childIslands, MAG_RADIUS);

    for (const p of childIslands) {
      if (p.glbModel && p.glbWorldX !== null && p.glbWorldX !== undefined) {
        p.x = p.glbWorldX;
        p.z = p.glbWorldZ;
      }

      if (!p.blocks || p.blocks.length === 0) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const b of p.blocks) {
        if (b.sx === undefined) continue;
        minX = Math.min(minX, b.wx - b.sx);
        maxX = Math.max(maxX, b.wx + b.sx);
        minZ = Math.min(minZ, b.wz - b.sz);
        maxZ = Math.max(maxZ, b.wz + b.sz);
      }
      if (minX < Infinity) {
        p.x = (minX + maxX) * 3.5;
        p.z = (minZ + maxZ) * 3.5;
        p.sx = (maxX - minX) * 3.5;
        p.sz = (maxZ - minZ) * 3.5;
      }
      if (p.moving) {
        p.originX = p.x;
        p.originZ = p.z;
      }
    }

    for (let i = 0; i < islandCentres.length && i < childIslands.length; i++) {
      islandCentres[i].x = childIslands[i].x;
      islandCentres[i].z = childIslands[i].z;
    }

    for (const worldBlocks of deferredBlockCollision) {
      for (const b of worldBlocks) {
        if (b.sx === undefined || b.sy === undefined) continue;
        platforms.push({
          x: b.wx, y: b.wy + b.sy, z: b.wz,
          sx: b.sx, sz: b.sz, sy: b.sy,
          color: b.top, side: b.side,
          biome: b.biome || null,
          type: "island_block", blocks: [],
        });
      }
    }

    magnetizeDecorationsToIslands(decorations, childIslands);
  }

  // ── Bridge pass ────────────────────────────────────────────────────────
  const bridgedPairs = new Set();
  for (let a = 0; a < islandCentres.length; a++) {
    for (let b = a + 1; b < islandCentres.length; b++) {
      const ia = islandCentres[a];
      const ib = islandCentres[b];
      const dx = ib.x - ia.x, dz = ib.z - ia.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const yDiff = Math.abs(ia.y - ib.y);
      if (dist < BRIDGE_MIN_GAP || dist > BRIDGE_MAX_GAP || yDiff > BRIDGE_MAX_YDIFF) continue;
      const key = `${a}-${b}`;
      if (bridgedPairs.has(key)) continue;
      bridgedPairs.add(key);

      const BRIDGE_PALS = [
        { top: 0xffa0785a, side: 0xff5a3a22 },
        { top: 0xffb08060, side: 0xff6a4a2a },
        { top: 0xff9090a0, side: 0xff505060 },
      ];
      const bridgePal = BRIDGE_PALS[(rand() * BRIDGE_PALS.length) | 0];
      const nx = dx / dist, nz = dz / dist;
      const supportA = Math.min(Math.abs(nx * ia.halfW) + Math.abs(nz * ia.halfD), dist * 0.5);
      const supportB = Math.min(Math.abs(nx * ib.halfW) + Math.abs(nz * ib.halfD), dist * 0.5);
      const planks = buildBridge(
        rand,
        ia.x + nx * supportA, ia.y, ia.z + nz * supportA,
        ib.x - nx * supportB, ib.y, ib.z - nz * supportB,
        bridgePal
      );
      for (const plank of planks) platforms.push(plank);
    }
  }

  // ── Boss spawn — farthest island ─────────────────────────────────────────
  if (islandCentres.length > 0) {
    let bossIdx = 0, bossDistSq = 0;
    for (let i = 0; i < islandCentres.length; i++) {
      const ic = islandCentres[i];
      const dsq = ic.x * ic.x + ic.z * ic.z;
      if (dsq > bossDistSq) { bossDistSq = dsq; bossIdx = i; }
    }
    const bic = islandCentres[bossIdx];
    enemies.push({
      x: bic.x, y: bic.y + 1.0 * S, z: bic.z,
      frozen: false, frozenT: 0,
      hp: 6, bobPhase: 0, boss: true, hitRadius: 5.5,
    });
  }

  // ── Wind zones ─────────────────────────────────────────────────────────
  const windZones = buildWindZones(rand, islandCentres);

  return {
    spawn, platforms, crystals, enemies, breakables, portal,
    decorations, windZones,
    voronoiCells: allSectors,
  };
}

// ── Step moving platforms each frame ─────────────────────────────────────────
export function stepMovingPlatforms(world, frame) {
  const deltas = [];
  for (const p of world.platforms) {
    if (!p.moving) continue;
    const tNow = Math.sin(p.movePhase + frame * p.moveSpeed);

    const prevX = p.x, prevZ = p.z;

    if (p.moveAxis === "x") {
      p.x   = p.originX + tNow * p.moveAmp;
      p.dvx = p.x - prevX;
      p.dvz = 0;
    } else {
      p.z   = p.originZ + tNow * p.moveAmp;
      p.dvx = 0;
      p.dvz = p.z - prevZ;
    }

    for (const b of p.blocks) {
      if (b._originWx !== undefined) {
        if (p.moveAxis === "x") b.wx = b._originWx + tNow * p.moveAmp;
        else                    b.wz = b._originWz + tNow * p.moveAmp;
      }
    }

    deltas.push(p);
  }
  return deltas;
}
