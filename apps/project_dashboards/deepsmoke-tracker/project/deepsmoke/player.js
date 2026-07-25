// Deepsmoke — first-person player: movement, mouse-look, FP drill rig, drilling, items.
import * as THREE from 'three';
import { BLOCK, HARDNESS, SY, isUnbreakable } from './world.js';
import { gear, ORE_INFO, ORE_BLOCK_KEY } from './upgrades.js';
import { createInventory, ITEMS } from './inventory.js';
import { buildGoblin } from './partner.js';
import {
  disposePlayerRigModels,
  getPlayerModelPoseRef,
  registerPlayerRigModels,
  setFirstPersonRenderPriority,
} from './player-models.js';

// which blocks each tool family speeds up
const PICK = new Set([2, 3, 7, 19, 20, 21, 23, 12, 13, 14, 15, 30]);
const AXE = new Set([24, 25, 26, 27, 28]);

const TIER_COLORS = [0xb8c0cc, 0xb87333, 0x9aa2ae, 0xe3e8f0, 0xffd873];

// dominant texture color per block id — drill debris matches what you're chewing through
const BLOCK_COLORS = {
  1: 0xC4934A, 2: 0x7d7466, 3: 0x6b6156, 4: 0x60A5FA, 5: 0xffd873, 6: 0x41598f,
  7: 0x8a7a5c, 8: 0x6b6156, 9: 0x3b82f6, 10: 0x3c3a36, 11: 0xD4B483, 12: 0xb87333,
  13: 0x8d959e, 14: 0xd7dce4, 15: 0xe8b923, 16: 0x2a4ba0, 17: 0x5da03e, 18: 0xeef3f8,
  19: 0xa8d4f0, 20: 0xcfae74, 21: 0x4a5160, 22: 0x3fe0c8, 23: 0x8a3ad0, 36: 0x7a5b34,
};
const blockColor = id => BLOCK_COLORS[id] ?? 0xC4934A;
const HARD_LANDING_DROP = 10;
const HARD_LANDING_LOCK_S = 0.14;
const HARD_LANDING_SHAKE_S = 0.18;

