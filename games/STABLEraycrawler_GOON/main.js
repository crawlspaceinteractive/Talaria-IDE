import { Raycaster } from './raycaster.js';
import { Player, AMMO_CRATE_GRANT } from './player.js';
import { MapGen, GEM_COLORS, GEM_WALL_IDS, GEM_KEY_ITEMS } from './mapgen.js';
import { EnemyManager } from './enemies.js';
import { Renderer } from './renderer.js';
import { keybinds, buildKeybindUI } from './keybinds.js';
import { InputManager } from './input.js';
import { Shop, WEAPONS } from './shop.js';
import { MidiPlayer } from './midi.js';
import {
  loadAllSprites, loadWeaponSprites, loadEnemyAnims,
  loadEnemySfx, loadWeaponSfx, cloneAudio,
  AMBIENCE_URLS, HAT_BRIM_URL, loadImg,
  SPRITE_URLS, WEAPON_SPRITE_URLS, customSfx,
  precacheTextures, WeaponSpriteManager, doorSfx
} from './assets.js';
import { createLeaderboard } from './star-sdk/v1/leaderboard.js';
import { createPayments } from './star-sdk/v1/payments.js';
import { ModEditor } from './modeditor.js';
import { TouchControls } from './touch.js';
import { createCRT, tickCRT } from './crt.js';

const leaderboard = createLeaderboard();
const payments = createPayments();

/** Returns the active mod font (set by the mod editor) or the default. */
function getModFont() {
  return window.__modFont__ || "'Press Start 2P', 'Courier New', monospace";
}

// ================== MIDI PLAYER ==================
const midiPlayer = new MidiPlayer();

// ================== INTRO JINGLE ==================
const _introJingle = new Audio('./sounds/ambience/intro_jingle.mp3');
_introJingle.volume = 0.8;
_introJingle.loop   = false;

let _introJingleTimer = null;
let _introJingleFadeTimer = null;

/** Play intro jingle — silently swallows autoplay policy errors.
 *  Stops hard at 5s, fades out starting at 2s (3s fade). */
function _playIntroJingle() {
  _clearIntroJingleTimers();
  const startVol = audioVolumes.menuMusic;
  try {
    _introJingle.currentTime = 0;
    _introJingle.volume = startVol;
    const p = _introJingle.play();
    if (p && p.catch) p.catch(() => {});
  } catch(e) { return; }

  // Begin fade at 2 seconds, fade lasts 8s (until 10s mark)
  _introJingleFadeTimer = setTimeout(() => {
    const FADE_DURATION = 8000; // ms (2s → 10s)
    const steps = 80;
    const interval = FADE_DURATION / steps;
    let step = 0;
    const fade = setInterval(() => {
      step++;
      // Read live slider value each tick so slider drags during fade are respected
      try { _introJingle.volume = Math.max(0, audioVolumes.menuMusic * (1 - step / steps)); } catch(e) {}
      if (step >= steps) clearInterval(fade);
    }, interval);
  }, 2000);

  // Hard stop at 10 seconds
  _introJingleTimer = setTimeout(() => {
    _stopIntroJingle();
  }, 10000);
}

function _clearIntroJingleTimers() {
  if (_introJingleFadeTimer) { clearTimeout(_introJingleFadeTimer); _introJingleFadeTimer = null; }
  if (_introJingleTimer)     { clearTimeout(_introJingleTimer);     _introJingleTimer = null; }
}

/** Stop intro jingle. */
function _stopIntroJingle() {
  _clearIntroJingleTimers();
  try { _introJingle.pause(); _introJingle.currentTime = 0; _introJingle.volume = audioVolumes.menuMusic; } catch(e) {}
}

// ================== AUDIO VOLUME STATE ==================
const audioVolumes = {
  fx: 0.32,        // weapon/enemy SFX
  music: 0.7,      // MIDI music
  ambience: 0.55,  // ambient drone
  menuMusic: 0.25,  // intro jingle / menu music
};

// Preload hat brim image
const hatBrimImg = loadImg(HAT_BRIM_URL);

// Preload intermission screen texture
const intermissionBgImg = loadImg('./graphics/INTERMISSION.png');

// ===  State ===
const state = {
  phase: 'menu',
  level: 1,
  score: 0,
  gold: 0,
  muzzleTimer: 0,
  damageFlashTimer: 0,
  messageTimer: 0,
  messageText: '',
  paused: false,
  levelTransition: false,
  projectiles: [],
  hitEffects: [],
  bloodParticles: [],
  explosionEffects: [],
  screenShake: 0,
  screenShakeDx: 0,
  screenShakeDy: 0,
  nearSecretWall: null,
  secretWallData: null,
  useCooldown: false,
  fullscreenMap: false,
  mapToggleCooldown: false,
  bossRoar: false,
  bossRoarType: '',
  ownedWeapons: null,
  ownedUpgrades: null,
  ownedHats: null,
  equippedHat: null,
  // Intermission
  intermission: null, // { phase:'stats'|'entering', timer, stats, nextLevel, nextLabel, goToShop }
  // Level stat tracking
  levelStats: { kills: 0, goldEarned: 0, secretsFound: 0, timeStart: 0 },
};

// ================== DATE/TIME SEED ==================
function makeDateSeed() {
  const now = new Date();
  return (
    now.getFullYear()  * 100000000 +
    (now.getMonth()+1) * 1000000 +
    now.getDate()      * 10000 +
    now.getHours()     * 100 +
    now.getMinutes()
  );
}

function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seededMapGen(seed, fn) {
  const native = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = native; }
}

let _runSeed = makeDateSeed();

// ================== LOAD ALL ASSETS ==================
const assets = loadAllSprites();
const weaponSprites = loadWeaponSprites(); // kept for ModEditor legacy compat
const weaponManager = new WeaponSpriteManager(); // decoupled offscreen canvas pipeline
const enemyAnims = loadEnemyAnims();
const enemySfx = loadEnemySfx();
const weaponSfx = loadWeaponSfx();

// ================== MOD EDITOR ==================
// Build a map of original URLs so the editor can restore defaults
const _originalUrls = {
  assets: {},
  weaponSprites: {},
  hatBrim: HAT_BRIM_URL,
};
for (const [k, v] of Object.entries(SPRITE_URLS))         _originalUrls.assets[k] = v;
for (const [k, v] of Object.entries(WEAPON_SPRITE_URLS))  _originalUrls.weaponSprites[k] = v;

const modEditor = new ModEditor({
  assets,
  weaponSprites,
  weaponManager,              // WeaponSpriteManager — hotSwap called alongside legacy refs
  hatBrimImgRef: hatBrimImg,  // direct Image ref — hotSwapImage will change .src
  originalUrls: _originalUrls,
});
// Hand the intro jingle Audio node + stop/play hooks to the mod editor
// so it can swap the src when the user uploads a custom clip
modEditor.setIntroJingleAudio(_introJingle, _stopIntroJingle, _playIntroJingle);

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const minimapCanvas = document.getElementById('minimap');
const mmCtx = minimapCanvas.getContext('2d');

const input = new InputManager(canvas);
const _gameContainer = document.getElementById('game-container');
const touchControls = new TouchControls(_gameContainer, input);
let map, player, raycaster, enemies, renderer;
let shop = null;
let crtHandle = null;

// ================== WEAPON SCROLL HELPER ==================
function _scrollWeapon(dir) {
  if (state.phase !== 'playing' || state.paused || state.levelTransition || !player || !state.ownedWeapons) return;
  const owned = state.ownedWeapons.filter(w => w.owned);
  if (owned.length < 2) return;
  const idx = owned.findIndex(w => w.id === player.equippedWeapon);
  const next = (idx + dir + owned.length) % owned.length;
  player.equippedWeapon = owned[next].id;
  showMessage(owned[next].name, 800);
  updateHUD();
}

// ── Wire touch button callbacks ──────────────────────────────────────────────
// These are called directly instead of dispatching synthetic keyboard events,
// which don't propagate reliably inside sandboxed iframes.
touchControls.onPause = () => {
  if (state.phase !== 'playing' || state.levelTransition) return;
  state.paused = !state.paused;
  if (state.paused) {
    state.fullscreenMap = false;
    document.exitPointerLock();
    showPauseMenu();
  } else {
    hidePauseMenu();
    tryLockPointer();
  }
};

touchControls.onMap = () => {
  if (state.phase !== 'playing' || state.paused || state.levelTransition || state.mapToggleCooldown) return;
  state.fullscreenMap = !state.fullscreenMap;
  state.mapToggleCooldown = true;
  setTimeout(() => { state.mapToggleCooldown = false; }, 220);
};

touchControls.onWeaponNext = () => _scrollWeapon(+1);
touchControls.onWeaponPrev = () => _scrollWeapon(-1);

// ================== WEAPON LOOKUP ==================
function getActiveWeapon() {
  if (!player || !state.ownedWeapons) return WEAPONS[0];
  return state.ownedWeapons.find(w => w.id === player.equippedWeapon) || WEAPONS[0];
}

// ================== PROJECTILE SYSTEM ==================
const PROJECTILE_SPEED = 14.0;

function spawnProjectile(px, py, angle, weapon) {
  const dmg = (weapon.damage || 45) * (player.damageMult || 1.0);
  state.projectiles.push({
    x: px, y: py,
    vx: Math.cos(angle) * PROJECTILE_SPEED,
    vy: Math.sin(angle) * PROJECTILE_SPEED,
    angle, alive: true, life: 2.2, trail: [], damage: dmg,
    weaponType: weapon.id || 'firetome',
  });
}

function spawnCannonBall(px, py, angle, weapon) {
  const dmg = (weapon.damage || 200) * (player.damageMult || 1.0);
  state.projectiles.push({
    x: px, y: py,
    vx: Math.cos(angle) * PROJECTILE_SPEED * 0.5,
    vy: Math.sin(angle) * PROJECTILE_SPEED * 0.5,
    angle, alive: true, life: 4.0, trail: [], damage: dmg,
    weaponType: 'cannon',
  });
}

function spawnShotgunSpread(px, py, angle, weapon) {
  const pellets = weapon.pellets || 5;
  const spread  = weapon.spread  || 0.18;
  const dmg = (weapon.damage || 18) * (player.damageMult || 1.0);
  const wType = weapon.id || 'firetome';
  for (let i = 0; i < pellets; i++) {
    const pelletAngle = angle + (Math.random() - 0.5) * spread * 2;
    state.projectiles.push({
      x: px, y: py,
      vx: Math.cos(pelletAngle) * PROJECTILE_SPEED * 1.2,
      vy: Math.sin(pelletAngle) * PROJECTILE_SPEED * 1.2,
      angle: pelletAngle, alive: true, life: 0.9, trail: [], damage: dmg,
      weaponType: wType,
    });
  }
}

function _getEnemySfxKey(e) {
  if (e.isAbomination) return 'abomination';
  if (e.isBoss) return 'troll';
  return e.type || 'goblin';
}

function playEnemyDeathSfx(e) {
  const key = _getEnemySfxKey(e);
  const customKey = `enemy_${key}`;
  const src = customSfx[customKey] || enemySfx[key] || enemySfx.goblin;
  if (src) {
    const fxVol = audioVolumes.fx;
    const vol = (key === 'goblin') ? fxVol * 0.94 : Math.min(1, fxVol * 1.4);
    try { cloneAudio(src, vol).play().catch(() => {}); } catch(err) {}
  }
}

function playWeaponSfx(weaponId) {
  const customKey = `wpn_${weaponId}`;
  const src = customSfx[customKey] || weaponSfx[weaponId] || weaponSfx.pistol;
  if (src) {
    try { cloneAudio(src, audioVolumes.fx).play().catch(() => {}); } catch(err) {}
  }
}

function updateProjectiles(dt) {
  for (const bolt of state.projectiles) {
    if (!bolt.alive) continue;
    bolt.life -= dt;
    if (bolt.life <= 0) { bolt.alive = false; continue; }

    bolt.trail.push({ x: bolt.x, y: bolt.y });
    if (bolt.trail.length > 6) bolt.trail.shift();

    // Step-trace the bolt movement in sub-cell increments so fast projectiles
    // can't tunnel through thin walls (one step ≤ 0.45 tiles).
    const totalDX = bolt.vx * dt;
    const totalDY = bolt.vy * dt;
    const moveDist = Math.sqrt(totalDX * totalDX + totalDY * totalDY);
    const STEP = 0.45;
    const steps = Math.max(1, Math.ceil(moveDist / STEP));
    const stepX = totalDX / steps;
    const stepY = totalDY / steps;
    let hitWall = false;
    for (let s = 0; s < steps; s++) {
      const nx = bolt.x + stepX;
      const ny = bolt.y + stepY;
      if (map.isWall(nx, ny)) {
        bolt.alive = false;
        if (bolt.weaponType === 'cannon') {
          spawnExplosionEffect(bolt.x, bolt.y);
          cannonSplash(bolt.x, bolt.y, null);
          state.screenShake = 0.22;
        } else {
          spawnHitEffect(bolt.x, bolt.y, 'wall');
          state.screenShake = 0.06;
        }
        hitWall = true;
        break;
      }
      bolt.x = nx;
      bolt.y = ny;
    }
    if (hitWall) continue;

    for (const e of enemies.list) {
      if (!e.alive) continue;
      const radius = e.isAbomination ? 1.0 : (e.isBoss ? 0.8 : 0.35);
      const edx = e.x - bolt.x;
      const edy = e.y - bolt.y;
      if (edx * edx + edy * edy < (0.12 + radius) * (0.12 + radius)) {
        bolt.alive = false;
        const dmg = bolt.damage + Math.random() * 15;
        const killed = enemies.applyDamage(e, dmg);
        if (killed) {
          const scoreBonus = (e.scoreValue || 100) * Math.max(1, Math.floor(state.level / 5));
          const goldBonus  = (e.goldValue  || 10)  * Math.max(1, Math.floor(state.level / 5));
          state.score += scoreBonus;
          state.gold  += goldBonus;
          state.levelStats.kills++;
          state.levelStats.goldEarned += goldBonus;
          if (e.isAbomination) {
            showMessage('THE ABOMINATION IS SLAIN!', 5000);
            state.screenShake = 0.6;
          } else if (e.isBoss) {
            showMessage('TROLL WARLORD SLAIN!', 4000);
            state.screenShake = 0.4;
          } else {
            const typeNames = { goblin: 'GOBLIN', bat: 'BAT', spider: 'SPIDER' };
            showMessage(`${typeNames[e.type] || 'ENEMY'} SLAIN! +${scoreBonus}`);
          }
          playEnemyDeathSfx(e);
        }
        if (bolt.weaponType === 'cannon') {
          spawnExplosionEffect(bolt.x, bolt.y);
          cannonSplash(bolt.x, bolt.y, e);
          state.screenShake = e.isAbomination ? 0.6 : (e.isBoss ? 0.45 : 0.30);
        } else {
          spawnHitEffect(bolt.x, bolt.y, 'enemy');
          state.screenShake = e.isAbomination ? 0.35 : (e.isBoss ? 0.25 : 0.12);
        }
        break;
      }
    }
  }

  if (state.projectiles.length > 60) {
    state.projectiles = state.projectiles.filter(b => b.alive);
  }
}

function spawnHitEffect(x, y, type) {
  // legacy wall hits: no effect
  if (type !== 'enemy') return;
  spawnBloodParticles(x, y);
}

// Spawn a billboard explosion effect (squash → scale up → fade)
// duration: total life in seconds; maxSize: world-unit radius at peak
const EXPLOSION_DURATION = 0.55;
function spawnExplosionEffect(x, y) {
  state.explosionEffects.push({
    x, y,
    life: EXPLOSION_DURATION,
    maxLife: EXPLOSION_DURATION,
  });
}

// Apply cannon splash damage: 32 map-units radius = 32/64 = 0.5 world tiles
const CANNON_SPLASH_RADIUS = 0.5; // in world units (1 tile = 64 map units → 32 mu = 0.5)
function cannonSplash(cx, cy, primaryEnemy) {
  const rSq = CANNON_SPLASH_RADIUS * CANNON_SPLASH_RADIUS;
  for (const e of enemies.list) {
    if (!e.alive) continue;
    if (e === primaryEnemy) continue; // primary already damaged
    const dx = e.x - cx, dy = e.y - cy;
    if (dx * dx + dy * dy > rSq) continue;
    const splashDmg = 80 * (player.damageMult || 1.0);
    const killed = enemies.applyDamage(e, splashDmg);
    if (killed) {
      const scoreBonus = (e.scoreValue || 100) * Math.max(1, Math.floor(state.level / 5));
      const goldBonus  = (e.goldValue  || 10)  * Math.max(1, Math.floor(state.level / 5));
      state.score += scoreBonus;
      state.gold  += goldBonus;
      state.levelStats.kills++;
      state.levelStats.goldEarned += goldBonus;
      playEnemyDeathSfx(e);
    }
    spawnBloodParticles(e.x, e.y);
  }
}

