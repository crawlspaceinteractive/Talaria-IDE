/**
 * portal.js — Portal / Transition system (Spec Section X)
 *
 *   No alpha blending. LUT-driven warp distortion.
 *   Trigger: distance(player, portal) < 1.0
 *   Transition: save state → unload world → load world →
 *               apply WARP_OFFSET_LUT animation → resume gameplay
 */
import { WARP_OFFSET_LUT, COLOR_COLLAPSE_LUT } from "../engine/luts.js";

export function createTransition() {
  return {
    active: false,
    frame: 0,
    duration: WARP_OFFSET_LUT.length,
    phase: "out", // "out" | "in"
    pendingTarget: null,
    onMid: null,
  };
}

export function tryPortal(transition, player, portal) {
  if (transition.active) return false;
  const dx = player.x - portal.x;
  const dy = player.y - portal.y;
  const dz = player.z - portal.z;
  if (dx * dx + dy * dy + dz * dz < portal.radius * portal.radius) {
    transition.active = true;
    transition.phase = "out";
    transition.frame = 0;
    transition.pendingTarget = { ...portal.target };
    return true;
  }
  return false;
}

/**
 * Returns true while transition consumes the frame (game logic should pause).
 * The renderer reads transition.frame to apply warp distortion.
 */
export function stepTransition(transition, player) {
  if (!transition.active) return false;
  transition.frame++;
  if (transition.phase === "out" && transition.frame >= transition.duration) {
    // Midpoint: teleport
    if (transition.pendingTarget) {
      player.x = transition.pendingTarget.x;
      player.y = transition.pendingTarget.y + 1.0;
      player.z = transition.pendingTarget.z;
      player.vx = 0; player.vy = 0; player.vz = 0;
    }
    if (transition.onMid) transition.onMid();
    transition.phase = "in";
    transition.frame = 0;
  } else if (transition.phase === "in" && transition.frame >= transition.duration) {
    transition.active = false;
    transition.frame = 0;
    transition.pendingTarget = null;
  }
  return true;
}

export function transitionWarpAmount(transition) {
  if (!transition.active) return { warp: 0, fade: 0 };
  let f = transition.frame;
  if (f >= WARP_OFFSET_LUT.length) f = WARP_OFFSET_LUT.length - 1;
  const warp = WARP_OFFSET_LUT[f];
  const fade = COLOR_COLLAPSE_LUT[f];
  // Phase 'in' inverts so we collapse OUT then expand IN
  return { warp, fade };
}
