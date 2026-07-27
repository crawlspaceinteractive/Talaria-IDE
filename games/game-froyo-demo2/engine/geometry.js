/**
 * geometry.js — GLB loader + mesh-to-tris converter
 *
 * Three.js is used ONLY for parsing GLB files (player model).
 * ALL procedural world geometry (cubes, trapezoids, prisms, planks)
 * is handled by the pure-JS builders in renderer.js — no Three.js needed.
 *
 * Exports:
 *   threeReady()           — Promise; resolves when THREE + GLTFLoader available.
 *   isThreeReady()         — Synchronous; true once resolved.
 *   loadGLBMesh(url)       — Async. Parse a .glb → { vertices, normals, indices, colors }.
 *   buildMeshTris(...)     — GLB meshData → painter's-algo triangle records.
 *   extractMeshData()      — Low-level typed-array extractor from a BufferGeometry.
 *   syncThreeCamera(cam)   — No-op kept for API compatibility.
 *
 * Projection pipeline (v0.3):
 *   Uses the same engine-native toCameraSpace + projectCS math as renderer.js.
 *   Three.js is only used for loading/parsing the GLB file, NOT for projection.
 *   This guarantees the model renders exactly where the player sprite would be.
 */

// ─── Engine LUT imports (must be at top of module) ────────────────────────────
import { scaleAtX, scaleAtY, sinDeg, cosDeg } from "./luts.js";

// ─── Three.js CDN ──────────────────────────────────────────────────────────
// We use the ES-module build via an importmap-aware URL so bare specifiers
// ("three") resolve correctly.  The trick: load three.module.js first and
// stash it on window.THREE, then load the GLTFLoader addon which also uses
// the module build but resolves its own 'three' bare-specifier via the same
// CDN path.
//
// Strategy: use the esm.sh CDN which re-exports everything with proper
// relative paths — no bare specifiers, no importmap required.
const THREE_URL = "https://esm.sh/three@0.165.0";
const GLTF_URL  = "https://esm.sh/three@0.165.0/examples/jsm/loaders/GLTFLoader.js";

let _THREE      = null;
let _GLTFLoader = null;
let _readyProm  = null;
let _ready      = false;

// Internal Three.js camera — created once after THREE is loaded.
// Synced each frame via syncThreeCamera() before buildMeshTris is called.
let _threeCamera = null;
let _vec3        = null;   // reusable THREE.Vector3
let _mat4        = null;   // reusable THREE.Matrix4 for camera rebuild

// ─── Screen constants (must match renderer.js / luts.js) ─────────────────────
const SCREEN_W = 320;
const SCREEN_H = 200;
const HALF_W   = 160;
const HALF_H   = 100;

// Vertical FOV derived from focal length: FOV_y = 2*atan(HALF_H/FOCAL_Y)
// FOCAL_Y = 119 → FOV_y ≈ 80°.  Aspect = 320/200 = 1.6.
const CAM_FOV    = 80;          // degrees vertical
const CAM_ASPECT = SCREEN_W / SCREEN_H; // 1.6
const CAM_NEAR   = 0.4;
const CAM_FAR    = 1000.0;

// ─── Near-plane constant (must match renderer.js NEAR_Z) ─────────────────────
const NEAR_Z = 0.4;
const SCREEN_GUARD = 8192;

// ─── Directional light (matches renderer shading) ───────────────────────────
const LX = -0.4, LY = 0.8, LZ = -0.3;
const _lLen = Math.sqrt(LX*LX + LY*LY + LZ*LZ);
const LNX = LX/_lLen, LNY = LY/_lLen, LNZ = LZ/_lLen;


// Default island palette used when a game layer does not provide biome colors.
// Colors use the engine's packed RGBA form: 0xAABBGGRR.
const DEFAULT_ISLAND_PALETTE = {
  top:  0xff5b8d3a,
  side: 0xff5a3a2a,
};

function _validPackedColor(value, fallback) {
  return (typeof value === "number" && Number.isFinite(value)) ? (value >>> 0) : fallback;
}

function _resolveIslandPalette(palette) {
  return {
    top:  _validPackedColor(palette?.top,  DEFAULT_ISLAND_PALETTE.top),
    side: _validPackedColor(palette?.side, DEFAULT_ISLAND_PALETTE.side),
    biome: palette?.biome || "default",
    textureTop: palette?.textureTop || null,
    textureSide: palette?.textureSide || null,
    textureUnder: palette?.textureUnder || null,
    textureScale: (typeof palette?.textureScale === "number" && Number.isFinite(palette.textureScale)) ? palette.textureScale : 0.08,
  };
}

function zoneFromNormal(ny) {
  if (ny > 0.55) return "top";
  if (ny < -0.55) return "under";
  return "side";
}

function _setTerrainUVsForTri(cs0, cs1, cs2, wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2, nx, ny, nz, uvScale) {
  // PS1-style first pass: affine planar projection by surface orientation.
  // Top/under use XZ. Steep faces use the dominant horizontal axis plus Y.
  const any = Math.abs(ny);
  if (any > 0.55) {
    cs0.u = wx0 * uvScale; cs0.v = wz0 * uvScale;
    cs1.u = wx1 * uvScale; cs1.v = wz1 * uvScale;
    cs2.u = wx2 * uvScale; cs2.v = wz2 * uvScale;
    return;
  }

  if (Math.abs(nx) > Math.abs(nz)) {
    cs0.u = wz0 * uvScale; cs0.v = wy0 * uvScale;
    cs1.u = wz1 * uvScale; cs1.v = wy1 * uvScale;
    cs2.u = wz2 * uvScale; cs2.v = wy2 * uvScale;
  } else {
    cs0.u = wx0 * uvScale; cs0.v = wy0 * uvScale;
    cs1.u = wx1 * uvScale; cs1.v = wy1 * uvScale;
    cs2.u = wx2 * uvScale; cs2.v = wy2 * uvScale;
  }
}