function spawnBloodParticles(x, y) {
  const count = 8 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) {
    const hAngle = Math.random() * Math.PI * 2;
    const hSpeed = 0.5 + Math.random() * 1.5;
    const vz0 = -(1.5 + Math.random() * 2.0); // upward burst in world units/s
    const maxLife = 0.4 + Math.random() * 0.25;
    state.bloodParticles.push({
      x, y,
      z: 0.5, // start at mid-wall height (0=floor, 1=ceiling)
      vx: Math.cos(hAngle) * hSpeed,
      vy: Math.sin(hAngle) * hSpeed,
      vz: vz0,
      life: maxLife,
      maxLife,
    });
  }
}

// ================== MELEE ATTACK ==================
function meleeSword() {
  const range = 1.5;
  for (const e of enemies.list) {
    if (!e.alive) continue;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > range) continue;
    const angle = Math.atan2(dy, dx);
    let diff = angle - player.angle;
    while (diff > Math.PI)  diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > 1.0) continue;

    const dmg = 999 * (player.damageMult || 1.0);
    const killed = enemies.applyDamage(e, dmg);
    if (killed) {
      const scoreBonus = (e.scoreValue || 100) * Math.max(1, Math.floor(state.level / 5));
      const goldBonus  = (e.goldValue  || 10);
      state.score += scoreBonus;
      state.gold  += goldBonus;
      state.levelStats.kills++;
      state.levelStats.goldEarned += goldBonus;
      showMessage(e.isBoss ? 'BOSS SLAIN BY BLADE!' : 'SLAIN!');
      playEnemyDeathSfx(e);
    }
    spawnHitEffect(e.x, e.y, 'enemy');
    state.screenShake = 0.15;
  }
}

// ================== LEVEL INIT ==================
function getLevelLabel(level, theme) {
  if (!theme) return `LEVEL ${level}`;
  return `LEVEL ${level} — ${theme.label}`;
}

// ── Loading screen helpers ────────────────────────────────────────────────────
const _lsEl     = () => document.getElementById('loading-screen');
const _lsBar    = () => document.getElementById('ls-bar');
const _lsStatus = () => document.getElementById('ls-status');

function _showLoadingScreen() {
  const el = _lsEl(); if (el) el.classList.add('visible');
  // Hide ready button when (re)showing loading screen
  const btn = document.getElementById('ls-ready-btn');
  if (btn) btn.classList.remove('visible');
  _setLoadProgress(0, 'PRECACHING MAP...');
}
function _hideLoadingScreen() {
  const el = _lsEl(); if (el) el.classList.remove('visible');
  const btn = document.getElementById('ls-ready-btn');
  if (btn) btn.classList.remove('visible');
}
// Show the READY? button — player clicks it to dismiss the loading screen and
// capture the pointer. Returns a Promise that resolves once the player clicks.
function _waitForReady() {
  return new Promise(resolve => {
    const btn = document.getElementById('ls-ready-btn');
    const st  = _lsStatus();
    if (!btn) { _hideLoadingScreen(); resolve(); return; }
    if (st) { st.textContent = 'ARMED AND READY'; st.style.animation = 'none'; }
    btn.classList.add('visible');
    // Inherit mod font if set
    const modFont = (typeof getModFont === 'function') ? getModFont() : null;
    if (modFont) btn.style.fontFamily = modFont;

    // Register & activate for keyboard/gamepad navigation so Enter or A fires it
    menuNav.register('precache-ready', [btn], null);
    menuNav.activate('precache-ready');

    const _done = () => {
      menuNav.deactivate();
      menuNav.register('precache-ready', [], null); // unregister to avoid stale ref
      btn.classList.remove('visible');
      _hideLoadingScreen();
      resolve();
    };
    btn.onclick = _done;
  });
}
function _setLoadProgress(pct, msg) {
  const bar = _lsBar(); if (bar) bar.style.width = pct + '%';
  const st = _lsStatus(); if (st && msg) st.textContent = msg;
}

// Yield one animation frame so the browser can paint the loading screen
function _raf() { return new Promise(r => requestAnimationFrame(r)); }

/**
 * Play a 1-frame silent AudioBuffer through the MIDI player's AudioContext.
 * This primes the WebAudio graph during the loading phase so that when real
 * MIDI notes arrive they don't cause a stutter/freeze due to a cold context.
 * Must be called from inside a user-gesture callback (the READY? click path
 * is downstream of the start-btn click, which satisfies the gesture requirement).
 */
