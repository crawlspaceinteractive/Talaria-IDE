import { customAnimFrames } from './assets.js';
import { WEAPONS } from './shop.js';
import {
  FP_SHIFT, FP_ONE, f_mul, f_div,
  get_sin, get_cos, wrap_angle, radToBAM, bamToRad,
  get_reciprocal,
  BAM_COUNT, BAM_MASK,
  SineTable, CosineTable,
} from './raycaster.js';

// ---------------------------------------------------------------------------
// Framebuffer — Uint32Array for wall columns.
// One putImageData replaces ~320 individual drawImage calls per frame.
// Pixel format: 0xAABBGGRR (little-endian canvas layout).
// ---------------------------------------------------------------------------

const _FB_W = 320;
const _FB_H = 200;
const _wallImageData  = new ImageData(_FB_W, _FB_H);
const _wallFB         = new Uint32Array(_wallImageData.data.buffer);

// Detect endianness once at load time; affects ARGB word packing.
const _IS_LE = (new Uint32Array(new Uint8Array([1,0,0,0]).buffer))[0] === 1;

/** Pack an opaque RGB pixel into the correct Uint32 word for this platform.
 *  Specialized at load time so the call site is always monomorphic and V8
 *  can inline it — the dead branch never appears in the JIT output. */
const _packRGB = _IS_LE
  ? (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0
  : (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;

// Per-wall-column occlusion buffer — set to 1 after a solid wall column is drawn.
// Front-to-back would use this for span clipping; currently used as a reference
// for sticker partial-span support (spec §17/18).
const _occlude = new Uint8Array(_FB_W);

// Texture constants (spec §14)
const TEX_SIZE = 64;
const TEX_MASK = TEX_SIZE - 1;  // 63

// Texture cache: HTMLImageElement → { srcKey, buf: Uint32Array(TEX_SIZE×TEX_SIZE) }
// Lazily populated on first use; entry is invalidated when img.src changes.
// The renderer guards _getTexPixels with a per-frame this._wallTexImg reference
// check, so WeakMap.get fires at most O(distinct textures) per frame — not
// per column.  A string-keyed Map would be marginally faster but the win is
// negligible given how rarely this actually runs in the hot path.
const _texCache = new WeakMap();

// Build a set of weapon IDs that carry the FLASH tag — only these get muzzle flash draws.
const FLASH_IDS = new Set(
  WEAPONS.filter(w => w.tags && w.tags.includes('FLASH')).map(w => w.id)
);

/**
 * Quake-III fast inverse square root — ~0.175% error after one Newton-Raphson
 * iteration.  Used in place of `1 / Math.sqrt(n)` on hot rendering paths.
 * Returns 1/sqrt(n).  Undefined for n <= 0.
 */
const _fisBuf = new ArrayBuffer(4);
const _fisF32 = new Float32Array(_fisBuf);
const _fisU32 = new Uint32Array(_fisBuf);
function fastInvSqrt(n) {
  const x2 = n * 0.5;
  _fisF32[0] = n;
  _fisU32[0] = 0x5f3759df - (_fisU32[0] >> 1);
  let y = _fisF32[0];
  y = y * (1.5 - x2 * y * y);   // one Newton-Raphson iteration (~0.175% error)
  return y;
}

/** Returns the active mod font (set by the mod editor) or the default retro font.
 *  Exported so main.js can import it instead of maintaining a duplicate. */
export function getModFont() {
  return window.__modFont__ || "'Press Start 2P', 'Courier New', monospace";
}

const W = 320;
const H = 200;
const NUM_RAYS = 320;
const FOV = Math.PI / 2.5;

// ── Per-row floor walk cache — precomputed once per frame in _buildRowWalkCache(),
// then shared across all torch iterations in _drawTorchRaycastFill.
// Eliminates per-torch recomputation of stepX/Y, wx0, wy0 (saves ~4 muls/row/torch).
const _ROW_STEP_X  = new Float32Array(H / 2 + 2);
const _ROW_STEP_Y  = new Float32Array(H / 2 + 2);
const _ROW_WX0     = new Float32Array(H / 2 + 2);
const _ROW_WY0     = new Float32Array(H / 2 + 2);
// Squared zone radii — avoids Math.sqrt in the torch inner loop hot path.
const _TORCH_ZONE_1_SQ  = 1.5  * 1.5;   // 2.25
const _TORCH_ZONE_2_SQ  = 2.5  * 2.5;   // 6.25
const _TORCH_ZONE_3_SQ  = 3.25 * 3.25;  // 10.5625
// Frame parity flag: torch fill alternates every other frame (halves its pixel cost).
let _torchFillFrame = 0;
// ── Torch delta overlay buffer: stores RGB additions from _drawTorchRaycastFill.
// Rebuilt on even frames, then re-applied on odd frames.
// Uint8Array of size W*H*4 (same layout as ImageData). Zero = no torch light here.
const _torchDelta = new Uint8Array(W * H * 4);

// ── Camera-plane constants for floor/ceiling caster.
// tan(FOV/2) is constant — computed once; per-frame we only need cos/sin(playerAngle).
// Camera plane perp vector (right-hand side) = (-camDirY, camDirX) * tanHalfFov
// → rayLeft  = camDir - plane
// → rayRight = camDir + plane
const _FC_TAN_HALF_FOV = Math.tan(FOV / 2);  // ~0.7265 for FOV=π/2.5

// Culling constants
const HALF_FOV_CULL = (FOV / 2) + 0.42; // slight margin beyond FOV edge for sprites

/**
 * Returns the screen Y row of the perspective-correct floor at a given distance.
 * Uses the same _WALLH_LUT as the wall column renderer for consistency.
 * We add 2px to plant the sprite's feet just below the floor line.
 */
function _floorRow(dist) {
  const idx  = (Math.max(0.1, dist) * _WALLH_LUT_SCALE + 0.5) | 0;
  const safe = idx < _WALLH_LUT_SIZE ? idx : _WALLH_LUT_SIZE - 1;
  return _WALLTOP_LUT[safe] + _WALLH_LUT[safe] + 2;  // wallTop + wallH + 2 = floor line + 2
}
const MAX_SPRITE_DIST  = 28;  // hard max distance for any sprite
const MAX_ENEMY_DIST   = 26;
const MAX_DECOR_DIST   = 18;
const MAX_PICKUP_DIST  = 20;
const MAX_TORCH_DIST   = 10;
const MAX_PORTAL_DIST  = 28;
const MAX_PLASMA_DIST  = 24;

// Precomputed constants for angle wrap
const TWO_PI = Math.PI * 2;
const INV_TWO_PI = 1 / TWO_PI;

// ── LUT: pow(x, 2.5) for x ∈ [0,1] — replaces Math.pow per pixel in torch/halo loops.
// Input: (falloff * 255) | 0 → index 0..255.  Output: pow(index/255, 2.5).
// Eliminates Math.pow from every lit pixel in _drawTorchRaycastFill, _drawTorchWallGlows,
// and paintHalo (potentially thousands of calls per frame).
const _POW25_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) _POW25_LUT[i] = Math.pow(i / 255, 2.5);

// ── LUT: rowDist = eyeHeight / dy for dy = 1..H/2.
// Used in _drawTexturedFloorCeiling and _drawTorchRaycastFill per scanline.
// eyeHeight = H/2 = 100.  Index 0 unused (dy starts at 1).
const _ROW_DIST_LUT = new Float32Array(H / 2 + 2);
{ const eyeH = H / 2; for (let dy = 1; dy <= H / 2 + 1; dy++) _ROW_DIST_LUT[dy] = eyeH / dy; }

// ── LUT: wallH = floor(H / dist) for quantized dist (resolution = 1/64 world unit).
// Index = (dist * 64) | 0.  Max dist ~= 64 world units → 4096 entries.
// Caps at H*4 to avoid infinite values near dist=0.
const _WALLH_LUT_SCALE = 64;
const _WALLH_LUT_SIZE  = 4096;
const _WALLH_LUT = new Uint16Array(_WALLH_LUT_SIZE);
{
  const _wlMax = H * 4;
  for (let i = 1; i < _WALLH_LUT_SIZE; i++) {
    const dist = i / _WALLH_LUT_SCALE;
    _WALLH_LUT[i] = Math.min(_wlMax, Math.floor(H / dist));
  }
  _WALLH_LUT[0] = _wlMax; // dist=0 guard
}

// ── LUT: wallTop = floor((H - wallH) / 2) — derived directly from _WALLH_LUT.
// Called 6× per frame for every drawn wall column (BSP path: 320×/frame).
// Index identical to _WALLH_LUT; lookup replaces the Math.floor + subtraction.
// Uses Int16Array because top can be negative when wallH > H (very close walls).
const _WALLTOP_LUT = new Int16Array(_WALLH_LUT_SIZE);
{
  for (let i = 0; i < _WALLH_LUT_SIZE; i++) {
    _WALLTOP_LUT[i] = (H - _WALLH_LUT[i]) >> 1;
  }
}

// ── LUT: screenX = floor(((sa + halfFov) / FOV) * W) for angle offsets sa ∈ [-halfFov..halfFov].
// Index = ((sa + halfFov) * _SA_LUT_SCALE + 0.5) | 0, range [0 .. _SA_LUT_SIZE-1].
// Maps angle-space directly to integer screen column.
const _SA_LUT_SCALE = 512;  // sub-radian resolution
const _SA_LUT_SIZE  = Math.ceil(FOV * _SA_LUT_SCALE) + 2;
const _SA_LUT = new Int16Array(_SA_LUT_SIZE);
{
  const _halfFov = FOV / 2;
  for (let i = 0; i < _SA_LUT_SIZE; i++) {
    const sa = i / _SA_LUT_SCALE - _halfFov;
    _SA_LUT[i] = Math.max(0, Math.min(W - 1, Math.floor(((sa + _halfFov) / FOV) * W)));
  }
}
/**
 * Convert r = cross/dot (tan-space lateral ratio from _inFrustum) to screen column.
 *
 * The wall renderer sweeps rays linearly in angle space:
 *   rayAngle[col] = player.angle - halfFov + col/(N-1)*FOV
 * so the inverse mapping is:
 *   col = (spriteAngle - player.angle + halfFov) / FOV * W
 *       = (atan(r) + halfFov) / FOV * W
 *
 * Math.atan is called once per visible sprite (not per pixel) — negligible cost,
 * and produces exact column alignment with the wall geometry.
 *
 * NOTE: do NOT use r * (1/tan(halfFov)) here — that's a tangent-space linear
 * mapping which disagrees with the angle-linear wall renderer by up to ~8px at
 * the FOV edges, causing sprites to visibly drift/stick as they approach the
 * screen boundary.
 */
function _saToScreenX(r) {
  return ((Math.atan(r) + _HALF_FOV) / FOV * W) | 0;
}

// ── LUT: smoothstep falloff for _computeTorchLight inner col loop.
// t = |col - centerCol| / (radius + 1) ∈ [0..1].  Index = (t * _SS_LUT_N) | 0.
// f(t) = smoothstep on outer half: ht = max(0, (t-0.5)*2); 1 - ht²*(3-2*ht).
// Eliminates Math.abs + Math.max + 3 muls per column per active light.
const _SS_LUT_N = 512;
const _SS_LUT = new Float32Array(_SS_LUT_N + 1);
for (let i = 0; i <= _SS_LUT_N; i++) {
  const t  = i / _SS_LUT_N;
  const ht = t > 0.5 ? (t - 0.5) * 2 : 0;
  _SS_LUT[i] = 1 - ht * ht * (3 - 2 * ht);
}

// ── LUT: floor + ceiling shade per scanline row (dy = 1..H/2).
// floorShade[dy] = max(0.18, 1 - rowDist/18) * 0.86
// ceilShade[dy]  = max(0.18, 1 - rowDist/18) * 0.58
// _CEIL_SHADE_M_LUT: ceiling locked to 'm' light level (12/25=0.48) — uniform across
// all sector types (rooms and corridors alike), giving a stable medium-dark ceiling.
// Replaces Math.max + division in the per-row outer loop of _drawTexturedFloorCeiling.
// Index 0 unused (dy starts at 1).
const _FLOOR_SHADE_LUT  = new Float32Array(H / 2 + 2);
const _CEIL_SHADE_LUT   = new Float32Array(H / 2 + 2);  // kept for legacy callers
const _CEIL_SHADE_M_LUT = new Float32Array(H / 2 + 2);  // ceiling at fixed 'm' level
// Streets-of-Rage ambient: very dark base so torches carry ALL the visible light.
// Floor minimum 0.04 (near-black at distance), multiplier 0.42 keeps close tiles slightly
// visible. Ceiling is darker still — only torch fill brings it to life.
// 'm' = char code 109; 'a'=0..'z'=1.0 → (109-97)/25 = 0.48
const _CEIL_M_LEVEL = (109 - 97) / 25;  // 0.48  — Quake 'm' brightness constant
{
  const eyeH = H / 2, maxFlatDist = 18;
  for (let dy = 1; dy <= H / 2 + 1; dy++) {
    const rowDist  = eyeH / dy;
    // SOR dark ambient: minimum 0.04, aggressive distance falloff.
    // Close tiles (low rowDist) still show texture; far tiles fall to near-black.
    const base     = rowDist < maxFlatDist ? Math.max(0.04, 1 - rowDist / maxFlatDist) : 0.04;
    _FLOOR_SHADE_LUT[dy]  = base * 0.546;
    _CEIL_SHADE_LUT[dy]   = base * 0.364;
    // Ceiling: even darker — SOR ceilings are almost black, lit only by torch fill.
    _CEIL_SHADE_M_LUT[dy] = base * 0.429;
  }
}

// ── Sprite pool — pre-allocated ring buffer of plain objects, reused each frame.
// Avoids GC pressure from creating {type,data,sa,dist,...} objects every frame.
const _SPRITE_POOL_SIZE = 256;
const _spritePool = [];
for (let i = 0; i < _SPRITE_POOL_SIZE; i++) {
  _spritePool.push({ type: '', data: null, sa: 0, dist: 0, decorIdx: -1, torchIdx: -1 });
}
let _spritePoolIdx = 0;
/** Claim the next slot from the pool; reset it and return it. */
function _poolSprite(type, data, sa, dist, decorIdx = -1, torchIdx = -1) {
  const s = _spritePool[_spritePoolIdx % _SPRITE_POOL_SIZE];
  _spritePoolIdx++;
  s.type = type; s.data = data; s.sa = sa; s.dist = dist;
  s.decorIdx = decorIdx; s.torchIdx = torchIdx;
  return s;
}

// Precomputed half-FOV cosine/tangent for the dot/cross frustum check.
// Recomputed whenever FOV changes (it never does at runtime, but guard anyway).
let _frustumFovKey   = null;
let _frustumDirX     = 1;   // cos(playerAngle) — updated each call
let _frustumDirY     = 0;   // sin(playerAngle)
let _frustumHalfTan  = 0;   // tan(HALF_FOV_CULL) — threshold for cross/dot ratio
// Reciprocal of tan(halfFov)*2 — maps cross/dot ratio to column index without atan2.
// halfFov here is the true FOV half (not the cull margin) so screenX math stays correct.
let _frustumTanHalfFovRecip = 0;  // 1 / tan(FOV/2)
const _HALF_FOV = FOV / 2;
// After every _inFrustum call that returns non-null, this holds the fisheye-corrected
// perp distance (= dot product = euclidean * cos(relAngle)).  Callers read this
// immediately after checking sa !== null to get the projection-correct distance.
let _lastPerpDist = 0;

/**
 * Fast frustum check — BAM trig tables, zero Math.sin/Math.cos/Math.atan2 calls.
 *
 * Returns r = cross/dot (the tan-space lateral ratio) for screenX placement:
 *   screenX = floor((r / tanHalfFov + 1) * 0.5 * W)
 * Returns null if outside FOV or beyond maxDist.
 *
 * Previously returned an approximate atan(r) value, which accumulated error at
 * FOV edges (|r| ~ 1.07) and caused sprites to appear stuck/swimming at screen
 * edges. Returning r directly is both exact and cheaper (no polynomial eval).
 *
 * Hot-path trig elimination:
 *   - dirX/dirY resolved from BAM tables (no Math.cos/sin per sprite)
 *   - dot/cross cull avoids division entirely
 *   - column mapping: screenX = (r/tanHalfFov + 1)*0.5*W — one mul+add, no atan
 */
function _inFrustum(dx, dy, playerAngle, maxDist) {
  const distSq = dx * dx + dy * dy;
  if (distSq > maxDist * maxDist) return null;

  // Lazily initialise tan thresholds when FOV changes (never at runtime).
  if (_frustumFovKey !== HALF_FOV_CULL) {
    _frustumFovKey          = HALF_FOV_CULL;
    _frustumHalfTan         = Math.tan(HALF_FOV_CULL);
    _frustumTanHalfFovRecip = 1 / Math.tan(_HALF_FOV);
  }

  // Use Math.cos/sin on the raw float playerAngle — NOT the BAM-quantized table.
  // The wall renderer uses float _rayAngles[] derived from player.angle directly;
  // if we use BAM here the 1024-step quantisation (≈0.35°/step ≈ 1.5 columns/step)
  // makes dirX/dirY step in discrete jumps as the player rotates, causing the
  // cross/dot ratio — and therefore screenX — to visibly jitter even though the
  // sprite hasn't moved.  One Math.cos+sin per frustum call (~20-30 sprites/frame)
  // is negligible.
  const dirX = Math.cos(playerAngle);
  const dirY = Math.sin(playerAngle);

  const dot   =  dx * dirX + dy * dirY;  // forward component = perp (fisheye-corrected) distance
  const cross =  dy * dirX - dx * dirY;  // lateral component (right = positive in +Y-down coords)

  if (dot <= 0) return null;

  // |cross| / dot > tan(halfFov+margin) → outside FOV — no division needed.
  const absC = cross < 0 ? -cross : cross;
  if (absC > dot * _frustumHalfTan) return null;

  _lastPerpDist = dot;

  return cross / dot;
}

/**
 * Given the dot/cross components already computed in _inFrustum's coordinate
 * system, return the perp-distance (= dist * cos(angle)) without any trig.
 * Caller must pass the same dot value used for cull; distSq is dx²+dy².
 *   perpDist = dot  (exact: dot = |v|*cos(θ) = dist*cos(relAngle))
 */
function _perpFromDot(dot) {
  return dot;
}

// Dither pattern (4x4 Bayer matrix) — flattened Uint8Array for cache-friendly access.
// Index as: DITHER4[(y & 3) * 4 + (x & 3)]
const DITHER4 = new Uint8Array([
   0, 8, 2,10,
  12, 4,14, 6,
   3,11, 1, 9,
  15, 7,13, 5,
]);

// 8×8 Bayer matrix — values 0..63, normalised to 0..63 range.
// Index as: DITHER8[(y & 7) * 8 + (x & 7)]
// Used by the floor/ceiling caster with variable cell size (1px near → 8px far).
const DITHER8 = new Uint8Array([
   0,32, 8,40, 2,34,10,42,
  48,16,56,24,50,18,58,26,
  12,44, 4,36,14,46, 6,38,
  60,28,52,20,62,30,54,22,
   3,35,11,43, 1,33, 9,41,
  51,19,59,27,49,17,57,25,
  15,47, 7,39,13,45, 5,37,
  63,31,55,23,61,29,53,21,
]);

// 16×16 Bayer matrix — values 0..255 (0..N²-1 normalised).
// Index as: DITHER16[(y & 15) * 16 + (x & 15)]
// Used for torch fill mid-zone (3–4 units from source).
const DITHER16 = (() => {
  // Build from 8×8 via the recursive formula:
  // B16[y][x] = B8[y&7][x&7] * 4 + B4_sub[y>>3][x>>3]
  // where B4_sub is a 2×2 sub-selector: [[0,2],[3,1]] (standard 2×2 Bayer)
  const b4sub = [[0,2],[3,1]];
  const arr = new Uint8Array(256);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const b8 = DITHER8[(y & 7) * 8 + (x & 7)];
      const sub = b4sub[(y >> 3) & 1][(x >> 3) & 1];
      arr[y * 16 + x] = (b8 * 4 + sub) & 255;
    }
  }
  return arr;
})();

// 32×32 Bayer matrix — values 0..255 (mapped to 0..N²-1 range).
// Index as: DITHER32[(y & 31) * 32 + (x & 31)]
// Used for torch fill outer-zone (4–5 units from source) — very aggressive holes.
const DITHER32 = (() => {
  // Build from 16×16 via the same recursive step:
  // B32[y][x] = B16[y&15][x&15] * 4 + B4_sub[y>>4][x>>4] mapped to 0..255
  const b4sub = [[0,2],[3,1]];
  const arr = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const b16 = DITHER16[(y & 15) * 16 + (x & 15)];
      const sub  = b4sub[(y >> 4) & 1][(x >> 4) & 1];
      // Scale b16 (0..255) → 0..255 range with sub offset
      arr[y * 32 + x] = ((b16 >> 2) + sub * 64) & 255;
    }
  }
  return arr;
})();

// Index as: DITHER64[(y & 63) * 64 + (x & 63)]
// Used for torch fill far-edge zone (3.25–4 units) — maximum sparseness.
const DITHER64 = (() => {
  // Build from 32×32 via the same recursive step
  const b4sub = [[0,2],[3,1]];
  const arr = new Uint8Array(4096);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const b32 = DITHER32[(y & 31) * 32 + (x & 31)];
      const sub  = b4sub[(y >> 5) & 1][(x >> 5) & 1];
      arr[y * 64 + x] = ((b32 >> 2) + sub * 64) & 255;
    }
  }
  return arr;
})();

// Per-row cell-size LUT for variable-resolution dithering in _drawTexturedFloorCeiling.
// dy=1 (close, near horizon centre) → cellSize 1 (solid, no pattern).
// dy=mid (far, horizon edge) → cellSize 8.
// Precomputed so the inner loop only does an array read.
const _FC_CELL_LUT = new Uint8Array(H / 2 + 2);
{
  const mid = Math.floor(H / 2);
  for (let dy = 1; dy <= mid + 1; dy++) {
    // Linear interpolation: 1 at dy=1, 8 at dy=mid.
    const t = (dy - 1) / Math.max(1, mid - 1);   // 0..1
    const cs = 1 + (t * 7 + 0.5) | 0;            // 1..8
    _FC_CELL_LUT[dy] = Math.min(8, Math.max(1, cs));
  }
}

// Gem door tint colors
const GEM_TINTS = {
  3: '220,40,40',   // red
  4: '40,200,60',   // green
  5: '40,100,220',  // blue
};

// Number of fog darkness buckets for the sprite precache (0 = bright, N-1 = darkest)
const FOG_BUCKETS = 16;

export class Renderer {
  constructor(canvas, ctx, assets, map, raycaster, weaponManager, enemyAnims) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.assets = assets;
    this.map = map;
    this.raycaster = raycaster;
    /** @type {import('./assets.js').WeaponSpriteManager|null} */
    this.weaponManager = weaponManager || null;
    // Legacy alias kept so any external code referencing .weaponSprites still compiles
    this.weaponSprites = {};
    this.enemyAnims = enemyAnims || {};
    this.hatBrimImg = null;  // set externally when hat is equipped
    this.playerHasHat = false;
    this.zBuffer = new Float32Array(NUM_RAYS);

    // ── Pre-allocated torch light buffer — avoids a new Float32Array every frame.
    // Zeroed with .fill(0) at the start of _computeTorchLight() each frame.
    this._torchLightBuf = new Float32Array(NUM_RAYS);

    // ── Wall framebuffer state — tracks whether the wall framebuffer is dirty
    // this frame and needs a putImageData flush before sprite drawing begins.
    this._wallFBDirty = false;