function _shadePackedColor(packed, lit, mul = 1.0) {
  const r0 = packed & 0xff;
  const g0 = (packed >>> 8) & 0xff;
  const b0 = (packed >>> 16) & 0xff;
  const shade = lit * mul;
  const r = Math.max(0, Math.min(255, (r0 * shade) | 0));
  const g = Math.max(0, Math.min(255, (g0 * shade) | 0));
  const b = Math.max(0, Math.min(255, (b0 * shade) | 0));
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

// ─── Public: threeReady / isThreeReady ───────────────────────────────────────

/**
 * Kick off Three.js + GLTFLoader import. Safe to call multiple times.
 * Only needed for GLB loading — world geometry no longer requires this.
 */
export function threeReady() {
  if (_readyProm) return _readyProm;
  _readyProm = (async () => {
    _THREE = await import(THREE_URL);
    const gltfMod = await import(GLTF_URL);
    _GLTFLoader = gltfMod.GLTFLoader;

    // Build the persistent Three.js perspective camera that mirrors the engine camera.
    _threeCamera = new _THREE.PerspectiveCamera(CAM_FOV, CAM_ASPECT, CAM_NEAR, CAM_FAR);
    _vec3 = new _THREE.Vector3();
    _mat4 = new _THREE.Matrix4();

    _ready = true;
    return { THREE: _THREE, GLTFLoader: _GLTFLoader };
  })();
  return _readyProm;
}

/** True once threeReady() has fully resolved. */
export function isThreeReady() { return _ready; }

// ─── syncThreeCamera ─────────────────────────────────────────────────────────
//
// Call this once per frame (before buildMeshTris) to push the engine camera's
// position, yaw, pitch and fovMul into _threeCamera's matrices.
// Three.js's view matrix is:  V = R_pitch * R_yaw * T(-pos)
// We rebuild it manually here so we match the engine's convention exactly.
//
export function syncThreeCamera(engineCamera) {
  if (!_threeCamera || !_THREE) return;
  const cam = _threeCamera;

  // Apply fovMul: narrower fov = zoom in.  Three.js uses vertical fov in degrees.
  const fov = CAM_FOV / (engineCamera.fovMul || 1.0);
  if (Math.abs(cam.fov - fov) > 0.01) {
    cam.fov = fov;
    cam.updateProjectionMatrix();
  }

  // Position
  cam.position.set(engineCamera.x, engineCamera.y, engineCamera.z);

  // Orientation: engine uses (yaw degrees CW around Y, pitch degrees around X).
  // Three.js default camera looks down -Z.
  // Rotation order: first yaw (Y), then pitch (X) — Euler 'YXZ'.
  cam.rotation.order = 'YXZ';
  // Engine yaw: positive = CW when viewed from above → negative in Three.js (right-hand).
  cam.rotation.y = (-engineCamera.yaw * Math.PI) / 180;
  // Engine pitch: positive = look down → in Three.js the camera pitches forward = negative X.
  cam.rotation.x = (-(engineCamera.pitch || 0) * Math.PI) / 180;
  cam.rotation.z = 0;

  cam.updateMatrixWorld(true);
}

// ─── Project a world-space point using the Three.js camera ──────────────────
//
// Returns { sx, sy, cz, visible } compatible with the engine's drawTriangle.
//   sx, sy  — integer screen-pixel coordinates
//   cz      — camera-space Z (depth for depth buffer)
//   visible — false if behind the near plane
//
function _projectTHREE(wx, wy, wz) {
  _vec3.set(wx, wy, wz);
  _vec3.project(_threeCamera); // NDC: x,y,z each in -1..+1

  // Depth: project() sets _vec3.z to NDC-Z.  We need camera-space Z for the
  // depth buffer.  Recover it from the view matrix (row 2, column 3 gives the
  // camera-space Z of the point).
  // Faster: dot the view matrix's Z-row with the world position.
  const mw = _threeCamera.matrixWorldInverse.elements;
  // camera-space Z = mw[2]*wx + mw[6]*wy + mw[10]*wz + mw[14]
  const camZ = mw[2]*wx + mw[6]*wy + mw[10]*wz + mw[14];

  if (camZ < NEAR_Z) return { sx: 0, sy: 0, cz: camZ, visible: false };

  let sx = _vec3.x *  HALF_W + HALF_W;
  let sy = _vec3.y * -HALF_H + HALF_H;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    return { sx: 0, sy: 0, cz: camZ, visible: false };
  }
  if (sx < -SCREEN_GUARD) sx = -SCREEN_GUARD;
  else if (sx > SCREEN_GUARD) sx = SCREEN_GUARD;
  if (sy < -SCREEN_GUARD) sy = -SCREEN_GUARD;
  else if (sy > SCREEN_GUARD) sy = SCREEN_GUARD;
  return { sx: sx | 0, sy: sy | 0, cz: camZ, visible: true };
}

// ─── Near-plane clip (camera-space Sutherland-Hodgman, Z > NEAR_Z) ──────────
// Points are camera-space objects { cx, cy, cz } — same as before.
function _clipNear(pts) {
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
        wx: a.wx + t * (b.wx - a.wx),
        wy: a.wy + t * (b.wy - a.wy),
        wz: a.wz + t * (b.wz - a.wz),
        cz: NEAR_Z,
      });
    }
  }
  return out;
}

