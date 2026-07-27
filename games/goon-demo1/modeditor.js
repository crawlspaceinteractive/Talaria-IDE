// ═══════════════════════════════════════════════════════════════════════════════
// MOD EDITOR — In-game asset swap panel
// Lets players load custom PNG images (power-of-two, ≤2MB) to replace
// any sprite, texture, or weapon image. Web font loader included.
// Animation frame slots: 2 walk frames + 3 attack frames per enemy type.
// Changes apply live and persist across sessions.
// ═══════════════════════════════════════════════════════════════════════════════

import { customAnimFrames, customSfx } from './assets.js';

const MAX_FILE_SIZE        = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES        = ['image/png'];
const ALLOWED_AUDIO_TYPES  = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'];
const MAX_AUDIO_SIZE       = 8 * 1024 * 1024; // 8 MB
const MAX_INTRO_MUSIC_SIZE = 2 * 1024 * 1024; // 2 MB  (same as images)
const MAX_INTRO_MUSIC_SECS = 30;               // 30-second clip cap
const STORAGE_KEY          = 'goblin_dungeon_mods';

// ── Helpers ───────────────────────────────────────────��──────────────────────

function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Validate an image File; resolves with {img, dataUrl} or rejects with msg */
function validateImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return reject('Only PNG images are supported.');
    }
    if (file.size > MAX_FILE_SIZE) {
      return reject(`File too large (${(file.size/1024/1024).toFixed(1)} MB). Max 2 MB.`);
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const img = new Image();
      img.onload = () => {
        if (!isPowerOfTwo(img.naturalWidth) || !isPowerOfTwo(img.naturalHeight)) {
          return reject(
            `Dimensions must be power-of-two (e.g. 64×64, 128×128, 256×256).\n` +
            `Your image: ${img.naturalWidth}×${img.naturalHeight}.`
          );
        }
        resolve({ img, dataUrl });
      };
      img.onerror = () => reject('Could not decode image.');
      img.src = dataUrl;
    };
    reader.onerror = () => reject('Could not read file.');
    reader.readAsDataURL(file);
  });
}

/** Validate an audio File; resolves with dataUrl or rejects with msg */
function validateAudioFile(file) {
  return new Promise((resolve, reject) => {
    // Accept common audio types (browsers vary in MIME type reporting)
    const ext = file.name.split('.').pop().toLowerCase();
    const validExts = ['mp3', 'wav', 'ogg', 'webm', 'flac', 'm4a'];
    if (!ALLOWED_AUDIO_TYPES.includes(file.type) && !validExts.includes(ext)) {
      return reject('Supported formats: MP3, WAV, OGG, WEBM.');
    }
    if (file.size > MAX_AUDIO_SIZE) {
      return reject(`File too large (${(file.size/1024/1024).toFixed(1)} MB). Max 8 MB.`);
    }
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject('Could not read file.');
    reader.readAsDataURL(file);
  });
}

