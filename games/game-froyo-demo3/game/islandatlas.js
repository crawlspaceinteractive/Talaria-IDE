/**
 * islandatlas.js — Full GLB island model loader v2.0
 *
 * IslandF is now the dedicated PORTAL ISLAND — it is loaded first and
 * exported as PORTAL_ISLAND_MODEL at double TARGET_HALF scale.
 * The remaining 6 island GLBs (A, B, C, D, E, G) populate ISLAND_MODELS
 * and are used as regular child islands.
 *
 * Each loaded entry contains:
 *   meshData    — { vertices, normals, indices, colors }  (from loadGLBMesh)
 *   halfW       — half-width  (X extent / 2), in world units after scaling
 *   halfD       — half-depth  (Z extent / 2)
 *   topY        — height of the top surface above island origin Y
 *   scale       — uniform world scale applied when rendering / colliding
 *   localCX/Y/Z — bounding-box center in local mesh space
 *
 * Exports
 * ───────
 *   loadIslandAtlas()      — Promise. Safe to call multiple times.
 *   isAtlasReady()         — bool
 *   getAtlasProgress()     — 0.0..1.0
 *   ISLAND_MODELS          — child island models (A–E, G); empty until resolved
 *   PORTAL_ISLAND_MODEL    — IslandF model entry; null until resolved
 */

import { loadGLBMeshIfAvailable } from "../engine/geometry.js";

const MODEL_BASE_URL = new URL("./models/", import.meta.url).href;

const PORTAL_ISLAND_URL = new URL("island_D_model.glb", MODEL_BASE_URL).href;

const CHILD_ISLAND_URLS = [
  "island_A_model.glb",
  "island_B_model.glb",
  "island_C_model.glb",
  "island_D_model.glb",
  "island_E_model.glb",
  "island_G_model.glb",
].map(name => new URL(name, MODEL_BASE_URL).href);

// ── Scale targets ─────────────────────────────────────────────────────────────
// Standard child island target half-extents
const TARGET_HALF_W = 22.0;
const TARGET_HALF_D = 22.0;

// Portal island is rendered at 2× normal scale in world.js (glbScaleMul = 2.0),
// so we keep the same TARGET_HALF here; world.js doubles it.
const PORTAL_TARGET_HALF_W = 22.0;
const PORTAL_TARGET_HALF_D = 22.0;

function _basename(url) {
  const name = url.split("/").pop() || url;
  return name.replace(/\.[^.]+$/, "");
}

// ── Public API ───────────────────────────────────────────────────────────────
export const ISLAND_MODELS = [];

// Portal island container — mutable object so importers hold a live reference.
// world.js reads _PORTAL.model after atlas is ready.
const _PORTAL = { model: null };
export function getPortalIslandModel() { return _PORTAL.model; }

export function findIslandModelById(id) {
  if (!id) return null;
  if (_PORTAL.model?.id === id) return _PORTAL.model;
  return ISLAND_MODELS.find(model => model.id === id) || null;
}

// Convenience alias accessed by world.js via named export
// We expose a getter-function instead of a bare `let` to avoid ES-module
// live-binding complexities with cross-file reassignment.
export { _PORTAL as PORTAL_ISLAND_MODEL };

let _ready    = false;
let _loadProm = null;
let _progress = 0;

export function isAtlasReady()     { return _ready; }
export function getAtlasProgress() { return _progress; }

export async function loadIslandAtlas() {
  if (_loadProm) return _loadProm;
  _loadProm = _doLoad();
  return _loadProm;
}

