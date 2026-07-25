/**
 * carstate.js — Bitwise + Discrete car state resolution
 *
 * Mirrors the architecture of the platformer's state.js but for a racing car:
 *
 *   inputMask + vehicleContext → CAR_STATE (bitwise) → driveMode (discrete)
 *
 * Priority rules (highest → lowest):
 *   STATE_WRECKED   overrides everything (car is flipping/on fire)
 *   STATE_AIRBORNE  while car is off the ground
 *   STATE_DRIFT     handbrake held + speed above drift threshold
 *   STATE_BRAKING   brake input held
 *   STATE_FAST      speed > FAST_THRESHOLD fraction of top speed
 *   STATE_DRIVING   any forward throttle + speed > 0
 *   (default)       PARKED
 *
 * Gear state is NOT stored here — it lives in carphysics.js as a plain number.
 * This module is purely for state-flag bookkeeping + DRIVE mode derivation.
 */

import { BTN_FLAGS } from "./input.js";
import { DRIVE, CAR_TOP_SPEED } from "./luts.js";

// ---- Bitwise flags ----------------------------------------------------------
export const CAR_STATE = {
  NONE:     0b00000000,
  DRIVING:  0b00000001,  // throttle applied + speed > 0
  BRAKING:  0b00000010,  // brake pedal depressed
  DRIFT:    0b00000100,  // handbrake / oversteer slide active
  FAST:     0b00001000,  // speed > FAST_THRESHOLD
  AIRBORNE: 0b00010000,  // wheels off ground
  OFFTRACK: 0b00100000,  // on gravel or grass surface
  WRECKED:  0b01000000,  // collision / respawn countdown
};

// Speed threshold (fraction of top speed) above which FAST flag is set.
// At this fraction the camera zooms back and FOV widens.
const FAST_THRESHOLD = 0.65;

/**
 * resolveBitwise — update car state flags from inputs + vehicle context.
 *
 * @param {number} prev        — previous CAR_STATE bitmask
 * @param {object} ctx         — {
 *   input,       InputController
 *   speed,       current forward speed (m/s, always positive)
 *   grounded,    boolean — all wheels on surface
 *   surface,     SURFACE.* constant for current track segment
 *   topSpeed,    optional override (defaults to CAR_TOP_SPEED)
 * }
 * @returns {number} updated CAR_STATE bitmask
 */
export function resolveBitwise(prev, ctx) {
  const {
    input,
    speed,
    grounded,
    surface,
  } = ctx;
  const topSpeed = ctx.topSpeed ?? CAR_TOP_SPEED;

  let s = prev;

  // WRECKED locks all state until an external respawn clears it.
  if (s & CAR_STATE.WRECKED) return s;

  // ---- Driving / braking -----------------------------------------------
  const throttle = input.isDown(BTN_FLAGS.A) || input.isDown(BTN_FLAGS.RT);
  const brake    = input.isDown(BTN_FLAGS.B) || input.isDown(BTN_FLAGS.LT);

  if (throttle && speed >= 0) s |=  CAR_STATE.DRIVING;
  else                         s &= ~CAR_STATE.DRIVING;

  if (brake) s |=  CAR_STATE.BRAKING;
  else       s &= ~CAR_STATE.BRAKING;

  // ---- Drift -----------------------------------------------------------
  // Drift requires: handbrake held AND speed above a minimum threshold
  // AND the car is on the ground.  Gravel/grass lowers the threshold so
  // the car slides more easily on low-grip surfaces.
  const handbrake    = input.isDown(BTN_FLAGS.X);
  const driftMinSpeed = 4.0; // m/s — below this, handbrake just stops the car
  if (handbrake && speed > driftMinSpeed && grounded) {
    s |=  CAR_STATE.DRIFT;
  } else if (!handbrake) {
    s &= ~CAR_STATE.DRIFT;
  }

  // ---- FAST ------------------------------------------------------------
  if (speed > topSpeed * FAST_THRESHOLD) s |=  CAR_STATE.FAST;
  else                                    s &= ~CAR_STATE.FAST;

  // ---- AIRBORNE --------------------------------------------------------
  if (!grounded) s |=  CAR_STATE.AIRBORNE;
  else           s &= ~CAR_STATE.AIRBORNE;

  // ---- OFFTRACK --------------------------------------------------------
  // Imported as a numeric constant — SURFACE 1 (gravel) or 2 (grass).
  if (surface === 1 || surface === 2) s |=  CAR_STATE.OFFTRACK;
  else                                 s &= ~CAR_STATE.OFFTRACK;

  return s;
}

/**
 * resolveDiscrete — derive the DRIVE mode integer from bitwise state.
 * Used as an index into CAMERA_OFFSET_LUT, CAMERA_LAG_LUT, etc.
 *
 * @param {number} carState — CAR_STATE bitmask
 * @returns {number}        — DRIVE.* constant
 */
export function resolveDiscrete(carState) {
  if (carState & CAR_STATE.WRECKED)  return DRIVE.PARKED;
  if (carState & CAR_STATE.AIRBORNE) return DRIVE.AIRBORNE;
  if (carState & CAR_STATE.DRIFT)    return DRIVE.DRIFT;
  if (carState & CAR_STATE.FAST)     return DRIVE.FAST;
  if (carState & CAR_STATE.DRIVING)  return DRIVE.DRIVING;
  return DRIVE.PARKED;
}
