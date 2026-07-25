/**
 * physics.js — Player movement system (Spec Section VI)
 *
 *   Momentum preserved across states.
 *   Air control < ground control.
 *   State modifies LUT-driven physics.
 *
 * Receives: player object, ctx { axisX, axisY, movementMode, jumpMode, dt },
 *           and the world (for collision against floating islands).
 *
 * FIXED-POINT NOTES
 * -----------------
 *   Gravity, damping, and speed-cap arithmetic use 8.8 fixed point (×256)
 *   so that all per-frame accumulation uses integer shifts instead of floats.
 *   Player position/velocity are still stored as ordinary JS numbers (float64)
 *   but every in-loop multiply is replaced with integer >> 8.
 *
 *   Damping encode: damp256 = round(damp * 256)
 *     vx *= damp   →   vx = (vx * damp256 + 128) >> 8
 *   Gravity encode: grav256 = round(grav * 256)
 *     vy -= grav   →   vy -= grav256 / 256   (one division, outside frame loop)
 *
 *   In practice JS engines will JIT these to native integer ops.
 */
import { PHYSICS_LUT, MOVE, JUMPM, sinDeg, cosDeg } from "./luts.js";
import { STATE } from "./state.js";

// ---- Physics constants (all in world units per frame) ---------------------
const JUMP_IMPULSE        = 0.26;
const DOUBLE_JUMP_IMPULSE = 0.22;

// Gravity variants — stored as integers (×65536 = 16.16 fixed point)
// Actual value: fp >> 16
const _FP = 65536;
const RISE_GRAVITY_FP       = (0.008 * _FP + 0.5) | 0;   // 524
const NORMAL_GRAVITY_AIR_FP = (0.030 * _FP + 0.5) | 0;   // 1966

// Turn rates in degrees/frame
const TURN_RATE_GROUND = 3.6;
const TURN_RATE_AIR    = 2.2;

// Per-mode damping pre-baked as 16.16 fixed-point integers
// damp_fp = round(damp * 65536)
const _groundDamp256 = new Int32Array(5);
const _airDamp256    = new Int32Array(5);
const _accel         = new Float32Array(5);
const _maxSpeed      = new Float32Array(5);
const _maxFall       = new Float32Array(5);
const _gravFP        = new Int32Array(5);
const _vClamp        = new Float32Array(5).fill(Infinity);

(function bakePhysicsLUT() {
  for (let i = 0; i < PHYSICS_LUT.length; i++) {
    const p = PHYSICS_LUT[i];
    _groundDamp256[i] = (p.groundDamp * 65536 + 0.5) | 0;
    _airDamp256[i]    = (p.airDamp    * 65536 + 0.5) | 0;
    _accel[i]         = p.accel;
    _maxSpeed[i]      = p.maxSpeed;
    _maxFall[i]       = p.maxFall;
    _gravFP[i]        = (p.gravity * _FP + 0.5) | 0;
    _vClamp[i]        = p.vClamp != null ? p.vClamp : -Infinity;
  }
})();

