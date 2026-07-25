// Deepsmoke — main: renderer, run lifecycle, hazards, win/lose, screens, audio, leaderboard.
import * as THREE from 'three';
import createAudio from '/star-sdk/audio.js';
import { createLeaderboard } from '/star-sdk/v1/leaderboard.js';
import { tunable } from '/star-sdk/v1/dom.js';
import { makeTextures } from './textures.js';
import { createWorld, BLOCK, GROUND_Y, SY, isUnbreakable } from './world.js';
import { createItems } from './items.js';
import { createPartner, initGoblinModel } from './partner.js';
import { createPlayer } from './player.js';
import { FIRST_PERSON_LAYER, getPlayerModelPoses, setPlayerModelPoseOverride } from './player-models.js';
import { createInput } from './input.js';
import { createHUD } from './hud.js';
import { loadProfile, saveProfile, sanitizePlayerName, ORE_KEYS, ORE_BLOCK_KEY, CAMP_PROJECTS } from './upgrades.js';
import { createNPCs } from './npcs.js';
import { getCampPropOverrides, initCampPropModels, setCampPropOverride } from './camp-models.js';
import { initOreCrystalModel } from './ore-model.js';
import { createUI } from './ui.js';
import { ITEMS, BLOCK_DROP, makeIcons } from './inventory.js';
import { createTrees } from './trees.js';
import { createHotbar } from './hotbar.js';
import { createMobs } from './mobs.js';
import { mp, startCoop, createCoopClient, rollWeather } from './coop.js';
import { SLOT_COOP, saveSnapshot, deleteSnapshot, listSnapshots, newWorldSlot, packChests, packSharedChests, packSharedEdits, packEdits } from './persist.js';
import { BTN } from './gamepad.js';

const BGM_URL = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/db045441-4873-4e9f-b32e-7f969e752c48.mp3'; // Under_the_Canopy(1)
const BREACH_URL = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/6e87689c-fb9e-4e14-a1f6-7fcb495153f1.mp3';
const STOMP_URL = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/fc5e0170-13b6-430e-a014-61d0f2d0ce6c/886edfdf-6844-41ac-8d80-2d8039f53114.mp3'; // mech_stomp — booming metallic footstep

// Boot only in real browsers — the co-op room can be server-hosted, and the renderer/DOM
// must never run there (mp.client). The connection itself starts at load, below.
mp.client(() => {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
});
// Top-level, never behind a button: players are in a room from frame one.
// minPlayersToStart: 1 — singleplayer must never wait on matchmaking.
// startCoop flips coop.js's internal gate — until it resolves, every mp.me /
// mp.players accessor in the coop client is a safe no-op (the render loop
// polls coop.digLaunched from frame one, before this promise settles).
await startCoop();

