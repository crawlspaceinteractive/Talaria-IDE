// ---------------------------------------------------------------------------
// Fixed-Point Core (16.16)
// ---------------------------------------------------------------------------
// All world coordinates in the raycaster use 16.16 fixed-point.
// JavaScript operates on IEEE-754 doubles, so we emulate fixed-point via
// ordinary arithmetic — bitshifts alone overflow the signed-32 range for
// values this large.
//
//   Float → fixed:   (float_value * FP_ONE) | 0
//   Fixed multiply:  ((a * b) / FP_ONE) | 0         ← SAFE
//   Fixed divide:    ((a * FP_ONE) / b) | 0          ← SAFE
//
// AVOID:  (a * b) >> 16   or   (a << 16) / b  — both overflow at large values.
// ---------------------------------------------------------------------------
const FP_SHIFT = 16;
const FP_ONE   = 65536;   // 1 << FP_SHIFT

/** Multiply two 16.16 fixed-point values. */
function f_mul(a, b) { return ((a * b) / FP_ONE) | 0; }

/** Divide two 16.16 fixed-point values. */
function f_div(a, b) { return ((a * FP_ONE) / b) | 0; }

// ---------------------------------------------------------------------------
// Binary Angular Measure (BAM) — 1024-unit circle
// ---------------------------------------------------------------------------
// One full revolution = BAM_COUNT units.
// Angle wrapping is a fast bitwise AND (power-of-two count).
// Trig tables store 16.16 fixed-point values so all downstream multiplies
// stay in fixed-point — zero Math.sin / Math.cos calls in the hot path.
// ---------------------------------------------------------------------------
const BAM_COUNT = 1024;
const BAM_MASK  = BAM_COUNT - 1;   // 1023 — fast modulo

const SineTable   = new Int32Array(BAM_COUNT);
const CosineTable = new Int32Array(BAM_COUNT);

for (let i = 0; i < BAM_COUNT; i++) {
  const rad = (i / BAM_COUNT) * Math.PI * 2;
  SineTable[i]   = (Math.sin(rad) * FP_ONE) | 0;
  CosineTable[i] = (Math.cos(rad) * FP_ONE) | 0;
}

/** 16.16 fixed-point sine, BAM angle. */
function get_sin(a) { return SineTable[a & BAM_MASK]; }

/** 16.16 fixed-point cosine, BAM angle. */
function get_cos(a) { return CosineTable[a & BAM_MASK]; }

/** Wrap an integer angle into [0, BAM_COUNT). */
function wrap_angle(a) { return a & BAM_MASK; }

/** Convert radians → nearest BAM unit (integer). */
function radToBAM(r) { return (((r / (Math.PI * 2)) * BAM_COUNT) | 0) & BAM_MASK; }

/** Convert BAM angle → radians (float — used only outside the hot path). */
function bamToRad(a) { return (a / BAM_COUNT) * Math.PI * 2; }

// ---------------------------------------------------------------------------
// Reciprocal Table — avoids runtime division during projection.
// Indexed by the INTEGER part of view_z (i.e. view_z >> FP_SHIFT).
// Entry i = FP_ONE / i, pre-scaled as 16.16 fixed-point.
// ---------------------------------------------------------------------------
const ReciprocalTable = new Int32Array(4096);
for (let i = 0; i < 4096; i++) {
  const z = i === 0 ? 1 : i;
  ReciprocalTable[i] = f_div(FP_ONE, z << FP_SHIFT);
}

/** Fast reciprocal of a 16.16 fixed-point distance. */
function get_reciprocal(view_z) {
  const z = view_z >> FP_SHIFT;
  if (z <= 0)    return ReciprocalTable[1];
  if (z >= 4096) return ReciprocalTable[4095];
  return ReciprocalTable[z];
}

// ---------------------------------------------------------------------------
// Export BAM helpers so renderer/enemies can share the same tables.
// ---------------------------------------------------------------------------
export { FP_SHIFT, FP_ONE, f_mul, f_div, get_sin, get_cos, wrap_angle, radToBAM, bamToRad, get_reciprocal, BAM_COUNT, BAM_MASK, SineTable, CosineTable };

// ---------------------------------------------------------------------------
// Raycaster
// ---------------------------------------------------------------------------

