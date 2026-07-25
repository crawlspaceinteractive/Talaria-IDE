// Deepsmoke — pickups (relics, gas cans, ore, block items), thrown-can projectiles, particle pool.
import * as THREE from 'three';
import { ITEMS } from './inventory.js';
import { buildOreCrystal } from './ore-model.js';

const CRYSTAL_DROP_COLOR = 0xd45cf0; // magenta — matches the CRYSTAL block texture/emissive family

export function createItems(scene, world, audio, textures, icons) {
  // shared geometry/materials
  const relicGeo = new THREE.IcosahedronGeometry(0.22, 0);
  const relicMat = new THREE.MeshLambertMaterial({ color: 0x60A5FA, emissive: 0x2a55cc, emissiveIntensity: 0.9 });
  const torusGeo = new THREE.TorusGeometry(0.3, 0.045, 6, 14);
  const brassMat = new THREE.MeshLambertMaterial({ color: 0xC4934A, emissive: 0x53400f, emissiveIntensity: 0.4 });
  const canGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.34, 10);
  const canMat = new THREE.MeshLambertMaterial({ color: 0x1E3A8A, emissive: 0x102050, emissiveIntensity: 0.5 });
  const capGeo = new THREE.BoxGeometry(0.12, 0.1, 0.12);
  const oreGeo = new THREE.OctahedronGeometry(0.2, 0);
  const ORE_COLORS = { copper: 0xb87333, iron: 0x9aa2ae, silver: 0xe3e8f0, gold: 0xffd873 };
  const oreMats = {};
  for (const k of Object.keys(ORE_COLORS))
    oreMats[k] = new THREE.MeshLambertMaterial({ color: ORE_COLORS[k], emissive: ORE_COLORS[k], emissiveIntensity: 0.22 });

  // identity block drops: mini-cube with the block's own texture; tools/sticks are icon sprites
  const blockGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
  const blockMats = {}, spriteMats = {};
  function blockMat(kind) {
    if (!blockMats[kind]) blockMats[kind] = new THREE.MeshLambertMaterial({ map: textures[ITEMS[kind].tex] });
    return blockMats[kind];
  }
  function spriteMat(kind) {
    if (!spriteMats[kind]) {
      const t = new THREE.CanvasTexture(icons[kind]);
      t.magFilter = THREE.NearestFilter;
      spriteMats[kind] = new THREE.SpriteMaterial({ map: t, transparent: true });
    }
    return spriteMats[kind];
  }

  const pickups = [];
  const projectiles = [];

  function makeMesh(type, kind) {
    const g = new THREE.Group();
    if (type === 'block') {
      // crystal drops use the shared recolorable ore_crystal GLB (same system as ore chunks)
      const chunk = kind === 'crystal' ? buildOreCrystal(CRYSTAL_DROP_COLOR, { emissiveIntensity: 0.5 }) : null;
      if (chunk) g.add(chunk);
      else if (ITEMS[kind] && ITEMS[kind].tex) g.add(new THREE.Mesh(blockGeo, blockMat(kind)));
      else {
        const s = new THREE.Sprite(spriteMat(kind));
        s.scale.set(0.42, 0.42, 1);
        g.add(s);
      }
    } else if (type === 'relic') {
      g.add(new THREE.Mesh(relicGeo, relicMat));
      const t = new THREE.Mesh(torusGeo, brassMat);
      g.add(t);
      g.userData.torus = t;
    } else if (type === 'ore') {
      // ore chunks = the ore_crystal GLB recolored per ore kind (octahedron until it loads)
      const chunk = buildOreCrystal(ORE_COLORS[kind] || ORE_COLORS.copper);
      g.add(chunk || new THREE.Mesh(oreGeo, oreMats[kind] || oreMats.copper));
    } else {
      g.add(new THREE.Mesh(canGeo, canMat));
      const cap = new THREE.Mesh(capGeo, brassMat);
      cap.position.y = 0.21;
      g.add(cap);
    }
    return g;
  }

  function spawnPickup(type, pos, kind) {
    const mesh = makeMesh(type, kind);
    mesh.position.copy(pos);
    scene.add(mesh);
    pickups.push({ type, kind, mesh, pos: pos.clone(), t: Math.random() * 6 });
  }

  function removePickup(p) {
    scene.remove(p.mesh);
    const i = pickups.indexOf(p);
    if (i >= 0) pickups.splice(i, 1);
  }

  // ---------- ore flights: nuggets vacuumed out of the pack, arcing to the intake ----------
  const flights = [];
  function flyOre(kind, from, to, onArrive) {
    const mesh = makeMesh('ore', kind);
    mesh.position.copy(from);
    mesh.scale.setScalar(0.8);
    scene.add(mesh);
    flights.push({ mesh, pos: from.clone(), to: to.clone(), speed: 2.5, kind, onArrive, wob: Math.random() * 6 });
  }

  function throwCan(pos, dir) {
    const mesh = makeMesh('can');
    mesh.position.copy(pos);
    scene.add(mesh);
    const vel = dir.clone().normalize();
    vel.y += 0.35;
    vel.normalize().multiplyScalar(11.5);
    projectiles.push({ mesh, pos: pos.clone(), vel, life: 0 });
  }

  // ---------- particle pool ----------
  const MAXP = 300;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(MAXP * 3);
  const pCol = new Float32Array(MAXP * 3);
  for (let i = 0; i < MAXP; i++) pPos[i * 3 + 1] = -999;
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 0.9 }));
  points.frustumCulled = false;
  scene.add(points);
  const parts = [];
  for (let i = 0; i < MAXP; i++) parts.push({ alive: false, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, grav: 0 });
  let pCursor = 0;

  function emit(x, y, z, vx, vy, vz, life, r, g, b, grav) {
    const p = parts[pCursor];
    pCursor = (pCursor + 1) % MAXP;
    p.alive = true; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = 0; p.max = life; p.grav = grav;
    const i = parts.indexOf(p) * 3;
    pCol[i] = r; pCol[i + 1] = g; pCol[i + 2] = b;
  }

  const R = (s = 1) => (Math.random() - 0.5) * s;

  function burst(pos, color, n = 14) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++)
      emit(pos.x + R(0.6), pos.y + R(0.6), pos.z + R(0.6), R(4), 1.5 + R(3), R(4), 0.45 + Math.random() * 0.3, c.r, c.g, c.b, 9);
  }

  function steam(pos, n = 3) {
    for (let i = 0; i < n; i++)
      emit(pos.x + R(0.5), pos.y + R(0.2), pos.z + R(0.5), R(0.6), 1.6 + Math.random() * 1.4, R(0.6), 0.8 + Math.random() * 0.5, 0.9, 0.93, 0.97, -0.5);
  }

  function updateParticles(dt) {
    for (let i = 0; i < MAXP; i++) {
      const p = parts[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.max) { p.alive = false; pPos[i * 3 + 1] = -999; continue; }
      p.vy -= p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  // ---------- update ----------
  const tmp = new THREE.Vector3();

  function update(dt, ents, cb) {
    // pickups: bob, spin, magnet, collect
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      p.t += dt;
      p.mesh.rotation.y += dt * 2.2;
      if (p.mesh.userData.torus) p.mesh.userData.torus.rotation.x += dt * 3;
      p.mesh.position.copy(p.pos);
      p.mesh.position.y += Math.sin(p.t * 2.5) * 0.08;
      for (const who of ['player', 'grub']) {
        const e = ents[who];
        if (!e || e.locked) continue;
        tmp.set(e.ent.pos.x, e.ent.pos.y + e.ent.h * 0.5, e.ent.pos.z);
        const d = tmp.distanceTo(p.pos);
        if (d < 0.75) {
          if (cb.onPickup(who, p.type, p.pos, p.kind)) {
            burst(p.pos, p.type === 'relic' ? 0x60A5FA : p.type === 'ore' ? (ORE_COLORS[p.kind] || 0xb87333)
              : p.type === 'block' ? (p.kind === 'crystal' ? CRYSTAL_DROP_COLOR : 0xC4934A) : 0xffd873, 10);
            removePickup(p);
          }
          break;
        } else if (d < 1.6) {
          p.pos.lerp(tmp, Math.min(1, 6 * dt));
        }
      }
    }
    // vacuum ore flights
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.speed = Math.min(15, f.speed + 26 * dt);
      tmp.copy(f.to).sub(f.pos);
      const dist = tmp.length();
      const step = f.speed * dt;
      if (dist <= step + 0.18) {
        scene.remove(f.mesh);
        flights.splice(i, 1);
        burst(f.to, ORE_COLORS[f.kind] || 0xb87333, 6);
        if (f.onArrive) f.onArrive(f.kind);
      } else {
        f.wob += dt * 10;
        f.pos.addScaledVector(tmp.normalize(), step);
        f.mesh.position.copy(f.pos);
        f.mesh.position.y += Math.sin(f.wob) * 0.06;
        f.mesh.rotation.y += dt * 9;
        f.mesh.rotation.x += dt * 5;
      }
    }
    // thrown cans
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      pr.life += dt;
      pr.vel.y -= 18 * dt;
      pr.pos.addScaledVector(pr.vel, dt);
      pr.mesh.position.copy(pr.pos);
      pr.mesh.rotation.x += dt * 8;
      // grub catch
      const g = ents.grub;
      if (g && !g.locked) {
        tmp.set(g.ent.pos.x, g.ent.pos.y + 0.9, g.ent.pos.z);
        if (tmp.distanceTo(pr.pos) < 1.2) {
          scene.remove(pr.mesh); projectiles.splice(i, 1);
          if (cb.onGrubCatch) cb.onGrubCatch();
          audio.play('pickup');
          continue;
        }
      }
      // voxel hit or timeout → becomes pickup
      const cx = Math.floor(pr.pos.x), cyy = Math.floor(pr.pos.y), cz = Math.floor(pr.pos.z);
      if (world.isSolidCell(cx, cyy, cz) || pr.life > 6) {
        pr.pos.addScaledVector(pr.vel, -dt * 1.5);
        scene.remove(pr.mesh); projectiles.splice(i, 1);
        spawnPickup('can', pr.pos);
        audio.play('hit');
      }
    }
    updateParticles(dt);
  }

  function dispose() {
    for (const p of pickups) scene.remove(p.mesh);
    for (const p of projectiles) scene.remove(p.mesh);
    for (const f of flights) scene.remove(f.mesh);
    pickups.length = 0; projectiles.length = 0; flights.length = 0;
    scene.remove(points);
    pGeo.dispose();
    [relicGeo, torusGeo, canGeo, capGeo, oreGeo, blockGeo].forEach(g => g.dispose());
    [relicMat, brassMat, canMat, ...Object.values(oreMats), ...Object.values(blockMats)].forEach(m => m.dispose());
    for (const m of Object.values(spriteMats)) { m.map.dispose(); m.dispose(); }
  }

  return { spawnPickup, throwCan, flyOre, burst, steam, update, dispose, pickups };
}