function _playSilentSample() {
  try {
    midiPlayer._ensureAudioCtx();
    const ctx = midiPlayer._audioCtx;
    if (!ctx) return;
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch(e) { /* non-fatal */ }
}

async function initLevel(level) {
  // Guard the entire loading + READY phase so the game loop's update() never
  // runs while the map/player are half-initialised.  Cleared after _waitForReady().
  state.levelTransition = true;

  const mapSize = Math.min(16 + level * 2, 80);
  const levelSeed = (_runSeed + level * 99991) >>> 0;

  // ── Step 1: texture precache — wait for every Image to be fully decoded ───
  // Runs before map gen so the renderer never draws a blank/missing texture.
  // Progress fires per-image so the bar advances smoothly from 2% → 32%.
  // SANITY: precacheTextures resolves on load OR error, so a CDN hiccup on
  // one image won't freeze the entire loading screen.
  _setLoadProgress(2, 'LOADING TEXTURES...');
  await _raf();
  // Run world-sprite precache and weapon-sprite baking in parallel
  await Promise.all([
    precacheTextures(assets, null, enemyAnims, (loaded, total) => {
      if (total === 0) return;
      const pct = 2 + Math.round((loaded / total) * 30); // 2% → 32%
      _setLoadProgress(pct, `LOADING TEXTURES... ${loaded}/${total}`);
    }),
    weaponManager.ready(),
  ]);
  _setLoadProgress(32, 'TEXTURES READY');
  await _raf();

  // ── Step 1b: prime AudioContext + start MIDI shuffle during loading ───────
  // Firing the silent sample here unlocks the WebAudio graph so MIDI notes
  // don't cause a stutter when the first real track starts.  We also kick off
  // playRandom() now (while the CPU-bound map-gen is about to run) so the
  // music is already playing by the time the READY? button appears.
  // This call is safe on all levels: playRandom() stops any current track
  // before loading the next, so level-to-level transitions just crossfade.
  _playSilentSample();
  if (midiPlayer.autoAdvance && (midiPlayer.playlist.length > 0 || midiPlayer.isLoaded)) {
    midiPlayer.setVolume(audioVolumes.music);
    midiPlayer.playRandom();
  }
  await _raf();

  // ── Step 2: generate map (CPU-bound) ─────────────────────────────────────
  _setLoadProgress(36, 'GENERATING DUNGEON...');
  await _raf();
  map = seededMapGen(levelSeed, () => MapGen.generate(mapSize, mapSize, level));
  map.seed = levelSeed;
  _setLoadProgress(50, 'DUNGEON CARVED');
  await _raf();

  // ── Step 3: build raycaster + precache distance map ──────────────────────
  // SANITY: raycaster.precache() must be called on a freshly constructed
  // Raycaster — it sets this.distToWall which the DDA loop reads.  The
  // Raycaster constructor is cheap; precache() is the BFS and takes ~1 ms.
  _setLoadProgress(54, 'BUILDING RAYCASTER...');
  await _raf();
  raycaster = new Raycaster(map);

  _setLoadProgress(62, 'PRECACHING DISTANCES...');
  await _raf();
  raycaster.precache(); // BFS multi-source distance map — O(n) one-shot

  // ── Attach torch stickers to their wall faces ───────────────────────────────────────
  // Each torch sits at a floor tile adjacent to a wall. We find that wall tile
  // by checking the 4 cardinal neighbours, then call attachSticker() so the
  // torch plate decal projects correctly onto the wall surface.
  // Must run after precache() (which allocates raycaster.stickers) and
  // before the first render frame.
  raycaster.clearAllStickers();
  for (const t of (map.torches || [])) {
    // wallX/wallY/normX/normY baked by mapgen from the known placement side —
    // no neighbour scan needed, and only the correct face gets a sticker.
    raycaster.attachSticker(
      t.wallX, t.wallY,
      t.x, t.y,   // world-space centre of the sticker (torch position)
      0.6,        // worldZ: slightly above mid-wall
      'torch',
      0.25,       // half-width in world units
      0.25,       // half-height in world units
    );
  }

  _setLoadProgress(70, 'DISTANCES BAKED');
  await _raf();

  // ── Step 4: spawn enemies + renderer ─────────────────────────────────────
  _setLoadProgress(74, 'SPAWNING ENEMIES...');
  await _raf();
  enemies  = new EnemyManager(map, level, raycaster);
  renderer = new Renderer(canvas, ctx, assets, map, raycaster, weaponManager, enemyAnims);
  renderer.invalidateGradientLUT();
  _setLoadProgress(80, 'ENEMIES SPAWNED');
  await _raf();

  // ── Step 4b: precache sprite fog buckets (bakes darkness levels at native res) ──
  // SANITY: renderer.precacheAllSprites() references this.assets and
  // this.weaponSprites which are set in the Renderer constructor above.
  // It also schedules two deferred re-runs (800 ms, 2500 ms) to catch any
  // images that hadn't finished decoding by the time this runs — those
  // fallback timers are still valuable for mods loaded mid-session.
  _setLoadProgress(84, 'PRECACHING SPRITES...');
  await _raf();
  renderer.precacheAllSprites();
  _setLoadProgress(90, 'SPRITES BAKED');
  await _raf();

  // ── Step 5: player state ──────────────────────────────────────────────────
  _setLoadProgress(93, 'ARMING PLAYER...');
  await _raf();

  const prevPlayer = player;
  player = new Player(map.startX, map.startY, map.startAngle);
  if (prevPlayer) {
    player.health       = prevPlayer.health;
    player.maxHealth    = prevPlayer.maxHealth;
    player.ammo         = prevPlayer.ammo;
    player.maxAmmo      = prevPlayer.maxAmmo;
    player.speedMult    = prevPlayer.speedMult;
    player.stealthMult  = prevPlayer.stealthMult;
    player.damageMult   = prevPlayer.damageMult;
    player.equippedWeapon = prevPlayer.equippedWeapon;
    player.inventory    = {};
    // Carry over per-weapon ammo pools
    if (prevPlayer.weaponAmmo) {
      player.weaponAmmo = Object.assign({}, prevPlayer.weaponAmmo);
    }
  } else {
    player.health = 100;
    player.ammo   = 50 + level * 5;
    player.inventory = {};
    // Starting ammo pools are already set in Player constructor
  }

  if (state.ownedWeapons) {
    state.ownedWeapons.forEach(w => {
      if (w.owned) {
        const wdDef = WEAPONS.find(x => x.id === w.id);
        if (wdDef) wdDef.owned = true;
      }
    });
  }

  state.projectiles  = [];
  state.hitEffects   = [];
  state.screenShake  = 0;
  state.nearSecretWall = null;
  state.secretWallData = null;
  state.useCooldown    = false;
  state.bossRoar       = false;
  state.bossRoarType   = '';
  state.levelStats = { kills: 0, goldEarned: 0, secretsFound: 0, timeStart: performance.now() };
  updateHUD();

  if (map.isAbominationLevel) {
    showMessage('THE ABOMINATION STIRS...', 5000);
  } else if (map.isBossLevel) {
    showMessage('A TROLL WARLORD AWAITS...', 4000);
  }
  document.getElementById('hud-level').textContent = level;

  // ── Done ─────────────────────────────────────────────────────────────��────
  _setLoadProgress(100, 'READY!');
  await _raf(); // let the 100% bar render for a tick
  await _waitForReady(); // player clicks READY? (or presses Enter/A) before pointer is captured
  // Now safe to let update() run — map, enemies, and player are all live
  state.levelTransition = false;
  tryLockPointer();
}

function _syncHUDVisibility() {
  // Show HUD elements only while actively playing (not in menu, pause, intermission, shop, dead, or viewing big map)
  const inLevel = state.phase === 'playing' && !state.levelTransition;
  const paused = !!state.paused;
  const viewingBigMap = inLevel && !paused && !!state.fullscreenMap;
  const visible = inLevel && !paused && !viewingBigMap;
  const vis = visible ? 'visible' : 'hidden';
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.style.visibility = vis;
  // pauseHUD: solid black bar shown only when paused in-level (covers z-buffer bleed)
  const pauseHudEl = document.getElementById('pause-hud');
  if (pauseHudEl) pauseHudEl.style.display = (inLevel && paused) ? 'block' : 'none';
  const consoleEl = document.getElementById('console-log');
  if (consoleEl) consoleEl.style.visibility = vis;
  const crosshairEl = document.getElementById('crosshair');
  if (crosshairEl) crosshairEl.style.visibility = vis;
  const minimapEl = document.getElementById('minimap');
  if (minimapEl) minimapEl.style.visibility = vis;
}

function updateHUD() {
  const healthEl = document.getElementById('hud-health');
  healthEl.textContent = Math.max(0, Math.floor(player.health));
  healthEl.style.color = '';
  document.getElementById('hud-score').textContent = state.score;
  const goldEl = document.getElementById('hud-gold');
  if (goldEl) goldEl.textContent = state.gold;
  // Show per-weapon ammo pool for active weapon, or 'INF' for sword
  const _aw = getActiveWeapon();
  const _awId = _aw ? _aw.id : 'pistol';
  let _ammoDisplay;
  if (_aw && _aw.melee) {
    _ammoDisplay = '∞';
  } else if (player.weaponAmmo && player.weaponAmmo[_awId] !== undefined) {
    _ammoDisplay = player.weaponAmmo[_awId];
  } else {
    _ammoDisplay = player.ammo;
  }
  document.getElementById('hud-ammo').textContent = _ammoDisplay;
  const w = getActiveWeapon();
  const wEl = document.getElementById('hud-weapon');
  if (wEl) {
    const owned = (state.ownedWeapons || WEAPONS).filter(ww => ww.owned);
    const slot  = owned.findIndex(ww => ww.id === w.id) + 1;
    wEl.textContent = `[${slot}] ${w ? w.name : 'FIRE TOME'}`;
    wEl.style.color = '';
  }
  // Gem key indicators in HUD
  _updateGemKeyHUD();
}

function _updateGemKeyHUD() {
  const gemEl = document.getElementById('hud-gems');
  if (!gemEl || !player) return;
  const inv = player.inventory || {};
  const parts = [];
  if (inv.gem_red)   parts.push('<span style="color:#ff4444;text-shadow:0 0 6px #ff0000;">♦R</span>');
  if (inv.gem_green) parts.push('<span style="color:#44ff44;text-shadow:0 0 6px #00ff00;">♦G</span>');
  if (inv.gem_blue)  parts.push('<span style="color:#4488ff;text-shadow:0 0 6px #0044ff;">♦B</span>');
  gemEl.innerHTML = parts.join(' ');
}

// ================== CONSOLE LOG SYSTEM ==================
const _consoleMsgs = []; // { text, cssClass, timer, el }
const MAX_CONSOLE_LINES = 1;

function _getConsoleClass(text) {
  const t = text.toUpperCase();
  if (t.includes('SLAIN') || t.includes('DEAD') || t.includes('DIED') || t.includes('KILLED')) return 'crit';
  if (t.includes('BOSS') || t.includes('ABOMINATION') || t.includes('DANGER') || t.includes('RUN') || t.includes('WARLORD')) return 'crit';
  if (t.includes('SECRET') || t.includes('TREASURE') || t.includes('FOUND') || t.includes('GEM')) return 'warn';
  if (t.includes('PORTAL') || t.includes('EXIT') || t.includes('ENTERING') || t.includes('DEFEATED')) return 'warn';
  if (t.includes('HEALTH') || t.includes('AMMO') || t.includes('MANA') || t.includes('PACK') || t.includes('CRATE')) return 'info';
  return '';
}

function showMessage(text, duration = 2000) {
  state.messageText  = text;
  state.messageTimer = duration;

  const consoleEl = document.getElementById('console-log');
  if (!consoleEl) return;

  while (_consoleMsgs.length >= MAX_CONSOLE_LINES) {
    const oldest = _consoleMsgs.shift();
    if (oldest.el && oldest.el.parentNode) oldest.el.parentNode.removeChild(oldest.el);
  }

  const cssClass = _getConsoleClass(text);
  const line = document.createElement('div');
  line.className = 'console-line' + (cssClass ? ' ' + cssClass : '');
  line.textContent = '> ' + text;
  consoleEl.appendChild(line);
  consoleEl.classList.add('has-content');

  const entry = { text, cssClass, timer: duration, el: line };
  _consoleMsgs.push(entry);

  const fadeDelay = Math.max(duration - 400, 200);
  const fadeTO = setTimeout(() => {
    line.classList.add('fading');
  }, fadeDelay);

  const removeTO = setTimeout(() => {
    if (line.parentNode) line.parentNode.removeChild(line);
    const idx = _consoleMsgs.indexOf(entry);
    if (idx !== -1) _consoleMsgs.splice(idx, 1);
    if (_consoleMsgs.length === 0) consoleEl.classList.remove('has-content');
  }, duration + 200);

  entry._fadeTO = fadeTO;
  entry._removeTO = removeTO;
}

// ================== CHEAT CONSOLE ==================
let _cheatBuffer = '';
let _cheatActive = false;   // god mode flag (iddqd)
let _noclipActive = false;  // noclip flag   (idclip)

function _handleCheatInput(key) {
  if (state.phase !== 'playing' || state.paused || state.levelTransition) return;
  if (key.length !== 1) return; // only single printable chars
  _cheatBuffer += key.toLowerCase();
  if (_cheatBuffer.length > 10) _cheatBuffer = _cheatBuffer.slice(-10);

  if (_cheatBuffer.endsWith('iddqd')) {
    _cheatBuffer = '';
    _cheatActive = !_cheatActive;
    state.score = 0;
    if (_cheatActive) {
      if (player) { player.health = 9999; player._godMode = true; }
      showMessage('IDDQD — GOD MODE ON. SCORE NULLED.', 3500);
    } else {
      if (player) { player.health = Math.min(player.health, player.maxHealth || 100); player._godMode = false; }
      showMessage('IDDQD — GOD MODE OFF.', 2000);
    }
    updateHUD();
  } else if (_cheatBuffer.endsWith('idkfa')) {
    _cheatBuffer = '';
    state.score = 0;
    if (player && state.ownedWeapons) {
      // Give all weapons
      state.ownedWeapons.forEach(w => { w.owned = true; });
      WEAPONS.forEach(w => { w.owned = true; });
      // Give all gem keys
      if (!player.inventory) player.inventory = {};
      player.inventory.gem_red   = true;
      player.inventory.gem_green = true;
      player.inventory.gem_blue  = true;
      // Max ammo
      player.ammo = player.maxAmmo || 999;
    }
    showMessage('IDKFA — ALL WEAPONS & KEYS. SCORE NULLED.', 3500);
    updateHUD();
  } else if (_cheatBuffer.endsWith('idclip')) {
    _cheatBuffer = '';
    _noclipActive = !_noclipActive;
    showMessage(_noclipActive ? 'IDCLIP — NOCLIP ON.' : 'IDCLIP — NOCLIP OFF.', 2500);
  } else {
    // idclev## — level warp (two digits after idclev)
    const clevMatch = _cheatBuffer.match(/idclev(\d{2})$/);
    if (clevMatch) {
      _cheatBuffer = '';
      const warpLevel = parseInt(clevMatch[1], 10);
      if (warpLevel >= 1) {
        state.score = 0;
        document.exitPointerLock();
        // Route through the intermission pipeline so all game systems
        // (raycaster, renderer, enemies, player, projectiles, etc.) are
        // cleanly torn down and rebuilt by the normal initLevel flow.
        state.levelTransition = true;
        state.phase = 'intermission';
        state.intermission = {
          phase: 'entering',           // skip the stats panel, go straight to "ENTERING"
          timer: 0,
          statsDisplayTime: 0,
          enteringDisplayTime: 1.8,    // brief "WARPING" display before initLevel fires
          stats: {
            level:   state.level,
            label:   `WARP → MAP ${String(warpLevel).padStart(2,'0')}`,
            kills:   state.levelStats ? state.levelStats.kills   : 0,
            gold:    0,
            secrets: state.levelStats ? state.levelStats.secretsFound : 0,
            time:    '--:--',
            score:   state.score,
          },
          nextLevel:  warpLevel,
          nextLabel:  _getNextLevelLabel(warpLevel, false),
          goToShop:   false,
          isWarp:     true,            // flag so drawIntermission can show warp text
          scanlineOffset: 0,
        };
      }
    }
  }
}

function _tickGodMode() {
  if (_cheatActive && player && state.phase === 'playing') {
    player.health = 9999;
    player._godMode = true;
  }
}

// ================== MENU NAVIGATION ==================
/**
 * MenuNav — keyboard/gamepad focus system for all HTML menus.
 *
 * Usage:
 *   menuNav.register('pause-main', [resumeBtn, optionsBtn, controlsBtn, quitMenuBtn]);
 *   menuNav.activate('pause-main');
 *   menuNav.deactivate();
 *
 * The currently focused button gets a 1px white glow border + 2px black outline.
 * Arrow keys / D-pad Up-Down move focus. Enter / Space / gamepad A = click.
 * Escape / gamepad B = back action (optional callback).
 */
class MenuNav {
  constructor() {
    this._menus          = {}; // id → { btns: [], idx: 0, onBack: fn|null }
    this._active         = null;
    this._styleInjected  = false;
    this._suppressFrames = 0;  // countdown to ignore gamepad input after title-screen reveal

    // Inject selection border style once
    if (!document.getElementById('menu-nav-style')) {
      const s = document.createElement('style');
      s.id = 'menu-nav-style';
      s.textContent = `
        .menu-nav-focused {
          outline: 2px solid #000 !important;
          outline-offset: 1px !important;
          box-shadow: 0 0 0 3px #000, 0 0 0 4px #fff, 0 0 8px 5px rgba(255,255,255,0.55) !important;
          filter: brightness(1.4) saturate(1.3) !important;
          text-shadow: 2px 2px 0 #000, 0 0 14px #fff, 0 0 6px #ffcc44 !important;
        }
      `;
      document.head.appendChild(s);
    }

    // Keyboard handler
    this._onKey = (e) => {
      if (!this._active) return;
      const menu = this._menus[this._active];
      if (!menu) return;
      const horiz = menu.horizontal;
      if (!horiz && (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        this._move(-1);
      } else if (!horiz && (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        this._move(1);
      } else if (horiz && (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        this._move(-1);
      } else if (horiz && (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        this._move(1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._select();
      } else if (e.key === 'Escape') {
        if (menu.onBack) { menu.onBack(); }
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  /**
   * Register a named menu screen.
   * @param {string} id
   * @param {HTMLElement[]} btns — ordered list of focusable buttons
   * @param {Function|null} onBack — called when ESC/B pressed; null = do nothing
   * @param {boolean} horizontal — if true, use Left/Right nav instead of Up/Down
   */
  register(id, btns, onBack = null, horizontal = false) {
    this._menus[id] = { btns, idx: 0, onBack, horizontal };
  }

  /** Activate a menu screen (sets focus to first item). */
  activate(id, startIdx = 0) {
    this._clearFocus();
    this._active = id;
    const menu = this._menus[id];
    if (!menu) return;
    menu.idx = Math.max(0, Math.min(startIdx, menu.btns.length - 1));
    this._applyFocus();
  }

  /** Deactivate (clear all focus decorations). */
  deactivate() {
    this._clearFocus();
    this._active = null;
  }

  /** Update a menu's button list (for dynamic menus). */
  update(id, btns, onBack = null) {
    if (this._menus[id]) {
      this._clearFocus();
      this._menus[id].btns  = btns;
      if (onBack !== null) this._menus[id].onBack = onBack;
      if (this._active === id) this._applyFocus();
    } else {
      this.register(id, btns, onBack);
    }
  }

  /** Tick — call once per frame to apply gamepad nav. */
  tickGamepad(inp) {
    // Burn down suppress counter (used to swallow the "press any button" frame
    // on the title screen so it doesn't immediately click the first menu item).
    if (this._suppressFrames > 0) { this._suppressFrames--; return; }
    if (!this._active || !inp) return;
    const menu = this._menus[this._active];
    if (!menu) return;
    if (menu.horizontal) {
      if (inp.gpMenuLeft)  this._move(-1);
      if (inp.gpMenuRight) this._move(1);
    } else {
      if (inp.gpMenuUp)   this._move(-1);
      if (inp.gpMenuDown) this._move(1);
    }
    if (inp.gpMenuSel)  this._select();
    if (inp.gpMenuBack) {
      if (menu.onBack) menu.onBack();
    }
  }

  _move(dir) {
    const menu = this._menus[this._active];
    if (!menu || menu.btns.length === 0) return;
    this._clearFocus();
    menu.idx = (menu.idx + dir + menu.btns.length) % menu.btns.length;
    this._applyFocus();
  }

  _select() {
    const menu = this._menus[this._active];
    if (!menu || menu.btns.length === 0) return;
    const btn = menu.btns[menu.idx];
    if (btn) btn.click();
  }

  _applyFocus() {
    const menu = this._menus[this._active];
    if (!menu) return;
    const btn = menu.btns[menu.idx];
    if (btn) btn.classList.add('menu-nav-focused');
  }

  _clearFocus() {
    // Clear from all registered menus
    for (const m of Object.values(this._menus)) {
      for (const b of m.btns) b.classList.remove('menu-nav-focused');
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
  }
}

const menuNav = new MenuNav();

// ================== GAME LOOP ==================
let lastTime = 0;
function gameLoop(ts) {
  const dt = Math.min((ts - lastTime) / 1000, 0.05);
  lastTime = ts;

  // Always tick input so gamepad state is fresh
  input.tick();

  // Gamepad START = pause toggle (during gameplay)
  if (state.phase === 'playing' && !state.levelTransition && input.gpPause) {
    state.paused = !state.paused;
    if (state.paused) {
      state.fullscreenMap = false;
      document.exitPointerLock();
      showPauseMenu();
    } else {
      hidePauseMenu();
      tryLockPointer();
    }
  }

  // Gamepad SELECT = map toggle (during gameplay, not paused)
  if (state.phase === 'playing' && !state.paused && !state.levelTransition && input.gpMap) {
    if (!state.mapToggleCooldown) {
      state.fullscreenMap = !state.fullscreenMap;
      state.mapToggleCooldown = true;
      setTimeout(() => { state.mapToggleCooldown = false; }, 220);
    }
  }

  // Gamepad B = close mod editor if open (on main menu or pause)
  if (input.gpMenuBack && modEditor._panel && modEditor._panel.style.display !== 'none') {
    modEditor.hide();
    if (state.phase === 'menu') {
      _showMainMenuButtons();
      menuNav.activate('main-menu', 3);
    }
    // consume so menuNav doesn't double-fire its own onBack this frame
    input.gpMenuBack = false;
  }

  // Tick menu navigation
  menuNav.tickGamepad(input);

  if (state.phase === 'playing' && !state.paused && !state.levelTransition && player) {
    update(dt);
  } else if (state.phase === 'shop' && shop) {
    shop.update(dt);
    shop.tickGamepad(input);
  } else if (state.phase === 'intermission') {
    updateIntermission(dt);
  }
  // Sync touch HUD visibility — show only while actively playing (not paused/menu/shop)
  touchControls.syncVisibility(state.phase, state.paused || state.levelTransition);
  draw();
  if (crtHandle) tickCRT(crtHandle, ts);
  requestAnimationFrame(gameLoop);
}

function update(dt) {
  // input.tick() is now called once per frame in gameLoop() before update()

  // Gamepad / keyboard weapon scroll (edge-triggered via input.tick())
  if (input.gpWpnNext) _scrollWeapon(+1);
  if (input.gpWpnPrev) _scrollWeapon(-1);

  const BASE_SPEED = 4.2;
  const SPEED = BASE_SPEED * (player.speedMult || 1.0);
  const ROT_SPEED = 2.4;
  const { keys, mouseDX } = input;

  let angle = player.angle;
  if (input.action('turnLeft'))  angle -= ROT_SPEED * dt;
  if (input.action('turnRight')) angle += ROT_SPEED * dt;
  // Right stick analog turning
  if (input.gpTurnX) angle += input.gpTurnX * ROT_SPEED * 1.4 * dt;
  angle += mouseDX * 0.003;
  input.mouseDX = 0;
  player.angle = angle;

  let dx = 0, dy = 0, moving = false, strafeDir = 0;
  if (input.action('moveForward') || input._gpFwd)  { dx += Math.cos(angle) * SPEED * dt; dy += Math.sin(angle) * SPEED * dt; moving = true; }
  if (input.action('moveBack')    || input._gpBack) { dx -= Math.cos(angle) * SPEED * dt; dy -= Math.sin(angle) * SPEED * dt; moving = true; }
  if (input.action('strafeLeft')  || input._gpLeft) { dx += Math.cos(angle - Math.PI/2) * SPEED * dt; dy += Math.sin(angle - Math.PI/2) * SPEED * dt; moving = true; strafeDir = -1; }
  if (input.action('strafeRight') || input._gpRight){ dx += Math.cos(angle + Math.PI/2) * SPEED * dt; dy += Math.sin(angle + Math.PI/2) * SPEED * dt; moving = true; strafeDir = 1; }

  // ── Cylinder collision for player (swept-circle, 8 probes) ──────────────
  const PLAYER_RADIUS = 0.25;
  const _playerCircleWall = (cx, cy) => {
    const r = PLAYER_RADIUS;
    return map.isWall(cx + r, cy)       || map.isWall(cx - r, cy) ||
           map.isWall(cx, cy + r)       || map.isWall(cx, cy - r) ||
           map.isWall(cx + r*0.707, cy + r*0.707) ||
           map.isWall(cx + r*0.707, cy - r*0.707) ||
           map.isWall(cx - r*0.707, cy + r*0.707) ||
           map.isWall(cx - r*0.707, cy - r*0.707);
  };
  // Hard OOB clamp — keep player (and noclip) inside map bounds always.
  // isWall() returns true for OOB so normal collision already stops the player,
  // but noclip bypasses that check, so we clamp explicitly.
  const _MAP_MARGIN = 0.3;
  const _clampToMap = (px, py) => ({
    x: Math.max(_MAP_MARGIN, Math.min(map.width  - _MAP_MARGIN, px)),
    y: Math.max(_MAP_MARGIN, Math.min(map.height - _MAP_MARGIN, py)),
  });

  if (_noclipActive) {
    const clamped = _clampToMap(player.x + dx, player.y + dy);
    player.x = clamped.x; player.y = clamped.y;
  } else if (!_playerCircleWall(player.x + dx, player.y + dy)) {
    player.x += dx; player.y += dy;
  } else if (dx !== 0 && !_playerCircleWall(player.x + dx, player.y)) {
    player.x += dx;
  } else if (dy !== 0 && !_playerCircleWall(player.x, player.y + dy)) {
    player.y += dy;
  }

  const targetBobAmp = moving ? 1.0 : 0.0;
  player.bobAmp += (targetBobAmp - player.bobAmp) * Math.min(1, dt * 8);
  if (moving) player.bobPhase += dt * 9.5;
  player.strafeDir = strafeDir;
  const targetTilt = strafeDir * 0.18;
  player.strafeTilt += (targetTilt - player.strafeTilt) * Math.min(1, dt * 12);

  if (player.weaponKick > 0) { player.weaponKick -= dt * 5; if (player.weaponKick < 0) player.weaponKick = 0; }
  if (player.weaponAnim !== 'idle') {
    player.weaponFrame += dt * (player.weaponAnim === 'shoot' ? 8 : 4);
    if (player.weaponFrame >= 1.0) { player.weaponFrame = 0; player.weaponAnim = 'idle'; }
  }

  player.shootCooldown -= dt;
  const wep = getActiveWeapon();
  if ((input.action('shoot') || keys['shoot']) && player.shootCooldown <= 0) {
    if (wep && wep.melee) {
      player.shootCooldown = wep.cooldown;
      player.weaponAnim = 'shoot'; player.weaponFrame = 0; player.weaponKick = 1.0;
      state.muzzleTimer = 0.08;
      playWeaponSfx(wep.id);
      meleeSword();
    } else {
      const cost = wep ? (wep.ammoPerShot || 1) : 1;
      const wid  = wep ? wep.id : 'pistol';
      const pool = (player.weaponAmmo && player.weaponAmmo[wid] !== undefined)
        ? player.weaponAmmo[wid]
        : player.ammo;
      if (pool >= cost) shoot(wep);
    }
  }

  if (state.muzzleTimer > 0) state.muzzleTimer -= dt;
  if (state.damageFlashTimer > 0) {
    state.damageFlashTimer -= dt;
    const alpha = state.damageFlashTimer / 0.3;
    document.getElementById('damage-flash').style.background = `rgba(255,0,0,${alpha * 0.5})`;
  }
  if (state.messageTimer > 0) {
    state.messageTimer -= dt * 1000;
  }

  for (const ef of state.hitEffects) ef.life -= dt;
  state.hitEffects = state.hitEffects.filter(ef => ef.life > 0);

  // Update explosion effects (cannon impacts)
  for (const ex of state.explosionEffects) ex.life -= dt;
  state.explosionEffects = state.explosionEffects.filter(ex => ex.life > 0);

  const BLOOD_GRAVITY = 6; // world-units/s² downward
  for (const bp of state.bloodParticles) {
    bp.vz += BLOOD_GRAVITY * dt;
    bp.x  += bp.vx * dt;
    bp.y  += bp.vy * dt;
    bp.z  -= bp.vz * dt; // z increases upward, gravity pulls down
    if (bp.z < 0) { bp.z = 0; bp.vz = 0; bp.vx *= 0.5; bp.vy *= 0.5; } // splat on floor
    bp.life -= dt;
  }
  if (state.bloodParticles.length > 400) {
    state.bloodParticles = state.bloodParticles.filter(bp => bp.life > 0);
  } else {
    state.bloodParticles = state.bloodParticles.filter(bp => bp.life > 0);
  }

  if (state.screenShake > 0) {
    state.screenShake -= dt * 3;
    if (state.screenShake < 0) state.screenShake = 0;
    state.screenShakeDx = (Math.random() - 0.5) * state.screenShake * 6;
    state.screenShakeDy = (Math.random() - 0.5) * state.screenShake * 6;
  } else { state.screenShakeDx = 0; state.screenShakeDy = 0; }

  if (state.bossRoar) {
    state.bossRoar = false;
    if (state.bossRoarType === 'abomination') { showMessage('THE ABOMINATION AWAKENS! RUN!', 4000); state.screenShake = 0.5; }
    else if (state.bossRoarType === 'abomination_enrage') { showMessage('THE ABOMINATION ENRAGES!', 3000); state.screenShake = 0.4; }
    else { showMessage('THE TROLL WARLORD CHARGES!', 3000); state.screenShake = 0.3; }
    state.bossRoarType = '';
  }

  _tickGodMode();
  updateProjectiles(dt);
  enemies.update(dt, player, state);
  enemies.separateFromPlayer(player, 0.25);

  if (player.health <= 0 && !_cheatActive) { state.phase = 'dead'; showOverlay('dead'); return; }

  if (enemies.allDead() && !map.exitPortal.active) {
    map.exitPortal.active = true;
    const bossKillMsg = map.isAbominationLevel ? 'ABOMINATION DEFEATED! PORTAL OPENED!'
      : (map.isBossLevel ? 'BOSS DEFEATED! PORTAL OPENED!' : 'ALL ENEMIES SLAIN! FIND THE EXIT PORTAL!');
    showMessage(bossKillMsg, 3500);
  }

  if (map.exitPortal.active) {
    const pdx = map.exitPortal.x - player.x, pdy = map.exitPortal.y - player.y;
    if (pdx * pdx + pdy * pdy < 0.55 * 0.55) levelClear();
  }

  // ── Secret walls & Gem Doors (USE key) ─────────────────────────��────────
  const USE_RANGE = 1.5;
  state.nearSecretWall = null;
  state.secretWallData = null;
  const pressUse = input.action('use');

  // Check regular secret walls first
  for (let si = 0; si < (map.secretWalls || []).length; si++) {
    const sw = map.secretWalls[si];
    if (sw.opened) continue;
    const dwx = (sw.x + 0.5) - player.x, dwy = (sw.y + 0.5) - player.y;
    const wallDist = Math.sqrt(dwx * dwx + dwy * dwy);
    if (wallDist >= USE_RANGE) continue;
    const wallAngle = Math.atan2(dwy, dwx);
    let angleDiff = wallAngle - player.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    if (Math.abs(angleDiff) >= 1.1) continue;
    state.nearSecretWall = si;
    state.secretWallData = { x: sw.x, y: sw.y, isGemDoor: false };
    if (pressUse && !state.useCooldown) {
      state.useCooldown = true;
      sw.unlocked = true; sw.opened = true; map.grid[sw.y][sw.x] = 0;
      raycaster.clearStickers(sw.x, sw.y);
      try { cloneAudio(doorSfx, audioVolumes.fx * 0.5).play().catch(() => {}); } catch(e) {}
      state.levelStats.secretsFound++;
      // Always spawn a treasure chest at the secret door location
      map.decor.push({ type: 'treasureChest', x: sw.x + 0.5, y: sw.y + 0.5, zOffset: 0, isPuddle: false, isBrazier: false });
      if (sw.treasure === 'health') { player.health = Math.min(player.maxHealth || 100, player.health + 35); showMessage('SECRET FOUND! +35 HEALTH!', 2500); }
      else if (sw.treasure === 'ammo') { player.ammo = Math.min(player.maxAmmo || 999, player.ammo + 30); showMessage('SECRET FOUND! +30 AMMO!', 2500); }
      else { const bonus = 250 * state.level; state.score += bonus; state.gold += 25; showMessage(`SECRET FOUND! +${bonus} SCORE! +25 GOLD!`, 2500); }
      updateHUD();
    } else if (!pressUse) { state.useCooldown = false; }
    break;
  }

  // Check gem doors if no regular secret wall found nearby
  if (state.nearSecretWall === null) {
    for (let gi = 0; gi < (map.gemDoors || []).length; gi++) {
      const gd = map.gemDoors[gi];
      if (gd.opened) continue;
      const dwx = (gd.x + 0.5) - player.x, dwy = (gd.y + 0.5) - player.y;
      const wallDist = Math.sqrt(dwx * dwx + dwy * dwy);
      if (wallDist >= USE_RANGE) continue;
      const wallAngle = Math.atan2(dwy, dwx);
      let angleDiff = wallAngle - player.angle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      if (Math.abs(angleDiff) >= 1.1) continue;

      // Use 'si' index = -(gi+1) to distinguish from regular secret walls
      state.nearSecretWall = -(gi + 1);
      const colorNames = { red: 'RED', green: 'GREEN', blue: 'BLUE' };
      const inv = player.inventory || {};
      const keyItem = GEM_KEY_ITEMS[gd.color];
      const hasKey = !!inv[keyItem];
      state.secretWallData = {
        x: gd.x, y: gd.y,
        isGemDoor: true,
        gemColor: gd.color,
        hasKey,
      };

      if (pressUse && !state.useCooldown) {
        state.useCooldown = true;
        if (hasKey) {
          // Consume key and open door
          delete player.inventory[keyItem];
          gd.opened = true;
          map.grid[gd.y][gd.x] = 0;
          raycaster.clearStickers(gd.x, gd.y);
          try { cloneAudio(doorSfx, audioVolumes.fx * 0.5).play().catch(() => {}); } catch(e) {}
          state.levelStats.secretsFound++;
          const cName = colorNames[gd.color] || gd.color.toUpperCase();
          const bonus = 500 * state.level;
          state.score += bonus;
          showMessage(`${cName} GEM DOOR OPENED! +${bonus} SCORE!`, 3000);
          updateHUD();
          state.secretWallData = null;
          state.nearSecretWall = null;
        } else {
          const cName = colorNames[gd.color] || gd.color.toUpperCase();
          showMessage(`NEED ${cName} GEM KEY TO OPEN!`, 2200);
        }
      } else if (!pressUse) { state.useCooldown = false; }
      break;
    }
  }

  if (!pressUse) state.useCooldown = false;

  // ── Gem key pickups ──────────────────────────────────────────────────────
  for (const gk of (map.gemKeyPickups || [])) {
    if (gk.collected) continue;
    const dx2 = gk.x - player.x, dy2 = gk.y - player.y;
    if (dx2 * dx2 + dy2 * dy2 < 0.45 * 0.45) {
      gk.collected = true;
      if (!player.inventory) player.inventory = {};
      player.inventory[gk.item] = true;
      const colorNames2 = { red: 'RED', green: 'GREEN', blue: 'BLUE' };
      const cName = colorNames2[gk.color] || gk.color.toUpperCase();
      showMessage(`${cName} GEM KEY FOUND!`, 2500);
      state.screenShake = 0.08;
      updateHUD();
    }
  }

  // ── Pickups ──────────────────────────────────���───────────────────────────
  const pickupIdx = map.checkPickup(player.x, player.y);
  if (pickupIdx !== -1) {
    const pickup = map.pickups[pickupIdx];
    if (pickup.type === 'health') { player.health = Math.min(player.maxHealth || 100, player.health + 25); showMessage('+ HEALTH PACK +'); }
    else if (pickup.type === 'ammo') {
      // Grant per-weapon ammo from crate
      if (player.weaponAmmo) {
        for (const [wid, grant] of Object.entries(AMMO_CRATE_GRANT)) {
          if (player.weaponAmmo[wid] !== undefined) {
            player.weaponAmmo[wid] = Math.min(999, player.weaponAmmo[wid] + grant);
          }
        }
      } else {
        player.ammo = Math.min(player.maxAmmo || 999, player.ammo + 20);
      }
      showMessage('+ AMMO CRATE +');
    }
    map.pickups.splice(pickupIdx, 1); updateHUD();
  }
  updateHUD();
}

// ──────────────────────────────────────────────────────────────────────────────
// HITSCAN — instant ray hit detection, no projectile object spawned.
// Fires N rays (pellets) with spread, traces until wall or first enemy hit.
// ──────────────────────────────────────────────────────────────────────────────
function fireHitscan(wep) {
  const pellets = wep.pellets || 1;
  const spread  = wep.spread  || 0;
  const dmg     = (wep.damage || 45) * (player.damageMult || 1.0);
  const MAX_DIST = 30;
  const STEP     = 0.1;

  for (let i = 0; i < pellets; i++) {
    const ang = player.angle + (Math.random() - 0.5) * spread * 2;
    const cosA = Math.cos(ang), sinA = Math.sin(ang);
    let rx = player.x, ry = player.y;
    let hitEnemy = null;
    let hitDist  = MAX_DIST;

    // Step along ray until wall or max distance
    for (let d = 0; d < MAX_DIST; d += STEP) {
      rx = player.x + cosA * d;
      ry = player.y + sinA * d;
      if (map.isWall(rx, ry)) {
        hitDist = d;
        spawnHitEffect(rx, ry, 'wall');
        state.screenShake = Math.max(state.screenShake, 0.04);
        break;
      }
      // Check enemy collision
      for (const e of enemies.list) {
        if (!e.alive) continue;
        const radius = e.isAbomination ? 1.0 : (e.isBoss ? 0.8 : 0.35);
        const ex = e.x - rx, ey = e.y - ry;
        if (ex * ex + ey * ey < (0.12 + radius) * (0.12 + radius)) {
          hitEnemy = e; hitDist = d; break;
        }
      }
      if (hitEnemy) break;
    }

    if (hitEnemy) {
      const shotDmg = dmg + Math.random() * 15;
      const killed = enemies.applyDamage(hitEnemy, shotDmg);
      spawnHitEffect(hitEnemy.x, hitEnemy.y, 'enemy');
      state.screenShake = Math.max(state.screenShake,
        hitEnemy.isAbomination ? 0.35 : (hitEnemy.isBoss ? 0.25 : 0.12));
      if (killed) {
        const scoreBonus = (hitEnemy.scoreValue || 100) * Math.max(1, Math.floor(state.level / 5));
        const goldBonus  = (hitEnemy.goldValue  || 10)  * Math.max(1, Math.floor(state.level / 5));
        state.score += scoreBonus;
        state.gold  += goldBonus;
        state.levelStats.kills++;
        state.levelStats.goldEarned += goldBonus;
        if (hitEnemy.isAbomination) {
          showMessage('THE ABOMINATION IS SLAIN!', 5000);
          state.screenShake = 0.6;
        } else if (hitEnemy.isBoss) {
          showMessage('TROLL WARLORD SLAIN!', 4000);
          state.screenShake = 0.4;
        } else {
          const typeNames = { goblin: 'GOBLIN', bat: 'BAT', spider: 'SPIDER' };
          showMessage(`${typeNames[hitEnemy.type] || 'ENEMY'} SLAIN! +${scoreBonus}`);
        }
        playEnemyDeathSfx(hitEnemy);
      }
    }
  }
}

function shoot(wep) {
  if (!wep) wep = WEAPONS[0];
  const cost = wep.ammoPerShot || 1;
  if (wep.ammoPerShot === 0) return;
  // Per-weapon ammo pool
  const wid = wep.id;
  if (player.weaponAmmo && player.weaponAmmo[wid] !== undefined) {
    player.weaponAmmo[wid] = Math.max(0, player.weaponAmmo[wid] - cost);
  } else {
    player.ammo = Math.max(0, player.ammo - cost);
  }
  player.shootCooldown = wep.cooldown || 0.22;
  state.muzzleTimer = 0.09; player.weaponAnim = 'shoot'; player.weaponFrame = 0; player.weaponKick = 1.0;

  if (wep.hitscan) {
    // Instant-hit ray — no projectile object
    fireHitscan(wep);
  } else {
    // Projectile-based (Crossbow, Fire Tome, Cannon)
    const bx = player.x + Math.cos(player.angle) * 0.4;
    const by = player.y + Math.sin(player.angle) * 0.4;
    if (wep.id === 'cannon') spawnCannonBall(bx, by, player.angle, wep);
    else if (wep.pellets && wep.pellets > 1) spawnShotgunSpread(bx, by, player.angle, wep);
    else spawnProjectile(bx, by, player.angle, wep);
  }

  playWeaponSfx(wep.id);
  updateHUD();
}

// ================== LEVEL CLEAR / SHOP ==================
function levelClear() {
  if (state.levelTransition) return;
  state.levelTransition = true;
  state.score += 500 * state.level; state.gold += 30 + state.level * 2; updateHUD();

  const nextLevel = state.level + 1;
  const goToShop  = true; // shop after every level

  // Compute elapsed time
  const elapsed = Math.floor((performance.now() - state.levelStats.timeStart) / 1000);
  const mins = Math.floor(elapsed / 60), secs = elapsed % 60;
  const timeStr = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;

  const nextLabel = _getNextLevelLabel(nextLevel, goToShop);

  const stats = {
    level:   state.level,
    label:   _getCurrentLevelLabel(),
    kills:   state.levelStats.kills,
    gold:    state.levelStats.goldEarned + (30 + state.level * 2),
    secrets: state.levelStats.secretsFound,
    time:    timeStr,
    score:   state.score,
  };

  document.exitPointerLock();
  state.phase = 'intermission';
  state.intermission = {
    phase: 'stats',
    timer: 0,
    statsDisplayTime: 4.5,
    enteringDisplayTime: 3.2,
    stats,
    nextLevel,
    nextLabel,
    goToShop,
    scanlineOffset: 0,
  };
}

function _getCurrentLevelLabel() {
  if (!map) return `LEVEL ${state.level}`;
  if (map.isAbominationLevel) return `LEVEL ${state.level} — THE ABOMINATION FLOOR`;
  if (map.isBossLevel)        return `LEVEL ${state.level} — BOSS FLOOR`;
  return getLevelLabel(state.level, map.theme);
}

function _getNextLevelLabel(nextLevel, goToShop) {
  if (goToShop) return `THE SHOP`;
  const THEMES = ['DAMP CAVES','GOBLIN LAIR','ANCIENT RUINS','CURSED LIBRARY','THE DEEP'];
  const themeLabel = THEMES[(nextLevel - 1) % THEMES.length];
  if (nextLevel % 25 === 0) return `LEVEL ${nextLevel} — THE ABOMINATION FLOOR`;
  if (nextLevel % 5  === 0) return `LEVEL ${nextLevel} — BOSS FLOOR`;
  return `LEVEL ${nextLevel} — ${themeLabel}`;
}

function updateIntermission(dt) {
  const im = state.intermission;
  if (!im) return;
  im.timer += dt;
  im.scanlineOffset = (im.scanlineOffset + dt * 30) % 4;

  if (im.phase === 'stats' && im.timer >= im.statsDisplayTime) {
    im.phase = 'entering';
    im.timer = 0;
  } else if (im.phase === 'entering' && im.timer >= im.enteringDisplayTime) {
    // Consume gem keys at level transition
    if (player && player.inventory) {
      delete player.inventory.gem_red;
      delete player.inventory.gem_green;
      delete player.inventory.gem_blue;
    }

    state.intermission = null;
    state.phase = 'playing';
    state.level = im.nextLevel;
    if (im.goToShop) {
      openShop();
    } else {
      _showLoadingScreen();
      initLevel(state.level).then(() => {
        state.levelTransition = false;
        startAmbience(state.level);
        if (im.fromShop) { updateHUD(); _applyHatToRenderer(state.equippedHat); }
        // MIDI shuffle is triggered inside initLevel's precache phase (Step 1b)
        // tryLockPointer() is called inside initLevel after READY? is clicked
      });
    }
  }
}

function drawIntermission() {
  const im = state.intermission;
  if (!im) return;
  const cw = canvas.width, ch = canvas.height;

  // Background: INTERMISSION texture, cover-fitted, then darken overlay
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  if (intermissionBgImg.complete && intermissionBgImg.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false;
    const iw = intermissionBgImg.naturalWidth;
    const ih = intermissionBgImg.naturalHeight;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2;
    ctx.drawImage(intermissionBgImg, dx, dy, dw, dh);
  }

  // Dark overlay so text reads cleanly
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, cw, ch);

  const scanH = 2;
  const offset = Math.floor(im.scanlineOffset);
  ctx.fillStyle = 'rgba(0,255,80,0.025)';
  for (let y = offset % scanH; y < ch; y += scanH * 2) {
    ctx.fillRect(0, y, cw, scanH);
  }

  const vgGrad = ctx.createRadialGradient(cw/2, ch/2, ch * 0.2, cw/2, ch/2, ch * 0.75);
  vgGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vgGrad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vgGrad;
  ctx.fillRect(0, 0, cw, ch);

  const FONT = getModFont();
  ctx.textAlign = 'center';
  ctx.imageSmoothingEnabled = false;

  // Helper: draw white text with 2px black outline
  const _strokeFill = (text, x, y, fillColor) => {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillColor || '#ffffff';
    ctx.fillText(text, x, y);
  };

  if (im.phase === 'stats') {
    const s = im.stats;
    const alpha = Math.min(1, im.timer / 0.5);
    ctx.globalAlpha = alpha;

    ctx.fillStyle = 'rgba(0,60,20,0.7)';
    ctx.fillRect(12, 20, cw - 24, 26);

    ctx.font = `9px ${FONT}`;
    _strokeFill('— LEVEL COMPLETE —', cw / 2, 37, '#ffffff');

    ctx.font = `6px ${FONT}`;
    _strokeFill(s.label, cw / 2, 56, '#ffffff');

    ctx.fillStyle = '#003311';
    ctx.fillRect(20, 63, cw - 40, 2);

    const rows = [
      { label: 'ENEMIES SLAIN',  value: String(s.kills),   delay: 0.3  },
      { label: 'GOLD EARNED',    value: `${s.gold} G`,     delay: 0.7  },
      { label: 'SECRETS FOUND',  value: String(s.secrets), delay: 1.1  },
      { label: 'TIME',           value: s.time,            delay: 1.5  },
      { label: 'SCORE',          value: String(s.score),   delay: 1.9, highlight: true },
    ];

    rows.forEach((row, i) => {
      const rowAlpha = Math.min(1, Math.max(0, (im.timer - row.delay) / 0.25));
      if (rowAlpha <= 0) return;
      ctx.globalAlpha = alpha * rowAlpha;

      const ry = 82 + i * 26;
      if (row.highlight) {
        ctx.fillStyle = 'rgba(0,80,30,0.5)';
        ctx.fillRect(16, ry - 12, cw - 32, 20);
      }

      ctx.font = `6px ${FONT}`;
      ctx.textAlign = 'left';
      _strokeFill(row.label, 28, ry, '#ffffff');
      ctx.textAlign = 'right';
      _strokeFill(row.value, cw - 28, ry, row.highlight ? '#ffff88' : '#ffffff');
      ctx.textAlign = 'center';
    });

    if (im.timer > 3.0) {
      const blinkAlpha = 0.5 + 0.5 * Math.sin(im.timer * 6);
      ctx.globalAlpha = alpha * blinkAlpha;
      ctx.font = `5px ${FONT}`;
      _strokeFill('PREPARING NEXT LEVEL...', cw / 2, ch - 18, '#ffffff');
    }

    ctx.globalAlpha = 1;

  } else if (im.phase === 'entering') {
    const t = im.timer;
    const fadeIn  = Math.min(1, t / 0.6);
    const fadeOut = t > im.enteringDisplayTime - 0.8 ? Math.max(0, 1 - (t - (im.enteringDisplayTime - 0.8)) / 0.6) : 1;
    const a = fadeIn * fadeOut;

    ctx.globalAlpha = a * 0.8;
    ctx.fillStyle = '#00ff55';
    ctx.fillRect(0, ch / 2 - 38, cw, 1);
    ctx.fillRect(0, ch / 2 + 32, cw, 1);

    ctx.globalAlpha = a;
    ctx.font = `7px ${FONT}`;
    _strokeFill(im.isWarp ? 'WARPING TO' : 'NOW ENTERING', cw / 2, ch / 2 - 18, im.isWarp ? '#ffcc44' : '#ffffff');

    const pulse = 0.85 + 0.15 * Math.sin(t * 4);
    ctx.globalAlpha = a * pulse;
    ctx.shadowBlur = 0;
    ctx.font = `10px ${FONT}`;

    const label = im.nextLabel;
    if (label.length > 22) {
      const parts = label.split(' — ');
      if (parts.length > 1) {
        _strokeFill(parts[0], cw / 2, ch / 2 + 8, '#ffffff');
        ctx.font = `7px ${FONT}`;
        _strokeFill(parts[1], cw / 2, ch / 2 + 24, '#ffffff');
      } else {
        _strokeFill(label, cw / 2, ch / 2 + 8, '#ffffff');
      }
    } else {
      _strokeFill(label, cw / 2, ch / 2 + 10, '#ffffff');
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = 'rgba(0,180,60,0.15)';
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, cw, ch);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

function _applyHatToRenderer(hatId) {
  if (!renderer) return;
  if (hatId) {
    renderer.hatBrimImg = hatBrimImg;
    renderer.playerHasHat = true;
  } else {
    renderer.playerHasHat = false;
  }
}

function openShop() {
  state.phase = 'shop'; document.exitPointerLock(); hideOverlay();
  if (shop) shop.destroy();
  shop = new Shop(canvas, ctx, assets, payments);
  shop.setGold(state.gold); shop.setPlayer(player);
  if (state.ownedWeapons) { shop.weapons = state.ownedWeapons.map(w => ({ ...w })); const pistol = shop.weapons.find(w => w.id === 'pistol'); if (pistol) pistol.owned = true; }
  if (state.ownedUpgrades) { shop.upgrades = state.ownedUpgrades.map(u => ({ ...u })); }
  if (state.ownedHats) { shop.hats = state.ownedHats.map(h => ({ ...h })); }
  shop.onHatEquipped = (hatId) => {
    state.equippedHat = hatId;
    _applyHatToRenderer(hatId);
  };
  shop.onClose = (newGold, weapons, upgrades, hats) => {
    state.ownedWeapons = weapons.map(w => ({ ...w }));
    state.ownedUpgrades = upgrades.map(u => ({ ...u }));
    if (hats) state.ownedHats = hats.map(h => ({ ...h }));
    state.gold = newGold;
    shop.destroy(); shop = null;

    // Show "NOW ENTERING [Level Name]" intermission before loading the level
    const enteringLabel = _getNextLevelLabel(state.level, false);
    state.phase = 'intermission';
    state.intermission = {
      phase: 'entering',
      timer: 0,
      statsDisplayTime: 0,
      enteringDisplayTime: 3.0,
      stats: null,
      nextLevel: state.level,
      nextLabel: enteringLabel,
      goToShop: false,
      fromShop: true,
      scanlineOffset: 0,
    };
  };
}

// ================== DRAW ==================
function draw() {
  _syncHUDVisibility();
  if (state.phase === 'menu') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 240); return; }
  if (state.phase === 'intermission') { drawIntermission(); mmCtx.fillStyle = '#000'; mmCtx.fillRect(0, 0, 80, 80); return; }
  if (state.phase === 'shop' && shop) { shop.draw(); mmCtx.fillStyle = '#000'; mmCtx.fillRect(0, 0, 80, 80); return; }
  if (!player || !renderer) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 240); return; }
  ctx.save();
  if (state.screenShakeDx || state.screenShakeDy) ctx.translate(Math.round(state.screenShakeDx), Math.round(state.screenShakeDy));
  renderer.render(
    player,
    enemies.getVisible(player, raycaster),
    state.muzzleTimer > 0,
    state.paused,
    state.projectiles,
    state.hitEffects,
    state.nearSecretWall !== null,
    state.secretWallData,
    getActiveWeapon(),
    state.bloodParticles,
    state.explosionEffects
  );
  ctx.restore();
  const _isInLevel = state.phase === 'playing' && !state.paused && !state.levelTransition;
  if (_isInLevel) {
    if (state.fullscreenMap) {
      drawFullscreenMap();
      // Hide the corner minimap while the big map is open
      mmCtx.fillStyle = '#000'; mmCtx.fillRect(0, 0, 80, 80);
    } else {
      drawMinimap();
    }
  } else {
    mmCtx.fillStyle = '#000'; mmCtx.fillRect(0, 0, 80, 80);
  }
}

function drawMinimap() {
  const CELL = 4, W = map.width, H = map.height;
  mmCtx.fillStyle = '#000'; mmCtx.fillRect(0, 0, 80, 80);
  const offX = Math.floor(player.x) - 10, offY = Math.floor(player.y) - 10;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const mx = offX + x, my = offY + y;
    if (mx < 0 || mx >= W || my < 0 || my >= H) mmCtx.fillStyle = '#111';
    else {
      const cell = map.grid[my][mx];
      if (cell === 1) mmCtx.fillStyle = '#555';
      else if (cell === 2) {
        // Secret doors: if opened show as passage, else disguise as regular wall
        const sw = (map.secretWalls||[]).find(s => s.x===mx && s.y===my);
        mmCtx.fillStyle = sw && sw.opened ? '#222' : '#555';
      }
      else if (cell === 3 || cell === 4 || cell === 5) {
        // Gem doors: disguise as regular wall on map (hidden until opened)
        const gd = (map.gemDoors||[]).find(d => d.x===mx && d.y===my);
        mmCtx.fillStyle = gd && gd.opened ? '#222' : '#555';
      }
      else mmCtx.fillStyle = '#222';
    }
    mmCtx.fillRect(x * CELL, y * CELL, CELL, CELL);
  }
  if (map.exitPortal) { const epx = Math.floor(map.exitPortal.x - offX), epy = Math.floor(map.exitPortal.y - offY); if (epx >= 0 && epx < 20 && epy >= 0 && epy < 20) { mmCtx.fillStyle = map.exitPortal.active ? '#00ffdd' : '#004444'; mmCtx.fillRect(epx * CELL, epy * CELL, CELL, CELL); } }
  for (const t of (map.torches||[])) { const tx = Math.floor(t.x - offX), ty = Math.floor(t.y - offY); if (tx >= 0 && tx < 20 && ty >= 0 && ty < 20) { mmCtx.fillStyle = '#ff8800'; mmCtx.fillRect(tx * CELL + 1, ty * CELL + 1, 2, 2); } }
  // Gem key pickups on minimap
  for (const gk of (map.gemKeyPickups||[])) { if (gk.collected) continue; const gkx = Math.floor(gk.x - offX), gky = Math.floor(gk.y - offY); if (gkx >= 0 && gkx < 20 && gky >= 0 && gky < 20) { mmCtx.fillStyle = gk.color === 'red' ? '#ff4444' : (gk.color === 'green' ? '#44ff44' : '#4488ff'); mmCtx.fillRect(gkx * CELL, gky * CELL, CELL, CELL); } }
  for (const e of enemies.list) { if (!e.alive) continue; const ex = Math.floor(e.x - offX), ey = Math.floor(e.y - offY); if (ex >= 0 && ex < 20 && ey >= 0 && ey < 20) { if (e.isAbomination) mmCtx.fillStyle = '#ff00aa'; else if (e.isBoss) mmCtx.fillStyle = '#ff00ff'; else if (e.type==='bat') mmCtx.fillStyle = '#8866ff'; else if (e.type==='spider') mmCtx.fillStyle = '#aa44ff'; else mmCtx.fillStyle = '#ff4444'; const sz = e.isAbomination ? CELL : (e.isBoss ? CELL : CELL-2); mmCtx.fillRect(ex*CELL+1, ey*CELL+1, sz, sz); } }
  for (const p of map.pickups) { const px = Math.floor(p.x - offX), py = Math.floor(p.y - offY); if (px >= 0 && px < 20 && py >= 0 && py < 20) { mmCtx.fillStyle = p.type === 'health' ? '#44ff44' : '#ffdd44'; mmCtx.fillRect(px*CELL+1, py*CELL+1, 2, 2); } }
  for (const bolt of state.projectiles) { if (!bolt.alive) continue; const bx = Math.floor(bolt.x - offX), by = Math.floor(bolt.y - offY); if (bx >= 0 && bx < 20 && by >= 0 && by < 20) { mmCtx.fillStyle = '#00ffff'; mmCtx.fillRect(bx*CELL+1, by*CELL+1, 2, 2); } }
  const ppx = Math.floor(player.x - offX), ppy = Math.floor(player.y - offY);
  mmCtx.fillStyle = '#00aaff'; mmCtx.fillRect(ppx*CELL, ppy*CELL, CELL, CELL);
  mmCtx.strokeStyle = '#00aaff'; mmCtx.lineWidth = 1; mmCtx.beginPath();
  mmCtx.moveTo(ppx*CELL+CELL/2, ppy*CELL+CELL/2); mmCtx.lineTo(ppx*CELL+CELL/2+Math.cos(player.angle)*6, ppy*CELL+CELL/2+Math.sin(player.angle)*6); mmCtx.stroke();
}

function showOverlay(type) {
  // Hide any panels first
  _hideAllMenuPanels();
  const overlay = document.getElementById('overlay'); overlay.innerHTML = ''; overlay.style.display = 'flex';
  if (type === 'dead') {
    overlay.innerHTML = `<h1 style="color:#ff2222">YOU DIED</h1><div class="subtitle">DEPTH REACHED: ${state.level} | SCORE: ${state.score}</div><button class="btn" id="lb-btn">&#127942; LEADERBOARD</button><button class="btn" id="restart-btn">&#9658; TRY AGAIN</button>`;
    // Wipe player-uploaded mod data before leaderboard post
    try { localStorage.removeItem('goblin_dungeon_mods'); } catch(e) {}
    leaderboard.submit(state.score);
    document.getElementById('lb-btn').onclick = (e) => { e.stopPropagation(); leaderboard.show(); };
    document.getElementById('restart-btn').onclick = startGame;
  }
}
function hideOverlay() { document.getElementById('overlay').style.display = 'none'; }

// ================== AMBIENT DRONE SYSTEM ==================
let _ambienceNode = null, _ambienceGain = null, _audioCtx = null;
const _ambienceBuffers = [null, null, null];
function _getAudioCtx() { if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return _audioCtx; }
async function _loadAmbienceBuffer(idx) {
  if (_ambienceBuffers[idx]) return _ambienceBuffers[idx];
  try { const resp = await fetch(AMBIENCE_URLS[idx]); const arr = await resp.arrayBuffer(); const ctx2 = _getAudioCtx(); const buf = await ctx2.decodeAudioData(arr); _ambienceBuffers[idx] = buf; return buf; } catch (err) { return null; }
}
function stopAmbience(fadeSecs = 1.5) {
  if (!_ambienceNode || !_ambienceGain) return;
  const ctx2 = _getAudioCtx(), gain = _ambienceGain, node = _ambienceNode;
  gain.gain.setTargetAtTime(0, ctx2.currentTime, fadeSecs / 3);
  setTimeout(() => { try { node.stop(); } catch(e) {} }, fadeSecs * 1000 + 200);
  _ambienceNode = null; _ambienceGain = null;
}
async function startAmbience(level) {
  const seedMod = map && map.seed ? (map.seed % 3) : (level - 1) % 3;
  stopAmbience(1.2);
  const buf = await _loadAmbienceBuffer(seedMod);
  if (!buf) return;
  const ctx2 = _getAudioCtx();
  if (ctx2.state === 'suspended') { try { await ctx2.resume(); } catch(e) {} }
  const gainNode = ctx2.createGain();
  gainNode.gain.setValueAtTime(0, ctx2.currentTime);
  gainNode.gain.setTargetAtTime(audioVolumes.ambience, ctx2.currentTime, 1.2);
  gainNode.connect(ctx2.destination);
  const src = ctx2.createBufferSource();
  src.buffer = buf; src.loop = true;
  const seedHash = map && map.seed ? map.seed : level;
  const pitchBase = 0.85 + ((seedHash % 31) / 31) * 0.3;
  src.playbackRate.value = pitchBase;
  src.connect(gainNode); src.start();
  _ambienceNode = src; _ambienceGain = gainNode;
}

// ================== LIVE VOLUME CONTROL ==================
function setAmbienceLiveVolume(v) {
  audioVolumes.ambience = v;
  if (_ambienceGain && _audioCtx) {
    _ambienceGain.gain.setTargetAtTime(v, _audioCtx.currentTime, 0.08);
  }
}

// ================== PAUSE MENU ==================
let _pauseMenu = null;

function _buildMidiSection(container, idPrefix) {
  const section = document.createElement('div');
  const MENU_GFX_MIDI = "url('./graphics/MENU_GFX.png')";
  section.style.cssText = 'border:none;padding:14px 20px;margin-bottom:14px;min-width:280px;border-image:' + MENU_GFX_MIDI + ' 0 33% 0 33% fill / 0 13px 0 13px / 0px round stretch;image-rendering:pixelated;';
  section.innerHTML = `
    <div style="color:#fff;font-size:6px;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;font-family:'Press Start 2P','Courier New',monospace;">♬ MIDI Music Player</div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;">
      <label id="${idPrefix}-midi-file-label" style="background:rgba(0,0,0,0.55);color:#fff;border:2px solid #000;padding:4px 8px;font-size:5px;letter-spacing:1px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">📂 FILE</label>
      <input type="file" id="${idPrefix}-midi-file-input" accept=".mid,.midi" style="display:none;">
      <label id="${idPrefix}-midi-folder-label" style="background:rgba(0,0,0,0.55);color:#fff;border:2px solid #000;padding:4px 8px;font-size:5px;letter-spacing:1px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">📁 FOLDER</label>
      <input type="file" id="${idPrefix}-midi-folder-input" accept=".mid,.midi" multiple webkitdirectory style="display:none;">
      <span id="${idPrefix}-midi-filename" style="color:#fff;font-size:5px;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:110px;flex:1;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">No file loaded</span>
    </div>
    <div id="${idPrefix}-midi-playlist-row" style="display:none;margin-bottom:8px;color:#fff;font-size:5px;letter-spacing:1px;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">
      📋 <span id="${idPrefix}-midi-playlist-count">0</span> tracks loaded &nbsp;
      <label style="cursor:pointer;color:#fff;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;"><input type="checkbox" id="${idPrefix}-midi-auto-advance" checked style="margin-right:4px;">auto-play per level</label>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="${idPrefix}-midi-play-btn" style="background:rgba(0,0,0,0.55);color:#fff;border:2px solid #000;padding:5px 12px;font-size:7px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">▶ PLAY</button>
      <button id="${idPrefix}-midi-rand-btn" style="background:rgba(0,0,0,0.55);color:#fff;border:2px solid #000;padding:5px 8px;font-size:7px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">🎲</button>
      <button id="${idPrefix}-midi-stop-btn" style="background:rgba(0,0,0,0.55);color:#fff;border:2px solid #000;padding:5px 12px;font-size:7px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">■ STOP</button>
      <span id="${idPrefix}-midi-status" style="color:#fff;font-size:5px;letter-spacing:1px;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;">stopped</span>
    </div>
  `;
  container.appendChild(section);

  const fileInput   = section.querySelector(`#${idPrefix}-midi-file-input`);
  const folderInput = section.querySelector(`#${idPrefix}-midi-folder-input`);
  const filenameEl  = section.querySelector(`#${idPrefix}-midi-filename`);
  const statusEl    = section.querySelector(`#${idPrefix}-midi-status`);
  const playlistRow = section.querySelector(`#${idPrefix}-midi-playlist-row`);
  const plCount     = section.querySelector(`#${idPrefix}-midi-playlist-count`);
  const autoAdvCB   = section.querySelector(`#${idPrefix}-midi-auto-advance`);
  const playBtn     = section.querySelector(`#${idPrefix}-midi-play-btn`);
  const randBtn     = section.querySelector(`#${idPrefix}-midi-rand-btn`);
  const stopBtn     = section.querySelector(`#${idPrefix}-midi-stop-btn`);
  const fileLabel   = section.querySelector(`#${idPrefix}-midi-file-label`);
  const folderLabel = section.querySelector(`#${idPrefix}-midi-folder-label`);

  const setStatus    = (txt, _color) => { statusEl.textContent = txt; statusEl.style.color = '#fff'; };
  const syncFilename = () => { if (midiPlayer.fileName) filenameEl.textContent = midiPlayer.fileName; };

  // ── Sync UI from current midiPlayer state (handles carry-over from main menu) ──
  autoAdvCB.checked = midiPlayer.autoAdvance;
  if (midiPlayer.playlist.length > 0) {
    playlistRow.style.display = 'flex';
    plCount.textContent = midiPlayer.playlist.length;
    filenameEl.textContent = `${midiPlayer.playlist.length} tracks`;
  } else if (midiPlayer.fileName) {
    filenameEl.textContent = midiPlayer.fileName;
  }
  if (midiPlayer.isPlaying) {
    playBtn.textContent = '‖ PAUSE';
    setStatus('playing', '#44ff44');
    syncFilename();
  } else if (midiPlayer.isPaused) {
    setStatus('paused', '#ffaa44');
    syncFilename();
  } else if (midiPlayer.isLoaded) {
    setStatus('ready', '#44ff44');
  }

  autoAdvCB.addEventListener('change', () => { midiPlayer.autoAdvance = autoAdvCB.checked; });

  // ── Multi-listener callbacks — use on/off so both menus coexist ──────────
  const onPlay = () => { playBtn.textContent = '‖ PAUSE'; setStatus('playing', '#44ff44'); syncFilename(); };
  const onEnd  = () => {
    playBtn.textContent = '▶ PLAY';
    if (midiPlayer.autoAdvance && midiPlayer.playlist.length > 1) {
      setStatus('next track…', '#ffaa44');
      // Only the first section to handle onEnd should trigger autoAdvance;
      // guard with a flag so we don't double-advance.
      if (!midiPlayer._autoAdvancing) {
        midiPlayer._autoAdvancing = true;
        setTimeout(() => { midiPlayer._autoAdvancing = false; midiPlayer.playRandom(); }, 400);
      }
    } else { setStatus('finished', '#888'); }
  };
  const onError        = (msg) => { setStatus(msg || 'error', '#ff4444'); };
  const onLoad         = ()    => { setStatus('ready', '#44ff44'); };
  const onPlaylistLoad = (count) => {
    playlistRow.style.display = 'flex';
    plCount.textContent = count;
    filenameEl.textContent = `${count} tracks`;
    setStatus('ready', '#8888ff');
  };

  midiPlayer.on('play',        onPlay);
  midiPlayer.on('end',         onEnd);
  midiPlayer.on('error',       onError);
  midiPlayer.on('load',        onLoad);
  midiPlayer.on('playlistload', onPlaylistLoad);

  // Track whether listeners are currently attached to avoid double-add.
  let _attached = true;

  const cleanup = () => {
    if (!_attached) return;
    _attached = false;
    midiPlayer.off('play',        onPlay);
    midiPlayer.off('end',         onEnd);
    midiPlayer.off('error',       onError);
    midiPlayer.off('load',        onLoad);
    midiPlayer.off('playlistload', onPlaylistLoad);
  };

  const reattach = () => {
    if (_attached) return;
    _attached = true;
    midiPlayer.on('play',        onPlay);
    midiPlayer.on('end',         onEnd);
    midiPlayer.on('error',       onError);
    midiPlayer.on('load',        onLoad);
    midiPlayer.on('playlistload', onPlaylistLoad);
  };

  // Expose for explicit show/hide lifecycle — no hot MutationObserver needed.
  section._midiCleanup  = cleanup;
  section._midiReattach = reattach;

  fileLabel.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    filenameEl.textContent = file.name;
    setStatus('loading…', '#ffdd44');
    playlistRow.style.display = 'none';
    midiPlayer.loadFile(file);
    e.target.value = '';
  });

  folderLabel.addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
  folderInput.addEventListener('change', (e) => {
    const files = e.target.files; if (!files || !files.length) return;
    setStatus('reading…', '#8888ff');
    filenameEl.textContent = 'loading folder…';
    midiPlayer.loadFolder(files);
    e.target.value = '';
  });

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (midiPlayer.isPlaying) { midiPlayer.pause(); playBtn.textContent = '▶ PLAY'; setStatus('paused', '#ffaa44'); }
    else if (midiPlayer.isPaused) { midiPlayer.resume(); playBtn.textContent = '‖ PAUSE'; setStatus('playing', '#44ff44'); }
    else { midiPlayer.setVolume(audioVolumes.music); midiPlayer.play(); }
  });
  randBtn.addEventListener('click', (e) => { e.stopPropagation(); midiPlayer.setVolume(audioVolumes.music); midiPlayer.playRandom(); });
  stopBtn.addEventListener('click', (e) => { e.stopPropagation(); midiPlayer.stop(); playBtn.textContent = '▶ PLAY'; setStatus('stopped', '#666'); });
  return section;
}

// Push current audioVolumes into every volume slider that exists in the DOM.
// Called whenever any slider changes, and when either options panel opens.
function _syncAllVolumeSliders() {
  const prefixes = ['pause', 'menu-opt'];
  const vals = {
    'vol-fx':      Math.round(audioVolumes.fx * 100),
    'vol-music':   Math.round(audioVolumes.music * 100),
    'vol-ambience':Math.round(audioVolumes.ambience * 100),
    'vol-menumx':  Math.round(audioVolumes.menuMusic * 100),
  };
  for (const prefix of prefixes) {
    for (const [key, val] of Object.entries(vals)) {
      const slider = document.getElementById(`${prefix}-${key}`);
      const label  = document.getElementById(`${prefix}-${key}-val`);
      if (slider) slider.value = val;
      if (label)  label.textContent = val;
    }
  }
}

function _buildVolumeSection(container, idPrefix) {
  // Inject slider + pause-button CSS once — must happen here so main-menu options
  // panel is styled correctly even before the pause menu has ever been opened.
  if (!document.getElementById('vol-slider-style')) {
    const style = document.createElement('style');
    style.id = 'vol-slider-style';
    style.textContent = `
      .vol-row { display:flex;align-items:center;gap:8px;margin-bottom:8px; }
      .vol-lbl { color:#fff;font-size:5px;letter-spacing:1px;font-family:'Press Start 2P','Courier New',monospace;min-width:58px;text-align:right;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000; }
      .vol-val  { color:#fff;font-size:5px;font-family:'Press Start 2P','Courier New',monospace;min-width:26px;text-align:right;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000; }
      .vol-slider { -webkit-appearance:none;appearance:none;flex:1;height:18px;border-radius:0;background:transparent;border:none;outline:none;cursor:pointer;padding:0; }
      .vol-slider::-webkit-slider-runnable-track { height:18px;border-image:url('./graphics/SLIDER_BAR.png') 0 33% 0 fill / 0 6px 0 / 0 stretch;border-style:solid;border-width:0 6px 0;background:transparent; }
      .vol-slider::-moz-range-track { height:18px;border-image:url('./graphics/SLIDER_BAR.png') 0 33% 0 fill / 0 6px 0 / 0 stretch;border-style:solid;border-width:0 6px 0;background:transparent; }
      .vol-slider::-webkit-slider-thumb { -webkit-appearance:none;width:20px;height:20px;margin-top:-1px;background:url('./graphics/GEM_HANDLE.png') center/contain no-repeat;background-color:transparent;border:none;cursor:pointer; }
      .vol-slider::-moz-range-thumb { width:20px;height:20px;background:url('./graphics/GEM_HANDLE.png') center/contain no-repeat;background-color:transparent;border:none;cursor:pointer;border-radius:0; }

      /* Pause-menu buttons — identical atlas style to main menu .btn */
      .pause-btn {
        --btn-atlas: url('./graphics/MENUBUTTONPIECES.png');
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: none;
        border: none;
        padding: 0;
        margin: 4px;
        cursor: pointer;
        font-family: 'Press Start 2P', 'Courier New', monospace;
        font-size: 11px;
        letter-spacing: 2px;
        color: #fff;
        text-transform: uppercase;
        text-shadow: 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
        min-width: 220px;
        height: 26px;
        border-image: var(--btn-atlas) 0 33% 0 33% fill / 0 13px 0 13px / 0px round stretch;
        image-rendering: pixelated;
        transition: filter 0.08s;
      }
      .pause-btn:hover {
        filter: brightness(1.35) saturate(1.2);
        text-shadow: 2px 2px 0 #000, 0 0 14px #fff, 0 0 6px #ff8800;
      }
      .pause-btn:active {
        filter: brightness(0.85);
        transform: translateY(1px);
      }
      /* Pause menu section titles */
      .pause-title {
        color: #fff;
        font-family: 'Press Start 2P', 'Courier New', monospace;
        font-size: 16px;
        letter-spacing: 4px;
        text-shadow: 2px 2px 0 #000, -1px -1px 0 #000;
        margin-bottom: 22px;
      }
      .pause-title-sm {
        color: #fff;
        font-family: 'Press Start 2P', 'Courier New', monospace;
        font-size: 14px;
        letter-spacing: 4px;
        text-shadow: 2px 2px 0 #000, -1px -1px 0 #000;
        margin-bottom: 14px;
      }
    `;
    document.head.appendChild(style);
  }

  const section = document.createElement('div');
  const MENU_GFX = "url('./graphics/MENU_GFX.png')";
  section.style.cssText = 'border:none;padding:14px 20px;margin-bottom:14px;min-width:280px;border-image:' + MENU_GFX + ' 0 33% 0 33% fill / 0 13px 0 13px / 0px round stretch;image-rendering:pixelated;';
  section.innerHTML = `
    <div style="color:#fff;font-size:6px;letter-spacing:2px;margin-bottom:12px;text-transform:uppercase;text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;font-family:'Press Start 2P','Courier New',monospace;">⚙ Audio Settings</div>
    <div class="vol-row">
      <span class="vol-lbl">FX</span>
      <input type="range" id="${idPrefix}-vol-fx" min="0" max="100" step="1" value="${Math.round(audioVolumes.fx*100)}" class="vol-slider">
      <span class="vol-val" id="${idPrefix}-vol-fx-val">${Math.round(audioVolumes.fx*100)}</span>
    </div>
    <div class="vol-row">
      <span class="vol-lbl">MUSIC</span>
      <input type="range" id="${idPrefix}-vol-music" min="0" max="100" step="1" value="${Math.round(audioVolumes.music*100)}" class="vol-slider">
      <span class="vol-val" id="${idPrefix}-vol-music-val">${Math.round(audioVolumes.music*100)}</span>
    </div>
    <div class="vol-row">
      <span class="vol-lbl">AMBIENCE</span>
      <input type="range" id="${idPrefix}-vol-ambience" min="0" max="100" step="1" value="${Math.round(audioVolumes.ambience*100)}" class="vol-slider">
      <span class="vol-val" id="${idPrefix}-vol-ambience-val">${Math.round(audioVolumes.ambience*100)}</span>
    </div>
    <div class="vol-row">
      <span class="vol-lbl">MENU MX</span>
      <input type="range" id="${idPrefix}-vol-menumx" min="0" max="100" step="1" value="${Math.round(audioVolumes.menuMusic*100)}" class="vol-slider">
      <span class="vol-val" id="${idPrefix}-vol-menumx-val">${Math.round(audioVolumes.menuMusic*100)}</span>
    </div>
  `;
  container.appendChild(section);

  section.querySelector(`#${idPrefix}-vol-fx`).addEventListener('input', function() {
    audioVolumes.fx = this.value / 100;
    _syncAllVolumeSliders();
  });
  section.querySelector(`#${idPrefix}-vol-music`).addEventListener('input', function() {
    audioVolumes.music = this.value / 100;
    midiPlayer.setVolume(audioVolumes.music);
    _syncAllVolumeSliders();
  });
  section.querySelector(`#${idPrefix}-vol-ambience`).addEventListener('input', function() {
    setAmbienceLiveVolume(this.value / 100);
    _syncAllVolumeSliders();
  });
  section.querySelector(`#${idPrefix}-vol-menumx`).addEventListener('input', function() {
    audioVolumes.menuMusic = this.value / 100;
    // Apply live to jingle if currently playing
    try { if (!_introJingle.paused) _introJingle.volume = audioVolumes.menuMusic; } catch(e) {}
    _syncAllVolumeSliders();
  });

  return section;
}

function buildPauseMenu() {
  if (_pauseMenu) return;

  const el = document.createElement('div');
  el.id = 'pause-menu';
  el.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:80px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:rgba(0,0,0,0.88);z-index:20;
    font-family:'Press Start 2P','Courier New',monospace;
    overflow-y:auto;
  `;

  // ── Main pause screen (title + nav buttons) ────────────────────────────────
  const mainScreen = document.createElement('div');
  mainScreen.id = 'pause-main-screen';
  mainScreen.style.cssText = 'display:flex;flex-direction:column;align-items:center;';

  const title = document.createElement('div');
  title.className = 'pause-title';
  title.textContent = '— PAUSED —';
  mainScreen.appendChild(title);

  const resumeBtn = document.createElement('button');
  resumeBtn.id = 'pause-resume-btn';
  resumeBtn.className = 'pause-btn';
  resumeBtn.textContent = '▶ RESUME';
  mainScreen.appendChild(resumeBtn);

  const optionsBtn = document.createElement('button');
  optionsBtn.id = 'pause-options-btn';
  optionsBtn.className = 'pause-btn';
  optionsBtn.textContent = '⚙ OPTIONS';
  mainScreen.appendChild(optionsBtn);

  const controlsBtn = document.createElement('button');
  controlsBtn.id = 'pause-controls-btn';
  controlsBtn.className = 'pause-btn';
  controlsBtn.textContent = '⚙ CONTROLS';
  mainScreen.appendChild(controlsBtn);

  const quitMenuBtn = document.createElement('button');
  quitMenuBtn.id = 'pause-quit-menu-btn';
  quitMenuBtn.className = 'pause-btn';
  quitMenuBtn.style.marginTop = '14px';
  quitMenuBtn.textContent = '✕ MAIN MENU';
  mainScreen.appendChild(quitMenuBtn);

  el.appendChild(mainScreen);

  // Register pause main-screen nav (buttons added after this block)
  // Will be fully registered after all buttons are known (see below)

  // ── Quit-confirm sub-panel ─────────────────────────────────────────────────
  const QUIT_TAUNTS = [
    'Really end run?',
    'Scared?',
    'Quit if your socks smell like Goblin armpits.',
    'Exit to DOS?'
  ];

  const confirmScreen = document.createElement('div');
  confirmScreen.id = 'pause-confirm-screen';
  confirmScreen.style.cssText = 'display:none;flex-direction:column;align-items:center;justify-content:center;gap:18px;';

  const confirmMsg = document.createElement('div');
  confirmMsg.style.cssText = 'color:#fff;font-size:9px;letter-spacing:2px;text-align:center;max-width:260px;line-height:1.8;text-shadow:2px 2px 0 #000,-1px -1px 0 #000;font-family:\'Press Start 2P\',\'Courier New\',monospace;';
  confirmScreen.appendChild(confirmMsg);

  const confirmBtnRow = document.createElement('div');
  confirmBtnRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;';

  const confirmYesBtn = document.createElement('button');
  confirmYesBtn.textContent = '✕ YES, QUIT';
  confirmYesBtn.className = 'pause-btn';
  confirmYesBtn.style.minWidth = '160px';

  const confirmNoBtn = document.createElement('button');
  confirmNoBtn.textContent = '◀ NO, BACK';
  confirmNoBtn.className = 'pause-btn';
  confirmNoBtn.style.minWidth = '160px';

  confirmBtnRow.appendChild(confirmYesBtn);
  confirmBtnRow.appendChild(confirmNoBtn);
  confirmScreen.appendChild(confirmBtnRow);

  el.appendChild(confirmScreen);

  // ── Options sub-panel ──────────────────────────────────────────────────────
  const optionsScreen = document.createElement('div');
  optionsScreen.id = 'pause-options-screen';
  optionsScreen.style.cssText = 'display:none;flex-direction:column;align-items:center;width:100%;padding:16px 0;';

  const optTitle = document.createElement('div');
  optTitle.className = 'pause-title-sm';
  optTitle.textContent = '— OPTIONS —';
  optionsScreen.appendChild(optTitle);

  _buildVolumeSection(optionsScreen, 'pause');
  el._pauseMidiSection = _buildMidiSection(optionsScreen, 'pause');

  const optBackBtn = document.createElement('button');
  optBackBtn.className = 'pause-btn';
  optBackBtn.style.marginTop = '8px';
  optBackBtn.textContent = '◀ BACK';
  optBackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    optionsScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    menuNav.activate('pause-main', 1);
  });
  optionsScreen.appendChild(optBackBtn);
  el.appendChild(optionsScreen);

  // ── Controls / Keybind sub-panel ───────────────────────────────────────────
  const controlsScreen = document.createElement('div');
  controlsScreen.id = 'pause-controls-screen';
  controlsScreen.style.cssText = 'display:none;flex-direction:column;align-items:center;width:100%;padding:16px;overflow-y:auto;';

  const ctrlTitle = document.createElement('div');
  ctrlTitle.className = 'pause-title-sm';
  ctrlTitle.style.marginBottom = '10px';
  ctrlTitle.textContent = '— CONTROLS —';
  controlsScreen.appendChild(ctrlTitle);

  // Static info block (always visible)
  const ctrlInfo = document.createElement('div');
  ctrlInfo.style.cssText = 'color:#fff;font-size:7px;text-align:center;line-height:1.8;letter-spacing:1px;text-shadow:2px 2px 0 #000,-1px -1px 0 #000;font-family:\'Press Start 2P\',\'Courier New\',monospace;margin-bottom:10px;';
  ctrlInfo.innerHTML = `
    MOUSE — AIM &bull; 1-6 — SWITCH WEAPON<br>
    LEFT CLICK — SHOOT &bull; ESC — PAUSE<br>
    <br>
    <span style="color:#fff;">BOSS EVERY 5 FLOORS &bull; SHOP AFTER EVERY LEVEL</span><br>
    <span style="color:#fff;">ABOMINATION LURKS AT FLOOR 25, 50, 75...</span><br>
    <br>
    <span style="color:#ff4444;">♦</span> RED &bull; <span style="color:#44ff44;">♦</span> GREEN &bull; <span style="color:#4488ff;">♦</span> BLUE GEM KEYS<br>
    <span style="color:#aaa;font-size:6px;">GEM KEYS EXPIRE EACH LEVEL TRANSITION</span>
  `;
  controlsScreen.appendChild(ctrlInfo);

  // Keybind editor container
  const kbContainer = document.createElement('div');
  kbContainer.id = 'pause-kb-container';
  kbContainer.style.cssText = 'width:100%;max-width:360px;';
  controlsScreen.appendChild(kbContainer);
  // Populated when the Controls screen is shown (so gp reference is ready)

  const ctrlBackBtn = document.createElement('button');
  ctrlBackBtn.className = 'pause-btn';
  ctrlBackBtn.style.cssText = 'margin-top:12px;border-image:var(--btn-atlas) 0 33% 0 33% fill / 0 24px 0 24px / 0px round stretch;height:48px;';
  ctrlBackBtn.textContent = '◀ BACK';
  ctrlBackBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    controlsScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    // Cleanup any pending capture listeners
    if (kbContainer._keybindCleanup) kbContainer._keybindCleanup();
    menuNav.activate('pause-main', 2);
  });
  controlsScreen.appendChild(ctrlBackBtn);
  el.appendChild(controlsScreen);

  // Store ref so controlsBtn click can build the keybind UI with the live gp
  el._kbContainer = kbContainer;

  document.getElementById('game-container').appendChild(el);
  _pauseMenu = el;

  // ── Register all pause sub-screens with menuNav ─────────────────────────────
  menuNav.register('pause-main', [resumeBtn, optionsBtn, controlsBtn, quitMenuBtn], null);
  menuNav.register('pause-confirm', [confirmNoBtn, confirmYesBtn], () => {
    confirmScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    menuNav.activate('pause-main', 3);
  }, true /* horizontal */);
  menuNav.register('pause-options', [optBackBtn], () => {
    optionsScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    menuNav.activate('pause-main', 1);
  });
  menuNav.register('pause-controls', [ctrlBackBtn], () => {
    controlsScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    if (kbContainer._keybindCleanup) kbContainer._keybindCleanup();
    menuNav.activate('pause-main', 2);
  });

  resumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.paused = false;
    hidePauseMenu();
    tryLockPointer();
  });

  optionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mainScreen.style.display = 'none';
    optionsScreen.style.display = 'flex';
    menuNav.activate('pause-options');
  });

  controlsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mainScreen.style.display = 'none';
    controlsScreen.style.display = 'flex';
    // Build / refresh the keybind editor with the live gp reference
    if (el._kbContainer) {
      buildKeybindUI(el._kbContainer, keybinds, input ? input.gp : null);
    }
    menuNav.activate('pause-controls');
  });

  quitMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Pick a random taunt and show confirm screen
    confirmMsg.textContent = QUIT_TAUNTS[Math.floor(Math.random() * QUIT_TAUNTS.length)];
    mainScreen.style.display = 'none';
    confirmScreen.style.display = 'flex';
    menuNav.activate('pause-confirm');
  });

  confirmNoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmScreen.style.display = 'none';
    mainScreen.style.display = 'flex';
    menuNav.activate('pause-main', 3);
  });

  confirmYesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmScreen.style.display = 'none';
    // Stop audio
    stopAmbience(0.5);
    midiPlayer.stop();
    document.exitPointerLock();
    // Reset cheat state
    _cheatActive = false;
    _noclipActive = false;
    _cheatBuffer = '';
    if (player) player._godMode = false;
    // Return to menu phase
    state.paused = false;
    state.phase = 'menu';
    state.levelTransition = false;
    hidePauseMenu();
    _playIntroJingle();
    // Show the main menu overlay as it was (just show it, don't rebuild)
    const overlay = document.getElementById('overlay');
    if (overlay) {
      // Rebuild main menu HTML (press-any-key hidden since player already interacted)
      overlay.innerHTML = `
        <h1>GOON</h1>
        <div class="subtitle">&#9760; RETRO FPS &#9760;</div>
        <div id="press-any-key" style="display:none;">&#9658; PRESS ANY KEY &#9668;</div>
        <div id="main-menu-btns" style="display:flex;flex-direction:column;align-items:center;gap:4px;">
          <button class="btn" id="start-btn">&#9658; START GAME</button>
          <button class="btn" id="options-btn">&#9881; OPTIONS</button>
          <button class="btn" id="controls-btn">&#9741; CONTROLS</button>
          <button class="btn" id="modeditor-btn" style="color:#aaff88;text-shadow:1px 1px 0 #000,0 0 10px #44ff44;">&#9998; MOD EDITOR</button>
        </div>
      `;
      overlay.style.display = 'flex';
      // Re-wire buttons — re-collect refs after innerHTML rebuild
      const _rStartBtn     = document.getElementById('start-btn');
      _rStartBtn.onclick = startGame;
      const _rOptionsBtn   = document.getElementById('options-btn');
      const _rControlsBtn  = document.getElementById('controls-btn');
      const _rModEditorBtn = document.getElementById('modeditor-btn');
      _rOptionsBtn.onclick = (ev) => {
        ev.stopPropagation();
        _hideMainMenuButtons();
        const panel = buildMenuOptions();
        panel.style.display = 'flex';
        _syncAllVolumeSliders();
        menuNav.activate('main-options');
      };
      _rControlsBtn.onclick = (ev) => {
        ev.stopPropagation();
        _hideMainMenuButtons();
        const panel = buildMenuControls();
        panel.style.display = 'flex';
        menuNav.activate('main-controls');
      };
      _rModEditorBtn.onclick = (ev) => {
        ev.stopPropagation();
        _hideMainMenuButtons();
        menuNav.deactivate();
        modEditor.show(() => { _showMainMenuButtons(); menuNav.activate('main-menu'); });
      };
      menuNav.register('main-menu', [_rStartBtn, _rOptionsBtn, _rControlsBtn, _rModEditorBtn], null);
      menuNav.activate('main-menu');
    }
  });
}

function showPauseMenu() {
  buildPauseMenu();
  // Always reset to main screen when opening
  const mainScreen  = _pauseMenu.querySelector('#pause-main-screen');
  const optScreen   = _pauseMenu.querySelector('#pause-options-screen');
  const ctrlScreen  = _pauseMenu.querySelector('#pause-controls-screen');
  const confScreen  = _pauseMenu.querySelector('#pause-confirm-screen');
  if (mainScreen)  mainScreen.style.display  = 'flex';
  if (optScreen)   optScreen.style.display   = 'none';
  if (ctrlScreen)  ctrlScreen.style.display  = 'none';
  if (confScreen)  confScreen.style.display  = 'none';

  // Re-attach MIDI listeners while the pause menu is visible.
  // (They were detached on hide to avoid competing with the main-menu handler.)
  const pauseMidiSec = _pauseMenu._pauseMidiSection;
  if (pauseMidiSec && typeof pauseMidiSec._midiReattach === 'function') pauseMidiSec._midiReattach();

  _pauseMenu.style.display = 'flex';
  // Sync all slider values across both option panels
  _syncAllVolumeSliders();

  // Activate menu navigation on the main pause screen
  menuNav.activate('pause-main');
}

function hidePauseMenu() {
  if (!_pauseMenu) return;
  // Detach MIDI event listeners while hidden so they don't compete with the
  // main-menu section's identical handlers during gameplay.
  const pauseMidiSec = _pauseMenu._pauseMidiSection;
  if (pauseMidiSec && typeof pauseMidiSec._midiCleanup === 'function') pauseMidiSec._midiCleanup();
  _pauseMenu.style.display = 'none';
  menuNav.deactivate();
}

// ================== MAIN MENU PANELS ==================
let _menuOptionsEl = null;
let _menuControlsEl = null;

function _hideAllMenuPanels() {
  if (_menuOptionsEl) _menuOptionsEl.style.display = 'none';
  if (_menuControlsEl) _menuControlsEl.style.display = 'none';
  modEditor.hide();
}

function buildMenuOptions() {
  if (_menuOptionsEl) return _menuOptionsEl;
  const gameContainer = document.getElementById('game-container');

  const el = document.createElement('div');
  el.id = 'menu-options-panel';
  el.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:0;
    display:none;flex-direction:column;align-items:center;justify-content:flex-start;
    background:rgba(0,0,0,0.96);z-index:15;
    font-family:'Press Start 2P','Courier New',monospace;
    overflow-y:auto;padding:16px 0 16px;
  `;

  const title = document.createElement('div');
  title.className = 'pause-title-sm';
  title.style.marginBottom = '14px';
  title.textContent = '— OPTIONS —';
  el.appendChild(title);

  _buildVolumeSection(el, 'menu-opt');
  _buildMidiSection(el, 'menu-opt');

  const backBtn = document.createElement('button');
  backBtn.className = 'btn';
  backBtn.textContent = '◀ BACK';
  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.style.display = 'none';
    _showMainMenuButtons();
    menuNav.activate('main-menu', 1);
  });
  el.appendChild(backBtn);

  // Register main-options panel nav (just the back button)
  menuNav.register('main-options', [backBtn], () => {
    el.style.display = 'none';
    _showMainMenuButtons();
    menuNav.activate('main-menu', 1);
  });

  gameContainer.appendChild(el);
  _menuOptionsEl = el;
  return el;
}