export class Raycaster {
  constructor(map) {
    this.map = map;
    this.distToWall = null; // set by precache()

    // ── Struct-of-Arrays for per-ray trig — Q1.14 Int16 halves bandwidth.
    // _soaDdx / _soaDdy stay Float64 because |1/cos| blows Int16 near zero.
    // Rebuilt only when numRays or fov changes (once per level).
    this._soaCos  = null;   // Int16Array  (Q1.14)
    this._soaSin  = null;   // Int16Array  (Q1.14)
    this._soaDdx  = null;   // Float64Array |1/cos|
    this._soaDdy  = null;   // Float64Array |1/sin|
    this._soaFov  = -1;
    this._soaN    = -1;

    // ── Pre-allocated hit result arrays — zero heap allocs per castAll() call.
    this._hitDist     = null;   // Float32Array
    this._hitSide     = null;   // Uint8Array   0=X 1=Y
    this._hitWallX    = null;   // Float32Array  texture U coord [0,1)
    this._hitMapX     = null;   // Int16Array
    this._hitMapY     = null;   // Int16Array
    this._hitPrevMapX = null;   // Int16Array — open tile the ray entered from (face ID)
    this._hitPrevMapY = null;   // Int16Array
    this._hitN        = 0;

    // ── BAM angle state — updated each castAll() call.
    this._camAngleBAM = 0;   // current player angle in BAM units
    this._camAngleF   = 0;   // current player angle in radians (kept for hasLOS)

    // ── Wall sticker support.
    // stickers[mapY * mapWidth + mapX] = Array<sticker> | undefined
    // Each sticker: { offset_u, offset_y, tex_id, width, height, animated, frame }
    // offset_u / offset_y are 16.16 fixed-point in [0, FP_ONE].
    this.stickers = null;    // allocated by buildStickerMap()
  }

