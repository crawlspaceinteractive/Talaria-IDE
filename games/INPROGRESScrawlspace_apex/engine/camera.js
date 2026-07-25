/**
 * camera.js — State-driven third-person camera (Spec Section IX)
 *
 *   camera_position = player_position - forward * CAMERA_OFFSET_LUT[movementMode]
 *   smoothed by CAMERA_LAG_LUT[movementMode]
 *
 *   This module also owns:
 *     - per-mode FOV multiplier (CAMERA_FOV_LUT) → smooth `camera.fovMul`
 *     - auto-pitch (aim slightly above the player) → exposed as `camera.autoPitch`
 *     - the caller (game.js) composes `targetPitch = autoPitch + lookPitch` so
 *       a manual right-stick/mouse pitch override can layer on top of the
 *       auto-aim, decaying back to auto when the player releases the stick.
 *
 *   Look-at ray (NEW):
 *     castLookRay() fires a ray from the player muzzle along player.yaw.
 *     It steps forward until it hits a platform AABB or reaches RAY_MAX_DIST.
 *     That hit point becomes camera.lookAt{X,Y,Z}, which is smoothed each frame.
 *     autoPitch is then derived from the camera position → lookAt vector instead
 *     of pointing at the player body directly. Result: the camera looks *ahead*
 *     of Froyo, not just at her feet.
 */
import {
  CAMERA_OFFSET_LUT, CAMERA_LAG_LUT, CAMERA_FOV_LUT,
  sinDeg, cosDeg,
} from "./luts.js";

// Identity passthrough — values are stored as plain floats.
function fpf(v) { return v; }

// Ray march settings (scaled to larger world)
const RAY_MAX_DIST  = 100;  // world units before we settle on the end point
const RAY_STEP      = 1.5;  // step size per iteration
const RAY_MUZZLE_UP = 0.05; // vertical offset from player center for ray origin

export function createCamera() {
  return {
    x: 0, y: 1, z: -1,
    yaw: 0,          // degrees, 0 = looking +Z
    pitch: 0,        // degrees, 0 = horizontal, positive = look up
    fovMul: 1.0,     // 1.0 = base FOV, smoothed toward CAMERA_FOV_LUT[mode]
    targetX: 0, targetY: 1, targetZ: -8,
    targetYaw: 0,
    targetPitch: 0,
    targetFovMul: 1.0,
    autoPitch: 0,    // pitch derived from camera → lookAt (read-only)
    lookPitch: 0,    // manual offset added by right-stick (sticky w/ decay)

    // Smooth look-at point (world space). Initialised at player position.
    lookAtX: 0, lookAtY: 0, lookAtZ: 0,
    // Instantaneous target computed by castLookRay each frame.
    lookAtTargetX: 0, lookAtTargetY: 0, lookAtTargetZ: 0,
  };
}

/**
 * castLookRay — march a ray from the player's muzzle along player.yaw.
 * Returns the first hit point (platform AABB top) or the ray endpoint.
 * Stored into camera.lookAtTarget{X,Y,Z} for the caller to smooth toward.
 *
 * @param {object} camera
 * @param {object} player   — needs .x .y .z .yaw
 * @param {Array}  platforms — world.platforms
 */