function _emitClipped(worldPts, color, avgZ) {
  if (worldPts.length < 3) return [];
  const tris = [];
  const v0 = _projectTHREE(worldPts[0].wx, worldPts[0].wy, worldPts[0].wz);
  if (!v0.visible) return [];
  for (let i = 1; i + 1 < worldPts.length; i++) {
    const va = _projectTHREE(worldPts[i].wx,   worldPts[i].wy,   worldPts[i].wz);
    const vb = _projectTHREE(worldPts[i+1].wx, worldPts[i+1].wy, worldPts[i+1].wz);
    if (!va.visible || !vb.visible) continue;
    tris.push({ verts: [v0, va, vb], color, avgZ });
  }
  return tris;
}

// ─── Camera-space Z from the Three.js view matrix ─────────────────────────
// Used for per-vertex cz during clipping (before _projectTHREE is called).
function _camZ(wx, wy, wz) {
  const m = _threeCamera.matrixWorldInverse.elements;
  return m[2]*wx + m[6]*wy + m[10]*wz + m[14];
}

// ─── GLB mesh data extractor ─────────────────────────────────────────────────

export function extractMeshData(geo, matrixWorld = null, material = null) {
  const THREE = _THREE;
  if (!THREE) throw new Error("Call threeReady() and await it before extractMeshData()");

  const posAttr = geo.attributes.position;
  const nrmAttr = geo.attributes.normal;
  const colAttr = geo.attributes.color || geo.attributes.COLOR_0 || null;
  const uvAttr  = geo.attributes.uv || geo.attributes.TEXCOORD_0 || null;

  const count = posAttr.count;
  const vertices = new Float32Array(count * 3);
  const normals  = new Float32Array(count * 3);

  const vTmp = new THREE.Vector3();
  const nTmp = new THREE.Vector3();
  const normalMatrix = matrixWorld ? new THREE.Matrix3().getNormalMatrix(matrixWorld) : null;

  for (let i = 0; i < count; i++) {
    vTmp.fromBufferAttribute(posAttr, i);
    if (matrixWorld) vTmp.applyMatrix4(matrixWorld);
    vertices[i*3]   = vTmp.x;
    vertices[i*3+1] = vTmp.y;
    vertices[i*3+2] = vTmp.z;

    if (nrmAttr) {
      nTmp.fromBufferAttribute(nrmAttr, i);
      if (normalMatrix) nTmp.applyMatrix3(normalMatrix).normalize();
      normals[i*3]   = nTmp.x;
      normals[i*3+1] = nTmp.y;
      normals[i*3+2] = nTmp.z;
    }
  }

  let uvs = null;
  if (uvAttr) {
    uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvs[i*2] = uvAttr.getX(i);
      uvs[i*2+1] = uvAttr.getY(i);
    }
  }

  let colors = null;
  if (colAttr) {
    colors = new Float32Array(count * 4);
    const itemSize = colAttr.itemSize;
    for (let i = 0; i < count; i++) {
      colors[i*4]   = colAttr.getX(i);
      colors[i*4+1] = colAttr.getY(i);
      colors[i*4+2] = colAttr.getZ(i);
      colors[i*4+3] = itemSize >= 4 ? colAttr.getW(i) : 1.0;
    }
  } else if (material && material.color) {
    const mc = material.color;
    colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      colors[i*4]   = mc.r;
      colors[i*4+1] = mc.g;
      colors[i*4+2] = mc.b;
      colors[i*4+3] = 1.0;
    }
  }

  let indices;
  if (geo.index) {
    const src = geo.index.array;
    indices = src instanceof Uint32Array ? src : new Uint32Array(src);
  } else {
    indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
  }

  return { vertices, normals, indices, colors, uvs };
}

// ─── GLB loader ──────────────────────────────────────────────────────────────

async function _checkUrlExists(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.ok) return true;
    if (res.status === 405) {
      const getRes = await fetch(url, { method: "GET" });
      return getRes.ok;
    }
    return false;
  } catch (err) {
    return false;
  }
}

export async function loadGLBMeshIfAvailable(url, name = "GLB model", required = false) {
  const label = `${name} @ ${url}`;
  if (!(await _checkUrlExists(url))) {
    const msg = `[geometry] ${label} unavailable`;
    if (required) throw new Error(msg);
    console.warn(msg);
    return null;
  }

  try {
    return await loadGLBMesh(url);
  } catch (err) {
    const msg = `[geometry] ${label} failed to load`;
    if (required) throw new Error(`${msg}: ${err.message}`);
    console.warn(msg, err);
    return null;
  }
}

