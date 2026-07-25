/**
 * luts.js — Froyo Racer Engine Lookup Tables
 *
 * Ported from the platformer luts.js.
 * Retained: SCREEN_W/H, FOCAL_X/Y, SCALE_TABLE, TRIG LUTs, sinDeg/cosDeg.
 * Replaced: platformer movement/camera/jump/physics tables with racing equivalents.
 *
 * New sections:
 *   SURFACE_LUT      — grip/friction per surface type (tarmac, gravel, grass, kerb)
 *   GEAR_RATIO_LUT   — 6 forward gears + reverse
 *   TORQUE_CURVE_LUT — 16-sample RPM torque envelope
 *   DRIVE_MODE       — discrete car state IDs (replaces MOVE / JUMPM)
 *   CAMERA_OFFSET_LUT / CAMERA_LAG_LUT / CAMERA_FOV_LUT — per drive mode
 *   BRAKE_TORQUE_LUT — front/rear brake bias per drive mode
 */

// ---- Resolution / world constants ------------------------------------------
export const SCREEN_W = 320;
export const SCREEN_H = 200;
export const HALF_W = SCREEN_W >> 1;
export const HALF_H = SCREEN_H >> 1;

// Camera focal lengths — same 100°H / 80°V asymmetric FOV as the platformer.
export const FOCAL_X = 134;
export const FOCAL_Y = 119;
export const FOCAL    = FOCAL_Y; // back-compat

// ---- SCALE_TABLE[z] ---------------------------------------------------------
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
export const SCALE_TABLE = SCALE_TABLE_Y; // back-compat

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
export const scaleAt = scaleAtY; // back-compat

// ---- TRIG_SIN / TRIG_COS ----------------------------------------------------
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

// ---- Bayer 4x4 dither matrix -------------------------------------------------
export const BAYER_4X4 = new Int8Array([
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
]);

// ============================================================================
// RACING CONSTANTS
// ============================================================================

// ---- Drive mode IDs (replaces MOVE / JUMPM) ---------------------------------
// Used as indices into all _LUT arrays below.
export const DRIVE = {
  PARKED:   0,  // stationary / stopped
  DRIVING:  1,  // normal forward movement
  FAST:     2,  // above ~80% of top speed
  AIRBORNE: 3,  // off the ground (jump / crest)
  DRIFT:    4,  // handbrake / oversteer slide
};

// ---- Surface types (track segment property) ---------------------------------
export const SURFACE = {
  TARMAC: 0,
  GRAVEL: 1,
  GRASS:  2,
  KERB:   3,
};

/**
 * SURFACE_LUT[surfaceId]
 *   grip           — lateral and longitudinal traction scalar (0..1)
 *   rollingFriction— velocity retention per frame while coasting (0..1)
 *   accelScale     — engine force multiplier (gravel/grass = less bite)
 *   driftBoost     — extra yaw rate during handbrake (1 = normal)
 */
export const SURFACE_LUT = [
  // TARMAC
  { grip: 1.00, rollingFriction: 0.997, accelScale: 1.00, driftBoost: 1.0 },
  // GRAVEL
  { grip: 0.52, rollingFriction: 0.970, accelScale: 0.68, driftBoost: 1.4 },
  // GRASS
  { grip: 0.38, rollingFriction: 0.960, accelScale: 0.52, driftBoost: 1.6 },
  // KERB (rumble strip — high friction spike, penalises if you ride it too long)
  { grip: 0.82, rollingFriction: 0.985, accelScale: 0.88, driftBoost: 1.1 },
];

// ---- Gear ratios (index 0 = reverse, 1..6 = forward gears) -----------------
// Higher ratio = more torque multiplication, lower top speed per gear.
// Final drive ratio = 3.8 (baked into TORQUE_SCALE, not separate).
export const GEAR_RATIO_LUT = new Float32Array([
  -3.20,  // R  (reverse)
   3.50,  // 1st
   2.18,  // 2nd
   1.58,  // 3rd
   1.24,  // 4th
   1.00,  // 5th
   0.82,  // 6th
]);

export const GEAR_REVERSE = 0;
export const GEAR_NEUTRAL = -1; // special value, not an index
export const GEAR_COUNT   = 6;  // forward gears

// RPM range
export const RPM_IDLE    = 800;
export const RPM_REDLINE = 7800;
export const RPM_SHIFT_UP   = 6800; // auto-shift up threshold
export const RPM_SHIFT_DOWN = 2200; // auto-shift down threshold

/**
 * TORQUE_CURVE_LUT — 16 evenly-spaced samples across the RPM band.
 * Index 0 = RPM_IDLE, index 15 = RPM_REDLINE.
 * Values are normalised torque (0..1). Multiply by CAR_TORQUE_NM for real units.
 *
 * Shape: builds quickly to a fat mid-range torque peak (GT car flavour),
 * then falls off approaching redline.
 */
export const TORQUE_CURVE_LUT = new Float32Array([
  0.40,  // 800  RPM  — idle
  0.55,  // 1300
  0.70,  // 1800
  0.82,  // 2300
  0.92,  // 2800
  0.99,  // 3300  ← torque peak region begins
  1.00,  // 3800  ← peak
  0.99,  // 4300
  0.97,  // 4800
  0.93,  // 5300
  0.87,  // 5800
  0.78,  // 6300
  0.66,  // 6800
  0.52,  // 7300
  0.36,  // 7800  ← redline
  0.10,  // (guard — never reached in normal play)
]);