  // ── Called once after map load to build the wall-distance precache and
  // initialise the sticker map (sized to the tile grid).
  precache() {
    const map = this.map;
    const w = map.width, h = map.height;
    const n = w * h;
    const dist = new Uint8Array(n);

    // Multi-source BFS from all wall cells outward — O(n), visited exactly once.
    const queue = new Int32Array(n);
    let head = 0, tail = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const cell = map.grid[y][x];
        if (cell !== 0) {
          // Grid is purely 0/1 — all non-zero cells are solid walls.
          // Toggleables (secret walls, gem doors) are no longer stored in the
          // grid as special values 2/3/4/5, so no special case is needed here.
          dist[idx] = 0;
          queue[tail++] = idx;
        } else {
          dist[idx] = 255;
        }
      }
    }

    const dx4 = [-1, 1,  0, 0];
    const dy4 = [ 0, 0, -1, 1];
    while (head < tail) {
      const idx = queue[head++];
      const cx = idx % w;
      const cy = (idx / w) | 0;
      const d  = dist[idx];
      for (let i = 0; i < 4; i++) {
        const nx = cx + dx4[i];
        const ny = cy + dy4[i];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        const nd = d + 1;
        if (nd < dist[ni]) {
          dist[ni] = nd;
          queue[tail++] = ni;
        }
      }
    }

    this.distToWall = dist;

    // Sticker map: one slot per tile, lazily allocated to arrays on first write.
    this.stickers = new Array(n);
  }

  // ── Build / rebuild the SoA trig tables when fov or numRays changes.
  // Uses BAM for the camera-relative ray angles; rotates them by player angle
  // each frame using BAM integer arithmetic.
  _rebuildSoA(numRays, fov) {
    this._soaFov = fov;
    this._soaN   = numRays;

    this._soaCos  = new Int16Array(numRays);
    this._soaSin  = new Int16Array(numRays);
    this._soaDdx  = new Float64Array(numRays);
    this._soaDdy  = new Float64Array(numRays);

    // Hit result arrays (pre-allocated, reused every frame)
    this._hitDist     = new Float32Array(numRays);
    this._hitSide     = new Uint8Array(numRays);
    this._hitWallX    = new Float32Array(numRays);
    this._hitMapX     = new Int16Array(numRays);
    this._hitMapY     = new Int16Array(numRays);
    this._hitPrevMapX = new Int16Array(numRays);
    this._hitPrevMapY = new Int16Array(numRays);
    this._hitN        = numRays;

    const halfFov = fov / 2;
    for (let i = 0; i < numRays; i++) {
      // Camera-relative angle in radians, then convert to BAM.
      const relAngle = -halfFov + (i / (numRays - 1)) * fov;
      const cosF = Math.cos(relAngle);
      const sinF = Math.sin(relAngle);

      // Q1.14: multiply by 16384 (1 << 14) so the range [-1,1] fits Int16.
      this._soaCos[i] = (cosF * 16384) | 0;
      this._soaSin[i] = (sinF * 16384) | 0;

      // deltaDistX/Y stay float — they can exceed Int16 near axis-aligned rays.
      this._soaDdx[i] = Math.abs(cosF) < 1e-10 ? 1e30 : Math.abs(1 / cosF);
      this._soaDdy[i] = Math.abs(sinF) < 1e-10 ? 1e30 : Math.abs(1 / sinF);
    }
  }

  // ── Main cast �� returns a lightweight view object backed by pre-allocated
  // typed arrays.  Zero heap allocations per call after the first level load.
  castAll(px, py, angle, numRays, fov) {
    if (this._soaFov !== fov || this._soaN !== numRays) {
      this._rebuildSoA(numRays, fov);
    }

    // Player angle in BAM units (integer)
    const angleBAM = radToBAM(angle);
    this._camAngleBAM = angleBAM;
    this._camAngleF   = angle;

    // BAM cos/sin of player angle, normalised to float for DDA
    const camCosF = CosineTable[angleBAM & BAM_MASK] / FP_ONE;
    const camSinF = SineTable[angleBAM & BAM_MASK]   / FP_ONE;

    const soaCos = this._soaCos;
    const soaSin = this._soaSin;
    // Multiply by reciprocal instead of dividing — ~5× faster on hot path.
    // Q1.14 scale = 16384; reciprocal precomputed as a constant.
    const Q14_INV = 1 / 16384;

    const soaDdx = this._soaDdx;
    const soaDdy = this._soaDdy;

    for (let i = 0; i < numRays; i++) {
      // Rotate the precomputed camera-relative direction by the player angle.
      // Q1.14 * Q14_INV → float in [-1, 1].
      const cx = soaCos[i] * Q14_INV;
      const cy = soaSin[i] * Q14_INV;
      const wx = camCosF * cx - camSinF * cy;
      const wy = camSinF * cx + camCosF * cy;

      // Precomputed deltaDist values for this ray's camera-relative angle.
      // After rotation the sign of wx/wy may flip, but |1/cos| = |1/sin| are
      // unchanged (rotation preserves magnitudes).  Pass them in to avoid
      // recomputing the guarded division inside _ddaIntoSlot for every ray.
      this._ddaIntoSlot(px, py, wx, wy, soaDdx[i], soaDdy[i], i);
    }

    // Return the raw typed arrays directly — renderer reads them by index.
    // (Replaces the old getter-object _hitView which caused 2240 getter
    //  dispatches per frame and blocked V8's hidden-class fast path.)
    return this;
  }

  // ── DDA — writes directly into the pre-allocated typed-array slots.
  // ddx / ddy are |1/cos| and |1/sin| — precomputed by the caller to avoid
  // repeated guarded division in the 320×/frame hot path.  hasLOS passes
  // undefined and falls back to inline computation (called only ~10×/frame).
  _ddaIntoSlot(px, py, cos, sin, ddx, ddy, slot) {
    const map  = this.map;
    const mapX0 = Math.floor(px);
    const mapY0 = Math.floor(py);

    const deltaDistX = ddx !== undefined ? ddx : (Math.abs(cos) < 1e-10 ? 1e30 : Math.abs(1 / cos));
    const deltaDistY = ddy !== undefined ? ddy : (Math.abs(sin) < 1e-10 ? 1e30 : Math.abs(1 / sin));

    let stepX, stepY, sideDistX, sideDistY;

    if (cos < 0) {
      stepX = -1;
      sideDistX = (px - mapX0) * deltaDistX;
    } else {
      stepX = 1;
      sideDistX = (mapX0 + 1 - px) * deltaDistX;
    }
    if (sin < 0) {
      stepY = -1;
      sideDistY = (py - mapY0) * deltaDistY;
    } else {
      stepY = 1;
      sideDistY = (mapY0 + 1 - py) * deltaDistY;
    }

    let mapX = mapX0, mapY = mapY0, side = 0, dist = 0;
    let prevMapX = mapX0, prevMapY = mapY0;

    const MAX_DIST = 24;
    const dtw  = this.distToWall;
    const mapW = map.width;

    for (let i = 0; i < MAX_DIST * 4 && dist < MAX_DIST; i++) {
      // Space-skipping optimisation — stride past empty space in one go.
      if (dtw && mapX >= 0 && mapX < mapW && mapY >= 0 && mapY < map.height) {
        const skip = (dtw[mapY * mapW + mapX] | 0) - 1;
        if (skip > 1) {
          for (let s = 1; s < skip; s++) {
            prevMapX = mapX; prevMapY = mapY;
            if (sideDistX < sideDistY) {
              dist = sideDistX; sideDistX += deltaDistX; mapX += stepX; side = 0;
            } else {
              dist = sideDistY; sideDistY += deltaDistY; mapY += stepY; side = 1;
            }
            i++;
            if (dist >= MAX_DIST) break;
          }
          continue;
        }
      }

      prevMapX = mapX; prevMapY = mapY;
      if (sideDistX < sideDistY) {
        dist = sideDistX; sideDistX += deltaDistX; mapX += stepX; side = 0;
      } else {
        dist = sideDistY; sideDistY += deltaDistY; mapY += stepY; side = 1;
      }

      if (map.isWall(mapX, mapY)) {
        // Inner-face cull: skip faces shared between two solid blocks (noclip safety).
        // Use the pre-baked distToWall typed array (dtw[idx] === 0 means solid wall)
        // instead of calling map.isWall() — that path runs .find() on secretWalls /
        // gemDoors for every hit, which is O(n) and fires 320×/frame.
        // dtw is a Uint8Array: value 0 = wall tile, >0 = open space.
        if (dtw && prevMapX >= 0 && prevMapX < mapW &&
            prevMapY >= 0 && prevMapY < map.height &&
            dtw[prevMapY * mapW + prevMapX] === 0) continue;

        let wallX = (side === 0) ? (py + dist * sin) : (px + dist * cos);
        wallX -= Math.floor(wallX);

        this._hitDist[slot]     = dist;
        this._hitSide[slot]     = side;
        this._hitWallX[slot]    = wallX;
        this._hitMapX[slot]     = mapX;
        this._hitMapY[slot]     = mapY;
        this._hitPrevMapX[slot] = prevMapX;
        this._hitPrevMapY[slot] = prevMapY;
        return;
      }
    }

    this._hitDist[slot]     = MAX_DIST;
    this._hitSide[slot]     = 0;
    this._hitWallX[slot]    = 0;
    this._hitMapX[slot]     = mapX;
    this._hitMapY[slot]     = mapY;
    this._hitPrevMapX[slot] = prevMapX;
    this._hitPrevMapY[slot] = prevMapY;
  }

  // ── Hitscan ray (center of screen) — placeholder; enemy hit detection is
  // done by sprite distance comparison, not hitscan.  Body is a no-op.
  shootRay(_px, _py, _angle) {
    return null;
  }

  // ── Line-of-sight check (enemy AI aggro).
  // Uses the DDA engine with the distToWall space-skip acceleration instead of
  // the old linear step-trace (which called map.isWall() dist*4 times per check).
  // A scratch slot (LOS_SLOT) is reserved at the end of the hit arrays; it is
  // never read by the renderer.
  hasLOS(px, py, ex, ey) {
    const dx = ex - px, dy = ey - py;
    const distSq = dx * dx + dy * dy;
    if (distSq < 1e-12) return true;

    const dist = Math.sqrt(distSq);
    const cosF = dx / dist;
    const sinF = dy / dist;

    // Write into the last slot of the pre-allocated hit arrays (never rendered).
    // Pass undefined for ddx/ddy — hasLOS is called ~10×/frame so the fallback
    // division in _ddaIntoSlot is negligible here.
    const slot = this._hitN > 0 ? this._hitN - 1 : 0;
    this._ddaIntoSlot(px, py, cosF, sinF, undefined, undefined, slot);

    // If the nearest wall is at or beyond enemy distance, LOS is clear.
    return this._hitDist[slot] >= dist - 0.15;
  }

  // ── Sticker API
  // ──────────────────────────────────────────────────────────────────────────
  // Stickers (torches, bullet holes, decals, scorch marks) are attached to
  // wall faces in segment space so they project correctly without any per-frame
  // world-space reprojection.
  //
  // offset_u: 16.16 fixed-point in [0, FP_ONE] — 0 = segment start, FP_ONE = end
  // offset_y: 16.16 fixed-point in [0, FP_ONE] — 0 = wall bottom, FP_ONE = top
  // ───────────────────────────────────────────────────────────────��──────────

  /**
   * Attach a sticker to a wall tile.
   *
   * @param {number} mapX
   * @param {number} mapY
   * @param {number} worldX  - world-space X of the sticker centre
   * @param {number} worldY  - world-space Y of the sticker centre
   * @param {number} worldZ  - world-space Z (height) of the sticker centre [0=floor, 1=ceiling]
   * @param {string} tex_id  - asset key
   * @param {number} width   - sticker half-width in world units
   * @param {number} height  - sticker half-height in world units
   * @param {boolean} animated
   */
  attachSticker(mapX, mapY, worldX, worldY, worldZ, tex_id, width = 0.25, height = 0.25, animated = false) {
    if (!this.stickers) return;
    const idx = mapY * this.map.width + mapX;

    // Project point onto wall segment (spec §6).
    // For an axis-aligned grid, the wall face is either a pure X or pure Y edge.
    // We project the world point onto the wall tile centre to get offset_u.
    const tileCX = mapX + 0.5;
    const tileCY = mapY + 0.5;

    // Nearest face: determine which open-space neighbor this sticker faces.
    // fromX/fromY is the floor tile on the other side of this wall face —
    // the same tile the DDA ray occupies (prevMapX/prevMapY) when it hits this wall.
    const dx = worldX - tileCX;
    const dy = worldY - tileCY;
    let t;
    let fromX, fromY;
    // faceAxis: 'x' = left/right wall face, 'y' = top/bottom wall face.
    // faceCoord: the constant coordinate of the face plane on that axis,
    // used by _drawWallStickers to compute a stable perp distance:
    //   X-face: dist = (faceCoord - player.x)*dirX + (worldY - player.y)*dirY
    //   Y-face: dist = (worldX - player.x)*dirX    + (faceCoord - player.y)*dirY
    let faceAxis, faceCoord;
    if (Math.abs(dx) > Math.abs(dy)) {
      // X face (left or right wall boundary)
      t         = (worldY - mapY);
      fromX     = mapX + (dx > 0 ? 1 : -1);
      fromY     = mapY;
      faceAxis  = 'x';
      faceCoord = mapX + (dx > 0 ? 1 : 0);  // integer tile boundary on X
    } else {
      // Y face (top or bottom wall boundary)
      t         = (worldX - mapX);
      fromX     = mapX;
      fromY     = mapY + (dy > 0 ? 1 : -1);
      faceAxis  = 'y';
      faceCoord = mapY + (dy > 0 ? 1 : 0);  // integer tile boundary on Y
    }
    t = Math.max(0, Math.min(1, t));

    // Wall height assumed 1 world unit.  offset_y: 0=bottom, FP_ONE=top.
    const oy_f = Math.max(0, Math.min(1, worldZ));

    const sticker = {
      offset_u: (t * FP_ONE)    | 0,
      offset_y: (oy_f * FP_ONE) | 0,
      tex_id,
      width:    (width  * FP_ONE) | 0,
      height:   (height * FP_ONE) | 0,
      animated,
      frame: 0,
      // fromX/fromY: open-space neighbor tile this face is visible from.
      fromX,
      fromY,
      // worldX/worldY: original hit point — used only for _inFrustum angle/column.
      worldX,
      worldY,
      // faceAxis + faceCoord: exact wall plane for stable perp-distance in renderer.
      faceAxis,
      faceCoord,
    };

    if (!this.stickers[idx]) this.stickers[idx] = [];
    this.stickers[idx].push(sticker);
    return sticker;
  }

  /** Return the sticker array for a tile (may be undefined). */
  getStickers(mapX, mapY) {
    if (!this.stickers) return undefined;
    return this.stickers[mapY * this.map.width + mapX];
  }

  /** Remove all stickers for a tile (e.g. when secret wall opens).
   *  Also stamps distToWall so the inner-face cull no longer skips faces
   *  that were interior to this tile while it was solid. */
  clearStickers(mapX, mapY) {
    if (!this.stickers) return;
    this.stickers[mapY * this.map.width + mapX] = undefined;
    // Patch the distToWall bake: value 0 means "solid wall" and triggers the
    // inner-face cull. Set it to 1 (minimum open-space value) so rays coming
    // from the now-open tile are no longer treated as interior.
    if (this.distToWall) {
      const idx = mapY * this.map.width + mapX;
      if (this.distToWall[idx] === 0) this.distToWall[idx] = 1;
    }
  }

  /** Wipe all stickers (called at level load). */
  clearAllStickers() {
    if (this.stickers) this.stickers.fill(undefined);
  }
}
