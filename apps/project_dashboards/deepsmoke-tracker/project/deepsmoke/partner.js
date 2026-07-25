// Deepsmoke — Grub, the AI goblin partner: shared goblin model, follow/fetch/rescue AI, fuel.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { BLOCK, HARDNESS, isUnbreakable } from './world.js';

const LINES = {
  low30: ["Gauge's wheezin', boss!", "Runnin' thin over here...", "Oi! Fuel's lookin' sad!"],
  low15: ["I'm on FUMES! Toss a can!", "She's gonna lock up, boss!!"],
  locked: ["*clank* ...suit's DEAD. Little help?!", "Locked solid! Don't leave me!"],
  gift: ["Take a swig o' mine!", "Here — you need it more!"],
  caught: ["Caught it! Nice arm!", "Got it, boss!"],
  rescue: ["Hang on, I got ya!", "Comin' for ya, boss!"],
  glug: ["*GLUG GLUG* Ahh, that's the stuff."],
};
const pick = a => a[(Math.random() * a.length) | 0];

const GOBLIN_MODEL_URL = '/api/games/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/assets/76a002d4-365e-4d18-8921-5d7c3109fc4d';
const GOBLIN_MODEL_HEIGHT = 1.42;

let goblinTemplate = null;
let goblinClips = [];
let goblinLoadPromise = null;
const pendingGoblinRigs = new Set();
const clipByIntentCache = new Map();

const CLIP_PRIORITY = {
  idle: ['idle', 'stand', 'breathe', 'look', 'wait', 'work', 'hammer', 'drill', 'walk'],
  walk: ['walk', 'run', 'move', 'idle', 'stand'],
  work: ['hammer', 'drill', 'work', 'mine', 'smith', 'craft', 'idle', 'stand'],
  drill: ['drill', 'mine', 'work', 'hammer', 'walk', 'idle'],
  hammer: ['hammer', 'smith', 'work', 'drill', 'idle'],
};
const CLIP_BLOCKLIST = ['death', 'dead', 'die', 'hurt', 'hit', 'stun', 'knock'];
const clampTint = v => Math.max(0, Math.min(2, Number.isFinite(Number(v)) ? Number(v) : 1));
const clampScale = v => Math.max(0.1, Math.min(4, Number.isFinite(Number(v)) ? Number(v) : 1));

function isBlockedClipName(name) {
  const lower = String(name || '').toLowerCase();
  return CLIP_BLOCKLIST.some(word => lower.includes(word));
}

function findClipByIntent(intent = 'idle') {
  if (!goblinClips.length) return null;
  const key = CLIP_PRIORITY[intent] ? intent : 'idle';
  if (clipByIntentCache.has(key)) return clipByIntentCache.get(key);
  const safe = goblinClips.filter(clip => !isBlockedClipName(clip.name));
  const pool = safe.length ? safe : goblinClips;
  let found = null;
  for (const token of CLIP_PRIORITY[key]) {
    found = pool.find(clip => String(clip.name || '').toLowerCase().includes(token));
    if (found) break;
  }
  if (!found) found = pool[0] || null;
  clipByIntentCache.set(key, found || null);
  return found || null;
}

function playRigAnimation(state, intent = 'idle', opts = {}) {
  state.animIntent = intent;
  state.animOpts = opts;
  if (!state.mixer) return false;
  const clip = findClipByIntent(intent) || findClipByIntent('idle');
  if (!clip) return false;
  let action = state.actions.get(clip);
  if (!action) {
    action = state.mixer.clipAction(clip);
    state.actions.set(clip, action);
  }
  const fade = Number.isFinite(opts.fade) ? Math.max(0, opts.fade) : 0.18;
  const timeScale = Number.isFinite(opts.timeScale) ? opts.timeScale : 1;
  const oneShot = !!opts.oneShot || opts.loop === false;
  if (state.currentAction === action) {
    action.timeScale = timeScale;
    if (!action.isRunning()) action.play();
    return true;
  }
  if (state.currentAction) state.currentAction.fadeOut(fade);
  action.reset();
  action.enabled = true;
  action.paused = false;
  action.timeScale = timeScale;
  action.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
  action.clampWhenFinished = oneShot;
  action.fadeIn(fade).play();
  state.currentAction = action;
  return true;
}

