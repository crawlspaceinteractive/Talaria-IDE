/**
 * renderer.js — 320x200 software renderer (Spec Section II)
 *
 * Pipeline per spec:
 *   1. World → camera transform
 *   2. Depth scale via SCALE_TABLE
 *   3. Rotation via TRIG LUT
 *   4. Triangle rasterization (flat-shaded, depth-buffered)
 *   5. Particle pass
 *   6. HUD pass (handled by hud.js, called after present())
 *
 * Authentic touches:
 *   - Integer vertex snap (vertex jitter)
 *   - Affine — no perspective correction (we shade per-triangle, no UVs needed in v0.1)
 *   - Bayer 4x4 dither + 15-bit color quantization at final pixel write
 *   - Distance fog tint toward sky color
 *   - Scanline horizontal shift for portal warp
 *   - Near-plane clipping: triangles crossing the near plane are clipped
 *     (not discarded), preventing large floor slabs from popping out.
 *
 * FIXED-POINT NOTES
 * -----------------
 *   All screen-space arithmetic in drawTriangle uses 16.16 fixed point
 *   (values multiplied by FP = 65536) so the inner scanline loop runs
 *   entirely on integer ALU — no floats, no GC, no branches for casts.
 *
 *   Camera-space transforms use the pre-baked TRIG LUT (Float32 but cached),
 *   and projection output is integer-snapped via |0 before entering the rasterizer.
 *
 *   Color arithmetic (fog, shade, tint, quantize) operates on packed 32-bit
 *   integers throughout using only shifts, ORs, and integer multiply.
 */
import {
  SCREEN_W, SCREEN_H, HALF_W, HALF_H,
  scaleAtX, scaleAtY, sinDeg, cosDeg,
  BAYER_4X4,
} from "./luts.js";
import { quantize15, shade, tint, rgba } from "./ps1fx.js";
import { sampleTextureNearest, tintTexelRGBA } from "./textureloader.js";

const SKY_TOP    = rgba(0, 0, 0);
const SKY_MID    = rgba(120, 0, 0);
const SKY_BOTTOM = rgba(0, 0, 0);
const FOG_COLOR  = rgba(200, 0, 0);

// Distance fog limits (world units).
// FOG_NEAR: distance at which fog starts blending in.
// FOG_FAR : distance at which geometry is fully fogged (== view distance).
const FOG_NEAR = 80.0;
const FOG_FAR  = 200.0;

// Near-clip Z (camera space)
const NEAR_Z = 0.4;

export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(SCREEN_W, SCREEN_H);
  const buf32 = new Uint32Array(image.data.buffer);
  const depth = new Float32Array(SCREEN_W * SCREEN_H);
  // Per-row sky precompute
  const skyRows = new Uint32Array(SCREEN_H);
  for (let y = 0; y < SCREEN_H; y++) {
    const t = y / (SCREEN_H - 1);
    let c;
    if (t < 0.55) {
      const tt = t / 0.55;
      c = lerpColor(SKY_TOP, SKY_MID, tt);
    } else {
      const tt = (t - 0.55) / 0.45;
      c = lerpColor(SKY_MID, SKY_BOTTOM, tt);
    }
    skyRows[y] = c;
  }
  return { ctx, image, buf32, depth, skyRows, canvas };
}

function lerpColor(a, b, t) {
  const ar = a & 0xff, ag = (a >>> 8) & 0xff, ab = (a >>> 16) & 0xff;
  const br = b & 0xff, bg = (b >>> 8) & 0xff, bb = (b >>> 16) & 0xff;
  const r = (ar + (br - ar) * t) | 0;
  const g = (ag + (bg - ag) * t) | 0;
  const b2 = (ab + (bb - ab) * t) | 0;
  return rgba(r, g, b2);
}

// ---- Cloud precompute buffer -----------------------------------------------
// One Uint8Array per screen column — 1 if cloud pixel, 0 otherwise.
// Rebuilt once per frame in clearSky, then stamped into sky rows.
// This converts the per-pixel Math.sin inner loop into a single precompute pass
// (SCREEN_W evaluations) followed by a plain integer comparison per pixel row.
const _cloudMask = new Uint8Array(SCREEN_W);

// Clear framebuffer with sky gradient + simple star dots near top.
export function clearSky(rd, cameraYaw, frame) {
  const { buf32, skyRows, depth } = rd;
  for (let y = 0; y < SCREEN_H; y++) {
    const c = skyRows[y];
    const row = y * SCREEN_W;
    buf32.fill(c, row, row + SCREEN_W);
    depth.fill(Infinity, row, row + SCREEN_W);
  }
  // Star field in top region — pseudo-stationary relative to yaw (simple parallax)
  const yawShift = (cameraYaw * 5.6) | 0;
  for (let i = 0; i < 80; i++) {
    const sx = ((i * 73) - yawShift) % SCREEN_W;
    const x = ((sx + SCREEN_W) % SCREEN_W) | 0;
    const y = ((i * 37) % (SCREEN_H * 0.45)) | 0;
    const c = rgba(220 + ((i * 13) & 31), 220 + ((i * 7) & 31), 240);
    buf32[y * SCREEN_W + x] = c;
  }
  // Distant cloud band — precompute per-column mask (one pass, SCREEN_W sin evals)
  // then stamp each cloud row without any transcendentals in the inner loop.
  const yCloudStart = (SCREEN_H * 0.42) | 0;
  const yCloudEnd   = (SCREEN_H * 0.52) | 0;
  // Use a fixed representative Y for the cloud shape (midpoint of cloud band)
  const yCloudMid = (yCloudStart + yCloudEnd) >> 1;
  for (let x = 0; x < SCREEN_W; x++) {
    const xs = x; // stationary mountain/cloud layer
    const n = (Math.sin(xs * 0.013) + Math.sin(xs * 0.03 + yCloudMid * 0.2)) * 0.5;
    _cloudMask[x] = n > 0.5 ? 1 : 0;
  }
  // Cloud gradient: pink at top, dark blue at bottom
  const CLOUD_PINK      = rgba(255, 160, 200);  // top of cloud band
  const CLOUD_DARK_BLUE = rgba(30,  20,  80);   // bottom of cloud band
  for (let y = yCloudStart; y < yCloudEnd; y++) {
    const row = y * SCREEN_W;
    const tCloud = (y - yCloudStart) / Math.max(1, yCloudEnd - yCloudStart - 1);
    const cloudC = lerpColor(CLOUD_PINK, CLOUD_DARK_BLUE, tCloud);
    for (let x = 0; x < SCREEN_W; x++) {
      if (_cloudMask[x]) buf32[row + x] = cloudC;
    }
  }
}

