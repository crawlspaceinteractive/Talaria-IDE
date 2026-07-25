import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildGoblin } from './partner.js';

const PLAYER_MECH_MODEL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/6fe38633-d9de-4f87-93c6-6762998f0b30';
const PLAYER_DRILL_MODEL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/6adb59c3-63f8-4d1a-9b7d-1a54d7de9d9d';
const PLAYER_MECH_MODEL_HEIGHT = 2.6;
const PLAYER_DRILL_MODEL_LENGTH = 0.68;
export const FIRST_PERSON_LAYER = 1;
// MUST match player.js camera eye offset (`camera.position.set(pos.x, pos.y + 1.55, pos.z)`)
export const PLAYER_EYE_HEIGHT = 1.55;
const FIRST_PERSON_RENDER_ORDER = 10000;

const PLAYER_MODEL_POSE_DEFAULTS = Object.freeze({
  mech: Object.freeze({
    x: 0,
    y: -2,
    z: -0.15,
    scale: 1.5,
    pitchDeg: 0,
    yawDeg: 180,
    rollDeg: 0,
  }),
  pilot: Object.freeze({
    x: 0,
    y: 0.7,
    z: 0,
    scale: 0.55,
    pitchDeg: 0,
    yawDeg: 180,
    rollDeg: 0,
  }),
  drill: Object.freeze({
    x: 0.6,
    y: -0.5,
    z: -1.02,
    scale: 1,
    pitchDeg: 90,
    yawDeg: 180,
    rollDeg: 0,
  }),
  // Third-person mate rigs get their own drill pose (seeded from the FP drill
  // pose) so the drill bit can be positioned independently in each view.
  drillTP: Object.freeze({
    x: 0.4,
    y: -0.13,
    z: 0.51,
    scale: 0.85,
    pitchDeg: 90,
    yawDeg: 180,
    rollDeg: 0,
  }),
});

const DRILL_MODEL_BASE_ROT = Object.freeze({
  pitch: -Math.PI / 2,
  yaw: Math.PI,
  roll: 0,
});

const playerModelPoses = {
  mech: { ...PLAYER_MODEL_POSE_DEFAULTS.mech },
  pilot: { ...PLAYER_MODEL_POSE_DEFAULTS.pilot },
  drill: { ...PLAYER_MODEL_POSE_DEFAULTS.drill },
  drillTP: { ...PLAYER_MODEL_POSE_DEFAULTS.drillTP },
};

let playerMechTemplate = null;
let playerDrillTemplate = null;
let playerModelsLoadPromise = null;
let playerModelsRenderer = null;
const pendingPlayerModelStates = new Set();
const playerModelStates = new Set();

const toNum = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const toRad = deg => Number(deg || 0) * (Math.PI / 180);
const clampScale = (v, fallback = 1) => {
  const n = toNum(v, fallback);
  return Math.max(0.05, Math.min(6, n));
};

function copyPose(pose) {
  return {
    x: pose.x,
    y: pose.y,
    z: pose.z,
    scale: pose.scale,
    pitchDeg: pose.pitchDeg,
    yawDeg: pose.yawDeg,
    rollDeg: pose.rollDeg,
  };
}

function shouldShowCockpitPilot(state) {
  return !state || state.hideCockpitPilot !== true;
}

function sanitizePose(kind, next = {}) {
  const cur = playerModelPoses[kind];
  if (!cur) return null;
  return {
    x: toNum(next.x, cur.x),
    y: toNum(next.y, cur.y),
    z: toNum(next.z, cur.z),
    scale: clampScale(next.scale, cur.scale),
    pitchDeg: toNum(next.pitchDeg, cur.pitchDeg),
    yawDeg: toNum(next.yawDeg, cur.yawDeg),
    rollDeg: toNum(next.rollDeg, cur.rollDeg),
  };
}

export function setFirstPersonRenderPriority(root) {
  if (!root || !root.traverse) return;
  root.traverse(obj => {
    obj.layers.set(FIRST_PERSON_LAYER);
    if (obj.isMesh) {
      obj.frustumCulled = false;
      obj.renderOrder = FIRST_PERSON_RENDER_ORDER;
    }
  });
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
  return box;
}

function normalizeModel(root, targetHeight) {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const bounds = meshBounds(root);
  const size = bounds.getSize(new THREE.Vector3());
  const h = Math.max(0.001, size.y);
  if (!Number.isFinite(h)) return false;
  root.scale.setScalar(targetHeight / h);
  root.updateMatrixWorld(true);
  const scaled = meshBounds(root);
  root.position.x -= (scaled.min.x + scaled.max.x) * 0.5;
  root.position.z -= (scaled.min.z + scaled.max.z) * 0.5;
  root.position.y -= scaled.min.y;
  root.updateMatrixWorld(true);
  return true;
}

