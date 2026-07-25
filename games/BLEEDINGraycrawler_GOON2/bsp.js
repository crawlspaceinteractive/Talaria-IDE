// ---------------------------------------------------------------------------
// bsp.js — Binary Space Partitioning for non-grid wall geometry
// ---------------------------------------------------------------------------
//
// Coordinate system matches the rest of the engine:
//   +X = east, +Y = south, Z = up (not used in 2D BSP)
//   World units = grid tiles (1 unit = one grid cell width)
//
// All BSP math is float — this runs once at map load, not per frame.
//
// Public API:
//   buildBSP(segs, sectors)  → BSPNode (root of tree)
//   classifyPoint(node, x, y) → 'front' | 'back' | 'on'
//   traverseFrontToBack(node, x, y, callback)
//
// Seg format (input):
//   { x1, y1, x2, y2, frontSector, backSector, texId, flags }
//   frontSector / backSector: index into sectors[], or -1 for void
//   flags: bitmask — SEG_FLAG_TWO_SIDED, SEG_FLAG_SECRET, etc.
//
// Sector format (input):
//   { floorH, ceilH, floorTex, ceilTex, lightLevel }
//
// BSPNode:
//   { partition, front, back, bbox }
//   partition: the Seg used as the splitting plane for this node
//   front/back: BSPNode | BSPLeaf
//
// BSPLeaf:
//   { isLeaf: true, segs[], sector, bbox }
//   segs: all Segs that belong to this convex subspace
//   sector: index of the sector this leaf is in (-1 if void)
// ---------------------------------------------------------------------------

// ── Seg flags ────────────────────────────────────────────────────────────────
export const SEG_FLAG_TWO_SIDED  = 1 << 0;  // portal between two sectors
export const SEG_FLAG_SECRET     = 1 << 1;  // secret door
export const SEG_FLAG_INVISIBLE  = 1 << 2;  // no-draw (used for blockmap only)
export const SEG_FLAG_TOGGLEABLE = 1 << 3;  // secret wall or gem door face — has .toggleRef

// ── Epsilon for floating-point comparisons ───────���──────────────────────���────
const EPSILON = 1e-6;

// ── Classification results ���──────────��────────────────────────────────────────
export const SIDE_FRONT = 0;
export const SIDE_BACK  = 1;
export const SIDE_ON    = 2;
export const SIDE_SPLIT = 3;


// ---------------------------------------------------------------------------
// Seg helpers
// ---------------------------------------------------------------------------

/**
 * Create a new Seg.  All fields explicit — no defaults — so callers are clear.
 *
 * Optional extra fields (set after construction for the enriched wall system):
 *   wallTileX / wallTileY  — integer grid cell of the solid wall behind this face.
 *                            Used by the renderer to skip the seg if the tile has
 *                            been opened (secret wall / gem door carve).
 *   toggleRef              — reference to a toggleable object (for SEG_FLAG_TOGGLEABLE).
 *                            The renderer reads .opened, .type, .color, .treasure.
 */
export function makeSeg(x1, y1, x2, y2, frontSector, backSector, texId, flags = 0) {
  return { x1, y1, x2, y2, frontSector, backSector, texId, flags,
           wallTileX: -1, wallTileY: -1, toggleRef: null };
}

/**
 * Compute the outward-facing normal of a seg (points toward the front sector).
 * In a right-hand 2D system with +Y down (screen coords), the left-hand normal
 * of the directed seg (x1,y1)→(x2,y2) points to the front.
 */
export function segNormal(seg) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPSILON) return { nx: 0, ny: 0 };
  // Left-hand normal: (-dy, dx) normalised
  return { nx: -dy / len, ny: dx / len };
}

/**
 * Return the signed distance from point (px, py) to the infinite line
 * defined by the seg.  Positive = front side, negative = back side.
 */
function _signedDist(seg, px, py) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  // Plane equation: (-dy)(x - x1) + (dx)(y - y1) = 0
  return -dy * (px - seg.x1) + dx * (py - seg.y1);
}

/**
 * Classify a single point relative to the seg's splitting plane.
 * Returns SIDE_FRONT, SIDE_BACK, or SIDE_ON.
 */
export function classifyPoint(seg, px, py) {
  const d = _signedDist(seg, px, py);
  if (d >  EPSILON) return SIDE_FRONT;
  if (d < -EPSILON) return SIDE_BACK;
  return SIDE_ON;
}

/**
 * Classify an entire seg relative to a splitting plane seg.
 * Returns SIDE_FRONT, SIDE_BACK, SIDE_ON, or SIDE_SPLIT.
 */