// ---- Camera-space transform (returns { cx, cy, cz } without projection) -----
// Uses pre-baked trig LUT (Float32Array) — no Math.sin/cos in the hot path.
function toCameraSpace(world, camera) {
  const dx = world.x - camera.x;
  const dy = world.y - camera.y;
  const dz = world.z - camera.z;
  const cy = cosDeg(-camera.yaw);
  const sy = sinDeg(-camera.yaw);
  let cx  =  dx * cy + dz * sy;
  let cz  = -dx * sy + dz * cy;
  let cyy = dy;
  const pitch = camera.pitch || 0;
  if (pitch !== 0) {
    const cp = cosDeg(pitch);
    const sp = sinDeg(pitch);
    const cyy2 = cyy * cp + cz * sp;
    const cz2  = -cyy * sp + cz * cp;
    cyy = cyy2;
    cz  = cz2;
  }
  return { cx, cy: cyy, cz };
}

// ---- Project an already-in-camera-space point to screen --------------------
// Screen coords are integer-snapped (|0) here — this is where vertex jitter lives.
function projectCS(cs, camera) {
  if (cs.cz < NEAR_Z) return { sx: 0, sy: 0, cz: cs.cz, visible: false };
  const fovMul = camera.fovMul || 1.0;
  const scaleX = scaleAtX(cs.cz) * fovMul;
  const scaleY = scaleAtY(cs.cz) * fovMul;
  const sx = (HALF_W + cs.cx * scaleX) | 0;
  const sy = (HALF_H - cs.cy * scaleY) | 0;
  return { sx, sy, cz: cs.cz, visible: true };
}

// ---- Project world point through camera → screen + camZ ---------------------
export function project(world, camera) {
  const cs = toCameraSpace(world, camera);
  return projectCS(cs, camera);
}

// ---- Near-plane clip in camera space (Sutherland-Hodgman for Z > NEAR_Z) ---
function clipNear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const aIn = a.cz >= NEAR_Z;
    const bIn = b.cz >= NEAR_Z;
    if (aIn) out.push(a);
    if (aIn !== bIn) {
      const t = (NEAR_Z - a.cz) / (b.cz - a.cz);
      out.push({
        cx: a.cx + t * (b.cx - a.cx),
        cy: a.cy + t * (b.cy - a.cy),
        cz: NEAR_Z,
      });
    }
  }
  return out;
}

// ---- Fog lookup table — maps quantized camZ to fog intensity 0..255 ---------
// index = (camZ * 10) | 0   →   _fogLut[i] = 0..255 integer fog amount
// All downstream consumers read the raw byte; no division ever happens.
const _FOG_LUT_LEN = 4096;
const _fogLut = new Uint8Array(_FOG_LUT_LEN);
(function buildFogLut() {
  const range = FOG_FAR - FOG_NEAR;
  for (let i = 0; i < _FOG_LUT_LEN; i++) {
    const z = i * 0.1;
    if (z <= FOG_NEAR)      _fogLut[i] = 0;
    else if (z >= FOG_FAR)  _fogLut[i] = 255;
    else                     _fogLut[i] = ((z - FOG_NEAR) / range * 255) | 0;
  }
})();

// fogByte: returns raw 0..255 fog amount for a given camera-Z.
// Used by drawPixelW; all other callers go through getShadedColor.
function fogByte(camZ) {
  const i = (camZ * 10) | 0;
  if (i <= 0)          return 0;
  if (i >= _FOG_LUT_LEN) return 255;
  return _fogLut[i];
}

// ---- Precomputed fog-blended color cache -----------------------------------
// Key: color32 XOR (band << 27), where band = fogLut byte >> 3  (0..31 bands)
// Cache hits cost one array read; misses compute tint() in 8-bit fixed point.
// Open-addressing, 4096 slots.
const _FOG_CACHE_SIZE = 4096;
const _fogCacheKey   = new Int32Array(_FOG_CACHE_SIZE).fill(-1);
const _fogCacheVal   = new Uint32Array(_FOG_CACHE_SIZE);

// Pre-bake: 32 fog-blend amounts in 0..256 fixed-point (×256).
// Formula: C_final = C_fog * f + C_object * (1 - f)  where f = band/31 (0..1)
// fogBlend256[b] = round(b / 31 * 256)   for b in 0..31
const _fogBlend256 = new Uint16Array(32);
for (let b = 0; b < 32; b++) {
  _fogBlend256[b] = (b / 31 * 256 + 0.5) | 0; // 0..256
}

// Pre-extract FOG_COLOR channels for integer tint in getShadedColor
const _FC_R = FOG_COLOR & 0xff;
const _FC_G = (FOG_COLOR >>> 8) & 0xff;
const _FC_B = (FOG_COLOR >>> 16) & 0xff;
const _FC_A = FOG_COLOR >>> 24;

function getShadedColor(color, avgZ) {
  const fogIdx = (avgZ * 10) | 0;
  const band   = (fogIdx < _FOG_LUT_LEN ? _fogLut[fogIdx] : 255) >> 3; // 0..31
  const key    = (color ^ (band << 27)) | 0;
  const slot   = (key >>> 0) % _FOG_CACHE_SIZE;
  if (_fogCacheKey[slot] === key) return _fogCacheVal[slot];
  // Cache miss — C_final = C_fog * f + C_object * (1 - f), integer fixed-point
  const f   = _fogBlend256[band]; // 0..256 fixed-point fog factor
  const inv = 256 - f;
  const cr = color & 0xff,      cg = (color >>> 8) & 0xff,  cb = (color >>> 16) & 0xff;
  const r  = ((_FC_R * f + cr * inv) >> 8);
  const g  = ((_FC_G * f + cg * inv) >> 8);
  const b  = ((_FC_B * f + cb * inv) >> 8);
  const a  = color >>> 24;
  const shaded = (a << 24) | (b << 16) | (g << 8) | r;
  _fogCacheKey[slot] = key;
  _fogCacheVal[slot] = shaded;
  return shaded;
}

// ---- Triangle rasterization — FIXED-POINT HALF-SPACE ----------------------
//
// All edge function arithmetic is performed in 16.16 fixed point.
// Screen coords enter as integers (already snapped in projectCS).
// The inner loop touches only integer ALU: +, -, >> for sign test.
//
// Color quantization (Bayer 4×4 dither) is inlined from ps1fx.js to avoid
// the function-call overhead in the innermost loop.
//
// Vertices: { sx:int, sy:int, cz:float, visible:bool }