export async function loadGLBMesh(url) {
  const { THREE, GLTFLoader } = await threeReady();

  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
      const meshes = [];
      gltf.scene.traverse((node) => {
        if (node.isMesh && node.geometry) {
          node.updateMatrixWorld(true);
          meshes.push(node);
        }
      });

      if (meshes.length === 0) {
        reject(new Error("GLB contains no Mesh nodes"));
        return;
      }

      const allVerts   = [];
      const allNormals = [];
      const allColors  = [];
      const allUVs     = [];
      const allIndices = [];
      let indexOffset  = 0;
      let hasAnyColors = false;
      let hasAnyUVs    = false;

      for (const mesh of meshes) {
        const mat  = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        // Pass null for matrixWorld so vertices stay in local (geometry) space.
        // buildMeshTris handles orientation via yawDeg + worldX/Y/Z translation.
        // Baking matrixWorld here would fold in the GLB node's own rotation,
        // causing a double-rotation when buildMeshTris applies player.yaw.
        const data = extractMeshData(mesh.geometry, null, mat || null);
        allVerts.push(data.vertices);
        allNormals.push(data.normals);
        allColors.push(data.colors);
        allUVs.push(data.uvs);
        if (data.colors) hasAnyColors = true;
        if (data.uvs) hasAnyUVs = true;

        const shiftedIdx = new Uint32Array(data.indices.length);
        for (let i = 0; i < data.indices.length; i++) {
          shiftedIdx[i] = data.indices[i] + indexOffset;
        }
        allIndices.push(shiftedIdx);
        indexOffset += data.vertices.length / 3;
      }

      const totalV     = allVerts.reduce((s, a) => s + a.length, 0);
      const totalI     = allIndices.reduce((s, a) => s + a.length, 0);
      const vertices   = new Float32Array(totalV);
      const normals    = new Float32Array(totalV);
      const indices    = new Uint32Array(totalI);
      const totalVerts = totalV / 3;
      const colors     = hasAnyColors ? new Float32Array(totalVerts * 4) : null;
      const uvs        = hasAnyUVs ? new Float32Array(totalVerts * 2) : null;

      let vOff = 0, cOff = 0, uvOff = 0, iOff = 0;
      for (let k = 0; k < allVerts.length; k++) {
        vertices.set(allVerts[k], vOff);
        normals.set(allNormals[k], vOff);

        const segVerts = allVerts[k].length / 3;
        if (colors) {
          if (allColors[k]) {
            colors.set(allColors[k], cOff);
          } else {
            for (let s = 0; s < segVerts; s++) {
              colors[cOff + s*4]   = 1.0;
              colors[cOff + s*4+1] = 1.0;
              colors[cOff + s*4+2] = 1.0;
              colors[cOff + s*4+3] = 1.0;
            }
          }
          cOff += segVerts * 4;
        }
        if (uvs) {
          if (allUVs[k]) {
            uvs.set(allUVs[k], uvOff);
          } else {
            for (let s = 0; s < segVerts; s++) {
              uvs[uvOff + s*2] = 0;
              uvs[uvOff + s*2+1] = 0;
            }
          }
          uvOff += segVerts * 2;
        }
        vOff += allVerts[k].length;
      }
      for (let k = 0; k < allIndices.length; k++) {
        indices.set(allIndices[k], iOff);
        iOff += allIndices[k].length;
      }

      resolve({ vertices, normals, indices, colors, uvs });
    }, undefined, reject);
  });
}

// ─── Engine-native camera helpers ─────────────────────────────────────────────
// Mirrors renderer.js toCameraSpace / projectCS exactly, using the same
// LUT-based trig so GLB vertices project identically to all other geometry.

function _engToCameraSpace(wx, wy, wz, cam) {
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const dz = wz - cam.z;
  const cy = cosDeg(-cam.yaw);
  const sy = sinDeg(-cam.yaw);
  let cx  =  dx * cy + dz * sy;
  let cz  = -dx * sy + dz * cy;
  let cyy = dy;
  const pitch = cam.pitch || 0;
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

function _engProjectCS(cs, cam) {
  if (cs.cz < NEAR_Z) return { sx: 0, sy: 0, cz: cs.cz, visible: false };
  const fovMul = cam.fovMul || 1.0;
  let sx = HALF_W + cs.cx * scaleAtX(cs.cz) * fovMul;
  let sy = HALF_H - cs.cy * scaleAtY(cs.cz) * fovMul;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
    return { sx: 0, sy: 0, cz: cs.cz, visible: false };
  }
  if (sx < -SCREEN_GUARD) sx = -SCREEN_GUARD;
  else if (sx > SCREEN_GUARD) sx = SCREEN_GUARD;
  if (sy < -SCREEN_GUARD) sy = -SCREEN_GUARD;
  else if (sy > SCREEN_GUARD) sy = SCREEN_GUARD;
  return { sx: sx | 0, sy: sy | 0, cz: cs.cz, u: cs.u ?? 0, v: cs.v ?? 0, visible: true };
}

function _engClipNear(pts) {
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
        u: (a.u ?? 0) + t * ((b.u ?? 0) - (a.u ?? 0)),
        v: (a.v ?? 0) + t * ((b.v ?? 0) - (a.v ?? 0)),
      });
    }
  }
  return out;
}

function _engEmitClipped(csPts, color, avgZ, cam, texture = null, zone = null, biome = null) {
  if (csPts.length < 3) return [];
  const tris = [];
  const v0 = _engProjectCS(csPts[0], cam);
  if (!v0.visible) return [];
  for (let i = 1; i + 1 < csPts.length; i++) {
    const va = _engProjectCS(csPts[i], cam);
    const vb = _engProjectCS(csPts[i+1], cam);
    if (!va.visible || !vb.visible) continue;
    tris.push({ verts: [v0, va, vb], color, avgZ, texture, zone, biome });
  }
  return tris;
}