export function stepPhysics(player, world, ctx) {
  const { axisX, axisY, movementMode, jumpMode } = ctx;
  const mi = movementMode | 0; // mode index (integer)

  if (player.state & STATE.FROZEN) return;

  if (player.state & STATE.DEAD) {
    // Dead: apply gravity only, clamp fall speed, integrate position
    player.vy -= _gravFP[mi] / _FP;
    const mf = _maxFall[mi];
    if (player.vy < -mf) player.vy = -mf;
    player.x += player.vx;
    player.y += player.vy;
    player.z += player.vz;
    if (player.y < -20) player.y = -20;
    return;
  }

  // ---- Turn ----------------------------------------------------------------
  const turnRate = (jumpMode === JUMPM.GROUNDED) ? TURN_RATE_GROUND : TURN_RATE_AIR;
  player.yaw += axisX * turnRate;
  if (player.yaw < 0)    player.yaw += 360;
  if (player.yaw >= 360) player.yaw -= 360;

  // ---- Acceleration along player.yaw ----------------------------------------
  const inputForward = -axisY;
  const fx = sinDeg(player.yaw);
  const fz = cosDeg(player.yaw);
  const accel = _accel[mi];
  player.vx += fx * inputForward * accel;
  player.vz += fz * inputForward * accel;

  // Cap horizontal speed
  const maxSpeed = _maxSpeed[mi];
  if (maxSpeed > 0) {
    const horizSp2 = player.vx * player.vx + player.vz * player.vz;
    const maxSp2   = maxSpeed * maxSpeed;
    if (horizSp2 > maxSp2) {
      // k = maxSpeed / sqrt(horizSp2) via inverse sqrt approx
      // For safety use the exact division (one sqrt per frame max)
      const k = maxSpeed / Math.sqrt(horizSp2);
      player.vx *= k;
      player.vz *= k;
    }
  }

  // ---- Damping — 16.16 fixed-point multiply then >> 16 --------------------
  // vx *= damp   →   vx = vx * damp_fp >> 16
  const dampFP = (jumpMode === JUMPM.GROUNDED) ? _groundDamp256[mi] : _airDamp256[mi];
  player.vx = (player.vx * dampFP) / _FP;
  player.vz = (player.vz * dampFP) / _FP;

  // HIT extra damping (plain multiply — rare code path)
  if (player.state & STATE.HIT) {
    player.vx *= 0.92;
    player.vz *= 0.92;
  }

  // ---- Gravity — 16.16 fixed-point ----------------------------------------
  const isGliding = (player.state & STATE.GLIDE) !== 0;
  let gravFP;
  if (isGliding) {
    gravFP = _gravFP[mi]; // GLIDE row already encodes 0.008
  } else if (!player.grounded && player.vy > 0) {
    gravFP = RISE_GRAVITY_FP;  // floaty ascent for all jumps
  } else {
    gravFP = NORMAL_GRAVITY_AIR_FP;
  }
  player.vy -= gravFP / _FP;

  const mf = _maxFall[mi];
  if (player.vy < -mf) player.vy = -mf;
  const vc = _vClamp[mi];
  if (player.vy < vc) player.vy = vc;

  // ---- Jump impulse (one-shot trigger) -------------------------------------
  if (player._wantJump) {
    player._wantJump = false;
    if (player.jumpTokens === 1 && (player.state & STATE.DOUBLE_JUMP)) {
      player.vy = DOUBLE_JUMP_IMPULSE;
      player.jumpTokens = 0;
    } else if (player.jumpTokens === 2 && (player.state & STATE.JUMP)) {
      player.vy = JUMP_IMPULSE;
      player.jumpTokens = 1;
    }
  }

  // ---- Integrate position and resolve platform collision -------------------
  const radius = 0.35;
  const halfH  = 0.5;

  player.x += player.vx;
  player.z += player.vz;
  player.y += player.vy;

  const wasGrounded = player.grounded;
  player.grounded = false;

  // Single AABB collision test — mutates player in place.
  function testAABB(px, py, pz, bsx, bsy_half, bsz, topY) {
    const blockTop    = topY;
    const blockBottom = topY - bsy_half * 2;

    const dx = player.x - px;
    const dz = player.z - pz;
    const overlapX = bsx + radius - (dx < 0 ? -dx : dx);
    const overlapZ = bsz + radius - (dz < 0 ? -dz : dz);

    if (overlapX <= 0 || overlapZ <= 0) return false;

    const playerBottom = player.y - halfH;
    const playerTop    = player.y + halfH;

    if (playerTop <= blockBottom || playerBottom >= blockTop) return false;

    // Top landing
    if (
      playerBottom <= blockTop + 0.05 &&
      playerBottom >= blockBottom &&
      player.vy <= 0
    ) {
      player.y = blockTop + halfH;
      player.vy = 0;
      player.grounded = true;
      return true;
    }

    // Side push-out (only when clearly inside the vertical volume)
    if (playerBottom < blockTop - 0.05 && playerTop > blockBottom + 0.05) {
      if (overlapX < overlapZ) {
        player.x += dx > 0 ? overlapX : -overlapX;
        player.vx = 0;
      } else {
        player.z += dz > 0 ? overlapZ : -overlapZ;
        player.vz = 0;
      }
    }
    return false;
  }

  for (const p of world.platforms) {
    if (p.glbModel) {
      // ── GLB face collision ──────────────────────────────────────────────
      // First do a cheap AABB broad-phase using the island's halfW/halfD/topY.
      const wx = p.glbWorldX ?? p.x;
      const wy = p.glbWorldY ?? (p.y - p.sy);
      const wz = p.glbWorldZ ?? p.z;
      const halfW = p.sx;
      const halfD = p.sz;
      const scaleMul = p.glbScaleMul ?? 1.0;
      const aabbTop = wy + p.glbModel.topY * scaleMul;
      const aabbBot = wy - p.glbModel.topY * scaleMul * 2;

      const dxAabb = player.x - wx;
      const dzAabb = player.z - wz;
      if (Math.abs(dxAabb) > halfW + radius * 2 ||
          Math.abs(dzAabb) > halfD + radius * 2) continue;
      if (player.y + halfH < aabbBot || player.y - halfH > aabbTop + 2) continue;

      // Narrow-phase: test each triangle face
      const faces = p.glbModel.faces;
      const faceCount = p.glbModel.faceCount;

      for (let fi = 0; fi < faceCount; fi++) {
        const base = fi * 9;
        // Triangle vertices in world space (faces are pre-baked at model.scale;
        // multiply by scaleMul to match any 2× portal island override)
        const ax = faces[base]     * scaleMul + wx, ay = faces[base + 1] * scaleMul + wy, az = faces[base + 2] * scaleMul + wz;
        const bx = faces[base + 3] * scaleMul + wx, by = faces[base + 4] * scaleMul + wy, bz = faces[base + 5] * scaleMul + wz;
        const cx = faces[base + 6] * scaleMul + wx, cy = faces[base + 7] * scaleMul + wy, cz = faces[base + 8] * scaleMul + wz;

        // Compute face normal (unnormalised for culling)
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;

        // Only collide with upward-facing surfaces (ny > 0) or nearly-vertical walls
        // For landing on top: require ny > 0.3 (tilted faces count too)
        const nLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (nLen < 0.0001) continue;
        const nny = ny / nLen;

        if (nny > 0.25) {
          // Landing surface — find approximate Y of the triangle at (player.x, player.z)
          // using barycentric interpolation on XZ plane.
          // Project player XZ onto triangle XZ using barycentric coords.
          const px2 = player.x - ax, pz2 = player.z - az;
          const d1x = bx - ax, d1z = bz - az;
          const d2x = cx - ax, d2z = cz - az;
          const denom = d1x * d2z - d1z * d2x;
          if (Math.abs(denom) < 0.0001) continue;
          const u = (px2 * d2z - pz2 * d2x) / denom;
          const v = (d1x * pz2 - d1z * px2) / denom;
          // Tight tolerance — no sliding off edge: allow only a tiny epsilon outward
          if (u < -0.005 || v < -0.005 || u + v > 1.005) continue;

          // Interpolated Y on the face at player XZ
          const faceY = ay + u * (by - ay) + v * (cy - ay);
          const playerFeet = player.y - halfH;

          if (player.vy <= 0 &&
              playerFeet <= faceY + 0.15 &&
              playerFeet >= faceY - 0.8) {
            player.y  = faceY + halfH;
            player.vy = 0;
            player.grounded = true;
          }
        } else if (Math.abs(nny) < 0.65) {
          // Vertical / near-vertical wall — push player out
          // Use the face plane equation for accurate distance from the actual face
          const nnx = nx / nLen, nny2 = ny / nLen, nnz = nz / nLen;
          // Signed distance from player centre to the face plane
          const dist = (player.x - ax) * nnx + (player.y - ay) * nny2 + (player.z - az) * nnz;

          // Only push if player is penetrating from the front side and close enough
          if (dist > -0.05 && dist < radius + 0.1) {
            // Only push out if player body overlaps the vertical span of this face
            const minFaceY = Math.min(ay, by, cy) - 0.05;
            const maxFaceY = Math.max(ay, by, cy) + 0.05;
            if (player.y + halfH > minFaceY && player.y - halfH < maxFaceY) {
              // Also check the player is horizontally near the triangle (XZ proximity)
              const px2 = player.x - ax, pz2 = player.z - az;
              const d1x = bx - ax, d1z = bz - az;
              const d2x = cx - ax, d2z = cz - az;
              const denom = d1x * d2z - d1z * d2x;
              if (Math.abs(denom) > 0.0001) {
                const u = (px2 * d2z - pz2 * d2x) / denom;
                const v = (d1x * pz2 - d1z * px2) / denom;
                // Allow a slightly wider tolerance for walls so we don't clip through
                if (u >= -0.15 && v >= -0.15 && u + v <= 1.15) {
                  const push = radius + 0.1 - dist;
                  player.x += nnx * push;
                  player.z += nnz * push;
                  if (Math.abs(nnx) > Math.abs(nnz)) player.vx = 0;
                  else player.vz = 0;
                }
              }
            }
          }
        }
      }
    } else if (p.blocks && p.blocks.length > 1) {
      for (const b of p.blocks) {
        if (b._axisNX !== undefined) continue;
        const bTopY = b.wy + b.sy;
        testAABB(b.wx, b.wy, b.wz, b.sx, b.sy, b.sz, bTopY);
      }
    } else {
      const blockHeight = p.sy != null ? p.sy * 2 : 1.2;
      testAABB(p.x, p.y - blockHeight * 0.5, p.z, p.sx, blockHeight * 0.5, p.sz, p.y);
    }
  }

  // Restore full jump tokens on landing.
  if (player.grounded && !wasGrounded) {
    player.jumpTokens = 2;
  }

  // Death plane
  if (player.y < -20) {
    player.state |= STATE.DEAD;
  }
}