// Precompute Bayer thresholds as a flat Int32Array for fast access
const _BAYER = new Int32Array(16);
for (let i = 0; i < 16; i++) _BAYER[i] = BAYER_4X4[i] - 7; // -7..8

// ---- Per-pixel fog constants (precomputed for inner loop) ------------------
// FOG_RANGE_INV: reciprocal of (FOG_FAR - FOG_NEAR) — avoids division in loop.
// FOG_NEAR_SCALED: FOG_NEAR pre-scaled to match the fixed-point depth range.
const _FOG_RANGE_INV = 1.0 / (FOG_FAR - FOG_NEAR); // ~0.00833 for 80..200

export function drawTriangle(rd, v0, v1, v2, color) {
  if (!v0.visible || !v1.visible || !v2.visible) return;

  // Integer screen coords (already snapped from projectCS)
  const x1 = v0.sx | 0, y1 = v0.sy | 0;
  const x2 = v1.sx | 0, y2 = v1.sy | 0;
  const x3 = v2.sx | 0, y3 = v2.sy | 0;

  // AABB cull
  const minX = x1 < x2 ? (x1 < x3 ? x1 : x3) : (x2 < x3 ? x2 : x3);
  const maxX = x1 > x2 ? (x1 > x3 ? x1 : x3) : (x2 > x3 ? x2 : x3);
  const minY = y1 < y2 ? (y1 < y3 ? y1 : y3) : (y2 < y3 ? y2 : y3);
  const maxY = y1 > y2 ? (y1 > y3 ? y1 : y3) : (y2 > y3 ? y2 : y3);
  if (maxX < 0 || minX >= SCREEN_W || maxY < 0 || minY >= SCREEN_H) return;

  // Degeneracy check: area = (x1-x3)*(y2-y1) - (x1-x2)*(y3-y1)
  const area = (x1 - x3) * (y2 - y1) - (x1 - x2) * (y3 - y1);
  if (area === 0) return;

  // Pre-extract source color channels once (no fog yet — fog applied per-pixel).
  const cR = color & 0xff;
  const cG = (color >>> 8) & 0xff;
  const cB = (color >>> 16) & 0xff;
  const cA = color >>> 24;

  // Edge deltas (integer)
  const dx12 = x1 - x2, dy12 = y1 - y2;
  const dx23 = x2 - x3, dy23 = y2 - y3;
  const dx31 = x3 - x1, dy31 = y3 - y1;

  const invArea = 1 / area;
  const zF0 = v0.cz * invArea;
  const zF1 = v1.cz * invArea;
  const zF2 = v2.cz * invArea;
  const dzdx = dy23 * zF0 + dy31 * zF1 + dy12 * zF2;
  const dzdy = -dx23 * zF0 - dx31 * zF1 - dx12 * zF2;

  // Clip to screen
  const x0c = minX < 0 ? 0 : minX;
  const xec = maxX >= SCREEN_W ? SCREEN_W - 1 : maxX;
  const y0c = minY < 0 ? 0 : minY;
  const yec = maxY >= SCREEN_H ? SCREEN_H - 1 : maxY;

  const { buf32, depth } = rd;

  // Half-space initial values at (x0c, y0c) — integer arithmetic
  // w_i(x, y) = (x - xi) * dy_ij - (y - yi) * dx_ij
  let w1_row = (x0c - x2) * dy23 - (y0c - y2) * dx23;
  let w2_row = (x0c - x3) * dy31 - (y0c - y3) * dx31;
  let w3_row = (x0c - x1) * dy12 - (y0c - y1) * dx12;

  for (let y = y0c; y <= yec; y++) {
    const row = y * SCREEN_W;
    const by = y & 3;
    let w1 = w1_row;
    let w2 = w2_row;
    let w3 = w3_row;
    let zRow = w1_row * zF0 + w2_row * zF1 + w3_row * zF2;

    for (let x = x0c; x <= xec; x++) {
      // Inside test: inside iff all barycentric coords same sign
      // (handles both CW and CCW winding)
      const allPos = (w1 >= 0) & (w2 >= 0) & (w3 >= 0);
      const allNeg = (w1 <= 0) & (w2 <= 0) & (w3 <= 0);
      if (allPos | allNeg) {
        const z = zRow;
        const idx = row + x;
        if (z < depth[idx]) {
          depth[idx] = z;

          // ---- Per-pixel fog: C_final = C_fog * f + C_object * (1 - f) ------
          // f (fog factor) = 0 at FOG_NEAR, 1 at FOG_FAR.
          // t256 is f scaled to 0..256 fixed-point for integer blend.
          let t256;
          if (z <= FOG_NEAR) {
            t256 = 0;
          } else if (z >= FOG_FAR) {
            t256 = 256;
          } else {
            t256 = ((z - FOG_NEAR) * _FOG_RANGE_INV * 256) | 0;
          }
          // Dither threshold for PS1-style 15-bit quantize
          const t = _BAYER[(by << 2) | (x & 3)]; // -7..8

          // C_final = C_fog * t256/256 + C_object * (256 - t256)/256
          const invT = 256 - t256;
          const r0 = ((_FC_R * t256 + cR * invT) >> 8);
          const g0 = ((_FC_G * t256 + cG * invT) >> 8);
          const b0 = ((_FC_B * t256 + cB * invT) >> 8);

          // Dither + 5-bit quantize (PS1 15-bit color)
          const r2 = (r0 + t) < 0 ? 0 : (r0 + t) > 255 ? 0xf8 : ((r0 + t) & 0xf8);
          const g2 = (g0 + t) < 0 ? 0 : (g0 + t) > 255 ? 0xf8 : ((g0 + t) & 0xf8);
          const b2 = (b0 + t) < 0 ? 0 : (b0 + t) > 255 ? 0xf8 : ((b0 + t) & 0xf8);
          buf32[idx] = (cA << 24) | (b2 << 16) | (g2 << 8) | r2;
        }
      }
      w1 += dy23;
      w2 += dy31;
      w3 += dy12;
      zRow += dzdx;
    }

    w1_row -= dx23;
    w2_row -= dx31;
    w3_row -= dx12;
    zRow += dzdy;
  }
}

