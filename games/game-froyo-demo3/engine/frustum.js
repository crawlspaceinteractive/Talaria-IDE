/**
 * frustum.js — Wide-angle view frustum culling (Froyo Engine)
 *
 * Builds 5 half-space planes (near + 4 side) in world space from the camera
 * each frame. Objects are tested via a conservative sphere-vs-frustum check
 * before any geometry is built.
 *
 * WIDE ANGLE POLICY
 * -----------------
 * The visual FOV is ~100° horizontal / ~80° vertical. The cull frustum is set
 * deliberately WIDER (HFOV_CULL = 120°, VFOV_CULL = 100°) plus a generous
 * sphere-radius slack, so we never clip something the rasterizer would draw.
 * This is a broad-phase accelerator, not a pixel-perfect clip.
 *
 * PLANE CONVENTION
 * ----------------
 * Each plane is stored as { nx, ny, nz, d } where the "inside" half-space is:
 *   nx*x + ny*y + nz*z + d >= 0
 * (normal points INTO the frustum).
 *
 * USAGE
 * -----
 *   import { updateFrustum, sphereInFrustum } from "./frustum.js";
 *
 *   // Once per frame, after camera has been updated:
 *   updateFrustum(camera);
 *
 *   // Before building geometry for each object:
 *   if (!sphereInFrustum(cx, cy, cz, radius)) continue;
 */

import { sinDeg, cosDeg } from "./luts.js";

// Culling FOV half-angles in degrees (wider than visual to be conservative).
const HFOV_HALF = 85;   // horizontal half-angle (visual is ~50°) — 130° total
const VFOV_HALF = 75;   // vertical half-angle   (visual is ~40°) — 110° total

// Near-plane distance (same as renderer NEAR_Z).
const NEAR_Z = 0.08;

// Far-plane distance — anything beyond FOG_FAR is invisible anyway.
const FAR_Z = 250.0;

// 5 planes: near, far, left, right, top, bottom — 6 total.
// Stored as plain objects; updated in-place each frame.
const _planes = [
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 0: near
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 1: far
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 2: left
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 3: right
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 4: top
  { nx: 0, ny: 0, nz: 0, d: 0 }, // 5: bottom
];

/**
 * updateFrustum — rebuild the 6 world-space frustum planes.
 * Call once per frame after camera position/yaw/pitch have been updated.
 *
 * @param {object} camera  — { x, y, z, yaw (deg), pitch (deg), fovMul }
 */