/** Sample the torque curve at an arbitrary RPM. Returns 0..1. */
export function torqueAtRPM(rpm) {
  const n = TORQUE_CURVE_LUT.length - 1;
  const t = (rpm - RPM_IDLE) / (RPM_REDLINE - RPM_IDLE);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const idx = clamped * n;
  const lo  = idx | 0;
  const hi  = lo < n ? lo + 1 : n;
  const frac = idx - lo;
  return TORQUE_CURVE_LUT[lo] + (TORQUE_CURVE_LUT[hi] - TORQUE_CURVE_LUT[lo]) * frac;
}

// ---- Car physics baseline constants ----------------------------------------
// These are tuned for a ~1200 kg GT-class car at the engine's world scale
// (1 world unit ≈ 1 metre).  Adjust TORQUE_NM / MASS for different car classes.
export const CAR_MASS         = 1200;   // kg (affects inertia feel only — forces scaled)
export const CAR_TORQUE_NM    = 420;    // Nm peak engine torque
export const CAR_FINAL_DRIVE  = 3.8;    // final drive ratio
export const CAR_WHEEL_RADIUS = 0.32;   // metres — converts torque→force at wheel

// Longitudinal force = torque(RPM) * gearRatio * finalDrive / wheelRadius / mass
// (pre-multiplied below into a convenient scalar)
export const DRIVE_FORCE_SCALE =
  (CAR_TORQUE_NM * CAR_FINAL_DRIVE) / (CAR_WHEEL_RADIUS * CAR_MASS);

export const CAR_TOP_SPEED     = 78.0;  // m/s (≈280 km/h — GT class)
export const CAR_BRAKE_FORCE   = 2.20;  // decel m/s² at full brake (engine-units/frame²)
export const CAR_HANDBRAKE_FORCE = 3.0; // decel when handbrake locked
export const CAR_STEER_RATE    = 2.6;   // max yaw rate rad/s at low speed
export const CAR_STEER_SPEED_FALLOFF = 0.018; // yaw rate falls off with speed
export const CAR_DRIFT_LATERAL_GRIP  = 0.30;  // lateral grip fraction while drifting

// ---- CAMERA_OFFSET_LUT[driveMode] ------------------------------------------
// back: distance behind car (world units), up: height above car centre
export const CAMERA_OFFSET_LUT = [
  { back:  6.0, up: 2.5 }, // PARKED
  { back:  7.5, up: 2.5 }, // DRIVING
  { back: 10.0, up: 3.0 }, // FAST    — zooms back for speed feel
  { back:  8.0, up: 3.5 }, // AIRBORNE
  { back:  9.5, up: 2.8 }, // DRIFT   — slightly wider view
];

// ---- CAMERA_FOV_LUT[driveMode] — focal-length multiplier -------------------
// < 1 = wider (zoom-out), > 1 = narrower (zoom-in)
export const CAMERA_FOV_LUT = [
  1.00, // PARKED
  1.00, // DRIVING
  0.90, // FAST    — mild wide-lens speed-blur
  1.00, // AIRBORNE
  0.94, // DRIFT   — fractionally wider for dramatic cornering view
];

// ---- CAMERA_LAG_LUT[driveMode] — smoothing coefficient (0..1, higher=snappier)
export const CAMERA_LAG_LUT = [
  0.08, // PARKED   — lazy settle
  0.12, // DRIVING
  0.16, // FAST     — snappier at speed so track feels responsive
  0.10, // AIRBORNE
  0.09, // DRIFT    — let the camera lag during a slide for cinematic feel
];

// ---- SPEEDOMETER_LUT — 16-sample non-linear needle sweep (0..1 → angle) ---
// Maps normalised speed (0 = stopped, 1 = top speed) to needle rotation 0..1
// (0 = full left, 1 = full right).  Slightly compressed at the top end
// so the high-speed zone has more visual resolution.
export const SPEEDOMETER_LUT = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const t = i / 15;
  // Mild ease-in: quicker off the mark, compressed top end
  SPEEDOMETER_LUT[i] = Math.pow(t, 0.85);
}

// ---- SKID_CURVE_LUT — lateral slip angle → skid intensity (0..1) -----------
// 12 samples, 0° → 18° slip angle.  Used to drive skid mark opacity + tyre squeal.
export const SKID_CURVE_LUT = new Float32Array([
  0.00, // 0° — no slip
  0.05, // 1.5°
  0.12, // 3°
  0.22, // 4.5°
  0.35, // 6°
  0.50, // 7.5° — onset of squeal
  0.65, // 9°
  0.77, // 10.5°
  0.86, // 12°
  0.92, // 13.5°
  0.97, // 15°
  1.00, // 16.5°+  — full lockup
]);

/** Sample skid curve at a slip angle in degrees (0..18+). Returns 0..1. */
export function skidAtSlip(slipDeg) {
  const n = SKID_CURVE_LUT.length - 1;
  const t = slipDeg / 18.0;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const idx = clamped * n;
  const lo  = idx | 0;
  const hi  = lo < n ? lo + 1 : n;
  const frac = idx - lo;
  return SKID_CURVE_LUT[lo] + (SKID_CURVE_LUT[hi] - SKID_CURVE_LUT[lo]) * frac;
}

// ---- WARP_OFFSET_LUT — portal/checkpoint flash (retained from platformer) ---
export const WARP_OFFSET_LUT = new Float32Array(30);
for (let f = 0; f < 30; f++) {
  const t = f / 29;
  WARP_OFFSET_LUT[f] = Math.sin(t * Math.PI) * 32;
}
export const COLOR_COLLAPSE_LUT = new Float32Array(30);
for (let f = 0; f < 30; f++) {
  const t = f / 29;
  COLOR_COLLAPSE_LUT[f] = Math.sin(t * Math.PI);
}