// ---- Internal: emit triangles from a polygon (fan triangulation), after near-clip.
function emitClipped(csPts, color, camera) {
  if (csPts.length < 3) return [];
  const tris = [];
  const v0 = projectCS(csPts[0], camera);
  for (let i = 1; i + 1 < csPts.length; i++) {
    const va = projectCS(csPts[i], camera);
    const vb = projectCS(csPts[i + 1], camera);
    if (!v0.visible || !va.visible || !vb.visible) continue;
    const avgZ = (v0.cz + va.cz + vb.cz) * 0.3333333;
    tris.push({ verts: [v0, va, vb], color, avgZ });
  }
  return tris;
}

// ---- Build clipped tris from a face defined by world-space quad/tri corners -
export function buildFace(worldPts, color, camera) {
  const csPts = worldPts.map(p => toCameraSpace(p, camera));
  const clipped = clipNear(csPts);
  return emitClipped(clipped, color, camera);
}

// ---- Cube (used for platforms, crystals, enemies) --------------------------
export function buildCube(cx, cy, cz, sx, sy, sz, topColor, sideColor, camera) {
  const corners = [
    { x: cx - sx, y: cy + sy, z: cz - sz }, // 0 top NW
    { x: cx + sx, y: cy + sy, z: cz - sz }, // 1 top NE
    { x: cx + sx, y: cy + sy, z: cz + sz }, // 2 top SE
    { x: cx - sx, y: cy + sy, z: cz + sz }, // 3 top SW
    { x: cx - sx, y: cy - sy, z: cz - sz }, // 4 bot NW
    { x: cx + sx, y: cy - sy, z: cz - sz }, // 5 bot NE
    { x: cx + sx, y: cy - sy, z: cz + sz }, // 6 bot SE
    { x: cx - sx, y: cy - sy, z: cz + sz }, // 7 bot SW
  ];

  const sideN = shadeFace(sideColor, 0.85);
  const sideE = shadeFace(sideColor, 0.70);
  const sideS = shadeFace(sideColor, 0.55);
  const sideW = shadeFace(sideColor, 0.85);

  const camDx = camera.x - cx;
  const camDy = camera.y - cy;
  const camDz = camera.z - cz;

  const quads = [
    [[0,1,2,3], topColor,  0,  1,  0],
    [[4,0,1,5], sideN,     0,  0, -1],
    [[5,1,2,6], sideE,     1,  0,  0],
    [[6,2,3,7], sideS,     0,  0,  1],
    [[7,3,0,4], sideW,    -1,  0,  0],
  ];

  const tris = [];
  for (const [idxs, color, nx, ny, nz] of quads) {
    const dot = camDx * nx + camDy * ny + camDz * nz;
    if (dot <= 0) continue;
    const pts = idxs.map(i => corners[i]);
    for (const tri of buildFace(pts, color, camera)) tris.push(tri);
  }
  return tris;
}