function applyProceduralMotion(state, dt = 0) {
  const proc = state.procedural;
  if (!proc || !state.body) return;
  const delta = Math.max(0, Number.isFinite(dt) ? dt : 0);
  proc.t += delta;
  const intent = state.animIntent || 'idle';
  let bobAmp = 0.012;
  let bobHz = 2.2;
  let pitchAmp = 0.025;
  let rollAmp = 0.012;
  if (intent === 'walk') {
    bobAmp = 0.03;
    bobHz = 8.8;
    pitchAmp = 0.05;
    rollAmp = 0.026;
  } else if (intent === 'work' || intent === 'drill' || intent === 'hammer') {
    bobAmp = 0.022;
    bobHz = 10.4;
    pitchAmp = 0.07;
    rollAmp = 0.036;
  }
  const phase = proc.t * bobHz;
  state.body.position.y = proc.baseY + Math.sin(phase) * bobAmp;
  state.body.rotation.x = proc.baseRotX + Math.sin(phase * 0.5) * pitchAmp;
  state.body.rotation.z = proc.baseRotZ + Math.cos(phase * 0.37) * rollAmp;
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

function normalizeGoblinModel(root) {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const bounds = meshBounds(root);
  const size = bounds.getSize(new THREE.Vector3());
  const h = Math.max(0.001, size.y);
  const s = GOBLIN_MODEL_HEIGHT / h;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  const scaled = meshBounds(root);
  root.position.x -= (scaled.min.x + scaled.max.x) * 0.5;
  root.position.z -= (scaled.min.z + scaled.max.z) * 0.5;
  root.position.y -= scaled.min.y;
  root.updateMatrixWorld(true);
}

function applyRigVisualState(state) {
  const tr = clampTint(state.tint.r);
  const tg = clampTint(state.tint.g);
  const tb = clampTint(state.tint.b);
  for (const m of state.mats) {
    if (!m || !m.color) continue;
    if (!m.userData.base) m.userData.base = m.color.clone();
    const base = m.userData.base;
    m.color.setRGB(base.r * tr, base.g * tg, base.b * tb);
  }
  state.grp.scale.setScalar(state.baseScale * clampScale(state.scaleMul));
}

function applyModelToRig(state) {
  if (!goblinTemplate || state.disposed || state.model) return;
  const clone = SkeletonUtils.clone(goblinTemplate);
  // Gameplay yaw code targets rigs whose visual "front" is -Z.
  // The uploaded goblin model comes in flipped relative to that contract.
  clone.rotation.y = Math.PI;
  clone.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(mat => {
        const m = mat.clone();
        if (m.color) m.userData.base = m.color.clone();
        state.mats.push(m);
        return m;
      });
    } else {
      const m = obj.material.clone();
      if (m.color) m.userData.base = m.color.clone();
      obj.material = m;
      state.mats.push(m);
    }
  });
  state.model = clone;
  state.body.add(clone);
  if (state.fallback) state.fallback.visible = false;
  applyRigVisualState(state);
  if (goblinClips.length) {
    state.mixer = new THREE.AnimationMixer(clone);
    state.actions = new Map();
    playRigAnimation(state, state.animIntent || 'idle', state.animOpts || {});
  }
}