// ─── GLB → painter's tris  (engine-native projection path) ───────────────────
//
// Transforms GLB vertex data through the same toCameraSpace + projectCS math
// used by ALL other geometry in renderer.js. This guarantees the model lands
// exactly where the player sprite sits — no Three.js camera mismatch.
//
// syncThreeCamera() is no longer needed for projection but kept for any
// other callers that may reference it.
//
// colorMode options:
//   undefined / false     — default: use vertex colors or baseColor with lighting
//   "froyo"               — bottom half orange, top uses vertex/base color
//   "flatRed"             — force solid red (255,30,30) on every triangle (cherry)
//   "flatYellow"          — force flat yellow (255,210,0) on every triangle (sun)
//   "flatBrown"           — force flat brown on every triangle (bridge)
//   "sunZone"             — yellow on triangles within the primary sphere radius,
//                           black on ray/spike geometry outside that radius
//   "island"              — biome palette flat top faces, gradient sides/bottom
//   "skyDome"             — old sky gradient or game-provided level palette
//   "skyRing"             — old purple ring or game-provided level palette
export function buildMeshTris(meshData, worldX, worldY, worldZ, baseColor, camera, _unusedProjectFn, scale = 1, yawDeg = 0, colorMode = false, islandPalette = null) {
  if (!camera) return [];

  // Legacy boolean support: tintBottomOrange=true maps to "froyo"
  if (colorMode === true) colorMode = "froyo";

  const { vertices, normals, indices, colors, uvs } = meshData;
  const tris = [];

  const br = (baseColor)        & 0xff;
  const bg = (baseColor >>> 8)  & 0xff;
  const bb = (baseColor >>> 16) & 0xff;
  const islandPal = _resolveIslandPalette(islandPalette);

  const rad  = (yawDeg * Math.PI) / 180;
  const cosY = Math.cos(rad);
  const sinY = Math.sin(rad);
  const triCount = (indices.length / 3) | 0;

  // Local-space center offset: subtract before rotating so the model spins
  // around its own geometric center instead of the geometry origin.
  const lcx = meshData.localCX ?? 0;
  const lcy = meshData.localCY ?? 0;
  const lcz = meshData.localCZ ?? 0;

  // For sunZone mode: compute the primary sphere radius from the bounding box.
  // The sun model is roughly a sphere with rays/spikes sticking out.
  // We use half the model's Y extent as the sphere radius — rays extend beyond it.
  let sunSphereR = 0;
  if (colorMode === "sunZone" && meshData._sunSphereR !== undefined) {
    sunSphereR = meshData._sunSphereR;
  } else if (colorMode === "sunZone") {
    // Estimate: measure max Y-axis extent (sphere diameter ≈ half the total height).
    // The sun GLB typically has a big central sphere and thin spike rays.
    // We'll compute the tight bounding sphere radius from vertex distances.
    let maxR = 0;
    for (let i = 0; i < vertices.length; i += 3) {
      const dx = vertices[i]   - lcx;
      const dy = vertices[i+1] - lcy;
      const dz = vertices[i+2] - lcz;
      const r  = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (r > maxR) maxR = r;
    }
    // Primary sphere = ~55% of the max radius (rays stick out further)
    sunSphereR = maxR * 0.55;
    meshData._sunSphereR = sunSphereR; // cache on mesh object
  }

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];

    // Step 1: subtract bounding-box center (pivot at model center)
    const lx0 = vertices[i0*3] - lcx, ly0 = vertices[i0*3+1] - lcy, lz0 = vertices[i0*3+2] - lcz;
    const lx1 = vertices[i1*3] - lcx, ly1 = vertices[i1*3+1] - lcy, lz1 = vertices[i1*3+2] - lcz;
    const lx2 = vertices[i2*3] - lcx, ly2 = vertices[i2*3+1] - lcy, lz2 = vertices[i2*3+2] - lcz;

    // Step 2: scale + yaw rotation + world translation
    const wx0 = (lx0*cosY + lz0*sinY)*scale + worldX;
    const wy0 = ly0*scale + worldY;
    const wz0 = (-lx0*sinY + lz0*cosY)*scale + worldZ;

    const wx1 = (lx1*cosY + lz1*sinY)*scale + worldX;
    const wy1 = ly1*scale + worldY;
    const wz1 = (-lx1*sinY + lz1*cosY)*scale + worldZ;

    const wx2 = (lx2*cosY + lz2*sinY)*scale + worldX;
    const wy2 = ly2*scale + worldY;
    const wz2 = (-lx2*sinY + lz2*cosY)*scale + worldZ;

    // Step 3: world → camera space using the engine's own transform
    const cs0 = _engToCameraSpace(wx0, wy0, wz0, camera);
    const cs1 = _engToCameraSpace(wx1, wy1, wz1, camera);
    const cs2 = _engToCameraSpace(wx2, wy2, wz2, camera);

    // Discard if all three vertices are behind the near plane
    if (cs0.cz < NEAR_Z && cs1.cz < NEAR_Z && cs2.cz < NEAR_Z) continue;

    // Flat-shaded lighting (averaged face normal rotated by yaw)
    const rn0x = normals[i0*3]*cosY + normals[i0*3+2]*sinY;
    const rn0y = normals[i0*3+1];
    const rn0z = -normals[i0*3]*sinY + normals[i0*3+2]*cosY;
    const rn1x = normals[i1*3]*cosY + normals[i1*3+2]*sinY;
    const rn1y = normals[i1*3+1];
    const rn1z = -normals[i1*3]*sinY + normals[i1*3+2]*cosY;
    const rn2x = normals[i2*3]*cosY + normals[i2*3+2]*sinY;
    const rn2y = normals[i2*3+1];
    const rn2z = -normals[i2*3]*sinY + normals[i2*3+2]*cosY;

    const nx2 = (rn0x+rn1x+rn2x)/3;
    const ny2 = (rn0y+rn1y+rn2y)/3;
    const nz2 = (rn0z+rn1z+rn2z)/3;

    const dot = nx2*LNX + ny2*LNY + nz2*LNZ;
    const lit = 0.30 + 0.70 * Math.max(0, dot);

    // Average local position of the three verts (center-relative)
    const avgLocalX = (lx0 + lx1 + lx2) / 3;
    const avgLocalY = (ly0 + ly1 + ly2) / 3;
    const avgLocalZ = (lz0 + lz1 + lz2) / 3;
    const avgLocalR = Math.sqrt(avgLocalX*avgLocalX + avgLocalY*avgLocalY + avgLocalZ*avgLocalZ);

    // Orange for bottom half: RGB(255, 140, 0)
    const ORANGE_R = 255, ORANGE_G = 140, ORANGE_B = 0;

    let color;
    let texture = null;
    let zone = null;
    let biome = null;
    if (colorMode === "skyDome") {
      // Biome-aware sky gradient. The game layer may pass a level/sky palette;
      // if it does not, this preserves the old warm purple-orange style.
      if (!meshData._skyYMin) {
        let mn = Infinity, mx = -Infinity;
        for (let vi = 0; vi < vertices.length; vi += 3) {
          const yy = vertices[vi+1] - (meshData.localCY || 0);
          if (yy < mn) mn = yy; if (yy > mx) mx = yy;
        }
        meshData._skyYMin = mn; meshData._skyYMax = mx;
      }
      const ySpan = meshData._skyYMax - meshData._skyYMin || 1;
      const t = Math.max(0, Math.min(1, (avgLocalY - meshData._skyYMin) / ySpan));
      if (islandPalette) {
        const lo = islandPal.side; // horizon / lower sky
        const hi = islandPal.top;  // upper sky
        const lr = lo & 255, lg = (lo >>> 8) & 255, lb = (lo >>> 16) & 255;
        const hr = hi & 255, hg = (hi >>> 8) & 255, hb = (hi >>> 16) & 255;
        const r = Math.min(255, (lr + (hr - lr) * t) | 0);
        const g = Math.min(255, (lg + (hg - lg) * t) | 0);
        const b = Math.min(255, (lb + (hb - lb) * t) | 0);
        color = (0xff << 24) | (b << 16) | (g << 8) | r;
      } else {
        // t=0 → bottom/orange (255,120,40), t=1 → top/purple (160,60,220)
        const pr = Math.min(255, (255 + (160 - 255) * t) | 0);
        const pg = Math.min(255, (120 + ( 60 - 120) * t) | 0);
        const pb = Math.min(255, ( 40 + (220 -  40) * t) | 0);
        color = (0xff << 24) | (pb << 16) | (pg << 8) | pr;
      }
    } else if (colorMode === "skyRing") {
      // Biome-aware sky ring. Geometry only classifies the surface zone;
      // the game-provided sky palette/atlas decides what each zone means.
      zone = zoneFromNormal(ny2);
      biome = islandPal.biome;

      const ringBase = islandPalette
        ? (zone === "top" ? islandPal.top : islandPal.side)
        : 0xffdc3ca0;

      color = _shadePackedColor(ringBase, lit, 1.0);

      texture = islandPalette
        ? (zone === "top"
            ? islandPal.textureTop
            : zone === "under"
              ? (islandPal.textureUnder || islandPal.textureSide)
              : islandPal.textureSide)
        : null;

      if (texture) {
        _setTerrainUVsForTri(
          cs0, cs1, cs2,
          wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2,
          nx2, ny2, nz2,
          islandPal.textureScale || 0.035
        );
      }
    } else if (colorMode === "flatRed") {
      // Cherry: force solid red on every triangle
      const r  = Math.min(255, (220 * lit) | 0);
      const g  = Math.min(255, (30  * lit) | 0);
      const b2 = Math.min(255, (30  * lit) | 0);
      color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
    } else if (colorMode === "sunVertex") {
      // Sun with sunglasses: use the GLB's own vertex colors so the sunglasses
      // (dark triangles in the model) stay dark, while the yellow sun body stays yellow.
      // If no vertex colors present, fall back to flat yellow.
      if (colors) {
        const cr = (colors[i0*4]   + colors[i1*4]   + colors[i2*4])   / 3;
        const cg = (colors[i0*4+1] + colors[i1*4+1] + colors[i2*4+1]) / 3;
        const cb = (colors[i0*4+2] + colors[i1*4+2] + colors[i2*4+2]) / 3;
        // Boost yellow: if the vertex color is already yellowish (r>0.6, g>0.5, b<0.3)
        // push it toward the bright sun yellow. Dark triangles (sunglasses) stay dark.
        const brightness = (cr + cg + cb) / 3;
        let fr, fg, fb;
        if (brightness > 0.35) {
          // Bright region — blend toward vivid yellow (1.0, 0.82, 0.0)
          const blend = Math.min(1, brightness * 1.4);
          fr = cr + (1.00 - cr) * blend * 0.7;
          fg = cg + (0.82 - cg) * blend * 0.7;
          fb = cb * (1 - blend * 0.9);
        } else {
          // Dark region (sunglasses, pupils) — preserve the darkness
          fr = cr * 0.8;
          fg = cg * 0.8;
          fb = cb * 0.8;
        }
        const r  = Math.min(255, (fr * 255 * lit) | 0);
        const g  = Math.min(255, (fg * 255 * lit) | 0);
        const b2 = Math.min(255, (fb * 255 * lit) | 0);
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      } else {
        // No vertex colors — flat yellow
        const r  = Math.min(255, (255 * lit) | 0);
        const g  = Math.min(255, (210 * lit) | 0);
        const b2 = 0;
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      }
    } else if (colorMode === "flatYellow") {
      // Sun: force flat yellow (255,210,0) on every triangle
      const r  = Math.min(255, (255 * lit) | 0);
      const g  = Math.min(255, (210 * lit) | 0);
      const b2 = 0;
      color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
    } else if (colorMode === "flatBrown") {
      // Bridge: warm brown (160,100,50)
      const r  = Math.min(255, (160 * lit) | 0);
      const g  = Math.min(255, (100 * lit) | 0);
      const b2 = Math.min(255, ( 50 * lit) | 0);
      color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
    } else if (colorMode === "island") {
      // Islands inherit their top/side colors from the game biome palette.
      // Classify by face normal Y component: flat-top (ny > 0.55) = top zone,
      // otherwise side/underside gets a height-darkened version of the side color.
      const rn0y2 = normals[i0*3+1], rn1y2 = normals[i1*3+1], rn2y2 = normals[i2*3+1];
      const faceNY = (rn0y2 + rn1y2 + rn2y2) / 3;
      if (faceNY > 0.55) {
        color = _shadePackedColor(islandPal.top, lit);
        texture = islandPal.textureTop || null;
      } else {
        // Cache island Y extent for gradient
        if (meshData._islandYMin === undefined) {
          let mn = Infinity, mx = -Infinity;
          for (let vi = 0; vi < vertices.length; vi += 3) {
            const yy = vertices[vi+1];
            if (yy < mn) mn = yy; if (yy > mx) mx = yy;
          }
          meshData._islandYMin = mn; meshData._islandYMax = mx;
        }
        const ySpan = meshData._islandYMax - meshData._islandYMin || 1;
        // t=0 bottom → darker side color, t=1 top → full side color.
        const rawY = vertices[i0*3+1] + vertices[i1*3+1] + vertices[i2*3+1];
        const tt = Math.max(0, Math.min(1, (rawY / 3 - meshData._islandYMin) / ySpan));
        const sideMul = 0.55 + tt * 0.45;
        color = _shadePackedColor(islandPal.side, lit, sideMul);
        texture = (faceNY < -0.35 ? islandPal.textureUnder : islandPal.textureSide) || null;
      }

      if (texture) {
        _setTerrainUVsForTri(
          cs0, cs1, cs2,
          wx0, wy0, wz0, wx1, wy1, wz1, wx2, wy2, wz2,
          nx2, faceNY, nz2,
          islandPal.textureScale
        );
      }
    } else if (colorMode === "sunZone") {
      // Sun: yellow core sphere, black on spikes/rays outside sphere
      const inSphere = avgLocalR <= sunSphereR;
      if (inSphere) {
        // Bright yellow
        const r  = Math.min(255, (255 * lit) | 0);
        const g  = Math.min(255, (210 * lit) | 0);
        const b2 = 0;
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      } else {
        // Pure black for spikes/rays
        const dark = (lit * 30) | 0;
        color = (0xff << 24) | (dark << 16) | (dark << 8) | dark;
      }
    } else if (colorMode === "froyo") {
      const isBottom = avgLocalY < 0;
      if (isBottom) {
        // Froyo player model: bottom half forced orange
        const r  = Math.min(255, (ORANGE_R * lit) | 0);
        const g  = Math.min(255, (ORANGE_G * lit) | 0);
        const b2 = Math.min(255, (ORANGE_B * lit) | 0);
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      } else if (colors) {
        const cr = (colors[i0*4]   + colors[i1*4]   + colors[i2*4])   / 3;
        const cg = (colors[i0*4+1] + colors[i1*4+1] + colors[i2*4+1]) / 3;
        const cb = (colors[i0*4+2] + colors[i1*4+2] + colors[i2*4+2]) / 3;
        const r  = Math.min(255, (cr*255*lit) | 0);
        const g  = Math.min(255, (cg*255*lit) | 0);
        const b2 = Math.min(255, (cb*255*lit) | 0);
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      } else {
        const r  = Math.min(255, (br*lit) | 0);
        const g  = Math.min(255, (bg*lit) | 0);
        const b2 = Math.min(255, (bb*lit) | 0);
        color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
      }
    } else if (colors) {
      // Use vertex colors from the GLB
      const cr = (colors[i0*4]   + colors[i1*4]   + colors[i2*4])   / 3;
      const cg = (colors[i0*4+1] + colors[i1*4+1] + colors[i2*4+1]) / 3;
      const cb = (colors[i0*4+2] + colors[i1*4+2] + colors[i2*4+2]) / 3;
      const r  = Math.min(255, (cr*255*lit) | 0);
      const g  = Math.min(255, (cg*255*lit) | 0);
      const b2 = Math.min(255, (cb*255*lit) | 0);
      color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
    } else {
      // No vertex colors — use baseColor
      const r  = Math.min(255, (br*lit) | 0);
      const g  = Math.min(255, (bg*lit) | 0);
      const b2 = Math.min(255, (bb*lit) | 0);
      color = (0xff << 24) | (b2 << 16) | (g << 8) | r;
    }

    const avgZ = (cs0.cz + cs1.cz + cs2.cz) / 3;

    // Near-plane clip in camera space, then project
    const clipped = _engClipNear([cs0, cs1, cs2]);
    const emitted = _engEmitClipped(clipped, color, avgZ, camera, texture, zone, biome);
    for (const tri of emitted) tris.push(tri);
  }

  return tris;
}