export function updateFrustum(camera) {
  const yaw   = camera.yaw   || 0;
  const pitch = camera.pitch || 0;
  const cx = camera.x, cy = camera.y, cz = camera.z;

  // Camera forward vector (world space), applying yaw then pitch.
  // Forward = +Z in camera local space → rotated by yaw around Y then pitch around X.
  const cosYaw   = cosDeg(yaw   | 0);
  const sinYaw   = sinDeg(yaw   | 0);
  const cosPitch = cosDeg(pitch | 0);
  const sinPitch = sinDeg(pitch | 0);

  // Local-to-world rotation:
  //   forward_local = (0, 0, 1)
  //   After yaw:   fx = sinYaw, fy = 0,        fz = cosYaw
  //   After pitch: fx = sinYaw, fy = sinPitch*cosYaw, fz = cosPitch*cosYaw
  // (Froyo uses Y-up, yaw rotates around Y, pitch rotates around camera-local X.)
  const fwdX =  sinYaw * cosPitch;
  const fwdY =  sinPitch;
  const fwdZ =  cosYaw * cosPitch;

  // Camera up vector after pitch (local up = (0,1,0) rotated by pitch around X):
  //   upY = cosPitch, upZ = -sinPitch … but in world frame with yaw:
  const upX = -sinYaw * sinPitch;
  const upY =  cosPitch;
  const upZ = -cosYaw * sinPitch;

  // Camera right vector = cross(up, forward) (already normalised since forward⊥up)
  // right = up × fwd  (gives the true camera-right, i.e. +X in screen space)
  const rtX = upY * fwdZ - upZ * fwdY;
  const rtY = upZ * fwdX - upX * fwdZ;
  const rtZ = upX * fwdY - upY * fwdX;

  // ---- Near plane (normal = forward, passes through cam + fwd*NEAR_Z) ----
  {
    const p = _planes[0];
    p.nx = fwdX; p.ny = fwdY; p.nz = fwdZ;
    p.d  = -(fwdX * (cx + fwdX * NEAR_Z)
           + fwdY * (cy + fwdY * NEAR_Z)
           + fwdZ * (cz + fwdZ * NEAR_Z));
  }

  // ---- Far plane (normal = -forward, passes through cam + fwd*FAR_Z) -----
  {
    const p = _planes[1];
    p.nx = -fwdX; p.ny = -fwdY; p.nz = -fwdZ;
    // d = -(n · point) = -(-fwd · (cam + fwd*FAR_Z)) = fwd · (cam + fwd*FAR_Z)
    p.d  = fwdX * (cx + fwdX * FAR_Z)
         + fwdY * (cy + fwdY * FAR_Z)
         + fwdZ * (cz + fwdZ * FAR_Z);
  }

  // ---- Side planes — built by rotating the forward vector by ±half-angle --
  // Each side plane passes through the camera origin; its normal is perpendicular
  // to the frustum edge, pointing inward.
  //
  // For the LEFT plane: rotate fwd by -HFOV_HALF around the up axis (Y).
  // Normal = rotated_fwd × up  (inward = pointing right)
  // Equivalently: the plane normal is perpendicular to the left-edge direction,
  // oriented inward. We compute it as: rotate the right-vector back by HFOV_HALF.
  //
  // Simpler formulation used here:
  //   left-edge direction  = fwd rotated -HFOV_HALF around up
  //   left plane normal    = left-edge × up  (so normal points inward/right)
  //   The plane passes through the camera origin → d = -dot(n, camPos)

  const sinH = Math.sin(HFOV_HALF * Math.PI / 180);
  const cosH = Math.cos(HFOV_HALF * Math.PI / 180);
  const sinV = Math.sin(VFOV_HALF * Math.PI / 180);
  const cosV = Math.cos(VFOV_HALF * Math.PI / 180);

  // Left edge direction: fwd rotated -HFOV_HALF around world-Y (approximate —
  // uses the true yaw-aligned up). We rotate around the camera's up vector for
  // correctness when pitched.
  //
  // Rodrigues formula: rot(v, axis, θ) = v*cos + cross(axis,v)*sin + axis*(axis·v)*(1-cos)
  // axis = (upX, upY, upZ), v = (fwdX, fwdY, fwdZ), θ = -HFOV_HALF
  function rotAround(vx, vy, vz, ax, ay, az, sinA, cosA) {
    // dot(axis, v)
    const dv = ax*vx + ay*vy + az*vz;
    // cross(axis, v)
    const crx = ay*vz - az*vy;
    const cry = az*vx - ax*vz;
    const crz = ax*vy - ay*vx;
    return {
      x: vx*cosA + crx*sinA + ax*dv*(1 - cosA),
      y: vy*cosA + cry*sinA + ay*dv*(1 - cosA),
      z: vz*cosA + crz*sinA + az*dv*(1 - cosA),
    };
  }

  // LEFT plane: fwd rotated -HFOV_HALF around up-axis
  {
    const edge = rotAround(fwdX, fwdY, fwdZ, upX, upY, upZ, -sinH, cosH);
    // plane normal = edge × up  → points inward (rightward)
    const nx = edge.y * upZ - edge.z * upY;
    const ny = edge.z * upX - edge.x * upZ;
    const nz = edge.x * upY - edge.y * upX;
    const p = _planes[2];
    p.nx = nx; p.ny = ny; p.nz = nz;
    p.d  = -(nx * cx + ny * cy + nz * cz);
  }

  // RIGHT plane: fwd rotated +HFOV_HALF around up-axis
  {
    const edge = rotAround(fwdX, fwdY, fwdZ, upX, upY, upZ, sinH, cosH);
    // plane normal = up × edge  → points inward (leftward)
    const nx = upY * edge.z - upZ * edge.y;
    const ny = upZ * edge.x - upX * edge.z;
    const nz = upX * edge.y - upY * edge.x;
    const p = _planes[3];
    p.nx = nx; p.ny = ny; p.nz = nz;
    p.d  = -(nx * cx + ny * cy + nz * cz);
  }

  // BOTTOM plane: fwd rotated -VFOV_HALF around right-axis
  {
    const edge = rotAround(fwdX, fwdY, fwdZ, rtX, rtY, rtZ, -sinV, cosV);
    // plane normal = right × edge  → points inward (upward)
    const nx = rtY * edge.z - rtZ * edge.y;
    const ny = rtZ * edge.x - rtX * edge.z;
    const nz = rtX * edge.y - rtY * edge.x;
    const p = _planes[4];
    p.nx = nx; p.ny = ny; p.nz = nz;
    p.d  = -(nx * cx + ny * cy + nz * cz);
  }

  // TOP plane: fwd rotated +VFOV_HALF around right-axis
  {
    const edge = rotAround(fwdX, fwdY, fwdZ, rtX, rtY, rtZ, sinV, cosV);
    // plane normal = edge × right  → points inward (downward)
    const nx = edge.y * rtZ - edge.z * rtY;
    const ny = edge.z * rtX - edge.x * rtZ;
    const nz = edge.x * rtY - edge.y * rtX;
    const p = _planes[5];
    p.nx = nx; p.ny = ny; p.nz = nz;
    p.d  = -(nx * cx + ny * cy + nz * cz);
  }
}

/**
 * sphereInFrustum — conservative sphere-vs-frustum test.
 *
 * Returns false only when the sphere is ENTIRELY outside one of the planes
 * (signed distance < -radius). Returns true otherwise (including any doubt).
 *
 * @param {number} x, y, z   — sphere center world position
 * @param {number} r          — bounding radius
 * @returns {boolean}
 */
export function sphereInFrustum(x, y, z, r) {
  for (let i = 0; i < 6; i++) {
    const p = _planes[i];
    if (p.nx * x + p.ny * y + p.nz * z + p.d < -r) return false;
  }
  return true;
}