// ── Internal loader ──────────────────────────────────────────────────────────
async function _doLoad() {
  const total = CHILD_ISLAND_URLS.length + 1; // +1 for portal island
  let loaded  = 0;

  // ── Load IslandF as the portal island first ──────────────────────────────
  try {
    const mesh  = await loadGLBMeshIfAvailable(PORTAL_ISLAND_URL, "Portal island model");
    if (mesh) {
      const model = _buildModel(mesh, PORTAL_TARGET_HALF_W, PORTAL_TARGET_HALF_D, _basename(PORTAL_ISLAND_URL));
      _PORTAL.model = model;
      console.log(
        "[islandatlas] portal island (IslandF) loaded",
        `verts:${mesh.vertices.length / 3}`,
        `tris:${mesh.indices.length / 3}`,
        `scale:${model.scale.toFixed(3)}`,
        `halfW:${model.halfW.toFixed(1)} halfD:${model.halfD.toFixed(1)}`
      );
    } else {
      console.warn("[islandatlas] portal island (IslandF) model unavailable");
    }
  } catch (err) {
    console.warn("[islandatlas] failed to load portal island (IslandF):", err);
  }
  loaded++;
  _progress = loaded / total;

  // ── Load child islands ───────────────────────────────────────────────────
  for (let ai = 0; ai < CHILD_ISLAND_URLS.length; ai++) {
    try {
      const mesh  = await loadGLBMeshIfAvailable(CHILD_ISLAND_URLS[ai], `Child island model ${ai + 1}`);
      if (mesh) {
        const model = _buildModel(mesh, TARGET_HALF_W, TARGET_HALF_D, _basename(CHILD_ISLAND_URLS[ai]));
        ISLAND_MODELS.push(model);
        console.log(
          `[islandatlas] child island ${ai + 1}/${CHILD_ISLAND_URLS.length} loaded`,
          `verts:${mesh.vertices.length / 3}`,
          `tris:${mesh.indices.length / 3}`,
          `scale:${model.scale.toFixed(3)}`,
          `halfW:${model.halfW.toFixed(1)} halfD:${model.halfD.toFixed(1)}`
        );
      } else {
        console.warn(`[islandatlas] child island ${ai + 1} model unavailable`);
      }
    } catch (err) {
      console.warn(`[islandatlas] failed to load child island ${ai}:`, err);
    }
    loaded++;
    _progress = loaded / total;
  }

  _ready = true;
  console.log(
    `[islandatlas] ready — portal island: ${_PORTAL.model ? "OK" : "FAILED"},`,
    `child models: ${ISLAND_MODELS.length}/${CHILD_ISLAND_URLS.length}`
  );
  return ISLAND_MODELS;
}

// ── Build a model entry from raw GLB mesh data ───────────────────────────────
function _buildModel(meshData, targetHalfW, targetHalfD, sourceId) {
  const verts = meshData.vertices;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const rawHalfW = (maxX - minX) * 0.5;
  const rawHalfD = (maxZ - minZ) * 0.5;

  const scaleW = rawHalfW > 0.0001 ? targetHalfW / rawHalfW : 1;
  const scaleD = rawHalfD > 0.0001 ? targetHalfD / rawHalfD : 1;
  const scale  = Math.min(scaleW, scaleD);

  const halfW = rawHalfW * scale;
  const halfD = rawHalfD * scale;
  const topY  = (maxY - (minY + maxY) * 0.5) * scale;

  const localCX = (minX + maxX) * 0.5;
  const localCY = (minY + maxY) * 0.5;
  const localCZ = (minZ + maxZ) * 0.5;
  meshData.localCX = localCX;
  meshData.localCY = localCY;
  meshData.localCZ = localCZ;

  const faceCount = (meshData.indices.length / 3) | 0;
  const faces     = new Float32Array(faceCount * 9);
  const idx       = meshData.indices;

  for (let t = 0; t < faceCount; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    const base = t * 9;
    faces[base]     = (verts[i0*3]   - localCX) * scale;
    faces[base + 1] = (verts[i0*3+1] - localCY) * scale;
    faces[base + 2] = (verts[i0*3+2] - localCZ) * scale;
    faces[base + 3] = (verts[i1*3]   - localCX) * scale;
    faces[base + 4] = (verts[i1*3+1] - localCY) * scale;
    faces[base + 5] = (verts[i1*3+2] - localCZ) * scale;
    faces[base + 6] = (verts[i2*3]   - localCX) * scale;
    faces[base + 7] = (verts[i2*3+1] - localCY) * scale;
    faces[base + 8] = (verts[i2*3+2] - localCZ) * scale;
  }

  return {
    id: sourceId || null,
    meshData,
    faces,
    faceCount,
    scale,
    halfW,
    halfD,
    topY,
    localCX, localCY, localCZ,
  };
}