function _classifySeg(plane, seg) {
  const d1 = _signedDist(plane, seg.x1, seg.y1);
  const d2 = _signedDist(plane, seg.x2, seg.y2);

  const front1 = d1 >  EPSILON;
  const back1  = d1 < -EPSILON;
  const front2 = d2 >  EPSILON;
  const back2  = d2 < -EPSILON;

  if (front1 && front2) return SIDE_FRONT;
  if (back1  && back2 ) return SIDE_BACK;
  if (!back1 && !back2) return SIDE_ON;   // both on plane
  return SIDE_SPLIT;
}

/**
 * Split a seg by a splitting plane.  Returns { front, back } — two new segs
 * sharing the intersection point.  The intersection is computed via parametric
 * line-line intersection.
 *
 * front: the portion on the front side of the plane
 * back:  the portion on the back side
 */
function _splitSeg(plane, seg) {
  const d1 = _signedDist(plane, seg.x1, seg.y1);
  const d2 = _signedDist(plane, seg.x2, seg.y2);

  // Parametric t along seg where it crosses the plane
  const t = d1 / (d1 - d2);
  const ix = seg.x1 + t * (seg.x2 - seg.x1);
  const iy = seg.y1 + t * (seg.y2 - seg.y1);

  const front = makeSeg(seg.x1, seg.y1, ix, iy, seg.frontSector, seg.backSector, seg.texId, seg.flags);
  const back  = makeSeg(ix, iy, seg.x2, seg.y2, seg.frontSector, seg.backSector, seg.texId, seg.flags);

  // Propagate enriched wall-system fields to both halves
  front.wallTileX = seg.wallTileX;  front.wallTileY = seg.wallTileY;  front.toggleRef = seg.toggleRef;
  back.wallTileX  = seg.wallTileX;  back.wallTileY  = seg.wallTileY;  back.toggleRef  = seg.toggleRef;

  // d1 > 0 means x1 is on the front side
  if (d1 > 0) {
    return { front, back };
  } else {
    return { front: back, back: front };
  }
}


// ---------------------------------------------------------------------------
// Partition selection
// ---------------------------------------------------------------------------

/**
 * Pick the best seg from `segs` to use as the splitting plane for this node.
 *
 * Strategy: minimise a cost function balancing:
 *   - Number of splits caused (expensive — creates new segs)
 *   - Imbalance between front and back child counts
 *
 * Weight constants chosen to match Doom's BSP builder heuristic.
 * SPLIT_COST > BALANCE_COST because splits increase total seg count.
 */
const SPLIT_COST   = 8;
const BALANCE_COST = 1;

// Maximum number of candidate segs to evaluate as splitters.
// A random sample of this size gives near-optimal results for typical dungeon
// maps while reducing O(n²) splitter selection to O(n) per node.
const MAX_SPLITTER_CANDIDATES = 32;

function _chooseSplitter(segs) {
  let bestSeg   = null;
  let bestScore = Infinity;

  // For large seg counts, sample a random subset to keep BSP build O(n log n).
  // Fisher-Yates partial shuffle into a candidate index array.
  const n = segs.length;
  const sampleSize = Math.min(n, MAX_SPLITTER_CANDIDATES);
  const indices = new Int32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;
  for (let i = 0; i < sampleSize; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
  }

  for (let ci = 0; ci < sampleSize; ci++) {
    const i = indices[ci];
    const candidate = segs[i];
    let splits = 0, frontCount = 0, backCount = 0;

    for (let j = 0; j < segs.length; j++) {
      if (j === i) continue;
      const side = _classifySeg(candidate, segs[j]);
      if      (side === SIDE_FRONT) frontCount++;
      else if (side === SIDE_BACK)  backCount++;
      else if (side === SIDE_ON)    frontCount++;  // coplanar goes front
      else                          splits++;       // SIDE_SPLIT
    }

    const score = splits * SPLIT_COST + Math.abs(frontCount - backCount) * BALANCE_COST;
    if (score < bestScore) {
      bestScore = score;
      bestSeg   = candidate;
    }
  }

  return bestSeg;
}


// ---------------------------------------------------------------------------
// Bounding box helpers
// ---------------------------------------------------------------------------

function _bboxFromSegs(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segs) {
    if (s.x1 < minX) minX = s.x1;  if (s.x1 > maxX) maxX = s.x1;
    if (s.y1 < minY) minY = s.y1;  if (s.y1 > maxY) maxY = s.y1;
    if (s.x2 < minX) minX = s.x2;  if (s.x2 > maxX) maxX = s.x2;
    if (s.y2 < minY) minY = s.y2;  if (s.y2 > maxY) maxY = s.y2;
  }
  return { minX, minY, maxX, maxY };
}


// ---------------------------------------------------------------------------
// BSP builder
// ---------------------------------------------------------------------------

// Recursion depth guard — prevents infinite loops on degenerate input
const MAX_DEPTH = 64;