    // ── Per-frame wall-column texture pointer cache.
    // Reused between _drawWallColumn() calls to avoid repeated WeakMap lookups
    // for the same wall texture within one frame.
    // Reset at the top of each render() call.
    this._wallTexPixels = null;   // Uint32Array — current wall texture pixels
    this._wallTexImg    = null;   // HTMLImageElement — last img used (cache key)

    this._flickerTimer = 0;
    this._flickerVal = 1.0;
    this._frameCount = 0;
    this._time = 0;

    // ── Quake-style letter-table flicker ──────────────────────────────────
    // a=0 (darkest) … z=1.0 (full bright).  Each character maps to
    // (charCode - 97) / 25 so the 26-step scale is perfectly linear.
    // Sequence strings define the flicker pattern; each light keeps its own
    // position (phase) index that advances every FLICKER_TICK frames.
    this._FLICKER_TICK  = 3;          // frames per step  (lower = faster)
    this._flickerStep   = 0;          // frame counter for global advance
    // Named sequences — mix of steady, soft pulse, and hard flicker
    this._FLICKER_SEQ = {
      // Quake-classic normal torch flicker
      torch:   'zzzzzzzzwwwtttwwwtwtwtwzzzzwtwwwtttw',
      // Slow strong pulse (braziers)
      brazier: 'abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba',
      // Flat world ambient — m is the default light level (constant mid-bright)
      normal:  'mmmmmmmmmmmmmmmm',
      // Fast strobe flicker (used as alternate torch pattern)
      flicker: 'mamamamamama',
      // Slow fade in/out
      pulse:   'abcdefghijklmnopqrstuvwxyzzyxwvutsrqponmlkjihgfedcba',
      // Custom sequence: qrstuvwvuutsrqp
      custom:  'qrstuvwvuutsrqp',
    };
    // Per-light flicker state: { seqName, phase }
    this._globalFlicker = { seqName: 'custom',  phase: 0 };
    this._torchFlicker  = [];   // re-used name; now holds { seqName, phase }
    this._brazierFlicker = new Map(); // di → { seqName, phase }

    // Helper: read current brightness from a named sequence at a given phase
    this._flickerRead = (seqName, phase) => {
      const seq = this._FLICKER_SEQ[seqName] || this._FLICKER_SEQ.normal;
      const c = seq.charCodeAt(phase % seq.length);
      return (c - 97) / 25;   // 'a'→0  'z'→1.0
    };

    // Offscreen sprite canvas for fog compositing (reused each frame)
    this._spriteCanvas = document.createElement('canvas');
    this._spriteCanvas.width  = W;
    this._spriteCanvas.height = H;
    this._spriteCtx = this._spriteCanvas.getContext('2d');
    this._spriteCtx.imageSmoothingEnabled = false;

    // ── Sprite precache: Map<HTMLImageElement|HTMLCanvasElement, Canvas[FOG_BUCKETS]>
    // Each entry is an array of FOG_BUCKETS canvases baked at native image resolution.
    // Bucket 0 = no fog, bucket N-1 = near-total darkness.
    // Only static single-image sprites use this path; animated frame canvases do not.
    this._spriteCache = new Map();

    // ── Brightmap cache: Map<img, Canvas> — one canvas per sprite image that
    // contains only the "self-luminous" red-eye pixels at full brightness.
    // Built lazily on first draw; Abomination sprites are never entered here.
    this._brightmapCache = new Map();

    // ── Halo ImageData buffer — shared across torch + brazier halos each frame.
    // One putImageData replaces thousands of per-pixel fillRect calls.
    this._haloImageData = new ImageData(W, H);

    // ── Floor/ceiling texture sampling cache.
    // Texture Images stay live in assets.js / modeditor.js, so cache entries are
    // invalidated when src/currentSrc or dimensions change.
    this._flatTexCache = new WeakMap();
    this._flatCanvas = document.createElement('canvas');
    this._flatCtx = this._flatCanvas.getContext('2d', { willReadFrequently: true });
    this._flatImageData = null;

    // ── Per-sector floor/ceil texture data cache.
    // Rebuilt lazily whenever sectorGrid reference changes (i.e. each level load / rebake).
    this._sectorTexCacheMap = null;   // last sectorGrid reference seen
    this._sectorTexCache    = new Map(); // sectorId → { floorTex, ceilTex, lightLevel, masks }

    // ── Corridor→room adjacency map for hallway bucket-culling bypass.
    // Maps corridor sectorId → Set<roomSectorId> of all directly adjacent room sectors.
    // Rebuilt whenever sectorGrid reference changes (same trigger as _sectorTexCacheMap).
    this._corridorAdjMap    = null;   // last sectorGrid reference seen
    this._corridorToRooms   = new Map(); // corridorSectorId → Set<roomSectorId>