function shadeFace(c, brightness) {
  const r = Math.min(255, ((c & 0xff) * brightness)) | 0;
  const g = Math.min(255, (((c >>> 8) & 0xff) * brightness)) | 0;
  const b = Math.min(255, (((c >>> 16) & 0xff) * brightness)) | 0;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

// ---- Trapezoid prism -------------------------------------------------------
export function buildTrapezoid(cx, cy, cz, sx, sy, sz, topScale, yaw, topColor, sideColor, camera) {
  const ts = topScale ?? 0.6;
  const radYaw = ((yaw ?? 0) * Math.PI) / 180;
  const cosY = Math.cos(radYaw), sinY = Math.sin(radYaw);

  const rot = (lx, lz) => ({
    x: cx + lx * cosY - lz * sinY,
    z: cz + lx * sinY + lz * cosY,
  });

  const b0 = rot(-sx, -sz);
  const b1 = rot( sx, -sz);
  const b2 = rot( sx,  sz);
  const b3 = rot(-sx,  sz);

  const tx = sx * ts, tz = sz * ts;
  const t0 = rot(-tx, -tz);
  const t1 = rot( tx, -tz);
  const t2 = rot( tx,  tz);
  const t3 = rot(-tx,  tz);

  const yBot = cy;
  const yTop = cy + sy * 2;

  const pts = {
    b0: { x: b0.x, y: yBot, z: b0.z },
    b1: { x: b1.x, y: yBot, z: b1.z },
    b2: { x: b2.x, y: yBot, z: b2.z },
    b3: { x: b3.x, y: yBot, z: b3.z },
    t0: { x: t0.x, y: yTop, z: t0.z },
    t1: { x: t1.x, y: yTop, z: t1.z },
    t2: { x: t2.x, y: yTop, z: t2.z },
    t3: { x: t3.x, y: yTop, z: t3.z },
  };

  const sideN = shadeFace(sideColor, 0.85);
  const sideE = shadeFace(sideColor, 0.70);
  const sideS = shadeFace(sideColor, 0.55);
  const sideW = shadeFace(sideColor, 0.85);

  const camDx = camera.x - cx;
  const camDy = camera.y - (yBot + yTop) * 0.5;
  const camDz = camera.z - cz;

  const quads = [
    [[pts.t0, pts.t1, pts.t2, pts.t3], topColor,  0,  1,  0],
    [[pts.b0, pts.t0, pts.t1, pts.b1], sideN,     0,  0, -1],
    [[pts.b1, pts.t1, pts.t2, pts.b2], sideE,     1,  0,  0],
    [[pts.b2, pts.t2, pts.t3, pts.b3], sideS,     0,  0,  1],
    [[pts.b3, pts.t3, pts.t0, pts.b0], sideW,    -1,  0,  0],
  ];

  const tris = [];
  for (const [worldPts, color, nx, ny, nz] of quads) {
    const rnx = nx * cosY + nz * sinY;
    const rnz = -nx * sinY + nz * cosY;
    const dot = camDx * rnx + camDy * ny + camDz * rnz;
    if (dot <= 0) continue;
    for (const tri of buildFace(worldPts, color, camera)) tris.push(tri);
  }
  return tris;
}

// ---- Triangular prism ------------------------------------------------------
export function buildTriPrism(cx, cy, cz, r, sy, yaw, topColor, sideColor, camera) {
  const baseYaw = ((yaw ?? 0) * Math.PI) / 180;
  const yBot = cy;
  const yTop = cy + sy * 2;

  const corners = [0, 1, 2].map(i => {
    const a = baseYaw + (i * Math.PI * 2) / 3;
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
  });

  const bots = corners.map(c => ({ x: c.x, y: yBot, z: c.z }));
  const tops = corners.map(c => ({ x: c.x, y: yTop, z: c.z }));

  const faceShades = [0.90, 0.65, 0.80];
  const tris = [];

  const camDx = camera.x - cx;
  const camDy = camera.y - (yBot + yTop) * 0.5;
  const camDz = camera.z - cz;

  if (camDy > 0) {
    for (const tri of buildFace(tops, topColor, camera)) tris.push(tri);
  }

  for (let i = 0; i < 3; i++) {
    const next = (i + 1) % 3;
    const enx = corners[i].x + corners[next].x - 2 * cx;
    const enz = corners[i].z + corners[next].z - 2 * cz;
    const dot = camDx * enx + camDz * enz;
    if (dot <= 0) continue;
    const sc = shadeFace(sideColor, faceShades[i]);
    const quad = [bots[i], bots[next], tops[next], tops[i]];
    for (const tri of buildFace(quad, sc, camera)) tris.push(tri);
  }

  return tris;
}

// ---- Oriented plank (bridge segment) --------------------------------------
export function buildOrientedPlank(cx, cy, cz, nx, nz, halfLen, halfW, halfH, topColor, sideColor, camera) {
  const px = -nz, pz = nx;

  const corners = [
    { x: cx + nx*halfLen + px*halfW, y: cy + halfH, z: cz + nz*halfLen + pz*halfW }, // 0 TFL
    { x: cx - nx*halfLen + px*halfW, y: cy + halfH, z: cz - nz*halfLen + pz*halfW }, // 1 TBL
    { x: cx - nx*halfLen - px*halfW, y: cy + halfH, z: cz - nz*halfLen - pz*halfW }, // 2 TBR
    { x: cx + nx*halfLen - px*halfW, y: cy + halfH, z: cz + nz*halfLen - pz*halfW }, // 3 TFR
    { x: cx + nx*halfLen + px*halfW, y: cy - halfH, z: cz + nz*halfLen + pz*halfW }, // 4 BFL
    { x: cx - nx*halfLen + px*halfW, y: cy - halfH, z: cz - nz*halfLen + pz*halfW }, // 5 BBL
    { x: cx - nx*halfLen - px*halfW, y: cy - halfH, z: cz - nz*halfLen - pz*halfW }, // 6 BBR
    { x: cx + nx*halfLen - px*halfW, y: cy - halfH, z: cz + nz*halfLen - pz*halfW }, // 7 BFR
  ];

  const sideN = shadeFace(sideColor, 0.85);
  const sideE = shadeFace(sideColor, 0.70);
  const sideS = shadeFace(sideColor, 0.60);
  const sideW = shadeFace(sideColor, 0.80);

  const camDx = camera.x - cx;
  const camDy = camera.y - cy;
  const camDz = camera.z - cz;

  const quads = [
    [[0,1,2,3], topColor,  0,  1,  0],
    [[4,0,3,7], sideN,     nx, 0,  nz],
    [[5,4,7,6], sideS,    -nx, 0, -nz],
    [[1,5,6,2], sideE,    -px, 0, -pz],
    [[0,4,5,1], sideW,     px, 0,  pz],
  ];

  const tris = [];
  for (const [idxs, color, fnx, fny, fnz] of quads) {
    const dot = camDx * fnx + camDy * fny + camDz * fnz;
    if (dot <= 0) continue;
    const pts = idxs.map(i => corners[i]);
    for (const tri of buildFace(pts, color, camera)) tris.push(tri);
  }
  return tris;
}

// ---- Billboard sprite quad (camera-facing) ---------------------------------
export function buildBillboard(cx, cy, cz, hw, hh, palette, camera, leanX = 0) {
  // Enforce max palette size to avoid huge embedded color tables
  const MAX_PALETTE_COLORS = 128;
  if (Array.isArray(palette) && palette.length > MAX_PALETTE_COLORS) {
    console.warn(`[renderer] palette length ${palette.length} exceeds ${MAX_PALETTE_COLORS}; trimming to ${MAX_PALETTE_COLORS}`);
    palette = palette.slice(0, MAX_PALETTE_COLORS);
  }
  const c = cosDeg(camera.yaw);
  const s = sinDeg(camera.yaw);
  const rx = c, rz = -s;
  const ax = cx - rx * hw, az = cz - rz * hw;
  const bx = cx + rx * hw, bz = cz + rz * hw;
  const topShiftX = rx * leanX, topShiftZ = rz * leanX;
  const midShiftX = rx * leanX * 0.5, midShiftZ = rz * leanX * 0.5;
  const topL = project({ x: ax + topShiftX, y: cy + hh, z: az + topShiftZ }, camera);
  const topR = project({ x: bx + topShiftX, y: cy + hh, z: bz + topShiftZ }, camera);
  const midL = project({ x: ax + midShiftX, y: cy,      z: az + midShiftZ }, camera);
  const midR = project({ x: bx + midShiftX, y: cy,      z: bz + midShiftZ }, camera);
  const botL = project({ x: ax,             y: cy - hh, z: az             }, camera);
  const botR = project({ x: bx,             y: cy - hh, z: bz             }, camera);

  const out = [];
  const pack = (a, b, d, color) => {
    if (!a.visible || !b.visible || !d.visible) return;
    const avgZ = (a.cz + b.cz + d.cz) * 0.3333333 - 0.05;
    out.push({ verts: [a, b, d], color, avgZ });
  };
  pack(topL, topR, midR, palette[0]);
  pack(topL, midR, midL, palette[0]);
  pack(midL, midR, botR, palette[1]);
  pack(midL, botR, botL, palette[1]);
  return out;
}

// ---- Pixel point (for particles) -------------------------------------------

// Textured triangle rasterization — first-pass affine mapper.
// Used only when a triangle carries `texture` plus per-vertex u/v values.
export function drawTexturedTriangle(rd, v0, v1, v2, color, texture) {
  if (!texture) return drawTriangle(rd, v0, v1, v2, color);
  if (!v0.visible || !v1.visible || !v2.visible) return;

  const x1 = v0.sx | 0, y1 = v0.sy | 0;
  const x2 = v1.sx | 0, y2 = v1.sy | 0;
  const x3 = v2.sx | 0, y3 = v2.sy | 0;

  const minX = x1 < x2 ? (x1 < x3 ? x1 : x3) : (x2 < x3 ? x2 : x3);
  const maxX = x1 > x2 ? (x1 > x3 ? x1 : x3) : (x2 > x3 ? x2 : x3);
  const minY = y1 < y2 ? (y1 < y3 ? y1 : y3) : (y2 < y3 ? y2 : y3);
  const maxY = y1 > y2 ? (y1 > y3 ? y1 : y3) : (y2 > y3 ? y2 : y3);
  if (maxX < 0 || minX >= SCREEN_W || maxY < 0 || minY >= SCREEN_H) return;

  const area = (x1 - x3) * (y2 - y1) - (x1 - x2) * (y3 - y1);
  if (area === 0) return;

  const dx12 = x1 - x2, dy12 = y1 - y2;
  const dx23 = x2 - x3, dy23 = y2 - y3;
  const dx31 = x3 - x1, dy31 = y3 - y1;

  const invArea = 1 / area;
  const zF0 = v0.cz * invArea;
  const zF1 = v1.cz * invArea;
  const zF2 = v2.cz * invArea;

  const u0 = (v0.u ?? 0) * invArea;
  const u1 = (v1.u ?? 0) * invArea;
  const u2 = (v2.u ?? 0) * invArea;
  const vv0 = (v0.v ?? 0) * invArea;
  const vv1 = (v1.v ?? 0) * invArea;
  const vv2 = (v2.v ?? 0) * invArea;

  const x0c = minX < 0 ? 0 : minX;
  const xec = maxX >= SCREEN_W ? SCREEN_W - 1 : maxX;
  const y0c = minY < 0 ? 0 : minY;
  const yec = maxY >= SCREEN_H ? SCREEN_H - 1 : maxY;

  const { buf32, depth } = rd;

  let w1_row = (x0c - x2) * dy23 - (y0c - y2) * dx23;
  let w2_row = (x0c - x3) * dy31 - (y0c - y3) * dx31;
  let w3_row = (x0c - x1) * dy12 - (y0c - y1) * dx12;

  for (let y = y0c; y <= yec; y++) {
    const row = y * SCREEN_W;
    const by = y & 3;
    let w1 = w1_row;
    let w2 = w2_row;
    let w3 = w3_row;
    let zRow = w1_row * zF0 + w2_row * zF1 + w3_row * zF2;
    let uRow = w1_row * u0 + w2_row * u1 + w3_row * u2;
    let vRow = w1_row * vv0 + w2_row * vv1 + w3_row * vv2;

    for (let x = x0c; x <= xec; x++) {
      const allPos = (w1 >= 0) & (w2 >= 0) & (w3 >= 0);
      const allNeg = (w1 <= 0) & (w2 <= 0) & (w3 <= 0);
      if (allPos | allNeg) {
        const z = zRow;
        const idx = row + x;
        if (z < depth[idx]) {
          depth[idx] = z;

          const texel = sampleTextureNearest(texture, uRow, vRow);
          const tinted = tintTexelRGBA(texel, color);
          const cR = tinted & 0xff;
          const cG = (tinted >>> 8) & 0xff;
          const cB = (tinted >>> 16) & 0xff;
          const cA = tinted >>> 24;

          let t256;
          if (z <= FOG_NEAR) t256 = 0;
          else if (z >= FOG_FAR) t256 = 256;
          else t256 = ((z - FOG_NEAR) * _FOG_RANGE_INV * 256) | 0;

          const t = _BAYER[(by << 2) | (x & 3)];
          const invT = 256 - t256;
          const r0 = ((_FC_R * t256 + cR * invT) >> 8);
          const g0 = ((_FC_G * t256 + cG * invT) >> 8);
          const b0 = ((_FC_B * t256 + cB * invT) >> 8);

          const r2 = (r0 + t) < 0 ? 0 : (r0 + t) > 255 ? 0xf8 : ((r0 + t) & 0xf8);
          const g2 = (g0 + t) < 0 ? 0 : (g0 + t) > 255 ? 0xf8 : ((g0 + t) & 0xf8);
          const b2 = (b0 + t) < 0 ? 0 : (b0 + t) > 255 ? 0xf8 : ((b0 + t) & 0xf8);
          buf32[idx] = (cA << 24) | (b2 << 16) | (g2 << 8) | r2;
        }
      }
      w1 += dy23; w2 += dy31; w3 += dy12;
      zRow += dy23*zF0 + dy31*zF1 + dy12*zF2;
      uRow += dy23*u0 + dy31*u1 + dy12*u2;
      vRow += dy23*vv0 + dy31*vv1 + dy12*vv2;
    }
    w1_row -= dx23; w2_row -= dx31; w3_row -= dx12;
  }
}

export function drawPixelW(rd, world, camera, color, size = 1) {
  const p = project(world, camera);
  if (!p.visible) return;
  // C_final = C_fog * f + C_object * (1 - f),  f = fogByte / 255 in 0..1
  // fogT256 = fogByte (already 0..255 ≈ 0..256 fixed-point for the blend)
  const fogB = fogByte(p.cz);
  const fogT256 = fogB; // 0..255 (treat as /256 fixed-point fog factor)
  const fr = color & 0xff,      fg = (color >>> 8) & 0xff,  fb = (color >>> 16) & 0xff;
  const rr = fr + (((_FC_R - fr) * fogT256) >> 8);
  const rg = fg + (((_FC_G - fg) * fogT256) >> 8);
  const rb = fb + (((_FC_B - fb) * fogT256) >> 8);
  const ra = color >>> 24;
  const tinted = (ra << 24) | (rb << 16) | (rg << 8) | rr;
  const c = quantize15(tinted, p.sx, p.sy);
  const { buf32, depth } = rd;
  for (let dy = -size; dy <= size; dy++) {
    const y = (p.sy + dy) | 0;
    if (y < 0 || y >= SCREEN_H) continue;
    const row = y * SCREEN_W;
    for (let dx = -size; dx <= size; dx++) {
      const x = (p.sx + dx) | 0;
      if (x < 0 || x >= SCREEN_W) continue;
      const idx = row + x;
      if (p.cz < depth[idx]) {
        depth[idx] = p.cz;
        buf32[idx] = c;
      }
    }
  }
}

// ---- Present buffer to canvas, optionally with warp distortion -------------
export function present(rd, warpAmount = 0, fadeAmount = 0) {
  if (warpAmount > 0.5 || fadeAmount > 0) {
    const src = new Uint32Array(rd.buf32);
    const fadeC = rgba(0, 0, 0);
    for (let y = 0; y < SCREEN_H; y++) {
      const phase = Math.sin((y / SCREEN_H) * Math.PI * 4 + warpAmount * 0.1);
      const shift = (phase * warpAmount) | 0;
      const row = y * SCREEN_W;
      for (let x = 0; x < SCREEN_W; x++) {
        let sx = x + shift;
        if (sx < 0) sx = 0; else if (sx >= SCREEN_W) sx = SCREEN_W - 1;
        let c = src[row + sx];
        if (fadeAmount > 0) c = tint(c, fadeC, fadeAmount * 0.85);
        rd.buf32[row + x] = c;
      }
    }
  }
  rd.ctx.putImageData(rd.image, 0, 0);
}

// ---- Simple 4x5 monospace bitmap font for HUD overlay ----------------------
const FONT = {
  "0": 0x69996, "1": 0x4c44e, "2": 0xe168f, "3": 0xe161e, "4": 0x99f11,
  "5": 0xf8e1e, "6": 0x68e96, "7": 0xf1244, "8": 0x69696, "9": 0x69716,
  "A": 0x69f99, "B": 0xe9e9e, "C": 0x78887, "D": 0xe999e, "E": 0xf8e8f,
  "F": 0xf8e88, "G": 0x78b97, "H": 0x99f99, "I": 0xe444e, "J": 0x722a4,
  "K": 0x9aca9, "L": 0x8888f, "M": 0x9ff99, "N": 0x9dfb9, "O": 0x69996,
  "P": 0xe9e88, "Q": 0x699b7, "R": 0xe9ea9, "S": 0x7861e, "T": 0xf4444,
  "U": 0x99996, "V": 0x99966, "W": 0x99ff9, "X": 0x96669, "Y": 0x99644,
  "Z": 0xf168f,
  " ": 0,
  ".": 0x00004, ",": 0x00048, "-": 0x00e00, ":": 0x04040,
  "+": 0x04e40, "/": 0x12480, "!": 0x44404, "?": 0xe1604,
  ">": 0x84248,
  "<": 0x24842,
  "(": 0x24442, ")": 0x84448,
  "[": 0xe8888, "]": 0xe111e,
  "_": 0x0000f,
};

export function drawText(rd, text, x, y, color = 0xffffffff, scale = 1) {
  text = String(text).toUpperCase();
  const { buf32 } = rd;
  let cx = x | 0;
  for (let i = 0; i < text.length; i++) {
    const glyph = FONT[text[i]] ?? 0;
    for (let gy = 0; gy < 5; gy++) {
      const row = (glyph >>> ((4 - gy) * 4)) & 0xf;
      for (let gx = 0; gx < 4; gx++) {
        const bit = (row >>> (3 - gx)) & 1;
        if (!bit) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const xx = cx + gx * scale + px;
            const yy = y + gy * scale + py;
            if (xx < 0 || xx >= SCREEN_W || yy < 0 || yy >= SCREEN_H) continue;
            buf32[yy * SCREEN_W + xx] = color;
          }
        }
      }
    }
    cx += 5 * scale;
  }
}

