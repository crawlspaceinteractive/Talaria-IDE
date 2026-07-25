// Deepsmoke — shared ore_crystal GLB pipeline: ONE recolorable crystal-chunk model backs
// every ore drop (tinted per ore kind) and crystal drops (magenta). Clones share the
// template geometry and pull materials from a per-color cache, so spawning drops is cheap
// and nothing needs per-pickup disposal.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const ORE_CRYSTAL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/12ef78af-0280-4a59-b992-52c23b855564';
const TARGET_MAX_DIM = 0.46; // matches the old octahedron/mini-cube drop footprint

let template = null;
let loadPromise = null;
const tintedMats = new Map(); // `${hex}:${emissive}:${srcUuid}` -> shared tinted material

export function initOreCrystalModel(renderer) {
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/three-decoders/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath('/three-decoders/basis/');
  if (renderer) ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  loadPromise = new Promise(resolve => {
    loader.load(
      ORE_CRYSTAL_URL,
      gltf => {
        const root = gltf.scene;
        // normalize: fit the largest dimension, then center on the origin so drops
        // bob/spin around their middle exactly like the old procedural meshes.
        root.position.set(0, 0, 0);
        root.rotation.set(0, 0, 0);
        root.scale.set(1, 1, 1);
        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        if (Number.isFinite(maxDim)) root.scale.setScalar(TARGET_MAX_DIM / maxDim);
        root.updateMatrixWorld(true);
        const scaled = new THREE.Box3().setFromObject(root);
        root.position.sub(scaled.getCenter(new THREE.Vector3()));
        root.updateMatrixWorld(true);
        template = root;
        draco.dispose();
        ktx2.dispose();
        resolve(template);
      },
      undefined,
      err => {
        console.warn('ore_crystal load failed; drops keep procedural meshes.', err);
        draco.dispose();
        ktx2.dispose();
        resolve(null);
      },
    );
  });
  return loadPromise;
}

function tintedMat(src, color, emissiveIntensity) {
  const key = `${color.getHexString()}:${emissiveIntensity}:${src.uuid}`;
  let m = tintedMats.get(key);
  if (!m) {
    m = src.clone();
    if (m.color) m.color.copy(color);
    if (m.emissive) {
      m.emissive.copy(color);
      m.emissiveIntensity = emissiveIntensity;
    }
    tintedMats.set(key, m);
  }
  return m;
}

// Clone the crystal chunk recolored to `colorHex`. Returns null until the GLB is ready
// (callers keep their procedural fallback). The wrapper group scales safely around the
// normalized center offset.
export function buildOreCrystal(colorHex, { emissiveIntensity = 0.35, scale = 1 } = {}) {
  if (!template) return null;
  const color = new THREE.Color(colorHex);
  const inst = template.clone(true);
  inst.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    obj.material = Array.isArray(obj.material)
      ? obj.material.map(m => tintedMat(m, color, emissiveIntensity))
      : tintedMat(obj.material, color, emissiveIntensity);
  });
  const wrap = new THREE.Group();
  wrap.add(inst);
  if (scale !== 1) wrap.scale.setScalar(scale);
  return wrap;
}