export function createPlayer(scene, world, camera, audio, input, items, profile, renderer) {
  const p = profile || { drill: 0, tank: 0, plate: 0 };
  const ent = { pos: world.spawn.clone(), vel: new THREE.Vector3(), w: 0.6, h: 1.7, onGround: false, inWater: false, swimUp: false };
  const player = {
    ent, fuel: 100, cans: 1, locked: false, yaw: Math.PI, pitch: 0, drillProgress: 0,
    inv: { ores: { copper: 0, iron: 0, silver: 0, gold: 0 } },
    fuelMax: 100, drillSpeed: 1, mineTier: 1, hazardMult: 1, moveLockT: 0,
  };
  player.bag = createInventory(36);
  Object.defineProperty(player, 'selItem', { get: () => player.bag.selected() });
  player.refreshGear = () => {
    const g = gear(p);
    player.fuelMax = g.tank.cap;
    player.drillSpeed = g.drill.speed;
    player.mineTier = g.drill.mineTier;
    player.hazardMult = g.plate.mult;
    steelM.color.setHex(TIER_COLORS[p.drill] || TIER_COLORS[0]);
  };
  camera.rotation.order = 'YXZ';

  // ---------- first-person drill rig (attached to camera) ----------
  const rig = new THREE.Group();
  camera.add(rig);
  const mechMount = new THREE.Group();
  rig.add(mechMount);
  const cobaltM = new THREE.MeshLambertMaterial({ color: 0x2a4ba0 });
  const brassM = new THREE.MeshLambertMaterial({ color: 0xC4934A });
  const steelM = new THREE.MeshLambertMaterial({ color: 0xb8c0cc });
  const geos = [];
  const fallbackSuitMeshes = [];
  const mkBox = (w, h, d, mat, x, y, z, parent = rig) => {
    const g = new THREE.BoxGeometry(w, h, d); geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  // brass collar along bottom of view
  fallbackSuitMeshes.push(mkBox(1.3, 0.1, 0.5, brassM, 0, -0.62, -0.75));
  // left gauntlet
  fallbackSuitMeshes.push(mkBox(0.22, 0.2, 0.5, cobaltM, -0.42, -0.42, -0.75));
  fallbackSuitMeshes.push(mkBox(0.26, 0.1, 0.2, brassM, -0.42, -0.3, -0.62));
  // right gauntlet + drill
  const rightArm = new THREE.Group();
  rightArm.position.set(0.42, -0.42, -0.7);
  rig.add(rightArm);
  fallbackSuitMeshes.push(mkBox(0.24, 0.22, 0.55, cobaltM, 0, 0, 0, rightArm));
  fallbackSuitMeshes.push(mkBox(0.28, 0.12, 0.2, brassM, 0, 0.13, 0.1, rightArm));
  const drillPose0 = getPlayerModelPoseRef('drill') || { x: 0, y: 0, z: -0.5 };
  const drillMount = new THREE.Group();
  drillMount.position.set(drillPose0.x, drillPose0.y, drillPose0.z);
  rightArm.add(drillMount);
  const coneG = new THREE.ConeGeometry(0.11, 0.45, 10); geos.push(coneG);
  const drillBitFallback = new THREE.Mesh(coneG, steelM);
  drillBitFallback.rotation.x = -Math.PI / 2;
  drillMount.add(drillBitFallback);

  // cockpit pilot nested inside the mech body once the suit model mounts
  const cockpitPilot = buildGoblin({
    skin: 0x6fbf4a,
    suit: 0x2a4ba0,
    scale: 1,
    tool: 'drill',
    includeShell: false,
  });
  cockpitPilot.grp.visible = false;
  cockpitPilot.setAnim('idle');
  mechMount.add(cockpitPilot.grp);
  setFirstPersonRenderPriority(rig);

  const playerModelState = {
    disposed: false,
    hideCockpitPilot: true,
    mechMount,
    drillMount,
    drillFallback: drillBitFallback,
    fallbackSuitMeshes,
    cockpitPilot,
    mechModel: null,
    drillModel: null,
  };
  registerPlayerRigModels(playerModelState, renderer);

  // drill target highlight
  const hlGeo = new THREE.BoxGeometry(1.01, 1.01, 1.01); geos.push(hlGeo);
  const hlWire = new THREE.LineSegments(new THREE.EdgesGeometry(hlGeo), new THREE.LineBasicMaterial({ color: 0xffd873 }));
  const hlDark = new THREE.Mesh(hlGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 }));
  hlWire.visible = hlDark.visible = false;
  scene.add(hlWire); scene.add(hlDark);

  player.refreshGear();
  player.fuel = player.fuelMax;

  let drillKey = null, drillSfxT = 0, bobT = 0, throwT = 0, hardSayT = 0;
  let airPeakY = ent.pos.y, impactShakeT = 0;
  const STEP_STRIDE = 2.3; // world units of ground travel per stomp
  let stepDist = STEP_STRIDE * 0.55; // start mid-stride so the first stomp comes quick
  function playStomp(vol) {
    // slight pitch/volume wobble so each footfall reads as its own metal slab
    audio.play('sfx.stomp', { volume: vol + Math.random() * 0.12, rate: 0.92 + Math.random() * 0.16 });
  }
  const tmp = new THREE.Vector3(), fwd = new THREE.Vector3();

  function update(dt, grub, cb) {
    const drillPose = getPlayerModelPoseRef('drill') || drillPose0;
    // look
    const look = input.takeLook();
    if (!player.locked || true) { // locked suit: head can still move
      player.yaw -= look.dx;
      player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch + look.dy * -1));
    }
    camera.rotation.set(player.pitch, player.yaw, 0);

    const edges = { ...input.edges };
    input.consumeEdges();
    // hotbar selection: 1-9 keys + mouse wheel
    if (edges.slot >= 0) { player.bag.sel = edges.slot; player.bag.rev++; }
    if (edges.wheel) { player.bag.sel = ((player.bag.sel + edges.wheel) % 9 + 9) % 9; player.bag.rev++; }
    player.moveLockT = Math.max(0, player.moveLockT - dt);
    const moveLocked = player.moveLockT > 0;
    const wasOnGround = ent.onGround;

    // ---------- movement ----------
    if (!player.locked && !moveLocked) {
      const mv = input.move;
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
      const speed = 4.3;
      const wishX = (mv.z * -sin + mv.x * cos) * speed;
      const wishZ = (mv.z * -cos + mv.x * -sin) * speed;
      const acc = ent.onGround ? 14 : 6;
      ent.vel.x += (wishX - ent.vel.x) * Math.min(1, acc * dt);
      ent.vel.z += (wishZ - ent.vel.z) * Math.min(1, acc * dt);
      if (edges.jump && ent.onGround && !ent.inWater) { ent.vel.y = 8; audio.play('jump'); }
      ent.swimUp = ent.inWater && input.jumpHeld;
      const hSpeed = Math.hypot(ent.vel.x, ent.vel.z);
      bobT += hSpeed * dt * 2.2;
      // booming metallic footfalls — stride-driven so stomps match actual ground travel
      if (ent.onGround && !ent.inWater && hSpeed > 0.6) {
        stepDist += hSpeed * dt;
        if (stepDist >= STEP_STRIDE) { stepDist = 0; playStomp(0.5); }
      } else if (!ent.onGround) {
        stepDist = STEP_STRIDE * 0.55; // reset mid-stride while airborne
      }
    } else {
      ent.vel.x *= 0.8; ent.vel.z *= 0.8;
      ent.swimUp = false;
    }
    world.moveEntity(ent, dt);
    if (wasOnGround && !ent.onGround) {
      airPeakY = ent.pos.y;
    } else if (!ent.onGround) {
      airPeakY = Math.max(airPeakY, ent.pos.y);
    } else if (!wasOnGround && ent.onGround) {
      const drop = airPeakY - ent.pos.y;
      if (drop > HARD_LANDING_DROP && !ent.inWater) {
        player.moveLockT = Math.max(player.moveLockT, HARD_LANDING_LOCK_S);
        impactShakeT = HARD_LANDING_SHAKE_S;
        ent.vel.x *= 0.1;
        ent.vel.z *= 0.1;
        if (cb.onHardLanding) cb.onHardLanding({ drop, pos: ent.pos.clone() });
      } else if (drop > 1.2 && !ent.inWater) {
        playStomp(0.62); // ordinary landing thud (hard landings get the full impact mix in main)
      }
      airPeakY = ent.pos.y;
    } else {
      airPeakY = ent.pos.y;
    }
    camera.position.set(ent.pos.x, ent.pos.y + 1.55, ent.pos.z);

    // ---------- drilling ----------
    let drilling = false;
    hlWire.visible = hlDark.visible = false;
    player.drillProgress = 0;
    hardSayT = Math.max(0, hardSayT - dt);
    if (input.drill && !player.locked) {
      camera.getWorldDirection(fwd);
      tmp.copy(camera.position);
      const hit = world.raycast(tmp, fwd, 4.5);
      if (hit && !isUnbreakable(hit.id)) {
        drilling = true;
        const key = `${hit.x},${hit.y},${hit.z}`;
        if (drillKey !== key) { drillKey = key; player.progress = 0; }
        // tool in hand: pick/axe speed multiplier + pick tier can beat the drill's
        const selIt = player.bag.selected();
        const tool = selIt && ITEMS[selIt.id].tool;
        const toolFits = tool && ((tool.kind === 'pick' && PICK.has(hit.id)) || (tool.kind === 'axe' && AXE.has(hit.id)));
        const mult = toolFits ? tool.mult : 1;
        const effTier = Math.max(player.mineTier, tool && tool.kind === 'pick' ? (tool.tier || 0) : 0);
        const oreKey = ORE_BLOCK_KEY[hit.id];
        const tooHard = oreKey && ORE_INFO[oreKey].mineTier > effTier;
        if (tooHard) {
          player.progress = 0;
          if (Math.random() < dt * 6) {
            items.burst(new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5), 0xffffff, 2);
          }
          if (hardSayT <= 0) {
            hardSayT = 3;
            cb.say('YOU', `${ORE_INFO[oreKey].name} ore — too hard for this bit! Tub can fix that.`);
          }
        } else {
          player.progress = (player.progress || 0) + dt * player.drillSpeed * mult / (HARDNESS[hit.id] || 1);
          player.drillProgress = Math.min(1, player.progress);
        }
        // highlight
        hlWire.visible = hlDark.visible = true;
        hlWire.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
        hlDark.position.copy(hlWire.position);
        hlDark.material.opacity = tooHard ? 0.2 : player.progress * 0.55;
        // sfx + anim — bit shakes (no spin) and sprays block-colored debris
        drillMount.position.x = drillPose.x + (Math.random() - 0.5) * 0.05;
        drillMount.position.y = drillPose.y + (Math.random() - 0.5) * 0.05;
        drillMount.position.z = drillPose.z;
        if (!tooHard && Math.random() < dt * 16) {
          items.burst(new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5), blockColor(hit.id), 2);
        }
        drillSfxT -= dt;
        if (drillSfxT <= 0) { drillSfxT = 0.13; audio.play('sfx.drillNear'); }
        if (!tooHard && player.progress >= 1) {
          world.set(hit.x, hit.y, hit.z, BLOCK.AIR);
          const center = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
          audio.play('hit');
          items.burst(center, hit.id === BLOCK.RELIC ? 0x60A5FA : hit.id === BLOCK.CACHE ? 0xffd873 : blockColor(hit.id));
          if (hit.id === BLOCK.RELIC) items.spawnPickup('relic', center);
          if (hit.id === BLOCK.CACHE) items.spawnPickup('can', center);
          cb.onBlockBroken(hit, hit.id, 'player');
          drillKey = null; player.progress = 0;
        }
      } else drillKey = null;
    } else { drillKey = null; player.progress = 0; }

    // ---------- fuel drain ----------
    if (!player.locked) {
      let drain = 0.5;
      if (drilling) drain += 1.8 * (world.headInWater(ent) ? 2 : 1);
      player.fuel -= drain * dt;
      if (player.fuel <= 0) {
        player.fuel = 0;
        player.locked = true;
        cb.onLocked();
      }
    }

    // ---------- item actions ----------
    if (!player.locked) {
      if (edges.use && player.cans > 0) {
        player.cans--;
        player.fuel = Math.min(player.fuelMax, player.fuel + 40);
        audio.play('powerup');
        cb.say('YOU', '*GLUG* Fuel topped up!');
      }
      if (edges.place) {
        const s = player.bag.selected();
        if (!s) {
          cb.say('YOU', 'Nothing in hand — grab a block from the bag.');
        } else if (!ITEMS[s.id].block) {
          cb.say('YOU', "Can't place that.");
        } else {
          camera.getWorldDirection(fwd);
          tmp.copy(camera.position);
          const hit = world.raycast(tmp, fwd, 4.5);
          if (hit) {
            const pCell = hit.prev;
            const inB = pCell.y >= 0 && pCell.y < SY; // infinite world: only the vertical range is bounded
            const id = world.get(pCell.x, pCell.y, pCell.z);
            const placedId = ITEMS[s.id].block;
            if (placedId === BLOCK.TRACK) {
              const below = world.get(pCell.x, pCell.y - 1, pCell.z);
              if (pCell.y <= 0 || below === BLOCK.AIR || below === BLOCK.WATER) {
                cb.say('YOU', 'Tracks need solid ground.');
                return;
              }
            }
            if (inB &&
                (id === BLOCK.AIR || id === BLOCK.WATER) &&
                !world.entityOverlapsCell(ent, pCell.x, pCell.y, pCell.z) &&
                !(grub && world.entityOverlapsCell(grub.ent, pCell.x, pCell.y, pCell.z))) {
              world.set(pCell.x, pCell.y, pCell.z, placedId);
              player.bag.consumeSel();
              audio.play('sfx.place');
              if (cb.onBlockPlaced) cb.onBlockPlaced({ x: pCell.x, y: pCell.y, z: pCell.z }, placedId);
            }
          }
        }
      }
      if (edges.throw && player.cans > 0) {
        player.cans--;
        camera.getWorldDirection(fwd);
        tmp.copy(camera.position).addScaledVector(fwd, 0.6);
        items.throwCan(tmp, fwd);
        audio.play('swoosh');
        throwT = 0.35;
      }
      if (edges.transfer && grub) {
        const d = ent.pos.distanceTo(grub.ent.pos);
        if (d < 2.5) {
          if (grub.locked && (player.cans > 0 || player.fuel > 25)) {
            if (player.cans > 0) { player.cans--; grub.revive(40); }
            else { player.fuel -= 15; grub.revive(30); }
            audio.play('powerup');
            cb.say('YOU', 'Back on your feet, Grub!');
          } else if (player.cans > 0) {
            player.cans--; grub.cans++;
            audio.play('coin');
            cb.say('YOU', 'Spare can for ya, Grub.');
          } else if (player.fuel > 25) {
            player.fuel -= 15;
            grub.fuel = Math.min(100, grub.fuel + 15);
            audio.play('coin');
            cb.say('YOU', 'Sharing some steam.');
          }
        }
      }
    }

    // ---------- rig animation ----------
    const moving = Math.hypot(ent.vel.x, ent.vel.z) > 0.5;
    rig.position.y = (moving ? Math.sin(bobT * 2) * 0.022 : Math.sin(performance.now() * 0.0012) * 0.008);
    rig.position.x = moving ? Math.cos(bobT) * 0.012 : 0;
    rig.position.z = 0;
    if (impactShakeT > 0) {
      impactShakeT = Math.max(0, impactShakeT - dt);
      const k = impactShakeT / HARD_LANDING_SHAKE_S;
      rig.position.x += (Math.random() - 0.5) * 0.08 * k;
      rig.position.y += (Math.random() - 0.5) * 0.06 * k;
      rig.position.z += (Math.random() - 0.5) * 0.05 * k;
    }
    if (drilling) {
      rightArm.position.z = -0.74 + Math.sin(performance.now() * 0.045) * 0.03;
      rightArm.position.x = 0.42 + (Math.random() - 0.5) * 0.02;
      rightArm.position.y = -0.42 + (Math.random() - 0.5) * 0.02;
    } else {
      rightArm.position.set(0.42, -0.42, -0.7);
      drillMount.position.set(drillPose.x, drillPose.y, drillPose.z);
    }
    if (throwT > 0) {
      throwT -= dt;
      rightArm.rotation.x = Math.sin((0.35 - throwT) / 0.35 * Math.PI) * -0.9;
    } else rightArm.rotation.x = 0;
    cockpitPilot.updateAnim(dt);
  }

  function dispose() {
    disposePlayerRigModels(playerModelState);
    cockpitPilot.dispose();
    camera.remove(rig);
    scene.remove(hlWire); scene.remove(hlDark);
    geos.forEach(g => g.dispose());
    [cobaltM, brassM, steelM, hlDark.material, hlWire.material].forEach(m => m.dispose());
    hlWire.geometry.dispose();
  }

  player.update = update;
  player.dispose = dispose;
  return player;
}