export function initGoblinModel(renderer) {
  if (goblinLoadPromise) return goblinLoadPromise;
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('/three-decoders/draco/');
  loader.setDRACOLoader(draco);
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath('/three-decoders/basis/');
  if (renderer) ktx2.detectSupport(renderer);
  loader.setKTX2Loader(ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  goblinLoadPromise = new Promise(resolve => {
    loader.load(
      GOBLIN_MODEL_URL,
      (gltf) => {
        goblinTemplate = gltf.scene;
        goblinClips = Array.isArray(gltf.animations) ? gltf.animations.slice() : [];
        clipByIntentCache.clear();
        normalizeGoblinModel(goblinTemplate);
        for (const state of pendingGoblinRigs) applyModelToRig(state);
        pendingGoblinRigs.clear();
        draco.dispose();
        ktx2.dispose();
        resolve(goblinTemplate);
      },
      undefined,
      (err) => {
        console.warn('goblin_miner load failed, using voxel fallback rigs.', err);
        pendingGoblinRigs.clear();
        draco.dispose();
        ktx2.dispose();
        resolve(null);
      },
    );
  });
  return goblinLoadPromise;
}

// ---------- THE goblin drill-suit rig — Grub, Bub & Tub all share this exact model ----------
export function buildGoblin({ skin = 0x6fbf4a, suit = 0x1E3A8A, scale = 1, tool = 'drill', includeShell = true } = {}) {
  const grp = new THREE.Group();
  const body = new THREE.Group();
  grp.add(body);
  const fallback = includeShell ? new THREE.Group() : null;
  if (fallback) body.add(fallback);
  const mats = [], geos = [];
  const M = c => { const m = new THREE.MeshLambertMaterial({ color: c }); m.userData.base = new THREE.Color(c); mats.push(m); return m; };
  const skinM = includeShell ? M(skin) : null;
  const suitM = includeShell ? M(suit) : null;
  const brass = includeShell ? M(0xC4934A) : null;
  const steel = includeShell ? M(0x9aa2ad) : null;
  const dark = includeShell ? M(0x33260a) : null;
  const box = (w, h, d, mat, x, y, z, parent = body) => {
    const g = new THREE.BoxGeometry(w, h, d); geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const bodyBox = (w, h, d, mat, x, y, z, parent = fallback || body) => box(w, h, d, mat, x, y, z, parent);
  let head = null;
  let arm = null;
  let drill = null;
  if (includeShell) {
    // legs, body, head (feet at y=0)
    bodyBox(0.16, 0.3, 0.16, suitM, -0.13, 0.15, 0);
    bodyBox(0.16, 0.3, 0.16, suitM, 0.13, 0.15, 0);
    bodyBox(0.5, 0.5, 0.34, suitM, 0, 0.55, 0);
    bodyBox(0.54, 0.08, 0.38, brass, 0, 0.82, 0);       // collar
    bodyBox(0.26, 0.42, 0.18, brass, 0, 0.55, 0.24);    // back tank
    bodyBox(0.1, 0.14, 0.1, dark, 0, 0.82, 0.26);       // tank valve
    head = bodyBox(0.38, 0.34, 0.36, skinM, 0, 1.05, 0);
    bodyBox(0.12, 0.16, 0.04, skinM, -0.25, 1.12, 0, fallback); // ears
    bodyBox(0.12, 0.16, 0.04, skinM, 0.25, 1.12, 0, fallback);
    bodyBox(0.3, 0.1, 0.06, brass, 0, 1.12, -0.19);     // goggles band
    bodyBox(0.09, 0.09, 0.04, steel, -0.08, 1.12, -0.22);
    bodyBox(0.09, 0.09, 0.04, steel, 0.08, 1.12, -0.22);
    // right arm: drill or blacksmith hammer
    arm = new THREE.Group();
    arm.position.set(0.32, 0.62, -0.05);
    body.add(arm);
    box(0.14, 0.14, 0.3, suitM, 0, 0, -0.12, arm);
    if (tool === 'hammer') {
      box(0.05, 0.34, 0.05, M(0x8B6914), 0, 0.1, -0.3, arm);  // handle
      box(0.18, 0.1, 0.11, steel, 0, 0.28, -0.3, arm);        // head
    } else {
      const coneG = new THREE.ConeGeometry(0.11, 0.34, 8); geos.push(coneG);
      drill = new THREE.Mesh(coneG, steel);
      drill.rotation.x = -Math.PI / 2;
      drill.position.set(0, 0, -0.42);
      arm.add(drill);
    }
    // left arm
    bodyBox(0.13, 0.34, 0.13, suitM, -0.32, 0.5, 0);
    // suit badge keeps seat color readability for co-op even with a shared base mesh
    box(0.12, 0.12, 0.04, suitM, 0, 0.76, -0.24, body);
  }

  const rigState = {
    grp, body, fallback, mats, disposed: false, model: null,
    mixer: null, actions: new Map(), currentAction: null,
    animIntent: 'idle', animOpts: {},
    tint: { r: 1, g: 1, b: 1 },
    baseScale: scale,
    scaleMul: 1,
    procedural: { t: 0, baseY: body.position.y, baseRotX: body.rotation.x, baseRotZ: body.rotation.z },
  };
  if (goblinTemplate) applyModelToRig(rigState);
  else pendingGoblinRigs.add(rigState);

  applyRigVisualState(rigState);
  return {
    grp, body, head, arm, drill, mats, box, M,
    setAnim(intent, opts) { return playRigAnimation(rigState, intent, opts); },
    updateAnim(dt, opts = {}) {
      const delta = Math.max(0, Number.isFinite(dt) ? dt : 0);
      if (rigState.mixer) rigState.mixer.update(delta);
      if (opts.procedural === false) return;
      if (!rigState.mixer) applyProceduralMotion(rigState, delta);
    },
    setTextureRGB(r = 1, g = 1, b = 1) {
      rigState.tint.r = clampTint(r);
      rigState.tint.g = clampTint(g);
      rigState.tint.b = clampTint(b);
      applyRigVisualState(rigState);
    },
    setScaleMul(mult = 1) {
      rigState.scaleMul = clampScale(mult);
      applyRigVisualState(rigState);
    },
    setVisual({ r = 1, g = 1, b = 1, scale = 1 } = {}) {
      rigState.tint.r = clampTint(r);
      rigState.tint.g = clampTint(g);
      rigState.tint.b = clampTint(b);
      rigState.scaleMul = clampScale(scale);
      applyRigVisualState(rigState);
    },
    dispose() {
      rigState.disposed = true;
      pendingGoblinRigs.delete(rigState);
      geos.forEach(g => g.dispose());
      mats.forEach(m => m.dispose());
    },
  };
}

// floating sprite nametag — shared by Grub (here) and the camp NPCs (npcs.js imports this)
export function makeNameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 288; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,18,45,.78)'; g.fillRect(6, 8, 276, 48);
  g.strokeStyle = color; g.lineWidth = 3; g.strokeRect(6, 8, 276, 48);
  g.font = 'bold 26px "Pixelify Sans", sans-serif'; g.textAlign = 'center'; g.fillStyle = color;
  g.fillText(text, 144, 41);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.0, 0.44, 1);
  sprite.userData.dispose = () => { tex.dispose(); mat.dispose(); };
  return sprite;
}