export function castLookRay(camera, player, platforms) {
  // Player position is FP; convert to float for camera/ray math.
  // Yaw is stored in FP degrees (FP_ONE = 1°); convert to plain degrees.
  const yaw = fpf(player.yaw);   // plain degrees (0–360 float)
  const dx = sinDeg(yaw | 0);
  const dz = cosDeg(yaw | 0);

  const px = fpf(player.x), py = fpf(player.y), pz = fpf(player.z);
  const ox = px + dx * 0.20;  // muzzle start, slightly ahead
  const oy = py + RAY_MUZZLE_UP;
  const oz = pz + dz * 0.20;

  let t = 0;
  let hitX = ox + dx * RAY_MAX_DIST;
  let hitY = oy;
  let hitZ = oz + dz * RAY_MAX_DIST;

  while (t < RAY_MAX_DIST) {
    t += RAY_STEP;
    const px = ox + dx * t;
    const pz = oz + dz * t;

    for (const p of platforms) {
      // Platform coords are FP — convert for comparison.
      const pfx = fpf(p.x), pfz = fpf(p.z);
      const sfx = fpf(p.sx), sfz = fpf(p.sz);
      const pfy = fpf(p.y);
      if (
        Math.abs(px - pfx) <= sfx + 0.1 &&
        Math.abs(pz - pfz) <= sfz + 0.1
      ) {
        hitX = px;
        hitY = pfy + 0.5;
        hitZ = pz;
        t = RAY_MAX_DIST;
        break;
      }
    }
  }

  camera.lookAtTargetX = hitX;
  camera.lookAtTargetY = hitY;
  camera.lookAtTargetZ = hitZ;
}

export function updateCamera(camera, player, movementMode, dtScale = 1) {
  const off = CAMERA_OFFSET_LUT[movementMode];
  const yaw = camera.targetYaw;
  const fx = sinDeg(yaw), fz = cosDeg(yaw);

  // Player position is FP — convert to float for camera math.
  const pxf = fpf(player.x), pyf = fpf(player.y), pzf = fpf(player.z);

  // Camera looks along yaw; position is behind the player along that vector.
  camera.targetX = pxf - fx * off.back;
  camera.targetZ = pzf - fz * off.back;
  camera.targetY = pyf + off.up;

  // FOV multiplier per mode.
  camera.targetFovMul = CAMERA_FOV_LUT[movementMode];

  // Smooth the look-at point toward its target on a relaxed lag (so it
  // doesn't whip around instantly when the player turns sharply).
  const lookLag = 0.10 * dtScale;
  camera.lookAtX += (camera.lookAtTargetX - camera.lookAtX) * lookLag;
  camera.lookAtY += (camera.lookAtTargetY - camera.lookAtY) * lookLag;
  camera.lookAtZ += (camera.lookAtTargetZ - camera.lookAtZ) * lookLag;

  // Derive auto-pitch from camera position → smoothed look-at point.
  // Falls back to aiming at the player body if the look-at hasn't diverged yet.
  {
    const dxAim = camera.lookAtX - camera.targetX;
    const dyAim = camera.lookAtY - camera.targetY;
    const dzAim = camera.lookAtZ - camera.targetZ;
    const flat  = Math.sqrt(dxAim * dxAim + dzAim * dzAim) || 0.001;
    // Add 15° so the camera always aims ~15° above the horizon baseline.
    let desired = Math.atan(dyAim / flat) * 180 / Math.PI + 15;
    if (desired < -5)  desired = -5;
    if (desired > 35)  desired = 35;
    camera.autoPitch = desired;
  }

  const lag = CAMERA_LAG_LUT[movementMode];
  camera.x += (camera.targetX - camera.x) * lag * dtScale;
  camera.y += (camera.targetY - camera.y) * lag * dtScale;
  camera.z += (camera.targetZ - camera.z) * lag * dtScale;

  // FOV smooths a bit slower than position so zoom transitions feel deliberate.
  camera.fovMul += (camera.targetFovMul - camera.fovMul) * lag * 0.7 * dtScale;

  // Smooth yaw on the same lag curve.
  let dyaw = camera.targetYaw - camera.yaw;
  if (dyaw > 180) dyaw -= 360;
  if (dyaw < -180) dyaw += 360;
  camera.yaw += dyaw * lag * dtScale;
  if (camera.yaw < 0) camera.yaw += 360;
  if (camera.yaw >= 360) camera.yaw -= 360;

  // Pitch eases on a softer curve so vertical drama doesn't feel jarring.
  // NOTE: camera.targetPitch is set by game.js (autoPitch + lookPitch).
  camera.pitch += (camera.targetPitch - camera.pitch) * lag * 0.6 * dtScale;
}
