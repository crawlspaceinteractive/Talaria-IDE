// Deepsmoke — ambient meadow critters: chickens, pigs, cows, goats. No drops, no combat — pure life.
// Box-built, front at -Z (goblin convention), feet at y=0.
import * as THREE from 'three';

const TYPES = ['chicken', 'pig', 'cow', 'chicken', 'goat', 'pig', 'cow', 'chicken', 'goat', 'pig', 'cow', 'chicken'];

export function createMobs(scene, world, audio) {
  const group = new THREE.Group();
  scene.add(group);
  const geos = [], mats = [];
  const M = c => { const m = new THREE.MeshLambertMaterial({ color: c }); mats.push(m); return m; };
  const box = (w, h, d, mat, x, y, z, parent) => {
    const g = new THREE.BoxGeometry(w, h, d); geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  function build(type) {
    const grp = new THREE.Group();
    const legs = [];
    let w = 0.6, h = 0.8, head = null;
    if (type === 'chicken') {
      w = 0.35; h = 0.5;
      const white = M(0xf2f2ee), beakM = M(0xe8b923);
      box(0.3, 0.26, 0.4, white, 0, 0.28, 0.02, grp);
      head = box(0.18, 0.2, 0.18, white, 0, 0.5, -0.16, grp);
      box(0.06, 0.05, 0.1, beakM, 0, 0.48, -0.3, grp);
      box(0.05, 0.08, 0.1, M(0xd23c2a), 0, 0.62, -0.16, grp);
      legs.push(box(0.05, 0.16, 0.05, beakM, -0.07, 0.08, 0.04, grp));
      legs.push(box(0.05, 0.16, 0.05, beakM, 0.07, 0.08, 0.04, grp));
    } else if (type === 'pig') {
      w = 0.6; h = 0.6;
      const pink = M(0xe8a2a8);
      box(0.5, 0.34, 0.72, pink, 0, 0.38, 0, grp);
      head = box(0.3, 0.28, 0.26, pink, 0, 0.44, -0.48, grp);
      box(0.14, 0.1, 0.06, M(0xd88890), 0, 0.42, -0.63, grp);
      for (const sx of [-0.16, 0.16]) for (const sz of [-0.24, 0.24])
        legs.push(box(0.1, 0.22, 0.1, pink, sx, 0.11, sz, grp));
    } else if (type === 'cow') {
      w = 0.7; h = 0.85;
      const brown = M(0x6b4a2a), white = M(0xf2f2ee);
      box(0.55, 0.4, 0.85, brown, 0, 0.55, 0, grp);
      box(0.57, 0.18, 0.25, white, 0, 0.6, 0.18, grp);
      head = box(0.3, 0.3, 0.28, brown, 0, 0.72, -0.55, grp);
      box(0.22, 0.14, 0.08, white, 0, 0.64, -0.72, grp);
      box(0.08, 0.06, 0.06, M(0xe6e2d8), -0.16, 0.88, -0.5, grp);
      box(0.08, 0.06, 0.06, M(0xe6e2d8), 0.16, 0.88, -0.5, grp);
      for (const sx of [-0.18, 0.18]) for (const sz of [-0.28, 0.28])
        legs.push(box(0.12, 0.35, 0.12, brown, sx, 0.175, sz, grp));
    } else { // goat
      w = 0.55; h = 0.7;
      const gray = M(0x9a9a92);
      box(0.42, 0.32, 0.66, gray, 0, 0.45, 0, grp);
      head = box(0.24, 0.26, 0.24, gray, 0, 0.62, -0.42, grp);
      box(0.08, 0.1, 0.06, M(0xe6e2d8), 0, 0.48, -0.5, grp);
      box(0.05, 0.14, 0.05, M(0xd8d4c8), -0.08, 0.78, -0.38, grp);
      box(0.05, 0.14, 0.05, M(0xd8d4c8), 0.08, 0.78, -0.38, grp);
      for (const sx of [-0.13, 0.13]) for (const sz of [-0.2, 0.2])
        legs.push(box(0.09, 0.28, 0.09, gray, sx, 0.14, sz, grp));
    }
    return { grp, legs, head, w, h };
  }

  const mobs = [];
  for (let i = 0; i < TYPES.length; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 12 + Math.random() * 24;
    const x = world.spawn.x + Math.cos(a) * r;
    const z = world.spawn.z + Math.sin(a) * r;
    const y = world.heightAt(x, z) + 0.01;
    const b = build(TYPES[i]);
    b.grp.position.set(x, y, z);
    b.grp.rotation.y = Math.random() * Math.PI * 2;
    group.add(b.grp);
    mobs.push({
      ...b, headY0: b.head ? b.head.position.y : 0,
      ent: { pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), w: b.w, h: b.h, onGround: false, inWater: false, swimUp: false },
      timer: 1 + Math.random() * 4, dir: new THREE.Vector3(), moving: false, anim: Math.random() * 6,
    });
  }

  const SPEED = 1.2;

  function update(dt) {
    for (const m of mobs) {
      m.timer -= dt; m.anim += dt;
      if (m.timer <= 0) {
        m.timer = 2 + Math.random() * 3;
        if (Math.random() < 0.5) m.moving = false;
        else {
          const a = Math.random() * Math.PI * 2;
          m.dir.set(Math.sin(a), 0, Math.cos(a));
          m.moving = true;
        }
      }
      if (m.moving) {
        m.ent.vel.x += (m.dir.x * SPEED - m.ent.vel.x) * Math.min(1, 8 * dt);
        m.ent.vel.z += (m.dir.z * SPEED - m.ent.vel.z) * Math.min(1, 8 * dt);
      } else {
        m.ent.vel.x *= 0.85; m.ent.vel.z *= 0.85;
      }
      const px = m.ent.pos.x, pz = m.ent.pos.z;
      world.moveEntity(m.ent, dt);
      // hop when a block stops the stroll
      if (m.moving && m.ent.onGround) {
        const moved = Math.hypot(m.ent.pos.x - px, m.ent.pos.z - pz);
        if (moved < SPEED * dt * 0.25) m.ent.vel.y = 7;
      }
      m.grp.position.copy(m.ent.pos);
      if (m.moving) {
        const want = Math.atan2(m.ent.vel.x, m.ent.vel.z) + Math.PI; // front is -Z
        let d = want - m.grp.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        m.grp.rotation.y += d * Math.min(1, 6 * dt);
      }
      const sp = Math.hypot(m.ent.vel.x, m.ent.vel.z);
      for (let i = 0; i < m.legs.length; i++)
        m.legs[i].rotation.x = sp > 0.15 ? Math.sin(m.anim * 8 + i * Math.PI) * 0.6 : 0;
      if (m.head) m.head.position.y = m.headY0 + (sp > 0.15 ? 0 : Math.sin(m.anim * 1.5) * 0.02);
    }
  }

  function dispose() {
    scene.remove(group);
    geos.forEach(g => g.dispose());
    mats.forEach(m => m.dispose());
    mobs.length = 0;
  }

  return { update, dispose };
}
