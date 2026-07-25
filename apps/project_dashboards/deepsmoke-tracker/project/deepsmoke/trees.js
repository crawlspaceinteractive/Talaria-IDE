// Deepsmoke — tree felling: cut trunk cells become a rigid group that tips over and scatters drops.
import * as THREE from 'three';
import { BLOCK } from './world.js';

export function createTrees(scene, world, items, audio, textures) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const logM = new THREE.MeshLambertMaterial({ map: textures.log });
  const leafM = new THREE.MeshLambertMaterial({ map: textures.leaf });
  const falling = [];
  const tmp = new THREE.Vector3();

  // baseCell: the cell the player cut. cells: [{x,y,z,id}] above it. dir: horizontal tip direction.
  function fell(baseCell, cells, dir, onDone) {
    if (!cells.length) return;
    const pivot = new THREE.Vector3(baseCell.x + 0.5, baseCell.y, baseCell.z + 0.5);
    const grp = new THREE.Group();
    grp.position.copy(pivot);
    for (const c of cells) {
      const m = new THREE.Mesh(geo, c.id === BLOCK.LOG ? logM : leafM);
      m.position.set(c.x + 0.5 - pivot.x, c.y + 0.5 - pivot.y, c.z + 0.5 - pivot.z);
      grp.add(m);
    }
    scene.add(grp);
    const d = dir.clone().setY(0);
    if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    d.normalize();
    // rotating around this axis tips the tree toward d
    const axis = new THREE.Vector3(d.z, 0, -d.x);
    falling.push({ grp, axis, angle: 0, vel: 0.4, cells, base: baseCell, onDone });
    audio.play('hit'); // trunk creak
  }

  function land(f) {
    f.grp.quaternion.setFromAxisAngle(f.axis, Math.PI / 2);
    f.grp.updateMatrixWorld(true);
    for (let j = 0; j < f.cells.length; j++) {
      const c = f.cells[j];
      f.grp.children[j].getWorldPosition(tmp);
      tmp.y = Math.max(f.base.y + 0.6, tmp.y);
      if (c.id === BLOCK.LOG) items.spawnPickup('block', tmp.clone(), 'log');
      else if (Math.random() < 0.5) items.spawnPickup('block', tmp.clone(), 'leaf');
    }
    items.burst(tmp, 0x8a7a5c, 14); // dust where it hit
    audio.play('sfx.rumble');
    scene.remove(f.grp);
    if (f.onDone) f.onDone();
  }

  function update(dt) {
    for (let i = falling.length - 1; i >= 0; i--) {
      const f = falling[i];
      f.vel += 4 * dt;
      f.angle += f.vel * dt;
      if (f.angle >= Math.PI / 2) {
        falling.splice(i, 1);
        land(f);
      } else {
        f.grp.quaternion.setFromAxisAngle(f.axis, f.angle);
      }
    }
  }

  function dispose() {
    for (const f of falling) scene.remove(f.grp);
    falling.length = 0;
    geo.dispose();
    logM.dispose();
    leafM.dispose();
  }

  return { fell, update, dispose };
}