function applyPlayerPoseState(state) {
  if (!state || state.disposed) return;
  const mech = playerModelPoses.mech;
  state.mechMount.position.set(mech.x, mech.y, mech.z);
  state.mechMount.rotation.set(toRad(mech.pitchDeg), toRad(mech.yawDeg), toRad(mech.rollDeg));
  state.mechMount.scale.setScalar(mech.scale);

  const drill = state.thirdPerson ? playerModelPoses.drillTP : playerModelPoses.drill;
  state.drillMount.position.set(drill.x, drill.y, drill.z);
  state.drillMount.rotation.set(toRad(drill.pitchDeg), toRad(drill.yawDeg), toRad(drill.rollDeg));
  state.drillMount.scale.setScalar(drill.scale);

  const pilot = playerModelPoses.pilot;
  state.cockpitPilot.grp.position.set(pilot.x, pilot.y, pilot.z);
  state.cockpitPilot.grp.rotation.set(toRad(pilot.pitchDeg), toRad(pilot.yawDeg), toRad(pilot.rollDeg));
  state.cockpitPilot.grp.scale.setScalar(pilot.scale);
  state.cockpitPilot.grp.visible = shouldShowCockpitPilot(state);
}

function applyPlayerPosesToAll() {
  for (const state of playerModelStates) {
    if (state.disposed) {
      playerModelStates.delete(state);
      continue;
    }
    applyPlayerPoseState(state);
  }
}

// Third-person mate rigs get a suit-color tint (clone materials so the shared
// template + other mates stay untouched); clones are tracked for disposal.
function applyMechTint(state, root) {
  if (!state.mechTint && state.mechTint !== 0) return;
  const tint = new THREE.Color(state.mechTint);
  if (!state.tintedMats) state.tintedMats = [];
  root.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const clones = mats.map(m => {
      const c = m.clone();
      if (c.color) c.color.lerp(tint, 0.4);
      state.tintedMats.push(c);
      return c;
    });
    obj.material = Array.isArray(obj.material) ? clones : clones[0];
  });
}

function applyPlayerModelState(state) {
  if (state.disposed) return false;
  let changed = false;
  if (playerMechTemplate && !state.mechModel) {
    const mech = SkeletonUtils.clone(playerMechTemplate);
    if (state.thirdPerson) applyMechTint(state, mech);
    else setFirstPersonRenderPriority(mech);
    mech.position.set(0, 0, 0);
    mech.rotation.set(0, 0, 0);
    mech.scale.setScalar(1);
    state.mechMount.add(mech);
    state.mechModel = mech;
    for (const part of state.fallbackSuitMeshes) part.visible = false;
    state.cockpitPilot.grp.visible = shouldShowCockpitPilot(state);
    changed = true;
  }
  if (playerDrillTemplate && !state.drillModel) {
    const bit = SkeletonUtils.clone(playerDrillTemplate);
    if (!state.thirdPerson) setFirstPersonRenderPriority(bit);
    bit.position.set(0, 0, 0);
    bit.rotation.set(DRILL_MODEL_BASE_ROT.pitch, DRILL_MODEL_BASE_ROT.yaw, DRILL_MODEL_BASE_ROT.roll);
    bit.scale.setScalar(1);
    state.drillMount.add(bit);
    state.drillModel = bit;
    if (state.drillFallback) state.drillFallback.visible = false;
    changed = true;
  }
  applyPlayerPoseState(state);
  return changed;
}

function flushPendingPlayerModelStates() {
  for (const state of pendingPlayerModelStates) {
    if (state.disposed) {
      pendingPlayerModelStates.delete(state);
      continue;
    }
    applyPlayerModelState(state);
  }
}