function init() {
  const root = document.getElementById('game-root');
  if (!root) return;

  // ---------- settings (persisted): music/sfx volume + render resolution ----------
  const RES_STEPS = [0.25, 0.5, 1, 2, 4];
  const campDefaults = getCampPropOverrides();
  let persisted = {};
  try { persisted = JSON.parse(localStorage.getItem('ds_vol') || '{}') || {}; } catch { /* keep defaults */ }
  const toNum = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  let settings = {
    music: toNum(persisted.music, 0.8),
    sfx: toNum(persisted.sfx, 0.9),
    res: toNum(persisted.res, 1),
  };
  if (!RES_STEPS.includes(settings.res)) settings.res = 1;
  const saveSettings = () => localStorage.setItem('ds_vol', JSON.stringify(settings));
  let applyNPCTunablesRuntime = () => {};

  const seedCamp = kind => setCampPropOverride(kind, campDefaults[kind]) || campDefaults[kind];
  const campSeeds = {
    vacuum: seedCamp('vacuum'),
    forge: seedCamp('forge'),
  };
  const CAMP_TUNE_SCHEMA = {
    scale: { min: 0.25, max: 2.5, step: 0.01, label: 'Scale' },
    x: { min: -2, max: 2, step: 0.01, label: 'Offset X' },
    y: { min: -2, max: 2, step: 0.01, label: 'Offset Y' },
    z: { min: -2, max: 2, step: 0.01, label: 'Offset Z' },
    yawDeg: { min: -180, max: 180, step: 1, label: 'Yaw (deg)' },
  };
  const toDeg = rad => Number(rad || 0) * (180 / Math.PI);
  const toRad = deg => Number(deg || 0) * (Math.PI / 180);
  const campVacuumTune = tunable('camp_prop_vacuum', {
    scale: campSeeds.vacuum.scale,
    x: campSeeds.vacuum.x,
    y: campSeeds.vacuum.y,
    z: campSeeds.vacuum.z,
    yawDeg: toDeg(campSeeds.vacuum.yaw),
  }, CAMP_TUNE_SCHEMA, {
    label: 'Camp Prop: Ore Vacuum',
    onChange: () => applyCampTunables(),
  });
  const campForgeTune = tunable('camp_prop_forge', {
    scale: campSeeds.forge.scale,
    x: campSeeds.forge.x,
    y: campSeeds.forge.y,
    z: campSeeds.forge.z,
    yawDeg: toDeg(campSeeds.forge.yaw),
  }, CAMP_TUNE_SCHEMA, {
    label: 'Camp Prop: Forge',
    onChange: () => applyCampTunables(),
  });
  function applyCampTunables() {
    setCampPropOverride('vacuum', {
      scale: Number(campVacuumTune.scale),
      x: Number(campVacuumTune.x),
      y: Number(campVacuumTune.y),
      z: Number(campVacuumTune.z),
      yaw: toRad(campVacuumTune.yawDeg),
    });
    setCampPropOverride('forge', {
      scale: Number(campForgeTune.scale),
      x: Number(campForgeTune.x),
      y: Number(campForgeTune.y),
      z: Number(campForgeTune.z),
      yaw: toRad(campForgeTune.yawDeg),
    });
  }
  applyCampTunables();

  const playerPoseSeeds = getPlayerModelPoses();
  const PLAYER_MODEL_TUNE_SCHEMA = {
    scale: { min: 0.25, max: 2.5, step: 0.01, label: 'Scale' },
    x: { min: -3, max: 3, step: 0.01, label: 'Offset X' },
    y: { min: -3, max: 3, step: 0.01, label: 'Offset Y' },
    z: { min: -3, max: 3, step: 0.01, label: 'Offset Z' },
    pitchDeg: { min: -180, max: 180, step: 1, label: 'Pitch (deg)' },
    yawDeg: { min: -180, max: 180, step: 1, label: 'Yaw (deg)' },
    rollDeg: { min: -180, max: 180, step: 1, label: 'Roll (deg)' },
  };
  const playerMechTune = tunable('player_model_mech', {
    scale: playerPoseSeeds.mech.scale,
    x: playerPoseSeeds.mech.x,
    y: playerPoseSeeds.mech.y,
    z: playerPoseSeeds.mech.z,
    pitchDeg: playerPoseSeeds.mech.pitchDeg,
    yawDeg: playerPoseSeeds.mech.yawDeg,
    rollDeg: playerPoseSeeds.mech.rollDeg,
  }, PLAYER_MODEL_TUNE_SCHEMA, {
    label: 'Player Model: Mech',
    onChange: () => applyPlayerModelTunables(),
  });
  const playerPilotTune = tunable('player_model_pilot', {
    scale: playerPoseSeeds.pilot.scale,
    x: playerPoseSeeds.pilot.x,
    y: playerPoseSeeds.pilot.y,
    z: playerPoseSeeds.pilot.z,
    pitchDeg: playerPoseSeeds.pilot.pitchDeg,
    yawDeg: playerPoseSeeds.pilot.yawDeg,
    rollDeg: playerPoseSeeds.pilot.rollDeg,
  }, PLAYER_MODEL_TUNE_SCHEMA, {
    label: 'Player Model: Cockpit Pilot',
    onChange: () => applyPlayerModelTunables(),
  });
  const playerDrillTune = tunable('player_model_drill', {
    scale: playerPoseSeeds.drill.scale,
    x: playerPoseSeeds.drill.x,
    y: playerPoseSeeds.drill.y,
    z: playerPoseSeeds.drill.z,
    pitchDeg: playerPoseSeeds.drill.pitchDeg,
    yawDeg: playerPoseSeeds.drill.yawDeg,
    rollDeg: playerPoseSeeds.drill.rollDeg,
  }, PLAYER_MODEL_TUNE_SCHEMA, {
    label: 'Player Model: Drill',
    onChange: () => applyPlayerModelTunables(),
  });
  const playerDrillTPTune = tunable('player_model_drill_tp', {
    scale: playerPoseSeeds.drillTP.scale,
    x: playerPoseSeeds.drillTP.x,
    y: playerPoseSeeds.drillTP.y,
    z: playerPoseSeeds.drillTP.z,
    pitchDeg: playerPoseSeeds.drillTP.pitchDeg,
    yawDeg: playerPoseSeeds.drillTP.yawDeg,
    rollDeg: playerPoseSeeds.drillTP.rollDeg,
  }, PLAYER_MODEL_TUNE_SCHEMA, {
    label: 'Player Model: Drill (3rd Person)',
    onChange: () => applyPlayerModelTunables(),
  });
  function applyPlayerModelTunables() {
    setPlayerModelPoseOverride('mech', {
      scale: Number(playerMechTune.scale),
      x: Number(playerMechTune.x),
      y: Number(playerMechTune.y),
      z: Number(playerMechTune.z),
      pitchDeg: Number(playerMechTune.pitchDeg),
      yawDeg: Number(playerMechTune.yawDeg),
      rollDeg: Number(playerMechTune.rollDeg),
    });
    setPlayerModelPoseOverride('pilot', {
      scale: Number(playerPilotTune.scale),
      x: Number(playerPilotTune.x),
      y: Number(playerPilotTune.y),
      z: Number(playerPilotTune.z),
      pitchDeg: Number(playerPilotTune.pitchDeg),
      yawDeg: Number(playerPilotTune.yawDeg),
      rollDeg: Number(playerPilotTune.rollDeg),
    });
    setPlayerModelPoseOverride('drill', {
      scale: Number(playerDrillTune.scale),
      x: Number(playerDrillTune.x),
      y: Number(playerDrillTune.y),
      z: Number(playerDrillTune.z),
      pitchDeg: Number(playerDrillTune.pitchDeg),
      yawDeg: Number(playerDrillTune.yawDeg),
      rollDeg: Number(playerDrillTune.rollDeg),
    });
    setPlayerModelPoseOverride('drillTP', {
      scale: Number(playerDrillTPTune.scale),
      x: Number(playerDrillTPTune.x),
      y: Number(playerDrillTPTune.y),
      z: Number(playerDrillTPTune.z),
      pitchDeg: Number(playerDrillTPTune.pitchDeg),
      yawDeg: Number(playerDrillTPTune.yawDeg),
      rollDeg: Number(playerDrillTPTune.rollDeg),
    });
  }
  applyPlayerModelTunables();

  const NPC_TEXTURE_TUNE_SCHEMA = {
    r: { min: 0, max: 2, step: 0.01, label: 'Red' },
    g: { min: 0, max: 2, step: 0.01, label: 'Green' },
    b: { min: 0, max: 2, step: 0.01, label: 'Blue' },
    scale: { min: 0.4, max: 2, step: 0.01, label: 'Scale' },
  };
  const npcTubTextureTune = tunable('npc_tub_texture', {
    r: 2, g: 0, b: 1.3, scale: 1,
  }, NPC_TEXTURE_TUNE_SCHEMA, {
    label: 'NPC: Tub Texture',
    onChange: () => applyNPCTunablesRuntime(),
  });
  const npcBubTextureTune = tunable('npc_bub_texture', {
    r: 0, g: 0, b: 2, scale: 0.59,
  }, NPC_TEXTURE_TUNE_SCHEMA, {
    label: 'NPC: Bub Texture',
    onChange: () => applyNPCTunablesRuntime(),
  });

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.autoClear = false;
  initGoblinModel(renderer);
  initCampPropModels(renderer);
  initOreCrystalModel(renderer);
  function applyRes() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * settings.res);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  applyRes();
  renderer.domElement.classList.add('webgl');
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const skyDay = new THREE.Color(0x60A5FA);
  const skyDusk = new THREE.Color(0xF2A160);
  const skyNight = new THREE.Color(0x071229);
  const fogDay = new THREE.Color(0x9cc4f0);
  const fogNight = new THREE.Color(0x111a33);
  const skyNow = new THREE.Color();
  const fogNow = new THREE.Color();
  scene.background = skyDay.clone();
  scene.fog = new THREE.Fog(fogDay.getHex(), 14, 44); // hides the infinite-gen horizon (GEN_R 3 chunks = 48 blocks)
  const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.08, 200);
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8B6914, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.4);
  sun.position.set(18, GROUND_Y + 36, 10);
  scene.add(sun);
  const lamp = new THREE.PointLight(0xffe3a8, 26, 16, 1.7);
  camera.add(lamp);

  // pooled point lights for placed Glow Lanterns (nearest 6 get real light)
  const lanternLights = [];
  for (let i = 0; i < 6; i++) {
    const L = new THREE.PointLight(0xffc070, 0, 13, 1.8);
    L.visible = false;
    scene.add(L);
    lanternLights.push(L);
  }
  [hemi, sun, lamp, ...lanternLights].forEach(light => light.layers.enable(FIRST_PERSON_LAYER));

  // sky actors: drifting voxel clouds + weather particles (rain/snow/storm)
  const cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  const cloudGeo = new THREE.BoxGeometry(1, 1, 1);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.72 });
  const clouds = [];
  const CLOUD_COUNT = 18;
  const WEATHER_MAX = 520;
  const weatherGeo = new THREE.BoxGeometry(0.08, 0.85, 0.08);
  const weatherMat = new THREE.MeshBasicMaterial({ color: 0x9ad4ff, transparent: true, opacity: 0.66 });
  const weatherMesh = new THREE.InstancedMesh(weatherGeo, weatherMat, WEATHER_MAX);
  weatherMesh.frustumCulled = false;
  weatherMesh.count = 0;
  scene.add(weatherMesh);
  const weatherDrops = Array.from({ length: WEATHER_MAX }, () => ({ x: 0, y: 0, z: 0, v: 0, sway: Math.random() * Math.PI * 2 }));
  const weatherM4 = new THREE.Matrix4();
  const weatherState = {
    time: Math.random() * 0.85,
    length: 420, // seconds per full day-night loop
    weather: 'clear',
    timer: 60,
    blend: 0,
    windX: 0.8,
    windZ: 0.25,
    targetWindX: 0.8,
    targetWindZ: 0.25,
  };
  const weatherLabel = {
    clear: 'Skies are clear.',
    rain: 'Rain front moving in.',
    snow: 'Snow squall rolling through.',
    storm: 'Storm winds! Keep the visor sealed.',
  };
  function createCloudMesh() {
    const parts = 8 + Math.floor(Math.random() * 9);
    const mesh = new THREE.InstancedMesh(cloudGeo, cloudMat, parts);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < parts; i++) {
      const px = (Math.random() - 0.5) * 8;
      const py = (Math.random() - 0.5) * 1.6;
      const pz = (Math.random() - 0.5) * 5;
      const sx = 1.5 + Math.random() * 1.9;
      const sy = 0.9 + Math.random() * 0.9;
      const sz = 1.2 + Math.random() * 1.7;
      m4.makeScale(sx, sy, sz);
      m4.setPosition(px, py, pz);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  }
  function spawnCloud(anchorX = 0, anchorZ = 0) {
    const mesh = createCloudMesh();
    cloudGroup.add(mesh);
    const c = {
      mesh,
      x: anchorX + (Math.random() - 0.5) * 180,
      z: anchorZ + (Math.random() - 0.5) * 180,
      y: GROUND_Y + 52 + Math.random() * 24,
      speed: 0.8 + Math.random() * 0.7,
      drift: (Math.random() - 0.5) * 0.32,
      phase: Math.random() * Math.PI * 2,
    };
    mesh.position.set(c.x, c.y, c.z);
    return c;
  }
  for (let i = 0; i < CLOUD_COUNT; i++) clouds.push(spawnCloud(0, 0));
  function resetCloud(c, anchorX, anchorZ, wrap = false) {
    const edge = 115 + Math.random() * 20;
    if (wrap) {
      c.x = anchorX - Math.sign(weatherState.windX || 1) * edge;
      c.z = anchorZ + (Math.random() - 0.5) * 210;
    } else {
      c.x = anchorX + (Math.random() - 0.5) * 210;
      c.z = anchorZ + (Math.random() - 0.5) * 210;
    }
    c.y = GROUND_Y + 52 + Math.random() * 24;
    c.phase = Math.random() * Math.PI * 2;
  }
  function resetWeatherDrop(d, top = false) {
    const r = 14 + Math.random() * 24;
    const a = Math.random() * Math.PI * 2;
    d.x = Math.cos(a) * r;
    d.z = Math.sin(a) * r;
    d.y = (top ? 22 : -2) + Math.random() * 28;
    d.v = 14 + Math.random() * 14;
    d.sway = Math.random() * Math.PI * 2;
  }
  for (const d of weatherDrops) resetWeatherDrop(d, false);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applyRes();
  });

  // ---------- audio ----------
  const audio = createAudio();
  const drillSynth = v => ({ waveform: 'square', frequency: [90, 70, 110, 60], duration: 0.12, volume: v });
  audio.preload({
    jump: { synth: 'jump', volume: 0.35 },
    swoosh: { synth: 'swoosh', volume: 0.55 },
    shoot: { synth: 'shoot', volume: 0.5 },
    coin: { synth: 'coin', volume: 0.5 },
    pickup: { synth: 'pickup', volume: 0.55 },
    success: 'success',
    hit: { synth: 'hit', volume: 0.45 },
    powerup: { synth: 'powerup', volume: 0.6 },
    click: 'click',
    'sfx.place': { waveform: 'triangle', frequency: [160, 120], duration: 0.12, volume: 0.5 },
    'sfx.slurp': { waveform: 'sine', frequency: [260, 520, 940], duration: 0.16, volume: 0.3 },
    'sfx.drillNear': drillSynth(0.28),
    'sfx.drillMid': drillSynth(0.15),
    'sfx.drillFar': drillSynth(0.06),
    'sfx.hiss': { waveform: 'sawtooth', frequency: [1400, 900, 1600, 1000, 1300, 800], duration: 0.35, volume: 0.1 },
    'sfx.grind': { waveform: 'sawtooth', frequency: [220, 180, 140, 90, 50], duration: 0.9, volume: 0.5 },
    'sfx.rumble': { waveform: 'triangle', frequency: [60, 45, 35], duration: 0.8, volume: 0.65 },
    'sfx.relic': { waveform: 'sine', frequency: [660, 880, 1320], duration: 0.35, volume: 0.45 },
    'bgm.cave': BGM_URL,
    'sfx.breach': BREACH_URL,
    'sfx.stomp': STOMP_URL,
  });
  audio.setMusicVolume(settings.music);
  audio.setSfxVolume(settings.sfx);

  const leaderboard = createLeaderboard();
  const hud = createHUD(root);
  const profile = loadProfile();
  let playerName = sanitizePlayerName(profile.playerName);
  if (profile.playerName !== playerName) {
    profile.playerName = playerName;
    saveProfile(profile);
  }
  const ui = createUI(root, audio);
  const input = createInput(root, renderer.domElement);
  const gamepad = input.gamepad;
  input.setActive(false); // hide touch controls on the menu
  const textures = makeTextures();
  const { icons, iconURL } = makeIcons(textures);
  const hotbar = createHotbar(root, iconURL);
  const coop = createCoopClient(scene); // DIG TOGETHER — all mp logic lives in coop.js
  coop.setPlayerName(playerName);
  // Phase 1.2 chest sync — coop converges confirmed remote chest contents into my containers
  // map (callbacks only run from coop.tick during a live dig, so the later `let` decls are safe).
  coop.bindChests(
    (k, size) => {
      let c = containers.get(k);
      if (!c) { c = { slots: Array(size).fill(null), rev: 0 }; containers.set(k, c); }
      return c;
    },
    k => { if (k === campChestKey) persistCampChest(); },
  );
  const dirtURL = textures.dirt.image.toDataURL(); // tile the in-game dirt block behind menus

  // ---------- screens ----------
  const screen = document.createElement('div');
  screen.id = 'menu-screen';
  screen.style.cssText = 'position:absolute;inset:0;z-index:20;';
  root.appendChild(screen);

  const WHITE = 'color:#fff;text-shadow:2px 2px 0 #000';
  const dirtBG = `background-image:linear-gradient(rgba(0,0,0,.5),rgba(0,0,0,.62)),url('${dirtURL}');background-size:100% 100%,64px 64px;background-repeat:no-repeat,repeat;image-rendering:pixelated`;
  let screenMode = 'menu'; // menu | options | lobby | pause | worlds | play
  const escapeAttr = s => String(s || '').replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function commitPlayerName(nextName) {
    const clean = sanitizePlayerName(nextName);
    const changed = clean !== playerName;
    playerName = clean;
    profile.playerName = clean;
    coop.setPlayerName(clean);
    if (changed) saveProfile(profile);
    const inputEl = screen.querySelector('#player-name');
    if (inputEl && inputEl.value !== clean) inputEl.value = clean;
    if (screenMode === 'lobby') renderRoster();
  }

  function menuHTML() {
    return `
    <div class="w-full h-full flex flex-col items-center justify-center gap-5 px-6 text-center" style="${dirtBG}">
      <h1 class="text-5xl md:text-7xl font-black tracking-widest" style="color:#D4B483;text-shadow:4px 4px 0 #5a4408,8px 8px 0 rgba(0,0,0,.55)">DEEPSMOKE</h1>
      <p class="font-bold max-w-md" style="${WHITE}">
        Drill deep with your goblin pal Grub. Every block you break drops into your pack — craft, build, smelt, and grow the camp. Haul ore to the vacuum to bank it. Run dry and the deep keeps yer pack — go win it back. ESC pauses.</p>
      <div class="text-xs md:text-sm font-mono leading-relaxed" style="${WHITE}">
        ${input.isTouch
          ? 'LEFT: move joystick · RIGHT: look · Hold DRILL to dig<br>PLACE builds from hand · PACK opens rig · TALK/OPEN near HQ, chests &amp; ovens'
          : 'WASD move · MOUSE look · HOLD LEFT-CLICK drill · SPACE jump<br>Pad: LS move · RS look · RT drill · A jump · B use · X throw · Y give · LB/RB place · View pack · Start pause'}
      </div>
      <div class="pixel-panel px-3 py-2 w-full max-w-sm">
        <label for="player-name" class="block text-xs md:text-sm font-black tracking-widest mb-1" style="color:#ffd873">MINER NAME</label>
        <input id="player-name" type="text" maxlength="18" autocomplete="nickname" spellcheck="false"
          class="w-full px-3 py-2 text-base font-black text-center"
          style="background:#0e1630;color:#fff;border:2px solid #000;outline:none;text-shadow:2px 2px 0 #000"
          value="${escapeAttr(playerName)}">
      </div>
      ${worldsList.length
        ? `<button id="btn-continue" class="btn-brass rounded-xl px-10 py-4 text-2xl font-black tracking-wider">CONTINUE — ${escapeAttr((worldsList[0].name || 'WORLD').slice(0, 16))}</button>`
        : ''}
      <button id="btn-start" class="btn-brass rounded-xl px-10 py-4 ${worldsList.length ? 'text-xl' : 'text-2xl'} font-black tracking-wider">${worldsList.length ? 'NEW DIG' : 'START DIG'}</button>
      <button id="btn-coop" class="btn-cobalt rounded-xl px-8 py-3 text-xl font-black tracking-wider">DIG TOGETHER</button>
      <div class="flex gap-3 flex-wrap justify-center">
        <button id="btn-worlds" class="btn-cobalt rounded-xl px-6 py-2 font-bold">WORLDS</button>
        <button id="btn-lb" class="btn-cobalt rounded-xl px-6 py-2 font-bold">LEADERBOARD</button>
        <button id="btn-opt" class="btn-cobalt rounded-xl px-6 py-2 font-bold">OPTIONS</button>
      </div>
    </div>`;
  }

  function sliderRowsHTML() {
    return `
      <div class="flex flex-col gap-3 items-center">
        <div class="flex items-center gap-3">
          <span class="text-xs font-black tracking-widest w-24 text-right" style="color:#D4B483;text-shadow:0 1px 3px #000">MUSIC</span>
          <input id="vol-music" class="pixel-slider" type="range" min="0" max="1" step="0.05" value="${settings.music}">
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs font-black tracking-widest w-24 text-right" style="color:#D4B483;text-shadow:0 1px 3px #000">SOUND</span>
          <input id="vol-sfx" class="pixel-slider" type="range" min="0" max="1" step="0.05" value="${settings.sfx}">
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs font-black tracking-widest w-24 text-right" style="color:#D4B483;text-shadow:0 1px 3px #000">RESOLUTION</span>
          <input id="vol-res" class="pixel-slider" type="range" min="0" max="4" step="1" value="${RES_STEPS.indexOf(settings.res)}">
          <span id="res-label" class="text-xs font-black w-12 text-left" style="${WHITE}">×${settings.res}</span>
        </div>
      </div>`;
  }

  function optionsHTML() {
    return `
    <div class="w-full h-full overflow-y-auto" style="${dirtBG}">
      <div class="min-h-full flex flex-col items-center justify-start md:justify-center gap-6 px-6 py-6 text-center">
        <h1 class="text-4xl md:text-6xl font-black tracking-widest" style="color:#D4B483;text-shadow:4px 4px 0 #5a4408,8px 8px 0 rgba(0,0,0,.55)">OPTIONS</h1>
        ${sliderRowsHTML()}
        <p class="text-xs font-mono max-w-sm" style="${WHITE}">Lower resolution = smoother on weak devices. Higher = crisper picture.</p>
        <button id="btn-back" class="btn-brass rounded-xl px-8 py-3 text-xl font-black tracking-wider">BACK</button>
      </div>
    </div>`;
  }

  function pauseHTML() {
    return `
    <div class="w-full h-full overflow-y-auto" style="${dirtBG}">
      <div class="min-h-full flex flex-col items-center justify-start md:justify-center gap-6 px-6 py-6 text-center">
        <h1 class="text-4xl md:text-6xl font-black tracking-widest" style="color:#D4B483;text-shadow:4px 4px 0 #5a4408,8px 8px 0 rgba(0,0,0,.55)">PAUSED</h1>
        ${sliderRowsHTML()}
        <div class="flex gap-3 flex-wrap justify-center">
          <button id="btn-resume" class="btn-brass rounded-xl px-8 py-3 text-xl font-black tracking-wider">RESUME</button>
          <button id="btn-quit" class="btn-cobalt rounded-xl px-6 py-3 text-lg font-black tracking-wider">QUIT TO MENU</button>
        </div>
      </div>
    </div>`;
  }

  function renderSettingsScreen() {
    if (screenMode === 'options') screen.innerHTML = optionsHTML();
    else if (screenMode === 'pause') screen.innerHTML = pauseHTML();
    else return;
    wireScreen();
  }

  function wireScreen() {
    const s = screen.querySelector('#btn-start');
    const l = screen.querySelector('#btn-lb');
    const o = screen.querySelector('#btn-opt');
    const b = screen.querySelector('#btn-back');
    const cp = screen.querySelector('#btn-coop');
    const rs = screen.querySelector('#btn-resume');
    const qt = screen.querySelector('#btn-quit');
    const pn = screen.querySelector('#player-name');
    const ct = screen.querySelector('#btn-continue');
    const ws = screen.querySelector('#btn-worlds');
    if (rs) rs.addEventListener('click', () => { audio.play('click'); resumeGame(); });
    if (qt) qt.addEventListener('click', () => { audio.play('click'); quitToMenu(); });
    if (s) s.addEventListener('click', () => { audio.play('click'); startRun(); });
    if (ct) ct.addEventListener('click', () => { audio.play('click'); if (worldsList[0]) startRun(undefined, worldsList[0]); });
    if (ws) ws.addEventListener('click', () => { audio.play('click'); showWorlds(); });
    if (cp) cp.addEventListener('click', () => { audio.play('click'); showLobby(); });
    if (l) l.addEventListener('click', e => { e.stopPropagation(); audio.play('click'); leaderboard.show(); });
    if (o) o.addEventListener('click', () => {
      audio.play('click');
      screenMode = 'options';
      renderSettingsScreen();
    });
    if (b) b.addEventListener('click', () => { audio.play('click'); showMenu(); });
    if (pn) {
      pn.value = playerName;
      pn.addEventListener('input', () => {
        // keep co-op presence/live roster synced while typing; persist on blur/change
        playerName = coop.setPlayerName(pn.value);
      });
      const commit = () => commitPlayerName(pn.value);
      pn.addEventListener('change', commit);
      pn.addEventListener('blur', commit);
      pn.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
          pn.blur();
        }
      });
    }
    const vm = screen.querySelector('#vol-music'), vs = screen.querySelector('#vol-sfx'), vr = screen.querySelector('#vol-res');
    if (vm) vm.addEventListener('input', () => {
      settings.music = parseFloat(vm.value);
      audio.setMusicVolume(settings.music);
      saveSettings();
    });
    if (vs) vs.addEventListener('input', () => {
      settings.sfx = parseFloat(vs.value);
      audio.setSfxVolume(settings.sfx);
      saveSettings();
      audio.play('click');
    });
    if (vr) vr.addEventListener('input', () => {
      settings.res = RES_STEPS[parseInt(vr.value, 10)] || 1;
      applyRes();
      const lab = screen.querySelector('#res-label');
      if (lab) lab.textContent = `×${settings.res}`;
      saveSettings();
      audio.play('click');
    });
    refreshNavTargets(true);
  }

  // ---------- controller menu/panel navigation ----------
  const NAV_AXIS_DEAD = 0.6;
  const NAV_REPEAT_DELAY = 0.24;
  const NAV_REPEAT_RATE = 0.1;
  const nav = {
    scope: null,
    targets: [],
    focusEl: null,
    xDir: 0,
    yDir: 0,
    xTimer: 0,
    yTimer: 0,
  };

  const visible = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function navScope() {
    if (ui.open) return document.getElementById('ui-layer');
    if (screen.style.pointerEvents !== 'none') return screen;
    return null;
  }

  function setNavFocus(el) {
    if (nav.focusEl === el) return;
    if (nav.focusEl) nav.focusEl.classList.remove('gp-focus');
    nav.focusEl = el || null;
    if (nav.focusEl) {
      nav.focusEl.classList.add('gp-focus');
      nav.focusEl.focus?.({ preventScroll: true });
    }
  }

  function refreshNavTargets(forceFirst = false) {
    const scope = navScope();
    nav.scope = scope;
    if (!scope) {
      nav.targets = [];
      setNavFocus(null);
      return;
    }
    const targets = Array.from(scope.querySelectorAll('button, input[type="range"]'))
      .filter(el => !el.disabled && visible(el))
      .map(el => {
        const r = el.getBoundingClientRect();
        return { el, cx: r.left + r.width * 0.5, cy: r.top + r.height * 0.5 };
      })
      .sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    nav.targets = targets;
    if (!targets.length) {
      setNavFocus(null);
      return;
    }
    const keep = nav.focusEl && targets.some(t => t.el === nav.focusEl);
    if (forceFirst || !keep) setNavFocus(targets[0].el);
  }

  function moveNavFocus(dx, dy) {
    if (!nav.targets.length) return;
    const current = nav.targets.find(t => t.el === nav.focusEl) || nav.targets[0];
    if (!current) return;

    let best = null;
    let bestScore = Infinity;
    for (const t of nav.targets) {
      if (t === current) continue;
      const vx = t.cx - current.cx;
      const vy = t.cy - current.cy;
      const primary = dx ? vx : vy;
      const sign = dx || dy;
      if (primary * sign <= 0) continue;
      const cross = dx ? Math.abs(vy) : Math.abs(vx);
      const score = Math.abs(primary) * 4 + cross;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best) {
      setNavFocus(best.el);
      return;
    }
    const i = nav.targets.findIndex(t => t.el === current.el);
    if (i >= 0) {
      const step = (dx > 0 || dy > 0) ? 1 : -1;
      const wrap = (i + step + nav.targets.length) % nav.targets.length;
      setNavFocus(nav.targets[wrap].el);
    }
  }

  function adjustFocusedRange(dir) {
    const el = nav.focusEl;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'range') return false;
    const min = Number.isFinite(parseFloat(el.min)) ? parseFloat(el.min) : 0;
    const max = Number.isFinite(parseFloat(el.max)) ? parseFloat(el.max) : 1;
    const step = Number.isFinite(parseFloat(el.step)) && parseFloat(el.step) > 0 ? parseFloat(el.step) : 0.05;
    const now = Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : min;
    const next = Math.max(min, Math.min(max, now + step * dir));
    if (Math.abs(next - now) < 1e-6) return true;
    el.value = String(next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function activateFocused() {
    if (!nav.focusEl) return;
    if (nav.focusEl.tagName === 'BUTTON') nav.focusEl.click();
  }

  function handleControllerBack() {
    if (ui.open) {
      ui.close();
      return;
    }
    if (paused && state === 'play') {
      resumeGame();
      return;
    }
    if (state !== 'play' && screenMode === 'lobby') {
      stopLobby();
      coop.leaveLobby();
      showMenu();
      return;
    }
    if (state !== 'play' && screenMode === 'worlds') {
      showMenu();
      return;
    }
    if (state !== 'play' && screenMode === 'options') {
      showMenu();
    }
  }

  function handleControllerMenuInput(dt) {
    const padIndex = input.gamepadIndex;
    if (padIndex === null || padIndex === undefined) {
      setNavFocus(null);
      nav.targets = [];
      nav.scope = null;
      nav.xDir = nav.yDir = 0;
      nav.xTimer = nav.yTimer = 0;
      return;
    }

    if (state === 'play' && !ui.open && gamepad.justPressed(padIndex, BTN.START)) {
      if (paused) resumeGame();
      else pauseGame();
    }

    const navActive = ui.open || screen.style.pointerEvents !== 'none';
    if (!navActive) {
      setNavFocus(null);
      nav.targets = [];
      nav.scope = null;
      nav.xDir = nav.yDir = 0;
      nav.xTimer = nav.yTimer = 0;
      return;
    }

    const scope = navScope();
    const scopeChanged = scope !== nav.scope;
    refreshNavTargets(scopeChanged);
    if (!nav.targets.length) return;

    const left = gamepad.justPressed(padIndex, BTN.LEFT);
    const right = gamepad.justPressed(padIndex, BTN.RIGHT);
    const up = gamepad.justPressed(padIndex, BTN.UP);
    const down = gamepad.justPressed(padIndex, BTN.DOWN);

    if (left) { if (!adjustFocusedRange(-1)) moveNavFocus(-1, 0); }
    if (right) { if (!adjustFocusedRange(1)) moveNavFocus(1, 0); }
    if (up) moveNavFocus(0, -1);
    if (down) moveNavFocus(0, 1);
    if (gamepad.justPressed(padIndex, BTN.A)) activateFocused();
    if (gamepad.justPressed(padIndex, BTN.B)) handleControllerBack();

    const ax = gamepad.axisValue(padIndex, 0);
    const ay = gamepad.axisValue(padIndex, 1);
    const xDir = ax > NAV_AXIS_DEAD ? 1 : ax < -NAV_AXIS_DEAD ? -1 : 0;
    const yDir = ay > NAV_AXIS_DEAD ? 1 : ay < -NAV_AXIS_DEAD ? -1 : 0;

    if (!xDir) { nav.xDir = 0; nav.xTimer = 0; }
    else if (nav.xDir !== xDir) {
      if (!adjustFocusedRange(xDir)) moveNavFocus(xDir, 0);
      nav.xDir = xDir;
      nav.xTimer = NAV_REPEAT_DELAY;
    } else {
      nav.xTimer -= dt;
      if (nav.xTimer <= 0) {
        if (!adjustFocusedRange(xDir)) moveNavFocus(xDir, 0);
        nav.xTimer = NAV_REPEAT_RATE;
      }
    }

    if (!yDir) { nav.yDir = 0; nav.yTimer = 0; }
    else if (nav.yDir !== yDir) {
      moveNavFocus(0, yDir);
      nav.yDir = yDir;
      nav.yTimer = NAV_REPEAT_DELAY;
    } else {
      nav.yTimer -= dt;
      if (nav.yTimer <= 0) {
        moveNavFocus(0, yDir);
        nav.yTimer = NAV_REPEAT_RATE;
      }
    }
  }

  // ---------- run state ----------
  const ORE_VALUE = { copper: 15, iron: 30, silver: 60, gold: 100 };
  let state = 'menu';
  let world = null, items = null, player = null, grub = null, npcs = null, trees = null, mobs = null;
  let score = 0, relicScore = 0, rescueTimer = 0, shakeT = 0, hissT = 0;
  let vacT = 0, vacHinted = false;
  let caveQueue = [];
  let musicStarted = false;
  let containers = new Map(); // "x,y,z" -> { slots: Array(18), rev }
  let campChestKey = null;
  let hbShown = false;
  let paused = false;
  let salvageKeys = new Set();  // wiped packs waiting in the deep ("x,y,z" chest keys)
  let lanterns = new Map();     // "x,y,z" -> V3 center of a placed Glow Lantern
  let banners = [];             // placed Waypoint Banner cells
  let charges = [];             // live Blast Charges {x,y,z,t}
  let depotStock = 3;           // cans on the Fuel Depot rack this dig
  let haulerChestKey = null;
  let hauler = null;            // steam freight state (segment carts + cargo slots)
  // 1.4 persistence: per-world snapshots (persist.js)
  let editJournal = new Map();  // "x,y,z" -> blockId (0 = air): every world.set vs the seeded gen
  let activeSlot = null;        // persist.js slot key of the running world
  let activeWorldName = 'DEEPSMOKE';
  let saveTimer = 0;            // autosave cadence (seconds)
  let skySeqApplied = -1;       // last shared-sky weather seq adopted (-1 = first adoption is silent)
  let skyReqT = 0;              // throttle between co-op weather-roll requests
  let worldsList = [];          // cached listSnapshots() — powers menu CONTINUE + WORLDS screen
  const HAULER_MIN_TRACK_SEGMENTS = 8;
  const HARD_LAND_CAVE_RADIUS = 5.5;
  const HARD_LAND_CAVE_DELAY = 0.16;
  const HARD_LAND_MAX_CAVES = 8;
  const HARD_LAND_CRATER_RADIUS = 1.7; // base crater size, scales up with drop height
  applyNPCTunablesRuntime = () => {
    if (!npcs || !npcs.setRigVisual) return;
    npcs.setRigVisual('tub', {
      r: Number(npcTubTextureTune.r),
      g: Number(npcTubTextureTune.g),
      b: Number(npcTubTextureTune.b),
      scale: Number(npcTubTextureTune.scale),
    });
    npcs.setRigVisual('bub', {
      r: Number(npcBubTextureTune.r),
      g: Number(npcBubTextureTune.g),
      b: Number(npcBubTextureTune.b),
      scale: Number(npcBubTextureTune.scale),
    });
  };
  // one roll table shared with the co-op host handler (coop.js) — no drift between paths
  const weatherForBiome = biome => rollWeather(biome, Math.random());
  function setWeather(kind, silent = false) {
    weatherState.weather = kind;
    weatherState.timer = 55 + Math.random() * 95;
    const gust = kind === 'storm' ? 3 : kind === 'snow' ? 1.3 : 1.9;
    weatherState.targetWindX = (Math.random() * 2 - 1) * gust;
    weatherState.targetWindZ = (Math.random() * 2 - 1) * gust * 0.7;
    if (!silent && state === 'play' && !paused && weatherLabel[kind]) hud.say('GRUB', weatherLabel[kind]);
  }
  function alignSkyActors(anchorX, anchorZ) {
    for (const c of clouds) resetCloud(c, anchorX, anchorZ, false);
    for (const d of weatherDrops) resetWeatherDrop(d, false);
    weatherMesh.count = 0;
    weatherMesh.visible = false;
  }
  function updateSkyWeather(dt, tElapsed) {
    if (!world || !player || state !== 'play') {
      cloudGroup.visible = false;
      weatherMesh.visible = false;
      weatherMesh.count = 0;
      return;
    }
    cloudGroup.visible = true;
    // co-op: ONE sky for the crew — time-of-day derives from the host-stamped epoch,
    // weather fronts adopt from shared.sky (seq change); expired fronts get re-rolled
    // via a host-guarded request (first valid ask wins). Solo keeps the local sim.
    const sharedSky = coop.active ? coop.sky(weatherState.length) : null;
    if (sharedSky) {
      weatherState.time = sharedSky.time;
      if (sharedSky.seq !== skySeqApplied) {
        const announce = skySeqApplied >= 0 && sharedSky.weather !== weatherState.weather;
        skySeqApplied = sharedSky.seq;
        weatherState.weather = sharedSky.weather;
        weatherState.targetWindX = sharedSky.windX;
        weatherState.targetWindZ = sharedSky.windZ;
        if (announce && !paused && weatherLabel[sharedSky.weather]) hud.say('GRUB', weatherLabel[sharedSky.weather]);
      }
      skyReqT -= dt;
      if (sharedSky.due && skyReqT <= 0) {
        skyReqT = 5; // don't spam while waiting for the host's roll to replicate
        coop.requestWeatherRoll(world.biomeAt(player.ent.pos.x, player.ent.pos.z));
      }
    } else {
      weatherState.time = (weatherState.time + dt / weatherState.length) % 1;
      weatherState.timer -= dt;
      if (weatherState.timer <= 0) setWeather(weatherForBiome(world.biomeAt(player.ent.pos.x, player.ent.pos.z)));
    }
    const cycle = weatherState.time * Math.PI * 2;
    const sunLift = Math.sin(cycle - Math.PI * 0.5);
    const daylight = Math.max(0, sunLift);
    const twilight = Math.max(0, 1 - Math.abs(sunLift) * 2.2);
    const night = 1 - daylight;
    skyNow.copy(skyNight).lerp(skyDusk, Math.min(1, twilight * 1.2)).lerp(skyDay, daylight);
    fogNow.copy(fogNight).lerp(fogDay, Math.min(1, daylight * 0.9 + twilight * 0.5));
    scene.background.copy(skyNow);
    scene.fog.color.copy(fogNow);
    const windT = Math.min(1, dt * 0.35);
    weatherState.windX += (weatherState.targetWindX - weatherState.windX) * windT;
    weatherState.windZ += (weatherState.targetWindZ - weatherState.windZ) * windT;
    const wetTarget = weatherState.weather === 'clear' ? 0 : weatherState.weather === 'storm' ? 1 : 0.72;
    weatherState.blend += (wetTarget - weatherState.blend) * Math.min(1, dt * 0.9);
    const px = player.ent.pos.x, py = player.ent.pos.y, pz = player.ent.pos.z;
    sun.position.set(px + Math.cos(cycle) * 56, GROUND_Y + 40 + sunLift * 72, pz + Math.sin(cycle) * 44);
    sun.intensity = 0.08 + daylight * 1.35 + twilight * 0.2;
    hemi.intensity = 0.2 + daylight * 0.9 + twilight * 0.35;
    lamp.intensity = 10 + night * 24 + (weatherState.weather === 'storm' ? 4 : 0);
    const fogDrop = (weatherState.weather === 'storm' ? 12 : weatherState.weather === 'rain' ? 7 : weatherState.weather === 'snow' ? 8 : 0) + night * 5;
    scene.fog.near = Math.max(8, 14 - fogDrop * 0.25);
    scene.fog.far = Math.max(24, 44 - fogDrop);
    const cloudTone = 0.44 + daylight * 0.56 + twilight * 0.18;
    cloudMat.color.setRGB(cloudTone, cloudTone, cloudTone + 0.03);
    cloudMat.opacity = Math.max(0.4, Math.min(0.8, 0.56 + daylight * 0.2 - weatherState.blend * 0.14));
    for (const c of clouds) {
      c.x += (weatherState.windX * 2.6 + c.speed) * dt;
      c.z += (weatherState.windZ * 1.8 + c.drift) * dt;
      if (c.x < px - 130 || c.x > px + 130 || c.z < pz - 130 || c.z > pz + 130) resetCloud(c, px, pz, true);
      c.mesh.position.set(c.x, c.y + Math.sin(tElapsed * 0.08 + c.phase) * 0.7, c.z);
    }
    const active = Math.floor(WEATHER_MAX * weatherState.blend);
    if (active < 3) {
      weatherMesh.count = 0;
      weatherMesh.visible = false;
      return;
    }
    const isSnow = weatherState.weather === 'snow';
    const isStorm = weatherState.weather === 'storm';
    weatherMat.color.setHex(isSnow ? 0xf4fbff : isStorm ? 0x88c9ff : 0x9ad4ff);
    weatherMat.opacity = isSnow ? 0.68 : isStorm ? 0.82 : 0.64;
    for (let i = 0; i < active; i++) {
      const d = weatherDrops[i];
      const fall = d.v * (isSnow ? 0.45 : isStorm ? 1.45 : 1);
      d.y -= fall * dt;
      d.x += weatherState.windX * dt * (isSnow ? 1.2 : 3.4) + (isSnow ? Math.sin(tElapsed * 1.6 + d.sway) * dt : 0);
      d.z += weatherState.windZ * dt * (isSnow ? 1 : 2.1);
      if (d.y < -4 || Math.abs(d.x) > 44 || Math.abs(d.z) > 44) resetWeatherDrop(d, true);
      const sx = isSnow ? 0.15 : 0.08;
      const sy = isSnow ? 0.18 : 0.85;
      weatherM4.makeScale(sx, sy, sx);
      weatherM4.setPosition(px + d.x, py + 12 + d.y, pz + d.z);
      weatherMesh.setMatrixAt(i, weatherM4);
    }
    weatherMesh.count = active;
    weatherMesh.instanceMatrix.needsUpdate = true;
    weatherMesh.visible = true;
  }

  function fellTreeAbove(cell) {
    const cells = [];
    let ty = cell.y + 1;
    while (world.get(cell.x, ty, cell.z) === BLOCK.LOG) {
      cells.push({ x: cell.x, y: ty, z: cell.z, id: BLOCK.LOG });
      ty++;
    }
    const top = ty - 1;
    for (let ly = cell.y + 1; ly <= top + 2; ly++)
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (world.get(cell.x + dx, ly, cell.z + dz) === BLOCK.LEAF)
          cells.push({ x: cell.x + dx, y: ly, z: cell.z + dz, id: BLOCK.LEAF });
      }
    for (const c of cells) world.set(c.x, c.y, c.z, BLOCK.AIR);
    const dir = new THREE.Vector3(
      cell.x + 0.5 - player.ent.pos.x, 0, cell.z + 0.5 - player.ent.pos.z);
    trees.fell(cell, cells, dir);
  }

  function queueCaveIn(x, y, z, t = 0.7) {
    for (const c of caveQueue) if (c.x === x && c.y === y && c.z === z) return false;
    caveQueue.push({ x, y, z, t });
    return true;
  }

  function triggerNearbyCaveIns(center, radius = HARD_LAND_CAVE_RADIUS, delay = HARD_LAND_CAVE_DELAY, maxCount = HARD_LAND_MAX_CAVES) {
    if (!world) return 0;
    const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
    const rr = Math.ceil(radius), r2 = radius * radius;
    const found = [];
    for (let y = Math.max(1, cy - rr); y <= Math.min(SY - 2, cy + rr); y++) {
      for (let z = cz - rr; z <= cz + rr; z++) for (let x = cx - rr; x <= cx + rr; x++) {
        if (world.get(x, y, z) !== BLOCK.CRACKED) continue;
        const dx = x + 0.5 - center.x;
        const dy = y + 0.5 - center.y;
        const dz = z + 0.5 - center.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        found.push({ x, y, z, d2 });
      }
    }
    found.sort((a, b) => a.d2 - b.d2);
    let queued = 0;
    for (const c of found) {
      if (queued >= maxCount) break;
      if (!queueCaveIn(c.x, c.y, c.z, delay + Math.random() * 0.28)) continue;
      queued++;
    }
    return queued;
  }

  // shared blast-radius carve — blast charges + hard-landing craters both use this.
  // Vaporizes plain rock only: never ore/relic/cache/chest/unbreakable, no drops.
  function carveBlastRadius(cx, cy, cz, radius = 2.2) {
    if (!world) return 0;
    const rr = Math.ceil(radius), r2 = radius * radius;
    const carvedCells = [];
    for (let dy = -rr; dy <= rr; dy++) for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const x = cx + dx, y = cy + dy, z = cz + dz;
      const id = world.get(x, y, z);
      if (id === BLOCK.AIR || id === BLOCK.WATER || isUnbreakable(id)) continue;
      if (ORE_BLOCK_KEY[id] || id === BLOCK.RELIC || id === BLOCK.CACHE || id === BLOCK.CHEST) continue;
      world.set(x, y, z, BLOCK.AIR); // vaporized — no drops
      carvedCells.push({ x, y, z });
    }
    coop.reportCarve(carvedCells); // no-op unless a co-op dig is live — syncs blast/crater holes to the crew
    return carvedCells.length;
  }

  const cb = {
    say: (n, t) => hud.say(n, t),
    onBlockBroken(cell, id) {
      coop.reportBreak(cell); // no-op unless a co-op dig is live
      const center = new THREE.Vector3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5);
      const oreKey = ORE_BLOCK_KEY[id];
      if (oreKey) {
        items.spawnPickup('ore', center, oreKey);
      } else if (id === BLOCK.LOG) {
        items.spawnPickup('block', center, 'log');
        fellTreeAbove(cell);
      } else if (id === BLOCK.CHEST) {
        const key = `${cell.x},${cell.y},${cell.z}`;
        const c = containers.get(key);
        if (c) {
          for (const s of c.slots) {
            if (!s) continue;
            for (let i = 0; i < s.n; i++) {
              const p = center.clone();
              p.x += (Math.random() - 0.5) * 0.8;
              p.z += (Math.random() - 0.5) * 0.8;
              items.spawnPickup('block', p, s.id);
            }
          }
          containers.delete(key);
        }
        if (key === campChestKey) {
          campChestKey = null;
          profile.campChest = null;
          saveProfile(profile);
        }
        salvageKeys.delete(key);
        items.spawnPickup('block', center, 'chest');
      } else if (BLOCK_DROP[id]) {
        items.spawnPickup('block', center, BLOCK_DROP[id]);
      }
      if (id === BLOCK.CHARGE) charges = charges.filter(c => c.x !== cell.x || c.y !== cell.y || c.z !== cell.z);
      else if (id === BLOCK.LANTERN) lanterns.delete(`${cell.x},${cell.y},${cell.z}`);
      else if (id === BLOCK.BANNER) banners = banners.filter(b => b.x !== cell.x || b.y !== cell.y || b.z !== cell.z);
      if (id === BLOCK.CRACKED) {
        queueCaveIn(cell.x, cell.y, cell.z, 0.7);
        hud.say('GRUB', 'That ceiling sounds ANGRY. Move!');
      }
    },
    onBlockPlaced(cell, id) {
      coop.reportPlace(cell, id); // no-op unless a co-op dig is live — host validates + broadcasts
      if (id === BLOCK.CHARGE) {
        charges.push({ x: cell.x, y: cell.y, z: cell.z, t: 2.5 });
        hud.say('GRUB', 'Fuse is LIT — RUN!');
      } else if (id === BLOCK.LANTERN) {
        lanterns.set(`${cell.x},${cell.y},${cell.z}`, new THREE.Vector3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5));
      } else if (id === BLOCK.BANNER) {
        banners.push({ x: cell.x, y: cell.y, z: cell.z });
      }
    },
    onLocked() {
      hud.say('YOU', '*hsssss* Suit... locked...');
      audio.play('sfx.grind');
      rescueTimer = 0;
    },
    onHardLanding(evt) {
      const drop = Number(evt?.drop) || 0;
      const impact = Math.min(1.5, 1 + Math.max(0, drop - 10) * 0.06);
      const pos = evt?.pos || player.ent.pos;
      const center = pos.clone().setY(pos.y + 0.25);
      audio.play('sfx.breach'); // surface clang
      // tree-fell crash mixed on top of the clang — same pair trees.js plays on tree landing
      audio.play('hit');
      audio.play('sfx.rumble');
      audio.play('sfx.stomp', { volume: 0.9, rate: 0.8 }); // slowed stomp = extra low-end body
      shakeT = Math.max(shakeT, 0.45 + 0.35 * impact);
      items.burst(center, 0x8a7a5c, Math.round(10 + 8 * impact));
      // crater the ground under the impact — same carve rules as blast charges
      carveBlastRadius(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z), HARD_LAND_CRATER_RADIUS * impact);
      const triggered = triggerNearbyCaveIns(pos);
      if (triggered > 0) hud.say('GRUB', triggered > 1 ? 'WOAH! You woke the whole ceiling!' : 'Hard hit! Ceiling crack gave way!');
    },
  };

  const itemCb = {
    onPickup(who, type, pos, kind) {
      if (type === 'block') {
        // grub's finds go to the shared pack too
        if (player.bag.add(kind, 1)) return false; // no room — leave it lying
        audio.play('pickup');
        return true;
      }
      const target = who === 'player' ? player : grub;
      if (type === 'ore') {
        if (kind && player.inv.ores[kind] !== undefined) player.inv.ores[kind]++;
        audio.play('coin');
        if (who === 'grub' && Math.random() < 0.4) hud.say('GRUB', 'Nugget snagged for the vault!');
        return true;
      }
      if (type === 'relic') {
        const depth = Math.max(0, Math.floor(GROUND_Y - pos.y));
        const pts = 100 + depth * 6;
        score += pts; relicScore += pts;
        target.fuel = Math.min(who === 'player' ? player.fuelMax : 100, target.fuel + 8);
        audio.play('sfx.relic');
        if (who === 'grub') hud.say('GRUB', `Shiny! +${pts}`);
        return true;
      }
      if (target.cans >= 3) return false;
      target.cans++;
      audio.play('pickup');
      return true;
    },
    onGrubCatch() {
      grub.cans++;
      hud.say('GRUB', 'Caught it! Nice arm!');
    },
  };

  // ---------- camp chest (persists between digs once camp tier 2) ----------
  function placeCampChest() {
    const cx = Math.floor(world.spawn.x) - 4, cz = Math.floor(world.spawn.z) + 3;
    world.set(cx, GROUND_Y, cz, BLOCK.CHEST);
    campChestKey = `${cx},${GROUND_Y},${cz}`;
    const slots = Array(18).fill(null);
    if (Array.isArray(profile.campChest)) {
      profile.campChest.slice(0, 18).forEach((s, i) => {
        if (s && s.id && s.n > 0) slots[i] = { id: s.id, n: s.n };
      });
    }
    containers.set(campChestKey, { slots, rev: 0 });
  }

  function persistCampChest() {
    if (!campChestKey) return;
    const c = containers.get(campChestKey);
    if (!c) return;
    profile.campChest = c.slots.map(s => (s ? { id: s.id, n: s.n } : null));
    saveProfile(profile);
  }

  function ensureHaulerChest() {
    if (!npcs || !npcs.haulerChestCell) return;
    const c = npcs.haulerChestCell;
    haulerChestKey = `${c.x},${c.y},${c.z}`;
    world.set(c.x, c.y, c.z, BLOCK.CHEST);
    if (!containers.has(haulerChestKey)) containers.set(haulerChestKey, { slots: Array(36).fill(null), rev: 0 });
  }

  function getHaulerTrackInfo() {
    const info = { connected: 0, routeLen: 0, minRoute: HAULER_MIN_TRACK_SEGMENTS, ready: false, starts: 0 };
    if (!world || !npcs || !npcs.haulerDockPos) return info;
    const baseX = Math.floor(npcs.haulerDockPos.x);
    const baseY = Math.floor(npcs.haulerDockPos.y);
    const baseZ = Math.floor(npcs.haulerDockPos.z);
    const starts = [];
    const seenStart = new Set();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const x = baseX + dx, y = baseY + dy, z = baseZ + dz;
      if (world.get(x, y, z) !== BLOCK.TRACK) continue;
      const k = `${x},${y},${z}`;
      if (seenStart.has(k)) continue;
      seenStart.add(k);
      starts.push({ x, y, z, d: 0 });
    }
    info.starts = starts.length;
    if (!starts.length) return info;
    const q = starts.slice();
    const seen = new Set(starts.map(n => `${n.x},${n.y},${n.z}`));
    let maxD = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const ySteps = [0, 1, -1];
    const HARD_LIMIT = 1200;
    for (let qi = 0; qi < q.length && seen.size < HARD_LIMIT; qi++) {
      const n = q[qi];
      if (n.d > maxD) maxD = n.d;
      for (const [dx, dz] of dirs) for (const dy of ySteps) {
        const nx = n.x + dx, ny = n.y + dy, nz = n.z + dz;
        if (Math.abs(ny - baseY) > 6) continue;
        if (world.get(nx, ny, nz) !== BLOCK.TRACK) continue;
        const nk = `${nx},${ny},${nz}`;
        if (seen.has(nk)) continue;
        seen.add(nk);
        q.push({ x: nx, y: ny, z: nz, d: n.d + 1 });
      }
    }
    info.connected = seen.size;
    info.routeLen = maxD + 1;
    info.ready = info.routeLen >= info.minRoute;
    return info;
  }

  function containerAddStack(cont, id, n) {
    const item = ITEMS[id];
    if (!item || !cont || n <= 0) return n;
    const max = item.stack || 64;
    let changed = false;
    for (let i = 0; i < cont.slots.length && n > 0; i++) {
      const s = cont.slots[i];
      if (s && s.id === id && s.n < max) {
        const t = Math.min(n, max - s.n);
        s.n += t;
        n -= t;
        if (t > 0) changed = true;
      }
    }
    for (let i = 0; i < cont.slots.length && n > 0; i++) {
      if (!cont.slots[i]) {
        const t = Math.min(n, max);
        cont.slots[i] = { id, n: t };
        n -= t;
        if (t > 0) changed = true;
      }
    }
    if (changed) cont.rev++;
    return n;
  }

  function commissionHauler() {
    if (!hauler || hauler.inTransit || hauler.built) return false;
    if (!player.bag.take('steam_hauler', 1)) {
      hud.say('YOU', 'Need a crafted Steam Hauler in your bag.');
      return false;
    }
    hauler.built = true;
    hauler.rev++;
    ensureHaulerChest();
    if (npcs.setHaulerState) npcs.setHaulerState(false, hauler.carts, hauler.built);
    hud.say('BUB', 'Engine commissioned. Lay tracks from the dock and send cargo.');
    return true;
  }

  function addHaulerCart() {
    if (!hauler || hauler.inTransit || !hauler.built || hauler.carts >= hauler.maxCarts) return false;
    if (!player.bag.take('cargo_cart', 1)) return false;
    hauler.carts++;
    while (hauler.slots.length < hauler.carts * 9) hauler.slots.push(null);
    hauler.rev++;
    if (npcs.setHaulerState) npcs.setHaulerState(false, hauler.carts, hauler.built);
    hud.say('GRUB', `Bolted another cart on. Train is now ${hauler.carts} carts long!`);
    return true;
  }

  function resolveHaulerArrival() {
    if (!hauler) return;
    const targetKey = campChestKey || haulerChestKey;
    if (!targetKey) { hauler.inTransit = false; return; }
    if (targetKey === haulerChestKey) {
      const [x, y, z] = haulerChestKey.split(',').map(Number);
      if (world.get(x, y, z) !== BLOCK.CHEST) world.set(x, y, z, BLOCK.CHEST);
    }
    let cont = containers.get(targetKey);
    if (!cont) { cont = { slots: Array(36).fill(null), rev: 0 }; containers.set(targetKey, cont); }
    let movedStacks = 0;
    for (let i = 0; i < hauler.slots.length; i++) {
      const s = hauler.slots[i];
      if (!s) continue;
      const before = s.n;
      const left = containerAddStack(cont, s.id, s.n);
      if (left <= 0) {
        hauler.slots[i] = null;
        movedStacks++;
      } else if (left < before) {
        s.n = left;
        movedStacks++;
      }
    }
    hauler.inTransit = false;
    hauler.eta = 0;
    hauler.routeLen = 0;
    hauler.rev++;
    if (npcs.setHaulerState) npcs.setHaulerState(false, hauler.carts, hauler.built);
    if (targetKey === campChestKey) persistCampChest();
    if (movedStacks > 0) hud.say('BUB', `Steam haul docked. ${movedStacks} cargo stack${movedStacks > 1 ? 's' : ''} unloaded at camp.`);
    else hud.say('BUB', 'Steam haul docked, but camp storage is jammed full!');
    audio.play('sfx.slurp');
  }

  function dispatchHauler() {
    if (!hauler || hauler.inTransit) return false;
    if (!hauler.built) {
      hud.say('YOU', 'You need to commission the Steam Hauler first.');
      return false;
    }
    if (!hauler.slots.some(Boolean)) {
      hud.say('YOU', 'Train carts are empty.');
      return false;
    }
    const track = getHaulerTrackInfo();
    if (!track.ready) {
      hud.say('YOU', `Need ${track.minRoute} connected track blocks from the dock (have ${track.routeLen}).`);
      return false;
    }
    hauler.inTransit = true;
    hauler.routeLen = track.routeLen;
    hauler.eta = 3 + track.routeLen * 0.45 + hauler.carts * 0.9;
    if (npcs.setHaulerState) npcs.setHaulerState(true, hauler.carts, hauler.built);
    audio.play('sfx.rumble');
    hud.say('YOU', `Steam convoy rolling on ${track.routeLen} track blocks!`);
    return true;
  }

  function disposeRun() {
    if (npcs) npcs.dispose();
    if (player) player.dispose();
    if (grub) grub.dispose();
    if (trees) trees.dispose();
    if (mobs) mobs.dispose();
    if (items) items.dispose();
    if (world) world.dispose();
    world = items = player = grub = npcs = trees = mobs = null;
    hauler = null;
    haulerChestKey = null;
    lanternLights.forEach(L => { L.visible = false; });
    cloudGroup.visible = false;
    weatherMesh.visible = false;
    weatherMesh.count = 0;
    weatherState.blend = 0;
    scene.background.copy(skyDay);
    scene.fog.color.copy(fogDay);
    scene.fog.near = 14;
    scene.fog.far = 44;
    sun.intensity = 1.4;
    hemi.intensity = 1;
    lamp.intensity = 26;
  }

  // Pointer lock is only legal inside a fresh user gesture (click/keydown).
  // startRun can fire from the frame loop (co-op digLaunched poll), so guard:
  // skip the request when there's no transient activation — input.js locks on
  // the next canvas click anyway, and drag-look works meanwhile.
  function tryPointerLock() {
    if (input.isTouch || document.pointerLockElement) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    try { renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); } catch {}
  }

  // ---------- 1.4 persistence: snapshot build / restore (persist.js keeps the engine) ----------
  function sanitizeWorldName(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 22);
    return s || autoWorldName();
  }
  function autoWorldName() { return `WORLD ${worldsList.length + 1}`; }
  function timeAgo(when) {
    const s = Math.max(0, (Date.now() - (when || 0)) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  async function refreshWorlds() {
    try { worldsList = await listSnapshots(); } catch { worldsList = []; }
  }

  function buildSnapshot() {
    const coopLive = coop.active;
    return {
      name: activeWorldName,
      mode: coopLive ? 'coop' : 'solo',
      seed: world.seed,
      // co-op: host-confirmed shared state wins over local prediction (spread order)
      edits: coopLive
        ? { ...packEdits(editJournal), ...packSharedEdits(mp.shared.edits) }
        : packEdits(editJournal),
      chests: coopLive
        ? { ...packChests(containers, salvageKeys), ...packSharedChests(mp.shared.chests) }
        : packChests(containers, salvageKeys),
      player: {
        x: player.ent.pos.x, y: player.ent.pos.y, z: player.ent.pos.z,
        yaw: player.yaw || 0, pitch: player.pitch || 0,
        fuel: player.fuel, cans: player.cans,
        bag: player.bag.slots.map(s => (s ? { id: s.id, n: s.n } : 0)),
        ores: { ...player.inv.ores },
      },
      grub: { x: grub.ent.pos.x, y: grub.ent.pos.y, z: grub.ent.pos.z, fuel: grub.fuel, cans: grub.cans },
      run: {
        score, relicScore, depotStock,
        hauler: hauler ? {
          built: hauler.built, carts: hauler.carts,
          slots: hauler.slots.map(s => (s ? { id: s.id, n: s.n } : 0)),
        } : null,
      },
      sky: {
        time: weatherState.time, weather: weatherState.weather,
        windX: weatherState.targetWindX, windZ: weatherState.targetWindZ,
      },
    };
  }
  // fire-and-forget world save — co-op digs share ONE crew slot (resume is always solo)
  function snapshotNow() {
    if (state !== 'play' || !world || !player || !grub) return;
    const slot = coop.active ? SLOT_COOP : activeSlot;
    if (!slot) return;
    saveSnapshot(slot, buildSnapshot());
  }

  function restoreSnapshot(rec) {
    // chests (packed shape: { size, salvage, slots: [{id,n}|0] })
    if (rec.chests) {
      for (const k in rec.chests) {
        const c = rec.chests[k];
        if (!c || !c.size) continue;
        const slots = Array(c.size).fill(null);
        (Array.isArray(c.slots) ? c.slots : []).slice(0, c.size).forEach((s, i) => {
          if (s && ITEMS[s.id] && s.n > 0) slots[i] = { id: s.id, n: s.n };
        });
        containers.set(k, { slots, rev: 0 });
        if (c.salvage) salvageKeys.add(k);
      }
      persistCampChest(); // re-mirror restored camp chest contents to the profile
    }
    // run state
    const run = rec.run || {};
    score = run.score || 0;
    relicScore = run.relicScore || 0;
    if (Number.isFinite(run.depotStock)) depotStock = run.depotStock;
    if (run.hauler && hauler) {
      hauler.built = !!run.hauler.built;
      hauler.carts = Math.max(1, Math.min(hauler.maxCarts, (run.hauler.carts | 0) || 1));
      hauler.slots = Array(hauler.carts * 9).fill(null);
      (Array.isArray(run.hauler.slots) ? run.hauler.slots : []).slice(0, hauler.slots.length).forEach((s, i) => {
        if (s && ITEMS[s.id] && s.n > 0) hauler.slots[i] = { id: s.id, n: s.n };
      });
      hauler.rev++;
      if (hauler.built) {
        ensureHaulerChest();
        if (npcs.setHaulerState) npcs.setHaulerState(false, hauler.carts, hauler.built);
      }
    }
    // player
    const p = rec.player;
    if (p && Number.isFinite(p.x)) {
      player.ent.pos.set(p.x, p.y, p.z);
      player.ent.vel.set(0, 0, 0);
      player.yaw = p.yaw || 0;
      player.pitch = p.pitch || 0;
      player.fuel = Math.max(1, Math.min(player.fuelMax, Number.isFinite(p.fuel) ? p.fuel : player.fuelMax));
      player.cans = Math.max(0, Math.min(3, p.cans | 0));
      if (Array.isArray(p.bag)) {
        player.bag.slots.fill(null);
        p.bag.slice(0, player.bag.slots.length).forEach((s, i) => {
          if (s && ITEMS[s.id] && s.n > 0) player.bag.slots[i] = { id: s.id, n: s.n };
        });
        player.bag.rev++;
      }
      if (p.ores) for (const k of ORE_KEYS) player.inv.ores[k] = Math.max(0, p.ores[k] | 0);
    }
    // grub
    const g = rec.grub;
    if (g && Number.isFinite(g.x)) {
      grub.ent.pos.set(g.x, g.y, g.z);
      grub.ent.vel.set(0, 0, 0);
      grub.fuel = Math.max(1, Math.min(100, Number.isFinite(g.fuel) ? g.fuel : 100));
      grub.cans = Math.max(0, Math.min(3, g.cans | 0));
    }
    // sky
    if (rec.sky) {
      weatherState.time = Number.isFinite(rec.sky.time) ? rec.sky.time : weatherState.time;
      setWeather(weatherLabel[rec.sky.weather] ? rec.sky.weather : 'clear', true);
      if (Number.isFinite(rec.sky.windX)) weatherState.targetWindX = rec.sky.windX;
      if (Number.isFinite(rec.sky.windZ)) weatherState.targetWindZ = rec.sky.windZ;
    }
    // synchronous chunk slice around the restored spot so we land on solid ground
    world.update(player.ent.pos, true);
    world.flush();
    alignSkyActors(player.ent.pos.x, player.ent.pos.z);
    hud.say('GRUB', 'Right where we left off, boss!');
  }

  function startRun(coopSeed, resumeRec = null, worldMeta = null) {
    stopLobby();
    disposeRun();
    ui.close();
    const isCoop = typeof coopSeed === 'number';
    if (isCoop) { activeSlot = SLOT_COOP; activeWorldName = 'CREW DIG'; }
    else if (resumeRec) { activeSlot = resumeRec.slot; activeWorldName = resumeRec.name || 'WORLD'; }
    else { activeSlot = newWorldSlot(); activeWorldName = sanitizeWorldName(worldMeta && worldMeta.name); }
    world = createWorld(scene, textures, isCoop ? coopSeed : (resumeRec ? resumeRec.seed : undefined));
    // --- edit journal: wrap world.set ONCE — every block change from any module
    // (player, grub, blasts, cave-ins, coop reconciliation) lands in the diff.
    editJournal = new Map();
    if (resumeRec && resumeRec.edits) for (const k in resumeRec.edits) editJournal.set(k, resumeRec.edits[k] | 0);
    const baseSet = world.set;
    world.set = (x, y, z, id) => {
      editJournal.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, id | 0);
      baseSet(x, y, z, id);
    };
    // replay the saved diff — applySavedEdit uses world-internal set (no re-journaling)
    // and lands even in not-yet-generated chunks via the pre-gen edit overlay.
    if (resumeRec && resumeRec.edits) {
      for (const k in resumeRec.edits) {
        const [ex, ey, ez] = k.split(',').map(Number);
        world.applySavedEdit(ex, ey, ez, resumeRec.edits[k] | 0);
      }
      world.flush();
    }
    items = createItems(scene, world, audio, textures, icons);
    trees = createTrees(scene, world, items, audio, textures);
    mobs = createMobs(scene, world, audio);
    npcs = createNPCs(scene, world, items, profile, renderer);
    world.setColliders(npcs.colliders); // camp furniture is solid
    applyNPCTunablesRuntime();
    player = createPlayer(scene, world, camera, audio, input, items, profile, renderer);
    grub = createPartner(scene, world, audio, items);
    containers.clear();
    campChestKey = null;
    haulerChestKey = null;
    hauler = { built: false, carts: 1, maxCarts: 6, slots: Array(9).fill(null), rev: 0, inTransit: false, eta: 0, routeLen: 0 };
    if (npcs.setHaulerState) npcs.setHaulerState(false, hauler.carts, hauler.built);
    if (profile.projects.storage) placeCampChest();
    player.cans = 1 + (profile.projects.depot ? 1 : 0);
    grub.cans = profile.projects.bunk ? 2 : 1;
    hotbar.setInv(player.bag);
    for (const p of world.canSpawns.splice(0)) items.spawnPickup('can', p);
    score = 0; relicScore = 0; rescueTimer = 0; shakeT = 0;
    vacT = 0; vacHinted = false;
    caveQueue = [];
    lanterns.clear(); banners = []; charges = []; salvageKeys.clear();
    depotStock = 3; paused = false;
    hud.reset();
    alignSkyActors(world.spawn.x, world.spawn.z);
    weatherState.time = Math.random() * 0.85;
    weatherState.blend = 0;
    setWeather(weatherForBiome(world.biomeAt(world.spawn.x, world.spawn.z)), true);
    saveTimer = 0;
    skySeqApplied = -1; // adopt the crew's shared sky silently on first tick
    skyReqT = 0;
    if (resumeRec) restoreSnapshot(resumeRec);
    state = 'play';
    screenMode = 'play';
    screen.innerHTML = '';
    screen.style.pointerEvents = 'none';
    input.setActive(true);
    tryPointerLock();
    if (!musicStarted) { musicStarted = true; audio.music.crossfadeTo('bgm.cave', { duration: 2 }); }
    hud.say('GRUB', "Gauges green, boss! Let's dig!");
  }

  // both suits locked: the deep keeps your pack — drop it as a salvage chest, wake at camp
  function suitsWipe() {
    const dp = player.ent.pos.clone();
    const cell = { x: Math.floor(dp.x), y: Math.max(1, Math.floor(dp.y)), z: Math.floor(dp.z) };
    while (containers.has(`${cell.x},${cell.y},${cell.z}`) && cell.y < world.SY - 1) cell.y++;
    const merged = new Map();
    for (const s of player.bag.slots) if (s) merged.set(s.id, (merged.get(s.id) || 0) + s.n);
    const slots = Array(36).fill(null);
    let i = 0;
    for (const [id, n] of merged) {
      let left = n;
      while (left > 0 && i < 36) {
        const t = Math.min(left, ITEMS[id].stack);
        slots[i++] = { id, n: t };
        left -= t;
      }
    }
    if (i > 0) {
      const key = `${cell.x},${cell.y},${cell.z}`;
      world.set(cell.x, cell.y, cell.z, BLOCK.CHEST);
      containers.set(key, { slots, rev: 0 });
      salvageKeys.add(key);
    }
    // loose ore spills where you fell
    for (const k of ORE_KEYS) {
      for (let n = player.inv.ores[k] || 0; n > 0; n--) {
        const p = dp.clone();
        p.x += (Math.random() - 0.5) * 1.6;
        p.y += 0.4 + Math.random() * 0.6;
        p.z += (Math.random() - 0.5) * 1.6;
        items.spawnPickup('ore', p, k);
      }
      player.inv.ores[k] = 0;
    }
    player.bag.slots.fill(null);
    player.bag.rev++;
    player.ent.pos.copy(world.spawn);
    player.ent.vel.set(0, 0, 0);
    player.fuel = player.fuelMax;
    player.locked = false;
    rescueTimer = 0;
    grub.ent.pos.copy(world.spawn).add(new THREE.Vector3(1.2, 0, 0.6));
    grub.ent.vel.set(0, 0, 0);
    grub.revive(100);
    player.cans = 1 + (profile.projects.depot ? 1 : 0);
    grub.cans = profile.projects.bunk ? 2 : 1;
    depotStock = 3;
    audio.play('sfx.grind');
    hud.flash('#dfe8f0');
    hud.say('BUB', "Hauled ya up cold... yer pack's in a salvage chest right where ya dropped!");
    hud.say('GRUB', 'We go back for it, boss. Every last bolt!');
  }

  function pauseGame() {
    if (state !== 'play' || ui.open || paused) return;
    paused = true;
    snapshotNow(); // natural save point
    screenMode = 'pause';
    input.setActive(false);
    screen.innerHTML = pauseHTML();
    screen.style.pointerEvents = 'auto';
    wireScreen();
  }

  function resumeGame() {
    paused = false;
    screenMode = 'play';
    screen.innerHTML = '';
    screen.style.pointerEvents = 'none';
    input.consumeEdges();
    input.setActive(true);
    tryPointerLock();
  }

  function quitToMenu() {
    paused = false;
    snapshotNow(); // BEFORE endDig — coop.active decides which slot the save routes to
    coop.endDig(); // no-op in singleplayer
    persistCampChest();
    if (score > 0) leaderboard.submit(score, { playerName });
    disposeRun();
    state = 'menu';
    screenMode = 'menu';
    input.setActive(false);
    showMenu();
  }

  function showMenu() {
    screenMode = 'menu';
    screen.innerHTML = menuHTML();
    screen.style.pointerEvents = 'auto';
    wireScreen();
    // refresh the saved-worlds cache, then re-render so CONTINUE reflects the newest save
    refreshWorlds().then(() => {
      if (screenMode !== 'menu') return;
      screen.innerHTML = menuHTML();
      wireScreen();
    });
  }

  // ---------- WORLDS: load / create / delete saved worlds ----------
  function worldsHTML() {
    const rows = worldsList.map(rec => {
      const crew = rec.mode === 'coop';
      return `
      <div class="pixel-panel px-3 py-2 flex items-center gap-2 text-left">
        <div class="flex-1 min-w-0">
          <div class="font-black truncate" style="${WHITE}">${escapeAttr(rec.name || 'WORLD')}${crew ? ' <span style="color:#8dff8d">[CREW]</span>' : ''}</div>
          <div class="text-xs font-mono" style="color:#D4B483;text-shadow:0 1px 3px #000">saved ${timeAgo(rec.when)} · score ${(rec.run && rec.run.score) || 0}</div>
        </div>
        <button data-load="${escapeAttr(rec.slot)}" class="btn-brass rounded px-4 py-2 font-black">LOAD</button>
        <button data-del="${escapeAttr(rec.slot)}" class="btn-cobalt rounded px-3 py-2 font-black">DELETE</button>
      </div>`;
    }).join('');
    return `
    <div class="w-full h-full overflow-y-auto" style="${dirtBG}">
      <div class="min-h-full flex flex-col items-center justify-start md:justify-center gap-4 px-6 py-6 text-center">
        <h1 class="text-4xl md:text-6xl font-black tracking-widest" style="color:#D4B483;text-shadow:4px 4px 0 #5a4408,8px 8px 0 rgba(0,0,0,.55)">WORLDS</h1>
        <div class="pixel-panel px-3 py-2 w-full max-w-md flex gap-2 items-center">
          <input id="world-name" type="text" maxlength="22" spellcheck="false" placeholder="${escapeAttr(autoWorldName())}"
            class="flex-1 px-3 py-2 text-base font-black text-center min-w-0"
            style="background:#0e1630;color:#fff;border:2px solid #000;outline:none;text-shadow:2px 2px 0 #000">
          <button id="btn-create" class="btn-brass rounded px-4 py-2 font-black whitespace-nowrap">CREATE</button>
        </div>
        <div class="w-full max-w-md flex flex-col gap-2">${rows || `<p class="font-bold" style="${WHITE}">No saved worlds yet — CREATE one!</p>`}</div>
        <button id="btn-back" class="btn-cobalt rounded-xl px-8 py-3 text-xl font-black tracking-wider">BACK</button>
      </div>
    </div>`;
  }

  function wireWorlds() {
    const back = screen.querySelector('#btn-back');
    if (back) back.addEventListener('click', () => { audio.play('click'); showMenu(); });
    const create = screen.querySelector('#btn-create');
    if (create) create.addEventListener('click', () => {
      audio.play('click');
      const nameEl = screen.querySelector('#world-name');
      startRun(undefined, null, { name: nameEl && nameEl.value });
    });
    for (const b of screen.querySelectorAll('[data-load]')) {
      b.addEventListener('click', () => {
        const rec = worldsList.find(r => r.slot === b.dataset.load);
        if (!rec) return;
        audio.play('click');
        startRun(undefined, rec); // co-op records resume as a solo dig of the same world
      });
    }
    for (const b of screen.querySelectorAll('[data-del]')) {
      b.addEventListener('click', () => {
        audio.play('click');
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'SURE?'; return; }
        const slot = b.dataset.del;
        worldsList = worldsList.filter(r => r.slot !== slot);
        deleteSnapshot(slot);
        screen.innerHTML = worldsHTML();
        wireWorlds();
      });
    }
    refreshNavTargets(true);
  }

  function showWorlds() {
    screenMode = 'worlds';
    screen.innerHTML = worldsHTML();
    screen.style.pointerEvents = 'auto';
    wireWorlds();
    refreshWorlds().then(() => {
      if (screenMode !== 'worlds') return;
      screen.innerHTML = worldsHTML();
      wireWorlds();
    });
  }

  // ---------- DIG TOGETHER lobby (co-op frontend — separate from the singleplayer flow) ----------
  let lobbyTimer = null;
  function stopLobby() { if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; } }

  function lobbyHTML() {
    return `
    <div class="w-full h-full flex flex-col items-center justify-center gap-4 px-6 text-center" style="${dirtBG}">
      <h1 class="text-4xl md:text-6xl font-black tracking-widest" style="color:#D4B483;text-shadow:4px 4px 0 #5a4408,8px 8px 0 rgba(0,0,0,.55)">DIG TOGETHER</h1>
      <p class="text-xs md:text-sm font-bold max-w-md" style="${WHITE}">Crew up! Everyone hits READY, then any goblin starts the dig — same world, same tunnels, up to 4 miners.</p>
      <div id="coop-roster" class="pixel-panel px-6 py-3 w-full max-w-sm text-left font-mono text-sm md:text-base" style="${WHITE}"></div>
      <div class="flex gap-3 flex-wrap justify-center">
        <button id="btn-ready" class="btn-brass rounded-xl px-8 py-3 text-xl font-black tracking-wider">READY UP</button>
        <button id="btn-begin" class="btn-brass rounded-xl px-8 py-3 text-xl font-black tracking-wider">START DIG</button>
      </div>
      <div class="flex gap-3">
        <button id="btn-invite" class="btn-cobalt rounded-xl px-6 py-2 font-bold">COPY INVITE LINK</button>
        <button id="btn-back" class="btn-cobalt rounded-xl px-6 py-2 font-bold">BACK</button>
      </div>
    </div>`;
  }

  function renderRoster() {
    const el = screen.querySelector('#coop-roster');
    if (!el) return;
    const crew = coop.roster();
    el.innerHTML = crew.length
      ? crew.map(p => {
          const me = p.id === coop.myId;
          const label = sanitizePlayerName(p.playerName, `MINER ${(p.index ?? 0) + 1}`);
          return `<div>${me ? '▶ ' : ''}${escapeAttr(label)}${me ? ' (YOU)' : ''}` +
            `<span class="float-right pl-6" style="color:${p.ready ? '#8dff8d' : '#ffd873'}">${p.ready ? 'READY' : 'WAITING'}</span></div>`;
        }).join('')
      : '<div>Connecting to the burrow…</div>';
    const rb = screen.querySelector('#btn-ready');
    if (rb) rb.textContent = coop.myReady ? 'UNREADY' : 'READY UP';
  }

  function showLobby() {
    stopLobby();
    coop.setPlayerName(playerName);
    coop.joinLobby();
    screenMode = 'lobby';
    screen.innerHTML = lobbyHTML();
    screen.style.pointerEvents = 'auto';
    const rb = screen.querySelector('#btn-ready');
    const gb = screen.querySelector('#btn-begin');
    const ib = screen.querySelector('#btn-invite');
    const kb = screen.querySelector('#btn-back');
    if (rb) rb.addEventListener('click', () => { audio.play('click'); coop.toggleReady(); renderRoster(); });
    if (gb) gb.addEventListener('click', () => { audio.play('click'); coop.begin(); });
    if (ib) ib.addEventListener('click', async () => {
      audio.play('click');
      const ok = await coop.invite();
      ib.textContent = ok ? 'LINK COPIED!' : (coop.inviteUrl || 'NO LINK YET');
      setTimeout(() => { const b2 = screen.querySelector('#btn-invite'); if (b2) b2.textContent = 'COPY INVITE LINK'; }, 1600);
    });
    if (kb) kb.addEventListener('click', () => { audio.play('click'); stopLobby(); coop.leaveLobby(); showMenu(); });
    renderRoster();
    lobbyTimer = setInterval(() => {
      if (!coop.inLobby) coop.joinLobby(); // retry until the room connection is up
      renderRoster();
    }, 300); // live roster/ready refresh
    refreshNavTargets(true);
  }
  showMenu();

  // ---------- pause (ESC / P / ⏸ button) ----------
  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = '⏸';
  pauseBtn.style.cssText = 'position:absolute;top:12px;left:12px;width:52px;height:52px;z-index:25;display:none;font-size:26px;line-height:1;color:#222;background:#9c9c9c;border:3px solid #000;box-shadow:inset 3px 3px 0 rgba(255,255,255,.5), inset -3px -3px 0 rgba(0,0,0,.35);cursor:pointer;';
  pauseBtn.addEventListener('click', () => { audio.play('click'); pauseGame(); });
  root.appendChild(pauseBtn);
  window.addEventListener('keydown', e => {
    if ((e.code === 'Escape' || e.code === 'KeyP') && state === 'play' && !ui.open) {
      if (paused) resumeGame();
      else pauseGame();
    }
  });
  // desktop ESC exits pointer lock: panels flip ui.open synchronously BEFORE this
  // async event fires, so this only triggers on a real ESC-to-pause.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && state === 'play' && !ui.open && !paused && !input.isTouch) pauseGame();
  });
  // last-gasp saves: tab close / backgrounding (mobile) — fire-and-forget snapshots
  window.addEventListener('pagehide', () => snapshotNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') snapshotNow();
  });

  // ---------- panels ----------
  function panelClosed() {
    input.consumeEdges();
    if (state === 'play') input.setActive(true);
  }

  function nearBench() {
    const px = Math.floor(player.ent.pos.x), py = Math.floor(player.ent.pos.y), pz = Math.floor(player.ent.pos.z);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++)
          if (world.get(px + dx, py + dy, pz + dz) === BLOCK.TABLE) return true;
    return !!(npcs.anvilPos && player.ent.pos.distanceTo(npcs.anvilPos) < 3.5);
  }

  function openPanel(which) {
    if (!player || !grub || ui.open) return;
    input.setActive(false);
    const ctx = {
      player,
      profile,
      bag: player.bag,
      nearBench: nearBench(),
      iconURL,
      onChange: () => player.refreshGear(),
      onClose: panelClosed,
    };
    if (which === 'shop') ui.openShop(ctx);
    else ui.openInventory(ctx);
  }

  function openChestPanel(key) {
    if (!player || ui.open) return;
    let c = containers.get(key);
    if (!c) { c = { slots: Array(18).fill(null), rev: 0 }; containers.set(key, c); }
    // co-op: take the host lock + adopt confirmed contents BEFORE the panel opens
    if (coop.active) {
      const res = coop.chestOpen(key, c, () => {
        if (ui.open) ui.close();
        hud.say('GRUB', 'A crewmate grabbed that chest first!');
      });
      if (res === 'busy') { hud.say('GRUB', "Someone's already rummaging in that chest!"); return; }
    }
    input.setActive(false);
    ui.openChest({
      bag: player.bag,
      chest: c,
      title: key === campChestKey ? 'CAMP CHEST' : key === haulerChestKey ? 'HAULER YARD' : 'CHEST',
      iconURL,
      onChange: () => { coop.chestChanged(key); if (key === campChestKey) persistCampChest(); },
      onClose: () => { if (coop.active) coop.chestClosed(key); panelClosed(); },
    });
  }

  function openHaulerPanel() {
    if (!player || !hauler || ui.open) return;
    input.setActive(false);
    ui.openHauler({
      bag: player.bag,
      hauler,
      iconURL,
      onBuild: commissionHauler,
      onAddCart: addHaulerCart,
      onDispatch: dispatchHauler,
      getTrackInfo: getHaulerTrackInfo,
      onClose: panelClosed,
    });
  }

  function openOvenPanel() {
    if (!player || ui.open) return;
    input.setActive(false);
    ui.openOven({ bag: player.bag, player, iconURL, onClose: panelClosed });
  }

  function openCampPanel() {
    if (!player || ui.open) return;
    input.setActive(false);
    ui.openCamp({
      bag: player.bag,
      profile,
      iconURL,
      onBuild: tryBuildProject,
      onRefuel: bubService,
      onClose: panelClosed,
    });
  }

  function tryBuildProject(id) {
    const pr = CAMP_PROJECTS.find(p => p.id === id);
    if (!pr || profile.projects[id]) return false;
    for (const k in pr.mats) if (player.bag.count(k) < pr.mats[k]) return false;
    for (const k in pr.mats) player.bag.take(k, pr.mats[k]);
    profile.projects[id] = true;
    saveProfile(profile);
    npcs.dispose();
    npcs = createNPCs(scene, world, items, profile, renderer);
    world.setColliders(npcs.colliders);
    if (id === 'storage' && !campChestKey) placeCampChest();
    if (id === 'depot') depotStock = 3;
    audio.play('success');
    hud.say('BUB', `${pr.name} — BUILT! ${pr.desc}`);
    return true;
  }

  function bubService() {
    let banked = 0;
    for (const k of ORE_KEYS) {
      const n = player.inv.ores[k] || 0;
      if (n > 0) {
        profile.bank[k] = (profile.bank[k] || 0) + n;
        player.inv.ores[k] = 0;
        banked += n;
      }
    }
    // refined ingots bank at double value
    for (const k of ORE_KEYS) {
      const n = player.bag.count(k + '_ingot');
      if (n > 0) {
        player.bag.take(k + '_ingot', n);
        profile.bank[k] = (profile.bank[k] || 0) + 2 * n;
        banked += 2 * n;
      }
    }
    if (banked > 0) saveProfile(profile);
    player.fuel = player.fuelMax;
    player.locked = false;
    grub.revive(100);
    if (player.cans === 0) player.cans = 1;
    audio.play('powerup');
    hud.say('BUB', banked > 0
      ? `Vaulted ${banked} ore — ingots count double! Boilers topped off!`
      : 'Boilers topped off. Bring me ores for the vault — smelted ingots bank double!');
  }

  // ---------- hazards ----------
  const vv = new THREE.Vector3();
  function updateHazards(dt, t) {
    const hx = player.ent.pos.x, hz = player.ent.pos.z;
    // steam vents (distance-gated: arrays grow forever as chunks generate)
    for (const v of world.vents) {
      if (Math.abs(v.x - hx) > 18 || Math.abs(v.z - hz) > 18) continue;
      if (world.get(v.x, v.y, v.z) !== BLOCK.VENT) continue; // drilled away
      const active = ((t + v.phase) % 3.5) < 1.2;
      if (!active) continue;
      vv.set(v.x + 0.5, v.y + 1.2, v.z + 0.5);
      if (Math.random() < 0.5) items.steam(vv, 1);
      for (const c of [player, grub]) {
        const d = vv.distanceTo(c.ent.pos.clone().setY(c.ent.pos.y + 0.5));
        if (d < 1.4) {
          const mult = c === player ? player.hazardMult : 1;
          if (!c.locked) c.fuel = Math.max(0, c.fuel - 7 * dt * mult);
          c.ent.vel.y += 10 * dt;
          if (c === player) {
            hud.flash('#dfe8f0');
            hissT -= dt;
            if (hissT <= 0) { hissT = 0.4; audio.play('sfx.hiss'); }
          }
        }
      }
    }
    // dart walls (distance-gated)
    for (const d of world.darts) {
      if (Math.abs(d.x - hx) > 18 || Math.abs(d.z - hz) > 18) continue;
      if (world.get(d.x, d.y, d.z) !== BLOCK.DART) continue;
      vv.set(d.x + 0.5, d.y + 0.5, d.z + 0.5);
      const dist = vv.distanceTo(player.ent.pos.clone().setY(player.ent.pos.y + 0.9));
      if (dist < 2.3) {
        d.timer += dt;
        if (d.timer > 1.6) {
          d.timer = 0;
          if (!player.locked) player.fuel = Math.max(0, player.fuel - 7 * player.hazardMult);
          hud.flash('#ff4433');
          audio.play('shoot');
          items.burst(player.ent.pos.clone().setY(player.ent.pos.y + 1), 0xC4934A, 8);
          hud.say('GRUB', 'Dart trap! Keep movin\'!');
        }
      } else d.timer = Math.max(0, d.timer - dt * 2);
    }
    // cave-ins
    for (let i = caveQueue.length - 1; i >= 0; i--) {
      const c = caveQueue[i];
      c.t -= dt;
      if (c.t > 0) continue;
      caveQueue.splice(i, 1);
      const cells = [];
      for (let dy = 0; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx, y = c.y + dy, z = c.z + dz;
        if (world.get(x, y, z) !== BLOCK.AIR) continue;
        if (world.entityOverlapsCell(player.ent, x, y, z)) continue;
        if (world.entityOverlapsCell(grub.ent, x, y, z)) continue;
        cells.push([x, y, z]);
      }
      cells.sort(() => Math.random() - 0.5);
      const filled = [];
      for (const [x, y, z] of cells.slice(0, 7)) { world.set(x, y, z, BLOCK.ROCK); filled.push({ x, y, z }); }
      coop.reportFill(filled, BLOCK.ROCK); // sync settled rubble to the crew (no-op solo)
      audio.play('sfx.rumble');
      shakeT = 0.55;
      items.burst(new THREE.Vector3(c.x + 0.5, c.y + 1, c.z + 0.5), 0x8a7a5c, 16);
    }
    // blast charges — placed from the hand, short fuse, vaporizes plain rock (never ore/loot)
    for (let i = charges.length - 1; i >= 0; i--) {
      const c = charges[i];
      c.t -= dt;
      if (c.t > 0) {
        if (Math.random() < dt * 9) items.burst(new THREE.Vector3(c.x + 0.5, c.y + 0.8, c.z + 0.5), 0xffaa33, 2);
        continue;
      }
      charges.splice(i, 1);
      const center = new THREE.Vector3(c.x + 0.5, c.y + 0.5, c.z + 0.5);
      carveBlastRadius(c.x, c.y, c.z, 2.2);
      audio.play('sfx.rumble');
      shakeT = 0.6;
      items.burst(center, 0xffaa33, 24);
      if (!player.locked && center.distanceTo(player.ent.pos) < 3.5) {
        player.fuel = Math.max(0, player.fuel - 15 * player.hazardMult);
        hud.flash('#ff8830');
      }
    }
  }

  // ---------- main loop ----------
  const clock = new THREE.Clock();
  const rayDir = new THREE.Vector3();
  let elapsed = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    // co-op: a lobby member hit START DIG — everyone drops into the same seeded world
    if (coop.digLaunched && state !== 'play') startRun(coop.acceptDig());
    handleControllerMenuInput(dt);

    const hbWant = state === 'play' && !ui.open && !paused;
    if (hbWant !== hbShown) { hbShown = hbWant; hotbar.show(hbWant); }
    if (hbWant) hotbar.render();
    pauseBtn.style.display = state === 'play' && !ui.open && !paused ? 'block' : 'none';
    updateSkyWeather(dt, elapsed);

    // periodic autosave (solo journal, or the host-confirmed shared state in co-op)
    if (state === 'play' && world && player && !paused && !ui.open) {
      saveTimer += dt;
      if (saveTimer > 20) { saveTimer = 0; snapshotNow(); }
    }

    if (state === 'play' && world) {
      if (ui.open || paused) {
        input.showTalk(false);
        hud.update(dt, { state: 'pause' });
      } else {
        npcs.update(dt, player.ent.pos);
        mobs.update(dt);
        trees.update(dt);
        let near = npcs.nearest(player.ent.pos);
        camera.getWorldDirection(rayDir);
        const rayHit = world.raycast(camera.position, rayDir, 4.5);
        const chestHit = !!rayHit && rayHit.id === BLOCK.CHEST;
        const ovenHit = !!rayHit && rayHit.id === BLOCK.OVEN;
        const stillHit = !!rayHit && rayHit.id === BLOCK.STILL;
        const nearDepot = !!npcs.depotPos &&
          Math.hypot(player.ent.pos.x - npcs.depotPos.x, player.ent.pos.z - npcs.depotPos.z) < 2.2;
        const nearHauler = !!npcs.haulerDockPos &&
          Math.hypot(player.ent.pos.x - npcs.haulerDockPos.x, player.ent.pos.z - npcs.haulerDockPos.z) < 2.4;
        const haulerTrack = nearHauler ? getHaulerTrackInfo() : null;
        const canTakeCan = nearDepot && depotStock > 0 && player.cans < 3;
        input.showTalk(!!near || nearHauler || chestHit || ovenHit || stillHit || canTakeCan,
          near ? 'TALK' : nearHauler ? 'LOAD' : stillHit ? 'USE' : canTakeCan && !chestHit && !ovenHit ? 'TAKE' : 'OPEN');

        if (input.edges.use) {
          // consume the edge ONLY when handled — otherwise player.js drinks a can with it
          if (near) {
            input.edges.use = false;
            if (near.id === 'tub') openPanel('shop');
            else openCampPanel();
          } else if (nearHauler) {
            input.edges.use = false;
            openHaulerPanel();
          } else if (stillHit) {
            input.edges.use = false;
            if (player.bag.count('log') < 2) hud.say('YOU', 'Still needs 2 logs in the bag to cook fuel.');
            else if (player.fuel >= player.fuelMax - 1) hud.say('YOU', "Boiler's already brimming.");
            else {
              player.bag.take('log', 2);
              player.fuel = Math.min(player.fuelMax, player.fuel + 30);
              items.steam(new THREE.Vector3(rayHit.x + 0.5, rayHit.y + 1.2, rayHit.z + 0.5), 3);
              audio.play('powerup');
              hud.say('YOU', '*glug* Wood-gas straight to the boiler!');
            }
          } else if (canTakeCan) {
            input.edges.use = false;
            player.cans++;
            depotStock--;
            audio.play('pickup');
          } else if (chestHit) {
            input.edges.use = false;
            openChestPanel(`${rayHit.x},${rayHit.y},${rayHit.z}`);
          } else if (ovenHit) {
            input.edges.use = false;
            openOvenPanel();
          }
        }
        if (input.edges.inv) {
          input.edges.inv = false;
          openPanel('inv');
        }

        if (!ui.open) {
          // infinite world: stream chunks around the player, spawn cans from freshly generated rooms
          world.update(player.ent.pos);
          for (const p of world.canSpawns.splice(0)) items.spawnPickup('can', p);
          player.update(dt, grub, cb);
          grub.update(dt, player, cb);
          items.update(dt, { player, grub }, itemCb);
          updateHazards(dt, elapsed);
          coop.tick(world, player, dt); // co-op: sync my position, apply crew breaks, lerp-render mates
          world.flush();
          if (hauler && hauler.inTransit) {
            hauler.eta -= dt;
            if (npcs.haulerDockPos && Math.random() < dt * 7) {
              vv.set(npcs.haulerDockPos.x, npcs.haulerDockPos.y + 1.1, npcs.haulerDockPos.z - 0.4);
              items.steam(vv, 1);
            }
            if (hauler.eta <= 0) resolveHaulerArrival();
          }

          // rescue fallback
          if (player.locked) {
            rescueTimer += dt;
            if (rescueTimer > 30) {
              player.fuel = 25;
              player.locked = false;
              hud.say('YOU', 'Mercy valve popped — emergency reserve online!');
              audio.play('powerup');
            }
          } else rescueTimer = 0;

          // ore vacuum: seamless banking at camp — no run interruption (tier 2 widens the intake)
          if (npcs.vacuumPos && !player.locked) {
            const vd = player.ent.pos.distanceTo(npcs.vacuumPos);
            if (vd < (profile.projects.turbine ? 7 : 4.5)) {
              vacT -= dt;
              const k = ORE_KEYS.find(ok => player.inv.ores[ok] > 0);
              if (k && vacT <= 0) {
                vacT = 0.16;
                player.inv.ores[k]--;
                audio.play('sfx.slurp');
                const from = player.ent.pos.clone().setY(player.ent.pos.y + 1.2);
                items.flyOre(k, from, npcs.vacuumIntake, kind => {
                  profile.bank[kind] = (profile.bank[kind] || 0) + 1;
                  score += ORE_VALUE[kind];
                  saveProfile(profile);
                  audio.play('coin');
                });
                if (!vacHinted) {
                  vacHinted = true;
                  hud.say('BUB', "Vacuum's slurpin' yer ores straight to the vault!");
                }
              }
            }
          }

          // Boiler House: standing in camp slowly refills yours AND Grub's boiler
          if (profile.projects.boiler &&
              Math.hypot(player.ent.pos.x - world.spawn.x, player.ent.pos.z - world.spawn.z) < 8) {
            if (!player.locked) player.fuel = Math.min(player.fuelMax, player.fuel + 4 * dt);
            if (!grub.locked) grub.fuel = Math.min(100, grub.fuel + 4 * dt);
          }

          // both suits locked — the deep keeps the pack; respawn at camp and go reclaim it
          if (player.locked && grub.locked) suitsWipe();

          // camera shake
          if (shakeT > 0) {
            shakeT -= dt;
            camera.position.x += (Math.random() - 0.5) * shakeT * 0.35;
            camera.position.y += (Math.random() - 0.5) * shakeT * 0.35;
          }

          // glow lanterns: pooled lights follow the nearest placed lanterns
          let li = 0;
          if (lanterns.size) {
            const sorted = [];
            for (const p of lanterns.values()) {
              const d = p.distanceTo(player.ent.pos);
              if (d < 30) sorted.push([d, p]);
            }
            sorted.sort((a, b) => a[0] - b[0]);
            for (const [, p] of sorted.slice(0, lanternLights.length)) {
              const L = lanternLights[li++];
              L.position.copy(p);
              L.intensity = 16;
              L.visible = true;
            }
          }
          for (; li < lanternLights.length; li++) lanternLights[li].visible = false;

          // compass markers: camp, distant Grub, salvage chests, 3 nearest banners
          const ppx = player.ent.pos.x, ppz = player.ent.pos.z;
          const angTo = (x, z) => Math.atan2(x - ppx, -(z - ppz)) * 180 / Math.PI;
          const markers = [{ ang: angTo(world.spawn.x, world.spawn.z), kind: 'camp', color: '#ffd873' }];
          if (grub.ent.pos.distanceTo(player.ent.pos) > 6)
            markers.push({ ang: angTo(grub.ent.pos.x, grub.ent.pos.z), kind: 'grub', color: '#6fbf4a' });
          for (const key of salvageKeys) {
            const [sx, , sz] = key.split(',').map(Number);
            markers.push({ ang: angTo(sx + 0.5, sz + 0.5), kind: 'chest', color: '#ff8873' });
          }
          banners
            .map(b => [Math.hypot(b.x + 0.5 - ppx, b.z + 0.5 - ppz), b])
            .sort((a, b) => a[0] - b[0])
            .slice(0, 3)
            .forEach(([, b]) => markers.push({ ang: angTo(b.x + 0.5, b.z + 0.5), kind: 'flag', color: '#60A5FA' }));

          near = npcs.nearest(player.ent.pos);
          const eP = input.isTouch ? '' : '[E] ';
          hud.update(dt, {
            state: 'play',
            fuel: player.fuel, fuelMax: player.fuelMax, grubFuel: grub.fuel,
            locked: player.locked, grubLocked: grub.locked,
            cans: player.cans, ores: player.inv.ores, score,
            depth: Math.max(0, Math.floor(world.heightAt(player.ent.pos.x, player.ent.pos.z) - player.ent.pos.y)),
            drillProgress: player.drillProgress || 0,
            yaw: player.yaw,
            markers,
            prompt: near ? `${eP}TALK — ${near.name}`
              : nearHauler ? `${eP}LOAD HAULER — ${
                hauler && hauler.inTransit ? `returning (${Math.ceil(hauler.eta)}s)`
                  : !hauler || !hauler.built ? 'commission needed'
                    : `track ${haulerTrack ? haulerTrack.routeLen : 0}/${haulerTrack ? haulerTrack.minRoute : HAULER_MIN_TRACK_SEGMENTS}, ${hauler.carts} carts`
              }`
              : stillHit ? `${eP}USE STILL — 2 LOGS → FUEL`
              : canTakeCan ? `${eP}TAKE CAN — rack has ${depotStock}`
              : chestHit ? `${eP}OPEN CHEST`
              : ovenHit ? `${eP}USE OVEN` : '',
          });
        } else {
          input.showTalk(false);
          hud.update(dt, { state: 'pause' });
        }
      }
    } else {
      input.showTalk(false);
      hud.update(dt, { state });
    }

    renderer.clear();
    camera.layers.set(0);
    renderer.render(scene, camera);

    // Viewmodel pass: render local first-person rig on top of world depth.
    const sceneBg = scene.background;
    scene.background = null;
    camera.layers.set(FIRST_PERSON_LAYER);
    renderer.clearDepth();
    renderer.render(scene, camera);
    camera.layers.set(0);
    scene.background = sceneBg;
  });
}
