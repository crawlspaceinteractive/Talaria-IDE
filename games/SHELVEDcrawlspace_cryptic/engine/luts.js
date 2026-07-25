/**
 * luts.js — Froyo Engine Lookup Tables
 *
 * All gameplay/rendering constants live here. Tables are immutable at runtime.
 * Section IDs reference Froyo Engine Spec v0.1.
 */

// ---- Resolution / world constants ------------------------------------------
// Internal render resolution: 320×200 (CSS-scaled to fill the viewport
// with image-rendering: pixelated for a hard-pixel PS1 look).
export const SCREEN_W = 320;
export const SCREEN_H = 200;
export const HALF_W = SCREEN_W >> 1;
export const HALF_H = SCREEN_H >> 1;

// Camera focal lengths chosen for asymmetric FOV: vertical ≈ 80°, horizontal ≈ 100°.
//   FOV_x = 2 * atan(HALF_W / FOCAL_X)  →  FOCAL_X = HALF_W / tan(50°)  ≈  134
//   FOV_y = 2 * atan(HALF_H / FOCAL_Y)  →  FOCAL_Y = HALF_H / tan(40°)  ≈  119
export const FOCAL_X = 134;
export const FOCAL_Y = 119;
// Legacy single-focal export kept for any external callers; defaults to FOCAL_Y.
export const FOCAL = FOCAL_Y;

// ---- SCALE_TABLE[z] -> projection scaling (separate per axis) --------------
// z is integer depth in tenths. SCALE_TABLE_X[i] = FOCAL_X / (i*0.1), etc.
const SCALE_LEN = 4096;
export const SCALE_TABLE_X = new Float32Array(SCALE_LEN);
export const SCALE_TABLE_Y = new Float32Array(SCALE_LEN);
for (let i = 1; i < SCALE_LEN; i++) {
  const zWorld = i * 0.1;
  SCALE_TABLE_X[i] = FOCAL_X / zWorld;
  SCALE_TABLE_Y[i] = FOCAL_Y / zWorld;
}
SCALE_TABLE_X[0] = FOCAL_X / 0.05;
SCALE_TABLE_Y[0] = FOCAL_Y / 0.05;

// Back-compat: a single SCALE_TABLE that resolves to Y (the more constraining axis).
export const SCALE_TABLE = SCALE_TABLE_Y;

export function scaleAtX(zWorld) {
  if (zWorld <= 0.1) return SCALE_TABLE_X[1];
  let i = (zWorld * 10) | 0;
  if (i >= SCALE_LEN) i = SCALE_LEN - 1;
  return SCALE_TABLE_X[i];
}
export function scaleAtY(zWorld) {
  if (zWorld <= 0.1) return SCALE_TABLE_Y[1];
  let i = (zWorld * 10) | 0;
  if (i >= SCALE_LEN) i = SCALE_LEN - 1;
  return SCALE_TABLE_Y[i];
}
// Back-compat alias.
export const scaleAt = scaleAtY;

// ---- TRIG_SIN[deg] / TRIG_COS[deg] -----------------------------------------
export const TRIG_SIN = new Float32Array(360);
export const TRIG_COS = new Float32Array(360);
for (let d = 0; d < 360; d++) {
  const r = (d * Math.PI) / 180;
  TRIG_SIN[d] = Math.sin(r);
  TRIG_COS[d] = Math.cos(r);
}
export function sinDeg(d) {
  d = ((d % 360) + 360) % 360 | 0;
  return TRIG_SIN[d];
}
export function cosDeg(d) {
  d = ((d % 360) + 360) % 360 | 0;
  return TRIG_COS[d];
}

// ---- Movement / Jump mode IDs (DISCRETE STATE) ------------------------------
export const MOVE = {
  IDLE: 0,
  WALK: 1,
  CHARGE: 2,
  AIRBORNE: 3,
  GLIDE: 4,
};
export const JUMPM = {
  GROUNDED: 0,
  JUMPING: 1,
  DOUBLE_JUMP: 2,
  FALLING: 3,
};

// ---- CAMERA_OFFSET_LUT[m] (per movement mode) -------------------------------
// Zoomed in considerably — back cut to ~40% of previous values so Froyo
// reads large and readable against the big island geometry.
export const CAMERA_OFFSET_LUT = [
  { back:  7.0, up: 3.5 }, // IDLE
  { back:  8.0, up: 3.5 }, // WALK
  { back: 11.0, up: 4.2 }, // CHARGE (zoomed back for speed feel)
  { back:  8.5, up: 4.0 }, // AIRBORNE
  { back:  9.5, up: 4.5 }, // GLIDE
];

// ---- CAMERA_FOV_LUT[m] (focal-length multiplier per movement mode) ---------
//   <1 widens FOV (zoom out), >1 narrows (zoom in). Combined with the
//   CAMERA_OFFSET_LUT.back boost above, CHARGE gets the "speed-blur" feel
//   without breaking the locked-behind framing.
export const CAMERA_FOV_LUT = [
  1.00, // IDLE
  1.00, // WALK
  0.92, // CHARGE — slightly wider lens
  1.00, // AIRBORNE
  1.02, // GLIDE — fractionally tighter, hints at "floaty focus"
];

// ---- CAMERA_LAG_LUT[m] (smoothing 0..1, higher = snappier) ------------------
export const CAMERA_LAG_LUT = [0.10, 0.12, 0.18, 0.10, 0.08];