function initPlayerModels(renderer) {
  if (renderer) playerModelsRenderer = renderer;
  if (playerMechTemplate && playerDrillTemplate) {
    flushPendingPlayerModelStates();
    return Promise.resolve({ mech: playerMechTemplate, drill: playerDrillTemplate });
  }
  if (playerModelsLoadPromise) return playerModelsLoadPromise;

  const needMech = !playerMechTemplate;
  const needDrill = !playerDrillTemplate;
  if (!needMech && !needDrill) {
    flushPendingPlayerModelStates();
    return Promise.resolve({ mech: playerMechTemplate, drill: playerDrillTemplate });
  }

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/three-decoders/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath('/three-decoders/basis/');
  if (playerModelsRenderer) ktx2.detectSupport(playerModelsRenderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);

  const loadModel = (url, targetHeight, label) => new Promise(resolve => {
    loader.load(
      url,
      gltf => {
        const model = gltf.scene;
        if (!normalizeModel(model, targetHeight)) {
          console.warn(`${label} normalization failed, using raw scale attach.`);
          model.scale.setScalar(targetHeight);
          model.position.set(0, 0, 0);
          model.rotation.set(0, 0, 0);
        }
        resolve(model);
      },
      undefined,
      err => {
        console.warn(`${label} load failed; keeping procedural first-person fallback.`, err);
        resolve(null);
      },
    );
  });

  playerModelsLoadPromise = Promise.all([
    needMech ? loadModel(PLAYER_MECH_MODEL_URL, PLAYER_MECH_MODEL_HEIGHT, 'goblin_mining_mech') : Promise.resolve(playerMechTemplate),
    needDrill ? loadModel(PLAYER_DRILL_MODEL_URL, PLAYER_DRILL_MODEL_LENGTH, 'mech_drill_bit') : Promise.resolve(playerDrillTemplate),
  ]).then(([mech, drill]) => {
    if (mech) playerMechTemplate = mech;
    if (drill) playerDrillTemplate = drill;
    flushPendingPlayerModelStates();
    return { mech: playerMechTemplate, drill: playerDrillTemplate };
  }).finally(() => {
    draco.dispose();
    ktx2.dispose();
    playerModelsLoadPromise = null;
  });
  return playerModelsLoadPromise;
}

export function getPlayerModelPose(kind) {
  const pose = playerModelPoses[kind];
  return pose ? copyPose(pose) : null;
}

export function getPlayerModelPoseRef(kind) {
  return playerModelPoses[kind] || null;
}

export function getPlayerModelPoses() {
  return {
    mech: copyPose(playerModelPoses.mech),
    pilot: copyPose(playerModelPoses.pilot),
    drill: copyPose(playerModelPoses.drill),
    drillTP: copyPose(playerModelPoses.drillTP),
  };
}

export function setPlayerModelPoseOverride(kind, next = {}) {
  const pose = sanitizePose(kind, next);
  if (!pose) return null;
  Object.assign(playerModelPoses[kind], pose);
  applyPlayerPosesToAll();
  return copyPose(playerModelPoses[kind]);
}

export function registerPlayerRigModels(state, renderer) {
  playerModelStates.add(state);
  applyPlayerModelState(state);
  if (!state.mechModel || !state.drillModel) pendingPlayerModelStates.add(state);
  initPlayerModels(renderer).then(() => {
    if (state.disposed) return;
    applyPlayerModelState(state);
  });
}

export function disposePlayerRigModels(state) {
  state.disposed = true;
  pendingPlayerModelStates.delete(state);
  playerModelStates.delete(state);
  if (state.tintedMats && state.tintedMats.length) {
    for (const m of state.tintedMats) m.dispose();
    state.tintedMats.length = 0;
  }
}

// Third-person crewmate rig: the FULL mech (suit GLB + drill GLB + visible goblin
// pilot) built on the SAME mount hierarchy as the first-person view, so the shared
// playerModelPoses (creator tunable sliders) drive both views identically.
//   grp (world root, position/yaw set by coop.tick)
//     └─ eye @ y=PLAYER_EYE_HEIGHT  (stands in for the FP camera)
//          ├─ mechMount  (pose: playerModelPoses.mech; contains mech GLB + pilot)
//          └─ rightArm @ (0.42,-0.42,-0.7)  (same hardpoint as player.js)
//               └─ drillMount  (pose: playerModelPoses.drill; contains drill GLB)
export function createMateMechRig({ tint } = {}) {
  const grp = new THREE.Group();
  const eye = new THREE.Group();
  eye.position.y = PLAYER_EYE_HEIGHT;
  grp.add(eye);
  const mechMount = new THREE.Group();
  eye.add(mechMount);
  const rightArm = new THREE.Group();
  rightArm.position.set(0.42, -0.42, -0.7);
  eye.add(rightArm);
  const drillMount = new THREE.Group();
  rightArm.add(drillMount);

  const pilot = buildGoblin({ includeShell: false });
  pilot.setAnim('idle');
  mechMount.add(pilot.grp);

  const state = {
    disposed: false,
    thirdPerson: true,
    hideCockpitPilot: false,
    mechMount,
    drillMount,
    drillFallback: null,
    fallbackSuitMeshes: [],
    cockpitPilot: pilot,
    mechModel: null,
    drillModel: null,
    mechTint: tint,
    tintedMats: [],
  };
  registerPlayerRigModels(state);

  return {
    grp,
    setAnim: (intent, opts) => pilot.setAnim(intent, opts),
    updateAnim: dt => pilot.updateAnim(dt),
    dispose() {
      disposePlayerRigModels(state);
      pilot.dispose();
    },
  };
}