/** Validate an intro-music File: size ≤ 2 MB, duration ≤ 30 s */
function validateIntroMusicFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split('.').pop().toLowerCase();
    const validExts = ['mp3', 'wav', 'ogg', 'webm', 'flac', 'm4a'];
    if (!ALLOWED_AUDIO_TYPES.includes(file.type) && !validExts.includes(ext)) {
      return reject('Supported formats: MP3, WAV, OGG, WEBM.');
    }
    if (file.size > MAX_INTRO_MUSIC_SIZE) {
      return reject(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 2 MB.`);
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      // Probe duration via an Audio element
      const probe = new Audio(dataUrl);
      probe.addEventListener('loadedmetadata', () => {
        if (isFinite(probe.duration) && probe.duration > MAX_INTRO_MUSIC_SECS) {
          return reject(`Clip too long (${probe.duration.toFixed(1)}s). Max ${MAX_INTRO_MUSIC_SECS}s.`);
        }
        resolve(dataUrl);
      });
      probe.addEventListener('error', () => resolve(dataUrl)); // can't read duration — accept anyway
    };
    reader.onerror = () => reject('Could not read file.');
    reader.readAsDataURL(file);
  });
}

/** Update a live Image element's src while keeping the same object reference */
function hotSwapImage(imgEl, newSrc) {
  if (!imgEl) return;
  imgEl.src = newSrc;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveModsToStorage(mods) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mods)); } catch (e) {}
}

function loadModsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

// ── ModEditor class ───────────────────────────────────────────────────────────

export class ModEditor {
  /**
   * @param {Object} refs  — live asset refs from main.js:
   *   { assets, weaponSprites, hatBrimImgRef, originalUrls }
   */
  constructor(refs) {
    this.refs    = refs;
    this.mods    = loadModsFromStorage();
    this._panel  = null;
    this._built  = false;

    // Apply any saved mods on startup (after a short delay so images load first)
    setTimeout(() => this._applySavedMods(), 600);
  }

  // Called by main.js to hand over the intro jingle Audio node after it's created
  setIntroJingleAudio(audioNode, stopFn, playFn) {
    this._introJingleAudio = audioNode;   // the live Audio element
    this._stopIntroJingle  = stopFn;      // () => void
    this._playIntroJingle  = playFn;      // () => void
  }

  // ── Slot definitions ────────────────────────────────────────────────────────

  _getSlots() {
    const slots = [
      // ─── Textures ────────────────────────────────────────────────────────
      { id: 'wall',         label: 'Wall Texture',         group: 'Textures',  target: 'assets',        key: 'wall' },
      { id: 'wallDungeon',  label: 'Wall (Dungeon)',        group: 'Textures',  target: 'assets',        key: 'wallDungeon' },
      { id: 'wallCave',     label: 'Wall (Cave)',           group: 'Textures',  target: 'assets',        key: 'wallCave' },
      { id: 'wallRuins',    label: 'Wall (Ruins)',          group: 'Textures',  target: 'assets',        key: 'wallRuins' },
      { id: 'wallLibrary',  label: 'Wall (Library)',        group: 'Textures',  target: 'assets',        key: 'wallLibrary' },
      { id: 'floor',        label: 'Floor Texture',        group: 'Textures',  target: 'assets',        key: 'floor' },
      { id: 'floorCave',    label: 'Floor (Cave)',          group: 'Textures',  target: 'assets',        key: 'floorCave' },
      { id: 'floorLibrary',     label: 'Floor (Library)',          group: 'Textures',  target: 'assets',        key: 'floorLibrary' },
      { id: 'floorAbomination', label: 'Floor (Abomination)',       group: 'Textures',  target: 'assets',        key: 'floorAbomination' },
      { id: 'wallDoor',         label: 'Wall (Door)',               group: 'Textures',  target: 'assets',        key: 'wallDoor' },
      // ─── Enemies (static/idle) ────────────────────────────────────────
      { id: 'goblin',        label: 'Goblin (idle)',         group: 'Enemies',   target: 'assets',        key: 'goblin' },
      { id: 'goblinDead',    label: 'Goblin (Dead)',         group: 'Enemies',   target: 'assets',        key: 'goblinDead' },
      { id: 'bat',           label: 'Bat (idle)',            group: 'Enemies',   target: 'assets',        key: 'bat' },
      { id: 'batDead',       label: 'Bat (Dead)',            group: 'Enemies',   target: 'assets',        key: 'batDead' },
      { id: 'spider',        label: 'Spider (idle)',         group: 'Enemies',   target: 'assets',        key: 'spider' },
      { id: 'spiderDead',    label: 'Spider (Dead)',         group: 'Enemies',   target: 'assets',        key: 'spiderDead' },
      { id: 'trollBoss',     label: 'Troll Boss (idle)',     group: 'Enemies',   target: 'assets',        key: 'trollBoss' },
      { id: 'trollDead',     label: 'Troll (Dead)',          group: 'Enemies',   target: 'assets',        key: 'trollDead' },
      { id: 'abomination',   label: 'Abomination (idle)',    group: 'Enemies',   target: 'assets',        key: 'abomination' },
      { id: 'abominationDead', label: 'Abomination (Dead)', group: 'Enemies',   target: 'assets',        key: 'abominationDead' },
    ];

    // ─── Enemy Animation Frames ───────────────────────────────────────────
    // 2 walk frames + 3 attack frames per enemy type.
    // When any walk OR attack frame is loaded for an enemy,
    // it fully overrides the generated spritesheet for that animation type.
    const animEnemies = [
      { key: 'goblin',      label: 'Goblin'      },
      { key: 'bat',         label: 'Bat'         },
      { key: 'spider',      label: 'Spider'      },
      { key: 'troll',       label: 'Troll Boss'  },
      { key: 'abomination', label: 'Abomination' },
    ];
    for (const ae of animEnemies) {
      slots.push({
        id: `anim_${ae.key}_walk_0`,  label: `${ae.label} Walk F1`,   group: 'Anim Frames',
        target: 'animFrame', enemyKey: ae.key, animType: 'walk',   frameIdx: 0,
      });
      slots.push({
        id: `anim_${ae.key}_walk_1`,  label: `${ae.label} Walk F2`,   group: 'Anim Frames',
        target: 'animFrame', enemyKey: ae.key, animType: 'walk',   frameIdx: 1,
      });
      slots.push({
        id: `anim_${ae.key}_atk_0`,   label: `${ae.label} Atk F1`,    group: 'Anim Frames',
        target: 'animFrame', enemyKey: ae.key, animType: 'attack', frameIdx: 0,
      });
      slots.push({
        id: `anim_${ae.key}_atk_1`,   label: `${ae.label} Atk F2`,    group: 'Anim Frames',
        target: 'animFrame', enemyKey: ae.key, animType: 'attack', frameIdx: 1,
      });
      slots.push({
        id: `anim_${ae.key}_atk_2`,   label: `${ae.label} Atk F3`,    group: 'Anim Frames',
        target: 'animFrame', enemyKey: ae.key, animType: 'attack', frameIdx: 2,
      });
    }

    // ─── Weapons ─────────────────────────────────────────────────────────
    slots.push({ id: 'wpn_pistol',   label: 'Pistol',               group: 'Weapons',   target: 'weaponSprites', key: 'pistol' });
    slots.push({ id: 'wpn_shotgun',  label: 'Shotgun',              group: 'Weapons',   target: 'weaponSprites', key: 'shotgun' });
    slots.push({ id: 'wpn_crossbow', label: 'Crossbow',             group: 'Weapons',   target: 'weaponSprites', key: 'crossbow' });
    slots.push({ id: 'wpn_cannon',   label: 'Cannon',               group: 'Weapons',   target: 'weaponSprites', key: 'cannon' });
    slots.push({ id: 'wpn_sword',    label: 'Sword',                group: 'Weapons',   target: 'weaponSprites', key: 'sword' });
    slots.push({ id: 'wpn_plasma2',  label: 'Plasma II',            group: 'Weapons',   target: 'weaponSprites', key: 'plasma2' });

    // ─── Props & Pickups ─────────────────────────────────────────────────
    slots.push({ id: 'healthPack',   label: 'Health Pack',          group: 'Props',     target: 'assets',        key: 'healthPack' });
    slots.push({ id: 'ammoCrate',    label: 'Ammo Crate',           group: 'Props',     target: 'assets',        key: 'ammoCrate' });
    slots.push({ id: 'barrel',       label: 'Barrel',               group: 'Props',     target: 'assets',        key: 'barrel' });
    slots.push({ id: 'pillar',       label: 'Pillar',               group: 'Props',     target: 'assets',        key: 'pillar' });
    slots.push({ id: 'torch',        label: 'Torch',                group: 'Props',     target: 'assets',        key: 'torch' });
    slots.push({ id: 'bookshelf',    label: 'Bookshelf',            group: 'Props',     target: 'assets',        key: 'bookshelf' });
    slots.push({ id: 'rubble',       label: 'Rubble',               group: 'Props',     target: 'assets',        key: 'rubble' });
    slots.push({ id: 'table',        label: 'Table',                group: 'Props',     target: 'assets',        key: 'table' });
    slots.push({ id: 'chair',        label: 'Chair',                group: 'Props',     target: 'assets',        key: 'chair' });
    slots.push({ id: 'brazier',      label: 'Brazier',              group: 'Props',     target: 'assets',        key: 'brazier' });
    slots.push({ id: 'decorSmall',   label: 'Decor (Small)',        group: 'Props',     target: 'assets',        key: 'decorSmall' });
    slots.push({ id: 'spiderEggs',   label: 'Spider Eggs',          group: 'Props',     target: 'assets',        key: 'spiderEggs' });
    slots.push({ id: 'exitPortal',   label: 'Exit Portal',          group: 'Props',     target: 'assets',        key: 'exitPortal' });
    slots.push({ id: 'treasureChest',label: 'Treasure Chest',       group: 'Props',     target: 'assets',        key: 'treasureChest' });
    slots.push({ id: 'muzzle',       label: 'Muzzle Flash',         group: 'Props',     target: 'assets',        key: 'muzzle' });
    slots.push({ id: 'plasmaBolt',   label: 'Plasma Bolt',          group: 'Props',     target: 'assets',        key: 'plasmaBolt' });

    // ─── Hat ─────────────────────────────────────────────────────────────
    slots.push({ id: 'hatBrim',      label: 'Hat Overlay',          group: 'Hat',       target: 'hatBrim',       key: null });

    // ─── Puddles ─────���───────────────────────────────────────────────────
    slots.push({ id: 'puddleWater',  label: 'Puddle (Water)',        group: 'Puddles',   target: 'assets',        key: 'puddleWater' });
    slots.push({ id: 'puddleSlime',  label: 'Puddle (Slime)',        group: 'Puddles',   target: 'assets',        key: 'puddleSlime' });
    slots.push({ id: 'puddleBlood',  label: 'Puddle (Blood)',        group: 'Puddles',   target: 'assets',        key: 'puddleBlood' });
    slots.push({ id: 'puddleMud',    label: 'Puddle (Mud)',          group: 'Puddles',   target: 'assets',        key: 'puddleMud' });

    return slots;
  }

  // ── Apply saved mods ────────────────────────────────────────────────────────

  _applySavedMods() {
    const slots = this._getSlots();
    for (const [slotId, dataUrl] of Object.entries(this.mods)) {
      if (slotId === '__fonts__' || slotId === '__sfx__') continue;
      const slot = slots.find(s => s.id === slotId);
      if (!slot) continue;
      this._applyMod(slot, dataUrl);
    }
    // Fonts
    if (this.mods.__fonts__) {
      for (const fontEntry of this.mods.__fonts__) {
        const res = this._loadWebFont(fontEntry.url, fontEntry.family, false);
        if (res.ok) {
          setTimeout(() => this._applyFontToHUD(fontEntry.family || res.family), 800);
        }
      }
    }
    // SFX
    if (this.mods.__sfx__) {
      for (const [sfxId, dataUrl] of Object.entries(this.mods.__sfx__)) {
        this._applySfxMod(sfxId, dataUrl);
      }
    }
    // Intro music
    if (this.mods.__introMusic__) {
      this._applyIntroMusicMod(this.mods.__introMusic__);
    }
  }

  _applyMod(slot, dataUrl) {
    if (slot.target === 'animFrame') {
      // Load the dataUrl into a new Image and store it in customAnimFrames
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = dataUrl;
      customAnimFrames[slot.enemyKey][slot.animType][slot.frameIdx] = img;
    } else if (slot.target === 'hatBrim') {
      hotSwapImage(this.refs.hatBrimImgRef, dataUrl);
    } else if (slot.target === 'assets') {
      const img = this.refs.assets[slot.key];
      if (img) hotSwapImage(img, dataUrl);
    } else if (slot.target === 'weaponSprites') {
      const img = this.refs.weaponSprites[slot.key];
      if (img) hotSwapImage(img, dataUrl);
      // Also update the WeaponSpriteManager's offscreen canvas
      if (this.refs.weaponManager) this.refs.weaponManager.hotSwap(slot.key, dataUrl);
    }
  }

  _clearMod(slot) {
    if (slot.target === 'animFrame') {
      customAnimFrames[slot.enemyKey][slot.animType][slot.frameIdx] = null;
    } else if (slot.target === 'hatBrim') {
      const origSrc = this.refs.originalUrls?.hatBrim;
      if (origSrc) hotSwapImage(this.refs.hatBrimImgRef, origSrc);
    } else if (slot.target === 'assets') {
      const origSrc = this.refs.originalUrls?.assets?.[slot.key];
      const img = this.refs.assets[slot.key];
      if (origSrc && img) hotSwapImage(img, origSrc);
    } else if (slot.target === 'weaponSprites') {
      const origSrc = this.refs.originalUrls?.weaponSprites?.[slot.key];
      const img = this.refs.weaponSprites[slot.key];
      if (origSrc && img) hotSwapImage(img, origSrc);
      // Also restore the WeaponSpriteManager's offscreen canvas
      if (origSrc && this.refs.weaponManager) this.refs.weaponManager.hotSwap(slot.key, origSrc);
    }
  }

  // ── SFX mod helpers ─────────────────────────────────────────────────────────

  _getSfxSlots() {
    return [
      // Weapon fire sounds
      { id: 'wpn_pistol',   label: 'Pistol Fire',       group: 'Weapon SFX' },
      { id: 'wpn_shotgun',  label: 'Shotgun Fire',      group: 'Weapon SFX' },
      { id: 'wpn_crossbow', label: 'Crossbow Fire',     group: 'Weapon SFX' },
      { id: 'wpn_cannon',   label: 'Cannon Fire',       group: 'Weapon SFX' },
      { id: 'wpn_sword',    label: 'Sword Swing',       group: 'Weapon SFX' },
      { id: 'wpn_plasma2',  label: 'Plasma II Fire',    group: 'Weapon SFX' },
      // Enemy death sounds
      { id: 'enemy_goblin',      label: 'Goblin Death',      group: 'Enemy SFX' },
      { id: 'enemy_bat',         label: 'Bat Death',         group: 'Enemy SFX' },
      { id: 'enemy_spider',      label: 'Spider Death',      group: 'Enemy SFX' },
      { id: 'enemy_troll',       label: 'Troll Death',       group: 'Enemy SFX' },
      { id: 'enemy_abomination', label: 'Abomination Death', group: 'Enemy SFX' },
    ];
  }

  _applySfxMod(sfxId, dataUrl) {
    const audio = new Audio(dataUrl);
    audio.volume = 0.4;
    customSfx[sfxId] = audio;
  }

  _clearSfxMod(sfxId) {
    delete customSfx[sfxId];
  }

  // ── Intro music mod helpers ──────────────────────────────────────────────────

  _applyIntroMusicMod(dataUrl) {
    if (!this._introJingleAudio) return;
    // Swap the src on the live Audio node so _playIntroJingle picks it up next time
    try {
      const wasPlaying = !this._introJingleAudio.paused;
      if (wasPlaying && this._stopIntroJingle) this._stopIntroJingle();
      this._introJingleAudio.src = dataUrl;
      this._introJingleAudio.load();
      if (wasPlaying && this._playIntroJingle) this._playIntroJingle();
    } catch (e) {}
  }

  _clearIntroMusicMod(originalUrl) {
    if (!this._introJingleAudio) return;
    try {
      const wasPlaying = !this._introJingleAudio.paused;
      if (wasPlaying && this._stopIntroJingle) this._stopIntroJingle();
      this._introJingleAudio.src = originalUrl;
      this._introJingleAudio.load();
    } catch (e) {}
  }

  // ── Font loading ────────────────────────────────────────────────────────────

  _loadWebFont(url, userFamily, persist = true) {
    // Try to extract the family name from a Google Fonts URL (?family=Name+Name)
    let family = userFamily;
    if (!family) {
      try {
        const u = new URL(url);
        const fParam = u.searchParams.get('family');
        if (fParam) {
          // "VT323" or "Press+Start+2P:wght@400" → take the part before ':'
          family = fParam.split(':')[0].replace(/\+/g, ' ');
        }
      } catch (_) {}
    }
    // Final fallback: derive from URL filename
    if (!family) {
      family = url.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_+]/g, ' ');
    }

    try {
      const link = document.createElement('link');
      link.rel  = 'stylesheet';
      link.href = url;
      document.head.appendChild(link);

      if (persist) {
        const existing = this.mods.__fonts__ || [];
        if (!existing.find(f => f.url === url)) {
          existing.push({ url, family });
          this.mods.__fonts__ = existing;
          saveModsToStorage(this.mods);
        }
      }
      return { ok: true, family };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }

  // ── Panel build ─────────────────────────────────────────────────────────────

  buildPanel() {
    if (this._built && this._panel) return this._panel;

    const gameContainer = document.getElementById('game-container');
    const el = document.createElement('div');
    el.id = 'mod-editor-panel';
    el.style.cssText = `
      position:absolute;top:0;left:0;right:0;bottom:0;
      display:none;flex-direction:column;align-items:stretch;
      background:rgba(0,0,0,0.97);z-index:16;
      font-family:'Press Start 2P','Courier New',monospace;
      overflow:hidden;
    `;

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 14px 8px;border-bottom:2px solid #336633;
      background:#0a1a0a;flex-shrink:0;
    `;
    header.innerHTML = `
      <div style="color:#44ff44;font-size:11px;letter-spacing:3px;text-shadow:0 0 8px #00cc44;">
        ✏ MOD EDITOR
      </div>
      <div style="color:#558855;font-size:5px;letter-spacing:1px;text-align:right;line-height:1.6;">
        PNG only &bull; Power-of-two &bull; Max 2 MB<br>
        Changes apply live and persist across sessions
      </div>
    `;
    el.appendChild(header);

    // ── Scrollable body ──────────────────────────────��────────────────────
    const body = document.createElement('div');
    body.id = 'mod-editor-body';
    body.style.cssText = `
      flex:1;overflow-y:auto;padding:10px 12px;
      scrollbar-width:thin;scrollbar-color:#336633 #0a1a0a;
    `;
    el.appendChild(body);

    this._buildBody(body);

    // ── Footer back button ────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.style.cssText = `
      flex-shrink:0;display:flex;justify-content:center;
      padding:8px;border-top:2px solid #336633;background:#0a1a0a;
    `;
    const backBtn = document.createElement('button');
    backBtn.textContent = '◀ BACK';
    backBtn.style.cssText = `background:#0a1a0a;color:#44ff44;border:1px solid #336633;padding:6px 18px;font-size:9px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;letter-spacing:1px;`;
    backBtn.addEventListener('click', () => this.hide());
    footer.appendChild(backBtn);
    el.appendChild(footer);

    gameContainer.appendChild(el);
    this._panel = el;
    this._built = true;
    return el;
  }

  _buildBody(body) {
    body.innerHTML = '';

    // ── Group slots by category ───────────────────────────────────────────
    const slots = this._getSlots();
    const groups = {};
    const groupOrder = [];
    for (const slot of slots) {
      if (!groups[slot.group]) { groups[slot.group] = []; groupOrder.push(slot.group); }
      groups[slot.group].push(slot);
    }

    const groupColors = {
      Textures: '#44aaff', Enemies: '#ff8844', 'Anim Frames': '#ffaa22',
      Weapons: '#ffdd44', Props: '#88ff88', Hat: '#ff88ff', Puddles: '#88ddff',
    };

    for (const groupName of groupOrder) {
      const groupSlots = groups[groupName];
      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:12px;';

      const groupLabel = document.createElement('div');
      groupLabel.style.cssText = `color:${groupColors[groupName] || '#aaa'};font-size:6px;letter-spacing:2px;margin-bottom:6px;text-transform:uppercase;border-bottom:1px solid #1a2a1a;padding-bottom:3px;`;
      groupLabel.textContent = `── ${groupName}`;

      // Extra hint for Anim Frames
      if (groupName === 'Anim Frames') {
        const hint = document.createElement('span');
        hint.style.cssText = 'color:#666;font-size:4px;letter-spacing:1px;margin-left:6px;';
        hint.textContent = '(2 walk + 3 attack per enemy — overrides spritesheet)';
        groupLabel.appendChild(hint);
      }
      section.appendChild(groupLabel);

      const cols = (groupName === 'Anim Frames') ? 3 : 2;
      const grid = document.createElement('div');
      grid.style.cssText = `display:grid;grid-template-columns:repeat(${cols},1fr);gap:5px;`;

      for (const slot of groupSlots) {
        const row = this._buildSlotRow(slot);
        grid.appendChild(row);
      }

      section.appendChild(grid);
      body.appendChild(section);
    }

    // ── SFX section ──────────────────────────────────────────────────────
    body.appendChild(this._buildSfxSection());

    // ── Intro Music section ─��─────────────────────────────────────────────
    body.appendChild(this._buildIntroMusicSection());

    // ── Font section ─────────────────────────────────────────────────────
    body.appendChild(this._buildFontSection());

    // ── Bottom action row: export / import / reset ───────────────────────
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:8px;margin:10px 0 4px;flex-wrap:wrap;';

    // Export button
    const exportBtn = document.createElement('button');
    exportBtn.style.cssText = `background:#0a1a2a;color:#44aaff;border:1px solid #224488;
      padding:5px 12px;font-size:5px;letter-spacing:1px;cursor:pointer;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    exportBtn.textContent = '⬇ EXPORT PACK';
    exportBtn.title = 'Show the zip file structure needed to import your mods';
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); this._exportModpack(); });
    actionRow.appendChild(exportBtn);

    // Import button
    const importFileInput = document.createElement('input');
    importFileInput.type = 'file';
    importFileInput.accept = '.zip,application/zip,application/x-zip-compressed';
    importFileInput.style.display = 'none';
    actionRow.appendChild(importFileInput);

    const importBtn = document.createElement('button');
    importBtn.style.cssText = `background:#0a1a2a;color:#aaddff;border:1px solid #335577;
      padding:5px 12px;font-size:5px;letter-spacing:1px;cursor:pointer;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    importBtn.textContent = '⬆ IMPORT PACK';
    importBtn.title = 'Load a .zip modpack file';
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); importFileInput.click(); });
    importFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await this._importModpack(file);
      e.target.value = '';
    });
    actionRow.appendChild(importBtn);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.style.cssText = `background:#220000;color:#ff4444;border:1px solid #aa2222;
      padding:5px 12px;font-size:5px;letter-spacing:1px;cursor:pointer;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    resetBtn.textContent = '✖ RESET ALL';
    resetBtn.addEventListener('click', () => this._resetAllMods());
    actionRow.appendChild(resetBtn);

    body.appendChild(actionRow);
  }

  // ── Modpack export — human-readable zip structure reference ─────────────────

  _exportModpack() {
    // Helper: guess file extension from a data-URL mime type
    function extFromDataUrl(dataUrl) {
      const mime = dataUrl.split(';')[0].split(':')[1] || '';
      const map = {
        'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
        'audio/mpeg':'mp3','audio/ogg':'ogg','audio/wav':'wav','audio/webm':'webm',
        'font/woff':'woff','font/woff2':'woff2','font/ttf':'ttf','font/otf':'otf',
      };
      return map[mime] || 'bin';
    }

    const slots    = this._getSlots();
    const sfxSlots = this._getSfxSlots();

    // Build a human-readable structure: folder → list of filenames (no data blobs)
    // This mirrors exactly what the zip importer expects.
    const structure = {};

    // Image/anim slots → images/<slotId>.<ext>
    for (const slot of slots) {
      const dataUrl = this.mods[slot.id];
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
      const folder = 'images';
      if (!structure[folder]) structure[folder] = [];
      structure[folder].push(`${slot.id}.${extFromDataUrl(dataUrl)}`);
    }

    // SFX → sfx/<sfxId>.<ext>
    const sfxData = this.mods.__sfx__ || {};
    for (const slot of sfxSlots) {
      const dataUrl = sfxData[slot.id];
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
      if (!structure['sfx']) structure['sfx'] = [];
      structure['sfx'].push(`${slot.id}.${extFromDataUrl(dataUrl)}`);
    }

    // Intro music → music/intro.<ext>
    if (typeof this.mods.__introMusic__ === 'string' && this.mods.__introMusic__.startsWith('data:')) {
      if (!structure['music']) structure['music'] = [];
      structure['music'].push(`intro.${extFromDataUrl(this.mods.__introMusic__)}`);
    }

    // Fonts → fonts/<index>_<family>.<ext>  (+ .meta.json sidecar)
    if (Array.isArray(this.mods.__fonts__) && this.mods.__fonts__.length) {
      const fontEntries = this.mods.__fonts__.filter(f => f && typeof f.url === 'string');
      if (fontEntries.length) {
        if (!structure['fonts']) structure['fonts'] = [];
        fontEntries.forEach((f, i) => {
          const name = (f.family || `font${i}`).replace(/[^a-zA-Z0-9_-]/g, '_');
          if (f.url.startsWith('data:')) {
            const ext = extFromDataUrl(f.url);
            structure['fonts'].push(`${i}_${name}.${ext}`);
            structure['fonts'].push(`${i}_${name}.meta.json  ← { "family": "${f.family || ''}" }`);
          } else {
            // URL-based font — no binary to include, just note it
            structure['fonts'].push(`(external URL: ${f.url})`);
          }
        });
      }
    }

    const totalMods = Object.values(structure).reduce((n, arr) => n + arr.length, 0);
    if (totalMods === 0) {
      this._showToast('No mods to export.', '#ffdd44');
      return;
    }

    // Build a readable text block showing the expected zip layout
    const lines = [];
    lines.push('// Sector-Zero Modpack — Zip File Structure');
    lines.push('// ─────────────────────────────────────────');
    lines.push('// Pack these files into a .zip and use ⬆ IMPORT PACK to load.');
    lines.push('// Filenames must match exactly (slot IDs shown below).');
    lines.push('');

    // Show a visual tree
    lines.push('your_modpack.zip');
    lines.push('│');

    const folders = Object.keys(structure);
    folders.forEach((folder, fi) => {
      const isLast = fi === folders.length - 1;
      const branch = isLast ? '└── ' : '├── ';
      lines.push(`${branch}${folder}/`);
      const files = structure[folder];
      files.forEach((fname, fni) => {
        const fileLast = fni === files.length - 1;
        const indent   = isLast ? '    ' : '│   ';
        const fbranch  = fileLast ? '└── ' : '├── ';
        lines.push(`${indent}${fbranch}${fname}`);
      });
      if (!isLast) lines.push('│');
    });

    lines.push('');
    lines.push('// ─── Slot ID Reference ───────────────────');

    // Append a comment block listing every valid slot id grouped by category
    const slotGroups = {};
    for (const slot of slots) {
      if (!slotGroups[slot.group]) slotGroups[slot.group] = [];
      slotGroups[slot.group].push(slot.id);
    }
    for (const [grp, ids] of Object.entries(slotGroups)) {
      lines.push(`// ${grp}`);
      for (const id of ids) lines.push(`//   images/${id}.png`);
    }
    lines.push('// Weapon SFX');
    for (const s of sfxSlots.filter(s => s.group === 'Weapon SFX')) lines.push(`//   sfx/${s.id}.mp3`);
    lines.push('// Enemy SFX');
    for (const s of sfxSlots.filter(s => s.group === 'Enemy SFX')) lines.push(`//   sfx/${s.id}.mp3`);
    lines.push('// Music');
    lines.push('//   music/intro.mp3');
    lines.push('// Fonts');
    lines.push('//   fonts/0_FontName.ttf  +  fonts/0_FontName.meta.json');

    const displayText = lines.join('\n');

    // ── Build modal ──────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.88);z-index:9998;
      display:flex;align-items:center;justify-content:center;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background:#0a0f0a;border:2px solid #224422;
      display:flex;flex-direction:column;
      width:min(92vw,640px);max-height:82vh;
      font-family:'Press Start 2P','Courier New',monospace;
    `;

    const activeCount = Object.values(structure).reduce((n, arr) => {
      // exclude comment-only entries (font URL refs)
      return n + arr.filter(f => !f.startsWith('(')).length;
    }, 0);

    modal.innerHTML = `
      <div style="padding:10px 14px 8px;border-bottom:1px solid #224422;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
        <div style="color:#44aaff;font-size:8px;letter-spacing:2px;">⬇ ZIP STRUCTURE</div>
        <div style="color:#556655;font-size:5px;letter-spacing:1px;">${activeCount} modded file(s)</div>
      </div>
      <div style="padding:7px 12px 4px;color:#556655;font-size:4px;letter-spacing:1px;line-height:1.9;flex-shrink:0;">
        Your active mods require these files inside a <span style="color:#44aaff;">.zip</span>.
        Recreate this folder structure, then use <span style="color:#44aaff;">⬆ IMPORT PACK</span> to load.
      </div>
    `;

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.value = displayText;
    textarea.style.cssText = `
      flex:1;resize:none;background:#060c06;color:#44cc44;
      border:none;border-top:1px solid #1a2a1a;
      padding:10px 12px;font-size:9px;letter-spacing:0.3px;
      font-family:'Courier New',monospace;line-height:1.65;
      outline:none;min-height:200px;overflow-y:auto;
      scrollbar-width:thin;scrollbar-color:#336633 #060c06;
      tab-size:4;
    `;
    modal.appendChild(textarea);

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:8px;border-top:1px solid #224422;display:flex;gap:8px;justify-content:center;flex-shrink:0;';

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = `background:#0a2a1a;color:#44ff88;border:1px solid #336633;
      padding:5px 12px;font-size:5px;letter-spacing:1px;cursor:pointer;
      font-family:'Press Start 2P','Courier New',monospace;`;
    copyBtn.textContent = '⊡ COPY';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      textarea.select();
      try {
        document.execCommand('copy');
        this._showToast('📋 Copied to clipboard!', '#44aaff');
      } catch (_) {
        try { navigator.clipboard.writeText(displayText); this._showToast('📋 Copied!', '#44aaff'); } catch(__) {}
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = `background:#1a0a0a;color:#ff6644;border:1px solid #442222;
      padding:5px 12px;font-size:5px;letter-spacing:1px;cursor:pointer;
      font-family:'Press Start 2P','Courier New',monospace;`;
    closeBtn.textContent = '✖ CLOSE';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });

    footer.appendChild(copyBtn);
    footer.appendChild(closeBtn);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    setTimeout(() => { textarea.focus(); textarea.select(); }, 80);
  }

  // ── Modpack import — zip only ────────────────────────────────────────────────

  async _importModpack(file) {
    await this._importModpackZip(file);
  }

  // ── ZIP import ───────────────────────────────────────────────────────────────

  async _importModpackZip(file) {
    if (typeof JSZip === 'undefined') {
      this._showToast('JSZip not loaded yet — try again in a moment.', '#ff4444');
      return;
    }

    const slots        = this._getSlots();
    const sfxSlots     = this._getSfxSlots();
    const validSlotIds = new Set(slots.map(s => s.id));
    const validSfxIds  = new Set(sfxSlots.map(s => s.id));

    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (err) {
      this._showToast('Invalid or corrupt .zip file.', '#ff4444');
      return;
    }

    // Helper: zip entry → data-URL string
    async function entryToDataUrl(zipEntry, mimeHint) {
      const ab = await zipEntry.async('arraybuffer');
      const bytes = new Uint8Array(ab);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return `data:${mimeHint};base64,${btoa(binary)}`;
    }

    // Helper: file extension → MIME type
    function extToMime(ext) {
      const map = {
        png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif',
        mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', webm:'audio/webm',
        woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf',
      };
      return map[ext.toLowerCase()] || 'application/octet-stream';
    }

    let applied = 0;
    let skipped = 0;

    // ── Image/anim slots  (images/<slotId>.<ext>) ─────────────────────────
    const imageFolder = zip.folder('images');
    if (imageFolder) {
      const fileList = [];
      imageFolder.forEach((relPath, entry) => { if (!entry.dir) fileList.push({ relPath, entry }); });
      for (const { relPath, entry } of fileList) {
        // relPath is e.g. "wall.png" (relative inside the folder)
        const dotIdx = relPath.lastIndexOf('.');
        if (dotIdx < 0) { skipped++; continue; }
        const slotId = relPath.slice(0, dotIdx);
        const ext    = relPath.slice(dotIdx + 1);
        if (!validSlotIds.has(slotId)) { skipped++; continue; }
        const slot = slots.find(s => s.id === slotId);
        if (!slot) { skipped++; continue; }
        const dataUrl = await entryToDataUrl(entry, extToMime(ext));
        this.mods[slotId] = dataUrl;
        this._applyMod(slot, dataUrl);
        applied++;
      }
    }

    // ── SFX  (sfx/<sfxId>.<ext>) ──────────────────────────────────────────
    const sfxFolder = zip.folder('sfx');
    if (sfxFolder) {
      if (!this.mods.__sfx__) this.mods.__sfx__ = {};
      const fileList = [];
      sfxFolder.forEach((relPath, entry) => { if (!entry.dir) fileList.push({ relPath, entry }); });
      for (const { relPath, entry } of fileList) {
        const dotIdx = relPath.lastIndexOf('.');
        if (dotIdx < 0) { skipped++; continue; }
        const sfxId = relPath.slice(0, dotIdx);
        const ext   = relPath.slice(dotIdx + 1);
        if (!validSfxIds.has(sfxId)) { skipped++; continue; }
        const dataUrl = await entryToDataUrl(entry, extToMime(ext));
        this.mods.__sfx__[sfxId] = dataUrl;
        this._applySfxMod(sfxId, dataUrl);
        applied++;
      }
    }

    // ── Intro Music  (music/intro.<ext>) ──────────────────────────────────
    const musicFolder = zip.folder('music');
    if (musicFolder) {
      const fileList = [];
      musicFolder.forEach((relPath, entry) => { if (!entry.dir) fileList.push({ relPath, entry }); });
      for (const { relPath, entry } of fileList) {
        if (!relPath.startsWith('intro.')) continue;
        const ext     = relPath.slice(relPath.lastIndexOf('.') + 1);
        const dataUrl = await entryToDataUrl(entry, extToMime(ext));
        this.mods.__introMusic__ = dataUrl;
        this._applyIntroMusicMod(dataUrl);
        applied++;
        break; // only one intro track
      }
    }

    // ── Fonts  (fonts/<index>_<family>.<ext>  +  .meta.json sidecar) ──────
    const fontsFolder = zip.folder('fonts');
    if (fontsFolder) {
      if (!this.mods.__fonts__) this.mods.__fonts__ = [];

      // Collect font binary files and their meta sidecars
      const fontFiles = {};  // baseName → { entry, ext }
      const metaFiles = {};  // baseName → { entry }

      fontsFolder.forEach((relPath, entry) => {
        if (entry.dir) return;
        if (relPath.endsWith('.meta.json')) {
          const base = relPath.slice(0, relPath.length - '.meta.json'.length);
          metaFiles[base] = entry;
        } else {
          const dotIdx = relPath.lastIndexOf('.');
          if (dotIdx < 0) return;
          const base = relPath.slice(0, dotIdx);
          const ext  = relPath.slice(dotIdx + 1);
          fontFiles[base] = { entry, ext };
        }
      });

      for (const [base, { entry, ext }] of Object.entries(fontFiles)) {
        let family = '';
        if (metaFiles[base]) {
          try {
            const metaText = await metaFiles[base].async('string');
            family = JSON.parse(metaText).family || '';
          } catch (_) {}
        }
        const dataUrl = await entryToDataUrl(entry, extToMime(ext));
        const res = this._loadWebFont(dataUrl, family, true);
        if (res.ok) {
          setTimeout(() => this._applyFontToHUD(family || res.family), 400);
          applied++;
        } else {
          skipped++;
        }
      }
    }

    if (applied === 0) {
      this._showToast(`No matching slots found. ${skipped} skipped.`, '#ffdd44');
      return;
    }

    // Persist and rebuild
    saveModsToStorage(this.mods);
    const body = document.getElementById('mod-editor-body');
    if (body) this._buildBody(body);

    const msg = `✓ Imported ${applied} mod(s)` + (skipped ? ` (${skipped} skipped)` : '');
    this._showToast(msg, '#44aaff');
  }

  // ── Toast helper ─────────────────────────────────────────────────────────────

  _showToast(msg, color = '#44ff44') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed;bottom:60px;left:50%;transform:translateX(-50%);
      background:#0a0a0a;color:${color};border:1px solid ${color};
      padding:7px 14px;font-size:5px;letter-spacing:1px;z-index:9999;
      font-family:'Press Start 2P','Courier New',monospace;
      pointer-events:none;white-space:nowrap;
      animation:mod-toast-in 0.15s ease;
    `;
    toast.textContent = msg;

    // Inject keyframe if not already there
    if (!document.getElementById('_mod-toast-style')) {
      const style = document.createElement('style');
      style.id = '_mod-toast-style';
      style.textContent = `@keyframes mod-toast-in { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 3200);
  }

  _buildSlotRow(slot) {
    const hasMod = !!this.mods[slot.id];

    const row = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:5px;
      background:${hasMod ? '#0d2210' : '#0d0d0d'};
      border:1px solid ${hasMod ? '#336633' : '#1a1a1a'};
      padding:5px 6px;
    `;
    row.dataset.slotId = slot.id;

    // Thumbnail
    const thumb = document.createElement('canvas');
    thumb.width  = 24;
    thumb.height = 24;
    thumb.style.cssText = 'width:24px;height:24px;image-rendering:pixelated;border:1px solid #222;flex-shrink:0;background:#111;';
    const tCtx = thumb.getContext('2d');
    tCtx.imageSmoothingEnabled = false;

    const drawThumb = (src) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => {
        tCtx.clearRect(0, 0, 24, 24);
        tCtx.drawImage(i, 0, 0, 24, 24);
      };
      i.src = src;
    };

    // Draw current (modded or original) thumbnail
    if (hasMod) {
      drawThumb(this.mods[slot.id]);
    } else if (slot.target !== 'animFrame') {
      // Grab from live asset
      const liveImg = this._getLiveImage(slot);
      if (liveImg && liveImg.src) drawThumb(liveImg.src);
    }

    row.appendChild(thumb);

    // Label + status
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'color:#aaa;font-size:4px;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    lbl.textContent = slot.label;
    info.appendChild(lbl);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = `font-size:4px;letter-spacing:1px;color:${hasMod ? '#44ff44' : '#333'};`;
    statusEl.textContent = hasMod ? '● CUSTOM' : '○ empty';
    info.appendChild(statusEl);

    row.appendChild(info);

    // Action buttons
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;';

    // Upload button
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png';
    fileInput.style.display = 'none';
    row.appendChild(fileInput);

    const uploadBtn = document.createElement('button');
    uploadBtn.style.cssText = `background:#1a3a1a;color:#44ff44;border:1px solid #336633;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    uploadBtn.textContent = '↑ LOAD';
    uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      statusEl.style.color = '#ffdd44';
      statusEl.textContent = '● loading…';
      try {
        const { dataUrl } = await validateImageFile(file);
        // Apply live
        this._applyMod(slot, dataUrl);
        // Persist
        this.mods[slot.id] = dataUrl;
        saveModsToStorage(this.mods);
        // Update UI
        drawThumb(dataUrl);
        statusEl.style.color = '#44ff44';
        statusEl.textContent = '● CUSTOM';
        row.style.background = '#0d2210';
        row.style.borderColor = '#336633';
        clearBtn.style.display = '';
      } catch (err) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = '● error';
        const tip = document.createElement('div');
        tip.style.cssText = `position:fixed;z-index:99;background:#220000;color:#ff4444;
          border:1px solid #aa2222;padding:6px 8px;font-size:5px;letter-spacing:1px;
          font-family:'Press Start 2P','Courier New',monospace;max-width:220px;line-height:1.6;
          pointer-events:none;white-space:pre-wrap;`;
        tip.textContent = err;
        document.body.appendChild(tip);
        const rect = uploadBtn.getBoundingClientRect();
        tip.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
        tip.style.top  = `${rect.bottom + 4}px`;
        setTimeout(() => {
          statusEl.textContent = hasMod ? '● CUSTOM' : '○ empty';
          statusEl.style.color = hasMod ? '#44ff44' : '#333';
          if (tip.parentNode) tip.parentNode.removeChild(tip);
        }, 3500);
      }
      e.target.value = '';
    });

    btnWrap.appendChild(uploadBtn);

    // Clear button (only if modded)
    const clearBtn = document.createElement('button');
    clearBtn.style.cssText = `background:#1a0a0a;color:#ff6644;border:1px solid #442222;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;
      display:${hasMod ? '' : 'none'};`;
    clearBtn.textContent = '✖ CLR';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete this.mods[slot.id];
      saveModsToStorage(this.mods);
      // Restore original
      this._clearMod(slot);
      // Clear thumb
      tCtx.clearRect(0, 0, 24, 24);
      if (slot.target !== 'animFrame') {
        const liveImg = this._getLiveImage(slot);
        if (liveImg && liveImg.src) drawThumb(liveImg.src);
      }
      statusEl.style.color = '#333';
      statusEl.textContent = '○ empty';
      row.style.background = '#0d0d0d';
      row.style.borderColor = '#1a1a1a';
      clearBtn.style.display = 'none';
    });
    btnWrap.appendChild(clearBtn);

    row.appendChild(btnWrap);
    return row;
  }

  _buildSfxSection() {
    const savedSfx = this.mods.__sfx__ || {};
    const sfxSlots = this._getSfxSlots();

    const section = document.createElement('div');
    section.id = 'mod-sfx-section';
    section.style.cssText = 'margin-top:12px;padding:8px 0;border-top:1px solid #1a2a1a;';

    const title = document.createElement('div');
    title.style.cssText = 'color:#ff88cc;font-size:6px;letter-spacing:2px;margin-bottom:4px;';
    title.textContent = '── Sound FX';
    section.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#556655;font-size:4px;letter-spacing:1px;margin-bottom:8px;line-height:1.8;';
    hint.textContent = 'Upload MP3/WAV/OGG (max 8 MB) to replace weapon & enemy sounds. Applied instantly.';
    section.appendChild(hint);

    // Group by category
    const groups = {};
    for (const slot of sfxSlots) {
      if (!groups[slot.group]) groups[slot.group] = [];
      groups[slot.group].push(slot);
    }
    const groupColors = { 'Weapon SFX': '#ffdd44', 'Enemy SFX': '#ff8844' };

    for (const [groupName, slots] of Object.entries(groups)) {
      const groupLabel = document.createElement('div');
      groupLabel.style.cssText = `color:${groupColors[groupName] || '#aaa'};font-size:5px;letter-spacing:1px;margin-bottom:5px;margin-top:6px;`;
      groupLabel.textContent = groupName;
      section.appendChild(groupLabel);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:5px;';

      for (const slot of slots) {
        const row = this._buildSfxSlotRow(slot, savedSfx);
        grid.appendChild(row);
      }
      section.appendChild(grid);
    }

    return section;
  }

  _buildSfxSlotRow(slot, savedSfx) {
    const hasMod = !!savedSfx[slot.id];

    const row = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:5px;
      background:${hasMod ? '#120d1a' : '#0d0d0d'};
      border:1px solid ${hasMod ? '#663366' : '#1a1a1a'};
      padding:5px 6px;
    `;
    row.dataset.sfxId = slot.id;

    // Icon (speaker symbol, changes color if modded)
    const icon = document.createElement('div');
    icon.style.cssText = `font-size:12px;flex-shrink:0;color:${hasMod ? '#cc88ff' : '#333'};line-height:1;`;
    icon.textContent = '♪';
    row.appendChild(icon);

    // Label + status
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'color:#aaa;font-size:4px;letter-spacing:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    lbl.textContent = slot.label;
    info.appendChild(lbl);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = `font-size:4px;letter-spacing:1px;color:${hasMod ? '#cc88ff' : '#333'};`;
    statusEl.textContent = hasMod ? '● CUSTOM' : '○ empty';
    info.appendChild(statusEl);
    row.appendChild(info);

    // Preview button (plays the current sound)
    const previewBtn = document.createElement('button');
    previewBtn.style.cssText = `background:#111;color:#888;border:1px solid #333;
      padding:3px 5px;font-size:9px;cursor:pointer;flex-shrink:0;`;
    previewBtn.title = 'Preview';
    previewBtn.textContent = '▶';
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        const src = customSfx[slot.id];
        if (src) { const a = src.cloneNode(); a.volume = 0.5; a.play().catch(() => {}); }
      } catch (_) {}
    });
    row.appendChild(previewBtn);

    // Action buttons
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm,.flac,.m4a';
    fileInput.style.display = 'none';
    row.appendChild(fileInput);

    const uploadBtn = document.createElement('button');
    uploadBtn.style.cssText = `background:#1a0a2a;color:#cc88ff;border:1px solid #663366;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    uploadBtn.textContent = '↑ LOAD';
    uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      statusEl.style.color = '#ffdd44';
      statusEl.textContent = '● loading…';
      try {
        const dataUrl = await validateAudioFile(file);
        // Apply live
        this._applySfxMod(slot.id, dataUrl);
        // Persist in __sfx__ sub-object
        if (!this.mods.__sfx__) this.mods.__sfx__ = {};
        this.mods.__sfx__[slot.id] = dataUrl;
        saveModsToStorage(this.mods);
        // Update UI
        statusEl.style.color = '#cc88ff';
        statusEl.textContent = '● CUSTOM';
        row.style.background = '#120d1a';
        row.style.borderColor = '#663366';
        icon.style.color = '#cc88ff';
        clearBtn.style.display = '';
        previewBtn.style.color = '#cc88ff';
      } catch (err) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = '● error';
        const tip = document.createElement('div');
        tip.style.cssText = `position:fixed;z-index:99;background:#220000;color:#ff4444;
          border:1px solid #aa2222;padding:6px 8px;font-size:5px;letter-spacing:1px;
          font-family:'Press Start 2P','Courier New',monospace;max-width:220px;line-height:1.6;
          pointer-events:none;white-space:pre-wrap;`;
        tip.textContent = err;
        document.body.appendChild(tip);
        const rect = uploadBtn.getBoundingClientRect();
        tip.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
        tip.style.top  = `${rect.bottom + 4}px`;
        setTimeout(() => {
          statusEl.textContent = hasMod ? '● CUSTOM' : '○ empty';
          statusEl.style.color = hasMod ? '#cc88ff' : '#333';
          if (tip.parentNode) tip.parentNode.removeChild(tip);
        }, 3500);
      }
      e.target.value = '';
    });

    btnWrap.appendChild(uploadBtn);

    const clearBtn = document.createElement('button');
    clearBtn.style.cssText = `background:#1a0a0a;color:#ff6644;border:1px solid #442222;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;
      display:${hasMod ? '' : 'none'};`;
    clearBtn.textContent = '✖ CLR';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearSfxMod(slot.id);
      if (this.mods.__sfx__) { delete this.mods.__sfx__[slot.id]; saveModsToStorage(this.mods); }
      statusEl.style.color = '#333';
      statusEl.textContent = '○ empty';
      row.style.background = '#0d0d0d';
      row.style.borderColor = '#1a1a1a';
      icon.style.color = '#333';
      previewBtn.style.color = '#888';
      clearBtn.style.display = 'none';
    });
    btnWrap.appendChild(clearBtn);

    row.appendChild(btnWrap);
    return row;
  }

  _buildIntroMusicSection() {
    const ORIGINAL_SRC = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/d7eb80a7-ff8e-4ac3-86e2-c556c89b37c9/12c7a027-0f7c-40be-9158-7f5fdf5c26d2.mp3';
    const hasMod = !!this.mods.__introMusic__;

    const section = document.createElement('div');
    section.id = 'mod-intro-music-section';
    section.style.cssText = 'margin-top:12px;padding:8px 0;border-top:1px solid #1a2a1a;';

    const title = document.createElement('div');
    title.style.cssText = 'color:#44ffcc;font-size:6px;letter-spacing:2px;margin-bottom:4px;';
    title.textContent = '── Intro Music';
    section.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#556655;font-size:4px;letter-spacing:1px;margin-bottom:8px;line-height:1.8;';
    hint.textContent = 'Upload MP3/WAV/OGG (max 2 MB, max 30 sec) to replace the main menu jingle.';
    section.appendChild(hint);

    const row = document.createElement('div');
    row.style.cssText = `
      display:flex;align-items:center;gap:6px;
      background:${hasMod ? '#0d1a18' : '#0d0d0d'};
      border:1px solid ${hasMod ? '#226655' : '#1a1a1a'};
      padding:6px 8px;
    `;

    // Icon
    const icon = document.createElement('div');
    icon.style.cssText = `font-size:14px;flex-shrink:0;color:${hasMod ? '#44ffcc' : '#333'};line-height:1;`;
    icon.textContent = '♫';
    row.appendChild(icon);

    // Label + status
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const lbl = document.createElement('div');
    lbl.style.cssText = 'color:#aaa;font-size:4px;letter-spacing:1px;';
    lbl.textContent = 'Menu Jingle';
    info.appendChild(lbl);
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `font-size:4px;letter-spacing:1px;color:${hasMod ? '#44ffcc' : '#333'};margin-top:2px;`;
    statusEl.textContent = hasMod ? '● CUSTOM' : '○ default';
    info.appendChild(statusEl);
    row.appendChild(info);

    // Preview button
    const previewBtn = document.createElement('button');
    previewBtn.style.cssText = `background:#111;color:#888;border:1px solid #333;
      padding:3px 5px;font-size:9px;cursor:pointer;flex-shrink:0;`;
    previewBtn.title = 'Preview';
    previewBtn.textContent = '▶';
    previewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        const src = hasMod ? this.mods.__introMusic__ : ORIGINAL_SRC;
        const a = new Audio(src);
        a.volume = 0.5;
        a.play().catch(() => {});
        setTimeout(() => { try { a.pause(); } catch(_){} }, 5000);
      } catch (_) {}
    });
    row.appendChild(previewBtn);

    // Action buttons
    const btnWrap = document.createElement('div');
    btnWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm,.flac,.m4a';
    fileInput.style.display = 'none';
    row.appendChild(fileInput);

    const uploadBtn = document.createElement('button');
    uploadBtn.style.cssText = `background:#0d2a22;color:#44ffcc;border:1px solid #226655;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    uploadBtn.textContent = '↑ LOAD';
    uploadBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      statusEl.style.color = '#ffdd44';
      statusEl.textContent = '● loading…';
      try {
        const dataUrl = await validateIntroMusicFile(file);
        this.mods.__introMusic__ = dataUrl;
        saveModsToStorage(this.mods);
        this._applyIntroMusicMod(dataUrl);
        // Update UI
        statusEl.style.color = '#44ffcc';
        statusEl.textContent = '● CUSTOM';
        row.style.background = '#0d1a18';
        row.style.borderColor = '#226655';
        icon.style.color = '#44ffcc';
        clearBtn.style.display = '';
        previewBtn.style.color = '#44ffcc';
      } catch (err) {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = '● error';
        const tip = document.createElement('div');
        tip.style.cssText = `position:fixed;z-index:99;background:#220000;color:#ff4444;
          border:1px solid #aa2222;padding:6px 8px;font-size:5px;letter-spacing:1px;
          font-family:'Press Start 2P','Courier New',monospace;max-width:220px;line-height:1.6;
          pointer-events:none;white-space:pre-wrap;`;
        tip.textContent = err;
        document.body.appendChild(tip);
        const rect = uploadBtn.getBoundingClientRect();
        tip.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
        tip.style.top  = `${rect.bottom + 4}px`;
        setTimeout(() => {
          statusEl.textContent = this.mods.__introMusic__ ? '● CUSTOM' : '○ default';
          statusEl.style.color = this.mods.__introMusic__ ? '#44ffcc' : '#333';
          if (tip.parentNode) tip.parentNode.removeChild(tip);
        }, 3500);
      }
      e.target.value = '';
    });

    btnWrap.appendChild(uploadBtn);

    const clearBtn = document.createElement('button');
    clearBtn.style.cssText = `background:#1a0a0a;color:#ff6644;border:1px solid #442222;
      padding:3px 6px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;
      display:${hasMod ? '' : 'none'};`;
    clearBtn.textContent = '✖ CLR';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete this.mods.__introMusic__;
      saveModsToStorage(this.mods);
      this._clearIntroMusicMod(ORIGINAL_SRC);
      statusEl.style.color = '#333';
      statusEl.textContent = '○ default';
      row.style.background = '#0d0d0d';
      row.style.borderColor = '#1a1a1a';
      icon.style.color = '#333';
      previewBtn.style.color = '#888';
      clearBtn.style.display = 'none';
    });
    btnWrap.appendChild(clearBtn);

    row.appendChild(btnWrap);
    section.appendChild(row);
    return section;
  }

  _buildFontSection() {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:10px;padding:8px 0;border-top:1px solid #1a2a1a;';

    const title = document.createElement('div');
    title.style.cssText = 'color:#ffaa44;font-size:6px;letter-spacing:2px;margin-bottom:8px;';
    title.textContent = '── Custom Web Font';
    section.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'color:#556655;font-size:4px;letter-spacing:1px;margin-bottom:6px;line-height:1.8;';
    hint.innerHTML =
      'Paste a Google Fonts CSS URL. After loading, the font will apply to the<br>' +
      'game HUD and overlays automatically — no extra steps needed.<br>' +
      '<span style="color:#4499aa;">Example: https://fonts.googleapis.com/css2?family=VT323&display=swap</span>';
    section.appendChild(hint);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:5px;align-items:center;flex-wrap:wrap;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'https://fonts.googleapis.com/css2?family=…';
    input.style.cssText = `flex:1;min-width:160px;background:#111;color:#88ffaa;
      border:1px solid #336633;padding:5px 6px;font-size:4px;letter-spacing:1px;
      font-family:'Courier New',monospace;outline:none;`;

    const loadBtn = document.createElement('button');
    loadBtn.style.cssText = `background:#1a3a1a;color:#44ff44;border:1px solid #336633;
      padding:5px 8px;font-size:4px;cursor:pointer;letter-spacing:1px;
      font-family:'Press Start 2P','Courier New',monospace;white-space:nowrap;`;
    loadBtn.textContent = '↑ LOAD FONT';

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'color:#444;font-size:4px;letter-spacing:1px;width:100%;margin-top:3px;';

    loadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = input.value.trim();
      if (!url) return;
      if (!url.startsWith('http')) { statusEl.style.color = '#ff4444'; statusEl.textContent = 'Must be a full https:// URL'; return; }
      const res = this._loadWebFont(url, null, true);
      if (res.ok) {
        // Apply font-family to main game HUD elements immediately
        this._applyFontToHUD(res.family);
        statusEl.style.color = '#44ff44';
        statusEl.textContent = `✓ "${res.family}" loaded & applied to HUD`;
        input.value = '';
        this._refreshFontList(fontListEl);
      } else {
        statusEl.style.color = '#ff4444';
        statusEl.textContent = `Error: ${res.err}`;
      }
    });

    row.appendChild(input);
    row.appendChild(loadBtn);
    section.appendChild(row);
    section.appendChild(statusEl);

    // Font list
    const fontListEl = document.createElement('div');
    fontListEl.style.cssText = 'margin-top:6px;';
    this._refreshFontList(fontListEl);
    section.appendChild(fontListEl);

    return section;
  }

  /** Apply a loaded font-family to the game HUD elements */
  _applyFontToHUD(family) {
    // Store globally so canvas drawing functions can pick it up
    window.__modFont__ = `'${family}', 'Press Start 2P', monospace`;
    // Apply to all HUD and overlay elements that use the Press Start 2P font
    const hudSelectors = ['#hud', '#console-log', '.btn', '#game-container'];
    for (const sel of hudSelectors) {
      const el = document.querySelector(sel);
      if (el) el.style.fontFamily = window.__modFont__;
    }
    // Also apply globally to the container so inherited elements pick it up
    const container = document.getElementById('game-container');
    if (container) container.style.fontFamily = window.__modFont__;
  }

  /** Reset font back to default Press Start 2P (called on clear/reset) */
  _resetFontToDefault() {
    window.__modFont__ = `'Press Start 2P', 'Courier New', monospace`;
    const defaultFont = window.__modFont__;
    const hudSelectors = ['#hud', '#console-log', '.btn', '#game-container'];
    for (const sel of hudSelectors) {
      const el = document.querySelector(sel);
      if (el) el.style.fontFamily = defaultFont;
    }
    const container = document.getElementById('game-container');
    if (container) container.style.fontFamily = defaultFont;

    // Simulate http:// being typed then cleared in the font input box
    const fontInput = document.querySelector('#mod-editor-panel input[type="text"]');
    if (fontInput) {
      fontInput.value = 'http://';
      setTimeout(() => { fontInput.value = ''; }, 80);
    }
  }

  _refreshFontList(container) {
    container.innerHTML = '';
    const fonts = this.mods.__fonts__ || [];
    if (!fonts.length) return;
    const header = document.createElement('div');
    header.style.cssText = 'color:#446644;font-size:4px;letter-spacing:1px;margin-bottom:4px;';
    header.textContent = 'Loaded fonts:';
    container.appendChild(header);

    for (let i = 0; i < fonts.length; i++) {
      const f = fonts[i];
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';
      const nameLbl = document.createElement('span');
      nameLbl.style.cssText = 'color:#88ffaa;font-size:4px;letter-spacing:1px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nameLbl.textContent = f.family || f.url;
      item.appendChild(nameLbl);

      const removeBtn = document.createElement('button');
      removeBtn.style.cssText = `background:#1a0a0a;color:#ff6644;border:1px solid #442222;
        padding:2px 5px;font-size:4px;cursor:pointer;
        font-family:'Press Start 2P','Courier New',monospace;`;
      removeBtn.textContent = '✖';
      const capturedI = i;
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const arr = this.mods.__fonts__ || [];
        arr.splice(capturedI, 1);
        this.mods.__fonts__ = arr;
        saveModsToStorage(this.mods);
        this._refreshFontList(container);
        // If no fonts remain, reset HUD font to default
        if (!arr.length) this._resetFontToDefault();
      });
      item.appendChild(removeBtn);
      container.appendChild(item);
    }
  }

  _getLiveImage(slot) {
    if (slot.target === 'hatBrim') return this.refs.hatBrimImgRef;
    if (slot.target === 'assets') return this.refs.assets[slot.key];
    if (slot.target === 'weaponSprites') return this.refs.weaponSprites[slot.key];
    return null;
  }

  // ── Reset all mods ───────────────────────────────────────────────────────────

  _resetAllMods() {
    // Use a fixed overlay so it floats above everything without affecting panel layout
    const confirmDiv = document.createElement('div');
    confirmDiv.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.75);z-index:9999;
    `;

    const box = document.createElement('div');
    box.style.cssText = `background:#0a0a0a;border:2px solid #ff4444;padding:20px 24px;
      font-family:'Press Start 2P','Courier New',monospace;text-align:center;`;
    box.innerHTML = `
      <div style="color:#ff4444;font-size:7px;letter-spacing:2px;margin-bottom:12px;">RESET ALL MODS?</div>
      <div style="color:#888;font-size:5px;letter-spacing:1px;margin-bottom:14px;">Removes all custom images, sounds & fonts.</div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button id="_mod-confirm-yes" style="background:#440000;color:#ff4444;border:1px solid #aa2222;padding:6px 14px;font-size:5px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;">✓ YES</button>
        <button id="_mod-confirm-no"  style="background:#001100;color:#44ff44;border:1px solid #226622;padding:6px 14px;font-size:5px;cursor:pointer;font-family:'Press Start 2P','Courier New',monospace;">✗ NO</button>
      </div>`;
    confirmDiv.appendChild(box);
    document.body.appendChild(confirmDiv);

    const dismiss = () => {
      if (confirmDiv.parentNode) confirmDiv.parentNode.removeChild(confirmDiv);
    };

    box.querySelector('#_mod-confirm-no').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
    });

    box.querySelector('#_mod-confirm-yes').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
      this._doResetAllMods();
    });

    // Click outside box to cancel
    confirmDiv.addEventListener('click', (e) => {
      if (e.target === confirmDiv) dismiss();
    });
  }

  _doResetAllMods() {
    // Restore all live images to original URLs
    const slots = this._getSlots();
    for (const slot of slots) {
      if (this.mods[slot.id]) {
        this._clearMod(slot);
      }
    }

    // Clear all custom anim frames
    for (const key of Object.keys(customAnimFrames)) {
      customAnimFrames[key].walk   = [null, null];
      customAnimFrames[key].attack = [null, null, null];
    }

    // Clear all custom SFX
    for (const key of Object.keys(customSfx)) {
      delete customSfx[key];
    }

    // Clear intro music mod — restore original jingle src
    if (this.mods.__introMusic__) {
      const ORIGINAL_SRC = 'https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/d7eb80a7-ff8e-4ac3-86e2-c556c89b37c9/12c7a027-0f7c-40be-9158-7f5fdf5c26d2.mp3';
      this._clearIntroMusicMod(ORIGINAL_SRC);
    }

    this.mods = {};
    saveModsToStorage({});

    // Reset HUD font back to default Press Start 2P
    this._resetFontToDefault();

    // Rebuild the body in-place (panel stays in DOM, just refresh content)
    const body = document.getElementById('mod-editor-body');
    if (body) this._buildBody(body);
  }

  // ── Show / hide ─────────────────────────────────────────────────────────────

  show(onBackFn) {
    this._onBack = onBackFn;
    const panel = this.buildPanel();
    panel.style.display = 'flex';
  }

  hide() {
    if (this._panel) this._panel.style.display = 'none';
    if (typeof this._onBack === 'function') this._onBack();
  }
}