    // ── Per-frame hallway LOS bypass cache.
    // Boolean array indexed by torch index — true if this torch should be treated
    // as "same room" because the player is in an adjacent corridor with LOS to it.
    // Built once per frame in render() before _computeTorchLight / _drawTorchRaycastFill.
    this._hallwayBypass     = [];
  }

  // ─────────────────────────────────────────────────────────
  // Precache phase — call once after Renderer is constructed,
  // before the first frame is rendered.
  // spriteList: array of HTMLImageElement (or HTMLCanvasElement).
  // For atlas sprites (gemKeys, decorSmall) the whole sheet is passed;
  // _drawSpriteIsolated handles the srcX/srcY sub-rect sampling from the baked canvas.
  // ────────────────────────────��──���─────────────────────────
  precacheSprites(spriteList) {
    for (const img of spriteList) {
      if (!img) continue;
      // HTMLCanvasElement is always ready; HTMLImageElement may still be loading.
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) continue; // not loaded yet — skip (will fall back to live path)
      if (this._spriteCache.has(img)) continue; // already cached

      const buckets = [];
      for (let b = 0; b < FOG_BUCKETS; b++) {
        const dark = b / (FOG_BUCKETS - 1); // 0.0 … 1.0
        const cvs = document.createElement('canvas');
        cvs.width  = w;
        cvs.height = h;
        const cx = cvs.getContext('2d');
        cx.imageSmoothingEnabled = false;
        // Draw sprite at native resolution
        cx.drawImage(img, 0, 0, w, h);
        // Apply fog only to opaque pixels via source-atop
        if (dark > 0.01) {
          cx.globalCompositeOperation = 'source-atop';
          cx.fillStyle = `rgba(0,0,0,${dark.toFixed(3)})`;
          cx.fillRect(0, 0, w, h);
          cx.globalCompositeOperation = 'source-over';
        }
        buckets.push(cvs);
      }
      this._spriteCache.set(img, buckets);
    }
  }

  // Build the full list of static world sprite images from assets and precache them.
  // Weapon sprites live in WeaponSpriteManager (their own offscreen canvas) and
  // are intentionally excluded from the fog-bucket precache.
  // Called from initLevel after renderer construction.
  // Accepts both HTMLImageElement and HTMLCanvasElement — the latter arrives after
  // precacheTextures() hot-swaps original Images with 128×128 atlas proxy canvases.
  precacheAllSprites() {
    const imgs = [];
    for (const img of Object.values(this.assets)) {
      if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) imgs.push(img);
    }
    // Weapons are omitted here — they live on WeaponSpriteManager's private canvas.
    // Wait for images to load then cache — split into two passes so partially-loaded
    // assets get picked up once they're ready.
    const tryCache = () => this.precacheSprites(imgs);
    tryCache();
    // Re-run after a short delay to catch anything still loading at construction time
    setTimeout(tryCache, 800);
    setTimeout(tryCache, 2500);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Brightmap helpers — extract and draw self-luminous eye pixels.
  //
  // A pixel is considered a "red eye" if:
  //   R > 140 && R > G*2.2 && R > B*2.2 && A > 40
  // This matches the vivid reds in goblin/spider/bat/boss eye sprites while
  // ignoring dark reds (flesh tones) and brown-reds.
  // Abomination sprites are never passed here (black eyes → void, no glow).
  // ─────────────────────────────────────────────────────────────────────────

  /** Build (or return cached) brightmap Canvas for img. Returns null if no red pixels found. */
  _getBrightmap(img) {
    if (this._brightmapCache.has(img)) return this._brightmapCache.get(img);

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w === 0 || h === 0) return null;

    // Read pixels from the source image via a temporary canvas.
    const tmpCvs = document.createElement('canvas');
    tmpCvs.width  = w;
    tmpCvs.height = h;
    const tmpCtx  = tmpCvs.getContext('2d', { willReadFrequently: true });
    tmpCtx.drawImage(img, 0, 0, w, h);
    let pixels;
    try { pixels = tmpCtx.getImageData(0, 0, w, h); }
    catch (e) { this._brightmapCache.set(img, null); return null; }

    // Build brightmap: keep only vivid red pixels, zero out all others.
    const data = pixels.data;
    let hasAny = false;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a > 40 && r > 180 && r > g * 4.5 && r > b * 4.5 && g < 60 && b < 60) {
        // Brighten the retained pixels slightly (they'll be composited over-top)
        data[i]   = Math.min(255, r + 30);
        data[i+1] = Math.min(255, g + 5);
        data[i+2] = Math.min(255, b + 5);
        // Keep alpha as-is (or slightly boost dim eyes)
        data[i+3] = Math.min(255, a + 40);
        hasAny = true;
      } else {
        // Fully transparent — this pixel is not a red eye
        data[i+3] = 0;
      }
    }

    if (!hasAny) {
      this._brightmapCache.set(img, null);
      return null;
    }

    const bmCvs = document.createElement('canvas');
    bmCvs.width  = w;
    bmCvs.height = h;
    bmCvs.getContext('2d').putImageData(pixels, 0, 0);
    this._brightmapCache.set(img, bmCvs);
    return bmCvs;
  }

  /**
   * Draw a brightmap overlay for an enemy sprite — red eye pixels only, at full
   * brightness regardless of ambient fog.  Respects z-buffer column clipping.
   * Adds a very faint red glow around the drawn pixels using the 'lighter' blend.
   */
  _drawBrightmapOverlay(ctx, img, left, top, width, height, dist) {
    const bm = this._getBrightmap(img);
    if (!bm) return;

    const clL = Math.max(0, left);
    const clR = Math.min(W, left + width);
    if (clL >= clR) return;

    const oY = Math.max(0, top);
    const oH = Math.min(H, top + height) - oY;
    if (oH <= 0) return;

    const bmW = bm.width;
    const bmH = bm.height;
    const scaleX = bmW / width;
    const scaleY = bmH / height;
    const topClip = oY - top;
    const srcYStart = topClip * scaleY;
    const srcYH = oH * scaleY;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // 'lighter' blending: red eye pixels add light to whatever's underneath,
    // making eyes appear to glow even in darkness.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.92;
    for (let sx = clL; sx < clR; sx++) {
      if (this.zBuffer[sx] <= dist) continue;
      const offX = sx - left;
      const bmSrcX = offX * scaleX;
      ctx.drawImage(bm,
        bmSrcX, srcYStart, Math.max(1, scaleX), srcYH,
        sx, oY, 1, oH);
    }
    ctx.restore();
  }

  /**
   * Draw a sprite image with fog/tint overlays and z-buffer column clipping.
   *
   * Fast path: if the overlay is pure fog darkness (applyOverlays === null or
   * the caller provides a _darkOnly hint via the 13th parameter), look up the
   * precached fog-baked canvas and blit directly — no per-frame offscreen clear.
   *
   * Slow path (live offscreen composite): used for complex overlays (pain flash,
   * boss glow, portal tint, etc.) where a simple darkness bake isn't enough.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLImageElement|HTMLCanvasElement} img
   * @param {number} left, top, width, height  — dest rect on main canvas
   * @param {number} dist                       — for z-buffer test
   * @param {function|null} applyOverlays       — callback(offCtx, l, t, w, h) or null
   * @param {number} [srcX] [srcY] [srcW] [srcH] — source sub-rect for atlas sprites
   * @param {number} [darkOnly]                 — if provided (0..1), use precache fast path
   *                                              with this darkness level instead of applyOverlays
   */
  _drawSpriteIsolated(ctx, img, left, top, width, height, dist, applyOverlays, srcX, srcY, srcW, srcH, darkOnly) {
    const clL = Math.max(0, left);
    const clR = Math.min(W, left + width);
    if (clL >= clR) return;
    let vis = false;
    for (let sx = clL; sx < clR; sx++) {
      if (this.zBuffer[sx] > dist) { vis = true; break; }
    }
    if (!vis) return;

    const oY = Math.max(0, top);
    const oH = Math.min(H, top + height) - oY;
    if (oH <= 0) return;

    const oX = left; // screen-space X origin of sprite

    // ── Fast path: precached fog bucket ──────────────────────────────────────
    // Use when: (a) no overlay at all, OR (b) overlay is pure darkness (_darkOnly hint).
    // Animated frame canvases (from SpriteSheet) typically aren't cached and fall through.
    const useDark = (darkOnly !== undefined) ? darkOnly : (applyOverlays === null ? 0 : -1);
    if (useDark >= 0) {
      const buckets = this._spriteCache.get(img);
      if (buckets) {
        // Pick the nearest fog bucket
        const bIdx = Math.round(Math.min(1, useDark) * (FOG_BUCKETS - 1));
        const baked = buckets[bIdx];
        const imgW  = baked.width;
        const imgH  = baked.height;
        // Compute the source sub-rect in the baked (native-res) canvas that maps
        // to the visible screen columns, accounting for atlas sub-rect if present.
        const scaleX = imgW / width;   // native px per screen px
        const scaleY = imgH / height;  // native px per screen px
        const atlasOffX = (srcX !== undefined) ? (srcX / (img.naturalWidth  || img.width)  * imgW) : 0;
        const atlasOffY = (srcY !== undefined) ? (srcY / (img.naturalHeight || img.height) * imgH) : 0;
        const atlasW    = (srcW !== undefined) ? (srcW / (img.naturalWidth  || img.width)  * imgW) : imgW;
        const atlasH    = (srcH !== undefined) ? (srcH / (img.naturalHeight || img.height) * imgH) : imgH;

        // Compute the vertical clip: oY is the clamped screen top, top may be negative
        // when the sprite overflows the top of the screen.  We must sample only the
        // visible slice of the baked image so the sprite is never squashed.
        const scaleYBaked = atlasH / height;          // baked rows per screen row
        const topClip     = oY - top;                  // screen rows cropped from the top
        const srcYStart   = atlasOffY + topClip * scaleYBaked;
        const srcYHeight  = oH * scaleYBaked;

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (let sx = clL; sx < clR; sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          const offX = sx - oX;               // column within dest sprite (0..width-1)
          const bakedX = atlasOffX + offX * (atlasW / width);
          ctx.drawImage(baked,
            bakedX, srcYStart, atlasW / width, srcYHeight,
            sx, oY, 1, oH);
        }
        ctx.restore();
        return;
      }
      // Cache miss (image not yet loaded at precache time) — fall through to live path
    }

    // ── Slow / live path: offscreen canvas composite ──────────────────────────
    const oW = width;
    const sc = this._spriteCtx;
    // Grow offscreen canvas as needed (never shrink — avoids realloc)
    if (this._spriteCanvas.width < oW || this._spriteCanvas.height < oH) {
      this._spriteCanvas.width  = Math.max(this._spriteCanvas.width,  oW);
      this._spriteCanvas.height = Math.max(this._spriteCanvas.height, oH);
      sc.imageSmoothingEnabled = false;
    }
    sc.clearRect(0, 0, oW, oH);

    const drawTop = top - oY;
    if (srcW !== undefined) {
      sc.drawImage(img, srcX, srcY, srcW, srcH, 0, drawTop, width, height);
    } else {
      sc.drawImage(img, 0, drawTop, width, height);
    }

    if (applyOverlays) {
      sc.globalCompositeOperation = 'source-atop';
      applyOverlays(sc, 0, drawTop, width, height);
      sc.globalCompositeOperation = 'source-over';
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let sx = clL; sx < clR; sx++) {
      if (this.zBuffer[sx] <= dist) continue;
      const offX = sx - oX;
      ctx.drawImage(this._spriteCanvas, offX, 0, 1, oH, sx, oY, 1, oH);
    }
    ctx.restore();
  }

  render(player, enemies, muzzleFlash, paused, projectiles, hitEffects, nearSecretWall, secretWallData, activeWeapon, bloodParticles, explosionEffects) {
    this._activeWeapon = activeWeapon;
    // Normalize activeWeapon to its string ID for FLASH_IDS lookups
    const activeWeaponId = (activeWeapon && typeof activeWeapon === 'object') ? activeWeapon.id : (activeWeapon || 'pistol');
    const ctx = this.ctx;
    this._frameCount++;
    this._time += 0.016;

    // ── Advance all flicker sequences every FLICKER_TICK frames ────────────
    this._flickerStep++;
    const _doStep = (this._flickerStep % this._FLICKER_TICK) === 0;

    // Global ambient flicker
    if (_doStep) this._globalFlicker.phase++;
    this._flickerVal = this._flickerRead(
      this._globalFlicker.seqName,
      this._globalFlicker.phase
    );

    // Per-torch flicker (each torch is offset by its index so they drift apart)
    const torches = this.map.torches || [];
    while (this._torchFlicker.length < torches.length) {
      const offset = this._torchFlicker.length * 7; // stagger starting phase
      this._torchFlicker.push({ seqName: 'torch', phase: offset });
    }
    if (_doStep) {
      for (let i = 0; i < torches.length; i++) {
        this._torchFlicker[i].phase++;
      }
    }
    // Expose .val for all downstream code that reads tf.val
    for (let i = 0; i < torches.length; i++) {
      const tf = this._torchFlicker[i];
      tf.val = this._flickerRead(tf.seqName, tf.phase);
    }

    // Per-brazier flicker (keyed by index in decor array)
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      if (!this._brazierFlicker.has(di)) {
        this._brazierFlicker.set(di, { seqName: 'brazier', phase: di * 11 });
      }
      const bf = this._brazierFlicker.get(di);
      if (_doStep) bf.phase++;
      bf.val = this._flickerRead(bf.seqName, bf.phase);
    }

    ctx.imageSmoothingEnabled = false;

    // ── Raycasting — must happen before floor/ceiling so the flat caster
    // can use the same per-column ray angles as the wall pass.
    // castAll() returns `this` (the raycaster); typed arrays are read directly
    // to avoid getter-object dispatch (was 2240 getter calls/frame).
    this.raycaster.castAll(player.x, player.y, player.angle, NUM_RAYS, FOV);
    const _hitDist     = this.raycaster._hitDist;
    const _hitSide     = this.raycaster._hitSide;
    const _hitWallX    = this.raycaster._hitWallX;
    const _hitMapX     = this.raycaster._hitMapX;
    const _hitMapY     = this.raycaster._hitMapY;
    const _hitPrevMapX = this.raycaster._hitPrevMapX;
    const _hitPrevMapY = this.raycaster._hitPrevMapY;
    // hits is kept as a thin compatibility shim for this.lastHits / _markFogLOS.
    // It is an object with the same named typed-array fields the old accessor had.
    const hits = {
      _dist: _hitDist, _mapX: _hitMapX, _mapY: _hitMapY,
      _wallX: _hitWallX, _prevMapX: _hitPrevMapX, _prevMapY: _hitPrevMapY,
      _side: _hitSide,
    };
    this.lastHits = hits; // exposed for main.js _markFogLOS()

    // ── Camera plane for floor/ceiling caster — stable, SoA-independent.
    // Computed once per frame from player.angle (2 trig calls).
    // Replaces the rotation-matrix path that depended on _soaRdxF being in sync.
    {
      const _pa     = player.angle;
      const _cdx    = Math.cos(_pa);
      const _cdy    = Math.sin(_pa);
      // Camera plane is the vector perpendicular to camDir, scaled by tan(FOV/2).
      // Perpendicular (right-hand): (-cdy, cdx) * tanHalfFov
      const _tHF    = _FC_TAN_HALF_FOV;
      const _plx    = -_cdy * _tHF;
      const _ply    =  _cdx * _tHF;
      // Left ray  = camDir - camPlane  (column 0 = left edge of frustum)
      // Right ray = camDir + camPlane  (column W-1 = right edge of frustum)
      this._fcRayLX  = _cdx - _plx;
      this._fcRayLY  = _cdy - _ply;
      this._fcRayRX  = _cdx + _plx;
      this._fcRayRY  = _cdy + _ply;
      this._fcSpanX  = this._fcRayRX - this._fcRayLX;  // = 2 * _plx
      this._fcSpanY  = this._fcRayRY - this._fcRayLY;  // = 2 * _ply
    }

    // ── Reset per-frame wall state.
    // Zero-fill the entire framebuffer so floor/ceiling rows from a previous
    // frame don't persist as a Hall of Mirrors behind newly drawn wall columns.
    // This is a single typed-array memset — one operation for 256 KB.
    _wallFB.fill(0);
    this._wallTexImg    = null;
    this._wallTexPixels = null;
    this._wallFBDirty   = true;   // will be flushed after stickers
    _occlude.fill(0);

    // Reset depth buffer to Infinity so sprite depth-tests see unwritten columns
    // as fully transparent (i.e. any sprite can draw into them).  The old pattern
    // of leaving stale values from the previous frame caused two classes of bug:
    //   (a) a column where BSP returned null AND DDA had dist=0 (open-space miss)
    //       stayed at 0, permanently occluding every sprite in that column.
    //   (b) interior wall faces exclusive to the new wall system (not in the DDA
    //       hit list) left stale depths that confused the sprite depth sorter.
    this.zBuffer.fill(Infinity);

    // ── Ceiling + floor — write directly into _wallFB so they share the
    // single putImageData flush with the wall columns.
    // _drawTexturedFloorCeiling writes into _wallFB and returns true.
    // _drawCeiling/_drawFloor copy gradient LUT rows into _wallFB.
    if (!this._drawTexturedFloorCeiling(ctx, player)) {
      this._drawCeiling(ctx);
      this._drawFloor(ctx);
    }

    // ── Hallway bucket-culling bypass — must run before _computeTorchLight
    // and _drawTorchRaycastFill so both share the same per-torch LOS cache.
    this._buildHallwayBypass(player, torches);

    // ── Per-column torch light (includes braziers)
    const torchLight = this._computeTorchLight(player, torches);
    this._torchLight = torchLight; // expose for boss green-glow interaction

    // ── Walls — BSP column renderer (sole wall-draw path)
    // DDA hits are still cast (needed for stickers + floor/ceil sampling)
    // but are NOT used for wall drawing — BSP segs own all wall faces.
    {
      // Pre-cast per-column ray angles (float — needed by sticker/torch code)
      if (!this._rayAngles || this._rayAngles.length !== NUM_RAYS) {
        this._rayAngles = new Float32Array(NUM_RAYS);
      }
      // Pre-allocated per-frame ray-direction arrays — eliminates 640 Math.cos/sin calls
      // inside _castBSPColumn (one cos+sin per column × 320 columns/frame).
      if (!this._soaRdxF || this._soaRdxF.length !== NUM_RAYS) {
        this._soaRdxF = new Float32Array(NUM_RAYS);
        this._soaRdyF = new Float32Array(NUM_RAYS);
      }

      // Player BAM direction — single table lookup shared by all 320 columns.
      const _bspBam    = radToBAM(player.angle);
      const _bspCamCos = CosineTable[_bspBam] / FP_ONE;
      const _bspCamSin = SineTable[_bspBam]   / FP_ONE;
      const _bspQ14    = 16384;
      const _bspSoaCos = this.raycaster._soaCos;
      const _bspSoaSin = this.raycaster._soaSin;

      const halfFov = FOV / 2;
      for (let i = 0; i < NUM_RAYS; i++) {
        this._rayAngles[i] = player.angle - halfFov + (i / (NUM_RAYS - 1)) * FOV;
        // Rotate camera-relative Q1.14 SoA direction by player angle via BAM tables.
        if (_bspSoaCos) {
          const cx = _bspSoaCos[i] / _bspQ14;
          const cy = _bspSoaSin[i] / _bspQ14;
          this._soaRdxF[i] = _bspCamCos * cx - _bspCamSin * cy;
          this._soaRdyF[i] = _bspCamSin * cx + _bspCamCos * cy;
        } else {
          // Fallback for first-frame edge case (SoA not yet built)
          this._soaRdxF[i] = Math.cos(this._rayAngles[i]);
          this._soaRdyF[i] = Math.sin(this._rayAngles[i]);
        }
      }

      for (let i = 0; i < NUM_RAYS; i++) {
        const bspHit = this._castBSPColumn(i, player);
        if (bspHit) {
          this.zBuffer[i] = bspHit.dist;
          this._drawBSPWallColumn(i, bspHit, player, torchLight[i]);
        }
        // BSP miss = open space; column stays empty (zBuffer = Infinity).
      }
    }

    // ── Stickers (bullet holes, scorch marks) blit into _wallFB before flush
    this._drawWallStickers(player);

    // ── Torch wall glows — additive orange bloom written into _wallFB so they
    // sit on the wall surface rather than floating in front of it.
    this._drawTorchWallGlows(torches, player);

    // ── Raycast-based torch + brazier light fill into floor/ceiling pixels
    this._drawTorchRaycastFill(torches, player);

    // ── Single putImageData for floor + ceiling + walls + stickers
    this._flushWallFB(ctx);

    // ── Floor halos under torches + braziers (braziers only now; torches use raycast fill)
    this._drawTorchFloorHalos(ctx, player, torches);
    this._drawBrazierFloorHalos(ctx, player);

    // ── Sprites (enemies + decor + pickups + torches + portal + projectiles)
    this._drawSprites(ctx, player, enemies, projectiles || []);

    // ── Blood particles (1×1 red pixels projected to screen)
    if (bloodParticles && bloodParticles.length > 0) {
      this._drawBloodParticles(ctx, player, bloodParticles);
    }

    // ── Cannon explosion effects (billboard sprite, squash→scale→fade)
    if (explosionEffects && explosionEffects.length > 0) {
      this._drawExplosions(ctx, player, explosionEffects);
    }

    // ── Muzzle flash sprite overlay (between world sprites and weapon layer) ──
    if (muzzleFlash && this.assets.muzzleFlash && FLASH_IDS.has(activeWeaponId)) {
      const flashIntensity = (typeof muzzleFlash === 'number') ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0;
      if (flashIntensity > 0 && this.assets.muzzleFlash.complete && this.assets.muzzleFlash.naturalWidth > 0) {
        const mf = this.assets.muzzleFlash;
        // Scale flash image to fill ~half the screen height, centered on canvas
        const mfH = Math.round(H * 0.5 * flashIntensity);
        const mfW = Math.round(mfH * (mf.naturalWidth / mf.naturalHeight));
        const mfX = Math.round(W / 2 - mfW / 2);
        const mfY = Math.round(H / 2 - mfH / 2 + 40);
        ctx.save();
        ctx.globalAlpha = Math.min(1, flashIntensity * 1.2);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(mf, mfX, mfY, mfW, mfH);
        ctx.restore();
      }
    }

    // ── Weapon (gun with sway, bob, tilt, kick) — muzzle flash is composited
    // directly onto the weapon offscreen canvas so it never touches #000 pixels
    this._drawGun(ctx, player, muzzleFlash);

    // ── Hat brim overlay (when hat is equipped)
    if (this.playerHasHat && this.hatBrimImg && this.hatBrimImg.complete && this.hatBrimImg.naturalWidth > 0) {
      ctx.drawImage(this.hatBrimImg, 0, 0, W, H);
    }

    // ── VGA scanlines
    this._drawScanlines(ctx);

    // ── Vignette
    this._drawVignette(ctx);

    // ── Secret wall USE prompt
    if (nearSecretWall && secretWallData && !secretWallData.opened) {
      const pulse = 0.7 + 0.3 * Math.sin(this._time * 6);

      let treasureLabel, treasureColor, borderColor;
      if (secretWallData.isGemDoor) {
        const colorNames = { red: 'RED', green: 'GREEN', blue: 'BLUE' };
        const cname = colorNames[secretWallData.gemColor] || 'GEM';
        treasureLabel = `the magical gem unlocks the door...`;
        const tintRgb = secretWallData.gemColor === 'red' ? '255,80,80'
                      : secretWallData.gemColor === 'green' ? '80,255,100'
                      : '80,150,255';
        treasureColor = `rgba(${tintRgb},${pulse})`;
        borderColor   = treasureColor;
      } else {
        treasureLabel = secretWallData.treasure === 'health' ? '[E] SECRET — HEALTH!'
                      : secretWallData.treasure === 'ammo'   ? '[E] SECRET — AMMO!'
                      :                                         '[E] SECRET — TREASURE!';
        treasureColor = secretWallData.treasure === 'health' ? `rgba(0,255,120,${pulse})`
                      : secretWallData.treasure === 'ammo'   ? `rgba(255,220,0,${pulse})`
                      :                                         `rgba(220,180,255,${pulse})`;
        borderColor   = secretWallData.treasure === 'health' ? `rgba(0,200,80,${pulse})`
                      : secretWallData.treasure === 'ammo'   ? `rgba(200,160,0,${pulse})`
                      :                                         `rgba(180,120,255,${pulse})`;
      }

      ctx.save();
      ctx.font = `bold 9px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(0,0,0,${0.65 * pulse})`;
      ctx.fillRect(W / 2 - 50, H / 2 - 24, 100, 16);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(W / 2 - 50, H / 2 - 24, 100, 16);
      ctx.fillStyle = treasureColor;
      ctx.fillText(treasureLabel, W / 2, H / 2 - 12);
      ctx.restore();
    }

    // ── Pause overlay — solid black fill only; HTML menu draws UI on top
    if (paused) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Torch lighting computation (includes braziers)
  // Uses this._torchLightBuf — pre-allocated, zeroed at start of each call.
  // No heap allocation per frame.
  // ─────────────────────────────────────────────────────────
  _computeTorchLight(player, torches) {
    // Reuse pre-allocated buffer — reset to zero with a single typed-array fill.
    const light = this._torchLightBuf;
    light.fill(0);

    // Read hit distances directly from the raycaster typed array.
    // castAll() has already been called this frame by draw() before this method.
    const _hitDist = this.raycaster._hitDist;

    const halfFov = FOV / 2;
    const TORCH_LIGHT_DIST = 8;
    const BRAZIER_LIGHT_DIST = 4;

    // Use float cos/sin (not BAM table) so the torch column center tracks the
    // same float player.angle that the wall renderer and _inFrustum use.
    const dirX2 = Math.cos(player.angle);
    const dirY2 = Math.sin(player.angle);

    // Precomputed column-mapping constant: maps r=cross/dot (tan-space ratio) to column.
    // centerCol = floor(((fastAtan(r) + halfFov) / FOV) * W)
    // Instead of calling fastAtan per torch we compute centerCol directly from r:
    //   r = cross/dot; col = floor((r / tanHalfFov + 1) * 0.5 * W)
    // This is exact for linear (non-atan) mapping; error vs atan2 is < 1 column for FOV=72°.
    // We use the same cull threshold: |r| <= tan(halfFov + margin).
    const _tanHFov = Math.tan(halfFov); // = tan(PI/5) ≈ 0.7265 — constant, computed once here

    // ── Bucket culling — same-room sector check ──
    // Torches in the same sector as the player bypass the distance/frustum cull
    // so their wall illumination contribution is never dropped while you share a room.
    const _ctSG   = this.map && this.map.sectorGrid;
    const _ctMapW = this.map ? this.map.width  : 0;
    const _ctMapH = this.map ? this.map.height : 0;
    const _ctPgx  = (player.x | 0), _ctPgy = (player.y | 0);
    const _ctPSec = (_ctSG && _ctPgx >= 0 && _ctPgx < _ctMapW && _ctPgy >= 0 && _ctPgy < _ctMapH)
      ? _ctSG[_ctPgy * _ctMapW + _ctPgx] : -1;

    // ── Regular torches ──
    for (let i = 0; i < torches.length; i++) {
      const t = torches[i];
      const tf = this._torchFlicker[i] || { val: 1 };
      const flickerBrightness = tf.val;

      const dx = t.x - player.x;
      const dy = t.y - player.y;
      const distSq = dx * dx + dy * dy;

      // Same-room bypass: never cull a torch that's in the same sector as the player,
      // or is in an adjacent room that the player can see from their corridor (hallway bypass).
      const _ctTgx = (t.x | 0), _ctTgy = (t.y | 0);
      const _ctTSec = (_ctSG && _ctTgx >= 0 && _ctTgx < _ctMapW && _ctTgy >= 0 && _ctTgy < _ctMapH)
        ? _ctSG[_ctTgy * _ctMapW + _ctTgx] : -1;
      const _ctSameRoom = (_ctPSec >= 0 && _ctPSec === _ctTSec)
                       || (this._hallwayBypass[i] === true);

      if (!_ctSameRoom && distSq > TORCH_LIGHT_DIST * TORCH_LIGHT_DIST) continue;

      // BAM-based dot/cross — no per-torch trig call.
      const dot2   =  dx * dirX2 + dy * dirY2;
      const cross2 =  dx * dirY2 - dy * dirX2;
      if (dot2 <= 0) continue;

      // Frustum cull: |cross/dot| <= tan(halfFov + 0.5) — no division needed.
      const absC2 = cross2 < 0 ? -cross2 : cross2;
      if (absC2 > dot2 * _frustumHalfTan) continue;

      // dist via fastInvSqrt; cross/dot ratio → centerCol without atan2.
      const invDist = fastInvSqrt(distSq);   // 1/dist, ~0.175% error
      const dist    = 1 / invDist;
      const r2 = cross2 / dot2;
      const centerCol = Math.floor((r2 / _tanHFov + 1) * 0.5 * W);

      const torchBright = flickerBrightness * Math.max(0, 1 - dist / 6.0);
      const radius = Math.floor(W * 0.75 * (1 - dist / TORCH_LIGHT_DIST));
      if (radius < 1) continue;

      const colStart = Math.max(0, centerCol - radius);
      const colEnd   = Math.min(W, centerCol + radius);
      const invR1    = _SS_LUT_N / (radius + 1);             // scale factor: t*_SS_LUT_N in one mul
      for (let col = colStart; col < colEnd; col++) {
        const absDiff = col - centerCol;
        const tIdx    = ((absDiff < 0 ? -absDiff : absDiff) * invR1 + 0.5) | 0; // |t| * N
        const falloff = _SS_LUT[tIdx < _SS_LUT_N ? tIdx : _SS_LUT_N];
        const wallDist = col < NUM_RAYS ? _hitDist[col] : 256;
        if (dist < wallDist + 0.5) {
          light[col] = Math.max(light[col], torchBright * falloff);
        }
      }
    }

    // ── Braziers as light sources ──
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      const bf = this._brazierFlicker.get(di) || { val: 1 };

      const dx = d.x - player.x;
      const dy = d.y - player.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > BRAZIER_LIGHT_DIST * BRAZIER_LIGHT_DIST) continue;

      // Reuse the player BAM direction computed above.
      const dotB   =  dx * dirX2 + dy * dirY2;
      const crossB =  dx * dirY2 - dy * dirX2;
      if (dotB <= 0) continue;

      // Frustum cull without atan2.
      const absCB = crossB < 0 ? -crossB : crossB;
      if (absCB > dotB * _frustumHalfTan) continue;

      const invDistB = fastInvSqrt(distSq);  // 1/dist
      const dist     = 1 / invDistB;
      const rB = crossB / dotB;
      const centerCol = Math.floor((rB / _tanHFov + 1) * 0.5 * W);

      const brazBright = bf.val * Math.max(0, 1 - dist / 5.0) * 0.75;
      const radius = Math.floor(W * 0.2 * (1 - dist / BRAZIER_LIGHT_DIST));
      if (radius < 1) continue;

      const colStart = Math.max(0, centerCol - radius);
      const colEnd   = Math.min(W, centerCol + radius);
      const invR1B   = _SS_LUT_N / (radius + 1);
      for (let col = colStart; col < colEnd; col++) {
        const absDiff = col - centerCol;
        const tIdx    = ((absDiff < 0 ? -absDiff : absDiff) * invR1B + 0.5) | 0;
        const falloff = _SS_LUT[tIdx < _SS_LUT_N ? tIdx : _SS_LUT_N];
        const wallDist = col < NUM_RAYS ? _hitDist[col] : 999;
        if (dist < wallDist + 0.5) {
          light[col] = Math.max(light[col], brazBright * falloff);
        }
      }
    }

    return light;
  }

  // ─────────────────────────────────────────────────────────
  // Ceiling + floor gradient — ImageData LUT path.
  // Per-row colors are baked into a Uint32Array once per theme change
  // (detected via a theme-key string), then written to the canvas as a
  // single putImageData call instead of H individual fillRect+string ops.
  // ─────────────────────────────────────────────────────────

  /** Invalidate gradient LUTs whenever the map/theme changes (call after level load) */
  invalidateGradientLUT() {
    this._gradLUTKey    = null;
    this._gradImageData = null;
  }

  /**
   * Bake (or re-bake) light-reach tables for all torches on the current map.
   * Call once after each level load, after map.torches is populated.
   * Each torch gets a _patchReach Float32Array and _patchFaceAngle stored on it,
   * so _drawTorchRaycastFill() can do pure table lookups with zero isWall calls.
   */
  rebakeTorchPatches() {
    const torches = this.map && this.map.torches;
    if (torches && torches.length) this.bakeTorchLightPatches(torches);
  }

  /**
   * Destroy all torches mounted on a wall tile that is being opened/removed.
   *
   * Call this at the same point you call raycaster.clearStickers() when a
   * secret wall opens (or any wall is destroyed).  It:
   *   1. Finds every torch whose backing wall tile matches (wallX/wallY, or
   *      falls back to adjacency scan for torches placed without a baked wallX).
   *   2. Removes those torches from map.torches (splice — keeps array compact).
   *   3. Keeps _torchFlicker in sync by splicing the same indices.
   *   4. Clears the wall sticker via raycaster.clearStickers().
   *   5. Rebakes the light-patch tables for the surviving torches so the
   *      newly-open space is reflected in reach distances.
   *
   * @param {number} wallMapX  - grid X of the wall tile being opened
   * @param {number} wallMapY  - grid Y of the wall tile being opened
   */
  destroyTorchesOnWall(wallMapX, wallMapY) {
    const torches = this.map && this.map.torches;
    if (!torches || torches.length === 0) return;

    // Collect indices to remove (iterate backwards so splice doesn't shift live indices).
    const toRemove = [];
    for (let i = 0; i < torches.length; i++) {
      const t  = torches[i];

      // Primary match: torch has a baked wallX/wallY pointing at this tile.
      if (t.wallX != null) {
        if (t.wallX === wallMapX && t.wallY === wallMapY) toRemove.push(i);
        continue;
      }

      // Fallback: torch has no baked wallX — check all 4 cardinal neighbours.
      // A torch is "on" this wall if any of its 4 adjacent tiles is the wall tile.
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      if (
        (gx === wallMapX && gy - 1 === wallMapY) ||
        (gx === wallMapX && gy + 1 === wallMapY) ||
        (gx - 1 === wallMapX && gy === wallMapY) ||
        (gx + 1 === wallMapX && gy === wallMapY)
      ) {
        toRemove.push(i);
      }
    }

    if (toRemove.length === 0) return;

    // Remove in reverse-index order so earlier splices don't shift later ones.
    for (let k = toRemove.length - 1; k >= 0; k--) {
      const i = toRemove[k];
      torches.splice(i, 1);
      // Keep _torchFlicker array in sync — same index, same length.
      if (this._torchFlicker.length > i) this._torchFlicker.splice(i, 1);
    }

    // Clear the wall sticker (also patches distToWall so DDA inner-face cull is correct).
    this.raycaster.clearStickers(wallMapX, wallMapY);

    // Rebake only the torches whose light patch could be affected by this wall opening.
    // A torch is dirty if the opened tile falls within its PATCH_REACH radius —
    // any further away and none of its baked rays could have been blocked by this tile.
    const reach = Renderer.PATCH_REACH;
    const wx = wallMapX + 0.5, wy = wallMapY + 0.5;  // centre of opened tile
    for (const t of torches) {
      const ddx = t.x - wx, ddy = t.y - wy;
      if (ddx * ddx + ddy * ddy <= reach * reach) this._bakeTorchPatch(t);
    }
  }

  /**
   * Invalidate the wall texture pixel cache for a specific image (or all images
   * if img is omitted).  Call this when ModEditor hot-swaps a wall texture so
   * the new pixels are re-sampled on the next frame.
   */
  invalidateTexCache(img) {
    if (img) {
      _texCache.delete(img);
    } else {
      // WeakMap has no .clear() — replace the module-level cache entries
      // by nuking the per-frame pointer so the next _drawWallColumn() misses.
      this._wallTexImg    = null;
      this._wallTexPixels = null;
      // Individual WeakMap entries will be GC'd when their keys (HTMLImageElements)
      // are re-assigned new src values by ModEditor.
    }
  }

  /** Lazily rebuild the ceiling+floor gradient ImageData if the theme changed */
  _rebuildGradientLUT() {
    const theme   = this.map.theme;
    const isAbom  = !!(this.map && this.map.isAbominationLevel);

    // Derive a cheap cache key from theme + abom flag
    const tKey = theme
      ? `${theme.ceiling}-${theme.ceilTop}-${theme.floorTint}-${isAbom}`
      : `default-${isAbom}`;

    if (this._gradLUTKey === tKey && this._gradImageData) return;
    this._gradLUTKey = tKey;

    // SOR-style gradient: near-black base with faint cool/blue undertone in shadows.
    // The actual texture+shade is painted over this by _drawTexturedFloorCeiling,
    // so this mainly controls the untextured fallback and the very-far horizon tone.
    // Ceiling: very dark, slight cool blue-grey tint (SOR upper-stage darkness)
    let [cr, cg, cb] = theme ? [
      Math.max(3, (theme.ceiling[0] * 0.25) | 0),
      Math.max(3, (theme.ceiling[1] * 0.25) | 0),
      Math.max(5, (theme.ceiling[2] * 0.32) | 0)
    ] : [3, 3, 6];
    let [tr, tg, tb] = [2, 2, 4];
    if (isAbom) { [cr, cg, cb] = [6, 1, 10]; [tr, tg, tb] = [3, 0, 6]; }

    // Floor: near-black with a very faint warm brown at horizon (texture obscures it)
    let [fr, fg, fb] = theme ? [
      Math.max(4, (theme.floorTint[0] * 0.20) | 0),
      Math.max(3, (theme.floorTint[1] * 0.18) | 0),
      Math.max(2, (theme.floorTint[2] * 0.15) | 0)
    ] : [5, 3, 2];
    if (isAbom) { [fr, fg, fb] = [8, 2, 12]; }

    const mid  = Math.floor(H / 2);
    const imgd = new ImageData(W, H);
    const buf  = new Uint32Array(imgd.data.buffer);
    const isLE = (new Uint32Array(new Uint8Array([1,0,0,0]).buffer))[0] === 1;
    // In little-endian (virtually all platforms): buf word = AABBGGRR

    const pack = isLE
      ? (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0
      : (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;

    // Ceiling rows (0 .. mid-1)
    for (let y = 0; y < mid; y++) {
      const t = y / mid;
      const r = (tr + t * (cr - tr)) | 0;
      const g = (tg + t * (cg - tg)) | 0;
      const b = (tb + t * (cb - tb)) | 0;
      const color = pack(r, g, b);
      const rowStart = y * W;
      for (let x = 0; x < W; x++) buf[rowStart + x] = color;
    }

    // Floor rows (mid .. H-1)
    const floorSpan = H - mid;
    for (let y = mid; y < H; y++) {
      const t = (y - mid) / floorSpan;
      const v = 1 - t * 0.65;
      const r = (fr * v) | 0;
      const g = (fg * v) | 0;
      const b = (fb * v) | 0;
      const color = pack(r, g, b);
      const rowStart = y * W;
      for (let x = 0; x < W; x++) buf[rowStart + x] = color;
    }

    this._gradImageData = imgd;
  }

  _drawCeiling(ctx) {
    this._rebuildGradientLUT();
    if (!this._gradImageData) return;
    // Copy ceiling rows from the gradient LUT directly into _wallFB.
    // putImageData is no longer called here — the combined flush happens in _flushWallFB().
    const src = new Uint32Array(this._gradImageData.data.buffer);
    const mid = Math.floor(H / 2);
    // Copy ceiling half (rows 0 .. mid-1) — typed set is a vectorised memcpy.
    _wallFB.set(src.subarray(0, mid * W), 0);
  }

  _drawFloor(ctx) {
    if (!this._gradImageData) return;
    // Copy floor rows from the gradient LUT directly into _wallFB.
    const src = new Uint32Array(this._gradImageData.data.buffer);
    const mid = Math.floor(H / 2);
    _wallFB.set(src.subarray(mid * W), mid * W);
  }

  // ────────────��────────────────────────────────────────────
  // Textured floor/ceiling casting — samples the live image assets directly.
  // This keeps ModEditor hot-swaps and FULL_RES_KEYS behavior intact.
  // ─────���────────────────────���──────────────────────────────

  _resolveFlatTextureKey(kind) {
    const theme = this.map && this.map.theme ? this.map.theme : null;
    const isCeil = kind === 'ceil';
    const themeName = String((theme && (
      theme.name ||
      theme.id ||
      theme.key ||
      theme.wallKey ||
      theme.wallTex ||
      theme.wallTexture ||
      theme.wall
    )) || '').toLowerCase();
    const isLibrary = themeName.includes('library');

    const explicitFloor = theme && (
      theme.floorTex ||
      theme.floorTexture ||
      theme.floorKey ||
      theme.floor
    );

    // Library ceilings need the old floor-style flat projection instead of the
    // wall-material ceiling projection. Reuse the library floor texture unless
    // the theme explicitly provides a ceiling texture/key.
    if (isCeil && isLibrary) {
      const explicitCeil = theme && (
        theme.ceilTex ||
        theme.ceilingTex ||
        theme.ceilTexture ||
        theme.ceilingTexture ||
        theme.ceilKey ||
        theme.ceilingKey
      );
      if (explicitCeil && this.assets[explicitCeil]) return explicitCeil;
      if (explicitFloor && this.assets[explicitFloor]) return explicitFloor;
      if (this.assets.floorLibrary) return 'floorLibrary';
    }

    // Non-library ceilings intentionally use the active wall texture so each
    // biome feels boxed-in by the same material.
    if (isCeil) {
      const wallKey = theme && (theme.wallKey || theme.wallTex || theme.wallTexture || theme.wall);
      if (wallKey && this.assets[wallKey]) return wallKey;
      return this.assets.wall ? 'wall' : null;
    }

    if (explicitFloor && this.assets[explicitFloor]) return explicitFloor;

    // Sensible defaults for the current three shipped floor textures.
    if (this.map && this.map.isAbominationLevel && this.assets.floorAbomination) return 'floorAbomination';

    if (isLibrary && this.assets.floorLibrary) return 'floorLibrary';
    if ((themeName.includes('cave') || themeName.includes('dungeon')) && this.assets.floorCave) return 'floorCave';

    return this.assets.floorCave ? 'floorCave' : (this.assets.floor ? 'floor' : null);
  }

  _getFlatTextureData(img) {
    if (!img) return null;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w <= 0 || h <= 0) return null;
    if (img instanceof HTMLImageElement && (!img.complete || img.naturalWidth <= 0)) return null;

    const srcKey = (img.currentSrc || img.src || 'canvas') + `|${w}x${h}`;
    const cached = this._flatTexCache.get(img);
    if (cached && cached.key === srcKey) return cached;

    this._flatCanvas.width = w;
    this._flatCanvas.height = h;
    this._flatCtx.clearRect(0, 0, w, h);
    this._flatCtx.drawImage(img, 0, 0, w, h);
    const data = this._flatCtx.getImageData(0, 0, w, h).data;
    const entry = { key: srcKey, w, h, data };
    this._flatTexCache.set(img, entry);
    return entry;
  }

  _drawTexturedFloorCeiling(ctx, player) {
    // ── Resolve global fallback textures (used when sectorGrid lookup fails)
    const floorKey = this._resolveFlatTextureKey('floor');
    const ceilKey  = this._resolveFlatTextureKey('ceil');
    const floorTexDefault = this._getFlatTextureData(floorKey ? this.assets[floorKey] : null);
    const ceilTexDefault  = this._getFlatTextureData(ceilKey  ? this.assets[ceilKey]  : null);
    if (!floorTexDefault && !ceilTexDefault) return false;

    // ── BSP sector data for per-quad texture selection
    const bspMap     = this.map && this.map.bspMap;
    const sectors    = bspMap ? bspMap.sectors : null;
    const sectorGrid = this.map && this.map.sectorGrid;
    const mapW       = this.map ? this.map.width  : 0;
    const mapH       = this.map ? this.map.height : 0;

    // Per-sector texture data cache — rebuilt when map changes (same ref check)
    // Map<sectorId, {floorTex, ceilTex}> — populated lazily below.
    if (this._sectorTexCacheMap !== sectorGrid) {
      this._sectorTexCacheMap = sectorGrid;
      this._sectorTexCache    = new Map();  // sectorId → { floorTex, ceilTex }
    }
    const sectorTexCache = this._sectorTexCache;

    const getSecTex = (sid) => {
      if (sectorTexCache.has(sid)) return sectorTexCache.get(sid);
      const sec = sectors && sectors[sid];
      const ft  = (sec ? this._getFlatTextureData(this.assets[sec.floorTex] || null) : null) || floorTexDefault;
      const ct  = (sec ? this._getFlatTextureData(this.assets[sec.ceilTex]  || null) : null) || ceilTexDefault;
      const entry = {
        floorTex:   ft,
        ceilTex:    ct,
        lightLevel: sec ? (sec.lightLevel || 1.0) : 1.0,
        // Bake power-of-two masks once per sector (avoids recomputing per pixel)
        fMaskX: ft && ((ft.w & (ft.w - 1)) === 0) ? ft.w - 1 : -1,
        fMaskY: ft && ((ft.h & (ft.h - 1)) === 0) ? ft.h - 1 : -1,
        cMaskX: ct && ((ct.w & (ct.w - 1)) === 0) ? ct.w - 1 : -1,
        cMaskY: ct && ((ct.h & (ct.h - 1)) === 0) ? ct.h - 1 : -1,
      };
      sectorTexCache.set(sid, entry);
      return entry;
    };

    const mid = Math.floor(H / 2);

    if (!this._flatImageData || this._flatImageData.width !== W || this._flatImageData.height !== H) {
      this._flatImageData = new ImageData(W, H);
    }
    const out = _wallImageData.data;

    // Fill with gradient fallback first
    this._rebuildGradientLUT();
    if (this._gradImageData) out.set(this._gradImageData.data);

    // ── Camera-plane floor ray span — read from the stable per-frame vectors
    // computed in render() (2 trig calls, no SoA dependency, no rotation-matrix drift).
    // Falls back to direct Math.cos/sin on the first frame before render() populates them.
    let rayLeftX, rayLeftY, raySpanX, raySpanY;
    if (this._fcRayLX !== undefined) {
      rayLeftX = this._fcRayLX;
      rayLeftY = this._fcRayLY;
      raySpanX = this._fcSpanX;
      raySpanY = this._fcSpanY;
    } else {
      // First-frame fallback only — render() will populate _fcRayLX before next frame.
      const halfFov    = FOV / 2;
      const leftAngle  = player.angle - halfFov;
      const rightAngle = player.angle + halfFov;
      rayLeftX  = Math.cos(leftAngle);
      rayLeftY  = Math.sin(leftAngle);
      raySpanX  = Math.cos(rightAngle) - rayLeftX;
      raySpanY  = Math.sin(rightAngle) - rayLeftY;
    }

    // ditherScale: amplitude of dither noise added to each colour channel.
    // 12 gives ±~12 LSBs of jitter — enough to break shade banding without
    // being so large it causes hue shift.  The 8x8 Bayer matrix covers 0..63
    // so we remap: (val - 31.5) / 63 * ditherAmp.
    const ditherAmp  = 12.0;
    const ditherBias = 31.5;
    const ditherNorm = ditherAmp / 63.0;
    const INT_BIAS   = 4096;

    // Draw paired floor/ceiling rows from the horizon outward.
    for (let dy = 1; dy <= mid; dy++) {
      const yFloor = mid + dy;
      const yCeil  = mid - dy;
      if (yFloor >= H && yCeil < 0) break;

      const rowDist        = _ROW_DIST_LUT[dy];
      const stepX          = (rowDist * raySpanX) / W;
      const stepY          = (rowDist * raySpanY) / W;
      let wx               = player.x + rowDist * rayLeftX;
      let wy               = player.y + rowDist * rayLeftY;

      const floorShadeBase = _FLOOR_SHADE_LUT[dy];
      // Ceiling uses fixed 'm'-level shade — uniform across all sector types.
      // _CEIL_SHADE_M_LUT already bakes the m-brightness constant; no lightLevel multiply.
      const ceilShadeM     = _CEIL_SHADE_M_LUT[dy];

      const floorRowStart = yFloor * W * 4;
      const ceilRowStart  = yCeil  * W * 4;

      // Variable-cell dither: cellSize grows linearly from 1 (near) to 8 (far horizon).
      // Snap screen y to cell boundary; x is snapped per pixel below.
      const cellSize  = _FC_CELL_LUT[dy];
      // Pre-compute the snapped y cell row for floor and ceiling (constant across this dy row)
      const cellMask  = cellSize - 1;                         // 0, 1, 3, or 7
      const snapYF    = (cellSize > 1) ? (yFloor & ~cellMask) : yFloor;  // snap down to cell boundary
      const snapYC    = (cellSize > 1) ? (yCeil  & ~cellMask) : yCeil;
      const dithRowF  = (snapYF & 7) * 8;   // base index into DITHER8 for floor row
      const dithRowC  = (snapYC & 7) * 8;   // base index into DITHER8 for ceiling row

      for (let x = 0; x < W; x++, wx += stepX, wy += stepY) {
        // ── Per-pixel sector lookup (O(1) via flat Int16Array)
        const gx   = (wx + INT_BIAS) | 0;
        const gy   = (wy + INT_BIAS) | 0;
        const gwx  = gx - INT_BIAS;
        const gwy  = gy - INT_BIAS;
        const sid  = (sectorGrid && gwx >= 0 && gwx < mapW && gwy >= 0 && gwy < mapH)
                     ? sectorGrid[gwy * mapW + gwx]
                     : -1;

        // Fractional position within the tile
        const fx = (wx + INT_BIAS) - gx;
        const fy = (wy + INT_BIAS) - gy;

        // Sector textures (lightLevel used for floor only; ceiling is always m-level)
        const secData    = sid >= 0 ? getSecTex(sid) : null;
        const lightLevel = secData ? secData.lightLevel : 1.0;
        const floorTex   = (secData && secData.floorTex) || floorTexDefault;
        const ceilTex    = (secData && secData.ceilTex)  || ceilTexDefault;
        const floorShade = floorShadeBase * lightLevel;
        // Ceiling shade: fixed m-level, no sector lightLevel variation
        const ceilShade  = ceilShadeM;

        // Snap x coordinate to cell boundary for variable-cell dither
        const snapX = (cellSize > 1) ? (x & ~cellMask) : x;
        const colIdx = snapX & 7;   // 0..7 within 8×8 matrix

        if (floorTex && yFloor < H) {
          const fmx = secData ? secData.fMaskX : -1;
          const fmy = secData ? secData.fMaskY : -1;
          let tx = (fx * floorTex.w) | 0;
          let ty = (fy * floorTex.h) | 0;
          if (fmx >= 0) tx &= fmx; else if (tx >= floorTex.w) tx = floorTex.w - 1;
          if (fmy >= 0) ty &= fmy; else if (ty >= floorTex.h) ty = floorTex.h - 1;
          const si = (ty * floorTex.w + tx) * 4;
          const di = floorRowStart + x * 4;
          const d  = (DITHER8[dithRowF + colIdx] - ditherBias) * ditherNorm;
          // Bitwise clamp: val | 0 truncates; (v >> 31) ^ 255 gives 255 if overflowed negative.
          // Inline: clamp01(v) = v < 0 ? 0 : v > 255 ? 255 : v  — branch-free via bit tricks.
          let fv; fv = (floorTex.data[si]     * floorShade + d + 0.5) | 0; out[di]     = (fv < 0 ? 0 : fv > 255 ? 255 : fv) & 0xF8;
          fv = (floorTex.data[si + 1] * floorShade + d + 0.5) | 0; out[di + 1] = (fv < 0 ? 0 : fv > 255 ? 255 : fv) & 0xF8;
          fv = (floorTex.data[si + 2] * floorShade + d + 0.5) | 0; out[di + 2] = (fv < 0 ? 0 : fv > 255 ? 255 : fv) & 0xF8;
          out[di + 3] = 255;
        }

        if (ceilTex && yCeil >= 0) {
          const cmx = secData ? secData.cMaskX : -1;
          const cmy = secData ? secData.cMaskY : -1;
          let tx = (fx * ceilTex.w) | 0;
          let ty = (fy * ceilTex.h) | 0;
          if (cmx >= 0) tx &= cmx; else if (tx >= ceilTex.w) tx = ceilTex.w - 1;
          if (cmy >= 0) ty &= cmy; else if (ty >= ceilTex.h) ty = ceilTex.h - 1;
          const si = (ty * ceilTex.w + tx) * 4;
          const di = ceilRowStart + x * 4;
          const d  = (DITHER8[dithRowC + colIdx] - ditherBias) * ditherNorm;
          let cv; cv = (ceilTex.data[si]     * ceilShade + d + 0.5) | 0; out[di]     = (cv < 0 ? 0 : cv > 255 ? 255 : cv) & 0xF8;
          cv = (ceilTex.data[si + 1] * ceilShade + d + 0.5) | 0; out[di + 1] = (cv < 0 ? 0 : cv > 255 ? 255 : cv) & 0xF8;
          cv = (ceilTex.data[si + 2] * ceilShade + d + 0.5) | 0; out[di + 2] = (cv < 0 ? 0 : cv > 255 ? 255 : cv) & 0xF8;
          out[di + 3] = 255;
        }
      }
    }

    // No ctx.putImageData here — floor/ceiling pixels live in _wallFB and
    // will be flushed together with wall columns in _flushWallFB().
    return true;
  }

  // ─────────────────────────────────────────────────────────
  // Wall rendering — Uint32Array framebuffer path.
  //
  // All 320 wall columns are written into the module-level _wallFB
  // (Uint32Array backed by _wallImageData) during the wall loop in render().
  // A single ctx.putImageData(_wallImageData, 0, 0) at the end of the wall
  // pass replaces ~320 individual drawImage / fillRect calls per frame.
  //
  // Texture sampling uses affine stepping (spec §15):
  //   texStep = wallTexH / wallH   (integer, pre-divided once per column)
  //   texPos += texStep            (one add per pixel — no per-pixel divide)
  //   texY = texPos >> 8           (shift instead of divide)
  //
  // The texture is sampled from a Uint32Array (_texCache) built once per
  // unique wall image, so all pixel reads are flat typed-array accesses.
  //
  // After all wall columns are flushed, stickers (bullet holes, scorch marks,
  // torch wall-plates) are blitted directly into the same framebuffer before
  // the single putImageData call.
  // ────────────────────────────────────────────────��────���───

  /**
   * Resolve a wall image to a Uint32Array pixel cache (built once per image).
   * Returns null if the image is not yet loaded.
   */
  _getTexPixels(img) {
    if (!img || !(img.complete || img instanceof HTMLCanvasElement)) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w <= 0 || h <= 0) return null;

    // Use currentSrc (resolved URL) or src as the cache-validity key.
    // When hotSwapImage() mutates img.src on the same element, the URL changes
    // and we must discard the stale pixel data — otherwise walls keep showing
    // the old texture until a full page reload.
    const srcKey = img.currentSrc || img.src || '';
    const cached = _texCache.get(img);
    if (cached && cached.srcKey === srcKey) return cached.buf;

    // Rasterize to an offscreen canvas and read pixels as Uint32Array.
    const oc  = document.createElement('canvas');
    oc.width  = w;
    oc.height = h;
    const ox  = oc.getContext('2d', { willReadFrequently: true });
    ox.imageSmoothingEnabled = false;
    ox.drawImage(img, 0, 0, w, h);
    const id  = ox.getImageData(0, 0, w, h);
    const buf = new Uint32Array(id.data.buffer);
    _texCache.set(img, { srcKey, buf });
    return buf;
  }

  /**
   * Flush the wall framebuffer to the canvas.
   * Called once per frame after all wall columns are written and stickers drawn.
   */
  _flushWallFB(ctx) {
    if (!this._wallFBDirty) return;
    ctx.putImageData(_wallImageData, 0, 0);
    this._wallFBDirty = false;
  }

  /**
   * Cast a single ray for column `col` against the BSP seg tree.
   * Returns a hit descriptor { dist, wallX, texId, segNormDot } or null
   * if no seg is closer than the DDA hit for this column.
   *
   * dist     — perpendicular (fish-eye corrected) distance to the seg
   * wallX    — U coordinate [0,1] along the seg for texture sampling
   * texId    — texture key string from seg.texId
   * segBx/By — raw seg delta components used for side-darkening via squared comparison
   */
  _castBSPColumn(col, player) {
    const bspMap = this.map.bspMap;
    if (!bspMap) return null;

    // Ray direction — always precomputed by the render loop via BAM table rotation.
    const rdx = this._soaRdxF[col];
    const rdy = this._soaRdyF[col];
    const px  = player.x;
    const py  = player.y;

    // Fish-eye correction factor: cos(angle - player.angle).
    // This depends only on the column index (not player angle) — read from the
    // camera-relative SoA cosine table (Q1.14, index = col) instead of calling Math.cos.
    // The SoA table stores cos(relAngle) where relAngle = -halfFov + col * (FOV/(N-1)).
    const _rc = this.raycaster;
    const cosA = (_rc && _rc._soaCos)
      ? _rc._soaCos[col] / 16384
      : Math.cos(this._rayAngles[col] - player.angle);

    let   bestDist = Infinity;
    let   bestHit  = null;
    const MAX_RENDER_DIST = 24;

    // Traverse BSP front-to-back; test every seg in each leaf.
    // Return true from the callback to stop traversal early.
    bspMap.traverse(px, py, (leaf) => {
      if (leaf.segs.length === 0) return false;

      // Bbox distance cull: if the nearest corner of this leaf's bbox is
      // farther than our current best hit (or render limit), we can stop —
      // BSP guarantees all subsequent leaves are even farther away.
      // Squared comparison avoids Math.sqrt — compare distSq vs limit².
      if (leaf.bbox) {
        const clampX = Math.max(leaf.bbox.minX, Math.min(leaf.bbox.maxX, px));
        const clampY = Math.max(leaf.bbox.minY, Math.min(leaf.bbox.maxY, py));
        const bboxDistSq = (clampX - px) * (clampX - px) + (clampY - py) * (clampY - py);
        if (bboxDistSq >= bestDist * bestDist || bboxDistSq >= MAX_RENDER_DIST * MAX_RENDER_DIST) return true; // stop
      }

      for (const seg of leaf.segs) {
        // Skip two-sided portal segs — they don't draw a wall face
        if (seg.flags & 1 /* SEG_FLAG_TWO_SIDED */) continue;

        // SEG_FLAG_TOGGLEABLE (bit 3): skip if the toggleable has been opened
        if (seg.flags & 8 /* SEG_FLAG_TOGGLEABLE */) {
          if (seg.toggleRef && seg.toggleRef.opened) continue;
        }

        // Ray-segment intersection
        // Ray:  P + t*D
        // Seg:  A + s*(B-A),  s ∈ [0,1]
        // Solve: t = cross(A-P, segDir) / cross(D, segDir)
        //        s = cross(A-P, D)     / cross(D, segDir)
        const ax = seg.x1 - px, ay = seg.y1 - py;
        const bx = seg.x2 - seg.x1, by = seg.y2 - seg.y1;

        const denom = rdx * by - rdy * bx;
        if (Math.abs(denom) < 1e-9) continue;  // parallel

        const t = (ax * by - ay * bx) / denom;
        const s = (ax * rdy - ay * rdx) / denom;

        if (t < 0.001) continue;             // behind camera
        if (s < -1e-4 || s > 1 + 1e-4) continue; // outside seg extent

        const perpDist = t * cosA;           // fish-eye corrected
        // Near-clip: mirror the draw-path minimum (Math.max(0.1, dist)) so the
        // depth sorter never gets a value smaller than the draw floor.  Also
        // guards against cosA ≈ 0 (extreme FOV edges) flipping sign.
        if (perpDist < 0.05 || perpDist >= bestDist) continue;

        // No global face-cull by denom sign.  Segs are wound so their front face
        // points into open space, but once a secret pocket opens the player can be
        // on the "back" side of surrounding wall segs — culling denom<=0 would
        // drop those legitimate faces and produce invisible walls.
        //
        // Instead: for secret/gem-door segs (identified by wallTileX/Y), skip if
        // the tile is no longer solid (already done above by texId check).
        // For all other segs the backing tile is guaranteed solid by construction;
        // render them regardless of which side the ray approaches from.

        bestDist = perpDist;
        // Side-darkening uses segBx/segBy directly in _drawBSPWallColumn via squared
        // comparison (bx² < 0.25 * segLen²) — no normDot or Math.sqrt needed here.
        // Clamp wallX to [0,1] to handle tiny floating-point overruns at seg endpoints
        const wallX = Math.max(0, Math.min(1, s));
        bestHit = { dist: perpDist, wallX, texId: seg.texId,
                    segBx: bx, segBy: by,
                    toggleRef: (seg.flags & 8) ? seg.toggleRef : null };
      }
      return false; // continue traversal
    });

    return bestHit;
  }

  /**
   * Draw a BSP wall column — same pixel pipeline as _drawWallColumn but
   * sources texture from seg.texId and uses normDot for side-darkening.
   */
  _drawBSPWallColumn(col, bspHit, player, torchAdd) {
    const dist   = Math.max(0.1, bspHit.dist);
    const _wlIdx = (dist * _WALLH_LUT_SCALE + 0.5) | 0;
    const _wlSafe = _wlIdx < _WALLH_LUT_SIZE ? _wlIdx : _WALLH_LUT_SIZE - 1;
    const wallH  = _WALLH_LUT[_wlSafe];
    const top    = _WALLTOP_LUT[_wlSafe];
    const bottom = top + wallH;

    // Texture — BSP segs only carry theme wall texIds now (no wallSecret/wallGem).
    const theme   = this.map.theme;
    let wallImg   = (bspHit.texId && this.assets[bspHit.texId])
                    || (theme && this.assets[theme.wallKey])
                    || this.assets.wall;

    let brightness = this._flickerVal / (1 + dist * 0.138);
    // Side darkening: segs running east-west (by≈0) are the "X-axis" faces —
    // keep full brightness. Segs running north-south (bx≈0) are "Y-axis" faces —
    // darken, matching DDA hit.side===1 behaviour.
    // Side darkening: |bx| / |seg| < 0.5  ↔  bx² < 0.25 * segLen²  (no sqrt needed)
    const segLen2 = bspHit.segBx * bspHit.segBx + bspHit.segBy * bspHit.segBy;
    if (segLen2 > 1e-9 && bspHit.segBx * bspHit.segBx < 0.25 * segLen2) {
      brightness *= 0.7;
    }
    brightness = Math.min(1.2, brightness + (torchAdd || 0) * 0.5);
    const tAdd = torchAdd || 0;

    // Shimmer for toggleable segs (secret walls / gem doors) — carried via toggleRef
    let shimR = 0, shimG = 0, shimB = 0, shimA = 0;
    const togRef = bspHit.toggleRef;
    if (togRef) {
      if (togRef.type === 'gemdoor') {
        const GEM_COL = { red: [220,40,40], green: [40,200,60], blue: [40,100,220] };
        const gc = GEM_COL[togRef.color];
        if (gc) {
          shimA = 0.15 + 0.1 * Math.sin(this._time * 4.5 + togRef.x * 2.1 + togRef.y * 1.7);
          shimR = gc[0]; shimG = gc[1]; shimB = gc[2];
        }
      } else {
        shimA = 0.06 + 0.04 * Math.sin(this._time * 3.7 + togRef.x * 1.3);
        shimR = 200; shimG = 140; shimB = 30;
      }
    }

    if (wallImg && wallImg.complete && wallImg.naturalWidth > 0) {
      if (wallImg !== this._wallTexImg) {
        this._wallTexImg    = wallImg;
        this._wallTexPixels = this._getTexPixels(wallImg);
      }
      const texPixels = this._wallTexPixels;
      const imgW = wallImg.naturalWidth  || wallImg.width;
      const imgH = wallImg.naturalHeight || wallImg.height;

      const texX    = Math.min((bspHit.wallX * imgW) | 0, imgW - 1);
      const texStep = (imgH << 8) / Math.max(1, wallH);
      let   texPos  = top < 0 ? (-top * texStep) : 0;

      const yStart = Math.max(0, top);
      const yEnd   = Math.min(H, bottom);

      // Wall shade: clamp brightness to [0.12, 1] so walls are dark but not black.
      // Spec (torch tint + shimmer) is applied first on the source pixel, then
      // shade darkens the result — matching the "darken after spec on source" order.
      const wallShade = Math.max(0.12, Math.min(1.0, brightness));
      const wsInt = (wallShade * 256 + 0.5) | 0;  // Q8 fixed-point for cheap multiply

      for (let y = yStart; y < yEnd; y++) {
        const _ty  = texPos >> 8;
        const texY = _ty >= imgH ? imgH - 1 : _ty;
        let px32   = texPixels[texY * imgW + texX];
        let r = ( px32        & 0xFF);
        let g = ((px32 >>  8) & 0xFF);
        let b = ((px32 >> 16) & 0xFF);

        // Spec (torch tint) applied to source values first
        if (tAdd > 0.05) {
          const ta = tAdd * 0.22;
          r = Math.min(255, r + (255 * ta) | 0);
          g = Math.min(255, g + (160 * ta) | 0);
          b = Math.min(255, b + ( 40 * ta) | 0);
        }
        if (shimA > 0.01) {
          r = Math.min(255, (r * (1 - shimA) + shimR * shimA) | 0);
          g = Math.min(255, (g * (1 - shimA) + shimG * shimA) | 0);
          b = Math.min(255, (b * (1 - shimA) + shimB * shimA) | 0);
        }

        // Apply wall darkness AFTER spec — source image stays bright for highlight detection
        r = (r * wsInt) >> 8;
        g = (g * wsInt) >> 8;
        b = (b * wsInt) >> 8;

        _wallFB[y * W + col] = _packRGB(r, g, b);
        texPos += texStep;
      }
    } else {
      const v = Math.floor(brightness * 160);
      const flatPx = _packRGB(v, (v * 0.8) | 0, (v * 0.6) | 0);
      const yStart = Math.max(0, top);
      const yEnd   = Math.min(H, bottom);
      for (let y = yStart; y < yEnd; y++) _wallFB[y * W + col] = flatPx;
    }
  }

  // _drawToggleables() removed — toggleable segs (secret walls, gem doors) are
  // now first-class BSP segs injected in mapgen.js (SEG_FLAG_TOGGLEABLE).
  // They render through _drawBSPWallColumn with shimmer, and are skipped when
  // tog.opened === true.  The separate pass + second _flushWallFB are gone.

  // ─────────────────────────────────────────────────────────
  // Sticker projection — draw raycaster stickers (bullet holes, scorch marks)
  // directly into _wallFB before the single putImageData flush.
  //
  // Projected from world space like sprites (decoupled from raycaster columns):
  //   • worldX/worldY → _inFrustum for screen column + frustum cull
  //   • faceAxis/faceCoord (baked by attachSticker) → stable perp distance
  //     by projecting a point ON the face plane rather than the hit point,
  //     so wallH/wallTop are constant as the player strafes.
  // ─────────────────────────────────────────────────────────
  _drawWallStickers(player) {
    const stickerArr = this.raycaster.stickers;
    if (!stickerArr) return;

    // Hoist view direction — constant for all stickers this frame.
    const dirX = Math.cos(player.angle);
    const dirY = Math.sin(player.angle);

    for (let i = 0; i < stickerArr.length; i++) {
      const stickers = stickerArr[i];
      if (!stickers || stickers.length === 0) continue;

      for (const stk of stickers) {
        // ── 1. World-space frustum + screen-column test. ─────────────────────
        // worldX/Y is the bullet hit point — use it for angle/column only.
        const dx = stk.worldX - player.x;
        const dy = stk.worldY - player.y;
        const sa = _inFrustum(dx, dy, player.angle, 24);
        if (sa === null) continue;

        // ── 2. Perpendicular distance to the wall FACE PLANE. ────────────────
        // _lastPerpDist is measured to worldX/Y (the bullet hit point, slightly
        // into open space). As the player strafes, that dot product changes and
        // wallH wobbles — the sticker appears unstuck.
        //
        // Instead project a point ON the face plane: substitute faceCoord for
        // the axis-aligned component and keep worldX/Y for the other axis.
        // This gives the exact same depth the wall renderer uses for that face.
        //   X-face: facePt = (faceCoord, worldY)  → dist = (faceCoord-px)*dirX + (worldY-py)*dirY
        //   Y-face: facePt = (worldX, faceCoord)  → dist = (worldX-px)*dirX   + (faceCoord-py)*dirY
        let faceDist;
        if (stk.faceAxis === 'x') {
          faceDist = (stk.faceCoord - player.x) * dirX + (stk.worldY - player.y) * dirY;
        } else {
          faceDist = (stk.worldX - player.x) * dirX + (stk.faceCoord - player.y) * dirY;
        }
        const dist = Math.max(0.1, faceDist);

        // ── 2. Screen geometry from perpDist — matches the wall renderer. ───
        const _stkIdx  = (dist * _WALLH_LUT_SCALE + 0.5) | 0;
        const _stkSafe = _stkIdx < _WALLH_LUT_SIZE ? _stkIdx : _WALLH_LUT_SIZE - 1;
        const wallH   = _WALLH_LUT[_stkSafe];
        const wallTop = _WALLTOP_LUT[_stkSafe];

        // Screen column for sticker centre
        const centerCol = _saToScreenX(sa);

        // Sticker width in screen columns derived from texture-space half-width × wallH
        const halfW_tex = (stk.width / FP_ONE) * 0.5;
        const halfW_px  = Math.max(1, Math.round(halfW_tex * wallH));

        const colStart = Math.max(0,     centerCol - halfW_px);
        const colEnd   = Math.min(W - 1, centerCol + halfW_px);

        // Vertical span
        const stickerY_frac   = stk.offset_y / FP_ONE;          // 0=bottom, 1=top
        const stickerScreenY  = wallTop + Math.floor((1 - stickerY_frac) * wallH);
        const stickerH_screen = Math.max(2, Math.floor((stk.height / FP_ONE) * wallH));
        const halfH  = stickerH_screen >> 1;
        const yStart = Math.max(0, stickerScreenY - halfH);
        const yEnd   = Math.min(H, stickerScreenY + halfH);

        // ── 3. Pixel blit, depth-culled per column. ─────────────────────────
        const stkImg    = this.assets[stk.tex_id];
        const stkPixels = stkImg ? this._getTexPixels(stkImg) : null;

        for (let col = colStart; col <= colEnd; col++) {
          // Depth-cull: skip column if a closer wall already occupies it.
          if (this.zBuffer[col] < dist - 0.01) continue;

          if (stkPixels) {
            const sw = stkImg.naturalWidth  || stkImg.width;
            const sh = stkImg.naturalHeight || stkImg.height;

            // Map screen column → texture U across the sticker's pixel span.
            const localU = (col - (centerCol - halfW_px)) / (halfW_px * 2 + 1e-6);
            const texX   = Math.max(0, Math.min(sw - 1, (localU * sw) | 0));

            const vStep = (sh << 8) / Math.max(1, stickerH_screen);
            let vPos = 0;

            for (let y = yStart; y < yEnd; y++) {
              const texY  = Math.min(sh - 1, vPos >> 8);
              const stkPx = stkPixels[texY * sw + texX];
              const alpha = (stkPx >>> 24) & 0xFF;
              if (alpha < 64) { vPos += vStep; continue; }

              const wallIdx = y * W + col;
              const wp = _wallFB[wallIdx];
              const wr = ( wp        & 0xFF);
              const wg = ((wp >>  8) & 0xFF);
              const wb = ((wp >> 16) & 0xFF);
              const sr = ( stkPx        & 0xFF);
              const sg = ((stkPx >>  8) & 0xFF);
              const sb = ((stkPx >> 16) & 0xFF);
              const t  = alpha / 255;
              _wallFB[wallIdx] = _packRGB(
                (wr + (sr - wr) * t) | 0,
                (wg + (sg - wg) * t) | 0,
                (wb + (sb - wb) * t) | 0,
              );
              vPos += vStep;
            }
          } else if (!stkImg) {
            // Fallback: solid dark scorch — only when no asset is registered.
            // Silently skip if stkImg exists but hasn't loaded yet.
            const sootPx = _packRGB(12, 8, 6);
            for (let y = yStart; y < yEnd; y++) {
              _wallFB[y * W + col] = sootPx;
            }
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Floor halos — torch + brazier, unified ImageData path.
  //
  // The original approach called ctx.fillRect(px, py, 1, 1) + ctx.fillStyle
  // once per visible pixel.  When the player stands inside a halo, haloDist
  // approaches 0, haloW/haloH scale as 1/dist and can cover hundreds of pixels,
  // generating thousands of Canvas API round-trips per halo per frame.
  //
  // New approach: accumulate all halo pixels into a single Uint8ClampedArray
  // (additively, so overlapping halos brighten correctly), then emit exactly
  // one ctx.putImageData call for the entire halo layer.  The buffer is cleared
  // with a single TypedArray.fill(0) — one memset vs N×M string allocations.
  //
  // Halo dimensions are hard-capped so standing inside a source can't make the
  // inner loop arbitrarily large.
  // ─────────────────────────────────────────────────────────

  // ────────────────��────────────────────────────────────────
  // Baked torch light patches — call once per level load.
  //
  // For every torch, cast N_PATCH_RAYS rays in a hemispherical fan aligned
  // to the torch face normal and DDA-march each ray until it hits a wall.
  // Store the per-ray reach distance in a Float32Array on the torch object.
  // This is the only moment isWall() is called for torch lighting; render
  // time is a single array lookup per floor pixel.
  //
  // Also stores faceAngle and the angular span so the render loop can do
  // a fast in-range check without any trig.
  // ─────────────────────────────────────────────────────────
  static N_PATCH_RAYS  = 64;    // angular resolution of the baked reach table
  static PATCH_REACH   = 4.0;   // world-unit hard limit — light fill radius
  static PATCH_FOV     = Math.PI * 1.05; // slightly over 180° so corners aren't clipped

  // Light field precalc constants.
  // LFSCALE: samples per world-unit in the local light field grid.
  // LF_SIZE: grid side length = ceil(2 * PATCH_REACH * LFSCALE) + 2 (one border cell)
  // Each torch gets a Float32Array of size LF_SIZE² stored as t._lightField,
  // indexed by offset from the torch's patch origin (ox, oy).
  static LFSCALE   = 4;         // 4 samples per world unit → 0.25 precision
  static LF_SIZE   = Math.ceil(2 * 4.0 * 4) + 2;  // 34 → 34×34 = 1156 entries/torch

  bakeTorchLightPatches(torches) {
    for (let ti = 0; ti < torches.length; ti++) {
      this._bakeTorchPatch(torches[ti]);
    }
  }

  /**
   * Build (or rebuild) the corridor→room adjacency map from the current sectorGrid.
   * For every corridor sector, records which room sectors it directly borders
   * (i.e. shares at least one grid edge with).  Called lazily when sectorGrid changes.
   *
   * Result stored in this._corridorToRooms:
   *   Map<corridorSectorId, Set<roomSectorId>>
   *
   * Complexity: O(W×H) — one pass over the grid.
   */
  _buildCorridorAdjacency() {
    const map = this.map;
    if (!map || !map.sectorGrid || !map.bspMap) return;

    const sg      = map.sectorGrid;
    const sectors = map.bspMap.sectors;
    const w       = map.width;
    const h       = map.height;
    const result  = new Map();

    const DIRS = [[-1,0],[1,0],[0,-1],[0,1]];

    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        const sid = sg[cy * w + cx];
        if (sid < 0) continue;                          // solid cell
        const sec = sectors[sid];
        if (!sec || sec.isRoom) continue;               // only care about corridor cells

        // Look at each 4-neighbour
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nsid = sg[ny * w + nx];
          if (nsid < 0 || nsid === sid) continue;       // solid or same corridor
          const nsec = sectors[nsid];
          if (!nsec || !nsec.isRoom) continue;          // only record room neighbours

          // Record: corridor sid → room nsid
          let set = result.get(sid);
          if (!set) { set = new Set(); result.set(sid, set); }
          set.add(nsid);
        }
      }
    }

    this._corridorToRooms = result;
    this._corridorAdjMap  = sg;   // invalidation key
  }

  /**
   * Build the per-frame hallway bypass array.
   * For each torch[i], sets this._hallwayBypass[i] = true when:
   *   - player is in a corridor sector
   *   - torch is in a room sector adjacent to that corridor
   *   - there is direct LOS from player to torch (raycaster.hasLOS)
   *
   * Called once per frame from render() before _computeTorchLight and
   * _drawTorchRaycastFill so both can consume the same cached result.
   */
  _buildHallwayBypass(player, torches) {
    const bypass = this._hallwayBypass;
    // Grow/shrink to match torches length
    while (bypass.length < torches.length) bypass.push(false);

    const map = this.map;
    if (!map || !map.sectorGrid || !map.bspMap) {
      bypass.fill(false, 0, torches.length);
      return;
    }

    // Rebuild adjacency map if sectorGrid changed (new level / rebake)
    if (this._corridorAdjMap !== map.sectorGrid) {
      this._buildCorridorAdjacency();
    }

    const sg      = map.sectorGrid;
    const sectors = map.bspMap.sectors;
    const w       = map.width;
    const h       = map.height;

    const pgx = (player.x | 0), pgy = (player.y | 0);
    const playerSec = (pgx >= 0 && pgx < w && pgy >= 0 && pgy < h)
      ? sg[pgy * w + pgx] : -1;

    // If player is not in a corridor, no hallway bypass applies
    const playerSector = playerSec >= 0 ? sectors[playerSec] : null;
    const playerInCorridor = playerSector && !playerSector.isRoom;

    if (!playerInCorridor) {
      bypass.fill(false, 0, torches.length);
      return;
    }

    // Get the set of room sectors adjacent to the player's corridor
    const adjRooms = this._corridorToRooms.get(playerSec);
    if (!adjRooms || adjRooms.size === 0) {
      bypass.fill(false, 0, torches.length);
      return;
    }

    const rc = this.raycaster;

    for (let i = 0; i < torches.length; i++) {
      const t   = torches[i];
      const tgx = (t.x | 0), tgy = (t.y | 0);
      const torchSec = (tgx >= 0 && tgx < w && tgy >= 0 && tgy < h)
        ? sg[tgy * w + tgx] : -1;

      // Torch must be in a room sector that is adjacent to the player's corridor
      if (torchSec < 0 || !adjRooms.has(torchSec)) {
        bypass[i] = false;
        continue;
      }

      // LOS check — walk a ray from player to torch; bypass only if unobstructed
      bypass[i] = rc ? rc.hasLOS(player.x, player.y, t.x, t.y) : false;
    }
  }

  /**
   * Bake (or re-bake) the light-reach table for a single torch.
   * Called by bakeTorchLightPatches (full bake at level load) and by
   * destroyTorchesOnWall (targeted dirty-patch after a wall opens).
   */
  _bakeTorchPatch(t) {
    const N    = Renderer.N_PATCH_RAYS;
    const HALF = Renderer.PATCH_FOV / 2;
    const STEP = 0.12;

    // Resolve face normal (mapgen always supplies normX/normY; guard anyway)
    let normX = t.normX, normY = t.normY;
    if (normX == null) {
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      normX = 0; normY = 1;
      const nb = [[gx,gy-1,0,-1],[gx,gy+1,0,1],[gx-1,gy,-1,0],[gx+1,gy,1,0]];
      for (const [nx,ny,ndx,ndy] of nb) {
        if (this.map.isWall(nx, ny)) { normX = -ndx; normY = -ndy; break; }
      }
    }
    const faceAngle = Math.atan2(normY, normX);

    const ox = t.x - normX * 0.5;
    const oy = t.y - normY * 0.5;
    t._patchOx       = ox;
    t._patchOy       = oy;
    t._patchFaceAngle = faceAngle;

    if (!t._patchReach || t._patchReach.length !== N) {
      t._patchReach = new Float32Array(N);
    }

    for (let ri = 0; ri < N; ri++) {
      const relAngle = -HALF + (ri / (N - 1)) * Renderer.PATCH_FOV;
      const rayAngle = faceAngle + relAngle;
      const rdx = Math.cos(rayAngle);
      const rdy = Math.sin(rayAngle);

      let reach = 0;
      while (reach < Renderer.PATCH_REACH) {
        reach += STEP;
        if (this.map.isWall(ox + rdx * reach, oy + rdy * reach)) { reach -= STEP; break; }
      }
      t._patchReach[ri] = reach;
    }

    // After re-baking reach rays, rebuild the local light-field grid.
    this._bakeTorchLightField(t);
  }

  /**
   * Bake the 2-D light-field grid for one torch.
   *
   * Samples a dense grid (LFSCALE samples per world unit) over the square
   * bounding the torch's PATCH_REACH cone, reusing the already-baked
   * _patchReach table — zero isWall calls here.
   *
   * Result stored as t._lightField: a Float32Array of size LF_SIZE²,
   * each entry is the pre-computed falloff [0..1] at that world position
   * (at flicker=1.0).  Entries outside the cone or occluded by walls store 0.
   *
   * At render time the hot loop quantises each floor pixel to a grid index
   * and does a single array lookup instead of atan2 + sqrt.
   *
   * t._lfOx / t._lfOy store the world-space origin of cell [0,0] so the
   * render loop can convert world coords to grid indices in one multiply.
   */
  _bakeTorchLightField(t) {
    const N    = Renderer.N_PATCH_RAYS;
    const REACH = Renderer.PATCH_REACH;
    const HALF_FOV_PATCH = Renderer.PATCH_FOV / 2;
    const INV_PATCH_SPAN = (N - 1) / Renderer.PATCH_FOV;
    const SCALE = Renderer.LFSCALE;
    const SZ    = Renderer.LF_SIZE;

    const ox = t._patchOx;
    const oy = t._patchOy;
    const fa = t._patchFaceAngle;
    const reach = t._patchReach;

    // Grid origin: ox - REACH maps to cell 0
    const gridOriginX = ox - REACH;
    const gridOriginY = oy - REACH;
    t._lfOx = gridOriginX;
    t._lfOy = gridOriginY;

    if (!t._lightField || t._lightField.length !== SZ * SZ) {
      t._lightField = new Float32Array(SZ * SZ);
    }
    const lf = t._lightField;
    lf.fill(0);

    const invScale = 1 / SCALE;
    const reachSq  = REACH * REACH;

    for (let gi = 0; gi < SZ; gi++) {
      const wx = gridOriginX + gi * invScale;
      const fx = wx - ox;
      for (let gj = 0; gj < SZ; gj++) {
        const wy = gridOriginY + gj * invScale;
        const fy = wy - oy;

        // Fast distance-squared pre-reject
        const fdistSq = fx * fx + fy * fy;
        if (fdistSq > reachSq) continue;

        // Angle relative to face normal
        let relAngle = Math.atan2(fy, fx) - fa;
        if (relAngle >  Math.PI) relAngle -= Math.PI * 2;
        if (relAngle < -Math.PI) relAngle += Math.PI * 2;
        if (relAngle < -HALF_FOV_PATCH || relAngle > HALF_FOV_PATCH) continue;

        // Reach table lookup — fastInvSqrt gives 1/dist; invert for dist comparison.
        const ri     = Math.max(0, Math.min(N - 1, ((relAngle + HALF_FOV_PATCH) * INV_PATCH_SPAN) | 0));
        const fdist  = fdistSq < 0.0001 ? 0 : 1 / fastInvSqrt(fdistSq);
        if (fdist > reach[ri]) continue;

        // Store falloff at flicker=1.0 — smoothstep with flat core at half-radius
        const lfT = fdist / REACH;                          // 0..1 normalized distance
        const lfH = Math.max(0, (lfT - 0.5) * 2);          // 0 inside half-reach, ramps to 1 at edge
        lf[gi * SZ + gj] = 1 - lfH * lfH * (3 - 2 * lfH); // smoothstep
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Torch floor+wall patch — replaces _drawTorchRaycastFill.
  //
  // Uses the pre-baked per-torch reach tables (no isWall calls at render time).
  // For each floor scanline pixel, the world position is computed via the same
  // incremental floor-caster walk used by _drawTexturedFloorCeiling.  The angle
  // from the torch is quantised to a reach-table bucket; if the pixel's distance
  // is within reach, an additive orange tint is blended into _wallFB.
  //
  // A thin wall-face strip (bottom ~35% of the torch's wall column band) also
  // receives the patch tint so the light appears to project onto both surfaces
  // simultaneously — matching how real torch sconces bleed onto the floor below.
  //
  // All writes go into _wallFB before the single putImageData flush.
  // Zero per-frame isWall calls.  Zero heap allocations.
  // ─────────────────────────────────────────────────────────
  _drawTorchRaycastFill(torches, player) {
    if (!torches.length) return;

    // ── Every-other-frame alternation via delta buffer ────────────────────────
    // Even frames: clear _torchDelta, recompute torch light, store deltas there.
    // Odd frames: skip the expensive recompute; re-apply the saved _torchDelta.
    // Both paths end by additively blending _torchDelta into the framebuffer.
    _torchFillFrame++;
    const isEvenFrame = (_torchFillFrame & 1) === 0;

    if (!isEvenFrame) {
      // Fast path: just re-apply the previous even frame's torch delta
      const out = _wallImageData.data;
      for (let i = 0; i < _torchDelta.length; i += 4) {
        const dr = _torchDelta[i];
        const dg = _torchDelta[i + 1];
        const db = _torchDelta[i + 2];
        if ((dr | dg | db) === 0) continue;
        let v; v = out[i]     + dr; out[i]     = v > 255 ? 255 : v;
        v = out[i + 1] + dg; out[i + 1] = v > 255 ? 255 : v;
        v = out[i + 2] + db; out[i + 2] = v > 255 ? 255 : v;
      }
      return;
    }

    // Even frame: clear delta buffer before rebuilding
    _torchDelta.fill(0);

    const REACH    = Renderer.PATCH_REACH;
    const SCALE    = Renderer.LFSCALE;
    const SZ       = Renderer.LF_SIZE;

    // Write torch additions into the delta buffer (not directly into the framebuffer).
    // At end of function, the delta is blended into _wallImageData.data.
    const out      = _torchDelta;  // build into delta; applied to framebuffer at end
    const fbOut    = _wallImageData.data;
    const mid      = (H / 2) | 0;

    // Row-distance table — module-level LUT (eyeH / dy), shared with floor caster.
    const rowDist = _ROW_DIST_LUT;

    // ── Stable camera-plane floor rays — same source as _drawTexturedFloorCeiling.
    // Precomputed in render() from 2 trig calls; no SoA rotation-matrix dependency.
    let rayLX, rayLY, spanX, spanY;
    if (this._fcRayLX !== undefined) {
      rayLX = this._fcRayLX;
      rayLY = this._fcRayLY;
      spanX = this._fcSpanX;
      spanY = this._fcSpanY;
    } else {
      const halfFov = FOV / 2;
      const leftAngle = player.angle - halfFov;
      const rightAngle = player.angle + halfFov;
      rayLX = Math.cos(leftAngle);
      rayLY = Math.sin(leftAngle);
      spanX = Math.cos(rightAngle) - rayLX;
      spanY = Math.sin(rightAngle) - rayLY;
    }

    // ── Precompute per-row walk arrays once — shared across ALL torches this frame.
    // Without this, every torch recomputes (rd * spanX / W) + player.x etc. per row.
    const invW = 1 / W;
    for (let dy = 1; dy <= mid; dy++) {
      const rd = rowDist[dy];
      _ROW_STEP_X[dy] = rd * spanX * invW;
      _ROW_STEP_Y[dy] = rd * spanY * invW;
      _ROW_WX0[dy]    = player.x + rd * rayLX;
      _ROW_WY0[dy]    = player.y + rd * rayLY;
    }

    // ── Bucket culling — same-room torches always render their light pools ──
    const sectorGrid = this.map && this.map.sectorGrid;
    const mapW       = this.map ? this.map.width  : 0;
    const mapH       = this.map ? this.map.height : 0;
    const _pgx = (player.x | 0), _pgy = (player.y | 0);
    const playerSectorId = (sectorGrid && _pgx >= 0 && _pgx < mapW && _pgy >= 0 && _pgy < mapH)
      ? sectorGrid[_pgy * mapW + _pgx] : -1;
    // Extended reach used for same-room scanline row cutoff — covers the full room
    const REACH_ROOM = REACH * 4;

    for (let ti = 0; ti < torches.length; ti++) {
      const t  = torches[ti];
      const tf = this._torchFlicker[ti] || { val: 1 };
      if (tf.val < 0.02) continue;

      // Same-room sector check — bypass distance cull if torch shares player's sector,
      // or is in an adjacent room visible from the player's corridor (hallway bypass).
      const _tgx = (t.x | 0), _tgy = (t.y | 0);
      const torchSectorId = (sectorGrid && _tgx >= 0 && _tgx < mapW && _tgy >= 0 && _tgy < mapH)
        ? sectorGrid[_tgy * mapW + _tgx] : -1;
      const sameRoom = (playerSectorId >= 0 && playerSectorId === torchSectorId)
                    || (this._hallwayBypass[ti] === true);

      // Bail early if torch is too far to cast any visible light
      // (bypassed for same-room torches so their pools always appear)
      const tdx = t.x - player.x, tdy = t.y - player.y;
      const tDistSq = tdx * tdx + tdy * tdy;
      if (!sameRoom && tDistSq > (REACH + 1) * (REACH + 1)) continue;

      // Ensure baked tables exist (guard against level that skips bakeTorchLightPatches)
      if (!t._patchReach) this._bakeTorchPatch(t);  // also builds _lightField
      if (!t._lightField) this._bakeTorchLightField(t);

      // ── Light-field lookup constants ──────────────────────────────────────
      // Convert world position to light-field grid index:
      //   gi = (wx - t._lfOx) * SCALE  → clamp to [0, SZ-1]
      //   gj = (wy - t._lfOy) * SCALE  → clamp to [0, SZ-1]
      const lf       = t._lightField;
      const lfOx     = t._lfOx;
      const lfOy     = t._lfOy;
      const flickVal = tf.val;

      // ── Merged floor + ceiling scanlines (single dy loop) ─────────────────
      // Processing both surfaces in one pass halves the outer loop overhead.
      // Per-row walk arrays (_ROW_WX0 etc.) are precomputed above — NO per-torch
      // recomputation of stepX/Y or wx0/wy0. Math.sqrt replaced by squared
      // distance comparisons against precomputed _TORCH_ZONE_*_SQ constants.
      const floorRowReach = sameRoom ? REACH_ROOM : REACH + 0.5;
      const txPos = t.x, tyPos = t.y;
      const reachRecip = 1 / (REACH + 0.01);
      const zBuf = this.zBuffer;

      for (let dy = 1; dy <= mid; dy++) {
        const yFloor = mid + dy;
        const yCeil  = mid - dy;
        const doFloor = yFloor < H;
        const doCeil  = yCeil  >= 0;
        if (!doFloor && !doCeil) break;

        const rd = rowDist[dy];
        if (rd > floorRowReach) continue;

        // Use precomputed row walk (shared across all torches this frame)
        const stepX = _ROW_STEP_X[dy];
        const stepY = _ROW_STEP_Y[dy];
        let wx = _ROW_WX0[dy];
        let wy = _ROW_WY0[dy];

        // Per-row constants that don't vary by x
        const distRatio = rd * reachRecip;
        const rowFalloffScale = flickVal * (1 - distRatio * distRatio) * 1.15;
        if (rowFalloffScale <= 0) { wx += stepX * W; wy += stepY * W; continue; }

        for (let x = 0; x < W; x++, wx += stepX, wy += stepY) {
          const zb = zBuf[x];
          if (zb < rd - 0.05) continue;  // behind a wall

          // Light-field grid lookup (O(1))
          const gi = ((wx - lfOx) * SCALE + 0.5) | 0;
          if (gi < 0 || gi >= SZ) continue;
          const gj = ((wy - lfOy) * SCALE + 0.5) | 0;
          if (gj < 0 || gj >= SZ) continue;

          const baseFalloff = lf[gi * SZ + gj];
          if (baseFalloff <= 0) continue;

          const falloff = baseFalloff * rowFalloffScale;
          if (falloff <= 0) continue;
          const expFall = _POW25_LUT[(falloff >= 1 ? 255 : (falloff * 255 + 0.5) | 0)];

          // ── Zone classification — squared distance, NO Math.sqrt ──────────
          const pdx = wx - txPos, pdy = wy - tyPos;
          const pDistSq = pdx * pdx + pdy * pdy;
          let skipFloor = false, skipCeil = false;

          if (pDistSq < _TORCH_ZONE_1_SQ) {
            // Inner zone: Bayer16, threshold 0→60
            const tIn = pDistSq / _TORCH_ZONE_1_SQ;  // squared ratio is fine (monotonic)
            const threshIn = (tIn * 60 + 0.5) | 0;
            const d16F = DITHER16[(yFloor & 15) * 16 + (x & 15)];
            const d16C = DITHER16[(yCeil  & 15) * 16 + (x & 15)];
            skipFloor = d16F < threshIn;
            skipCeil  = d16C < threshIn;
          } else if (pDistSq < _TORCH_ZONE_2_SQ) {
            // Bayer16 zone: threshold climbs 60→180
            const t16 = (pDistSq - _TORCH_ZONE_1_SQ) / (_TORCH_ZONE_2_SQ - _TORCH_ZONE_1_SQ);
            const thresh16 = (60 + t16 * 120 + 0.5) | 0;
            const d16F = DITHER16[(yFloor & 15) * 16 + (x & 15)];
            const d16C = DITHER16[(yCeil  & 15) * 16 + (x & 15)];
            skipFloor = d16F < thresh16;
            skipCeil  = d16C < thresh16;
          } else if (pDistSq < _TORCH_ZONE_3_SQ) {
            // Bayer32 zone: threshold climbs 0→220
            const t32 = (pDistSq - _TORCH_ZONE_2_SQ) / (_TORCH_ZONE_3_SQ - _TORCH_ZONE_2_SQ);
            const thresh32 = (t32 * 220 + 0.5) | 0;
            const d32F = DITHER32[(yFloor & 31) * 32 + (x & 31)];
            const d32C = DITHER32[(yCeil  & 31) * 32 + (x & 31)];
            skipFloor = d32F < thresh32;
            skipCeil  = d32C < thresh32;
          } else {
            // Bayer64 edge zone: threshold climbs 128→255
            const t64 = (pDistSq - _TORCH_ZONE_3_SQ) / (16 - _TORCH_ZONE_3_SQ);  // max ~4²=16
            const thresh64 = (128 + (t64 < 1 ? t64 : 1) * 127 + 0.5) | 0;
            const d64F = DITHER64[(yFloor & 63) * 64 + (x & 63)];
            const d64C = DITHER64[(yCeil  & 63) * 64 + (x & 63)];
            skipFloor = d64F < thresh64;
            skipCeil  = d64C < thresh64;
          }

          const a255 = (expFall * 105 + 0.5) | 0;
          if (a255 <= 0) continue;
          const addR = (230 * a255) >> 8;
          const addG = (145 * a255) >> 8;
          const addB = ( 20 * a255) >> 8;

          if (doFloor && !skipFloor) {
            const di = (yFloor * W + x) * 4;
            let v; v = out[di]     + addR; out[di]     = v > 255 ? 255 : v;
            v = out[di + 1] + addG; out[di + 1] = v > 255 ? 255 : v;
            v = out[di + 2] + addB; out[di + 2] = v > 255 ? 255 : v;
          }
          if (doCeil && !skipCeil) {
            const di = (yCeil * W + x) * 4;
            // Specular guard: check actual framebuffer G channel (not delta)
            if (fbOut[di + 1] >= 10) {
              let v; v = out[di]     + addR; out[di]     = v > 255 ? 255 : v;
              v = out[di + 1] + addG; out[di + 1] = v > 255 ? 255 : v;
              v = out[di + 2] + addB; out[di + 2] = v > 255 ? 255 : v;
            }
          }
        }
      }

      // ── Wall-face base strip ───────────────────────────────────────────────
      // Tint the bottom ~35% of the torch's projected wall-column band so the
      // light patch visually bleeds from floor onto the wall face below the torch.
      // Project from the wall-face contact point (same offset as _drawTorchWallGlows)
      // so the strip aligns with the bloom rather than the sprite float position.
      const normX = t.normX || 0, normY = t.normY || 0;
      const wfx = t.x - normX * 0.25 - player.x;
      const wfy = t.y - normY * 0.25 - player.y;
      const ta = _inFrustum(wfx, wfy, player.angle, REACH);
      if (ta !== null) {
        const tDist     = _lastPerpDist; // fisheye-corrected
        const screenX   = Math.max(0, Math.min(W - 1, _saToScreenX(ta)));
        const _twlIdx   = (Math.max(0.1, tDist) * _WALLH_LUT_SCALE + 0.5) | 0;
        const _twlSafe  = _twlIdx < _WALLH_LUT_SIZE ? _twlIdx : _WALLH_LUT_SIZE - 1;
        const wallH     = _WALLH_LUT[_twlSafe];
        const wallTop  = _WALLTOP_LUT[_twlSafe];
        const wallBot  = wallTop + wallH;
        // Cover the lower 35% of the wall face
        const stripTop = Math.max(0, Math.floor(wallBot - wallH * 0.35));
        const stripBot = Math.min(H, wallBot);
        const colSpan  = Math.max(2, Math.floor(wallH * 0.35));
        const bright   = tf.val * Math.max(0, 1 - tDist / REACH);
        if (bright > 0.02) {
          // Per-column perp depth: for column px, the ray angle is _rayAngles[px].
          // zBuffer[px] stores perpDist = euclidean * cos(rayAngle - playerAngle).
          // To compare the torch depth against zBuffer in the same units, compute
          // tDist * cos(rayAngles[px] - player.angle) for each column individually.
          // This is the only basis that correctly matches zBuffer for all columns.
          // Per-column cosA: cos(rayAngle[px] - playerAngle) = soaCos[px]/16384 (player-angle-independent).
          const _soaCosRef = this.raycaster && this.raycaster._soaCos;
          const xMin = Math.max(0, screenX - colSpan);
          const xMax = Math.min(W, screenX + colSpan);
          const _stripMid = (H / 2) | 0;
          for (let px = xMin; px < xMax; px++) {
            const colCosA = _soaCosRef ? _soaCosRef[px] / 16384 : Math.cos(this._rayAngles[px] - player.angle);
            const tPerpDist = tDist * colCosA;
            if (this.zBuffer[px] < tPerpDist - 0.01) continue;   // occluded column
            const hx = (px - screenX) / (colSpan + 1);
            const radH = Math.abs(hx);
            if (radH > 1) continue;
            for (let py = stripTop; py < stripBot; py++) {
              // Floor rows (py > mid) need the row-depth occlusion check in addition to
              // the per-column check above — the column check only tests horizontal occlusion.
              if (py > _stripMid) {
                const floorDepth = _stripMid / (py - _stripMid);
                if (this.zBuffer[px] < floorDepth - 0.05) continue;
              }
              const vy = (py - stripTop) / (stripBot - stripTop + 1);
              const falloff = (1 - radH) * (1 - vy * vy) * bright;
              if (falloff < 0.02) continue;
              const _ef2 = _POW25_LUT[(falloff >= 1 ? 255 : (falloff * 255 + 0.5) | 0)];
              const a255 = (_ef2 * 90 + 0.5) | 0;
              if (DITHER4[(py & 3) * 4 + (px & 3)] < ((((1 - _ef2) * 15 + 0.5) | 0))) continue;
              const idx = py * W + px;
              const wp = _wallFB[idx];
              let r = ( wp        & 0xFF);
              let g = ((wp >>  8) & 0xFF);
              let b = ((wp >> 16) & 0xFF);
              r = Math.min(255, r + ((255 * a255) >> 8));
              g = Math.min(255, g + ((130 * a255) >> 8));
              b = Math.min(255, b + ((  8 * a255) >> 8));
              _wallFB[idx] = _packRGB(r, g, b);
            }
          }
        }
      }
    }

    // ── Apply the built delta to the actual framebuffer ───────────────────────
    // _torchDelta now holds the summed RGB additions from all torches (floor+ceil).
    // Blend additively into fbOut; skip pixels where delta is zero (majority).
    for (let i = 0; i < _torchDelta.length; i += 4) {
      const dr = _torchDelta[i];
      const dg = _torchDelta[i + 1];
      const db = _torchDelta[i + 2];
      if ((dr | dg | db) === 0) continue;
      let v; v = fbOut[i]     + dr; fbOut[i]     = v > 255 ? 255 : v;
      v = fbOut[i + 1] + dg; fbOut[i + 1] = v > 255 ? 255 : v;
      v = fbOut[i + 2] + db; fbOut[i + 2] = v > 255 ? 255 : v;
    }
  }

  _drawTorchWallGlows(torches, player) {
    const halfFov = FOV / 2;
    for (let i = 0; i < torches.length; i++) {
      const t  = torches[i];
      const tf = this._torchFlicker[i] || { val: 1 };

      // Project from the wall-face contact point (torch position pushed back
      // onto the wall surface by one half-unit along the face normal).
      // This anchors the bloom to the physical wall rather than the sprite float.
      const normX = t.normX || 0, normY = t.normY || 0;
      const wx = t.x - normX * 0.25, wy = t.y - normY * 0.25;
      const dx = wx - player.x, dy = wy - player.y;
      const ta = _inFrustum(dx, dy, player.angle, 8);
      if (ta === null) continue;
      const dist       = _lastPerpDist; // fisheye-corrected perp distance
      const screenX    = Math.max(0, Math.min(W - 1, _saToScreenX(ta)));
      // Use the torch's own projected distance for wall geometry so the glow
      // stays on the torch's face even when something closer occludes the column.
      const _wgIdx  = (Math.max(0.1, dist) * _WALLH_LUT_SCALE + 0.5) | 0;
      const _wgSafe = _wgIdx < _WALLH_LUT_SIZE ? _wgIdx : _WALLH_LUT_SIZE - 1;
      const wallH   = _WALLH_LUT[_wgSafe];
      const wallTop = _WALLTOP_LUT[_wgSafe];
      // Vertical center matches the sticker (worldZ = 0.55)
      const screenY  = wallTop + Math.floor((1 - 0.55) * wallH);
      const radius   = Math.max(3, Math.floor(wallH * 0.45));
      const bright   = tf.val * Math.max(0, 1 - dist / 7);
      if (bright < 0.02) continue;

      // Per-column cosA LUT: cos(rayAngle[px] - playerAngle) = soaCos[px]/16384.
      const _wgSoaCos = this.raycaster && this.raycaster._soaCos;

      const xMin = Math.max(0, screenX - radius);
      const xMax = Math.min(W - 1, screenX + radius);
      const yMin = Math.max(0, screenY - radius);
      const yMax = Math.min(H - 1, screenY + radius);

      const _wgMid = (H / 2) | 0;
      for (let py = yMin; py <= yMax; py++) {
        const dithRow = (py & 3) * 4;
        for (let px = xMin; px <= xMax; px++) {
          const fx = (px - screenX) / (radius + 1);
          const fy = (py - screenY) / (radius + 1);
          const radialSq = fx * fx + fy * fy;
          if (radialSq > 1) continue;                           // squared guard — no sqrt
          // Z-buffer gate: use floor-row depth for floor pixels (py > mid),
          // or per-column torch perp depth for wall pixels (py <= mid).
          if (py > _wgMid) {
            // Floor row: rowDist = (H/2) / (py - mid). Occlude if wall is closer.
            const floorDepth = (_wgMid) / (py - _wgMid);
            if (this.zBuffer[px] < floorDepth - 0.05) continue;
          } else {
            const colCosA = _wgSoaCos ? _wgSoaCos[px] / 16384 : Math.cos(this._rayAngles[px] - player.angle);
            const tGlowPerp = dist * colCosA;
            if (this.zBuffer[px] < tGlowPerp - 0.01) continue;
          }
          const radial = radialSq < 0.0001 ? 0 : 1 / fastInvSqrt(radialSq); // only needed for hr
          const hr = Math.max(0, (radial - 0.5) * 2);           // 0 inside half-radius, ramps to 1 at edge
          const falloff = (1 - hr * hr * (3 - 2 * hr)) * bright; // smoothstep: flat core, smooth edge
          const _ef3   = _POW25_LUT[(falloff >= 1 ? 255 : falloff <= 0 ? 0 : (falloff * 255 + 0.5) | 0)];
          if (DITHER4[dithRow + (px & 3)] < ((((1 - _ef3) * 15 + 0.5) | 0))) continue;
          const idx = py * W + px;
          const wp = _wallFB[idx];
          let r = ( wp        & 0xFF);
          let g = ((wp >>  8) & 0xFF);
          let b = ((wp >> 16) & 0xFF);
          // Additive orange tint
          r = Math.min(255, r + (255 * falloff * 0.5) | 0);
          g = Math.min(255, g + (160 * falloff * 0.3) | 0);
          b = Math.min(255, b + ( 20 * falloff * 0.1) | 0);
          _wallFB[idx] = _packRGB(r, g, b);
        }
      }
    }
  }

  _drawTorchFloorHalos(ctx, player, torches) {
    this._drawHalos(ctx, player, torches);
  }
  _drawBrazierFloorHalos(_ctx, _player) { /* handled inside _drawTorchFloorHalos */ }

  _drawHalos(ctx, player, torches) {
    const halfFov  = FOV / 2;
    const mid      = Math.floor(H / 2);
    const buf      = this._haloImageData.data;
    const zBuf     = this.zBuffer;

    // Zero the buffer — single memset, no per-pixel overhead
    buf.fill(0);

    // Inner helper: paint one elliptical halo into buf.
    // r,g,b in [0,255]; haloAlpha in [0,1] (peak brightness at centre).
    // euclidDist = Euclidean player→source distance; pa = player.angle.
    // For each column px we compute tDist*cos(rayAngles[px]-pa) to match zBuffer units.
    const rayAnglesRef = this._rayAngles;
    const _haloMid = (H / 2) | 0;
    const paintHalo = (screenX, euclidDist, haloW, haloH, haloY, haloAlpha, r, g, b) => {
      if (haloAlpha < 0.02 || haloW < 2) return;

      // Cap dimensions: standing inside a torch can't push these past full-screen.
      // Torch/brazier radii at dist=0.2 (the floor): W*0.3/0.2 = 480 ��� cap at W.
      const capW = Math.min(haloW, W);
      const capH = Math.min(haloH, _haloMid); // never taller than floor half

      const pyMin = Math.max(_haloMid, haloY - capH);
      const pyMax = Math.min(H - 1, haloY + capH);
      const pa    = player.angle;

      for (let py = pyMin; py <= pyMax; py++) {
        const fy  = (py - haloY) / (capH + 1);
        const fy2 = fy * fy;
        const _rowArg = Math.max(0, 1 - fy2);
        // sqrt(1-fy2) = 1/fastInvSqrt(1-fy2); guard against ~0 to avoid div issues
        const rowW = _rowArg < 0.0001 ? 0 : ((capW / fastInvSqrt(_rowArg)) | 0);
        if (rowW < 1) continue;

        // For floor rows (py > mid), compute floor perp depth for this scanline.
        // rowDist = (H/2) / (py - mid) — same formula used by floor caster.
        const isFloorRow = py > _haloMid;
        const floorDepth = isFloorRow ? _haloMid / (py - _haloMid) : 0;

        const pxMin   = Math.max(0, screenX - rowW);
        const pxMax   = Math.min(W - 1, screenX + rowW);
        const dithRow = (py & 3) * 4;

        for (let px = pxMin; px <= pxMax; px++) {
          // Dither gate — exponential falloff matching wall/torch lights
          const fx        = (px - screenX) / (rowW + 1);
          const radialSq  = fx * fx + fy2;
          if (radialSq > 1) continue;                           // squared guard — no sqrt
          // Compute radius with smooth half-radius flat core, then exponential
          const radial   = radialSq < 0.0001 ? 0 : 1 / fastInvSqrt(radialSq);
          const hr       = Math.max(0, (radial - 0.5) * 2);
          const coreFall = haloAlpha * (1 - hr * hr * (3 - 2 * hr));
          const expFall  = _POW25_LUT[(coreFall >= 1 ? 255 : coreFall <= 0 ? 0 : (coreFall * 255 + 0.5) | 0)];
          if (DITHER4[dithRow + (px & 3)] < ((((1 - expFall) * 15 + 0.5) | 0))) continue;

          // Z-buffer gate — floor rows use row-depth; wall rows use per-column torch perp.
          // cos(rayAngles[px] - pa) = soaCos[px]/16384 (player-angle-independent LUT).
          if (isFloorRow) {
            if (zBuf[px] < floorDepth - 0.05) continue;
          } else {
            const colCosA = rayAnglesRef ? (this.raycaster._soaCos ? this.raycaster._soaCos[px] / 16384 : Math.cos(rayAnglesRef[px] - pa)) : 1;
            const colPerp = euclidDist * colCosA;
            if (zBuf[px] < colPerp - 0.01) continue;
          }

          // Additive accumulate — alpha driven by same exponential curve
          const a255 = (expFall * 255 + 0.5) | 0;
          if (a255 <= 0) continue;

          const idx = (py * W + px) * 4;
          buf[idx]     = Math.min(255, buf[idx]     + ((r * a255) >> 8));
          buf[idx + 1] = Math.min(255, buf[idx + 1] + ((g * a255) >> 8));
          buf[idx + 2] = Math.min(255, buf[idx + 2] + ((b * a255) >> 8));
          buf[idx + 3] = Math.min(255, buf[idx + 3] + a255);
        }
      }
    };

    // ── Torches — wall glow is now handled by _drawTorchWallGlows into _wallFB

    // ── Braziers ─────────────────────────────────────────────
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      const dx = d.x - player.x, dy = d.y - player.y;
      const ta = _inFrustum(dx, dy, player.angle, 7);
      if (ta === null) continue;
      const dist        = _lastPerpDist; // fisheye-corrected perp distance
      const bf          = this._brazierFlicker.get(di) || { val: 1 };
      // haloPerp = perp distance (same as dist — _lastPerpDist is the dot product).
      const haloPerp = Math.max(0.2, dist);
      const screenX  = _saToScreenX(ta);
      paintHalo(screenX, dist,
        Math.floor(W * 0.35  / haloPerp),                  // size uses center-column perp
        Math.floor(H * 0.12  / haloPerp),
        mid + Math.floor(H * 0.12 / haloPerp),
        bf.val * Math.max(0, 1 - dist / 6) * 0.35,
        255, 120, 30);
    }

    // ── Flush to screen ───────────────────────────────────────
    // putImageData bypasses globalCompositeOperation, so we blit the buffer
    // onto a scratch canvas first, then drawImage that with 'lighter' blending.
    // The scratch canvas is lazily created and reused every frame.
    if (!this._haloCanvas) {
      this._haloCanvas = document.createElement('canvas');
      this._haloCanvas.width  = W;
      this._haloCanvas.height = H;
      this._haloCtx = this._haloCanvas.getContext('2d');
      this._haloCtx.imageSmoothingEnabled = false;
    }
    this._haloCtx.putImageData(this._haloImageData, 0, 0);

    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._haloCanvas, 0, 0);
    ctx.globalCompositeOperation = prevOp;
  }

  // ─────────────��───────────────────────────────────────────
  // Sprite dispatcher — aggressive frustum + distance culling
  // ─────────────────────────────────────────────────────────
  _drawSprites(ctx, player, enemies, projectiles) {
    const halfFov = FOV / 2;
    const pa = player.angle;
    const px = player.x, py = player.y;

    // Reuse module-level sprite pool to avoid per-frame allocations.
    // Reset pool write cursor; read back exactly spriteCount entries after fill.
    _spritePoolIdx = 0;
    let spriteCount = 0;

    // Enemies (alive + dead flat) — already have dist from EnemyManager
    for (const e of enemies) {
      const dx = e.x - px, dy = e.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_ENEMY_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;  // near-clip: avoids blow-up when player walks through
      // Use perp distance (fisheye-corrected) so projection matches wall heights.
      _poolSprite('enemy', e, sa, _lastPerpDist); spriteCount++;
    }

    // Decor — cull at shorter range (static, never need to see very far)
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      const dx = d.x - px, dy = d.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_DECOR_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;
      _poolSprite('decor', d, sa, _lastPerpDist, di); spriteCount++;
    }

    // Gem key pickups
    for (const gk of (this.map.gemKeyPickups || [])) {
      if (gk.collected) continue;
      const dx = gk.x - px, dy = gk.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PICKUP_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;
      _poolSprite('gemkey', gk, sa, _lastPerpDist); spriteCount++;
    }

    // Pickups
    for (const p of this.map.pickups) {
      const dx = p.x - px, dy = p.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PICKUP_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;
      _poolSprite('pickup', p, sa, _lastPerpDist); spriteCount++;
    }

    // Torches — short visibility range.
    // If the torch has a wall sticker registered (the normal case after initLevel
    // wires them up), skip the floor-standing billboard entirely — the sticker
    // painted into _wallFB and the floor halo are sufficient.  Only fall back to
    // the billboard for any torch that somehow has no adjacent wall sticker
    // (e.g. a torch placed in the middle of a room with no nearby wall).
    for (let i = 0; i < (this.map.torches || []).length; i++) {
      const t = this.map.torches[i];
      // Check all 4 cardinal wall neighbours for a registered sticker.
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      // Use baked wall tile, or scan neighbours as fallback for old saves.
      let hasStickerOnWall = false;
      if (t.wallX != null) {
        hasStickerOnWall = this.raycaster.getStickers(t.wallX, t.wallY)?.length > 0;
      } else {
        hasStickerOnWall = (
          this.raycaster.getStickers(gx,     gy - 1)?.length > 0 ||
          this.raycaster.getStickers(gx,     gy + 1)?.length > 0 ||
          this.raycaster.getStickers(gx - 1, gy    )?.length > 0 ||
          this.raycaster.getStickers(gx + 1, gy    )?.length > 0
        );
      }
      if (hasStickerOnWall) continue;  // sticker path active — no billboard needed
      const dx = t.x - px, dy = t.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_TORCH_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;
      _poolSprite('torch', t, sa, _lastPerpDist, -1, i); spriteCount++;
    }

    // Exit portal — longer range so it's always findable
    const portal = this.map.exitPortal;
    if (portal) {
      const dx = portal.x - px, dy = portal.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PORTAL_DIST);
      if (sa !== null && _lastPerpDist >= 0.5) {
        _poolSprite('portal', portal, sa, _lastPerpDist); spriteCount++;
      }
    }

    // Projectile bolts — crossbow and fire tome only
    for (const bolt of projectiles) {
      if (!bolt.alive) continue;
      const dx = bolt.x - px, dy = bolt.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PLASMA_DIST);
      if (sa === null) continue;
      if (_lastPerpDist < 0.5) continue;
      let btype;
      if (bolt.weaponType === 'crossbow') btype = 'crossbow_bolt';
      else if (bolt.weaponType === 'plasma2' || bolt.weaponType === 'cannon') btype = 'plasma';
      else continue; // hitscan weapons don't spawn visible bolts
      _poolSprite(btype, bolt, sa, _lastPerpDist); spriteCount++;
    }

    // Sort back-to-front — only the live slice [0..spriteCount).
    // Insertion sort for typical counts (< 32 sprites); native sort fallback for large crowds.
    const sprites = _spritePool;
    if (spriteCount <= 32) {
      for (let i = 1; i < spriteCount; i++) {
        const key = sprites[i]; const kd = key.dist; let j = i - 1;
        while (j >= 0 && sprites[j].dist < kd) { sprites[j + 1] = sprites[j]; j--; }
        sprites[j + 1] = key;
      }
    } else {
      // For larger counts, sort a temp slice view
      const live = sprites.slice(0, spriteCount);
      live.sort((a, b) => b.dist - a.dist);
      for (let i = 0; i < spriteCount; i++) sprites[i] = live[i];
    }

    for (let si = 0; si < spriteCount; si++) {
      const s = sprites[si];
      const screenX = _saToScreenX(s.sa); // LUT-based sa → column

      if (s.type === 'enemy') {
        this._drawEnemySprite(ctx, s.data, screenX, s.dist, halfFov, s.sa);
      } else if (s.type === 'decor') {
        this._drawDecorSprite(ctx, s.data, s.decorIdx, screenX, s.dist);
      } else if (s.type === 'gemkey') {
        this._drawGemKeySprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'pickup') {
        this._drawPickupSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'torch') {
        this._drawTorchSprite(ctx, s.data, s.torchIdx, screenX, s.dist);
      } else if (s.type === 'portal') {
        this._drawPortalSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'plasma') {
        this._drawPlasmaSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'crossbow_bolt') {
        this._drawCrossbowBolt(ctx, s.data, screenX, s.dist);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Enemy sprite — alive = billboard, dead = flat decal
  // ─────────────────────────────────────────────────────────
  _drawEnemySprite(ctx, e, screenX, dist, halfFov, r) {
    // Normalise r=cross/dot to [-1,1] for AI screenX tracking.
    // atan(r)/halfFov matches the linear-angle wall mapping.
    e.screenX = Math.atan(r) / halfFov;

    // ── Dead enemy: flat sprite on floor
    if (!e.alive) {
      if (e.deathTimer <= 0) return;
      this._drawDeadEnemyFlat(ctx, e, screenX, dist);
      return;
    }

    // ── Per-type visual config ─────────────────────────────
    let img, heightMult, widthMult, yShift, glowColor, glowAlphaBase;
    glowColor = null;
    glowAlphaBase = 0;
    yShift = 0;

    // Determine animation key and pick frame
    let animKey = null; // which enemyAnims key to use
    if (e.isAbomination) {
      animKey = null; // handled below with direct frame selection
      heightMult = 2.8;
      widthMult  = 1.4;
      glowColor  = e.enraged ? '160,0,255' : '100,0,200';
      glowAlphaBase = 0.18 + 0.1 * Math.sin(this._time * 5);
      if (e.state === 'attack') {
        const ABOM_ATK = [this.assets.abomAtk1, this.assets.abomAtk2, this.assets.abomAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = ABOM_ATK[atkIdx] || this.assets.abomIdle || this.assets.abomination;
      } else if (e.state === 'chase') {
        const ABOM_WLK = [this.assets.abomWlk1, this.assets.abomWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = ABOM_WLK[wlkIdx] || this.assets.abomIdle || this.assets.abomination;
      } else {
        img = this.assets.abomIdle || this.assets.abomination;
      }
    } else if (e.isBoss) {
      // Use individual boss frames: idle / walk / attack
      animKey = null; // handled below with direct frame selection
      heightMult = 2.0;
      widthMult  = 1.0; // 1:1 — enforced to square after clamping
      glowColor  = null; // no ambient glow — green torch effect replaces it
      glowAlphaBase = 0;
      // Pick frame based on state
      if (e.state === 'attack') {
        // 3-frame attack sequence at ~8 fps
        const BOSS_ATK = [this.assets.bossAtk1, this.assets.bossAtk2, this.assets.bossAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = BOSS_ATK[atkIdx] || this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      } else if (e.state === 'chase' || e.charging) {
        // 2-frame walk cycle at ~4 fps
        const BOSS_WLK = [this.assets.bossWlk1, this.assets.bossWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = BOSS_WLK[wlkIdx] || this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      } else {
        // Idle
        img = this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      }
    } else if (e.type === 'bat') {
      animKey = null; // handled below with direct frame selection
      heightMult = 0.7;
      widthMult  = 1.5;
      yShift = -0.12;
      if (e.state === 'attack') {
        const BAT_ATK = [this.assets.batAtk1, this.assets.batAtk2, this.assets.batAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = BAT_ATK[atkIdx] || this.assets.batIdle || this.assets.bat;
      } else if (e.state === 'chase') {
        const BAT_WLK = [this.assets.batWlk1, this.assets.batWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = BAT_WLK[wlkIdx] || this.assets.batIdle || this.assets.bat;
      } else {
        img = this.assets.batIdle || this.assets.bat;
      }
    } else if (e.type === 'spider') {
      animKey = null; // handled below with direct frame selection
      heightMult = 0.75;
      widthMult  = 1.3;
      yShift = 0.14;
      if (e.state === 'attack') {
        const SPD_ATK = [this.assets.spiderAtk1, this.assets.spiderAtk2, this.assets.spiderAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = SPD_ATK[atkIdx] || this.assets.spiderIdle || this.assets.spider;
      } else if (e.state === 'chase') {
        const SPD_WLK = [this.assets.spiderWlk1, this.assets.spiderWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = SPD_WLK[wlkIdx] || this.assets.spiderIdle || this.assets.spider;
      } else {
        img = this.assets.spiderIdle || this.assets.spider;
      }
    } else {
      // Goblin — use individual frames (same pattern as Troll boss)
      animKey = null; // handled below with direct frame selection
      heightMult = 1.0;
      widthMult  = 1.0;
      if (e.state === 'attack') {
        const GOB_ATK = [this.assets.gobAtk1, this.assets.gobAtk2, this.assets.gobAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = GOB_ATK[atkIdx] || this.assets.gobIdle || this.assets.goblin;
      } else if (e.state === 'chase') {
        const GOB_WLK = [this.assets.gobWlk1, this.assets.gobWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = GOB_WLK[wlkIdx] || this.assets.gobIdle || this.assets.goblin;
      } else {
        img = this.assets.gobIdle || this.assets.goblin;
      }
    }

    // Pick animated frame — custom mod frames take priority over spritesheet
    // (only runs when animKey is set, i.e. bat/spider/abomination — not goblin/boss)
    {
      const animType = (e.state === 'attack') ? 'attack' : 'walk';
      const fps = (animType === 'attack') ? 6 : 4;
      const customSet = animKey ? customAnimFrames[animKey] : null;
      const customFrameList = customSet ? customSet[animType] : null;
      // Check if any custom frame is loaded for this anim type
      const hasCustomFrames = customFrameList && customFrameList.some(f => f && f.complete && f.naturalWidth > 0);
      if (hasCustomFrames) {
        const frameIdx = Math.floor(this._time * fps) % customFrameList.length;
        const cf = customFrameList[frameIdx];
        if (cf && cf.complete && cf.naturalWidth > 0) img = cf;
        else {
          // Fall back to first loaded custom frame if current slot is empty
          const fallback = customFrameList.find(f => f && f.complete && f.naturalWidth > 0);
          if (fallback) img = fallback;
        }
      } else if (animKey) {
        // Fall back to spritesheet animation
        const anims = this.enemyAnims[animKey];
        if (anims) {
          const sheet = anims[animType] || anims.walk;
          if (sheet && sheet.ready) {
            const frameIdx = Math.floor(this._time * fps) % sheet.frames.length;
            const frame = sheet.getFrame(frameIdx);
            if (frame) img = frame;
          }
        }
      }
    }

    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const imgReady = img instanceof HTMLCanvasElement ? (imgW > 0) : (img.complete && imgW > 0);
    if (!img || !imgReady) return;

    let height = Math.floor((H * heightMult) / Math.max(0.1, dist));
    let width  = Math.floor(height * widthMult);

    // ── Boss: square pixel ratio, 256px max ──
    if (e.isBoss) {
      const side = Math.min(height, 256);
      height = side;
      width  = side;
    }

    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height + height * yShift);
    const left   = screenX - Math.floor(width / 2);

    let bright = this._flickerVal / (1 + dist * 0.15);
    bright = Math.min(1, Math.max(0.1, bright));

    // ── Glow halo for abomination ──
    if (glowColor && glowAlphaBase > 0 && dist < 12) {
      const glowAlpha = glowAlphaBase * Math.max(0, 1 - dist / 12);
      const glowR = Math.floor(width * 0.6);
      for (let sx = Math.max(0, left - glowR); sx < Math.min(W, left + width + glowR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - screenX) / (glowR + width / 2 + 1);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = glowAlpha * (1 - radial);
        ctx.fillStyle = `rgba(${glowColor},${alpha.toFixed(2)})`;
        ctx.fillRect(sx, Math.max(0, top - 4), 1, height + 8);
      }
    }

    // ── Boss: green torch glow halo (interacts with per-column torch light) ──
    if (e.isBoss && dist < 14) {
      const torchLight = this._torchLight;
      // Sample average torch light across the boss's screen columns
      const clL = Math.max(0, left), clR = Math.min(W, left + width);
      let avgTorch = 0, tSamples = 0;
      for (let sx = clL; sx < clR; sx++) {
        avgTorch += torchLight ? (torchLight[sx] || 0) : 0;
        tSamples++;
      }
      avgTorch = tSamples > 0 ? avgTorch / tSamples : 0;

      // Flicker-driven base pulse (mirrors torch flicker rhythm)
      const flickerBase = this._flickerVal;
      const pulse = flickerBase * (0.55 + 0.35 * Math.sin(this._time * 6.2));
      // Torch proximity boosts the green halo just like torches boost walls
      const torchBoost = Math.min(0.5, avgTorch * 0.8);
      const haloAlpha = (pulse * 0.32 + torchBoost * 0.22) * Math.max(0, 1 - dist / 14);

      const haloR = Math.floor(width * 0.75);
      const _bossWallTop = Math.max(0, top - Math.floor(height * 0.2));
      const _bossWallBot = Math.min(H, top + height + Math.floor(height * 0.15));
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = haloAlpha * (1 - radial) * (1 - radial);
        if (alpha < 0.01) continue;
        ctx.fillStyle = `rgba(40,255,80,${alpha.toFixed(2)})`;
        ctx.fillRect(sx, _bossWallTop, 1, _bossWallBot - _bossWallTop);
      }

      // Inner flame core — bright green wisps at top of sprite
      const fireH = Math.max(2, Math.floor(height * 0.22));
      const fireW = Math.max(2, Math.floor(width * 0.45));
      const fireX = screenX - Math.floor(fireW / 2);
      const fireY = top - Math.floor(fireH * 0.25);
      const fireAlpha = (pulse * 0.65 + torchBoost * 0.4) * Math.max(0, 1 - dist / 10);
      if (fireAlpha > 0.04) {
        for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          const fx = (sx - fireX) / fireW;
          const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.8);
          if (fa < 0.04) continue;
          ctx.fillStyle = `rgba(60,255,100,${fa.toFixed(2)})`;
          ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.6));
          ctx.fillStyle = `rgba(180,255,160,${(fa * 0.55).toFixed(2)})`;
          ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.25));
        }
      }
    }

    const abomEnragePulse = e.isAbomination && e.enraged
      ? (0.25 + 0.2 * Math.sin(this._time * 10))
      : 0;

    const _dark = 1 - Math.min(1, bright);
    const _pain = e.pain;
    const _abom = abomEnragePulse;
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
      if (_dark > 0.05) {
        sc.fillStyle = `rgba(0,0,0,${_dark})`;
        sc.fillRect(ol, ot, ow, oh);
      }
      if (_pain > 0) {
        sc.fillStyle = `rgba(255,50,0,${Math.min(0.65, _pain * 1.8)})`;
        sc.fillRect(ol, ot, ow, oh);
      }
      if (_abom > 0) {
        sc.fillStyle = `rgba(160,0,255,${_abom})`;
        sc.fillRect(ol, ot, ow, oh);
      }
    });

    // ── Brightmap: red eye self-illumination — non-Abomination enemies only.
    // The Abomination has black void eyes; no brightmap is applied.
    if (!e.isAbomination) {
      this._drawBrightmapOverlay(ctx, img, left, top, width, height, dist);
    }

    // Boss health bars (HUD-style, kept for readability on big fights)
    if (e.isAbomination && dist < 20) {
      this._drawAbominationHealthBar(ctx, e);
    } else if (e.isBoss && dist < 15) {
      this._drawBossHealthBar(ctx, e);
    }
  }

  _drawAbominationHealthBar(ctx, boss) {
    const hp = Math.max(0, boss.health / boss.maxHealth);
    const barW = W - 20;
    const barH = 7;
    const bx = 10, by = 6;
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 6);
    const enraged = boss.enraged;

    ctx.fillStyle = enraged ? `rgba(80,0,80,0.9)` : `rgba(40,0,80,0.85)`;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = enraged ? '#200020' : '#120020';
    ctx.fillRect(bx, by, barW, barH);

    const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    if (enraged) {
      grad.addColorStop(0, '#ff00ff');
      grad.addColorStop(0.5, '#cc00cc');
      grad.addColorStop(1, '#ff44ff');
    } else {
      grad.addColorStop(0, '#8800cc');
      grad.addColorStop(0.5, '#aa00ff');
      grad.addColorStop(1, '#cc44ff');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, Math.floor(barW * hp), barH);

    ctx.strokeStyle = enraged
      ? `rgba(255,0,255,${0.6 + 0.4 * pulse})`
      : `rgba(180,0,255,${0.5 + 0.4 * pulse})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1, by - 1, barW + 2, barH + 2);

    ctx.fillStyle = enraged ? '#ff88ff' : '#cc88ff';
    ctx.font = `bold 6px ${getModFont()}`;
    ctx.textAlign = 'left';
    ctx.fillText(enraged ? '💀 THE ABOMINATION [ENRAGED]' : '💀 THE ABOMINATION', bx, by - 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ddaaff';
    ctx.fillText(`${Math.ceil(boss.health)} / ${boss.maxHealth}`, bx + barW, by - 2);
    ctx.textAlign = 'left';
  }

  _drawBossHealthBar(ctx, boss) {
    const hp = Math.max(0, boss.health / boss.maxHealth);
    const barW = W - 20;
    const barH = 6;
    const bx = 10, by = 6;
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 4);
    ctx.fillStyle = `rgba(120,0,0,0.8)`;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = '#220000';
    ctx.fillRect(bx, by, barW, barH);
    const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(0.5, '#ff4400');
    grad.addColorStop(1, '#ffaa00');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, Math.floor(barW * hp), barH);
    ctx.strokeStyle = `rgba(255,50,0,${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = '#ff8888';
    ctx.font = `bold 6px ${getModFont()}`;
    ctx.textAlign = 'left';
    ctx.fillText('TROLL WARLORD', bx, by - 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffaaaa';
    ctx.fillText(`${Math.ceil(boss.health)} / ${boss.maxHealth}`, bx + barW, by - 2);
    ctx.textAlign = 'left';
  }

  // Doom-style death flat: squashed sprite lying on floor
  _drawDeadEnemyFlat(ctx, e, screenX, dist) {
    let img;
    if (e.isAbomination)        img = this.assets.abomDead         || this.assets.abominationDead || this.assets.goblin;
    else if (e.isBoss)          img = this.assets.bossDead         || this.assets.trollDead  || this.assets.goblinDead || this.assets.goblin;
    else if (e.type === 'bat')  img = this.assets.batDeadFlat      || this.assets.batDead    || this.assets.goblin;
    else if (e.type === 'spider') img = this.assets.spiderDeadFlat || this.assets.spiderDead || this.assets.goblin;
    else                        img = this.assets.gobDead          || this.assets.goblinDead || this.assets.goblin;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const alpha = Math.min(1, e.deathTimer / 1.5);
    if (alpha <= 0.01) return;

    const flatW = Math.floor(H * 1.1 / Math.max(0.1, dist));
    const flatH = Math.max(2, Math.floor(flatW * 0.22));
    const top = _floorRow(dist) - Math.floor(flatH / 2);
    const left = screenX - Math.floor(flatW / 2);

    const clippedLeft = Math.max(0, left);
    const clippedRight = Math.min(W, left + flatW);
    let anyVisible = false;
    for (let sx = clippedLeft; sx < clippedRight; sx++) {
      if (this.zBuffer[sx] > dist) { anyVisible = true; break; }
    }
    if (!anyVisible) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    this._drawSpriteIsolated(ctx, img, left, top, flatW, flatH, dist, (sc, ol, ot, ow, oh) => {
      sc.fillStyle = `rgba(180,0,0,0.35)`;
      sc.fillRect(ol, ot, ow, oh);
    });
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────
  // Puddle flat decal — rendered BELOW the floor line
  // ─────────────────────────────────────────────────────────
  _drawPuddle(ctx, img, screenX, dist) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    // Place puddle centered on floor line, squashed flat
    const flatW = Math.floor(H * 1.2 / Math.max(0.1, dist));
    const flatH = Math.max(2, Math.floor(flatW * 0.18));
    // Position slightly BELOW the floor line (pushed down by half height)
    const floorY = _floorRow(dist);
    const top = floorY - Math.floor(flatH * 0.3); // mostly below floor line

    const left = screenX - Math.floor(flatW / 2);
    const clippedLeft  = Math.max(0, left);
    const clippedRight = Math.min(W, left + flatW);

    let anyVisible = false;
    for (let sx = clippedLeft; sx < clippedRight; sx++) {
      if (this.zBuffer[sx] > dist) { anyVisible = true; break; }
    }
    if (!anyVisible) return;

    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.25));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness fog → use precache
    this._drawSpriteIsolated(ctx, img, left, top, flatW, flatH, dist, null,
      undefined, undefined, undefined, undefined, dark);
  }

  // ─────────────────────────────────────────────────────────
  // Decor sprite — handles all new decor types
  // ─────────────────────────────────────────────────────────
  _drawDecorSprite(ctx, d, decorIdx, screenX, dist) {
    const type = d.type;

    // ── Puddles: rendered flat on floor ──
    if (d.isPuddle) {
      const puddleImgMap = {
        puddleWater: this.assets.puddleWater,
        puddleSlime: this.assets.puddleSlime,
        puddleBlood: this.assets.puddleBlood,
        puddleMud:   this.assets.puddleMud,
      };
      const img = puddleImgMap[type] || this.assets.puddleWater;
      this._drawPuddle(ctx, img, screenX, dist);
      return;
    }

    // ── Brazier: tall, glowing fire sprite ──
    if (d.isBrazier) {
      this._drawBrazierSprite(ctx, d, decorIdx, screenX, dist);
      return;
    }

    // ── Treasure chest ──
    if (type === 'treasureChest') {
      this._drawBillboard(ctx, this.assets.treasureChest, screenX, dist, 0.65, 0);
      return;
    }

    // ── Table ──
    if (type === 'table') {
      this._drawBillboard(ctx, this.assets.table, screenX, dist, 0.65, 0.12);
      return;
    }

    // ── Chair ──
    if (type === 'chair') {
      this._drawBillboard(ctx, this.assets.chair, screenX, dist, 0.55, 0.15);
      return;
    }

    // ── Cobweb → hatched spider egg cluster ──
    if (type === 'cobweb') {
      this._drawBillboard(ctx, this.assets.spiderEggs, screenX, dist, 0.38, 0.12);
      return;
    }

    // ── Small decors (skull, bones, claypot) via decorSmall atlas ──
    // decorSmall is a 2x2 spritesheet: [skull, bones; claypot, (unused)]
    if (type === 'skull' || type === 'bones' || type === 'claypot') {
      const quadMap = { skull: 0, bones: 1, claypot: 2 };
      const quad = quadMap[type] !== undefined ? quadMap[type] : 0;
      this._drawSmallDecorQuad(ctx, quad, screenX, dist, 0.35);
      return;
    }

    // ── Standard billboard decors ──
    let img;
    let heightScale = 0.85;
    let yOffset = 0;

    if (type === 'barrel') {
      img = this.assets.barrel;
      heightScale = 0.7;
      yOffset = 0.08;
    } else if (type === 'pillar') {
      img = this.assets.pillar;
      heightScale = 0.95;
    } else if (type === 'bookshelf') {
      img = this.assets.bookshelf;
      heightScale = 0.9;
    } else if (type === 'rubble') {
      img = this.assets.rubble;
      heightScale = 0.5;
      yOffset = 0.25;
    } else {
      img = this.assets.pillar;
    }

    this._drawBillboard(ctx, img, screenX, dist, heightScale, yOffset);
  }

  /** Generic billboard renderer: pins bottom to floor, applies z-buffer clip */
  _drawBillboard(ctx, img, screenX, dist, heightScale, yOffset) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    heightScale = heightScale || 0.85;
    yOffset = yOffset || 0;

    const height = Math.floor((H * heightScale) / Math.max(0.1, dist));
    const width = Math.floor(height * (img.naturalWidth / img.naturalHeight));
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height + height * yOffset);
    const left = screenX - Math.floor(width / 2);
    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.2));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness overlay → use precache
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      undefined, undefined, undefined, undefined, dark);
  }

  /** Draw a quadrant of the decorSmall 2x2 spritesheet (quad 0-3: skull,bones,claypot,cobweb) */
  _drawSmallDecorQuad(ctx, quad, screenX, dist, heightScale) {
    const img = this.assets.decorSmall;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    heightScale = heightScale || 0.35;
    const col = quad % 2;
    const row = Math.floor(quad / 2);
    const fw = img.naturalWidth / 2;
    const fh = img.naturalHeight / 2;
    const sx = col * fw, sy = row * fh;

    const height = Math.floor((H * heightScale) / Math.max(0.1, dist));
    const width  = Math.floor(height * (fw / fh));
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height);
    const left   = screenX - Math.floor(width / 2);
    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.22));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness overlay → use precache with atlas sub-rect
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      sx, sy, fw, fh, dark);
  }

  /** Brazier: glowing fire billboard with animated flame on top */
  _drawBrazierSprite(ctx, d, decorIdx, screenX, dist) {
    const img = this.assets.brazier;
    const bf = this._brazierFlicker.get(decorIdx) || { val: 1 };
    const flicker = bf.val;

    const height = Math.floor((H * 0.8) / Math.max(0.1, dist));
    const aspectRatio = (img && img.naturalWidth > 0) ? img.naturalWidth / img.naturalHeight : 1;
    const width  = Math.floor(height * aspectRatio);
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height);
    const left   = screenX - Math.floor(width / 2);
    const bright = Math.min(1.1, flicker / (1 + dist * 0.12));

    // Wall halo glow
    if (dist < 5) {
      const haloAlpha = flicker * Math.max(0, 1 - dist / 5) * 0.3;
      const haloR = Math.floor(width * 0.9);
      const _brazWallTop = Math.max(0, top - Math.floor(height * 0.3));
      const _brazWallBot = Math.min(H / 2, top + height);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = haloAlpha * (1 - radial) * (1 - radial);
        if (alpha < 0.01) continue;
        ctx.fillStyle = `rgba(255,100,10,${alpha.toFixed(2)})`;
        ctx.fillRect(sx, _brazWallTop, 1, _brazWallBot - _brazWallTop);
      }
    }

    // Brazier body — fullbright (self-luminous light source, darkOnly=0)
    if (img && img.complete && img.naturalWidth > 0) {
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
        undefined, undefined, undefined, undefined, 0);
    }

    // Animated fire flicker on top of brazier
    const fireH = Math.max(2, Math.floor(height * 0.4));
    const fireW = Math.max(2, Math.floor(width * 0.6));
    const fireX = screenX - Math.floor(fireW / 2);
    const fireY = top - Math.floor(fireH * 0.4);
    const fireAlpha = flicker * 0.9 * Math.max(0, 1 - dist / 9);

    if (fireAlpha > 0.04 && dist < 9) {
      for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const fx = (sx - fireX) / fireW;
        const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.6);
        if (fa < 0.04) continue;
        ctx.fillStyle = `rgba(255,110,0,${fa.toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.65));
        ctx.fillStyle = `rgba(255,230,60,${(fa * 0.8).toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.3));
      }
    }
  }

  // ──────────────────────────────────────────────��──────────
  // Gem key pickup sprite
  // ─────────────────────────────────────────────────────────
  _drawGemKeySprite(ctx, gk, screenX, dist) {
    const img = this.assets.gemKeys;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    // gemKeys is a 3-wide spritesheet: red | green | blue
    const colorIdx = gk.color === 'red' ? 0 : (gk.color === 'green' ? 1 : 2);
    const fw = Math.floor(img.naturalWidth / 3);
    const fh = img.naturalHeight;
    const sx = colorIdx * fw;

    const bobOffset = Math.floor(Math.sin(this._time * 3.5 + colorIdx) * 3);
    const height = Math.floor((H * 0.45) / Math.max(0.1, dist));
    const width  = Math.floor(height * (fw / fh));
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height) + bobOffset;
    const left   = screenX - Math.floor(width / 2);

    const clL = Math.max(0, left), clR = Math.min(W, left + width);
    let vis = false;
    for (let sx2 = clL; sx2 < clR; sx2++) { if (this.zBuffer[sx2] > dist) { vis = true; break; } }
    if (!vis) return;

    // Colored glow
    const glowRgb = gk.color === 'red' ? '255,60,60' : (gk.color === 'green' ? '60,255,80' : '60,120,255');
    const glowAlpha = 0.3 + 0.2 * Math.sin(this._time * 5);
    for (let sx2 = clL; sx2 < clR; sx2++) {
      if (this.zBuffer[sx2] <= dist + 0.1) continue;
      const fx = (sx2 - screenX) / (width * 0.8);
      const radial = Math.abs(fx);
      if (radial > 1) continue;
      const alpha = glowAlpha * (1 - radial * 0.8);
      ctx.fillStyle = `rgba(${glowRgb},${alpha.toFixed(2)})`;
      ctx.fillRect(sx2, top - 2, 1, height + 4);
    }

    // Gem keys are fullbright — pass darkOnly=0 so the sprite is unfogged
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      sx, 0, fw, fh, 0);

    // Label at close range
    if (dist < 4) {
      const label = `${gk.color.toUpperCase()} KEY`;
      ctx.fillStyle = `rgba(${glowRgb},${Math.min(0.9, (4-dist)/4)})`;
      ctx.font = `6px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText(label, screenX, top - 2);
      ctx.textAlign = 'left';
    }
  }

  // ─────��───────────────────────────────────────────────────
  // Pickup sprite
  // ─────────────────────��───────────────────────────────────
  _drawPickupSprite(ctx, p, screenX, dist) {
    const img = p.type === 'health' ? this.assets.healthPack : this.assets.ammoCrate;
    const bobOffset = Math.floor(Math.sin(this._time * 3) * 3);
    const height = Math.floor((H * 0.5) / Math.max(0.1, dist));
    const width = height;
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height) + bobOffset;
    const left = screenX - Math.floor(width / 2);
    // Pickups are fullbright — always drawn at full color regardless of ambient lighting.
    if (img && img.complete && img.naturalWidth > 0) {
      if (dist >= 4) {
        // Fullbright fast path: darkOnly=0 → bucket[0] = undarked sprite
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
          undefined, undefined, undefined, undefined, 0);
      } else {
        // Close range: fullbright + color glow overlay
        const _type = p.type;
        const glowAlpha = Math.min(0.6, (4 - dist) / 4 * 0.6);
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
          sc.fillStyle = _type === 'health' ? `rgba(0,255,100,${glowAlpha})` : `rgba(255,200,0,${glowAlpha})`;
          sc.fillRect(ol, ot, ow, oh);
        });
      }
    }
  }

  // ─────────���───────────────────────────────────────────────
  // Torch sprite
  // ─────────────────────────────────────────────────────────
  _drawTorchSprite(ctx, t, torchIdx, screenX, dist) {
    const img = this.assets.torch;
    const tf = this._torchFlicker[torchIdx] || { val: 1 };
    const flicker = tf.val;

    if (!img || !img.complete || img.naturalWidth === 0) {
      this._drawTorchFallback(ctx, screenX, dist, torchIdx);
      return;
    }

    const height = Math.floor((H * 0.75) / Math.max(0.1, dist));
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const width = Math.floor(height * aspectRatio);
    const top = Math.floor((H - height) / 2);
    const left = screenX - Math.floor(width / 2);
    const bright = Math.min(1.1, flicker / (1 + dist * 0.12));

    if (dist < 5) {
      const haloAlpha = flicker * Math.max(0, 1 - dist / 5) * 0.35;
      const haloR = Math.floor(width * 0.8);
      const _torchWallTop = Math.max(0, top - Math.floor(height * 0.3));
      const _torchWallBot = Math.min(H / 2, top + height);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = haloAlpha * (1 - radial) * (1 - radial);
        if (alpha < 0.01) continue;
        ctx.fillStyle = `rgba(255,140,20,${alpha.toFixed(2)})`;
        ctx.fillRect(sx, _torchWallTop, 1, _torchWallBot - _torchWallTop);
      }
    }

    {
      // Fast path: pure darkness fog → use precache
      const dark = 1 - Math.min(1, bright);
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
        undefined, undefined, undefined, undefined, dark);
    }

    const fireH = Math.max(2, Math.floor(height * 0.35));
    const fireW = Math.max(2, Math.floor(width * 0.5));
    const fireX = screenX - Math.floor(fireW / 2);
    const fireY = top - Math.floor(fireH * 0.3);
    const fireAlpha = flicker * 0.8 * Math.max(0, 1 - dist / 8);

    if (fireAlpha > 0.05 && dist < 8) {
      for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const fx = (sx - fireX) / fireW;
        const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.8);
        if (fa < 0.05) continue;
        ctx.fillStyle = `rgba(255,140,0,${fa.toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.6));
        ctx.fillStyle = `rgba(255,240,80,${(fa * 0.7).toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.25));
      }
    }
  }

  _drawTorchFallback(ctx, screenX, dist, torchIdx) {
    const tf = this._torchFlicker[torchIdx] || { val: 1 };
    const h = Math.floor((H * 0.3) / Math.max(0.1, dist));
    const w = Math.floor(h * 0.5);
    const top = Math.floor(H / 2) - h;
    const left = screenX - Math.floor(w / 2);
    const flk = tf.val;
    for (let sx = Math.max(0, left); sx < Math.min(W, left + w); sx++) {
      if (this.zBuffer[sx] <= dist) continue;
      ctx.fillStyle = `rgba(200,80,0,${flk * 0.9})`;
      ctx.fillRect(sx, top + Math.floor(h * 0.3), 1, Math.floor(h * 0.7));
      ctx.fillStyle = `rgba(255,180,0,${flk * 0.8})`;
      ctx.fillRect(sx, top, 1, Math.floor(h * 0.4));
    }
  }

  // ──────────────────────────────────���──────────────────────
  // Exit portal sprite
  // ─────────────────────────────────────────────────────────
  _drawPortalSprite(ctx, portal, screenX, dist) {
    const img = this.assets.exitPortal;
    const time = this._time;
    const height = Math.floor((H * 1.0) / Math.max(0.1, dist));
    const width = height;
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height);
    const left = screenX - Math.floor(width / 2);

    const clL = Math.max(0, left), clR = Math.min(W, left + width);

    if (!portal.active) {
      if (img && img.complete && img.naturalWidth > 0) {
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
          sc.fillStyle = `rgba(80,0,0,0.7)`;
          sc.fillRect(ol, ot, ow, oh);
        });
      } else {
        for (let sx = clL; sx < clR; sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          ctx.fillStyle = `rgba(120,0,80,0.18)`;
          ctx.fillRect(sx, top, 1, height);
        }
      }
      return;
    }

    const swirl = 0.7 + 0.3 * Math.sin(time * 4);

    if (dist < 8) {
      const haloAlpha = swirl * Math.max(0, 1 - dist / 8) * 0.5;
      const haloR = Math.floor(width * 0.7);
      const _portalTop = Math.max(0, top - 4);
      const _portalBot = Math.min(H, top + height + 8);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - screenX) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = haloAlpha * (1 - radial) * (1 - radial);
        if (alpha < 0.01) continue;
        ctx.fillStyle = `rgba(0,220,200,${alpha.toFixed(2)})`;
        ctx.fillRect(sx, _portalTop, 1, _portalBot - _portalTop);
      }
    }

    if (img && img.complete && img.naturalWidth > 0) {
      const _swirl = swirl;
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
        sc.fillStyle = `rgba(0,180,160,${_swirl * 0.25})`;
        sc.fillRect(ol, ot, ow, oh);
      });
    } else {
      for (let sx = clL; sx < clR; sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const cv = Math.floor(swirl * 200);
        ctx.fillStyle = `rgb(0,${cv},${Math.floor(cv * 0.9)})`;
        ctx.fillRect(sx, top, 1, height);
      }
    }

    if (dist < 3) {
      ctx.fillStyle = `rgba(0,255,220,${Math.min(1, (3-dist))})`;
      ctx.font = `6px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText('EXIT', screenX, top - 3);
      ctx.textAlign = 'left';
    }
  }

  // ─────────────────────────────────────────────────────────
  // Plasma bolt sprite
  // ─────────────────────────────────────────────────────────
  _drawPlasmaSprite(ctx, bolt, screenX, dist) {
    if (dist < 0.3) return;

    const img = this.assets.plasmaBolt;

    const size = Math.floor((H * 0.15) / Math.max(0.1, dist));
    if (size < 1) return;

    const top  = Math.floor(H / 2 - size / 2);
    const left = screenX - Math.floor(size / 2);

    if (img && img.complete && img.naturalWidth > 0) {
      this._drawSpriteIsolated(ctx, img, left, top, size, size, dist - 0.05, null);
    } else {
      for (let sx = Math.max(0, left); sx < Math.min(W, left + size); sx++) {
        if (this.zBuffer[sx] <= dist - 0.05) continue;
        ctx.fillStyle = 'rgba(0,255,220,0.9)';
        ctx.fillRect(sx, top, 1, size);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Crossbow bolt — uses CRSSBOLT sprite, no effects
  // ─────────────────────────────────────────────────────────
  _drawCrossbowBolt(ctx, bolt, screenX, dist) {
    if (dist < 0.3) return;

    const img = this.assets.crossbowBolt;

    const h = Math.floor((H * 0.10) / Math.max(0.1, dist));
    const w = Math.floor(h * 3.0);
    if (h < 1) return;

    const top  = Math.floor(H / 2 - h / 2);
    const left = screenX - Math.floor(w / 2);

    // Draw directly — projectiles are always in front of walls so skip z-culling
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, left, top, w, h);
    } else {
      // Fallback: simple brown shaft
      ctx.fillStyle = 'rgba(160,100,40,0.95)';
      ctx.fillRect(left, top + Math.floor(h * 0.35), w, Math.max(1, Math.floor(h * 0.3)));
      ctx.fillStyle = 'rgba(200,140,60,0.95)';
      ctx.fillRect(left, top + Math.floor(h * 0.4), w, Math.max(1, Math.floor(h * 0.2)));
    }
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────
  // Cannon explosion billboard — squash → scale → fade
  // Phase 0..0.2 : initial squash (wide, short)
  // Phase 0.2..0.7: scale up
  // Phase 0.7..1 : fade out while still growing
  // ─────────────────────────────────────────────────────────
  _drawExplosions(ctx, player, explosionEffects) {
    const img = this.assets.explosion;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const halfFov = FOV / 2;

    for (const ex of explosionEffects) {
      const dx = ex.x - player.x;
      const dy = ex.y - player.y;
      const sa = _inFrustum(dx, dy, player.angle, 18);
      if (sa === null) continue;
      const _exDistSq = dx * dx + dy * dy;
      if (_exDistSq < 0.0225) continue;                       // 0.15² = 0.0225 — no sqrt for guard
      const dist = _lastPerpDist; // fisheye-corrected perp distance

      const screenX = _saToScreenX(sa);  // LUT: sa → screen column

      // t goes 0→1 over the explosion lifetime
      const t = 1 - (ex.life / ex.maxLife);

      // Scale: starts small, squashes wide, then grows
      // squash phase (t<0.15): grow width fast, height slow
      // expand phase (t>0.15): grow both uniformly
      const baseSize = Math.floor((H * 0.55) / Math.max(0.2, dist));
      let scaleW, scaleH, alpha;

      if (t < 0.15) {
        // squash: spread wide, height compressed
        const p = t / 0.15;
        scaleW = 0.3 + p * 1.1; // 0.3→1.4
        scaleH = 0.15 + p * 0.45; // 0.15→0.60
        alpha = 1.0;
      } else {
        // expand
        const p = (t - 0.15) / 0.85;
        scaleW = 1.4 + p * 0.6; // 1.4→2.0
        scaleH = 0.6 + p * 1.4; // 0.6→2.0
        // fade out in last 30%
        alpha = t < 0.7 ? 1.0 : 1.0 - ((t - 0.7) / 0.3);
      }

      const w = Math.round(baseSize * scaleW);
      const h = Math.round(baseSize * scaleH);
      const left = screenX - Math.floor(w / 2);
      const top  = Math.floor(H / 2 - h / 2);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, left, top, w, h);
      ctx.restore();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Blood particles — 1×1 red pixels projected to screen
  // ──────────────────────────────��──────────────────────────
  _drawBloodParticles(ctx, player, bloodParticles) {
    const halfFov = FOV / 2;
    const imageData = ctx.getImageData(0, 0, W, H);
    const data = imageData.data;

    for (const bp of bloodParticles) {
      const dx = bp.x - player.x;
      const dy = bp.y - player.y;
      const sa = _inFrustum(dx, dy, player.angle, 8);
      if (sa === null) continue;
      const _bpDistSq = dx * dx + dy * dy;
      if (_bpDistSq < 0.01) continue;                         // 0.1² = 0.01 — no sqrt for guard
      const dist = _lastPerpDist; // fisheye-corrected perp distance

      const screenX = _saToScreenX(sa);  // LUT: sa → screen column

      // Proper vertical projection: z=0 is floor, z=1 is ceiling.
      // Wall height at this distance fills H pixels, so 1 world-unit = H/dist screen pixels.
      // Player eye is at z=0.5. Positive z = above horizon → negative screenY offset.
      const projScale = H / Math.max(0.01, dist);
      const zOffset   = (bp.z - 0.5) * projScale; // positive = above horizon
      const screenY   = Math.floor(H / 2 - zOffset);

      if (screenX < 0 || screenX >= W || screenY < 0 || screenY >= H) continue;

      const t = Math.max(0, bp.life / bp.maxLife);
      const alpha = Math.floor(t * 230);
      const idx = (screenY * W + screenX) * 4;
      data[idx]     = 180;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = alpha;
    }

    ctx.putImageData(imageData, 0, 0);
  }

  // ─────────────────────────────────────────────────────────
  // Gun rendering
  // Weapon sprites are served by WeaponSpriteManager (own offscreen canvas)
  // rather than the shared atlas, enabling per-frame torch effects.
  // ──────────────────────���──────────────────────────────────
  _drawGun(ctx, player, muzzleFlash) {
    const weaponId = player.equippedWeapon || 'pistol';
    const muzzle = this.assets.muzzle;

    // Resolve gun canvas from WeaponSpriteManager (native res, decoupled from atlas)
    let gun = null;
    if (this.weaponManager) {
      gun = this.weaponManager.get(weaponId);
    }
    // Fallback: legacy assets.gun (should rarely be needed)
    if (!gun) gun = this.assets.gun;

    const bobX = Math.sin(player.bobPhase) * 4 * (player.bobAmp || 0);
    const bobY = Math.abs(Math.cos(player.bobPhase)) * 5 * (player.bobAmp || 0);

    const swayAmt = (1 - (player.bobAmp || 0));
    const swayX = Math.sin(this._time * 1.1) * 2 * swayAmt;
    const swayY = Math.cos(this._time * 0.7) * 1.5 * swayAmt;

    const kick = player.weaponKick || 0;
    const kickY = kick * 10;
    const kickX = kick * 2;

    let animY = 0;
    if (player.weaponAnim === 'shoot') {
      const f = player.weaponFrame || 0;
      animY = Math.sin(f * Math.PI) * 12;
    }

    const tilt = player.strafeTilt || 0;

    // ── Torch proximity — use fire-tinted canvas when near a light source ──
    // Track via distSq to skip sqrt entirely during the scan; only compute real
    // dist once we know we're inside the 6-unit radius (closestSq < 36).
    let torchFlicker = 0;
    if (this.weaponManager && gun) {
      const torches = this.map.torches || [];
      let closestTorchDistSq = Infinity;
      for (const t of torches) {
        const dx = player.x - t.x, dy = player.y - t.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < closestTorchDistSq) closestTorchDistSq = dSq;
      }
      // Also check braziers as light sources
      for (const d of (this.map.decor || [])) {
        if (!d.isBrazier) continue;
        const dx = player.x - d.x, dy = player.y - d.y;
        const dSq = dx * dx + dy * dy;
        if (dSq < closestTorchDistSq) closestTorchDistSq = dSq;
      }
      if (closestTorchDistSq < 36) {                           // 6² — no sqrt needed for guard
        const closestTorchDist = 1 / fastInvSqrt(closestTorchDistSq);
        torchFlicker = Math.max(0, 1 - closestTorchDist / 6);
        const torchCanvas = this.weaponManager.getTorchCanvas(weaponId, torchFlicker, this._time);
        if (torchCanvas) gun = torchCanvas;
      }
    }

    // ── Muzzle flash — composite onto weapon canvas (black pixels masked) ──
    if (muzzleFlash && this.weaponManager && FLASH_IDS.has(weaponId)) {
      const flashIntensity = (typeof muzzleFlash === 'number') ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0;
      if (flashIntensity > 0) {
        // applyMuzzleFlash handles torch-tinting internally when torchFlicker > 0
        const flashCanvas = this.weaponManager.applyMuzzleFlash(weaponId, flashIntensity, torchFlicker, this._time);
        if (flashCanvas) gun = flashCanvas;
      }
    }

    // ── Recoil scale + offset: zoom toward camera when firing ──
    const flashIntensityForRecoil = muzzleFlash
      ? (typeof muzzleFlash === 'number' ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0)
      : 0;
    let recoilScale = 1 + flashIntensityForRecoil * 0.12;   // up to 12% upscale
    let recoilOffY  = flashIntensityForRecoil * 14;          // push down (toward player)
    let recoilOffX  = 0;

    // ── Sword fire state: arc down-left, scale down, pivot from bottom-centre ──
    if (weaponId === 'sword' && player.weaponAnim === 'shoot') {
      const f = Math.max(0, Math.min(1, player.weaponFrame || 0)); // 0→1 over animation
      const swingCurve = Math.sin(f * Math.PI);                    // peaks at mid-swing
      recoilOffX   = -swingCurve * 38;   // slide left up to 38px
      recoilOffY  += swingCurve * 28;    // slide down up to 28px (stays bottom-bound)
      recoilScale  = 1 - swingCurve * 0.15;  // shrink up to 15% at peak
    }

    const gw = 128, gh = 128;
    const gx = Math.floor(W / 2 - gw / 2 + bobX + swayX + kickX + recoilOffX);
    const gy = Math.floor(H - gh + bobY + swayY + kickY + animY + recoilOffY);

    // Pivot from bottom-centre so scaling keeps the grip planted at screen bottom
    const pivotX = W / 2;
    const pivotY = H;

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(tilt);
    ctx.scale(recoilScale, recoilScale);
    ctx.translate(-pivotX, -pivotY);

    const gunReady = gun instanceof HTMLCanvasElement ? (gun.width > 0)
                                                      : (gun && gun.complete && gun.naturalWidth > 0);
    if (gunReady) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(gun, gx, gy, gw, gh);
    } else {
      // Placeholder while sprite loads
      ctx.fillStyle = '#888';
      ctx.fillRect(gx + 20, gy + 30, 40, 20);
      ctx.fillRect(gx + 35, gy + 20, 10, 15);
    }

    ctx.restore();
  }

  // ────────────────��────────────────────────────────────────
  // Post-process effects
  // ─────────────────────────────────────────────────────────
  _drawScanlines(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < H; y += 2) {
      ctx.fillRect(0, y, W, 1);
    }
  }

  _drawVignette(ctx) {
    const grad = ctx.createRadialGradient(W/2, H/2, H*0.3, W/2, H/2, H*0.9);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}