/**
 * Build a BSP tree from a flat array of Segs.
 *
 * @param {object[]} segs    — array of Seg objects (will not be mutated)
 * @param {object[]} sectors — array of Sector objects (referenced by index)
 * @returns {BSPNode|BSPLeaf} root node
 */
export function buildBSP(segs, sectors, _depth = 0) {
  if (segs.length === 0) {
    return _makeLeaf([], -1);
  }

  // All segs in this set are coplanar / convex — make a leaf
  if (segs.length === 1 || _depth >= MAX_DEPTH) {
    const sector = segs[0].frontSector;
    return _makeLeaf(segs, sector);
  }

  // Choose splitting plane
  const splitter = _chooseSplitter(segs);

  const frontSegs = [];
  const backSegs  = [];

  for (const seg of segs) {
    if (seg === splitter) {
      // The splitter itself goes front (it defines the partition)
      frontSegs.push(seg);
      continue;
    }

    const side = _classifySeg(splitter, seg);

    if (side === SIDE_FRONT || side === SIDE_ON) {
      frontSegs.push(seg);
    } else if (side === SIDE_BACK) {
      backSegs.push(seg);
    } else {
      // SIDE_SPLIT — cut the seg and route each half
      const { front, back } = _splitSeg(splitter, seg);
      frontSegs.push(front);
      backSegs.push(back);
    }
  }

  // If one side is empty, don't recurse into void — make a leaf directly
  const frontChild = frontSegs.length > 0
    ? buildBSP(frontSegs, sectors, _depth + 1)
    : _makeLeaf([], -1);

  const backChild = backSegs.length > 0
    ? buildBSP(backSegs, sectors, _depth + 1)
    : _makeLeaf([], -1);

  return {
    isLeaf:    false,
    partition: splitter,
    front:     frontChild,
    back:      backChild,
    bbox:      _bboxFromSegs(segs),
  };
}

function _makeLeaf(segs, sector) {
  return {
    isLeaf: true,
    segs,
    sector,
    bbox: segs.length > 0 ? _bboxFromSegs(segs) : null,
  };
}


// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Traverse the BSP tree front-to-back relative to viewpoint (vx, vy).
 * Calls callback(node) for every leaf, in front-to-back order.
 *
 * If callback returns true the traversal stops early (used by the column
 * raycaster to abort once a closer hit has already been found in all
 * remaining geometry).
 *
 * The renderer uses this to draw nearer sectors first and track which
 * screen columns are already filled (the solid-column bitmask).
 */
export function traverseFrontToBack(node, vx, vy, callback) {
  if (!node) return false;

  if (node.isLeaf) {
    return callback(node) === true;
  }

  const side = classifyPoint(node.partition, vx, vy);

  if (side === SIDE_BACK) {
    // Viewer is behind the partition — visit back first
    if (traverseFrontToBack(node.back,  vx, vy, callback)) return true;
    traverseFrontToBack(node.front, vx, vy, callback);
  } else {
    // Viewer is in front of (or on) the partition — visit front first
    if (traverseFrontToBack(node.front, vx, vy, callback)) return true;
    traverseFrontToBack(node.back,  vx, vy, callback);
  }
  return false;
}

/**
 * Find the leaf (subsector) that contains point (vx, vy).
 * Used to look up which sector the player/entity is standing in.
 */
export function findLeaf(node, vx, vy) {
  if (!node) return null;
  if (node.isLeaf) return node;

  const side = classifyPoint(node.partition, vx, vy);
  if (side === SIDE_BACK) {
    return findLeaf(node.back,  vx, vy);
  } else {
    return findLeaf(node.front, vx, vy);
  }
}


// ---------------------------------------------------------------------------
// Sector / map container
// ---------------------------------------------------------------------------

/**
 * BSPMap — the runtime object passed to the renderer and collision system.
 *
 * Constructed from the output of buildBSP() plus the sector and seg arrays.
 * mapgen.js builds this and attaches it to the map object alongside the grid.
 */
export class BSPMap {
  /**
   * @param {object}   bspRoot  — root BSPNode from buildBSP()
   * @param {object[]} segs     — flat array of all Segs (for blockmap queries)
   * @param {object[]} sectors  — flat array of Sector objects
   */
  constructor(bspRoot, segs, sectors) {
    this.root    = bspRoot;
    this.segs    = segs;
    this.sectors = sectors;
  }

  /** Return the sector the point (x, y) is standing in, or null. */
  sectorAt(x, y) {
    const leaf = findLeaf(this.root, x, y);
    if (!leaf || leaf.sector < 0) return null;
    return this.sectors[leaf.sector];
  }

  /**
   * Traverse front-to-back from viewpoint (vx, vy).
   * Passes each BSPLeaf to the callback in draw order.
   */
  traverse(vx, vy, callback) {
    traverseFrontToBack(this.root, vx, vy, callback);
  }
}