function buildMenuControls() {
  if (_menuControlsEl) return _menuControlsEl;
  const gameContainer = document.getElementById('game-container');

  const el = document.createElement('div');
  el.id = 'menu-controls-panel';
  el.style.cssText = `
    position:absolute;top:0;left:0;right:0;bottom:0;
    display:none;flex-direction:column;align-items:center;justify-content:flex-start;
    background:rgba(0,0,0,0.96);z-index:15;
    font-family:'Press Start 2P','Courier New',monospace;
    padding:16px;overflow-y:auto;
  `;

  const titleEl = document.createElement('div');
  titleEl.className = 'pause-title-sm';
  titleEl.style.marginBottom = '12px';
  titleEl.textContent = '— CONTROLS & KEYBINDS —';
  el.appendChild(titleEl);

  const infoEl = document.createElement('div');
  infoEl.style.cssText = 'color:#fff;font-size:7px;text-align:center;line-height:1.8;letter-spacing:1px;text-shadow:2px 2px 0 #000,-1px -1px 0 #000;font-family:\'Press Start 2P\',\'Courier New\',monospace;margin-bottom:12px;';
  infoEl.innerHTML = `
    MOUSE — AIM &bull; 1-6 — SWITCH WEAPON<br>
    LEFT CLICK — SHOOT &bull; ESC — PAUSE<br>
    <span style="color:#aaa;font-size:6px;">CLICK BADGE BELOW TO REMAP ANY KEY OR GAMEPAD BUTTON</span>
  `;
  el.appendChild(infoEl);

  const kbContainer = document.createElement('div');
  kbContainer.style.cssText = 'width:100%;max-width:360px;';
  el.appendChild(kbContainer);
  // Build keybind UI immediately (menu context, input may not be ready — gp can be null)
  buildKeybindUI(kbContainer, keybinds, input ? input.gp : null);

  const backBtn = document.createElement('button');
  backBtn.className = 'btn';
  backBtn.style.cssText = 'margin-top:12px;border-image:var(--btn-atlas) 0 33% 0 33% fill / 0 24px 0 24px / 0px round stretch;height:48px;';
  backBtn.textContent = '◀ BACK';
  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (kbContainer._keybindCleanup) kbContainer._keybindCleanup();
    el.style.display = 'none';
    _showMainMenuButtons();
    menuNav.activate('main-menu', 2);
  });
  el.appendChild(backBtn);

  // Register controls panel nav (just the back button)
  menuNav.register('main-controls', [backBtn], () => {
    if (kbContainer._keybindCleanup) kbContainer._keybindCleanup();
    el.style.display = 'none';
    _showMainMenuButtons();
    menuNav.activate('main-menu', 2);
  });

  gameContainer.appendChild(el);
  _menuControlsEl = el;
  return el;
}

