/**
 * physics.js — Car movement system (GT-lite arcade-sim)
 *
 * Drop-in replacement for the platformer physics.js.
 * Keeps the same module path (../engine/luts.js) and same primary export
 * signature so game.js requires minimal changes:
 *
 *   OLD:  stepPhysics(player, world, ctx)
 *   NEW:  stepPhysics(car,    world, ctx)
 *         world.track must be a built track from track.js
 *
 * Velocity model
 * --------------
 *   Velocity is split into two car-local components:
 *     vLong — longitudinal (forward/back along car heading)
 *     vLat  — lateral (sideways slip)
 *
 *   Each frame:
 *     1. Engine torque → vLong  (torque curve × gear ratio × surface accel)
 *     2. Braking / rolling friction bleed vLong
 *     3. Steering + speed → yaw rate → car.yaw
 *     4. Lateral velocity builds from rotation; grip bleeds it back to zero
 *        (drift state drastically reduces grip → slides persist)
 *     5. vLong + vLat → world vx/vz → integrate x/z
 *     6. Gravity on vy when airborne; track.groundYAt() snaps car to road
 *
 * FIXED-POINT NOTES (matching original physics.js conventions)
 * -----------------------------------------------------------
 *   Rolling friction damping uses 16.16 fixed-point integers baked from
 *   SURFACE_LUT at startup, matching the original's _groundDamp256 pattern.
 *   All other arithmetic stays in float64 — the torque/gear path is too
 *   branchy to benefit from fixed-point.
 *
 * Car object schema (replaces player object — same field names where possible)
 * ----------------------------------------------------------------------------
 *   x, y, z       — world position       (same as player)
 *   yaw           — heading degrees       (same as player)
 *   vx, vz        — world-space velocity  (same as player)
 *   vy            — vertical velocity     (same as player)
 *   grounded      — boolean               (same as player)
 *   state         — CAR_STATE bitmask     (same as player.state — see carstate.js)
 *   vLong         — longitudinal speed (m/s, + = forward)
 *   vLat          — lateral slip speed (m/s, + = rightward)
 *   gear          — 0 = reverse, 1..6 = forward
 *   rpm           — smoothed engine RPM (for audio / gauges)
 *   steerAngle    — smoothed steer input -1..1
 *   slipAngle     — lateral slip angle degrees (skid marks)
 *   skidIntensity — 0..1 (skid mark opacity)
 *   drifting      — boolean (handbrake slide active)
 *   autoShift     — boolean (true = computer shifts gears)
 */

import {
  SURFACE_LUT,
  GEAR_RATIO_LUT,
  GEAR_REVERSE,
  GEAR_COUNT,
  RPM_IDLE,
  RPM_REDLINE,
  RPM_SHIFT_UP,
  RPM_SHIFT_DOWN,
  DRIVE_FORCE_SCALE,
  CAR_TOP_SPEED,
  CAR_BRAKE_FORCE,
  CAR_HANDBRAKE_FORCE,
  CAR_STEER_RATE,
  CAR_STEER_SPEED_FALLOFF,
  CAR_DRIFT_LATERAL_GRIP,
  torqueAtRPM,
  skidAtSlip,
} from "../engine/luts.js";
import { CAR_STATE } from "../engine/carstate.js";
import { BTN_FLAGS } from "../engine/input.js";
import { groundYAt, surfaceAt, nearestSegment } from "../engine/track.js";

// ---- Physics constants -------------------------------------------------------
const GRAVITY           = 0.025;  // world units / frame² (airborne downward pull)
const AIR_DRAG          = 0.0008; // aero drag coefficient (× vLong²)
const LATERAL_GRIP_BASE = 0.72;   // lateral bleed rate per frame on tarmac
const REVERSE_MAX_SPEED = 12.0;   // m/s cap going backward
const STEER_RETURN_RATE = 0.15;   // how fast steer centres when input released
const STEER_MIN_SPEED   = 0.8;    // m/s below which steering has no effect
const STEER_LATERAL_FEED = 0.018; // vLong fraction fed into vLat each frame when turning
const RPM_SMOOTH        = 0.18;   // RPM lag coefficient (lower = more lag)