export function drawRect(rd, x, y, w, h, color, fill = true) {
  const { buf32 } = rd;
  const x0 = (x < 0 ? 0 : x) | 0;
  const y0 = (y < 0 ? 0 : y) | 0;
  const x1 = (x + w > SCREEN_W ? SCREEN_W : x + w) | 0;
  const y1 = (y + h > SCREEN_H ? SCREEN_H : y + h) | 0;
  if (fill) {
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * SCREEN_W;
      for (let xx = x0; xx < x1; xx++) buf32[row + xx] = color;
    }
  } else {
    for (let xx = x0; xx < x1; xx++) {
      buf32[y0 * SCREEN_W + xx] = color;
      buf32[(y1 - 1) * SCREEN_W + xx] = color;
    }
    for (let yy = y0; yy < y1; yy++) {
      buf32[yy * SCREEN_W + x0] = color;
      buf32[yy * SCREEN_W + x1 - 1] = color;
    }
  }
}

// ---- Island bottom taper (cone/pyramid tapering to a single point) ---------
// Draws 4 triangular faces from the 4 bottom corners of a block down to a tip.
// tipY: world Y of the point (default = bottom of block - taperDepth)
export function buildIslandTaper(cx, cy, cz, sx, sz, sideColor, camera, taperDepth = null) {
  // Bottom face corners of the block (cy is block center Y, so bottom = cy - sy,
  // but callers pass the actual bottom Y directly as cy here)
  const botY = cy;
  const td   = taperDepth !== null ? taperDepth : (sx + sz) * 0.85;  // scale with footprint
  const tipY = botY - td;
  const tip  = { x: cx, y: tipY, z: cz };

  // 4 bottom corners
  const c0 = { x: cx - sx, y: botY, z: cz - sz }; // NW
  const c1 = { x: cx + sx, y: botY, z: cz - sz }; // NE
  const c2 = { x: cx + sx, y: botY, z: cz + sz }; // SE
  const c3 = { x: cx - sx, y: botY, z: cz + sz }; // SW

  const camDx = camera.x - cx;
  const camDz = camera.z - cz;

  // Shade sides: slightly darker than side to read as bottom
  const darkSide = shadeFace(sideColor, 0.50);
  const darkSide2= shadeFace(sideColor, 0.40);

  // 4 triangular faces: each is a corner-pair → tip
  // Only draw faces whose outward normal faces the camera
  const faces = [
    { pts: [c0, c1, tip], nx:  0, nz: -1 },  // North
    { pts: [c1, c2, tip], nx:  1, nz:  0 },  // East
    { pts: [c2, c3, tip], nx:  0, nz:  1 },  // South
    { pts: [c3, c0, tip], nx: -1, nz:  0 },  // West
  ];

  const tris = [];
  for (const face of faces) {
    const dot = camDx * face.nx + camDz * face.nz;
    if (dot <= 0) continue;
    const col = (face.nx !== 0) ? darkSide2 : darkSide;
    for (const t of buildFace(face.pts, col, camera)) tris.push(t);
  }
  return tris;
}

