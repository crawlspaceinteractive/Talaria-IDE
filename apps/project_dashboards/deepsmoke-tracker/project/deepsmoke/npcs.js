// Deepsmoke — surface HQ camp: Bub & Tub (shared goblin model rigs from partner.js), campfire, tents, ore vacuum.
import * as THREE from 'three';
import { disposeCampModelStates, initCampPropModels, registerCampModelState } from './camp-models.js';
import { buildGoblin, makeNameTag } from './partner.js';

export function createNPCs(scene, world, items, profile, renderer) {
  initCampPropModels(renderer);
  const group = new THREE.Group();
  scene.add(group);
  const disposables = [];
  const campModelStates = [];
  const M = c => { const m = new THREE.MeshLambertMaterial({ color: c }); disposables.push(m); return m; };
  const box = (w, h, d, mat, x, y, z, parent) => {
    const g = new THREE.BoxGeometry(w, h, d); disposables.push(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const clampTint = v => Math.max(0, Math.min(2, Number.isFinite(Number(v)) ? Number(v) : 1));
  const clampScale = v => Math.max(0.3, Math.min(3, Number.isFinite(Number(v)) ? Number(v) : 1));

  // nametag sprites live in partner.js now (Grub shares them)
  function nameTag(text, color) {
    const s = makeNameTag(text, color);
    disposables.push({ dispose: s.userData.dispose });
    return s;
  }

  // ---------- prop colliders (fed to world.setColliders — solid camp furniture) ----------
  const colliders = [];
  const coll = (cx, cz, w, d, h, y0) => colliders.push({
    x0: cx - w / 2, y0, z0: cz - d / 2, x1: cx + w / 2, y1: y0 + h, z1: cz + d / 2,
  });

  // ---------- camp layout around spawn (flattened clearing) ----------
  const base = world.spawn;
  const cy = base.y - 0.01; // camp ground level
  const at = (dx, dz) => new THREE.Vector3(base.x + dx, cy, base.z + dz);

  // --- campfire: stone ring, crossed logs, animated flames + flicker light ---
  const firePos = at(0.2, -2.3);
  const fire = new THREE.Group();
  fire.position.copy(firePos);
  group.add(fire);
  const stoneM = M(0x8a8378);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    box(0.22, 0.16, 0.22, stoneM, Math.cos(a) * 0.62, 0.08, Math.sin(a) * 0.62, fire);
  }
  const logM = M(0x6b4a2a);
  const log1 = box(0.9, 0.13, 0.13, logM, 0, 0.12, 0, fire); log1.rotation.y = 0.5;
  const log2 = box(0.9, 0.13, 0.13, logM, 0, 0.2, 0, fire); log2.rotation.y = -0.7;
  const flameM = new THREE.MeshLambertMaterial({ color: 0xffa030, emissive: 0xff6a10, emissiveIntensity: 1.2, transparent: true, opacity: 0.92 });
  const flameM2 = new THREE.MeshLambertMaterial({ color: 0xffd873, emissive: 0xffb020, emissiveIntensity: 1.4, transparent: true, opacity: 0.9 });
  disposables.push(flameM, flameM2);
  const flame1 = box(0.34, 0.44, 0.34, flameM, 0, 0.45, 0, fire);
  const flame2 = box(0.18, 0.3, 0.18, flameM2, 0.04, 0.62, -0.03, fire);
  const fireLight = new THREE.PointLight(0xff9540, 18, 11, 1.8);
  fireLight.position.set(0, 0.8, 0);
  fire.add(fireLight);
  coll(firePos.x, firePos.z, 1.3, 1.3, 0.5, cy);

  // --- tents: A-frame canvas, one brass-brown, one cobalt, one small ---
  function tent(pos, ry, canvasC, w = 1.9, h = 1.3, d = 2.0) {
    const t = new THREE.Group();
    t.position.copy(pos);
    t.rotation.y = ry;
    const cm = M(canvasC);
    const panelW = Math.hypot(w / 2, h) + 0.12;
    const left = box(panelW, 0.07, d, cm, 0, 0, 0, t);
    left.rotation.z = Math.atan2(h, w / 2);
    left.position.set(-w / 4, h / 2, 0);
    const right = box(panelW, 0.07, d, cm, 0, 0, 0, t);
    right.rotation.z = -Math.atan2(h, w / 2);
    right.position.set(w / 4, h / 2, 0);
    box(w * 0.72, h * 0.72, 0.06, M(0x3d3428), 0, h * 0.36, -d / 2 + 0.04, t); // back wall
    box(0.07, 0.07, d + 0.24, M(0x8B6914), 0, h + 0.02, 0, t);                 // ridge pole
    box(w + 0.5, 0.05, d + 0.5, M(0x7a6a4a), 0, 0.03, 0.1, t);                 // ground mat
    group.add(t);
    const f = Math.max(w, d); // rotated → approximate square footprint
    coll(pos.x, pos.z, f, f, h, cy);
    return t;
  }
  tent(at(-3.4, -4.0), 0.45, 0x9a6b35);
  tent(at(3.1, -4.2), -0.4, 0x2a4ba0);
  tent(at(-0.2, -5.0), 0.05, 0xb08948, 1.3, 0.95, 1.4);

  // --- crates & barrel clutter ---
  const c1 = at(1.5, -3.4), c2 = at(1.95, -2.9);
  box(0.55, 0.5, 0.55, M(0x8B6914), c1.x, cy + 0.25, c1.z, group);
  box(0.4, 0.36, 0.4, M(0xa07a3a), c2.x, cy + 0.18, c2.z, group);
  coll(c1.x, c1.z, 0.55, 0.55, 0.5, cy);
  coll(c2.x, c2.z, 0.4, 0.4, 0.36, cy);

  // ---------- TUB, the blacksmith ----------
  const tubPos = at(-2.7, 0.6);
  const tub = buildGoblin({ skin: 0xe8c93f, suit: 0x6b4a2a, scale: 1.2, tool: 'hammer', includeShell: false });
  tub.grp.position.copy(tubPos);
  // NB: Object3D.add() returns the PARENT — chaining .position.set() on it used to
  // teleport the whole goblin to the world origin (the "Bub & Tub invisible" bug).
  const tubTag = nameTag('TUB · BLACKSMITH', '#f0d868');
  tubTag.position.set(0, 1.7, 0);
  tub.grp.add(tubTag);
  group.add(tub.grp);
  // blacksmith forge station (GLB with fallback anvil+brazier)
  const forgePos = at(-3.6, 1.4);
  const forge = new THREE.Group();
  forge.position.copy(forgePos);
  group.add(forge);
  const forgeModel = new THREE.Group();
  forge.add(forgeModel);
  const forgeFallback = new THREE.Group();
  forge.add(forgeFallback);
  box(0.5, 0.2, 0.35, M(0x3c3a36), 0, 0.35, 0, forgeFallback);
  box(0.24, 0.3, 0.24, M(0x55524c), 0, 0.15, 0, forgeFallback);
  const brazier = new THREE.Group();
  brazier.position.set(1.8, 0, 0.2);
  forgeFallback.add(brazier);
  box(0.4, 0.3, 0.4, M(0x6b6156), 0, 0.15, 0, brazier);
  const emberM = new THREE.MeshLambertMaterial({ color: 0xff8830, emissive: 0xdd5510, emissiveIntensity: 1 });
  disposables.push(emberM);
  const ember = box(0.3, 0.12, 0.3, emberM, 0, 0.33, 0, brazier);
  registerCampModelState(campModelStates, 'forge', forgeModel, forgeFallback);
  const anvilPos = forgePos.clone();
  coll(anvilPos.x, anvilPos.z, 0.6, 0.6, 0.6, cy);
  coll(anvilPos.x + 1.8, anvilPos.z + 0.2, 0.5, 0.5, 0.6, cy);
  coll(tubPos.x, tubPos.z, 0.55, 0.55, 1.5, cy); // Tub himself is solid

  // ---------- BUB, the HQ attendant ----------
  const bubPos = at(2.6, 0.9);
  const bub = buildGoblin({ skin: 0xe8853a, suit: 0x1E3A8A, scale: 0.95, tool: 'drill', includeShell: false });
  bub.grp.position.copy(bubPos);
  const bubTag = nameTag('BUB · HQ', '#ffa868');
  bubTag.position.set(0, 1.7, 0);
  bub.grp.add(bubTag);
  group.add(bub.grp);
  coll(bubPos.x, bubPos.z, 0.55, 0.55, 1.5, cy); // Bub too

  // ---------- THE ORE VACUUM — brass slurper that banks yer nuggets ----------
  const vacPos = at(3.9, 2.4);
  const vac = new THREE.Group();
  vac.position.copy(vacPos);
  group.add(vac);
  const vacModel = new THREE.Group();
  vac.add(vacModel);
  const vacFallback = new THREE.Group();
  vac.add(vacFallback);
  const cylG = new THREE.CylinderGeometry(0.42, 0.48, 0.9, 12); disposables.push(cylG);
  const tank = new THREE.Mesh(cylG, M(0xC4934A));
  tank.position.y = 0.45;
  vacFallback.add(tank);
  box(0.5, 0.08, 0.5, M(0x8B6914), 0, 0.94, 0, vacFallback);       // lid rim
  const funG = new THREE.ConeGeometry(0.34, 0.5, 10); disposables.push(funG);
  const funnel = new THREE.Mesh(funG, M(0x9aa2ad));
  funnel.rotation.x = Math.PI;                                      // wide mouth up
  funnel.position.set(0, 1.28, 0);
  vacFallback.add(funnel);
  box(0.12, 0.6, 0.12, M(0x6b6156), 0.42, 0.3, 0.3, vacFallback);   // exhaust pipe
  box(0.2, 0.1, 0.2, M(0x6b6156), 0.42, 0.62, 0.3, vacFallback);
  const gaugeM = new THREE.MeshLambertMaterial({ color: 0xf2e6c8, emissive: 0x8a6a10, emissiveIntensity: 0.4 });
  disposables.push(gaugeM);
  box(0.16, 0.16, 0.05, gaugeM, 0, 0.6, -0.46, vacFallback);        // gauge face
  registerCampModelState(campModelStates, 'vacuum', vacModel, vacFallback);
  const vacSign = nameTag('ORE VACUUM', '#ffd873');
  vacSign.position.set(0, 1.85, 0);
  vac.add(vacSign);
  const vacuumIntake = vacPos.clone().add(new THREE.Vector3(0, 1.45, 0));
  coll(vacPos.x, vacPos.z, 1.0, 1.0, 1.4, cy);

  // ---------- STEAM HAULER dock: locomotive + segment cargo carts ----------
  const haulerPos = at(6.1, 1.4);
  const hauler = new THREE.Group();
  hauler.position.copy(haulerPos);
  group.add(hauler);
  const wheelM = M(0x3c3a36), brassM = M(0xC4934A), steelM = M(0x9aa2ad), woodM = M(0xa07a3a);
  const loco = new THREE.Group();
  hauler.add(loco);
  box(1.2, 0.22, 0.9, steelM, 0, 0.22, 0, loco);          // frame
  box(0.66, 0.58, 0.66, brassM, -0.05, 0.58, 0, loco);    // boiler
  box(0.36, 0.46, 0.62, steelM, 0.46, 0.58, 0, loco);     // cab
  box(0.22, 0.42, 0.22, wheelM, -0.38, 1.02, 0, loco);    // chimney
  box(0.18, 0.1, 0.18, brassM, -0.38, 1.27, 0, loco);
  const driveWheels = [
    box(0.22, 0.22, 0.12, wheelM, -0.35, 0.12, 0.34, loco),
    box(0.22, 0.22, 0.12, wheelM, -0.35, 0.12, -0.34, loco),
    box(0.22, 0.22, 0.12, wheelM, 0.35, 0.12, 0.34, loco),
    box(0.22, 0.22, 0.12, wheelM, 0.35, 0.12, -0.34, loco),
  ];
  const cartGroup = new THREE.Group();
  hauler.add(cartGroup);
  let haulerCarts = 1;
  let haulerActive = false;
  let haulerBuilt = false;
  hauler.visible = false;
  const haulerWhistle = haulerPos.clone().add(new THREE.Vector3(-0.38, 1.27, 0));
  const haulerDockPos = haulerPos.clone().add(new THREE.Vector3(0, 0, 1.35));
  const haulerChestCell = {
    x: Math.floor(haulerPos.x + 1),
    y: Math.floor(cy),
    z: Math.floor(haulerPos.z - 1),
  };
  function rebuildHaulerCarts(count) {
    while (cartGroup.children.length) cartGroup.remove(cartGroup.children[0]);
    for (let i = 0; i < count; i++) {
      const c = new THREE.Group();
      c.position.set(1.45 + i * 1.05, 0, 0);
      box(0.94, 0.14, 0.72, steelM, 0, 0.14, 0, c);
      box(0.86, 0.28, 0.08, woodM, 0, 0.34, 0.32, c);
      box(0.86, 0.28, 0.08, woodM, 0, 0.34, -0.32, c);
      box(0.08, 0.28, 0.72, woodM, -0.43, 0.34, 0, c);
      box(0.08, 0.28, 0.72, woodM, 0.43, 0.34, 0, c);
      box(0.12, 0.12, 0.08, wheelM, -0.3, 0.08, 0.34, c);
      box(0.12, 0.12, 0.08, wheelM, -0.3, 0.08, -0.34, c);
      box(0.12, 0.12, 0.08, wheelM, 0.3, 0.08, 0.34, c);
      box(0.12, 0.12, 0.08, wheelM, 0.3, 0.08, -0.34, c);
      cartGroup.add(c);
    }
  }
  rebuildHaulerCarts(haulerCarts);
  // Hauler is commissioned later; avoid an invisible default collider.

  // ---------- camp PROJECTS (rebuilt whenever a project finishes) ----------
  const has = k => !!(profile && profile.projects && profile.projects[k]);
  let boilerChimney = null;

  if (has('palisade')) {
    // palisade: ring of log posts with a south entrance gap + cobalt banner
    const postM = M(0x6b4a2a);
    const R = 6;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const px = Math.cos(a) * R, pz = Math.sin(a) * R;
      if (pz > R * 0.55 && Math.abs(px) < 2.4) continue; // gate gap
      const h = 1.25 + ((i * 7) % 5) * 0.09;
      box(0.32, h, 0.32, postM, base.x + px, cy + h / 2, base.z + pz, group);
      coll(base.x + px, base.z + pz, 0.32, 0.32, h, cy);
    }
    const pole = at(2.2, -5.2);
    box(0.12, 2.6, 0.12, M(0x8B6914), pole.x, cy + 1.3, pole.z, group);
    box(0.7, 0.42, 0.05, M(0x2a4ba0), pole.x + 0.41, cy + 2.3, pole.z, group);
  }
  let depotPos = null;
  if (has('depot')) {
    // fuel depot: can rack by the fire — 2 posts, shelf, 3 cobalt cans
    depotPos = at(1.0, 2.2);
    const rack = new THREE.Group();
    rack.position.copy(depotPos);
    const postM = M(0x8B6914);
    box(0.1, 1.1, 0.1, postM, -0.55, 0.55, 0, rack);
    box(0.1, 1.1, 0.1, postM, 0.55, 0.55, 0, rack);
    box(1.3, 0.08, 0.45, M(0xa07a3a), 0, 0.72, 0, rack);
    const canM = M(0x2a4ba0), capM = M(0xC4934A);
    for (let i = -1; i <= 1; i++) {
      box(0.26, 0.34, 0.26, canM, i * 0.4, 0.93, 0, rack);
      box(0.1, 0.08, 0.1, capM, i * 0.4, 1.14, 0, rack);
    }
    group.add(rack);
    coll(depotPos.x, depotPos.z, 1.3, 0.5, 1.2, cy);
  }
  if (has('storage')) {
    // storage lodge: plank floor/walls (front door gap) + dark slab roof
    const lp = at(-4.8, 2.5);
    const lodge = new THREE.Group();
    lodge.position.copy(lp);
    const plankM = M(0xa07a3a), roofM = M(0x6b4a2a);
    box(2.6, 0.14, 2.2, plankM, 0, 0.07, 0, lodge);
    box(2.6, 1.5, 0.12, plankM, 0, 0.82, -1.05, lodge);
    box(0.12, 1.5, 2.2, plankM, -1.25, 0.82, 0, lodge);
    box(0.12, 1.5, 2.2, plankM, 1.25, 0.82, 0, lodge);
    box(0.9, 1.5, 0.12, plankM, -0.85, 0.82, 1.05, lodge);
    box(0.9, 1.5, 0.12, plankM, 0.85, 0.82, 1.05, lodge);
    box(3.0, 0.14, 2.6, roofM, 0, 1.64, 0, lodge);
    group.add(lodge);
    // 3 solid walls + 2 front jambs (door gap |x|<0.4 stays open)
    coll(lp.x, lp.z - 1.05, 2.6, 0.12, 1.6, cy);
    coll(lp.x - 1.25, lp.z, 0.12, 2.2, 1.6, cy);
    coll(lp.x + 1.25, lp.z, 0.12, 2.2, 1.6, cy);
    coll(lp.x - 0.85, lp.z + 1.05, 0.9, 0.12, 1.6, cy);
    coll(lp.x + 0.85, lp.z + 1.05, 0.9, 0.12, 1.6, cy);
  }
  if (has('turbine')) {
    // vacuum turbine bolt-ons: side drum, extra pipes, beefier funnel
    const drumG = new THREE.CylinderGeometry(0.22, 0.22, 0.6, 10); disposables.push(drumG);
    const drum = new THREE.Mesh(drumG, M(0xC4934A));
    drum.position.set(-0.55, 0.5, 0);
    vacFallback.add(drum);
    box(0.4, 0.1, 0.1, M(0x6b6156), -0.35, 0.75, 0, vacFallback);
    box(0.12, 0.5, 0.12, M(0x6b6156), -0.42, 0.3, -0.3, vacFallback);
    box(0.2, 0.1, 0.2, M(0x6b6156), -0.42, 0.58, -0.3, vacFallback);
    funnel.scale.setScalar(1.35);
  }
  if (has('boiler')) {
    // boiler house: small brick hut w/ copper boiler + steaming chimney
    const bp = at(-4.6, -2.2);
    const hut = new THREE.Group();
    hut.position.copy(bp);
    const brickM = M(0x8a5a4a), roofM = M(0x55524c);
    box(1.6, 1.3, 1.6, brickM, 0, 0.65, 0, hut);
    box(1.9, 0.14, 1.9, roofM, 0, 1.37, 0, hut);
    const boilG = new THREE.CylinderGeometry(0.35, 0.35, 0.7, 10); disposables.push(boilG);
    const boil = new THREE.Mesh(boilG, M(0xb87333));
    boil.position.set(0, 1.8, 0);
    hut.add(boil);
    box(0.18, 0.7, 0.18, M(0x3c3a36), 0.55, 1.75, 0.55, hut); // chimney
    group.add(hut);
    boilerChimney = new THREE.Vector3(bp.x + 0.55, cy + 2.15, bp.z + 0.55);
    coll(bp.x, bp.z, 1.6, 1.6, 1.45, cy);
  }
  if (has('bunk')) {
    // Grub's bunk: small green tent + bedroll
    tent(at(4.6, -1.5), 0.9, 0x6fbf4a, 1.3, 0.95, 1.4);
    const br = at(4.6, -0.5);
    box(0.5, 0.12, 0.9, M(0x3f7a2e), br.x, cy + 0.06, br.z, group);
  }

  const npcs = [
    { id: 'tub', name: 'TUB THE BLACKSMITH', pos: tubPos, rig: tub, ember },
    { id: 'bub', name: 'BUB AT HQ', pos: bubPos, rig: bub },
  ];
  const npcVisual = {
    tub: { r: 1, g: 1, b: 1, scale: 1 },
    bub: { r: 1, g: 1, b: 1, scale: 1 },
  };
  function applyNpcVisual(id) {
    const npc = npcs.find(n => n.id === id);
    const t = npcVisual[id];
    if (!npc || !t || !npc.rig.setVisual) return;
    npc.rig.setVisual(t);
  }
  function setRigVisual(id, next = {}) {
    const t = npcVisual[id];
    if (!t) return null;
    if (next.r !== undefined) t.r = clampTint(next.r);
    if (next.g !== undefined) t.g = clampTint(next.g);
    if (next.b !== undefined) t.b = clampTint(next.b);
    if (next.scale !== undefined) t.scale = clampScale(next.scale);
    applyNpcVisual(id);
    return { ...t };
  }
  applyNpcVisual('tub');
  applyNpcVisual('bub');
  const tubForgeYaw = Math.atan2(forgePos.x - tubPos.x, forgePos.z - tubPos.z) + Math.PI;
  const bubFireYaw = Math.atan2(firePos.x - bubPos.x, firePos.z - bubPos.z) + Math.PI;

  // goblin model front is -Z, so add PI to face targets.
  for (const n of npcs) {
    n.rig.grp.rotation.y = n.id === 'tub' ? tubForgeYaw : bubFireYaw;
    n.rig.setAnim(n.id === 'tub' ? 'work' : 'idle');
  }

  let t = Math.random() * 10, smokeT = 0, haulSteamT = 0, boilT = 0;

  function update(dt, playerPos) {
    t += dt;
    for (let i = 0; i < npcs.length; i++) {
      const n = npcs[i];
      if (n.id === 'tub') {
        n.rig.grp.rotation.y = tubForgeYaw;
        n.rig.setAnim('work', { fade: 0.2 });
        n.rig.updateAnim(dt);
        continue;
      }
      const dx = playerPos.x - n.pos.x, dz = playerPos.z - n.pos.z;
      if (dx * dx + dz * dz < 36) {
        const want = Math.atan2(dx, dz) + Math.PI; // face (-Z front) toward the player
        let d = want - n.rig.grp.rotation.y;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        n.rig.grp.rotation.y += d * Math.min(1, 5 * dt);
      }
      n.rig.setAnim('idle', { fade: 0.2 });
      n.rig.updateAnim(dt);
    }
    if (npcs[0].ember) npcs[0].ember.material.emissiveIntensity = 0.8 + Math.sin(t * 5) * 0.3;

    // campfire life
    const flick = 0.9 + Math.sin(t * 9.7) * 0.18 + Math.sin(t * 23.3) * 0.1;
    flame1.scale.set(flick, 0.85 + Math.sin(t * 12) * 0.22, flick);
    flame2.scale.setScalar(0.8 + Math.sin(t * 15 + 1.3) * 0.25);
    flame2.rotation.y = t * 2.4;
    fireLight.intensity = 14 + flick * 6;
    smokeT -= dt;
    if (smokeT <= 0 && items) {
      smokeT = 0.28;
      items.steam(new THREE.Vector3(firePos.x, firePos.y + 0.9, firePos.z), 1);
    }
    // vacuum idle: funnel wobble + gauge shimmer
    funnel.rotation.y = t * 3;
    funnel.position.y = 1.28 + Math.sin(t * 4) * 0.03;
    // steam hauler idle/active animation
    if (haulerBuilt) {
      const wheelRate = haulerActive ? 7.5 : 0.8;
      for (const w of driveWheels) w.rotation.z += dt * wheelRate;
      cartGroup.children.forEach((c, i) => {
        c.position.y = (haulerActive ? 0.02 : 0.008) * Math.sin(t * (haulerActive ? 7 : 2) + i * 0.7);
      });
      if (items) {
        haulSteamT -= dt;
        if (haulSteamT <= 0) {
          haulSteamT = haulerActive ? 0.16 : 0.55;
          items.steam(haulerWhistle, haulerActive ? 2 : 1);
        }
      }
    }
    // boiler house huffs steam from its chimney
    if (boilerChimney && items) {
      boilT -= dt;
      if (boilT <= 0) { boilT = 0.4; items.steam(boilerChimney, 1); }
    }
  }

  function setHaulerState(active, carts, built = haulerBuilt) {
    haulerBuilt = !!built;
    hauler.visible = haulerBuilt;
    haulerActive = haulerBuilt && !!active;
    const want = Math.max(1, Math.min(6, carts | 0));
    if (want !== haulerCarts) {
      haulerCarts = want;
      rebuildHaulerCarts(haulerCarts);
    }
  }

  function nearest(pos) {
    let best = null, bd = 2.7;
    for (const n of npcs) {
      const d = Math.hypot(pos.x - n.pos.x, pos.z - n.pos.z);
      if (d < bd && Math.abs(pos.y - n.pos.y) < 2.5) { bd = d; best = n; }
    }
    return best;
  }

  function dispose() {
    scene.remove(group);
    tub.dispose();
    bub.dispose();
    disposeCampModelStates(campModelStates);
    disposables.forEach(d => d.dispose());
  }

  return {
    update, nearest, dispose,
    vacuumPos: vacPos, vacuumIntake, anvilPos, colliders, depotPos,
    haulerDockPos, haulerChestCell, setHaulerState, setRigVisual,
  };
}