// Wrecked state: car bounces in place for this many frames then respawns.
const WRECK_FRAMES = 90;

// ---- Pre-bake surface rolling-friction as 16.16 fixed point -----------------
// Mirrors the original physics.js _groundDamp256 pattern for the inner loop.
const _FP = 65536;
const _surfRollFP = new Int32Array(SURFACE_LUT.length);
(function bakeSurfaceLUT() {
  for (let i = 0; i < SURFACE_LUT.length; i++) {
    _surfRollFP[i] = (SURFACE_LUT[i].rollingFriction * _FP + 0.5) | 0;
  }
})();

// ============================================================================
// createCar — replaces the caller's player initialiser
// ============================================================================
/**
 * Create a car physics object at a given world position.
 * Pass the result wherever the platformer code passed a `player` object.
 *
 * @param {object} opts — { x, y, z, yaw }
 * @returns {object}
 */
export function createCar({ x = 0, y = 0, z = 0, yaw = 0 } = {}) {
  return {
    // ── Position / orientation (shared field names with old player) ──────────
    x, y, z,
    yaw,

    // ── World-space velocity (shared field names) ────────────────────────────
    vx: 0,
    vy: 0,
    vz: 0,

    // ── Car-local velocity components ────────────────────────────────────────
    vLong: 0,
    vLat:  0,

    // ── State (CAR_STATE bitmask — same role as player.state) ────────────────
    state: CAR_STATE.NONE,

    // ── Ground contact ───────────────────────────────────────────────────────
    grounded: true,

    // ── Drivetrain ───────────────────────────────────────────────────────────
    gear:      1,
    rpm:       RPM_IDLE,
    autoShift: true,

    // ── Steering ─────────────────────────────────────────────────────────────
    steerAngle: 0,

    // ── Tyre / skid ──────────────────────────────────────────────────────────
    slipAngle:     0,
    skidIntensity: 0,
    drifting:      false,

    // ── Wreck timer (counts down from WRECK_FRAMES after a collision) ────────
    _wreckTimer: 0,

    // ── Respawn position (set by game.js at race start) ──────────────────────
    _spawnX: x, _spawnY: y, _spawnZ: z, _spawnYaw: yaw,
  };
}

// ============================================================================
// stepPhysics — drop-in replacement for the platformer stepPhysics
// ============================================================================
/**
 * Advance the car by one frame.
 *
 * @param {object} car    — car object from createCar()  (was: player)
 * @param {object} world  — must contain world.track (built track from track.js)
 * @param {object} ctx    — { input, dt, movementMode }
 *                          input       — InputController
 *                          dt          — delta-time scale (1.0 = nominal 60fps)
 *                          movementMode — DRIVE.* (resolved by carstate.js, passed
 *                                          in by game.js for future per-mode hooks)
 */