function _showMainMenuButtons() {
  // Show the main overlay buttons group
  const btnGroup = document.getElementById('main-menu-btns');
  if (btnGroup) btnGroup.style.display = 'flex';
  // Hide the press-any-key prompt once the menu is revealed
  const pak = document.getElementById('press-any-key');
  if (pak) pak.style.display = 'none';
}

function _hideMainMenuButtons() {
  const btnGroup = document.getElementById('main-menu-btns');
  if (btnGroup) btnGroup.style.display = 'none';
  // Never restore press-any-key after the player has already interacted once
}

// ================== FULLSCREEN AUTOMAP ==================
function drawFullscreenMap() {
  if (!map) return;
  const W = map.width, H = map.height, cw = canvas.width, ch = canvas.height, pad = 10;
  const cellW = Math.floor((cw-pad*2)/W), cellH = Math.floor((ch-pad*2)/H);
  const CELL = Math.max(1, Math.min(cellW, cellH));
  const HEADER_H = 28; // reserve space at top for level name + close hint
  const oxM = Math.floor((cw - CELL * W) / 2);
  const oyM = Math.max(HEADER_H + 4, Math.floor((ch - CELL * H) / 2));

  ctx.fillStyle = 'rgba(0,0,0,0.92)'; ctx.fillRect(0, 0, cw, ch);

  // ── Header bar ─────────���───────────────────────────────────────────────────
  const levelLabel = _getCurrentLevelLabel();
  ctx.fillStyle = 'rgba(0,40,10,0.85)';
  ctx.fillRect(0, 0, cw, HEADER_H);
  ctx.fillStyle = '#ffdd44';
  ctx.font = `bold 10px ${getModFont()}`;
  ctx.textAlign = 'left';
  ctx.fillText(levelLabel, 10, 18);
  ctx.fillStyle = '#888866';
  ctx.textAlign = 'right';
  ctx.fillText('[Q] CLOSE', cw - 10, 18);
  ctx.textAlign = 'left';
  // ── Legend bar ─────────────────────────────────────────────────────────────
  const legendY = ch - 14;
  ctx.font = `bold 7px ${getModFont()}`;
  ctx.fillStyle = '#00aaff';  ctx.fillText('▪ YOU', 10, legendY);
  ctx.fillStyle = '#ff3333';  ctx.fillText('▪ ENEMY', 52, legendY);
  ctx.fillStyle = '#44ff44';  ctx.fillText('▪ HEALTH', 108, legendY);
  ctx.fillStyle = '#ffdd44';  ctx.fillText('▪ AMMO', 168, legendY);
  ctx.fillStyle = '#00ffdd';  ctx.fillText('▪ EXIT', 222, legendY);

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cell = map.grid[y][x];
    let color;
    if (cell===1) color='#444';
    else if (cell===2) {
      // Secret doors hidden as regular walls; show as passage once opened
      const sw = (map.secretWalls||[]).find(s=>s.x===x&&s.y===y);
      color = sw && sw.opened ? '#181818' : '#444';
    }
    else if (cell===3 || cell===4 || cell===5) {
      // Gem doors hidden as regular walls; show as passage once opened
      const gd = (map.gemDoors||[]).find(g=>g.x===x&&g.y===y);
      color = gd && gd.opened ? '#181818' : '#444';
    }
    else color='#181818';
    ctx.fillStyle=color; ctx.fillRect(oxM+x*CELL,oyM+y*CELL,CELL,CELL);
  }
  for (const r of (map.rooms||[])) { ctx.strokeStyle='rgba(80,80,120,0.4)'; ctx.lineWidth=1; ctx.strokeRect(oxM+r.x*CELL,oyM+r.y*CELL,r.w*CELL,r.h*CELL); }
  if (map.exitPortal) { ctx.fillStyle = map.exitPortal.active ? '#00ffdd' : '#005544'; ctx.fillRect(oxM+Math.floor(map.exitPortal.x)*CELL, oyM+Math.floor(map.exitPortal.y)*CELL, CELL, CELL); }
  for (const t of (map.torches||[])) { ctx.fillStyle='#ff8800'; ctx.fillRect(oxM+Math.floor(t.x)*CELL+Math.max(1,CELL/3),oyM+Math.floor(t.y)*CELL+Math.max(1,CELL/3),Math.max(1,CELL/3),Math.max(1,CELL/3)); }
  // Gem key pickups on fullscreen map
  for (const gk of (map.gemKeyPickups||[])) {
    if (gk.collected) continue;
    ctx.fillStyle = gk.color === 'red' ? '#ff4444' : (gk.color === 'green' ? '#44ff44' : '#4488ff');
    ctx.fillRect(oxM+Math.floor(gk.x)*CELL+1, oyM+Math.floor(gk.y)*CELL+1, Math.max(2,CELL-2), Math.max(2,CELL-2));
  }
  if (enemies) for (const e of enemies.list) { if (!e.alive) continue; if (e.isAbomination) ctx.fillStyle='#ff00aa'; else if (e.isBoss) ctx.fillStyle='#ff00ff'; else if (e.type==='bat') ctx.fillStyle='#8866ff'; else if (e.type==='spider') ctx.fillStyle='#aa44ff'; else ctx.fillStyle='#ff3333'; const ex=Math.floor(e.x),ey=Math.floor(e.y),sz=e.isBoss?CELL*2:CELL; ctx.fillRect(oxM+ex*CELL,oyM+ey*CELL,sz,sz); }
  for (const p of (map.pickups||[])) { ctx.fillStyle=p.type==='health'?'#44ff44':'#ffdd44'; ctx.fillRect(oxM+Math.floor(p.x)*CELL+1,oyM+Math.floor(p.y)*CELL+1,Math.max(1,CELL-2),Math.max(1,CELL-2)); }
  if (player) { const ppx=Math.floor(player.x),ppy=Math.floor(player.y); ctx.fillStyle='#00aaff'; ctx.fillRect(oxM+ppx*CELL,oyM+ppy*CELL,Math.max(2,CELL),Math.max(2,CELL)); ctx.strokeStyle='#00aaff'; ctx.lineWidth=Math.max(1,CELL/2); ctx.beginPath(); const cx2=oxM+ppx*CELL+CELL/2,cy2=oyM+ppy*CELL+CELL/2; ctx.moveTo(cx2,cy2); ctx.lineTo(cx2+Math.cos(player.angle)*CELL*2,cy2+Math.sin(player.angle)*CELL*2); ctx.stroke(); }
}