export function createPartner(scene, world, audio, items) {
  // Grub wears the classic green-and-cobalt palette
  const rig = buildGoblin({ skin: 0x6fbf4a, suit: 0x1E3A8A });
  const { grp, body, arm, drill, mats } = rig;
  rig.setAnim('idle');
  const tag = makeNameTag('GRUB', '#6fbf4a');
  tag.position.set(0, 1.6, 0);
  grp.add(tag);
  scene.add(grp);

  // ---------- state ----------
  const ent = { pos: world.spawn.clone().add(new THREE.Vector3(1.2, 0, 0.6)), vel: new THREE.Vector3(), w: 0.55, h: 1.4, onGround: false, inWater: false, swimUp: false };
  const grub = {
    ent, mesh: grp, fuel: 100, cans: 1, locked: false,
    drilling: null, drillProgress: 0,
  };

  let said30 = false, said15 = false, saidLocked = false;
  let blockedT = 0, drillSfxT = 0, thinkT = 0, steamT = 0;
  let target = new THREE.Vector3();
  let mode = 'follow';
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

  function setLockedVisual(l) {
    for (const m of mats) {
      if (!m.color) continue;
      const base = m.userData.base || m.color;
      if (l) m.color.set(0x8a8a8a).lerp(base, 0.25);
      else m.color.copy(base);
    }
  }

  function say(cb, line) { cb.say('GRUB', line); }

  function frontCell(level) {
    const dir = tmp2.set(target.x - ent.pos.x, 0, target.z - ent.pos.z);
    if (dir.lengthSq() < 0.01) dir.set(-Math.sin(grp.rotation.y), 0, -Math.cos(grp.rotation.y)); // facing dir (front is -Z)
    dir.normalize();
    return {
      x: Math.floor(ent.pos.x + dir.x * 0.8),
      y: Math.floor(ent.pos.y + level),
      z: Math.floor(ent.pos.z + dir.z * 0.8),
    };
  }

  function update(dt, player, cb) {
    const pp = player.ent.pos;
    const dist = tmp.set(pp.x - ent.pos.x, 0, pp.z - ent.pos.z).length();
    const dist3 = ent.pos.distanceTo(pp);

    // fuel management
    if (!grub.locked) {
      grub.fuel -= 0.35 * dt + (grub.drilling ? 1.2 * dt : 0);
      if (grub.fuel <= 0) {
        grub.fuel = 0; grub.locked = true;
        setLockedVisual(true);
        if (!saidLocked) { say(cb, pick(LINES.locked)); saidLocked = true; }
      }
      if (grub.fuel < 35 && grub.cans > 0) {
        grub.cans--; grub.fuel = Math.min(100, grub.fuel + 40);
        say(cb, pick(LINES.glug));
        audio.play('powerup');
      }
      if (grub.fuel < 30 && !said30) { said30 = true; say(cb, pick(LINES.low30)); }
      if (grub.fuel < 15 && !said15) { said15 = true; say(cb, pick(LINES.low15)); }
      if (grub.fuel > 35) { said30 = false; said15 = false; }
    }

    if (grub.locked) {
      // steam sputter while dead
      steamT += dt;
      if (steamT > 0.5) { steamT = 0; items.steam(tmp.set(ent.pos.x, ent.pos.y + 1.2, ent.pos.z), 1); }
      ent.vel.x = 0; ent.vel.z = 0;
      world.moveEntity(ent, dt);
      grp.position.copy(ent.pos);
      rig.setAnim('idle', { fade: 0.12 });
      rig.updateAnim(dt, { procedural: false });
      return;
    }

    // auto-give fuel to struggling player
    if (player.fuel < 20 && !player.locked && dist3 < 2.5 && grub.fuel > 45) {
      grub.fuel -= 15;
      player.fuel = Math.min(player.fuelMax || 100, player.fuel + 15);
      say(cb, pick(LINES.gift));
      audio.play('coin');
    }

    // ---------- think ----------
    thinkT -= dt;
    if (thinkT <= 0) {
      thinkT = 0.4;
      mode = 'follow';
      target.copy(pp);
      if (player.locked) {
        mode = 'rescue';
      } else {
        // nearby pickup?
        let best = null, bd = 6;
        for (const p of items.pickups) {
          const d = p.pos.distanceTo(ent.pos);
          if (d < bd && Math.abs(p.pos.y - ent.pos.y) < 4) { bd = d; best = p; }
        }
        if (best && dist < 9) { mode = 'fetch'; target.copy(best.pos); }
      }
    }
    if (mode === 'rescue') target.copy(pp);

    // rescue transfer
    if (player.locked && dist3 < 2.2) {
      if (grub.cans > 0) {
        grub.cans--;
        player.fuel = Math.min(player.fuelMax || 100, player.fuel + 40);
        player.locked = false;
        say(cb, pick(LINES.rescue));
        audio.play('powerup');
      } else if (grub.fuel > 35) {
        grub.fuel -= 15;
        player.fuel = Math.min(player.fuelMax || 100, player.fuel + 15);
        player.locked = false;
        say(cb, pick(LINES.rescue));
        audio.play('coin');
      }
    }

    // ---------- steer ----------
    const desired = mode === 'follow' ? 4.5 : 0.4;
    tmp.set(target.x - ent.pos.x, 0, target.z - ent.pos.z);
    const td = tmp.length();
    let moving = false;
    const stop = mode === 'follow' && td < desired && td > 0 ? true : false;
    if (!stop && td > 0.3) {
      tmp.normalize();
      const sp = ent.inWater ? 2.2 : 3.6;
      ent.vel.x = tmp.x * sp;
      ent.vel.z = tmp.z * sp;
      grp.rotation.y = Math.atan2(tmp.x, tmp.z) + Math.PI; // model front is -Z
      moving = true;
    } else {
      ent.vel.x *= 0.7; ent.vel.z *= 0.7;
      if (dist > 0.5) grp.rotation.y = Math.atan2(pp.x - ent.pos.x, pp.z - ent.pos.z) + Math.PI;
    }
    // follow too far behind → catch up even if "stopped"
    if (mode === 'follow' && td > 6.5) moving = true;

    // jump / swim when blocked
    const speed2 = ent.vel.x * ent.vel.x + ent.vel.z * ent.vel.z;
    ent.swimUp = ent.inWater && (moving || target.y > ent.pos.y);
    const prevX = ent.pos.x, prevZ = ent.pos.z;
    world.moveEntity(ent, dt);
    const actuallyMoved = (ent.pos.x - prevX) ** 2 + (ent.pos.z - prevZ) ** 2;

    if (moving && speed2 > 1 && actuallyMoved < 0.0004) {
      if (ent.onGround) { ent.vel.y = 8; audio.play('jump'); }
      blockedT += dt;
    } else blockedT = Math.max(0, blockedT - dt * 2);

    // ---------- drilling ----------
    let wantDrill = null;
    if (blockedT > 0.6) {
      const c = frontCell(0.5);
      const c2 = frontCell(1.2);
      if (world.isSolidCell(c.x, c.y, c.z) && !isUnbreakable(world.get(c.x, c.y, c.z))) wantDrill = c;
      else if (world.isSolidCell(c2.x, c2.y, c2.z) && !isUnbreakable(world.get(c2.x, c2.y, c2.z))) wantDrill = c2;
    }
    if (!wantDrill && target.y < ent.pos.y - 2 && td < 1.5 && ent.onGround) {
      const u = { x: Math.floor(ent.pos.x), y: Math.floor(ent.pos.y) - 1, z: Math.floor(ent.pos.z) };
      if (world.isSolidCell(u.x, u.y, u.z) && !isUnbreakable(world.get(u.x, u.y, u.z))) wantDrill = u;
    }

    if (wantDrill) {
      const key = `${wantDrill.x},${wantDrill.y},${wantDrill.z}`;
      if (grub.drilling !== key) { grub.drilling = key; grub.drillProgress = 0; }
      const id = world.get(wantDrill.x, wantDrill.y, wantDrill.z);
      grub.drillProgress += dt / ((HARDNESS[id] || 1) * 1.2);
      if (drill) drill.rotation.z += dt * 22;
      if (arm) arm.position.z = -0.05 + Math.sin(performance.now() * 0.03) * 0.03;
      rig.setAnim('drill', { fade: 0.12, timeScale: 1.05 });
      drillSfxT -= dt;
      if (drillSfxT <= 0) {
        drillSfxT = 0.14;
        audio.play(dist3 < 6 ? 'sfx.drillNear' : dist3 < 14 ? 'sfx.drillMid' : 'sfx.drillFar');
      }
      if (grub.drillProgress >= 1) {
        world.set(wantDrill.x, wantDrill.y, wantDrill.z, BLOCK.AIR);
        cb.onBlockBroken(wantDrill, id, 'grub');
        grub.drilling = null; grub.drillProgress = 0; blockedT = 0;
      }
    } else {
      grub.drilling = null;
      if (arm) arm.position.z = -0.05;
      rig.setAnim(moving ? 'walk' : 'idle', { fade: 0.16 });
    }

    grp.position.copy(ent.pos);
    body.rotation.x = Math.sin(performance.now() * 0.002) * 0.06;
    rig.updateAnim(dt, { procedural: false });
  }

  function revive(fuel) {
    grub.fuel = Math.max(grub.fuel, fuel);
    grub.locked = false;
    saidLocked = false;
    setLockedVisual(false);
  }

  function dispose() {
    tag.userData.dispose();
    rig.dispose();
    scene.remove(grp);
  }

  grub.update = update;
  grub.revive = revive;
  grub.dispose = dispose;
  return grub;
}