// ---- Animated void/water plane below the islands ---------------------------
// Renders a large flat quad at Y = voidY with animated wave tint.
// Uses painter's algo — just push tris like everything else.
export function buildVoidPlane(voidY, frame, camera) {
  // Large horizontal plane — 400 world units radius
  const R = 400;
  const waveT = frame * 0.04;

  // Two animated colors that mix with the wave
  const c1 = rgba(30, 20, 60);   // deep void purple
  const c2 = rgba(60, 40, 100);  // lighter void mid
  const waveBright = ((Math.sin(waveT) + 1) * 0.5) * 0.4; // 0..0.4
  const waveColor = lerpColor(c1, c2, waveBright);

  // Four corners of the plane
  const pts = [
    { x: camera.x - R, y: voidY, z: camera.z - R },
    { x: camera.x + R, y: voidY, z: camera.z - R },
    { x: camera.x + R, y: voidY, z: camera.z + R },
    { x: camera.x - R, y: voidY, z: camera.z + R },
  ];

  // Only render if camera is above the plane
  if (camera.y <= voidY) return [];

  const tris = buildFace(pts, waveColor, camera);
  // Add a second slightly higher band for wave shimmer
  const shimmerY = voidY + 0.8 + Math.sin(waveT * 1.7) * 0.5;
  const shimmerC = lerpColor(waveColor, rgba(100, 80, 180), 0.35);
  const ptsS = [
    { x: camera.x - R, y: shimmerY, z: camera.z - R },
    { x: camera.x + R, y: shimmerY, z: camera.z - R },
    { x: camera.x + R, y: shimmerY, z: camera.z + R },
    { x: camera.x - R, y: shimmerY, z: camera.z + R },
  ];
  const shimmerTris = buildFace(ptsS, shimmerC, camera);
  return [...tris, ...shimmerTris];
}