function tryLockPointer() { try { const p = canvas.requestPointerLock(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (e) {} }

async function startGame() {
  _stopIntroJingle();
  hidePauseMenu();
  _hideAllMenuPanels();
  hideOverlay();
  _showLoadingScreen();

  // Deactivate menu navigation immediately so gamepad/keyboard inputs
  // during loading don't fire main-menu buttons (mod editor, start, etc.)
  menuNav.deactivate();

  state.phase = 'playing'; state.level = 1; state.score = 0; state.gold = 0; state.paused = false;
  state.levelTransition = false; state.projectiles = []; state.hitEffects = []; state.bloodParticles = []; state.explosionEffects = []; state.screenShake = 0;
  state.fullscreenMap = false; state.bossRoar = false; state.bossRoarType = '';
  state.ownedWeapons = WEAPONS.map(w => ({ ...w })); state.ownedUpgrades = null;
  _runSeed = makeDateSeed(); player = null;

  await initLevel(1); // loading screen hides after READY? click; tryLockPointer called inside
  startAmbience(1);
}

document.addEventListener('DOMContentLoaded', () => {
  // ── Press Any Key → reveal main menu ─────────────────────────────────────
  let _menuRevealed = false;
  function _revealMainMenu() {
    if (_menuRevealed) return;
    _menuRevealed = true;
    _playIntroJingle();
    const pak = document.getElementById('press-any-key');
    if (pak) pak.style.display = 'none';
    const btnGroup = document.getElementById('main-menu-btns');
    if (btnGroup) btnGroup.style.display = 'flex';
    menuNav.activate('main-menu');
  }
  // Reveal on any key press OR any pointer/touch on the overlay
  document.addEventListener('keydown', function _pakKey(e) {
    // Don't intercept if overlay isn't showing
    const overlay = document.getElementById('overlay');
    if (!overlay || overlay.style.display === 'none') return;
    if (state.phase !== 'menu') return;
    _revealMainMenu();
    document.removeEventListener('keydown', _pakKey);
  });
  const overlay0 = document.getElementById('overlay');
  if (overlay0) {
    overlay0.addEventListener('pointerdown', function _pakClick() {
      if (state.phase !== 'menu') return;
      _revealMainMenu();
      overlay0.removeEventListener('pointerdown', _pakClick);
    });
  }

  // ── Gamepad "press any button" poll for title screen ─────────────────────
  // input.tick() only runs during gameplay, so we need a lightweight RAF loop
  // here to catch the very first gamepad button press on the title screen.
  // After revealing the menu we suppress menuNav for a few frames so the
  // triggering button press doesn't immediately click the focused menu item.
  let _pakGpRafId = null;
  function _pakGpPoll() {
    if (_menuRevealed) return; // done — stop polling
    if (state.phase !== 'menu') return; // not on title screen
    // Check any connected gamepad for any button press
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch(e) { return; }
    for (const pad of pads) {
      if (!pad) continue;
      for (const btn of pad.buttons) {
        if (btn.value > 0.3) {
          _revealMainMenu();
          // Suppress menuNav for ~10 frames so this button press doesn't
          // immediately trigger the focused menu button (bypassing the menu).
          menuNav._suppressFrames = 10;
          return; // stop — no need to schedule another frame
        }
      }
    }
    _pakGpRafId = requestAnimationFrame(_pakGpPoll);
  }
  _pakGpRafId = requestAnimationFrame(_pakGpPoll);

  const _startBtn     = document.getElementById('start-btn');
  const _optionsBtn   = document.getElementById('options-btn');
  const _controlsBtn  = document.getElementById('controls-btn');
  const _modEditorBtn = document.getElementById('modeditor-btn');

  _startBtn.onclick = startGame;

  _optionsBtn.onclick = (e) => {
    e.stopPropagation();
    _hideMainMenuButtons();
    const panel = buildMenuOptions();
    panel.style.display = 'flex';
    _syncAllVolumeSliders();
    menuNav.activate('main-options');
  };

  _controlsBtn.onclick = (e) => {
    e.stopPropagation();
    _hideMainMenuButtons();
    const panel = buildMenuControls();
    panel.style.display = 'flex';
    menuNav.activate('main-controls');
  };

  _modEditorBtn.onclick = (e) => {
    e.stopPropagation();
    _hideMainMenuButtons();
    menuNav.deactivate();
    modEditor.show(() => {
      // Called when user clicks ◀ BACK inside the editor
      _showMainMenuButtons();
      menuNav.activate('main-menu');
    });
  };

  // Register main menu navigation
  menuNav.register('main-menu', [_startBtn, _optionsBtn, _controlsBtn, _modEditorBtn], null);

  // ── Menu button click sounds ─────────────────────────────────────────────
  // Delegated listener on document: plays shop buy SFX for any .btn or .pause-btn click
  const _menuClickSfx = new Audio('./sounds/player/shop_buy.mp3');
  _menuClickSfx.volume = 0.5;
  document.addEventListener('click', (e) => {
    const tgt = e.target;
    if (!tgt) return;
    if (tgt.classList.contains('btn') || tgt.classList.contains('pause-btn')) {
      try { _menuClickSfx.cloneNode().play().catch(() => {}); } catch(_) {}
    }
  }, true); // capture phase so it fires even if handler calls stopPropagation

  document.addEventListener('keydown', e => {
    if (state.phase === 'playing' && !state.paused && !state.levelTransition) {
      const slotKey = parseInt(e.key);
      if (slotKey >= 1 && slotKey <= 6 && state.ownedWeapons) {
        const owned = state.ownedWeapons.filter(w => w.owned);
        const target = owned[slotKey - 1];
        if (target && player) { player.equippedWeapon = target.id; showMessage(`${target.name}`, 800); updateHUD(); return; }
      }
      // Feed cheat buffer
      _handleCheatInput(e.key);
    }
    // Skip intermission with Space/Enter
    if ((e.key === ' ' || e.key === 'Enter') && state.phase === 'intermission') {
      const im = state.intermission;
      if (im) {
        if (im.phase === 'stats') { im.phase = 'entering'; im.timer = 0; }
        else { im.timer = im.enteringDisplayTime; }
      }
      return;
    }
    if (e.key === 'Escape') {
      // Close pause sub-panels first (back to main pause screen)
      if (_pauseMenu && _pauseMenu.style.display !== 'none') {
        const optScreen  = _pauseMenu.querySelector('#pause-options-screen');
        const ctrlScreen = _pauseMenu.querySelector('#pause-controls-screen');
        const mainScreen = _pauseMenu.querySelector('#pause-main-screen');
        if (optScreen && optScreen.style.display !== 'none') {
          optScreen.style.display = 'none';
          if (mainScreen) mainScreen.style.display = 'flex';
          return;
        }
        if (ctrlScreen && ctrlScreen.style.display !== 'none') {
          ctrlScreen.style.display = 'none';
          if (mainScreen) mainScreen.style.display = 'flex';
          return;
        }
      }
      // Close main menu panels first
      if (_menuOptionsEl && _menuOptionsEl.style.display !== 'none') {
        _menuOptionsEl.style.display = 'none';
        _showMainMenuButtons();
        menuNav.activate('main-menu', 1);
        return;
      }
      if (_menuControlsEl && _menuControlsEl.style.display !== 'none') {
        _menuControlsEl.style.display = 'none';
        _showMainMenuButtons();
        menuNav.activate('main-menu', 2);
        return;
      }
      if (modEditor._panel && modEditor._panel.style.display !== 'none') {
        modEditor.hide();
        _showMainMenuButtons();
        menuNav.activate('main-menu', 3);
        return;
      }
      if (state.phase === 'playing' && !state.levelTransition) {
        state.paused = !state.paused;
        if (state.paused) { state.fullscreenMap = false; document.exitPointerLock(); showPauseMenu(); }
        else { hidePauseMenu(); tryLockPointer(); }
      }
    }
    if (state.phase === 'playing' && !state.mapToggleCooldown && keybinds.keyMatchesAction('map', e.key)) {
      state.fullscreenMap = !state.fullscreenMap;
      state.mapToggleCooldown = true;
      setTimeout(() => { state.mapToggleCooldown = false; }, 220);
    }
  });

  canvas.addEventListener('click', () => {
    if (state.phase === 'playing' && !state.paused) tryLockPointer();
  });

  // Initialize CRT overlay (async — starts rendering as soon as Three.js loads)
  createCRT(_gameContainer, canvas).then(handle => {
    crtHandle = handle;
  }).catch(err => {
    console.warn('[CRT] Failed to initialize shader overlay:', err);
  });

  requestAnimationFrame(gameLoop);
});
