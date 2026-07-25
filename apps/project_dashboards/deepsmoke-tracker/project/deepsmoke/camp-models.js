import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ORE_VACUUM_MODEL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/988672f2-9bee-4e10-a2b0-8ec9d5db9d8e';
const BLACKSMITH_FORGE_MODEL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/a5112361-6e75-4314-b9c7-6a9b52ac984c';
const ORE_VACUUM_MODEL_HEIGHT = 1.62;
const BLACKSMITH_FORGE_MODEL_HEIGHT = 1.35;
const CAMP_MODEL_YAW_OFFSET = Math.PI;
const CAMP_PROP_DEFAULTS = {
  vacuum: { scale: 1.35, x: 0, y: 0, z: 0, yaw: Math.PI * 0.75 },
  forge: { scale: 1.25, x: 1, y: -0.12, z: 0, yaw: -29 * (Math.PI / 180) },
};
const CAMP_PROP_KEYS = ['scale', 'x', 'y', 'z', 'yaw'];
const CAMP_PROP_KINDS = Object.freeze(Object.keys(CAMP_PROP_DEFAULTS));
const campPropOverrides = Object.fromEntries(CAMP_PROP_KINDS.map(kind => [kind, { ...CAMP_PROP_DEFAULTS[kind] }]));

const campModelTemplates = { vacuum: null, forge: null };
let campModelsLoadPromise = null;
let campModelsRenderer = null;
const pendingCampModelStates = new Set();
const liveCampModelStates = new Set();

function clampFinite(n, fallback) {
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeCampProp(kind, value) {
  const base = CAMP_PROP_DEFAULTS[kind];
  const out = {};
  for (const key of CAMP_PROP_KEYS) out[key] = clampFinite(Number(value?.[key]), base[key]);
  out.scale = Math.max(0.05, out.scale);
  return out;
}

function getCampOverride(kind) {
  return campPropOverrides[kind] || CAMP_PROP_DEFAULTS[kind] || null;
}

function applyCampOverrideToModel(state) {
  if (!state.model) return;
  const override = getCampOverride(state.kind);
  if (!override) return;
  state.model.rotation.y = CAMP_MODEL_YAW_OFFSET + override.yaw;
  state.model.scale.setScalar(override.scale);
  state.model.position.set(override.x, override.y, override.z);
}

function meshBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let hasMesh = false;
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    if (!obj.geometry.boundingBox) return;
    tmp.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
    if (!hasMesh) { box.copy(tmp); hasMesh = true; }
    else box.union(tmp);
  });
  if (!hasMesh) box.setFromObject(root);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.min.y) || !Number.isFinite(box.min.z)) return null;
  if (!Number.isFinite(box.max.x) || !Number.isFinite(box.max.y) || !Number.isFinite(box.max.z)) return null;
  return box;
}

function normalizeCampModel(root, targetHeight) {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const bounds = meshBounds(root);
  if (!bounds) return false;
  const size = bounds.getSize(new THREE.Vector3());
  const h = Math.max(0.001, size.y);
  if (!Number.isFinite(h)) return false;
  root.scale.setScalar(targetHeight / h);
  root.updateMatrixWorld(true);
  const scaled = meshBounds(root);
  if (!scaled) return false;
  root.position.x -= (scaled.min.x + scaled.max.x) * 0.5;
  root.position.z -= (scaled.min.z + scaled.max.z) * 0.5;
  root.position.y -= scaled.min.y;
  root.updateMatrixWorld(true);
  return true;
}

function applyCampModel(state) {
  const template = campModelTemplates[state.kind];
  if (!template || state.disposed || state.model) return false;
  const clone = SkeletonUtils.clone(template);
  clone.traverse(obj => { if (obj.isMesh) obj.frustumCulled = false; });
  state.mount.add(clone);
  state.model = clone;
  applyCampOverrideToModel(state);
  if (state.fallback) state.fallback.visible = false;
  return true;
}

