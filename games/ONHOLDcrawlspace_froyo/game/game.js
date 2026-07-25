/**
 * game.js — Froyo Engine main orchestrator (Spec Sections V, XII)
 *
 *   Drives the state resolution pipeline + state machine:
 *
 *     MENU → GAMEPLAY → PAUSE / INTERMISSION / GAME_OVER
 *
 *   Per-frame in GAMEPLAY:
 *     1. Sample input
 *     2. Bitwise update (state.js)
 *     3. Discrete resolution (state.js)
 *     4. LUT execution: physics → camera → breath → enemies
 *     5. Render: sky → world geo (depth sorted) → particles → HUD
 */
import { InputController, BTN_FLAGS } from "../engine/input.js";
import { resolveBitwise, resolveDiscrete, STATE } from "../engine/state.js";
import { generateWorld, stepMovingPlatforms } from "./world.js";
import { createCamera, updateCamera, castLookRay } from "../engine/camera.js";
import { getSkyPalette } from "./skypalette.js";

import {
    setSkyPalette
} from "../engine/renderer.js";
import { stepPhysics } from "./physics.js";
import { createBreathSystem, fireBreath, stepBreath, stepBreakables } from "./breath.js";
import { createTransition, tryPortal, stepTransition, transitionWarpAmount } from "./portal.js";
import { loadSave, writeSave, downloadFroyoFile } from "../data/persistence.js";
import { sceneDataToWorld } from "../tools/mapgen-export.js";
import {
  createRenderer, clearSky, present,
  buildCube, buildTrapezoid, buildTriPrism, buildOrientedPlank,
  buildFace, buildBillboard, drawPixelW,
  buildVoidPlane, buildIslandTaper,
  buildTree, buildPine, buildSpire, buildMushroom, buildCactus, buildGemstone, buildLantern,
  drawTriangle as drawTri,
  drawTexturedTriangle as drawTexturedTri,
  project as projectVertex,
  rgba,
  drawRect, drawText,
} from "../engine/renderer.js";
import { createHUD, drawHUD, drawCenterPanel, tickHUD, notifySprinkles, notifyLives, flashMessage } from "./hud.js";
import { MOVE } from "../engine/luts.js";
// frustum culling removed — back-face culling only
import {
  threeReady, loadGLBMesh, loadGLBMeshIfAvailable, buildMeshTris, syncThreeCamera,
  precacheIslandColors, buildMeshTrisFromCache,
} from "../engine/geometry.js";
import { stepEnemyAI, projectiles, resetProjectiles } from "./enemyai.js";
import { loadIslandAtlas, getAtlasProgress, isAtlasReady, findIslandModelById } from "./islandatlas.js";
import {
  sfxJump, sfxDoubleJump, sfxIceBreath, sfxCrystalBreak, sfxCrateBreak,
  sfxEnemyFrozen, sfxEnemyDie, sfxPlayerHit, sfxEnemyShoot, sfxWind,
  sfxPortalOpen, sfxCollect, sfxLand,
  bgmStart, bgmStop, bgmSetVolume, bgmGetVolume,
  sfxSetVolume, sfxGetVolume,
} from "../engine/audio.js";
import { loadTexture } from "../engine/textureloader.js";
import { getBiomeTextures } from "./textureatlas.js";
const MODEL_BASE_URL = new URL("./models/", import.meta.url).href;

const DEFAULT_ISLAND_BIOME = "grass";
const DEFAULT_SKY_BIOME = "ice";

// Game-owned sky/level palettes. The engine only receives packed colors.
// This is intentionally light: authored maps can later set `levelBiome`/`biome`
// and the sky ring + fallback island colors will inherit from here.
const LEVEL_BIOME_PALETTES = {
  grass:     { top: rgba( 91, 141,  58), side: rgba( 90,  58,  42), biome: "grass" },
  ice:       { top: rgba(245, 250, 255), side: rgba( 74, 117, 200), biome: "ice" },
  sand:      { top: rgba(217, 191, 119), side: rgba( 90,  58,  26), biome: "sand" },
  bubblegum: { top: rgba(255, 153, 255), side: rgba(176,  80, 192), biome: "bubblegum" },
  jungle:    { top: rgba(128, 232, 128), side: rgba( 42, 106,  42), biome: "jungle" },
  golden:    { top: rgba(255, 176,  80), side: rgba(154,  90,  16), biome: "golden" },
  volcanic:  { top: rgba( 70,  60,  55), side: rgba(160,  55,  35), biome: "volcanic" },
};
LEVEL_BIOME_PALETTES.default = LEVEL_BIOME_PALETTES[DEFAULT_ISLAND_BIOME];

const GAMESTATE = {
  LOADING: "LOADING",
  MENU: "MENU",
  SETTINGS: "SETTINGS",
  GAMEPLAY: "GAMEPLAY",
  PAUSE: "PAUSE",
  INTERMISSION: "INTERMISSION",
  GAME_OVER: "GAME_OVER",
};

const FROZEN_TINT = rgba(180, 230, 255);
const PLAYER_TOP  = rgba(245, 110, 90);   // warm head
const PLAYER_BOT  = rgba(250, 200, 110);  // body
const CRYSTAL_C   = rgba(120, 240, 255);

const ADJ_EPS = 0.2;

function overlap1D(minA, maxA, minB, maxB) {
  return minA < maxB - ADJ_EPS && maxA > minB + ADJ_EPS;
}

function covers1D(minA, maxA, minB, maxB) {
  return minB <= minA + ADJ_EPS && maxB >= maxA - ADJ_EPS;
}

function hasAdjacentFace(block, blocks, axis, dir) {
  const minA = [block.wx - block.sx, block.wy - block.sy, block.wz - block.sz];
  const maxA = [block.wx + block.sx, block.wy + block.sy, block.wz + block.sz];

  for (const other of blocks) {
    if (other === block) continue;
    if (other.sx === undefined || other.sy === undefined || other.sz === undefined) continue;
    if (other.shape || other._axisNX !== undefined) continue;

    const minB = [other.wx - other.sx, other.wy - other.sy, other.wz - other.sz];
    const maxB = [other.wx + other.sx, other.wy + other.sy, other.wz + other.sz];
    const faceA = dir > 0 ? maxA[axis] : minA[axis];
    const faceB = dir > 0 ? minB[axis] : maxB[axis];
    if (Math.abs(faceA - faceB) > ADJ_EPS) continue;

    const axes = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    if (covers1D(minA[axes[0]], maxA[axes[0]], minB[axes[0]], maxB[axes[0]]) &&
        covers1D(minA[axes[1]], maxA[axes[1]], minB[axes[1]], maxB[axes[1]])) {
      return true;
    }
  }
  return false;
}