// ─── Island geometry precache ─────────────────────────────────────────────────
//
// For non-moving (static) islands, we pre-compute color decisions per triangle
// (colorMode="island": green top, gradient brown sides/bottom) and cache
// pre-rotated/scaled local coords so per-frame rendering only does cam-space
// transform + clip, skipping all per-tri colorMode branches.
//
// Cache: Float32Array of 10 floats per tri:
//   [ rx0,ry0,rz0, rx1,ry1,rz1, rx2,ry2,rz2, colorBitsAsFloat ]
//   rx/ry/rz = scale+yaw-rotated local coords (no world translation yet)

export function precacheIslandColors(meshData, scale = 1, yawDeg = 0, islandPalette = null) {
  const { vertices, normals, indices } = meshData;
  const rad  = (yawDeg * Math.PI) / 180;
  const cosY = Math.cos(rad);
  const sinY = Math.sin(rad);
  const triCount = (indices.length / 3) | 0;
  const islandPal = _resolveIslandPalette(islandPalette);

  const lcx = meshData.localCX ?? 0;
  const lcy = meshData.localCY ?? 0;
  const lcz = meshData.localCZ ?? 0;

  // Pre-build Y extent for island gradient
  if (meshData._islandYMin === undefined) {
    let mn = Infinity, mx = -Infinity;
    for (let vi = 0; vi < vertices.length; vi += 3) {
      const yy = vertices[vi+1];
      if (yy < mn) mn = yy; if (yy > mx) mx = yy;
    }
    meshData._islandYMin = mn; meshData._islandYMax = mx;
  }
  const yMin = meshData._islandYMin;
  const ySpan = (meshData._islandYMax - yMin) || 1;

  const buf = new Float32Array(triCount * 9);
  const colorBuf = new Uint32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];

    const lx0 = vertices[i0*3] - lcx, ly0 = vertices[i0*3+1] - lcy, lz0 = vertices[i0*3+2] - lcz;
    const lx1 = vertices[i1*3] - lcx, ly1 = vertices[i1*3+1] - lcy, lz1 = vertices[i1*3+2] - lcz;
    const lx2 = vertices[i2*3] - lcx, ly2 = vertices[i2*3+1] - lcy, lz2 = vertices[i2*3+2] - lcz;

    const rx0 = (lx0*cosY + lz0*sinY)*scale, ry0 = ly0*scale, rz0 = (-lx0*sinY + lz0*cosY)*scale;
    const rx1 = (lx1*cosY + lz1*sinY)*scale, ry1 = ly1*scale, rz1 = (-lx1*sinY + lz1*cosY)*scale;
    const rx2 = (lx2*cosY + lz2*sinY)*scale, ry2 = ly2*scale, rz2 = (-lx2*sinY + lz2*cosY)*scale;

    // Rotated normals for lighting
    const rn0x = normals[i0*3]*cosY + normals[i0*3+2]*sinY;
    const rn0z = -normals[i0*3]*sinY + normals[i0*3+2]*cosY;
    const rn1x = normals[i1*3]*cosY + normals[i1*3+2]*sinY;
    const rn2x = normals[i2*3]*cosY + normals[i2*3+2]*sinY;
    const rn1z = -normals[i1*3]*sinY + normals[i1*3+2]*cosY;
    const rn2z = -normals[i2*3]*sinY + normals[i2*3+2]*cosY;
    const nx2 = (rn0x + rn1x + rn2x) / 3;
    const ny2 = (normals[i0*3+1] + normals[i1*3+1] + normals[i2*3+1]) / 3;
    const nz2 = (rn0z + rn1z + rn2z) / 3;
    const dot = nx2*LNX + ny2*LNY + nz2*LNZ;
    const lit = 0.30 + 0.70 * Math.max(0, dot);

    const faceNY = ny2;
    let colorBits;
    if (faceNY > 0.55) {
      colorBits = _shadePackedColor(islandPal.top, lit);
    } else {
      const rawY = (vertices[i0*3+1] + vertices[i1*3+1] + vertices[i2*3+1]) / 3;
      const tt = Math.max(0, Math.min(1, (rawY - yMin) / ySpan));
      const sideMul = 0.55 + tt * 0.45;
      colorBits = _shadePackedColor(islandPal.side, lit, sideMul);
    }

    const base = t * 9;
    buf[base]   = rx0; buf[base+1] = ry0; buf[base+2] = rz0;
    buf[base+3] = rx1; buf[base+4] = ry1; buf[base+5] = rz1;
    buf[base+6] = rx2; buf[base+7] = ry2; buf[base+8] = rz2;
    colorBuf[t] = colorBits;
  }

  return { buf, colorBuf, triCount };
}