function flushPendingCampModelStates() {
  for (const state of pendingCampModelStates) {
    if (state.disposed || applyCampModel(state)) pendingCampModelStates.delete(state);
  }
}

export function registerCampModelState(states, kind, mount, fallback) {
  const state = { kind, mount, fallback, model: null, disposed: false };
  states.push(state);
  liveCampModelStates.add(state);
  if (!applyCampModel(state)) pendingCampModelStates.add(state);
}

export function disposeCampModelStates(states) {
  for (const state of states) {
    state.disposed = true;
    pendingCampModelStates.delete(state);
    liveCampModelStates.delete(state);
  }
}

export function getCampPropKinds() {
  return CAMP_PROP_KINDS.slice();
}

export function getCampPropOverride(kind) {
  const override = getCampOverride(kind);
  return override ? { ...override } : null;
}

export function getCampPropOverrides() {
  const out = {};
  for (const kind of CAMP_PROP_KINDS) out[kind] = getCampPropOverride(kind);
  return out;
}

export function setCampPropOverride(kind, patch) {
  if (!CAMP_PROP_DEFAULTS[kind]) return null;
  const merged = sanitizeCampProp(kind, { ...campPropOverrides[kind], ...(patch || {}) });
  campPropOverrides[kind] = merged;
  for (const state of liveCampModelStates) {
    if (state.kind !== kind || state.disposed) continue;
    applyCampOverrideToModel(state);
  }
  return { ...merged };
}

export function resetCampPropOverride(kind) {
  if (!CAMP_PROP_DEFAULTS[kind]) return null;
  return setCampPropOverride(kind, CAMP_PROP_DEFAULTS[kind]);
}

export function initCampPropModels(renderer) {
  if (renderer) campModelsRenderer = renderer;
  if (campModelTemplates.vacuum && campModelTemplates.forge) {
    flushPendingCampModelStates();
    return Promise.resolve(campModelTemplates);
  }
  if (campModelsLoadPromise) return campModelsLoadPromise;

  const needVacuum = !campModelTemplates.vacuum;
  const needForge = !campModelTemplates.forge;
  if (!needVacuum && !needForge) {
    flushPendingCampModelStates();
    return Promise.resolve(campModelTemplates);
  }

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/three-decoders/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath('/three-decoders/basis/');
  if (campModelsRenderer) ktx2.detectSupport(campModelsRenderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loadModel = (url, targetHeight, label) => new Promise(resolve => {
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        if (!normalizeCampModel(model, targetHeight)) {
          console.warn(`${label} normalization failed, attaching raw model transform.`);
          model.position.set(0, 0, 0);
          model.rotation.set(0, 0, 0);
          model.scale.setScalar(targetHeight);
        }
        resolve(model);
      },
      undefined,
      (err) => {
        console.warn(`${label} load failed, keeping fallback camp prop.`, err);
        resolve(null);
      },
    );
  });
  campModelsLoadPromise = Promise.all([
    needVacuum ? loadModel(ORE_VACUUM_MODEL_URL, ORE_VACUUM_MODEL_HEIGHT, 'ore_vacuum_station') : Promise.resolve(campModelTemplates.vacuum),
    needForge ? loadModel(BLACKSMITH_FORGE_MODEL_URL, BLACKSMITH_FORGE_MODEL_HEIGHT, 'blacksmiths_forge') : Promise.resolve(campModelTemplates.forge),
  ]).then(([vacuumModel, forgeModel]) => {
    if (vacuumModel) campModelTemplates.vacuum = vacuumModel;
    if (forgeModel) campModelTemplates.forge = forgeModel;
    flushPendingCampModelStates();
    return campModelTemplates;
  }).finally(() => {
    draco.dispose();
    ktx2.dispose();
    campModelsLoadPromise = null;
  });
  return campModelsLoadPromise;
}