// ---- PHYSICS_LUT[m] ---------------------------------------------------------
// CORE MODIFIERS from spec:
//   CHARGE: velocity x2
//   GROUND: velocity x0.65 (friction-ish per frame retention)
//   AIR: velocity x0.98
//   GLIDE: clamp vertical
export const PHYSICS_LUT = [
  // IDLE
  { accel: 0.0,  maxSpeed: 0.0,  groundDamp: 0.65, airDamp: 0.98, gravity: 0.030, maxFall: 0.45, vClamp: null },
  // WALK
  { accel: 0.040, maxSpeed: 0.18, groundDamp: 0.78, airDamp: 0.98, gravity: 0.030, maxFall: 0.45, vClamp: null },
  // CHARGE  (x2 movement)
  { accel: 0.080, maxSpeed: 0.36, groundDamp: 0.88, airDamp: 0.99, gravity: 0.030, maxFall: 0.45, vClamp: null },
  // AIRBORNE
  { accel: 0.025, maxSpeed: 0.22, groundDamp: 0.65, airDamp: 0.98, gravity: 0.030, maxFall: 0.55, vClamp: null },
  // GLIDE
  { accel: 0.030, maxSpeed: 0.20, groundDamp: 0.65, airDamp: 0.99, gravity: 0.008, maxFall: 0.10, vClamp: -0.10 },
];

// ---- ANIM_LUT[m] -> animation hint (frame range / sprite key) ---------------
export const ANIM_LUT = [
  { name: "idle",   frames: [0, 1],     fps: 4  },
  { name: "walk",   frames: [2, 3, 4, 5], fps: 12 },
  { name: "charge", frames: [6, 7],     fps: 18 },
  { name: "airborne", frames: [8, 9],   fps: 8  },
  { name: "glide",  frames: [10, 11],   fps: 6  },
];

// ---- JUMP_REACH_LUT[v] -> max horizontal distance achievable for jump v -----
//   v is integer dm/frame (decimetres) of initial vertical impulse.
//   Used by world generation reachability validation.
export const JUMP_REACH_LUT = (() => {
  const arr = new Float32Array(64);
  for (let v = 0; v < 64; v++) {
    const v0 = v * 0.05;          // 0.0 .. 3.15 vertical impulse
    const g = 0.030;              // matches PHYSICS_LUT gravity
    const tAir = (2 * v0) / g;    // total airtime in frames
    arr[v] = tAir * 0.22;         // horizontal speed cap during air
  }
  return arr;
})();

// ---- PLATFORM_HEIGHT_LUT[h] -> valid traversal heights ---------------------
//   Indexed by integer step (0..15). Each entry = world Y level (scaled 8×).
//   Variance clamped: max height kept at ~38 units so the player can always
//   see (and in principle reach with double-jump + bridge) every island.
export const PLATFORM_HEIGHT_LUT = new Float32Array([
  0.0, 3.2, 6.4, 9.6, 12.8, 16.0, 19.2, 22.4,
  25.6, 28.8, 32.0, 35.2, 38.4, 38.4, 38.4, 38.4,
]);

// ---- BREATH_SPREAD_LUT[a] -> per-particle angular offset --------------------
// 8-entry symmetric cone, in radians.
export const BREATH_SPREAD_LUT = new Float32Array([
  -0.30, -0.20, -0.10, -0.03,
   0.03,  0.10,  0.20,  0.30,
]);

// ---- BREATH_SPREAD_DIR_LUT -> flat [cos0, sin0, cos1, sin1, ...] pairs ------
// Pre-computed (cos, sin) for each angle in BREATH_SPREAD_LUT.
// breath.js iterates s += 2: [s] = cos, [s+1] = sin.
export const BREATH_SPREAD_DIR_LUT = (() => {
  const angles = BREATH_SPREAD_LUT;
  const arr = new Float32Array(angles.length * 2);
  for (let i = 0; i < angles.length; i++) {
    arr[i * 2]     = Math.cos(angles[i]);
    arr[i * 2 + 1] = Math.sin(angles[i]);
  }
  return arr;
})();

// ---- BREATH_STEP_LUT[d] -> stepping distances (spec: 0.25 increments) -------
export const BREATH_STEP_LUT = new Float32Array(48);
for (let i = 0; i < 48; i++) BREATH_STEP_LUT[i] = i * 0.25;

// ---- WARP_OFFSET_LUT[f] -> portal transition distortion per frame ----------
//   30 frames of warp. Each entry = horizontal pixel scanline shift amplitude.
export const WARP_OFFSET_LUT = new Float32Array(30);
for (let f = 0; f < 30; f++) {
  // Ease in–out
  const t = f / 29;
  WARP_OFFSET_LUT[f] = Math.sin(t * Math.PI) * 32;
}

// ---- COLOR_COLLAPSE_LUT[f] -> fade/warp color collapse (alpha 0..1) ---------
export const COLOR_COLLAPSE_LUT = new Float32Array(30);
for (let f = 0; f < 30; f++) {
  const t = f / 29;
  COLOR_COLLAPSE_LUT[f] = Math.sin(t * Math.PI); // 0 → 1 → 0
}

// ---- SPIN_SMEAR_LUT[f] -> HUD digit/icon transition frames -----------------
//   24 frames of spin, returns rotation in degrees + Y offset.
export const SPIN_SMEAR_LUT = (() => {
  const arr = [];
  for (let f = 0; f < 24; f++) {
    const t = f / 23;
    arr.push({
      rot: Math.sin(t * Math.PI * 2) * 18,
      yOff: -Math.sin(t * Math.PI) * 4,
      smear: Math.sin(t * Math.PI), // 0..1..0
    });
  }
  return arr;
})();

// ---- Bayer 4x4 dither matrix ----------------------------------------------
export const BAYER_4X4 = new Int8Array([
  0,  8,  2, 10,
  12, 4, 14,  6,
  3, 11,  1,  9,
  15, 7, 13,  5,
]);