// Build tris from a precached island buffer each frame.
export function buildMeshTrisFromCache(cache, worldX, worldY, worldZ, camera) {
  if (!camera || !cache) return [];
  const { buf, colorBuf, triCount } = cache;
  const tris = [];

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const wx0 = buf[base]   + worldX, wy0 = buf[base+1] + worldY, wz0 = buf[base+2] + worldZ;
    const wx1 = buf[base+3] + worldX, wy1 = buf[base+4] + worldY, wz1 = buf[base+5] + worldZ;
    const wx2 = buf[base+6] + worldX, wy2 = buf[base+7] + worldY, wz2 = buf[base+8] + worldZ;

    const cs0 = _engToCameraSpace(wx0, wy0, wz0, camera);
    const cs1 = _engToCameraSpace(wx1, wy1, wz1, camera);
    const cs2 = _engToCameraSpace(wx2, wy2, wz2, camera);
    if (cs0.cz < NEAR_Z && cs1.cz < NEAR_Z && cs2.cz < NEAR_Z) continue;

    const colorBits = colorBuf ? colorBuf[t] : (buf[base+9] >>> 0);
    const avgZ = (cs0.cz + cs1.cz + cs2.cz) / 3;
    const clipped = _engClipNear([cs0, cs1, cs2]);
    const emitted = _engEmitClipped(clipped, colorBits, avgZ, camera);
    for (const tri of emitted) tris.push(tri);
  }

  return tris;
}