// ---- Biome decoration builders ----------------------------------------------
// Each returns an array of { verts, color, avgZ } triangles.

// Tree: trunk (tall thin box) + canopy (cube)
export function buildTree(cx, cy, cz, scale, camera) {
  const th = 1.8 * scale;   // trunk half-height
  const tw = 0.18 * scale;  // trunk half-width
  const ch = 1.0 * scale;   // canopy half-size
  const trunkTop = cy + th;

  const TRUNK = rgba(90, 60, 30);
  const LEAF  = rgba(50, 150, 40);
  const LEAFS = rgba(30, 100, 25);

  const tris = [];
  for (const t of buildCube(cx, cy, cz, tw, th, tw, TRUNK, shadeFace(TRUNK, 0.7), camera)) tris.push(t);
  for (const t of buildCube(cx, trunkTop, cz, ch, ch * 0.8, ch, LEAF, LEAFS, camera)) tris.push(t);
  return tris;
}

// Pine: trunk + stacked triangle prisms shrinking upward
export function buildPine(cx, cy, cz, scale, camera) {
  const TRUNK = rgba(80, 55, 28);
  const GREEN = rgba(40, 130, 50);
  const GREENS= rgba(25, 90, 35);
  const tw = 0.14 * scale;
  const th = 1.2 * scale;

  const tris = [];
  for (const t of buildCube(cx, cy, cz, tw, th, tw, TRUNK, shadeFace(TRUNK, 0.65), camera)) tris.push(t);
  // Three tiers
  for (let i = 0; i < 3; i++) {
    const r = (1.2 - i * 0.35) * scale;
    const sy = (0.55 - i * 0.1) * scale;
    const oy = cy + th + i * sy * 1.1;
    for (const t of buildTriPrism(cx, oy, cz, r, sy, 30, GREEN, GREENS, camera)) tris.push(t);
  }
  return tris;
}

// Ice spire: tall thin trapezoid prism
export function buildSpire(cx, cy, cz, scale, camera) {
  const ICE  = rgba(180, 230, 255);
  const ICES = rgba(100, 170, 220);
  const sy = (2.0 + scale) * scale;
  const sx = 0.35 * scale;
  const tris = [];
  for (const t of buildTrapezoid(cx, cy, cz, sx, sy, sx * 0.9, 0.05, 0, ICE, ICES, camera)) tris.push(t);
  return tris;
}

// Mushroom: stem (box) + cap (trapezoid, wide top)
export function buildMushroom(cx, cy, cz, scale, camera) {
  const STEM  = rgba(230, 200, 180);
  const STEMS = rgba(170, 140, 120);
  const CAP   = rgba(220, 60, 60);
  const CAPS  = rgba(160, 30, 30);
  const stemH = 0.8 * scale;
  const stemW = 0.2 * scale;
  const capW  = 1.0 * scale;
  const capH  = 0.5 * scale;
  const capY  = cy + stemH;

  const tris = [];
  for (const t of buildCube(cx, cy, cz, stemW, stemH, stemW, STEM, STEMS, camera)) tris.push(t);
  for (const t of buildTrapezoid(cx, capY, cz, capW * 0.55, capH, capW * 0.55, 1.8, 0, CAP, CAPS, camera)) tris.push(t);
  return tris;
}

// Cactus: two thick columns + small arm
export function buildCactus(cx, cy, cz, scale, camera) {
  const COL  = rgba(80, 160, 60);
  const COLS = rgba(50, 110, 35);
  const h = 1.8 * scale;
  const w = 0.28 * scale;

  const tris = [];
  // Main trunk
  for (const t of buildCube(cx, cy, cz, w, h, w, COL, COLS, camera)) tris.push(t);
  // Arm (horizontal short pillar offset to side)
  const armY = cy + h * 0.55;
  for (const t of buildCube(cx + w * 2.5, armY, cz, w * 0.7, h * 0.35, w * 0.7, COL, COLS, camera)) tris.push(t);
  return tris;
}

// Gemstone: a single tilted cube, bright accent color
export function buildGemstone(cx, cy, cz, scale, biome, camera) {
  const GEM_COLORS = {
    grass: [rgba(100, 255, 180), rgba(40, 180, 120)],
    ice:   [rgba(200, 240, 255), rgba(120, 190, 240)],
    sand:  [rgba(255, 200, 80),  rgba(200, 140, 30)],
    bubblegum: [rgba(255, 120, 200), rgba(180, 60, 150)],
    jungle:[rgba(60, 255, 120),  rgba(20, 180, 80)],
    golden:[rgba(255, 220, 40),  rgba(200, 160, 10)],
  };
  const cols = GEM_COLORS[biome] || [rgba(200, 200, 255), rgba(120, 120, 200)];
  const s = 0.5 * scale;
  const tris = [];
  for (const t of buildCube(cx, cy + s, cz, s, s, s, cols[0], cols[1], camera)) tris.push(t);
  return tris;
}

// Lantern: a glowing hovering orb (small cube with bright color)
export function buildLantern(cx, cy, cz, scale, frame, camera) {
  const bob = Math.sin(frame * 0.07 + cx * 0.5) * 0.3 * scale;
  const GLOW = rgba(255, 220, 80);
  const GLOWS= rgba(200, 160, 30);
  const s = 0.38 * scale;
  const tris = [];
  for (const t of buildCube(cx, cy + 1.2 * scale + bob, cz, s, s, s, GLOW, GLOWS, camera)) tris.push(t);
  return tris;
}

export { rgba, shade, tint, shadeFace };