export function stepPhysics(car, world, ctx) {
  const { input, dt = 1.0 } = ctx;

  // ── WRECKED — spin in place, count down, then respawn ─────────────────────
  if (car.state & CAR_STATE.WRECKED) {
    car._wreckTimer--;
    car.yaw = (car.yaw + 4 * dt) % 360;
    car.vLong  *= 0.85;
    car.vLat   *= 0.85;
    _integratePosition(car, dt);
    _snapToGround(car, world, dt);
    if (car._wreckTimer <= 0) _respawn(car);
    return;
  }

  const track = world.track;

  // ── Determine surface under the car ───────────────────────────────────────
  const surface = track ? surfaceAt(track, car.x, car.z) : 0;
  const surf    = SURFACE_LUT[surface] ?? SURFACE_LUT[0];

  // ── 1. Read inputs ─────────────────────────────────────────────────────────
  const throttle  = _readThrottle(input);
  const brake     = _readBrake(input);
  const steerRaw  = input.axisX;           // -1..1
  const handbrake = input.isDown(BTN_FLAGS.X);

  // Manual gear shifts
  if (!car.autoShift) {
    if (input.justPressed(BTN_FLAGS.RB)) _shiftUp(car);
    if (input.justPressed(BTN_FLAGS.LB)) _shiftDown(car);
  }

  // ── 2. Steer angle — smooth toward input, snap to centre on release ────────
  if (Math.abs(steerRaw) > 0.02) {
    car.steerAngle += (steerRaw - car.steerAngle) * 0.22 * dt;
  } else {
    car.steerAngle *= Math.pow(1.0 - STEER_RETURN_RATE, dt);
    if (Math.abs(car.steerAngle) < 0.001) car.steerAngle = 0;
  }

  // ── 3. Engine RPM + auto-shift ────────────────────────────────────────────
  const gearRatio = GEAR_RATIO_LUT[car.gear] ?? 1.0;
  const rawRPM    = _speedToRPM(Math.abs(car.vLong), gearRatio);
  car.rpm += (rawRPM - car.rpm) * RPM_SMOOTH * dt;
  if (car.rpm < RPM_IDLE)    car.rpm = RPM_IDLE;
  if (car.rpm > RPM_REDLINE) car.rpm = RPM_REDLINE;

  if (car.autoShift) _autoShift(car);

  // ── 4. Longitudinal force (engine + braking + rolling friction) ────────────
  let engineForce = 0;
  if (throttle > 0.01) {
    const torque = torqueAtRPM(car.rpm);
    engineForce = torque * DRIVE_FORCE_SCALE * Math.abs(gearRatio) * throttle * surf.accelScale;
    if (car.gear === GEAR_REVERSE) engineForce = -engineForce * 0.6;
  }

  // Aerodynamic drag (quadratic)
  const absSpeed = Math.abs(car.vLong);
  const drag     = AIR_DRAG * car.vLong * absSpeed;

  // Rolling friction — 16.16 fixed-point (mirrors original damping pattern)
  const rollFP    = _surfRollFP[surface] ?? _surfRollFP[0];
  const rollingLoss = car.vLong - ((car.vLong * rollFP) / _FP);

  car.vLong += (engineForce - drag - rollingLoss) * dt;

  // Braking
  if (handbrake) {
    _applyBrake(car, CAR_HANDBRAKE_FORCE, dt);
  } else if (brake > 0.01) {
    _applyBrake(car, CAR_BRAKE_FORCE * brake * surf.grip, dt);
  }

  // Speed clamps
  if (car.vLong >  CAR_TOP_SPEED)     car.vLong =  CAR_TOP_SPEED;
  if (car.vLong < -REVERSE_MAX_SPEED) car.vLong = -REVERSE_MAX_SPEED;

  // ── 5. Yaw rate (steering) ────────────────────────────────────────────────
  if (absSpeed > STEER_MIN_SPEED) {
    const yawRate = car.steerAngle * CAR_STEER_RATE /
                    (1.0 + absSpeed * CAR_STEER_SPEED_FALLOFF);
    car.yaw = (car.yaw + yawRate * (180 / Math.PI) * dt + 360) % 360;
  }

  // ── 6. Lateral dynamics ───────────────────────────────────────────────────
  if (absSpeed > STEER_MIN_SPEED) {
    car.vLat += car.steerAngle * absSpeed * STEER_LATERAL_FEED * dt;
  }

  car.drifting = handbrake && absSpeed > 4.0;

  const lateralGrip = car.drifting
    ? CAR_DRIFT_LATERAL_GRIP * surf.driftBoost
    : LATERAL_GRIP_BASE * surf.grip;

  car.vLat *= Math.pow(1.0 - lateralGrip * 0.04, dt);
  if (!car.drifting && Math.abs(car.vLat) < 0.02) car.vLat = 0;

  // ── 7. Slip angle + skid intensity ────────────────────────────────────────
  const vLatAbs = Math.abs(car.vLat);
  car.slipAngle     = absSpeed > 0.1 ? Math.atan2(vLatAbs, absSpeed) * (180 / Math.PI) : 0;
  car.skidIntensity = skidAtSlip(car.slipAngle);

  // ── 8. Integrate world position ───────────────────────────────────────────
  _integratePosition(car, dt);

  // ── 9. Ground snap / airborne ────────────────────────────────────────────
  _snapToGround(car, world, dt);
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Convert car-local vLong/vLat → world vx/vz, then integrate x/z. */
function _integratePosition(car, dt) {
  const cosYaw = Math.cos(car.yaw * Math.PI / 180);
  const sinYaw = Math.sin(car.yaw * Math.PI / 180);

  // +Z = forward at yaw 0 (matches camera.js convention)
  car.vx = sinYaw * car.vLong + cosYaw * car.vLat;
  car.vz = cosYaw * car.vLong - sinYaw * car.vLat;

  car.x += car.vx * dt;
  car.z += car.vz * dt;
}

/**
 * Snap the car to the road surface or apply gravity if airborne.
 * track.groundYAt() returns the Y of the road at (x, z) accounting for banking.
 * If the track is unavailable (e.g. during loading) the car just sits at y=0.
 */
function _snapToGround(car, world, dt) {
  const track = world?.track;
  if (!track) {
    car.grounded = true;
    return;
  }

  const roadY     = groundYAt(track, car.x, car.z);
  const carBottom = car.y;          // car origin is at centre; treat as base

  if (car.grounded) {
    // While grounded, follow road surface exactly
    car.y  = roadY;
    car.vy = 0;
  } else {
    // Airborne — apply gravity
    car.vy -= GRAVITY * dt;
    car.y  += car.vy * dt;

    // Landing check
    if (car.y <= roadY) {
      car.y       = roadY;
      car.vy      = 0;
      car.grounded = true;
    }
  }

  // Launch off a crest — if road drops away faster than the car falls, go airborne
  if (car.grounded) {
    // Probe road Y one step ahead along forward direction
    const cosYaw = Math.cos(car.yaw * Math.PI / 180);
    const sinYaw = Math.sin(car.yaw * Math.PI / 180);
    const probeX = car.x + sinYaw * 1.5;
    const probeZ = car.z + cosYaw * 1.5;
    const aheadY = groundYAt(track, probeX, probeZ);
    if (roadY - aheadY > 0.5) {
      // Crest — let the car launch
      car.grounded = false;
      car.vy = 0.04 * Math.abs(car.vLong); // small upward kick proportional to speed
    }
  }
}

function _applyBrake(car, force, dt) {
  const sign = car.vLong > 0 ? -1 : 1;
  car.vLong += sign * force * dt;
  // Prevent braking from reversing direction (unless in reverse gear)
  if (car.gear !== GEAR_REVERSE && sign === -1 && car.vLong < 0) car.vLong = 0;
  if (car.gear !== GEAR_REVERSE && sign ===  1 && car.vLong > 0) car.vLong = 0;
}

function _respawn(car) {
  car.x    = car._spawnX;
  car.y    = car._spawnY;
  car.z    = car._spawnZ;
  car.yaw  = car._spawnYaw;
  car.vLong = 0; car.vLat  = 0;
  car.vx   = 0;  car.vy   = 0; car.vz = 0;
  car.gear = 1;
  car.rpm  = RPM_IDLE;
  car.state &= ~CAR_STATE.WRECKED;
  car.grounded = true;
  car._wreckTimer = 0;
}

function _readThrottle(input) {
  if (input.isDown(BTN_FLAGS.A))  return 1.0;
  if (input.isDown(BTN_FLAGS.RT)) return 1.0;
  return 0;
}

function _readBrake(input) {
  if (input.isDown(BTN_FLAGS.B))  return 1.0;
  if (input.isDown(BTN_FLAGS.LT)) return 1.0;
  return 0;
}

function _speedToRPM(speed, gearRatio) {
  const WheelCirc  = 2.01;   // 2π × 0.32m wheel radius
  const FinalDrive = 3.8;
  const raw = (speed / WheelCirc) * 60 * Math.abs(gearRatio) * FinalDrive;
  return raw < RPM_IDLE ? RPM_IDLE : raw > RPM_REDLINE ? RPM_REDLINE : raw;
}

function _shiftUp(car)   { if (car.gear < GEAR_COUNT)   car.gear++; }
function _shiftDown(car) { if (car.gear > GEAR_REVERSE) car.gear--; }

function _autoShift(car) {
  if (car.rpm > RPM_SHIFT_UP   && car.gear < GEAR_COUNT)  car.gear++;
  else if (car.rpm < RPM_SHIFT_DOWN && car.gear > 1)      car.gear--;
}