function shadeFace(c, brightness) {
  const r = Math.min(255, ((c & 0xff) * brightness)) | 0;
  const g = Math.min(255, (((c >>> 8) & 0xff) * brightness)) | 0;
  const b = Math.min(255, (((c >>> 16) & 0xff) * brightness)) | 0;
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

function buildCubeWithAdjacency(block, camera, blocks) {
  const cx = block.wx;
  const cy = block.wy;
  const cz = block.wz;
  const sx = block.sx;
  const sy = block.sy;
  const sz = block.sz;
  const topColor = block.top;
  const sideColor = block.side;

  const corners = [
    { x: cx - sx, y: cy + sy, z: cz - sz }, // 0 top NW
    { x: cx + sx, y: cy + sy, z: cz - sz }, // 1 top NE
    { x: cx + sx, y: cy + sy, z: cz + sz }, // 2 top SE
    { x: cx - sx, y: cy + sy, z: cz + sz }, // 3 top SW
    { x: cx - sx, y: cy - sy, z: cz - sz }, // 4 bot NW
    { x: cx + sx, y: cy - sy, z: cz - sz }, // 5 bot NE
    { x: cx + sx, y: cy - sy, z: cz + sz }, // 6 bot SE
    { x: cx - sx, y: cy - sy, z: cz + sz }, // 7 bot SW
  ];

  const sideN = shadeFace(sideColor, 0.85);
  const sideE = shadeFace(sideColor, 0.70);
  const sideS = shadeFace(sideColor, 0.55);
  const sideW = shadeFace(sideColor, 0.85);

  const camDx = camera.x - cx;
  const camDy = camera.y - cy;
  const camDz = camera.z - cz;

  const quads = [
    { idxs: [0, 1, 2, 3], color: topColor, nx: 0, ny: 1, nz: 0, axis: 1, dir: 1 },
    { idxs: [4, 0, 1, 5], color: sideN,  nx: 0, ny: 0, nz: -1, axis: 2, dir: -1 },
    { idxs: [5, 1, 2, 6], color: sideE,  nx: 1, ny: 0, nz: 0, axis: 0, dir: 1 },
    { idxs: [6, 2, 3, 7], color: sideS,  nx: 0, ny: 0, nz: 1, axis: 2, dir: 1 },
    { idxs: [7, 3, 0, 4], color: sideW,  nx: -1, ny: 0, nz: 0, axis: 0, dir: -1 },
  ];

  const tris = [];
  for (const face of quads) {
    if (hasAdjacentFace(block, blocks, face.axis, face.dir)) continue;
    const dot = camDx * face.nx + camDy * face.ny + camDz * face.nz;
    if (dot <= 0) continue;
    const pts = face.idxs.map(i => corners[i]);
    for (const tri of buildFace(pts, face.color, camera)) tris.push(tri);
  }
  return tris;
}
const CRYSTAL_S   = rgba(60, 140, 200);
const ENEMY_TOP   = rgba(80, 60, 60);
const ENEMY_BOT   = rgba(120, 80, 80);
const PORTAL_C    = rgba(255, 80, 220);
const PORTAL_S    = rgba(110, 30, 150);
const SHADOW_C    = rgba(20, 16, 30);
const PARTICLE_C  = rgba(200, 240, 255);

export class FroyoGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = createRenderer(canvas);
    this.input = new InputController();
    this.camera = createCamera();
    this.breath = createBreathSystem();
    this.transition = createTransition();
    this.save = loadSave();
    this.hud = createHUD();
    this.hud.sprinkles = this.save.sprinkles;
    this.hud.lives = this.save.lives;

    this.world = generateWorld(Date.now());
    this._levelBiome = this._resolveLevelBiome(this.world);
    this._levelSkyBiome =
    this.world?.meta?.skyBiome ||
    "ice";

    setSkyPalette(

    getSkyPalette(
        this._levelSkyBiome
    )

    );
    this._applyLevelBiomeDefaults(this.world);
    this.player = this._newPlayer(this.world.spawn);

    // Apply persisted audio settings immediately
    sfxSetVolume(this.save.fxVolume  ?? 0.8);
    bgmSetVolume(this.save.bgmVolume ?? 0.55);

    this.gameState = GAMESTATE.LOADING;
    this.frame = 0;
    this.menuChoice = 0; // 0 = Start, 1 = Settings, 2 = Load Map, 3 = Save, 4 = Reset
    this.debugOpen = false;
    this.onRequestLoadMap = null;
    this._running = false;
    this._lastDebugLines = [];

    // Island geometry precache: Map from platform → { buf, triCount }
    // Built once after atlas loads for all non-moving GLB islands.
    this._islandCache = new Map();
    this._geomCacheReady = false;
    this._geomCacheProgress = 0; // 0..1

    // Snapshot stored on transition out / pause for INTERMISSION restore
    this._snapshot = null;
    this._windNotified = false;

    // Kick off Three.js loading for GLB meshes.
    // World geometry uses pure-JS builders in renderer.js — no Three.js needed.

    // Three.js GLB mesh data for the player character.
    // Null until the async GLB load resolves; falls back to billboard until ready.
    this._froyoMesh = null;
    this._loadFroyoMesh();

    // Red cherry — rendered at the player's front muzzle (replaces red cube pip)
    this._cherryMesh      = null;
    this._cherryScale     = 1;
    this._cherryLocalCY   = 0;
    this._loadCherryMesh();

    // Sun with sunglasses — rendered as the enemy model
    this._sunMesh         = null;
    this._sunScale        = 1;
    this._sunLocalCY      = 0;
    this._loadSunMesh();

    // SkyDome + SkyboxRing — encompass the perimeter of the level,
    // parallax rotate with camera (yaw-locked to camera).
    this._skyDomeMesh   = null;
    this._skyDomeScale  = 1;
    this._skyRingMesh   = null;
    this._skyRingScale  = 1;
    this._loadSkyMeshes();

    // Bridge GLB — each bridge connection between islands uses this model
    this._bridgeMesh    = null;
    this._bridgeScale   = 1;
    this._loadBridgeMesh();

    // Biome terrain textures. The game resolves URLs; the engine only samples
    // CPU texture objects passed through triangle metadata.
    this._biomeTextures = new Map();
    this._loadBiomeTerrainTextures();

    this._manualWorldLoaded = false;

    // Kick off island atlas loading. When done, regenerate world or resolve
    // an imported world, then precache island geometry and transition to menu.
    loadIslandAtlas()
      .then(() => {
        if (this._manualWorldLoaded) {
          console.log("[game] Atlas ready — resolving imported world GLB references.");
          this._resolveWorldGLBReferences(this.world);
        } else {
          this.world = generateWorld(Date.now());
          this._levelBiome = this._resolveLevelBiome(this.world);
          this._applyLevelBiomeDefaults(this.world);
          this.player = this._newPlayer(this.world.spawn);
          console.log("[game] Atlas ready — world regenerated with GLB island shapes.");
        }
        this._runGeomPrecache();
      })
      .catch(err => {
        console.warn("[islandatlas] Load error:", err);
        // Still allow transition to menu even if atlas failed
        if (this.gameState === GAMESTATE.LOADING) this.gameState = GAMESTATE.MENU;
      });

    this.tick = this.tick.bind(this);
  }

  _newPlayer(spawn) {
    const sx = spawn ? spawn.x : 0;
    const sy = spawn ? spawn.y : 0.6;
    const sz = spawn ? spawn.z : 0;
    return {
      x: sx, y: sy, z: sz,
      vx: 0, vy: 0, vz: 0,
      yaw: 0,
      yawVel: 0,
      _prevYaw: 0,
      // Squash & stretch: positive = stretched (rising), negative = squashed
      // (just landed). Decays toward 0 each frame.
      squash: 0,
      _wasGrounded: false,
      state: STATE.NONE,
      grounded: false,
      // jumpTokens: 2 = both jumps available, 1 = first spent, 0 = both spent.
      // Restored to 2 on landing. Replaces canDoubleJump + hasDoubleJumped.
      jumpTokens: 2,
      _wantJump: false,
      _glideArmed: false,
      hitT: 0,
      animT: 0,
    };
  }

  _resolveLevelBiome(world = null, sceneData = null) {
    const raw =
      sceneData?.mapgen?.levelBiome ??
      sceneData?.mapgen?.biome ??
      sceneData?.levelBiome ??
      sceneData?.biome ??
      sceneData?.meta?.levelBiome ??
      sceneData?.meta?.biome ??
      world?.levelBiome ??
      world?.biome ??
      null;

    if (!raw) return null;
    const biome = String(raw);
    return LEVEL_BIOME_PALETTES[biome] ? biome : null;
  }

  _getLevelBiomePalette(biome = this._levelBiome) {
    return LEVEL_BIOME_PALETTES[biome] || LEVEL_BIOME_PALETTES.default;
  }

  _getSkyBiome() {
    return this._levelBiome || DEFAULT_SKY_BIOME;
  }

  _getPlatformBiome(p) {
    return p?.biome || this._levelBiome || DEFAULT_ISLAND_BIOME;
  }

  _getPlatformPalette(p) {
    const biome = this._getPlatformBiome(p);
    const base = this._getLevelBiomePalette(biome);
    return {
      top:  (typeof p?.color === "number" && Number.isFinite(p.color)) ? p.color : base.top,
      side: (typeof p?.side  === "number" && Number.isFinite(p.side))  ? p.side  : base.side,
      biome,
    };
  }

  _applyLevelBiomeDefaults(world) {
    if (!world) return;
    world.levelBiome = this._levelBiome || DEFAULT_ISLAND_BIOME;
    if (!Array.isArray(world.platforms)) return;
    for (const p of world.platforms) {
      if (!p.biome) p.biome = world.levelBiome;
    }
  }

  _getSkyPalette() {
    // Sky has its own default: ice/snow. Authored levels can override by setting
    // levelBiome/biome, while untagged islands still fall back to grass.
    const skyBiome = this._getSkyBiome();
    const base = this._getLevelBiomePalette(skyBiome);
    const tex = this._getBiomeTextureTable(skyBiome);
    return {
      ...base,
      biome: skyBiome,
      textureTop: tex?.top || null,
      textureSide: tex?.side || tex?.top || null,
      textureUnder: tex?.under || null,
      textureScale: 0.035,
    };
  }

  // Async geometry precache — called after atlas + world are ready.
  // Iterates through all non-moving GLB island platforms and builds a
  // precacheIslandColors buffer for each. Runs over multiple microtask slices
  // to avoid blocking the main thread during the loading screen.
  _resolveWorldGLBReferences(world) {
    if (!world || !Array.isArray(world.platforms)) return;
    for (const p of world.platforms) {
      if (!p.glbModel && p.glbName) {
        const model = findIslandModelById(p.glbName);
        if (model) p.glbModel = model;
      }
    }
  }

  loadWorldFromSceneData(sceneData) {
    const world = sceneDataToWorld(sceneData);
    if (!world) return false;
    this.world = world;
    this._levelBiome = this._resolveLevelBiome(this.world, sceneData);
    this._applyLevelBiomeDefaults(this.world);
    this.player = this._newPlayer(this.world.spawn);
    this._manualWorldLoaded = true;
    this._islandCache.clear();
    this._geomCacheReady = false;
    this._geomCacheProgress = 0;
    this._resolveWorldGLBReferences(this.world);
    if (isAtlasReady()) {
      this._runGeomPrecache();
    }
    return true;
  }

  async _runGeomPrecache() {
    const platforms = this.world.platforms;
    const glbPlatforms = platforms.filter(p => p.glbModel && !p.moving);
    const total = glbPlatforms.length;
    this._geomCacheReady = false;
    this._geomCacheProgress = 0;

    for (let i = 0; i < total; i++) {
      const p = glbPlatforms[i];
      // Yield to browser every 3 platforms so the loading screen can animate
      if (i > 0 && i % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
      try {
        let modelScale = (typeof p.glbModel.scale === 'number' && isFinite(p.glbModel.scale)) ? p.glbModel.scale : 1.0;
        if (typeof p.glbModel.scale !== 'number' || !isFinite(p.glbModel.scale)) {
          console.warn('[scale] missing/invalid glbModel.scale for platform', p.glbName || p.id || p.name || null, ' — defaulting to 1.0');
          modelScale = 1.0;
        }
        const effectiveScale = modelScale * (p.glbScaleMul ?? 1.0);
        const cache = precacheIslandColors(
          p.glbModel.meshData,
          effectiveScale,
          0,  // islands have no yaw rotation
          this._getPlatformPalette(p)
        );
        this._islandCache.set(p, cache);
      } catch (e) {
        console.warn("[precache] failed for platform", i, e);
      }
      this._geomCacheProgress = (i + 1) / total;
    }

    this._geomCacheReady = true;
    console.log(`[precache] Done — ${this._islandCache.size} island caches built.`);
    // Transition to main menu
    if (this.gameState === GAMESTATE.LOADING) this.gameState = GAMESTATE.MENU;
  }

  async _loadBiomeTerrainTextures() {
    const biomeNames = [
      "default",
      "grass",
      "ice",
      "sand",
      "bubblegum",
      "jungle",
      "golden",
      "volcanic",
    ];

    const loadZone = async (url) => {
      if (!url) return null;
      try {
        const resolved = new URL(url, import.meta.url).href;
        return await loadTexture(resolved, { wrap: true });
      } catch (err) {
        console.warn("[texture] biome texture failed — color fallback remains active:", url, err);
        return null;
      }
    };

    for (let i = 0; i < biomeNames.length; i++) {
      const biome = biomeNames[i];
      const zones = getBiomeTextures(biome);
      if (!zones) continue;
      const table = {
        top:    await loadZone(zones.top),
        side:   await loadZone(zones.side),
        under:  await loadZone(zones.under),
        accent: await loadZone(zones.accent),
      };
      this._biomeTextures.set(biome, table);
    }

    console.log("[texture] biome terrain tables loaded", this._biomeTextures.size);
  }

  _getBiomeTextureTable(biome) {
    return this._biomeTextures.get(biome) || this._biomeTextures.get("default") || null;
  }

  // Async GLB loader — fires once at construction. On success, sets
  // this._froyoMesh; on failure, logs and leaves it null so the billboard
  // fallback keeps rendering without breaking the game.
  async _loadFroyoMesh() {
    // frozen_yogurt_bowl_3d_model asset uploaded by user
    const GLB_URL = `${MODEL_BASE_URL}froyo_body_model.glb`;
    try {
      await threeReady();
      const mesh = await loadGLBMeshIfAvailable(GLB_URL, "Froyo body model");
      if (!mesh) return;

      // ── Auto-normalize the GLB to player scale ──────────────────────────
      // Compute bounding box of the raw mesh so we can fit it to the
      // physics player height (1.0 world units, feet at player.y - 0.5).
      const verts = mesh.vertices;
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < verts.length; i += 3) {
        const vx = verts[i], vy = verts[i+1], vz = verts[i+2];
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }
      const rawH  = maxY - minY;          // model's native height
      const rawCY = (minY + maxY) * 0.5;  // model's vertical center in local space
      const rawCX = (minX + maxX) * 0.5;
      const rawCZ = (minZ + maxZ) * 0.5;

      // Target height = 1.0 world units (player billboard height).
      // We'll scale the model so it fills exactly that height.
      const TARGET_H = 1.0;
      const autoScale = rawH > 0.0001 ? TARGET_H / rawH : 1.0;

      // After scaling, the model's bottom is at:  rawCY * autoScale - TARGET_H*0.5
      // We want the bottom to sit at player.y - 0.5 (feet).
      // So the worldY offset we pass to buildMeshTris must be:
      //   player.y - 0.5 - (rawCY * autoScale - TARGET_H * 0.5)
      //   = player.y - 0.5 - rawCY * autoScale + TARGET_H * 0.5
      //   = player.y - rawCY * autoScale               (since -0.5 + 0.5 = 0)
      // We store the "centre-offset" so the render call can simply do:
      //   worldY = player.y - _meshCentreOffY
      this._meshAutoScale   = autoScale;
      this._meshCentreOffY  = rawCY * autoScale;  // subtract from player.y to get worldY
      this._meshCentreOffX  = rawCX * autoScale;  // lateral centering
      this._meshCentreOffZ  = rawCZ * autoScale;

      // Store raw local-space center on the mesh so buildMeshTris can subtract
      // it before rotating — ensures yaw rotates around the model's own center.
      mesh.localCX = rawCX;
      mesh.localCY = rawCY;
      mesh.localCZ = rawCZ;

      // Front-pip Y: place the muzzle at ~40% up the model (torso level)
      // In world space: player.y - _meshCentreOffY + (minY + rawH*0.4) * autoScale
      this._meshMuzzleY = -this._meshCentreOffY + (minY + rawH * 0.4) * autoScale;

      this._froyoMesh = mesh;
      console.log("[geometry] Froyo GLB loaded —",
        "verts:", mesh.vertices.length / 3,
        "| tris:", mesh.indices.length / 3,
        "| hasColors:", !!mesh.colors,
        "| autoScale:", autoScale.toFixed(3),
        "| centreOffY:", this._meshCentreOffY.toFixed(3));
    } catch (err) {
      console.warn("[geometry] GLB load failed — using billboard fallback:", err);
    }
  }

  // Async loader for the red cherry (muzzle pip replacement)
  async _loadCherryMesh() {
    const GLB_URL = `${MODEL_BASE_URL}cherry.glb`;
    try {
      await threeReady();
      const mesh = await loadGLBMeshIfAvailable(GLB_URL, "Cherry model");
      if (!mesh) return;
      const verts = mesh.vertices;
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < verts.length; i += 3) {
        const vx = verts[i], vy = verts[i+1], vz = verts[i+2];
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }
      const rawH = maxY - minY;
      mesh.localCX = (minX + maxX) * 0.5;
      mesh.localCY = (minY + maxY) * 0.5;
      mesh.localCZ = (minZ + maxZ) * 0.5;
      // Scale cherry to fit in a 0.38-unit cube (same size as the old pip)
      const TARGET_H = 0.38;
      this._cherryScale = rawH > 0.0001 ? TARGET_H / rawH : 1.0;
      this._cherryMesh  = mesh;
      console.log("[geometry] Cherry GLB loaded — verts:", mesh.vertices.length / 3, "scale:", this._cherryScale.toFixed(3));
    } catch (err) {
      console.warn("[geometry] Cherry GLB load failed — using cube pip fallback:", err);
    }
  }

  // Async loader for the sun-with-sunglasses (enemy model)
  async _loadSunMesh() {
    const GLB_URL = `${MODEL_BASE_URL}sun_enemy_model.glb`;
    try {
      await threeReady();
      const mesh = await loadGLBMeshIfAvailable(GLB_URL, "Sun enemy model");
      if (!mesh) return;
      const verts = mesh.vertices;
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < verts.length; i += 3) {
        const vx = verts[i], vy = verts[i+1], vz = verts[i+2];
        if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
        if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
      }
      const rawH = maxY - minY;
      mesh.localCX = (minX + maxX) * 0.5;
      mesh.localCY = (minY + maxY) * 0.5;
      mesh.localCZ = (minZ + maxZ) * 0.5;
      // Scale sun to match regular enemy display size (~2.8 world units tall)
      const TARGET_H = 2.8;
      this._sunScale      = rawH > 0.0001 ? TARGET_H / rawH : 1.0;
      // Boss sun is 2.5× bigger than regular enemy
      this._sunScaleBoss  = this._sunScale * 2.5;
      this._sunMesh       = mesh;
      console.log("[geometry] Sun GLB loaded — verts:", mesh.vertices.length / 3, "scale:", this._sunScale.toFixed(3));
    } catch (err) {
      console.warn("[geometry] Sun GLB load failed — using billboard fallback:", err);
    }
  }

  // Async loader for SkyDome + SkyboxRing (perimeter sky shells)
  async _loadSkyMeshes() {
    const SKY_DOME_URL = `${MODEL_BASE_URL}skydome_model.glb`;
    const SKY_RING_URL = `${MODEL_BASE_URL}skyring_model.glb`;
    try {
      await threeReady();

      // SkyDome — large shell, scaled to encompass entire level (radius ~250 units)
      const domeMesh = await loadGLBMeshIfAvailable(SKY_DOME_URL, "Sky dome model");
      if (domeMesh) {
        const dv = domeMesh.vertices;
        let dMinY = Infinity, dMaxY = -Infinity, dMaxR = 0;
        for (let i = 0; i < dv.length; i += 3) {
          const x = dv[i], y = dv[i+1], z = dv[i+2];
          if (y < dMinY) dMinY = y; if (y > dMaxY) dMaxY = y;
          const r = Math.sqrt(x*x + z*z);
          if (r > dMaxR) dMaxR = r;
        }
        domeMesh.localCX = 0;
        domeMesh.localCY = (dMinY + dMaxY) * 0.5;
        domeMesh.localCZ = 0;
        const SKY_DOME_RADIUS = 260;
        this._skyDomeScale = dMaxR > 0.001 ? SKY_DOME_RADIUS / dMaxR : 1;
        this._skyDomeMesh = domeMesh;
        console.log("[geometry] SkyDome loaded — scale:", this._skyDomeScale.toFixed(2));
      }

      // SkyboxRing — slightly smaller (0.82× of dome radius)
      const ringMesh = await loadGLBMeshIfAvailable(SKY_RING_URL, "Sky ring model");
      if (ringMesh) {
        const rv = ringMesh.vertices;
        let rMinY = Infinity, rMaxY = -Infinity, rMaxR = 0;
        for (let i = 0; i < rv.length; i += 3) {
          const x = rv[i], y = rv[i+1], z = rv[i+2];
          if (y < rMinY) rMinY = y; if (y > rMaxY) rMaxY = y;
          const r = Math.sqrt(x*x + z*z);
          if (r > rMaxR) rMaxR = r;
        }
        ringMesh.localCX = 0;
        ringMesh.localCY = (rMinY + rMaxY) * 0.5;
        ringMesh.localCZ = 0;
        const SKY_RING_RADIUS = 260 * 0.82;
        this._skyRingScale = rMaxR > 0.001 ? SKY_RING_RADIUS / rMaxR : 1;
        this._skyRingMesh = ringMesh;
        console.log("[geometry] SkyboxRing loaded — scale:", this._skyRingScale.toFixed(2));
      }
    } catch (err) {
      console.warn("[geometry] Sky mesh load failed:", err);
    }
  }

  // Async loader for the bridge model
  async _loadBridgeMesh() {
    const BRIDGE_URL = `${MODEL_BASE_URL}bridge_model.glb`;
    try {
      await threeReady();
      const mesh = await loadGLBMeshIfAvailable(BRIDGE_URL, "Bridge model");
      if (!mesh) return;
      const bv = mesh.vertices;
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < bv.length; i += 3) {
        const x = bv[i], y = bv[i+1], z = bv[i+2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      mesh.localCX = (minX + maxX) * 0.5;
      mesh.localCY = (minY + maxY) * 0.5;
      mesh.localCZ = (minZ + maxZ) * 0.5;
      // Scale bridge so its Z length (forward axis) = 1 world unit;
      // we'll scale it per-connection at render time
      const rawLen = (maxZ - minZ);
      this._bridgeRawLen = rawLen > 0.001 ? rawLen : 1;
      this._bridgeMesh   = mesh;
      console.log("[geometry] Bridge GLB loaded — verts:", mesh.vertices.length / 3, "rawLen:", this._bridgeRawLen.toFixed(2));
    } catch (err) {
      console.warn("[geometry] Bridge GLB load failed — using plank fallback:", err);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(this.tick);
  }
  stop() {
    this._running = false;
    this.input.destroy();
    bgmStop();
  }

  // ---- State machine transitions ------------------------------------------
  _enterGameplay() {
    this.gameState = GAMESTATE.GAMEPLAY;
    // Snap camera target to player's initial yaw, then snap to target.
    this.camera.targetYaw = this.player.yaw;
    updateCamera(this.camera, this.player, MOVE.IDLE);
    this.camera.x = this.camera.targetX;
    this.camera.y = this.camera.targetY;
    this.camera.z = this.camera.targetZ;
    this.camera.yaw = this.camera.targetYaw;

    // Ensure imported worlds always have safe array defaults.
    this.world.enemies = Array.isArray(this.world.enemies) ? this.world.enemies : [];
    this.world.platforms = Array.isArray(this.world.platforms) ? this.world.platforms : [];
    this.world.breakables = Array.isArray(this.world.breakables) ? this.world.breakables : [];
    this.world.decorations = Array.isArray(this.world.decorations) ? this.world.decorations : [];
    this.world.windZones = Array.isArray(this.world.windZones) ? this.world.windZones : [];

    if (!this.world.spawn || typeof this.world.spawn.x !== 'number' || typeof this.world.spawn.y !== 'number' || typeof this.world.spawn.z !== 'number') {
      let maxY = 0;
      for (const p of this.world.platforms) {
        const topY = typeof p.y === 'number'
          ? p.y + (typeof p.sy === 'number' ? p.sy : 0)
          : 0;
        if (topY > maxY) maxY = topY;
      }
      this.world.spawn = { x: 0, y: maxY + 5.0, z: 0 };
    }
    if (!this.world.portal || typeof this.world.portal.x !== 'number' || typeof this.world.portal.y !== 'number' || typeof this.world.portal.z !== 'number') {
      this.world.portal = {
        x: 0,
        y: this.world.spawn.y,
        z: 0,
        target: { ...this.world.spawn },
        radius: 1.0,
      };
    } else if (!this.world.portal.target || typeof this.world.portal.target.x !== 'number') {
      this.world.portal.target = { ...this.world.spawn };
    }

    // Sync enemy / portal state on entry
    const alive = this.world.enemies.filter(e => !e.dead);
    this.hud.enemiesLeft = alive.length;
    this.hud.portalOpen  = alive.length === 0;
    flashMessage(this.hud, "SUNDAE ISLES", 90);
    // Start background music on first entry into gameplay
    bgmStart();
  }
  _enterPause() {
    this.gameState = GAMESTATE.PAUSE;
    this._pauseRow = 0;      // 0=Resume, 1=Settings, 2=Main Menu
    this._pausePrevAxisY = 0;
  }
  _resumeFromPause() { this.gameState = GAMESTATE.GAMEPLAY; }
  _enterGameOver() {
    this.gameState = GAMESTATE.GAME_OVER;
    bgmStop();
  }
  _resetGame() {
    this.world = generateWorld(Date.now());
    this._levelBiome = this._resolveLevelBiome(this.world);
    this._applyLevelBiomeDefaults(this.world);
    this.player = this._newPlayer(this.world.spawn);
    this.camera = createCamera();
    this.breath = createBreathSystem();
    this.transition = createTransition();
    this.hud.sprinkles = 0;
    this.hud.lives = 5;
    this.save.sprinkles = 0;
    this.save.lives = 5;
    writeSave(this.save);
    resetProjectiles();
    this._enterGameplay();
  }
  _respawn() {
    this.player = this._newPlayer(this.world.spawn);
  }

  // ---- Main tick ----------------------------------------------------------
  tick() {
    if (!this._running) return;
    this.input.sample();
    this.frame++;

    switch (this.gameState) {
      case GAMESTATE.LOADING:     this._tickLoading(); break;
      case GAMESTATE.MENU:        this._tickMenu(); break;
      case GAMESTATE.SETTINGS:    this._tickSettings(); break;
      case GAMESTATE.GAMEPLAY:    this._tickGameplay(); break;
      case GAMESTATE.PAUSE:       this._tickPause(); break;
      case GAMESTATE.INTERMISSION:this._tickIntermission(); break;
      case GAMESTATE.GAME_OVER:   this._tickGameOver(); break;
    }

    requestAnimationFrame(this.tick);
  }

  // ---- LOADING SCREEN -----------------------------------------------------
  // Dark screen with the froyo character bouncing in place. Two progress bars:
  // top = atlas download (7 island GLBs), bottom = geometry precache.
  _tickLoading() {
    const rd = this.renderer;
    const { buf32, depth } = rd;
    const SW = 320, SH = 200;

    // Black background
    buf32.fill(rgba(8, 5, 18));
    depth.fill(Infinity);

    // Bouncing player character — sinusoidal up/down
    const t = this.frame * 0.10;
    const jumpY = Math.abs(Math.sin(t)) * 28;   // 0..28 screen px
    const squishX = 1 + Math.abs(Math.cos(t)) * 0.18;
    const squishY = 1 - Math.abs(Math.cos(t)) * 0.18;

    // We render the character as simple colored rectangles in screen-space
    // (no 3D camera needed — just stamp directly into buf32).
    const charCX = SW >> 1;           // center X
    const charBaseY = 108;            // ground line
    const charScreenY = charBaseY - jumpY;

    // Shadow (shrinks as character rises)
    const shadowW = Math.max(3, (12 - jumpY * 0.3) | 0);
    const shadowH = 2;
    const shadowAlpha = Math.max(0.2, 1.0 - jumpY / 32);
    const shadowC = rgba(0, 0, 0);
    const shadowX = charCX - (shadowW >> 1);
    const shadowY = charBaseY + 3;
    for (let py = shadowY; py < shadowY + shadowH && py < SH; py++) {
      for (let px = shadowX; px < shadowX + shadowW && px < SW; px++) {
        if (px >= 0) buf32[py * SW + px] = shadowC;
      }
    }

    // Body — froyo pink/orange
    const bodyW = Math.max(2, (10 * squishX) | 0);
    const bodyH = Math.max(2, (14 * squishY) | 0);
    const bodyX = charCX - (bodyW >> 1);
    const bodyTopY = (charScreenY - bodyH) | 0;
    const bodyBotC = rgba(250, 190, 80);   // bottom warm orange
    const bodyTopC = rgba(245, 100, 130);  // top pink
    for (let py = bodyTopY; py < bodyTopY + bodyH && py < SH; py++) {
      if (py < 0) continue;
      const tBody = (py - bodyTopY) / Math.max(1, bodyH - 1);
      const rc = ((bodyBotC & 0xff) * tBody + (bodyTopC & 0xff) * (1 - tBody)) | 0;
      const gc = (((bodyBotC >>> 8) & 0xff) * tBody + ((bodyTopC >>> 8) & 0xff) * (1 - tBody)) | 0;
      const bc = (((bodyBotC >>> 16) & 0xff) * tBody + ((bodyTopC >>> 16) & 0xff) * (1 - tBody)) | 0;
      const rowC = rgba(rc, gc, bc);
      for (let px = bodyX; px < bodyX + bodyW && px < SW; px++) {
        if (px >= 0) buf32[py * SW + px] = rowC;
      }
    }

    // Eyes — two small white dots near the top
    const eyeY = (bodyTopY + 3) | 0;
    const eyeC = rgba(255, 255, 255);
    for (let ex = -2; ex <= 2; ex += 4) {
      const epx = charCX + ex;
      if (epx >= 0 && epx < SW && eyeY >= 0 && eyeY < SH) {
        buf32[eyeY * SW + epx] = eyeC;
        if (eyeY + 1 < SH) buf32[(eyeY + 1) * SW + epx] = eyeC;
      }
    }

    // Title
    const TITLE = "SUNDAE  ISLES";
    const titleW = TITLE.length * 5;
    drawText(rd, TITLE, (SW - titleW) >> 1, 18, rgba(255, 200, 230), 1);

    // Loading phase label
    const atlasReady = isAtlasReady();
    const atlasProgress = getAtlasProgress();
    const geomProgress = this._geomCacheProgress ?? 0;

    // Bar 1 — island assets download
    const bar1Y = charBaseY + 16;
    const barW = 120, barH = 4;
    const bar1X = (SW - barW) >> 1;
    drawText(rd, "LOADING ISLANDS", bar1X, bar1Y - 9, rgba(150, 200, 255), 1);
    drawRect(rd, bar1X, bar1Y, barW, barH, rgba(20, 15, 40));
    const fill1 = Math.max(1, (atlasProgress * barW) | 0);
    drawRect(rd, bar1X, bar1Y, fill1, barH, rgba(100, 200, 255));
    drawRect(rd, bar1X, bar1Y, barW, barH, rgba(60, 120, 200), false);

    // Bar 2 — geometry precache
    const bar2Y = bar1Y + 16;
    drawText(rd, "BAKING  GEOMETRY", bar1X, bar2Y - 9, rgba(150, 255, 180), 1);
    drawRect(rd, bar1X, bar2Y, barW, barH, rgba(20, 15, 40));
    const fill2 = Math.max(1, (geomProgress * barW) | 0);
    drawRect(rd, bar1X, bar2Y, fill2, barH, rgba(80, 220, 140));
    drawRect(rd, bar1X, bar2Y, barW, barH, rgba(40, 140, 80), false);

    // Dot-dot-dot animation
    const dots = ".".repeat(((this.frame >> 3) % 4));
    const hint = "PLEASE WAIT" + dots;
    const hintW = hint.length * 5;
    drawText(rd, hint, (SW - hintW) >> 1, SH - 10, rgba(100, 80, 140), 1);

    present(rd);
  }

  // ---- MENU ---------------------------------------------------------------
  _tickMenu() {
    const inp = this.input;
    const MENU_COUNT = 7; // Start, Settings, Load Map, Load Froyo, Save, Scene Editor, Reset
    // Vertical navigate
    if (inp.justPressed(BTN_FLAGS.B)) {
      this.menuChoice = (this.menuChoice + 1) % MENU_COUNT;
    }
    const prevAxisY = this._menuPrevAxisY ?? 0;
    const axisY     = inp.axisY;
    if (axisY > 0.4 && prevAxisY <= 0.4)  this.menuChoice = (this.menuChoice + 1) % MENU_COUNT;
    if (axisY < -0.4 && prevAxisY >= -0.4) this.menuChoice = (this.menuChoice + MENU_COUNT - 1) % MENU_COUNT;
    this._menuPrevAxisY = axisY;

    // Confirm
    if (inp.justPressed(BTN_FLAGS.A) || inp.justPressed(BTN_FLAGS.START)) {
      if (this.menuChoice === 0) {
        this._enterGameplay();
      } else if (this.menuChoice === 1) {
        this._enterSettings("MENU");
      } else if (this.menuChoice === 2) {
        if (typeof this.onRequestLoadMap === "function") {
          this.onRequestLoadMap();
        }
      } else if (this.menuChoice === 3) {
        if (typeof this.onRequestLoadFroyo === "function") {
          this.onRequestLoadFroyo();
        }
      } else if (this.menuChoice === 4) {
        this.save.sprinkles = this.hud.sprinkles;
        this.save.lives = this.hud.lives;
        writeSave(this.save);
        downloadFroyoFile(this.save);
      } else if (this.menuChoice === 5) {
        if (typeof this.onRequestSceneEditor === "function") {
          this.onRequestSceneEditor();
        }
      } else if (this.menuChoice === 6) {
        this._resetGame();
      }
    }
    // Render menu
    const rd = this.renderer;
    clearSky(rd, this.frame * 0.5, this.frame);
    const sel = i => (this.menuChoice === i ? "> " : "  ");
    drawCenterPanel(rd, [
      { text: "FROYO  ENGINE", scale: 2, color: rgba(255, 200, 220) },
      { text: "SUNDAE ISLES  V0.2", scale: 1, color: rgba(180, 220, 255) },
      { text: "",   scale: 1 },
      { text: sel(0) + "START GAME",    scale: 1 },
      { text: sel(1) + "SETTINGS",      scale: 1 },
      { text: sel(2) + "LOAD MAP",       scale: 1 },
      { text: sel(3) + "LOAD GAME",    scale: 1 },
      { text: sel(4) + "SAVE  GAME",   scale: 1 },
      { text: sel(5) + "SCENE EDITOR",  scale: 1 },
      { text: sel(6) + "RESET PROGRESS",scale: 1 },
      { text: "",   scale: 1 },
      { text: "A / SPACE: CONFIRM",    scale: 1, color: rgba(180, 180, 200) },
      { text: "B / K: CHANGE OPTION",  scale: 1, color: rgba(180, 180, 200) },
    ]);

    // ── Island atlas loading bar ─────────────────────────────────────────
    // Show while the 3 floating-island GLBs are being processed.
    // Disappears once atlas is fully ready.
    if (!isAtlasReady()) {
      const progress = getAtlasProgress();
      const SCREEN_W = 320, SCREEN_H = 200;
      const barW  = 120;
      const barH  = 5;
      const barX  = (SCREEN_W - barW) >> 1;
      const barY  = SCREEN_H - 18;

      const LABEL      = "LOADING ISLANDS...";
      const labelW     = LABEL.length * 5;
      const labelX     = (SCREEN_W - labelW) >> 1;
      const labelColor = rgba(150, 200, 255);
      drawText(rd, LABEL, labelX, barY - 8, labelColor, 1);

      const BG_COLOR   = rgba(30,  25, 55);
      const FILL_COLOR = rgba(100, 210, 255);
      const EDGE_COLOR = rgba(80,  160, 220);
      drawRect(rd, barX, barY, barW, barH, BG_COLOR);
      const fillW = Math.max(1, Math.round(progress * barW));
      drawRect(rd, barX, barY, fillW, barH, FILL_COLOR);
      drawRect(rd, barX, barY, barW, barH, EDGE_COLOR, false);

      // Animated fill shimmer — a 2-pixel-wide bright stripe that scrolls
      const shimX = barX + ((this.frame * 2) % barW);
      if (shimX < barX + fillW) {
        drawRect(rd, shimX, barY, 2, barH, rgba(200, 240, 255));
      }
    }

    present(rd);
  }

  // ---- SETTINGS (shared by main menu and pause) ---------------------------
  _enterSettings(returnTo = "MENU") {
    this._settingsReturnTo = returnTo; // "MENU" or "PAUSE"
    this._settingsRow  = 0;
    this._settingsFxVol  = sfxGetVolume();
    this._settingsBgmVol = bgmGetVolume();
    this._settingsHeld   = 0;
    this._settingsPrevAxisX = 0;
    this._settingsPrevAxisY = 0;
    this.gameState = GAMESTATE.SETTINGS;
  }

  _tickSettings() {
    const inp   = this.input;
    const ROWS  = 3; // 0=FX Vol, 1=Music Vol, 2=Back

    // Axis edge detect
    const prevY = this._settingsPrevAxisY ?? 0;
    const prevX = this._settingsPrevAxisX ?? 0;
    const axY   = inp.axisY;
    const axX   = inp.axisX;
    const justDown  = axY >  0.4 && prevY <=  0.4;
    const justUp    = axY < -0.4 && prevY >= -0.4;
    const justRight = axX >  0.4 && prevX <=  0.4;
    const justLeft  = axX < -0.4 && prevX >= -0.4;
    this._settingsPrevAxisY = axY;
    this._settingsPrevAxisX = axX;

    // Navigate rows
    if (justDown || inp.justPressed(BTN_FLAGS.B))  this._settingsRow = (this._settingsRow + 1) % ROWS;
    if (justUp)                                     this._settingsRow = (this._settingsRow + ROWS - 1) % ROWS;

    // Confirm / back — pressing Start always goes back; A on BACK row also goes back
    const confirmBack = inp.justPressed(BTN_FLAGS.START) ||
                        (inp.justPressed(BTN_FLAGS.A) && this._settingsRow === 2);
    if (confirmBack) {
      this._saveAudioSettings();
      this.gameState = this._settingsReturnTo === "PAUSE" ? GAMESTATE.PAUSE : GAMESTATE.MENU;
      return;
    }

    // Slider adjust with auto-repeat
    const hDir = axX > 0.4 ? 1 : axX < -0.4 ? -1 : 0;
    hDir !== 0 ? this._settingsHeld++ : (this._settingsHeld = 0);
    const fire = (justLeft || justRight) ||
                 this._settingsHeld === 1 ||
                 (this._settingsHeld > 20 && this._settingsHeld % 5 === 0);

    if (fire && hDir !== 0 && this._settingsRow < 2) {
      const step = 0.05;
      if (this._settingsRow === 0) {
        this._settingsFxVol = Math.max(0, Math.min(1, this._settingsFxVol + hDir * step));
        sfxSetVolume(this._settingsFxVol);
        sfxCollect();
      } else {
        this._settingsBgmVol = Math.max(0, Math.min(1, this._settingsBgmVol + hDir * step));
        bgmSetVolume(this._settingsBgmVol);
      }
    }

    // Render
    const rd = this.renderer;
    clearSky(rd, this.frame * 0.5, this.frame);
    this._drawSettingsPanel(false);
    present(rd);
  }

  _saveAudioSettings() {
    this.save.fxVolume  = sfxGetVolume();
    this.save.bgmVolume = bgmGetVolume();
    writeSave(this.save);
  }

  // ---- PAUSE --------------------------------------------------------------
  _tickPause() {
    const inp = this.input;
    const ROWS = 4; // 0=Resume, 1=Settings, 2=Main Menu, (no inline sliders — use Settings)

    // ── Edge-detect axis inputs ──────────────────────────────────────────────
    const prevAxisY = this._pausePrevAxisY ?? 0;
    const axisY     = inp.axisY;
    const justDown  = axisY >  0.4 && prevAxisY <=  0.4;
    const justUp    = axisY < -0.4 && prevAxisY >= -0.4;
    this._pausePrevAxisY = axisY;

    // ── Navigation (up/down) ──────────────────────────────────────────────
    if (justDown || inp.justPressed(BTN_FLAGS.B)) this._pauseRow = (this._pauseRow + 1) % ROWS;
    if (justUp)                                    this._pauseRow = (this._pauseRow + ROWS - 1) % ROWS;

    // ── Confirm (A / Start) ───────────────────────────────────────────────
    if (inp.justPressed(BTN_FLAGS.A) || inp.justPressed(BTN_FLAGS.START)) {
      if (this._pauseRow === 0) { this._resumeFromPause(); return; }
      if (this._pauseRow === 1) { this._enterSettings("PAUSE"); return; }
      if (this._pauseRow === 2) { this._saveAudioSettings(); this.gameState = GAMESTATE.MENU; bgmStop(); return; }
      if (this._pauseRow === 3) { this._resumeFromPause(); return; } // extra resume row
    }

    // ── Render ────────────────────────────────────────────────────────────
    this._renderScene(true);
    this._drawPauseMenu();
    present(this.renderer);
  }

  _drawPauseMenu() {
    const rd = this.renderer;
    const SCREEN_W = 320, SCREEN_H = 200;

    const W = 100, H = 60;
    const px = (SCREEN_W - W) >> 1;
    const py = (SCREEN_H - H) >> 1;

    const PANEL  = rgba(20,  14,  36);
    const ACCENT = rgba(255, 110, 180);
    const WHITE  = rgba(255, 255, 255);
    const DIM    = rgba(140, 120, 160);
    const SEL    = rgba(120, 240, 200);

    drawRect(rd, px, py, W, H, PANEL);
    drawRect(rd, px, py, W, H, ACCENT, false);

    // Title
    const TITLE = "PAUSED";
    const titleW = TITLE.length * 5;
    drawText(rd, TITLE, px + ((W - titleW) >> 1), py + 5, ACCENT, 1);

    const items = ["RESUME GAME", "SETTINGS", "MAIN MENU"];
    let ry = py + 17;
    for (let i = 0; i < items.length; i++) {
      const s = i === this._pauseRow;
      if (s) drawText(rd, ">", px + 4, ry, SEL, 1);
      drawText(rd, items[i], px + 12, ry, s ? SEL : WHITE, 1);
      ry += 11;
    }

    const hint = "W/S:SEL  SPC:OK";
    const hw   = hint.length * 5;
    drawText(rd, hint, px + ((W - hw) >> 1), py + H - 8, DIM, 1);
  }

  // ---- SETTINGS panel (standalone screen, reachable from Menu and Pause) --
  _drawSettingsPanel(overlay) {
    const rd = this.renderer;
    const SCREEN_W = 320, SCREEN_H = 200;

    const W = 130, H = 72;
    const px = (SCREEN_W - W) >> 1;
    const py = (SCREEN_H - H) >> 1;

    const PANEL       = rgba(20,  14,  36);
    const ACCENT      = rgba(255, 110, 180);
    const WHITE       = rgba(255, 255, 255);
    const DIM         = rgba(140, 120, 160);
    const SEL         = rgba(120, 240, 200);
    const SLIDER_FILL = rgba(100, 220, 180);
    const SLIDER_BG   = rgba(50,  40,  70);
    const SLIDER_DIM  = rgba(60,  150, 120);

    drawRect(rd, px, py, W, H, PANEL);
    drawRect(rd, px, py, W, H, ACCENT, false);

    const TITLE = "SETTINGS";
    const titleW = TITLE.length * 5;
    drawText(rd, TITLE, px + ((W - titleW) >> 1), py + 4, ACCENT, 1);

    const items = [
      { label: "FX VOL",  val: this._settingsFxVol  },
      { label: "BGM VOL", val: this._settingsBgmVol },
    ];

    let ry = py + 16;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const s    = i === this._settingsRow;
      const lc   = s ? SEL : DIM;
      if (s) drawText(rd, ">", px + 3, ry, SEL, 1);
      drawText(rd, item.label, px + 10, ry, lc, 1);

      const sx  = px + 10;
      const sy  = ry + 9;
      const sw  = W - 28;
      const sh  = 4;
      drawRect(rd, sx, sy, sw, sh, SLIDER_BG);
      const fillW = Math.max(2, Math.round(item.val * sw));
      drawRect(rd, sx, sy, fillW, sh, s ? SLIDER_FILL : SLIDER_DIM);
      drawRect(rd, sx, sy, sw, sh, s ? SEL : DIM, false);
      const pct    = Math.round(item.val * 100);
      const pctStr = String(pct).padStart(3, " ") + "%";
      drawText(rd, pctStr, sx + sw + 2, sy, s ? SEL : DIM, 1);
      ry += 18;
    }

    // Back row
    {
      const s = this._settingsRow === 2;
      if (s) drawText(rd, ">", px + 3, ry, SEL, 1);
      drawText(rd, "BACK", px + 10, ry, s ? SEL : WHITE, 1);
    }

    const hint = "W/S:SEL  A/D:ADJ  SPC:BACK";
    const hw   = hint.length * 5;
    drawText(rd, hint, px + ((W - hw) >> 1), py + H - 8, DIM, 1);
  }

  // ---- INTERMISSION (portal warp animation) -------------------------------
  _tickIntermission() {
    const still = stepTransition(this.transition, this.player);
    this._renderScene(false);
    const { warp, fade } = transitionWarpAmount(this.transition);
    present(this.renderer, warp, fade);
    if (!still) {
      this.gameState = GAMESTATE.GAMEPLAY;
      flashMessage(this.hud, "WARPED!", 60);
    }
  }

  // ---- GAME OVER ----------------------------------------------------------
  _tickGameOver() {
    if (this.input.justPressed(BTN_FLAGS.START) || this.input.justPressed(BTN_FLAGS.A)) {
      this._resetGame();
    }
    this._renderScene(true);
    drawCenterPanel(this.renderer, [
      { text: "GAME OVER", scale: 2, color: rgba(255, 100, 120) },
      { text: "", scale: 1 },
      { text: `SPRINKLES: ${this.hud.sprinkles}`, scale: 1 },
      { text: "", scale: 1 },
      { text: "PRESS START TO RETRY", scale: 1, color: rgba(200, 200, 220) },
    ]);
    present(this.renderer);
  }

  // ---- GAMEPLAY -----------------------------------------------------------
  _tickGameplay() {
    const inp = this.input;
    const player = this.player;
    const world = this.world;

    // Pause hotkey
    if (inp.justPressed(BTN_FLAGS.START)) {
      this._enterPause();
      return;
    }
    // Debug toggle: hold SEL
    this.debugOpen = inp.isDown(BTN_FLAGS.SEL);

    // ---- 1. Input → derive request flags (jump trigger captured here) ----
    if (inp.justPressed(BTN_FLAGS.A)) {
      // request handled in physics on next step (so we can drive impulses)
      player._wantJump = true;
      // Sound: first jump vs double-jump based on current token count
      if (player.jumpTokens === 2) sfxJump();
      else if (player.jumpTokens === 1) sfxDoubleJump();
    }

    // ---- Glide arm tracking -----------------------------------------------
    // _glideArmed latches true the moment A is held after both jump tokens are
    // spent (jumpTokens === 0), and stays true until the player lands.
    // This gates glide so it only engages on intentional hold.
    if (player.grounded) {
      player._glideArmed = false; // reset every landing
    } else if (player.jumpTokens === 0) {
      // Both tokens spent — window is open: arm glide if A held at any point.
      if (inp.isDown(BTN_FLAGS.A)) {
        player._glideArmed = true;
      }
    }

    // ---- 2. Bitwise resolution ------------------------------------------
    const justLanded = player.grounded && (player.state & (STATE.JUMP | STATE.DOUBLE_JUMP));
    const grounded = player.grounded;
    player.state = resolveBitwise(player.state, {
      input: inp,
      grounded,
      justLanded,
      axisX: inp.axisX,
      axisY: inp.axisY,
      jumpTokens: player.jumpTokens,
      glideArmed: player._glideArmed,
    });

    // ---- 3. Discrete resolution -----------------------------------------
    const { movementMode, jumpMode } = resolveDiscrete(player.state, grounded);

    // ---- 4. LUT execution -----------------------------------------------
    // Track grounded transition for squash/stretch BEFORE physics overwrites it.
    const wasGrounded = player.grounded;
    const yVelPreLand = player.vy;

    // Camera yaw control: locked-behind-player by default, free-orbit while
    // any free-cam input is engaged (Q/E keys, right-stick X, LB/RB shoulders).
    {
      let orbitDelta = inp.orbitX;
      if (inp.isDown(BTN_FLAGS.LB)) orbitDelta -= 1;
      if (inp.isDown(BTN_FLAGS.RB)) orbitDelta += 1;
      const freeCam = Math.abs(orbitDelta) > 0.01;
      if (freeCam) {
        this.camera.targetYaw += orbitDelta * 2.5;
      } else {
        let dy = player.yaw - this.camera.targetYaw;
        if (dy > 180) dy -= 360;
        if (dy < -180) dy += 360;
        this.camera.targetYaw += dy * 0.18;
      }
      if (this.camera.targetYaw < 0) this.camera.targetYaw += 360;
      if (this.camera.targetYaw >= 360) this.camera.targetYaw -= 360;
    }

    // Camera pitch override: right-stick Y (gamepad) accumulates into
    // camera.lookPitch (clamped). When no input, it decays back to 0 so
    // the auto-pitch resumes. Composed targetPitch clamped to ±40°.
    {
      const stickPitch = inp.orbitY;       // -1..+1
      // Invert stick: pulling stick UP (-y) should look UP (+pitch).
      const stickDelta = -stickPitch * 2.0;
      const inputActive = Math.abs(stickPitch) > 0.05;
      if (inputActive) {
        this.camera.lookPitch += stickDelta;
      } else {
        this.camera.lookPitch *= 0.90; // ease back toward auto-aim
        if (Math.abs(this.camera.lookPitch) < 0.05) this.camera.lookPitch = 0;
      }
      if (this.camera.lookPitch > 30) this.camera.lookPitch = 30;
      if (this.camera.lookPitch < -30) this.camera.lookPitch = -30;
    }

    // Cast a ray from Froyo's muzzle along her facing direction.
    // The hit point (platform surface or max-range endpoint) becomes the
    // smooth look-at target; autoPitch is then derived from camera → that point.
    castLookRay(this.camera, player, world.platforms);

    updateCamera(this.camera, player, movementMode);

    // Compose final targetPitch after updateCamera produced autoPitch.
    {
      let p = this.camera.autoPitch + this.camera.lookPitch;
      if (p > 40)  p = 40;
      if (p < -40) p = -40;
      this.camera.targetPitch = p;
    }

    // Step moving platforms before physics so collision is up-to-date
    const movingPlatforms = stepMovingPlatforms(world, this.frame);

    // Platform carry — if player is grounded on a moving platform, push them
    // with the platform's velocity delta so they ride it naturally.
    if (player.grounded && movingPlatforms.length > 0) {
      const r = 0.35; // player radius (must match physics.js)
      const halfH = 0.5;
      for (const p of movingPlatforms) {
        // Check if player is standing on top of this specific platform
        let onThisPlatform = false;
        for (const b of p.blocks) {
          if (b.sx === undefined) continue;
          const dx = player.x - b.wx;
          const dz = player.z - b.wz;
          const topY = b.wy + b.sy;
          const bottomY = b.wy - b.sy;
          if (Math.abs(dx) <= b.sx + r + 0.05 &&
              Math.abs(dz) <= b.sz + r + 0.05 &&
              Math.abs(player.y - halfH - topY) < 0.12) {
            onThisPlatform = true;
            break;
          }
        }
        if (!onThisPlatform) {
          // Also check platform AABB for single-block platforms
          const dx = player.x - p.x;
          const dz = player.z - p.z;
          const topY = p.y;
          if (Math.abs(dx) <= p.sx + r + 0.05 &&
              Math.abs(dz) <= p.sz + r + 0.05 &&
              Math.abs(player.y - halfH - topY) < 0.12) {
            onThisPlatform = true;
          }
        }
        if (onThisPlatform) {
          player.x += p.dvx;
          player.z += p.dvz;
          break; // only one platform at a time
        }
      }
    }

    // Apply wind gust force — currently disabled while wind obstacles are paused.
    if (false && world.windZones && !player.grounded) {
      for (const wz of world.windZones) {
        const wdx = player.x - wz.x;
        const wdz = player.z - wz.z;
        const wdist = Math.sqrt(wdx * wdx + wdz * wdz);
        if (wdist < wz.radius) {
          const falloff = 1 - wdist / wz.radius;
          // Wind direction vector from angle
          const wvx = Math.sin(wz.angle);
          const wvz = Math.cos(wz.angle);
          player.vx += wvx * wz.strength * falloff;
          player.vz += wvz * wz.strength * falloff;
          // Visual cue: store "in wind" flag for HUD
          if (!this._windNotified && falloff > 0.5) {
            flashMessage(this.hud, "WIND!", 45);
            sfxWind();
            this._windNotified = true;
          }
        } else {
          this._windNotified = false;
        }
      }
    }

    stepPhysics(player, world, {
      axisX: inp.axisX,
      axisY: inp.axisY,
      movementMode,
      jumpMode,
    });

    // Track player angular velocity for the turn-lean animation.
    {
      let dy = player.yaw - player._prevYaw;
      if (dy > 180) dy -= 360;
      if (dy < -180) dy += 360;
      player.yawVel = player.yawVel * 0.65 + dy * 0.35;
      player._prevYaw = player.yaw;
    }

    // Squash & stretch driver (anim only — purely visual)
    {
      const landedThisFrame = !wasGrounded && player.grounded;
      if (landedThisFrame && yVelPreLand < -0.18) {
        // Sharp downward landing → squash + thud sound
        player.squash = -0.55;
        sfxLand(-yVelPreLand);
      } else if (!player.grounded && player.vy > 0.10) {
        // Ascending fast → stretch
        const target = 0.35;
        player.squash += (target - player.squash) * 0.30;
      } else {
        player.squash *= 0.78;
        if (Math.abs(player.squash) < 0.01) player.squash = 0;
      }
    }

    // Ice breath trigger — fires from the player's front muzzle along player.yaw.
    if (inp.justPressed(BTN_FLAGS.X)) {
      fireBreath(this.breath, player, world, player.yaw);
      this.input.rumble({ duration: 120, strongMagnitude: 0.3, weakMagnitude: 0.6 });
      sfxIceBreath();
    }
    // Track enemy frozen states before stepBreath to detect new freezes
    const _prevFrozen = world.enemies.map(e => e.frozen);
    const _prevDead   = world.enemies.map(e => e.dead);

    stepBreath(this.breath);
    stepBreakables(world);

    // Sound: crystal shatter
    for (const c of world.crystals) {
      if (c.broken && !c._rewarded) {
        c._rewarded = true;
        notifySprinkles(this.hud, this.hud.sprinkles + 10);
        this.save.sprinkles = this.hud.sprinkles;
        writeSave(this.save);
        sfxCrystalBreak();
        sfxCollect();
      }
    }

    // Sound: crate break
    if (world.breakables) {
      for (const b of world.breakables) {
        if (b.broken && !b._soundPlayed) {
          b._soundPlayed = true;
          sfxCrateBreak();
        }
      }
    }

    // Sound: enemy newly frozen
    for (let ei = 0; ei < world.enemies.length; ei++) {
      const e = world.enemies[ei];
      if (!_prevFrozen[ei] && e.frozen) sfxEnemyFrozen();
      if (!_prevDead[ei] && e.dead)     sfxEnemyDie();
    }

    // ---- Enemy AI tick ------------------------------------------------
    // Count projectiles fired this frame so we can play shoot SFX
    const projBefore = projectiles.length;
    stepEnemyAI(world.enemies, player, world.platforms, this.frame, this.hud, flashMessage);
    if (projectiles.length > projBefore) sfxEnemyShoot();

    // Player hit-stun from projectiles (hitT ticked down each frame)
    if (player.hitT > 0) {
      player.hitT--;
      if (player.hitT === 44) {
        // First frame of hit — apply STATE.HIT and deduct life
        player.state |= STATE.HIT;
        notifyLives(this.hud, this.hud.lives - 1);
        this.save.lives = this.hud.lives;
        writeSave(this.save);
        sfxPlayerHit();
        this.input.rumble({ duration: 200, strongMagnitude: 0.8, weakMagnitude: 0.4 });
        if (this.hud.lives <= 0) {
          this._enterGameOver();
          return;
        }
      }
    } else {
      player.state &= ~STATE.HIT; // clear HIT flag when stun ends
    }

    // ---- Enemy defeat tracking ------------------------------------------
    // Count living enemies; detect when the last one just died this frame.
    const aliveEnemies = world.enemies.filter(e => !e.dead);
    const prevPortalOpen = this.hud.portalOpen;
    this.hud.enemiesLeft = aliveEnemies.length;
    this.hud.portalOpen  = aliveEnemies.length === 0;

    // Flash a message exactly once when the portal unlocks
    if (!prevPortalOpen && this.hud.portalOpen && world.enemies.length > 0) {
      flashMessage(this.hud, "PORTAL OPEN!", 120);
      sfxPortalOpen();
    }

    // Portal interaction — only allowed when all enemies are dead
    if (this.hud.portalOpen && tryPortal(this.transition, player, world.portal)) {
      this.gameState = GAMESTATE.INTERMISSION;
    }

    // Death handling — bottom of world
    if (player.state & STATE.DEAD) {
      if (this.hud.lives > 0) {
        notifyLives(this.hud, this.hud.lives - 1);
        this.save.lives = this.hud.lives;
        writeSave(this.save);
      }
      if (this.hud.lives <= 0) {
        this._enterGameOver();
        return;
      }
      this._respawn();
    }

    tickHUD(this.hud);

    // ---- 5. Render ------------------------------------------------------
    this._renderScene(false, { movementMode, jumpMode });
    present(this.renderer);
  }

  // ---- Render the scene (no present) -------------------------------------
  _renderScene(staticFrame, modes = null) {
    const rd = this.renderer;
    const cam = this.camera;
    const world = this.world;
    const player = this.player;

    // Sync Three.js camera matrices before any GLB mesh projection this frame
    syncThreeCamera(cam);

    clearSky(rd, cam.yaw, this.frame);

    // Build all triangles
    const tris = [];

    // Helper: push an axis-aligned box (pure-JS, no Three.js)
    const pushBox = (cx, cy, cz, sx, sy, sz, top, side) => {
      const arr = buildCube(cx, cy, cz, sx, sy, sz, top, side, cam);
      for (const t of arr) tris.push(t);
    };

    // pushBoxCulled — no frustum check, back-face culling happens in buildCube
    const pushBoxCulled = (cx, cy, cz, sx, sy, sz, top, side, _r) => {
      pushBox(cx, cy, cz, sx, sy, sz, top, side);
    };

    // ── SkyDome + SkyboxRing — encompass the level perimeter ────────────────
    // Both are centered on the camera (parallax: they rotate WITH the camera yaw
    // so they appear stationary — a classic skybox trick). SkyDome gets a purple→orange
    // gradient tint; SkyboxRing is slightly smaller.
    // We render them before everything else so they sit behind all geometry.
    if (this._skyDomeMesh) {
      // Lerp tint from purple (top) to orange (horizon) based on each triangle's
      // average Y. We pass baseColor = orange and use the "skyGradient" colorMode
      // handled in geometry.js — but since we don't have that mode yet, we use
      // a warm orange-purple blend as baseColor and let lighting do the rest.
      const SKY_DOME_TINT = rgba(220, 100, 60);   // warm orange-purple
      const skyDomeTris = buildMeshTris(
        this._skyDomeMesh,
        cam.x, cam.y, cam.z,       // follow camera
        SKY_DOME_TINT,
        cam,
        projectVertex,
        this._skyDomeScale,
        cam.yaw,                   // rotate with camera yaw → parallax
        "skyDome",                 // custom colorMode for sky gradient
        this._getSkyPalette()
      );
      for (const t of skyDomeTris) tris.push(t);
    }
if (this._skyRingMesh) {

const sky =
    this._getSkyPalette();

const ringSide =
    sky.ringSide ||
    sky.side ||
    sky.fog ||
    [110, 110, 140];

const SKY_RING_TINT =
    rgba(
        ringSide[0],
        ringSide[1],
        ringSide[2],
    );

  const skyRingTris = buildMeshTris(
      this._skyRingMesh,
      cam.x, cam.y, cam.z,
      SKY_RING_TINT,
      cam,
      projectVertex,
      this._skyRingScale,
      0,
      "skyRing",
      sky
  );

  for (let i = 0; i < skyRingTris.length; i++) {
      tris.push(
          skyRingTris[i]
      );
  }
}
    // Void/water plane below islands — rendered before all geometry so it sits behind
    {
      const voidY = -22;
      const voidTris = buildVoidPlane(voidY, this.frame, cam);
      for (const t of voidTris) tris.push(t);
    }

    // Moving platform indicator: draw glowing rails to show travel path
    for (const p of world.platforms) {
      if (!p.moving) continue;
      const railC = rgba(100, 255, 200);
      const railS = rgba(40, 160, 120);
      const railH = 0.15;
      // Draw a small beacon cube at origin to mark track center
      const arr = buildCube(p.originX, p.y - p.sy + railH * 2, p.originZ, 0.4, railH, 0.4, railC, railS, cam);
      for (const t of arr) tris.push(t);
    }

    // Platforms — draw collision volumes first for non-GLB platforms, then island geometry.
    for (const p of world.platforms) {
      const hasBlocks = p.blocks && p.blocks.length > 0;
      const hasGLB = !!p.glbModel;

      if (hasGLB) {
        const ddx = p.x - cam.x, ddz = p.z - cam.z;
        const cullDist = p.isPortalIsland ? 999 : 220;
        if (ddx * ddx + ddz * ddz > cullDist * cullDist) continue;

        let modelScale = (typeof p.glbModel.scale === 'number' && isFinite(p.glbModel.scale)) ? p.glbModel.scale : 1.0;
        if (typeof p.glbModel.scale !== 'number' || !isFinite(p.glbModel.scale)) {
          console.warn('[scale] missing/invalid glbModel.scale for platform', p.glbName || p.id || p.name || null, ' — defaulting to 1.0');
          modelScale = 1.0;
        }
        const effectiveScale = modelScale * (p.glbScaleMul ?? 1.0);
        const wx = p.glbWorldX ?? p.x;
        const wy = p.glbWorldY ?? (p.y - p.sy);
        const wz = p.glbWorldZ ?? p.z;
        const platformPalette = this._getPlatformPalette(p);
        const biomeTextures = this._getBiomeTextureTable(platformPalette.biome);
        const islandPalette = {
          ...platformPalette,
          textureTop: biomeTextures?.top || null,
          textureSide: biomeTextures?.side || null,
          textureUnder: biomeTextures?.under || null,
          textureScale: 0.08,
        };
        const cachedIsland = this._islandCache.get(p);
        let islandTris;
        if (cachedIsland && !islandPalette.textureTop) {
          islandTris = buildMeshTrisFromCache(cachedIsland, wx, wy, wz, cam);
        } else {
          islandTris = buildMeshTris(
            p.glbModel.meshData,
            wx, wy, wz,
            islandPalette.top ?? 0xffffffff,
            cam,
            projectVertex,
            effectiveScale,
            0,
            "island",
            islandPalette
          );
        }
        for (const t of islandTris) tris.push(t);
      } else if (p.type === "bridge" && hasBlocks) {
        for (const b of p.blocks) {
          if (b._axisNX !== undefined && this._bridgeMesh) {
            const bridgeLen = b._plankL * 2;
            const scaleZ = bridgeLen / this._bridgeRawLen;
            const bridgeYaw = Math.atan2(b._axisNX, b._axisNZ) * 180 / Math.PI;
            const BRIDGE_WIDTH_SCALE = 1.0;
            const uniformScale = Math.sqrt(scaleZ * BRIDGE_WIDTH_SCALE);
            const bridgeTris = buildMeshTris(
              this._bridgeMesh,
              b.wx, b.wy, b.wz,
              rgba(140, 80, 35),
              cam,
              projectVertex,
              uniformScale,
              bridgeYaw,
              "flatBrown"
            );
            for (const t of bridgeTris) tris.push(t);
          } else if (b._axisNX !== undefined) {
            const arr = buildOrientedPlank(
              b.wx, b.wy, b.wz,
              b._axisNX, b._axisNZ,
              b._plankL, b._plankW, b.sy,
              b.top, b.side, cam
            );
            for (const t of arr) tris.push(t);
          }
        }
      } else if (hasBlocks) {
        for (const b of p.blocks) {
          let arr;
          if (b.shape === "trap") {
            arr = buildTrapezoid(b.wx, b.wy, b.wz, b.sx, b.sy, b.sz, b.topScale, b.yaw, b.top, b.side, cam);
          } else if (b.shape === "tri") {
            arr = buildTriPrism(b.wx, b.wy, b.wz, b.r, b.sy, b.yaw, b.top, b.side, cam);
          } else if (b._axisNX !== undefined) {
            arr = buildOrientedPlank(
              b.wx, b.wy, b.wz,
              b._axisNX, b._axisNZ,
              b._plankL, b._plankW, b.sy,
              b.top, b.side, cam
            );
          } else {
            arr = buildCubeWithAdjacency(b, cam, p.blocks);
          }
          for (const t of arr) tris.push(t);

          if (!b.shape && b._axisNX === undefined && b.sy !== undefined && b.sx !== undefined) {
            const botY = b.wy - b.sy;
            const taperArr = buildIslandTaper(b.wx, botY, b.wz, b.sx, b.sz, b.side, cam);
            for (const t of taperArr) tris.push(t);
          }
        }
      } else {
        const arr = buildCube(p.x, p.y - 0.5, p.z, p.sx, 0.5, p.sz, p.color, p.side, cam);
        for (const t of arr) tris.push(t);
        const taperArr = buildIslandTaper(p.x, p.y - 1.0, p.z, p.sx, p.sz, p.side || p.color, cam);
        for (const t of taperArr) tris.push(t);
      }
    }

    // Biome decorations — trees, spires, mushrooms, cacti, gemstones, lanterns
    if (world.decorations) {
      for (const d of world.decorations) {
        // Simple distance cull — decorations beyond FOG_FAR are invisible anyway
        const ddx = d.x - cam.x, ddz = d.z - cam.z;
        if (ddx * ddx + ddz * ddz > 200 * 200) continue;

        let dArr;
        const sc = d.scale;
        switch (d.type) {
          case "tree":     dArr = buildTree(d.x, d.y, d.z, sc, cam); break;
          case "pine":     dArr = buildPine(d.x, d.y, d.z, sc, cam); break;
          case "spire":    dArr = buildSpire(d.x, d.y, d.z, sc, cam); break;
          case "mushroom": dArr = buildMushroom(d.x, d.y, d.z, sc, cam); break;
          case "cactus":   dArr = buildCactus(d.x, d.y, d.z, sc, cam); break;
          case "gemstone": dArr = buildGemstone(d.x, d.y, d.z, sc, d.biome, cam); break;
          case "lantern":  dArr = buildLantern(d.x, d.y, d.z, sc, this.frame, cam); break;
          default:         dArr = [];
        }
        for (const t of dArr) tris.push(t);
      }
    }

    // Crystals (scaled 8×) — bounding radius ~3.0
    for (const c of world.crystals) {
      if (c.broken) continue;
      pushBoxCulled(c.x, c.y, c.z, 1.76, 2.4, 1.76, CRYSTAL_C, CRYSTAL_S, 3.2);
    }

    // Breakable crates
    const CRATE_TOP  = rgba(220, 140, 50);
    const CRATE_SIDE = rgba(160, 90, 30);
    const CRATE_BURST= rgba(255, 200, 80);
    if (world.breakables) {
      for (const b of world.breakables) {
        if (b.broken) {
          if (b.shatterT > 0) {
            const t = b.shatterT / 24;
            const spread = (1 - t) * 0.7;
            const offsets = [[-1,-1],[ 1,-1],[-1, 1],[ 1, 1]];
            for (const [ox, oz] of offsets) {
              pushBox(
                b.x + ox * spread * 0.4,
                b.y + (1 - t) * 0.4,
                b.z + oz * spread * 0.4,
                0.12 * t, 0.12 * t, 0.12 * t,
                CRATE_BURST, CRATE_SIDE
              );
            }
          }
          continue;
        }
        pushBoxCulled(b.x, b.y, b.z, 2.24, 2.24, 2.24, CRATE_TOP, CRATE_SIDE, 4.0);
      }
    }

    // Player shadow — blob shadow, scales with height above surface
    {
      const sh = this._findShadowY(player, world);
      if (sh !== null) {
        const heightAbove = Math.max(0, player.y - sh);
        // Scale shadow: shrinks and darkens as player goes higher
        const shadowScale = Math.max(0.06, 0.28 - heightAbove * 0.025);
        const shadowAlpha = Math.max(0.3, 1.0 - heightAbove * 0.06);
        const shadowAlpha8 = Math.min(255, (shadowAlpha * 255) | 0);
        const shadowColor = (shadowAlpha8 << 24) | (SHADOW_C & 0x00ffffff);
        pushBox(player.x, sh + 0.01, player.z, shadowScale, 0.005, shadowScale * 0.7, shadowColor, shadowColor);
      }
    }

    // Enemies — regular enemies are player-scale; boss is 2.5× bigger
    const ENEMY_HURT_TOP = rgba(255, 60, 60);
    const ENEMY_HURT_BOT = rgba(255, 140, 140);
    const ENEMY_HP1_TOP  = rgba(180, 80, 40);
    const ENEMY_HP1_BOT  = rgba(220, 120, 60);
    // Boss colors — dark purple/magenta to stand out
    const BOSS_TOP       = rgba(180, 30, 200);
    const BOSS_BOT       = rgba(100, 10, 140);
    const BOSS_FROZEN    = rgba(140, 200, 255);
    const BOSS_HURT_TOP  = rgba(255, 40, 180);
    const BOSS_HURT_BOT  = rgba(255, 120, 220);

    for (const e of world.enemies) {
      if (e.dead) continue;
      const isBoss = !!e.boss;
      // Regular enemies bob at player scale; boss bobs slower/bigger
      const bobAmp = isBoss ? 1.2 : 0.48;
      const bob = e.frozen ? 0 : Math.sin(e.bobPhase) * bobAmp;

      let pal;
      if (e.frozen) {
        pal = [isBoss ? BOSS_FROZEN : FROZEN_TINT, isBoss ? BOSS_FROZEN : FROZEN_TINT];
      } else if (e._hurtT && e._hurtT > 0) {
        pal = ((e._hurtT / 3) | 0) % 2 === 0
          ? [isBoss ? BOSS_HURT_TOP : ENEMY_HURT_TOP, isBoss ? BOSS_HURT_BOT : ENEMY_HURT_BOT]
          : [isBoss ? BOSS_TOP : ENEMY_TOP, isBoss ? BOSS_BOT : ENEMY_BOT];
      } else if (!isBoss && e.hp === 1) {
        pal = [ENEMY_HP1_TOP, ENEMY_HP1_BOT];
      } else {
        pal = [isBoss ? BOSS_TOP : ENEMY_TOP, isBoss ? BOSS_BOT : ENEMY_BOT];
      }

      if (isBoss) {
        // Boss: sun GLB model at 2.5× scale, or billboard fallback
        if (this._sunMesh && !e.frozen) {
          const bossScale = this._sunScaleBoss ?? this._sunScale * 2.5;
          const sunTris = buildMeshTris(
            this._sunMesh,
            e.x,
            e.y + bob,
            e.z,
            rgba(255, 210, 0),
            cam,
            projectVertex,
            bossScale,
            e._patrolAngle ? (e._patrolAngle * 180 / Math.PI) : 0,
            "sunVertex"
          );
          for (const t of sunTris) tris.push(t);
        } else {
          // Billboard fallback (frozen or mesh not yet loaded)
          const bb = buildBillboard(e.x, e.y + bob, e.z, 4.0, 5.5, pal, cam);
          for (const t of bb) tris.push(t);
        }
        // Boss HP bar — row of pips above head
        if (!e.frozen && e.hp > 0) {
          const maxHp = 6;
          const pipTop  = rgba(255, 200, 0);
          const pipSide = rgba(180, 130, 0);
          const emptyTop  = rgba(60, 50, 20);
          const emptySide = rgba(30, 25, 10);
          // pip height depends on whether sun mesh is loaded (sun is taller)
          const pipY = e.y + bob + (this._sunMesh ? (this._sunScaleBoss ?? 7) * 0.7 + 2 : 7.5);
          const pipSpacing = 1.4;
          for (let pi = 0; pi < maxHp; pi++) {
            const pipX = e.x + (pi - (maxHp - 1) * 0.5) * pipSpacing;
            const alive = pi < e.hp;
            const arr = buildCube(pipX, pipY, e.z, 0.4, 0.4, 0.4,
              alive ? pipTop : emptyTop,
              alive ? pipSide : emptySide, cam);
            for (const t of arr) tris.push(t);
          }
          // Crown above HP bar
          const crownC  = rgba(255, 200, 0);
          const crownS  = rgba(180, 130, 0);
          const crownY  = pipY + 1.2;
          for (let ci = 0; ci < 3; ci++) {
            const crownX = e.x + (ci - 1) * 2.2;
            const crownH = ci === 1 ? 0.8 : 0.5;
            const arr2 = buildCube(crownX, crownY + crownH, e.z, 0.5, crownH, 0.5, crownC, crownS, cam);
            for (const t of arr2) tris.push(t);
          }
        }
      } else {
        // Regular enemy: sun-with-sunglasses GLB mesh if loaded, billboard fallback otherwise
        if (this._sunMesh && !e.frozen) {
          // colorMode "sunVertex": uses GLB vertex colors so sunglasses stay dark
          const sunTris = buildMeshTris(
            this._sunMesh,
            e.x,
            e.y + bob,
            e.z,
            rgba(255, 210, 0),
            cam,
            projectVertex,
            this._sunScale,
            e._patrolAngle ? (e._patrolAngle * 180 / Math.PI) : 0,
            "sunVertex"
          );
          for (const t of sunTris) tris.push(t);
        } else {
          // Billboard fallback (also used when frozen — easy to tint)
          const bb = buildBillboard(e.x, e.y + bob, e.z, 1.4, 2.0, pal, cam);
          for (const t of bb) tris.push(t);
        }
        // HP pips — only show when damaged
        if (!e.frozen && e.hp > 0 && e.hp <= 2) {
          const pipTop  = e.hp > 1 ? rgba(80, 240, 80) : rgba(255, 120, 40);
          const pipSide = e.hp > 1 ? rgba(20, 140, 20) : rgba(180, 60, 10);
          const pipY = e.y + bob + 2.8;
          const pipSpacing = 0.8;
          for (let pi = 0; pi < e.hp; pi++) {
            const pipX = e.x + (pi - (e.hp - 1) * 0.5) * pipSpacing;
            const arr = buildCube(pipX, pipY, e.z, 0.22, 0.22, 0.22, pipTop, pipSide, cam);
            for (const t of arr) tris.push(t);
          }
        }
      }
    }

    // Portal — always render (landmark; small enough to cull cheaply)
    {
      const allDead = world.enemies.length === 0 || world.enemies.every(e => e.dead);
      if (allDead) {
        const ph = Math.sin(this.frame * 0.12) * 0.4;
        const pulse = 4.0 + Math.sin(this.frame * 0.18) * 0.4;
        pushBoxCulled(world.portal.x, world.portal.y + ph, world.portal.z, pulse, 5.6, pulse, PORTAL_C, PORTAL_S, 10.0);
      } else {
        const PORTAL_LOCKED   = rgba(80,  70,  90);
        const PORTAL_LOCKED_S = rgba(40,  35,  50);
        pushBoxCulled(world.portal.x, world.portal.y, world.portal.z, 3.2, 4.8, 3.2, PORTAL_LOCKED, PORTAL_LOCKED_S, 8.0);
      }
    }

    // Enemy death burst — bigger for boss
    for (const e of world.enemies) {
      if (!e.dead || !e.deathT || e.deathT <= 0) continue;
      const deathFrames = e.boss ? 45 : 30;
      const t = e.deathT / deathFrames;
      const spreadMul = e.boss ? 2.5 : 0.9;
      const spread = (1 - t) * spreadMul;
      const BURST_C = e.boss ? rgba(220, 80, 255) : rgba(160, 220, 255);
      const BURST_S = e.boss ? rgba(140, 20, 200) : rgba(80,  140, 200);
      const offsets = e.boss
        ? [[-1,-1],[1,-1],[-1,1],[1,1],[0,-1],[0,1],[-1,0],[1,0],[0,0]]
        : [[-1,-1],[1,-1],[-1,1],[1,1],[0,-1],[0,1]];
      for (const [ox, oz] of offsets) {
        const s = e.boss ? 0.5 * t : 0.14 * t;
        pushBox(
          e.x + ox * spread * 0.5,
          e.y + (1 - t) * (e.boss ? 2.0 : 0.5),
          e.z + oz * spread * 0.5,
          s, s, s, BURST_C, BURST_S
        );
      }
    }

    // Player — GLB mesh if loaded, billboard fallback otherwise.
    if (this._froyoMesh) {
      const sq = player.squash;
      // autoScale normalizes the model to 1.0 unit tall; squash/stretch on top.
      const meshScale = (this._meshAutoScale ?? 1.0) * (1 + sq * 0.25);
      // buildMeshTris now subtracts the local bounding-box center internally
      // (mesh.localCX/CY/CZ set during load), then adds worldX/Y/Z.
      // So we pass player.y as worldY — the model centres itself on that point.
      // The auto-scale was chosen so the model is 1.0 unit tall, meaning its
      // center sits at player.y and feet are at player.y - 0.5 automatically.
      const worldY = player.y;
      const hitColor = (player.state & STATE.HIT)
        ? rgba(255, 120, 100)
        : rgba(245, 200, 170);
      const meshTris = buildMeshTris(
        this._froyoMesh,
        player.x,
        worldY,
        player.z,
        hitColor,
        cam,
        projectVertex,
        meshScale,
        player.yaw,
        "froyo"  // bottom half orange, top uses vertex/base color
      );
      for (const t of meshTris) tris.push(t);
    } else {
      const palette = (player.state & STATE.HIT)
        ? [rgba(255, 80, 80), rgba(255, 200, 200)]
        : [PLAYER_TOP, PLAYER_BOT];
      const leanRaw = player.yawVel * 0.035;
      const lean = Math.max(-0.11, Math.min(0.11, leanRaw));
      const sq = player.squash;
      const sx = 1 - sq * 0.4;
      const sy = 1 + sq * 0.45;
      const bb = buildBillboard(
        player.x, player.y, player.z,
        0.70 * sx, 1.0 * sy, palette, cam, lean
      );
      for (const t of bb) tris.push(t);
    }

    // Front muzzle pip — red cherry GLB if loaded, red cube fallback otherwise
    {
      const yaw = player.yaw || 0;
      const fx = Math.sin((yaw * Math.PI) / 180);
      const fz = Math.cos((yaw * Math.PI) / 180);
      const muzzleY = this._froyoMesh
        ? player.y + 0.10
        : player.y + 0.20;
      const muzzleDist = this._froyoMesh ? 0.50 : 0.80;
      const mx = player.x + fx * muzzleDist;
      const my = muzzleY;
      const mz = player.z + fz * muzzleDist;
      const hot = this.breath.cooldown > 0;

      if (this._cherryMesh && !hot) {
        // Cherry GLB rendered at muzzle position, facing same direction as player
        // colorMode "flatRed" forces every triangle to solid red regardless of vertex colors
        const cherryTris = buildMeshTris(
          this._cherryMesh,
          mx, my, mz,
          rgba(220, 30, 30),
          cam,
          projectVertex,
          this._cherryScale,
          yaw,
          "flatRed"
        );
        for (const t of cherryTris) tris.push(t);
      } else {
        // Cube fallback, or ice-breath cooling flash
        const top  = hot ? rgba(140, 240, 255) : rgba(255, 40, 40);
        const side = hot ? rgba(60, 160, 220)  : rgba(180, 10, 10);
        const arr = buildCube(mx, my, mz, 0.20, 0.20, 0.20, top, side, cam);
        for (const t of arr) tris.push(t);
      }
    }

    // Enemy projectiles — boss projectiles are large dark purple; regular are red fireballs
    {
      const PROJ_TOP        = rgba(255, 80, 60);
      const PROJ_SIDE       = rgba(180, 40, 20);
      const BOSS_PROJ_TOP   = rgba(200, 30, 255);
      const BOSS_PROJ_SIDE  = rgba(110, 10, 180);
      for (const proj of projectiles) {
        const s = proj.boss ? 2.2 : 1.2;
        const top  = proj.boss ? BOSS_PROJ_TOP  : PROJ_TOP;
        const side = proj.boss ? BOSS_PROJ_SIDE : PROJ_SIDE;
        const arr = buildCube(proj.x, proj.y, proj.z, s, s, s, top, side, cam);
        for (const t of arr) tris.push(t);
      }
    }

    // Draw all geometry
    for (const t of tris) {
      if (t.texture) drawTexturedTri(rd, t.verts[0], t.verts[1], t.verts[2], t.color, t.texture);
      else drawTri(rd, t.verts[0], t.verts[1], t.verts[2], t.color);
    }

    // Particle pass (breath)
    for (const p of this.breath.particles) {
      const t = 1 - p.age / p.life;
      const c = lerp32(PARTICLE_C, 0xff100428, 1 - t); // fade slightly
      drawPixelW(rd, p, cam, c, 0);
    }

    // Wind zone particles — currently hidden while wind obstacles are paused.
    if (false && world.windZones) {
      const WIND_C = rgba(200, 240, 255);
      for (const wz of world.windZones) {
        const ddx = wz.x - cam.x, ddz = wz.z - cam.z;
        if (ddx * ddx + ddz * ddz > 140 * 140) continue;
        // Emit ~8 particles per zone, cycling by frame
        for (let wi = 0; wi < 8; wi++) {
          const phase = (this.frame * 0.04 + wi * 0.785) % (Math.PI * 2);
          const r = wz.radius * (0.3 + (wi % 3) * 0.25);
          const wx = wz.x + Math.cos(phase + wz.angle) * r;
          const wz2 = wz.z + Math.sin(phase + wz.angle) * r;
          const wy = player.y + Math.sin(phase * 2.1 + wi) * 3;
          const fade = ((Math.sin(phase) + 1) * 0.5);
          if (fade < 0.1) continue;
          drawPixelW(rd, { x: wx, y: wy, z: wz2 }, cam, WIND_C, 0);
        }
      }
    }

    // HUD
    const debug = this.debugOpen ? this._buildDebugLines(modes) : null;
    drawHUD(rd, this.hud, debug);
  }

  _findShadowY(player, world) {
    let best = null;
    for (const p of world.platforms) {
      const dx = player.x - p.x;
      const dz = player.z - p.z;
      if (Math.abs(dx) <= p.sx && Math.abs(dz) <= p.sz) {
        if (player.y > p.y - 0.1) {
          if (best === null || p.y > best) best = p.y;
        }
      }
    }
    return best;
  }

  _buildDebugLines(modes) {
    const inp = this.input;
    const s = this.player.state;
    const flags = [];
    if (s & STATE.WALK) flags.push("WALK");
    if (s & STATE.CHARGE) flags.push("CHARGE");
    if (s & STATE.JUMP) flags.push("JUMP");
    if (s & STATE.DOUBLE_JUMP) flags.push("DBLJMP");
    if (s & STATE.GLIDE) flags.push("GLIDE");
    if (s & STATE.HIT) flags.push("HIT");
    if (s & STATE.FROZEN) flags.push("FROZEN");
    if (s & STATE.DEAD) flags.push("DEAD");
    const moveNames = ["IDLE", "WALK", "CHARGE", "AIR", "GLIDE"];
    const jumpNames = ["GRND", "JUMP", "DBLJMP", "FALL"];
    return [
      `FLAGS:  ${flags.join(" ") || "NONE"}`,
      `TOKENS: ${this.player.jumpTokens}  GLIDE:${this.player._glideArmed ? "ARMED" : "off"}`,
      `MOVE:   ${modes ? moveNames[modes.movementMode] : "-"}`,
      `JUMP:   ${modes ? jumpNames[modes.jumpMode] : "-"}`,
      `POS:    ${this.player.x.toFixed(1)} ${this.player.y.toFixed(1)} ${this.player.z.toFixed(1)}`,
      `VEL:    ${this.player.vx.toFixed(2)} ${this.player.vy.toFixed(2)} ${this.player.vz.toFixed(2)}`,
      `INPUT:  ${inp.axisX.toFixed(1)} ${inp.axisY.toFixed(1)}  ORB:${inp.orbitX.toFixed(1)}  PAD:${inp.isGamepadConnected() ? "YES" : "NO"}`,
      `YAW:    P:${this.player.yaw.toFixed(0)}  CAM:${this.camera.yaw.toFixed(0)}  PIT:${this.camera.pitch.toFixed(0)}`,
      `LEAN:   ${this.player.yawVel.toFixed(1)} DEG/F  SQ:${this.player.squash.toFixed(2)}`,
      `CAM:    FOV:${this.camera.fovMul.toFixed(2)}  LOOK:${this.camera.lookPitch.toFixed(0)}`,
      `LOOKAT: ${this.camera.lookAtX.toFixed(1)} ${this.camera.lookAtY.toFixed(1)} ${this.camera.lookAtZ.toFixed(1)}`,
    ];
  }
}

// ---- Helpers used by FroyoGame above ----------------------------------------

function lerp32(a, b, t) {
  const ar = a & 0xff, ag = (a >>> 8) & 0xff, ab = (a >>> 16) & 0xff;
  const br = b & 0xff, bg = (b >>> 8) & 0xff, bb = (b >>> 16) & 0xff;
  const r = ar + (br - ar) * t;
  const g = ag + (bg - ag) * t;
  const b2 = ab + (bb - ab) * t;
  return (255 << 24) | ((b2 | 0) << 16) | ((g | 0) << 8) | (r | 0);
}
