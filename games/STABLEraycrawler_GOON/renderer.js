import { customAnimFrames } from './assets.js';
import { WEAPONS } from './shop.js';
import {
  FP_SHIFT, FP_ONE, f_mul, f_div,
  get_sin, get_cos, wrap_angle, radToBAM, bamToRad,
  get_reciprocal,
  BAM_COUNT, BAM_MASK,
  SineTable, CosineTable,
} from './raycaster.js';

// ---------------------------------------------------------------------------
// Framebuffer — Uint32Array for wall columns.
// One putImageData replaces ~320 individual drawImage calls per frame.
// Pixel format: 0xAABBGGRR (little-endian canvas layout).
// ---------------------------------------------------------------------------
const _FB_W = 320;
const _FB_H = 200;
const _wallImageData  = new ImageData(_FB_W, _FB_H);
const _wallFB         = new Uint32Array(_wallImageData.data.buffer);

// Detect endianness once at load time; affects ARGB word packing.
const _IS_LE = (new Uint32Array(new Uint8Array([1,0,0,0]).buffer))[0] === 1;

/** Pack an opaque RGB pixel into the correct Uint32 word for this platform. */
function _packRGB(r, g, b) {
  return _IS_LE
    ? (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;
}

// Per-wall-column occlusion buffer — set to 1 after a solid wall column is drawn.
// Front-to-back would use this for span clipping; currently used as a reference
// for sticker partial-span support (spec §17/18).
const _occlude = new Uint8Array(_FB_W);

// Texture constants (spec §14)
const TEX_SIZE = 64;
const TEX_MASK = TEX_SIZE - 1;  // 63

// Texture cache: HTMLImageElement → Uint32Array (TEX_SIZE×TEX_SIZE)
// Lazily populated on first wall draw after a level load.
const _texCache = new WeakMap();

// Build a set of weapon IDs that carry the FLASH tag — only these get muzzle flash draws.
const FLASH_IDS = new Set(
  WEAPONS.filter(w => w.tags && w.tags.includes('FLASH')).map(w => w.id)
);

/** Returns the active mod font or the default retro font. */
function getModFont() {
  return window.__modFont__ || "'Press Start 2P', 'Courier New', monospace";
}

const W = 320;
const H = 200;
const NUM_RAYS = 320;
const FOV = Math.PI / 2.5;

// Culling constants
const HALF_FOV_CULL = (FOV / 2) + 0.42; // slight margin beyond FOV edge for sprites

/**
 * Returns the screen Y row of the perspective-correct floor at a given distance.
 * Mirrors the wall projection: wallH = H / dist, so floor is at H/2 + wallH/2.
 * We add a 2-pixel push to plant the sprite's feet just below the floor line.
 */
function _floorRow(dist) {
  const wallH = H / Math.max(0.01, dist);
  return Math.floor(H / 2 + wallH / 2) + 2;
}
const MAX_SPRITE_DIST  = 28;  // hard max distance for any sprite
const MAX_ENEMY_DIST   = 26;
const MAX_DECOR_DIST   = 18;
const MAX_PICKUP_DIST  = 20;
const MAX_TORCH_DIST   = 10;
const MAX_PORTAL_DIST  = 28;
const MAX_PLASMA_DIST  = 24;

// Precomputed constants for angle wrap
const TWO_PI = Math.PI * 2;
const INV_TWO_PI = 1 / TWO_PI;

// Precomputed half-FOV cosine/tangent for the dot/cross frustum check.
// Recomputed whenever FOV changes (it never does at runtime, but guard anyway).
let _frustumFovKey   = null;
let _frustumDirX     = 1;   // cos(playerAngle) — updated each call
let _frustumDirY     = 0;   // sin(playerAngle)
let _frustumHalfTan  = 0;   // tan(HALF_FOV_CULL) — threshold for cross/dot ratio

/**
 * Fast frustum check using dot/cross products — uses BAM trig tables,
 * zero Math.sin/Math.cos calls.
 *
 * Returns the signed screen-space angle offset (used for screenX mapping),
 * or null if the sprite is outside the FOV or beyond maxDist.
 *
 * Strategy:
 *   dot   = dx*dirX + dy*dirY  → distance along view axis (must be > 0)
 *   cross = dx*dirY - dy*dirX  → signed lateral offset
 *   |cross/dot| <= tan(halfFov) means inside FOV
 *
 * We avoid atan2 entirely; the returned sa is Math.atan2(cross, dot) but only
 * computed for sprites that pass the cheap dot/cross test.
 *
 * dirX/dirY are resolved from the BAM sine/cosine tables (Int32 16.16 → float)
 * instead of calling Math.cos(playerAngle) / Math.sin(playerAngle) per sprite.
 */
function _inFrustum(dx, dy, playerAngle, maxDist) {
  const distSq = dx * dx + dy * dy;
  if (distSq > maxDist * maxDist) return null;

  // Lazily recompute tan(halfFov) threshold when FOV changes (practically never)
  if (_frustumFovKey !== HALF_FOV_CULL) {
    _frustumFovKey  = HALF_FOV_CULL;
    _frustumHalfTan = Math.tan(HALF_FOV_CULL);
  }

  // BAM lookup replaces Math.cos / Math.sin — table values are 16.16 fixed,
  // divide by FP_ONE to get the float direction vector.
  const bamAngle = radToBAM(playerAngle);
  const dirX = CosineTable[bamAngle] / FP_ONE;
  const dirY = SineTable[bamAngle]   / FP_ONE;

  const dot   =  dx * dirX + dy * dirY;  // forward component
  const cross = -dx * dirY + dy * dirX;  // lateral component (right = positive)

  // Sprite is behind the player
  if (dot <= 0) return null;

  // |cross| / dot > tan(halfFov)  →  outside FOV
  // Avoid division: |cross| > dot * tan(halfFov)
  const absC = cross < 0 ? -cross : cross;
  if (absC > dot * _frustumHalfTan) return null;

  // Only call atan2 for the small fraction that actually passed the cull.
  // This is the signed angle offset the caller needs for screenX placement.
  return Math.atan2(cross, dot);
}

// Dither pattern (4x4 Bayer matrix) — flattened Uint8Array for cache-friendly access.
// Index as: DITHER4[(y & 3) * 4 + (x & 3)]
const DITHER4 = new Uint8Array([
   0, 8, 2,10,
  12, 4,14, 6,
   3,11, 1, 9,
  15, 7,13, 5,
]);

// Gem door tint colors
const GEM_TINTS = {
  3: '220,40,40',   // red
  4: '40,200,60',   // green
  5: '40,100,220',  // blue
};

// Number of fog darkness buckets for the sprite precache (0 = bright, N-1 = darkest)
const FOG_BUCKETS = 16;

export class Renderer {
  constructor(canvas, ctx, assets, map, raycaster, weaponManager, enemyAnims) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.assets = assets;
    this.map = map;
    this.raycaster = raycaster;
    /** @type {import('./assets.js').WeaponSpriteManager|null} */
    this.weaponManager = weaponManager || null;
    // Legacy alias kept so any external code referencing .weaponSprites still compiles
    this.weaponSprites = {};
    this.enemyAnims = enemyAnims || {};
    this.hatBrimImg = null;  // set externally when hat is equipped
    this.playerHasHat = false;
    this.zBuffer = new Float32Array(NUM_RAYS);

    // ── Pre-allocated torch light buffer — avoids a new Float32Array every frame.
    // Zeroed with .fill(0) at the start of _computeTorchLight() each frame.
    this._torchLightBuf = new Float32Array(NUM_RAYS);

    // ── Wall framebuffer state — tracks whether the wall framebuffer is dirty
    // this frame and needs a putImageData flush before sprite drawing begins.
    this._wallFBDirty = false;

    // ── Per-frame wall-column texture pointer cache.
    // Reused between _drawWallColumn() calls to avoid repeated WeakMap lookups
    // for the same wall texture within one frame.
    // Reset at the top of each render() call.
    this._wallTexPixels = null;   // Uint32Array — current wall texture pixels
    this._wallTexImg    = null;   // HTMLImageElement — last img used (cache key)

    this._flickerTimer = 0;
    this._flickerVal = 1.0;
    this._frameCount = 0;
    this._time = 0;

    // Per-torch independent flicker values
    this._torchFlicker = [];
    // Per-brazier flicker values (indexed by decor idx)
    this._brazierFlicker = new Map();

    // Offscreen sprite canvas for fog compositing (reused each frame)
    this._spriteCanvas = document.createElement('canvas');
    this._spriteCanvas.width  = W;
    this._spriteCanvas.height = H;
    this._spriteCtx = this._spriteCanvas.getContext('2d');
    this._spriteCtx.imageSmoothingEnabled = false;

    // ── Sprite precache: Map<HTMLImageElement|HTMLCanvasElement, Canvas[FOG_BUCKETS]>
    // Each entry is an array of FOG_BUCKETS canvases baked at native image resolution.
    // Bucket 0 = no fog, bucket N-1 = near-total darkness.
    // Only static single-image sprites use this path; animated frame canvases do not.
    this._spriteCache = new Map();

    // ── Halo ImageData buffer — shared across torch + brazier halos each frame.
    // One putImageData replaces thousands of per-pixel fillRect calls.
    this._haloImageData = new ImageData(W, H);

    // ── Floor/ceiling texture sampling cache.
    // Texture Images stay live in assets.js / modeditor.js, so cache entries are
    // invalidated when src/currentSrc or dimensions change.
    this._flatTexCache = new WeakMap();
    this._flatCanvas = document.createElement('canvas');
    this._flatCtx = this._flatCanvas.getContext('2d', { willReadFrequently: true });
    this._flatImageData = null;
  }

  // ─────────────────────────────────────────────────────────
  // Precache phase — call once after Renderer is constructed,
  // before the first frame is rendered.
  // spriteList: array of HTMLImageElement (or HTMLCanvasElement).
  // For atlas sprites (gemKeys, decorSmall) the whole sheet is passed;
  // _drawSpriteIsolated handles the srcX/srcY sub-rect sampling from the baked canvas.
  // ───────────────────────────────���─────────────────────────
  precacheSprites(spriteList) {
    for (const img of spriteList) {
      if (!img) continue;
      // HTMLCanvasElement is always ready; HTMLImageElement may still be loading.
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) continue; // not loaded yet — skip (will fall back to live path)
      if (this._spriteCache.has(img)) continue; // already cached

      const buckets = [];
      for (let b = 0; b < FOG_BUCKETS; b++) {
        const dark = b / (FOG_BUCKETS - 1); // 0.0 … 1.0
        const cvs = document.createElement('canvas');
        cvs.width  = w;
        cvs.height = h;
        const cx = cvs.getContext('2d');
        cx.imageSmoothingEnabled = false;
        // Draw sprite at native resolution
        cx.drawImage(img, 0, 0, w, h);
        // Apply fog only to opaque pixels via source-atop
        if (dark > 0.01) {
          cx.globalCompositeOperation = 'source-atop';
          cx.fillStyle = `rgba(0,0,0,${dark.toFixed(3)})`;
          cx.fillRect(0, 0, w, h);
          cx.globalCompositeOperation = 'source-over';
        }
        buckets.push(cvs);
      }
      this._spriteCache.set(img, buckets);
    }
  }

  // Build the full list of static world sprite images from assets and precache them.
  // Weapon sprites live in WeaponSpriteManager (their own offscreen canvas) and
  // are intentionally excluded from the fog-bucket precache.
  // Called from initLevel after renderer construction.
  // Accepts both HTMLImageElement and HTMLCanvasElement — the latter arrives after
  // precacheTextures() hot-swaps original Images with 128×128 atlas proxy canvases.
  precacheAllSprites() {
    const imgs = [];
    for (const img of Object.values(this.assets)) {
      if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) imgs.push(img);
    }
    // Weapons are omitted here — they live on WeaponSpriteManager's private canvas.
    // Wait for images to load then cache — split into two passes so partially-loaded
    // assets get picked up once they're ready.
    const tryCache = () => this.precacheSprites(imgs);
    tryCache();
    // Re-run after a short delay to catch anything still loading at construction time
    setTimeout(tryCache, 800);
    setTimeout(tryCache, 2500);
  }

  /**
   * Draw a sprite image with fog/tint overlays and z-buffer column clipping.
   *
   * Fast path: if the overlay is pure fog darkness (applyOverlays === null or
   * the caller provides a _darkOnly hint via the 13th parameter), look up the
   * precached fog-baked canvas and blit directly — no per-frame offscreen clear.
   *
   * Slow path (live offscreen composite): used for complex overlays (pain flash,
   * boss glow, portal tint, etc.) where a simple darkness bake isn't enough.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLImageElement|HTMLCanvasElement} img
   * @param {number} left, top, width, height  — dest rect on main canvas
   * @param {number} dist                       — for z-buffer test
   * @param {function|null} applyOverlays       — callback(offCtx, l, t, w, h) or null
   * @param {number} [srcX] [srcY] [srcW] [srcH] — source sub-rect for atlas sprites
   * @param {number} [darkOnly]                 — if provided (0..1), use precache fast path
   *                                              with this darkness level instead of applyOverlays
   */
  _drawSpriteIsolated(ctx, img, left, top, width, height, dist, applyOverlays, srcX, srcY, srcW, srcH, darkOnly) {
    const clL = Math.max(0, left);
    const clR = Math.min(W, left + width);
    if (clL >= clR) return;
    let vis = false;
    for (let sx = clL; sx < clR; sx++) {
      if (this.zBuffer[sx] > dist) { vis = true; break; }
    }
    if (!vis) return;

    const oY = Math.max(0, top);
    const oH = Math.min(H, top + height) - oY;
    if (oH <= 0) return;

    const oX = left; // screen-space X origin of sprite

    // ── Fast path: precached fog bucket ──────────────────────────────────────
    // Use when: (a) no overlay at all, OR (b) overlay is pure darkness (_darkOnly hint).
    // Animated frame canvases (from SpriteSheet) typically aren't cached and fall through.
    const useDark = (darkOnly !== undefined) ? darkOnly : (applyOverlays === null ? 0 : -1);
    if (useDark >= 0) {
      const buckets = this._spriteCache.get(img);
      if (buckets) {
        // Pick the nearest fog bucket
        const bIdx = Math.round(Math.min(1, useDark) * (FOG_BUCKETS - 1));
        const baked = buckets[bIdx];
        const imgW  = baked.width;
        const imgH  = baked.height;
        // Compute the source sub-rect in the baked (native-res) canvas that maps
        // to the visible screen columns, accounting for atlas sub-rect if present.
        const scaleX = imgW / width;   // native px per screen px
        const scaleY = imgH / height;  // native px per screen px
        const atlasOffX = (srcX !== undefined) ? (srcX / (img.naturalWidth  || img.width)  * imgW) : 0;
        const atlasOffY = (srcY !== undefined) ? (srcY / (img.naturalHeight || img.height) * imgH) : 0;
        const atlasW    = (srcW !== undefined) ? (srcW / (img.naturalWidth  || img.width)  * imgW) : imgW;
        const atlasH    = (srcH !== undefined) ? (srcH / (img.naturalHeight || img.height) * imgH) : imgH;

        // Compute the vertical clip: oY is the clamped screen top, top may be negative
        // when the sprite overflows the top of the screen.  We must sample only the
        // visible slice of the baked image so the sprite is never squashed.
        const scaleYBaked = atlasH / height;          // baked rows per screen row
        const topClip     = oY - top;                  // screen rows cropped from the top
        const srcYStart   = atlasOffY + topClip * scaleYBaked;
        const srcYHeight  = oH * scaleYBaked;

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (let sx = clL; sx < clR; sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          const offX = sx - oX;               // column within dest sprite (0..width-1)
          const bakedX = atlasOffX + offX * (atlasW / width);
          ctx.drawImage(baked,
            bakedX, srcYStart, atlasW / width, srcYHeight,
            sx, oY, 1, oH);
        }
        ctx.restore();
        return;
      }
      // Cache miss (image not yet loaded at precache time) — fall through to live path
    }

    // ── Slow / live path: offscreen canvas composite ──────────────────────────
    const oW = width;
    const sc = this._spriteCtx;
    // Grow offscreen canvas as needed (never shrink — avoids realloc)
    if (this._spriteCanvas.width < oW || this._spriteCanvas.height < oH) {
      this._spriteCanvas.width  = Math.max(this._spriteCanvas.width,  oW);
      this._spriteCanvas.height = Math.max(this._spriteCanvas.height, oH);
      sc.imageSmoothingEnabled = false;
    }
    sc.clearRect(0, 0, oW, oH);

    const drawTop = top - oY;
    if (srcW !== undefined) {
      sc.drawImage(img, srcX, srcY, srcW, srcH, 0, drawTop, width, height);
    } else {
      sc.drawImage(img, 0, drawTop, width, height);
    }

    if (applyOverlays) {
      sc.globalCompositeOperation = 'source-atop';
      applyOverlays(sc, 0, drawTop, width, height);
      sc.globalCompositeOperation = 'source-over';
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let sx = clL; sx < clR; sx++) {
      if (this.zBuffer[sx] <= dist) continue;
      const offX = sx - oX;
      ctx.drawImage(this._spriteCanvas, offX, 0, 1, oH, sx, oY, 1, oH);
    }
    ctx.restore();
  }

  render(player, enemies, muzzleFlash, paused, projectiles, hitEffects, nearSecretWall, secretWallData, activeWeapon, bloodParticles, explosionEffects) {
    this._activeWeapon = activeWeapon;
    // Normalize activeWeapon to its string ID for FLASH_IDS lookups
    const activeWeaponId = (activeWeapon && typeof activeWeapon === 'object') ? activeWeapon.id : (activeWeapon || 'pistol');
    const ctx = this.ctx;
    this._frameCount++;
    this._time += 0.016;

    // ── Global flicker
    this._flickerTimer--;
    if (this._flickerTimer <= 0) {
      this._flickerVal = 0.82 + Math.random() * 0.18;
      this._flickerTimer = 2 + Math.floor(Math.random() * 4);
    }

    // ── Per-torch flicker
    const torches = this.map.torches || [];
    while (this._torchFlicker.length < torches.length) {
      this._torchFlicker.push({ val: 1.0, timer: 0 });
    }
    for (let i = 0; i < torches.length; i++) {
      const tf = this._torchFlicker[i];
      tf.timer--;
      if (tf.timer <= 0) {
        tf.val = 0.7 + Math.random() * 0.3;
        tf.timer = 2 + Math.floor(Math.random() * 5);
      }
    }

    // ── Per-brazier flicker (keyed by index in decor array)
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      if (!this._brazierFlicker.has(di)) {
        this._brazierFlicker.set(di, { val: 1.0, timer: 0 });
      }
      const bf = this._brazierFlicker.get(di);
      bf.timer--;
      if (bf.timer <= 0) {
        bf.val = 0.65 + Math.random() * 0.35;
        bf.timer = 2 + Math.floor(Math.random() * 5);
      }
    }

    ctx.imageSmoothingEnabled = false;

    // ── Raycasting — must happen before floor/ceiling so the flat caster
    // can use the same per-column ray angles as the wall pass.
    const hits = this.raycaster.castAll(player.x, player.y, player.angle, NUM_RAYS, FOV);
    this.lastHits = hits; // exposed for main.js _markFogLOS()

    // ── Reset per-frame wall state.
    // Zero-fill the entire framebuffer so floor/ceiling rows from a previous
    // frame don't persist as a Hall of Mirrors behind newly drawn wall columns.
    // This is a single typed-array memset — one operation for 256 KB.
    _wallFB.fill(0);
    this._wallTexImg    = null;
    this._wallTexPixels = null;
    this._wallFBDirty   = true;   // will be flushed after stickers
    _occlude.fill(0);

    // ── Ceiling + floor — write directly into _wallFB so they share the
    // single putImageData flush with the wall columns.
    // _drawTexturedFloorCeiling writes into _wallFB and returns true.
    // _drawCeiling/_drawFloor copy gradient LUT rows into _wallFB.
    if (!this._drawTexturedFloorCeiling(ctx, player)) {
      this._drawCeiling(ctx);
      this._drawFloor(ctx);
    }

    // ── Per-column torch light (includes braziers)
    const torchLight = this._computeTorchLight(player, torches, hits);
    this._torchLight = torchLight; // expose for boss green-glow interaction

    // ── Walls — overwrite wall-height rows in _wallFB
    for (let i = 0; i < NUM_RAYS; i++) {
      const hit = hits[i];
      this.zBuffer[i] = hit.dist;
      this._drawWallColumn(i, hit, player, torchLight[i]);
    }

    // ── Stickers (bullet holes, scorch marks) blit into _wallFB before flush
    this._drawWallStickers(hits);

    // ── Torch wall glows — additive orange bloom written into _wallFB so they
    // sit on the wall surface rather than floating in front of it.
    this._drawTorchWallGlows(torches, player);

    // ── Raycast-based torch + brazier light fill into floor/ceiling pixels
    this._drawTorchRaycastFill(torches, player);

    // ── Single putImageData for floor + ceiling + walls + stickers
    this._flushWallFB(ctx);

    // ── Floor halos under torches + braziers (braziers only now; torches use raycast fill)
    this._drawTorchFloorHalos(ctx, player, torches);
    this._drawBrazierFloorHalos(ctx, player);

    // ── Sprites (enemies + decor + pickups + torches + portal + projectiles)
    this._drawSprites(ctx, player, enemies, projectiles || []);

    // ── Blood particles (1×1 red pixels projected to screen)
    if (bloodParticles && bloodParticles.length > 0) {
      this._drawBloodParticles(ctx, player, bloodParticles);
    }

    // ── Cannon explosion effects (billboard sprite, squash→scale→fade)
    if (explosionEffects && explosionEffects.length > 0) {
      this._drawExplosions(ctx, player, explosionEffects);
    }

    // ── Muzzle flash sprite overlay (between world sprites and weapon layer) ──
    if (muzzleFlash && this.assets.muzzleFlash && FLASH_IDS.has(activeWeaponId)) {
      const flashIntensity = (typeof muzzleFlash === 'number') ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0;
      if (flashIntensity > 0 && this.assets.muzzleFlash.complete && this.assets.muzzleFlash.naturalWidth > 0) {
        const mf = this.assets.muzzleFlash;
        // Scale flash image to fill ~half the screen height, centered on canvas
        const mfH = Math.round(H * 0.5 * flashIntensity);
        const mfW = Math.round(mfH * (mf.naturalWidth / mf.naturalHeight));
        const mfX = Math.round(W / 2 - mfW / 2);
        const mfY = Math.round(H / 2 - mfH / 2 + 40);
        ctx.save();
        ctx.globalAlpha = Math.min(1, flashIntensity * 1.2);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(mf, mfX, mfY, mfW, mfH);
        ctx.restore();
      }
    }

    // ── Weapon (gun with sway, bob, tilt, kick) — muzzle flash is composited
    // directly onto the weapon offscreen canvas so it never touches #000 pixels
    this._drawGun(ctx, player, muzzleFlash);

    // ── Hat brim overlay (when hat is equipped)
    if (this.playerHasHat && this.hatBrimImg && this.hatBrimImg.complete && this.hatBrimImg.naturalWidth > 0) {
      ctx.drawImage(this.hatBrimImg, 0, 0, W, H);
    }

    // ── VGA scanlines
    this._drawScanlines(ctx);

    // ── Vignette
    this._drawVignette(ctx);

    // ── Secret wall USE prompt
    if (nearSecretWall && secretWallData && !secretWallData.opened) {
      const pulse = 0.7 + 0.3 * Math.sin(this._time * 6);

      let treasureLabel, treasureColor, borderColor;
      if (secretWallData.isGemDoor) {
        const colorNames = { red: 'RED', green: 'GREEN', blue: 'BLUE' };
        const cname = colorNames[secretWallData.gemColor] || 'GEM';
        treasureLabel = `the magical gem unlocks the door...`;
        const tintRgb = secretWallData.gemColor === 'red' ? '255,80,80'
                      : secretWallData.gemColor === 'green' ? '80,255,100'
                      : '80,150,255';
        treasureColor = `rgba(${tintRgb},${pulse})`;
        borderColor   = treasureColor;
      } else {
        treasureLabel = secretWallData.treasure === 'health' ? '[E] SECRET — HEALTH!'
                      : secretWallData.treasure === 'ammo'   ? '[E] SECRET — AMMO!'
                      :                                         '[E] SECRET — TREASURE!';
        treasureColor = secretWallData.treasure === 'health' ? `rgba(0,255,120,${pulse})`
                      : secretWallData.treasure === 'ammo'   ? `rgba(255,220,0,${pulse})`
                      :                                         `rgba(220,180,255,${pulse})`;
        borderColor   = secretWallData.treasure === 'health' ? `rgba(0,200,80,${pulse})`
                      : secretWallData.treasure === 'ammo'   ? `rgba(200,160,0,${pulse})`
                      :                                         `rgba(180,120,255,${pulse})`;
      }

      ctx.save();
      ctx.font = `bold 9px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = `rgba(0,0,0,${0.65 * pulse})`;
      ctx.fillRect(W / 2 - 50, H / 2 - 24, 100, 16);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(W / 2 - 50, H / 2 - 24, 100, 16);
      ctx.fillStyle = treasureColor;
      ctx.fillText(treasureLabel, W / 2, H / 2 - 12);
      ctx.restore();
    }

    // ── Pause overlay — solid black fill only; HTML menu draws UI on top
    if (paused) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Torch lighting computation (includes braziers)
  // Uses this._torchLightBuf — pre-allocated, zeroed at start of each call.
  // No heap allocation per frame.
  // ─────────────────────────────────────────────────────────
  _computeTorchLight(player, torches, hits) {
    // Reuse pre-allocated buffer — reset to zero with a single typed-array fill.
    const light = this._torchLightBuf;
    light.fill(0);

    const halfFov = FOV / 2;
    const TORCH_LIGHT_DIST = 8;
    const BRAZIER_LIGHT_DIST = 4;

    // BAM angle for the player — resolves dirX/dirY once for the whole loop.
    const bamAngle = radToBAM(player.angle);
    const dirX2 = CosineTable[bamAngle] / FP_ONE;
    const dirY2 = SineTable[bamAngle]   / FP_ONE;

    // ── Regular torches ──
    for (let i = 0; i < torches.length; i++) {
      const t = torches[i];
      const tf = this._torchFlicker[i] || { val: 1 };
      const flickerBrightness = tf.val;

      const dx = t.x - player.x;
      const dy = t.y - player.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > TORCH_LIGHT_DIST * TORCH_LIGHT_DIST) continue;
      const dist = Math.sqrt(distSq);

      // BAM-based dot/cross — no per-torch trig call.
      const dot2   =  dx * dirX2 + dy * dirY2;
      const cross2 = -dx * dirY2 + dy * dirX2;
      if (dot2 <= 0) continue;
      const ta = Math.atan2(cross2, dot2);
      if (Math.abs(ta) > halfFov + 0.5) continue;

      const torchBright = flickerBrightness * Math.max(0, 1 - dist / 6.0);
      const centerCol = Math.floor(((ta + halfFov) / FOV) * W);
      const radius = Math.floor(W * 0.75 * (1 - dist / TORCH_LIGHT_DIST));
      if (radius < 1) continue;

      const colStart = Math.max(0, centerCol - radius);
      const colEnd   = Math.min(W, centerCol + radius);
      for (let col = colStart; col < colEnd; col++) {
        const falloff = 1 - Math.abs(col - centerCol) / (radius + 1);
        const wallDist = hits[col] ? hits[col].dist : 256;
        if (dist < wallDist + 0.5) {
          light[col] = Math.max(light[col], torchBright * falloff);
        }
      }
    }

    // ── Braziers as light sources ──
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      const bf = this._brazierFlicker.get(di) || { val: 1 };

      const dx = d.x - player.x;
      const dy = d.y - player.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > BRAZIER_LIGHT_DIST * BRAZIER_LIGHT_DIST) continue;
      const dist = Math.sqrt(distSq);

      // Reuse the player BAM direction computed above.
      const dotB   =  dx * dirX2 + dy * dirY2;
      const crossB = -dx * dirY2 + dy * dirX2;
      if (dotB <= 0) continue;
      const ta = Math.atan2(crossB, dotB);
      if (Math.abs(ta) > halfFov + 0.6) continue;

      const brazBright = bf.val * Math.max(0, 1 - dist / 5.0) * 0.75;
      const centerCol = Math.floor(((ta + halfFov) / FOV) * W);
      const radius = Math.floor(W * 0.2 * (1 - dist / BRAZIER_LIGHT_DIST));
      if (radius < 1) continue;

      const colStart = Math.max(0, centerCol - radius);
      const colEnd   = Math.min(W, centerCol + radius);
      for (let col = colStart; col < colEnd; col++) {
        const falloff = 1 - Math.abs(col - centerCol) / (radius + 1);
        const wallDist = hits[col] ? hits[col].dist : 999;
        if (dist < wallDist + 0.5) {
          light[col] = Math.max(light[col], brazBright * falloff);
        }
      }
    }

    return light;
  }

  // ─────────────────────────────────────────────────────────
  // Ceiling + floor gradient — ImageData LUT path.
  // Per-row colors are baked into a Uint32Array once per theme change
  // (detected via a theme-key string), then written to the canvas as a
  // single putImageData call instead of H individual fillRect+string ops.
  // ─────────────────────────────────────────────────────────

  /** Invalidate gradient LUTs whenever the map/theme changes (call after level load) */
  invalidateGradientLUT() {
    this._gradLUTKey    = null;
    this._gradImageData = null;
  }

  /**
   * Bake (or re-bake) light-reach tables for all torches on the current map.
   * Call once after each level load, after map.torches is populated.
   * Each torch gets a _patchReach Float32Array and _patchFaceAngle stored on it,
   * so _drawTorchRaycastFill() can do pure table lookups with zero isWall calls.
   */
  rebakeTorchPatches() {
    const torches = this.map && this.map.torches;
    if (torches && torches.length) this.bakeTorchLightPatches(torches);
  }

  /**
   * Destroy all torches mounted on a wall tile that is being opened/removed.
   *
   * Call this at the same point you call raycaster.clearStickers() when a
   * secret wall opens (or any wall is destroyed).  It:
   *   1. Finds every torch whose backing wall tile matches (wallX/wallY, or
   *      falls back to adjacency scan for torches placed without a baked wallX).
   *   2. Removes those torches from map.torches (splice — keeps array compact).
   *   3. Keeps _torchFlicker in sync by splicing the same indices.
   *   4. Clears the wall sticker via raycaster.clearStickers().
   *   5. Rebakes the light-patch tables for the surviving torches so the
   *      newly-open space is reflected in reach distances.
   *
   * @param {number} wallMapX  - grid X of the wall tile being opened
   * @param {number} wallMapY  - grid Y of the wall tile being opened
   */
  destroyTorchesOnWall(wallMapX, wallMapY) {
    const torches = this.map && this.map.torches;
    if (!torches || torches.length === 0) return;

    // Collect indices to remove (iterate backwards so splice doesn't shift live indices).
    const toRemove = [];
    for (let i = 0; i < torches.length; i++) {
      const t  = torches[i];

      // Primary match: torch has a baked wallX/wallY pointing at this tile.
      if (t.wallX != null) {
        if (t.wallX === wallMapX && t.wallY === wallMapY) toRemove.push(i);
        continue;
      }

      // Fallback: torch has no baked wallX — check all 4 cardinal neighbours.
      // A torch is "on" this wall if any of its 4 adjacent tiles is the wall tile.
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      if (
        (gx === wallMapX && gy - 1 === wallMapY) ||
        (gx === wallMapX && gy + 1 === wallMapY) ||
        (gx - 1 === wallMapX && gy === wallMapY) ||
        (gx + 1 === wallMapX && gy === wallMapY)
      ) {
        toRemove.push(i);
      }
    }

    if (toRemove.length === 0) return;

    // Remove in reverse-index order so earlier splices don't shift later ones.
    for (let k = toRemove.length - 1; k >= 0; k--) {
      const i = toRemove[k];
      torches.splice(i, 1);
      // Keep _torchFlicker array in sync — same index, same length.
      if (this._torchFlicker.length > i) this._torchFlicker.splice(i, 1);
    }

    // Clear the wall sticker (also patches distToWall so DDA inner-face cull is correct).
    this.raycaster.clearStickers(wallMapX, wallMapY);

    // Rebake only the torches whose light patch could be affected by this wall opening.
    // A torch is dirty if the opened tile falls within its PATCH_REACH radius —
    // any further away and none of its baked rays could have been blocked by this tile.
    const reach = Renderer.PATCH_REACH;
    const wx = wallMapX + 0.5, wy = wallMapY + 0.5;  // centre of opened tile
    for (const t of torches) {
      const ddx = t.x - wx, ddy = t.y - wy;
      if (ddx * ddx + ddy * ddy <= reach * reach) this._bakeTorchPatch(t);
    }
  }

  /**
   * Invalidate the wall texture pixel cache for a specific image (or all images
   * if img is omitted).  Call this when ModEditor hot-swaps a wall texture so
   * the new pixels are re-sampled on the next frame.
   */
  invalidateTexCache(img) {
    if (img) {
      _texCache.delete(img);
    } else {
      // WeakMap has no .clear() — replace the module-level cache entries
      // by nuking the per-frame pointer so the next _drawWallColumn() misses.
      this._wallTexImg    = null;
      this._wallTexPixels = null;
      // Individual WeakMap entries will be GC'd when their keys (HTMLImageElements)
      // are re-assigned new src values by ModEditor.
    }
  }

  /** Lazily rebuild the ceiling+floor gradient ImageData if the theme changed */
  _rebuildGradientLUT() {
    const theme   = this.map.theme;
    const isAbom  = !!(this.map && this.map.isAbominationLevel);

    // Derive a cheap cache key from theme + abom flag
    const tKey = theme
      ? `${theme.ceiling}-${theme.ceilTop}-${theme.floorTint}-${isAbom}`
      : `default-${isAbom}`;

    if (this._gradLUTKey === tKey && this._gradImageData) return;
    this._gradLUTKey = tKey;

    // Ceiling colors
    let [cr, cg, cb] = theme ? theme.ceiling  : [8, 8, 12];
    let [tr, tg, tb] = theme ? theme.ceilTop  : [3, 3, 5];
    if (isAbom) { [cr, cg, cb] = [20, 4, 30]; [tr, tg, tb] = [8, 1, 14]; }

    // Floor colors
    let [fr, fg, fb] = theme ? theme.floorTint : [28, 20, 12];
    if (isAbom) { [fr, fg, fb] = [40, 8, 55]; }

    const mid  = Math.floor(H / 2);
    const imgd = new ImageData(W, H);
    const buf  = new Uint32Array(imgd.data.buffer);
    const isLE = (new Uint32Array(new Uint8Array([1,0,0,0]).buffer))[0] === 1;
    // In little-endian (virtually all platforms): buf word = AABBGGRR

    const pack = isLE
      ? (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0
      : (r, g, b) => ((r << 24) | (g << 16) | (b << 8) | 0xFF) >>> 0;

    // Ceiling rows (0 .. mid-1)
    for (let y = 0; y < mid; y++) {
      const t = y / mid;
      const r = (tr + t * (cr - tr)) | 0;
      const g = (tg + t * (cg - tg)) | 0;
      const b = (tb + t * (cb - tb)) | 0;
      const color = pack(r, g, b);
      const rowStart = y * W;
      for (let x = 0; x < W; x++) buf[rowStart + x] = color;
    }

    // Floor rows (mid .. H-1)
    const floorSpan = H - mid;
    for (let y = mid; y < H; y++) {
      const t = (y - mid) / floorSpan;
      const v = 1 - t * 0.65;
      const r = (fr * v) | 0;
      const g = (fg * v) | 0;
      const b = (fb * v) | 0;
      const color = pack(r, g, b);
      const rowStart = y * W;
      for (let x = 0; x < W; x++) buf[rowStart + x] = color;
    }

    this._gradImageData = imgd;
  }

  _drawCeiling(ctx) {
    this._rebuildGradientLUT();
    if (!this._gradImageData) return;
    // Copy ceiling rows from the gradient LUT directly into _wallFB.
    // putImageData is no longer called here — the combined flush happens in _flushWallFB().
    const src = new Uint32Array(this._gradImageData.data.buffer);
    const mid = Math.floor(H / 2);
    // Copy ceiling half (rows 0 .. mid-1) — typed set is a vectorised memcpy.
    _wallFB.set(src.subarray(0, mid * W), 0);
  }

  _drawFloor(ctx) {
    if (!this._gradImageData) return;
    // Copy floor rows from the gradient LUT directly into _wallFB.
    const src = new Uint32Array(this._gradImageData.data.buffer);
    const mid = Math.floor(H / 2);
    _wallFB.set(src.subarray(mid * W), mid * W);
  }

  // ─────────────────────────────────────────────────────────
  // Textured floor/ceiling casting — samples the live image assets directly.
  // This keeps ModEditor hot-swaps and FULL_RES_KEYS behavior intact.
  // ─────────────────────────────────────────────────────────

  _resolveFlatTextureKey(kind) {
    const theme = this.map && this.map.theme ? this.map.theme : null;
    const isCeil = kind === 'ceil';
    const themeName = String((theme && (
      theme.name ||
      theme.id ||
      theme.key ||
      theme.wallKey ||
      theme.wallTex ||
      theme.wallTexture ||
      theme.wall
    )) || '').toLowerCase();
    const isLibrary = themeName.includes('library');

    const explicitFloor = theme && (
      theme.floorTex ||
      theme.floorTexture ||
      theme.floorKey ||
      theme.floor
    );

    // Library ceilings need the old floor-style flat projection instead of the
    // wall-material ceiling projection. Reuse the library floor texture unless
    // the theme explicitly provides a ceiling texture/key.
    if (isCeil && isLibrary) {
      const explicitCeil = theme && (
        theme.ceilTex ||
        theme.ceilingTex ||
        theme.ceilTexture ||
        theme.ceilingTexture ||
        theme.ceilKey ||
        theme.ceilingKey
      );
      if (explicitCeil && this.assets[explicitCeil]) return explicitCeil;
      if (explicitFloor && this.assets[explicitFloor]) return explicitFloor;
      if (this.assets.floorLibrary) return 'floorLibrary';
    }

    // Non-library ceilings intentionally use the active wall texture so each
    // biome feels boxed-in by the same material.
    if (isCeil) {
      const wallKey = theme && (theme.wallKey || theme.wallTex || theme.wallTexture || theme.wall);
      if (wallKey && this.assets[wallKey]) return wallKey;
      return this.assets.wall ? 'wall' : null;
    }

    if (explicitFloor && this.assets[explicitFloor]) return explicitFloor;

    // Sensible defaults for the current three shipped floor textures.
    if (this.map && this.map.isAbominationLevel && this.assets.floorAbomination) return 'floorAbomination';

    if (isLibrary && this.assets.floorLibrary) return 'floorLibrary';
    if ((themeName.includes('cave') || themeName.includes('dungeon')) && this.assets.floorCave) return 'floorCave';

    return this.assets.floorCave ? 'floorCave' : (this.assets.floor ? 'floor' : null);
  }

  _getFlatTextureData(img) {
    if (!img) return null;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w <= 0 || h <= 0) return null;
    if (img instanceof HTMLImageElement && (!img.complete || img.naturalWidth <= 0)) return null;

    const srcKey = (img.currentSrc || img.src || 'canvas') + `|${w}x${h}`;
    const cached = this._flatTexCache.get(img);
    if (cached && cached.key === srcKey) return cached;

    this._flatCanvas.width = w;
    this._flatCanvas.height = h;
    this._flatCtx.clearRect(0, 0, w, h);
    this._flatCtx.drawImage(img, 0, 0, w, h);
    const data = this._flatCtx.getImageData(0, 0, w, h).data;
    const entry = { key: srcKey, w, h, data };
    this._flatTexCache.set(img, entry);
    return entry;
  }

  _drawTexturedFloorCeiling(ctx, player) {
    const floorKey = this._resolveFlatTextureKey('floor');
    const ceilKey  = this._resolveFlatTextureKey('ceil');
    const floorTex = this._getFlatTextureData(floorKey ? this.assets[floorKey] : null);
    const ceilTex  = this._getFlatTextureData(ceilKey ? this.assets[ceilKey] : null);
    if (!floorTex && !ceilTex) return false;

    const mid = Math.floor(H / 2);

    // Write directly into the shared _wallFB (Uint32Array) so floor/ceiling and
    // wall columns share a single putImageData flush.
    // We need a Uint8ClampedArray view for the per-component writes below;
    // reuse _flatImageData as the byte-addressed alias of _wallFB.
    if (!this._flatImageData || this._flatImageData.width !== W || this._flatImageData.height !== H) {
      this._flatImageData = new ImageData(W, H);
    }
    // Point `out` at the _wallFB byte view so writes go directly into the
    // shared framebuffer. _wallFB and _wallImageData share the same buffer.
    const out = _wallImageData.data;

    // Fill with the old gradient first so missing/late-loading ceiling or floor
    // texture still has a valid background half.
    this._rebuildGradientLUT();
    if (this._gradImageData) out.set(this._gradImageData.data);

    // Optimized floor casting:
    // - Compute the left/right ray vectors once per frame.
    // - Walk each scanline incrementally instead of calling sin/cos per pixel.
    // This keeps the visual result equivalent but removes the worst inner-loop cost.
    const halfFov = FOV / 2;
    const leftAngle  = player.angle - halfFov;
    const rightAngle = player.angle + halfFov;
    const rayLeftX   = Math.cos(leftAngle);
    const rayLeftY   = Math.sin(leftAngle);
    const rayRightX  = Math.cos(rightAngle);
    const rayRightY  = Math.sin(rightAngle);
    const raySpanX   = rayRightX - rayLeftX;
    const raySpanY   = rayRightY - rayLeftY;

    const eyeHeight = H / 2;
    const maxFlatDist = 18;
    const ditherScale = 0.75;

    const floorMaskX = floorTex && ((floorTex.w & (floorTex.w - 1)) === 0) ? floorTex.w - 1 : -1;
    const floorMaskY = floorTex && ((floorTex.h & (floorTex.h - 1)) === 0) ? floorTex.h - 1 : -1;
    const ceilMaskX  = ceilTex  && ((ceilTex.w  & (ceilTex.w  - 1)) === 0) ? ceilTex.w  - 1 : -1;
    const ceilMaskY  = ceilTex  && ((ceilTex.h  & (ceilTex.h  - 1)) === 0) ? ceilTex.h  - 1 : -1;

    // Draw paired floor/ceiling rows from the horizon outward. Floor and ceiling
    // at the same distance share the same projected world coordinates, so the
    // world-space walk is computed once and sampled for whichever textures exist.
    for (let dy = 1; dy <= mid; dy++) {
      const yFloor = mid + dy;
      const yCeil  = mid - dy;
      if (yFloor >= H && yCeil < 0) break;

      const rowDist = eyeHeight / dy;
      const stepX = (rowDist * raySpanX) / W;
      const stepY = (rowDist * raySpanY) / W;
      let wx = player.x + rowDist * rayLeftX;
      let wy = player.y + rowDist * rayLeftY;

      const baseShade = Math.max(0.18, 1.0 - rowDist / maxFlatDist);
      const floorShade = baseShade * 0.86;
      const ceilShade  = baseShade * 0.58;

      const floorRowStart = yFloor * W * 4;
      const ceilRowStart  = yCeil  * W * 4;

      for (let x = 0; x < W; x++, wx += stepX, wy += stepY) {
        // Fractional tile coordinate via integer truncation (fast for positive
        // and negative values alike — INT_BIAS keeps us positive).
        // 4096 gives plenty of room for rowDist * raySpan values at this scale.
        const INT_BIAS = 4096;
        const fx = (wx + INT_BIAS) - ((wx + INT_BIAS) | 0);
        const fy = (wy + INT_BIAS) - ((wy + INT_BIAS) | 0);

        if (floorTex && yFloor < H) {
          let tx = (fx * floorTex.w) | 0;
          let ty = (fy * floorTex.h) | 0;
          if (floorMaskX >= 0) tx &= floorMaskX; else tx %= floorTex.w;
          if (floorMaskY >= 0) ty &= floorMaskY; else ty %= floorTex.h;
          const si = (ty * floorTex.w + tx) * 4;
          const di = floorRowStart + x * 4;
          const d = (DITHER4[(yFloor & 3) * 4 + (x & 3)] - 7.5) * ditherScale;
          const r = Math.max(0, Math.min(255, floorTex.data[si]     * floorShade + d));
          const g = Math.max(0, Math.min(255, floorTex.data[si + 1] * floorShade + d));
          const b = Math.max(0, Math.min(255, floorTex.data[si + 2] * floorShade + d));
          out[di]     = (r >> 3) << 3;
          out[di + 1] = (g >> 3) << 3;
          out[di + 2] = (b >> 3) << 3;
          out[di + 3] = 255;
        }

        if (ceilTex && yCeil >= 0) {
          let tx = (fx * ceilTex.w) | 0;
          let ty = (fy * ceilTex.h) | 0;
          if (ceilMaskX >= 0) tx &= ceilMaskX; else tx %= ceilTex.w;
          if (ceilMaskY >= 0) ty &= ceilMaskY; else ty %= ceilTex.h;
          const si = (ty * ceilTex.w + tx) * 4;
          const di = ceilRowStart + x * 4;
          const d = (DITHER4[(yCeil & 3) * 4 + (x & 3)] - 7.5) * ditherScale;
          const r = Math.max(0, Math.min(255, ceilTex.data[si]     * ceilShade + d));
          const g = Math.max(0, Math.min(255, ceilTex.data[si + 1] * ceilShade + d));
          const b = Math.max(0, Math.min(255, ceilTex.data[si + 2] * ceilShade + d));
          out[di]     = (r >> 3) << 3;
          out[di + 1] = (g >> 3) << 3;
          out[di + 2] = (b >> 3) << 3;
          out[di + 3] = 255;
        }
      }
    }

    // No ctx.putImageData here — floor/ceiling pixels now live in _wallFB and
    // will be flushed together with wall columns in _flushWallFB().
    return true;
  }

  // ─────────────────────────────────────────────────────────
  // Wall rendering — Uint32Array framebuffer path.
  //
  // All 320 wall columns are written into the module-level _wallFB
  // (Uint32Array backed by _wallImageData) during the wall loop in render().
  // A single ctx.putImageData(_wallImageData, 0, 0) at the end of the wall
  // pass replaces ~320 individual drawImage / fillRect calls per frame.
  //
  // Texture sampling uses affine stepping (spec §15):
  //   texStep = wallTexH / wallH   (integer, pre-divided once per column)
  //   texPos += texStep            (one add per pixel — no per-pixel divide)
  //   texY = texPos >> 8           (shift instead of divide)
  //
  // The texture is sampled from a Uint32Array (_texCache) built once per
  // unique wall image, so all pixel reads are flat typed-array accesses.
  //
  // After all wall columns are flushed, stickers (bullet holes, scorch marks,
  // torch wall-plates) are blitted directly into the same framebuffer before
  // the single putImageData call.
  // ─────────────────────────────────────────────────────────

  /**
   * Resolve a wall image to a Uint32Array pixel cache (built once per image).
   * Returns null if the image is not yet loaded.
   */
  _getTexPixels(img) {
    if (!img || !(img.complete || img instanceof HTMLCanvasElement)) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (w <= 0 || h <= 0) return null;

    const cached = _texCache.get(img);
    if (cached) return cached;

    // Rasterize to an offscreen canvas and read pixels as Uint32Array.
    const oc  = document.createElement('canvas');
    oc.width  = w;
    oc.height = h;
    const ox  = oc.getContext('2d', { willReadFrequently: true });
    ox.imageSmoothingEnabled = false;
    ox.drawImage(img, 0, 0, w, h);
    const id  = ox.getImageData(0, 0, w, h);
    const buf = new Uint32Array(id.data.buffer);
    _texCache.set(img, buf);
    return buf;
  }

  /**
   * Flush the wall framebuffer to the canvas.
   * Called once per frame after all wall columns are written and stickers drawn.
   */
  _flushWallFB(ctx) {
    if (!this._wallFBDirty) return;
    ctx.putImageData(_wallImageData, 0, 0);
    this._wallFBDirty = false;
  }

  /**
   * Draw a single wall column into the _wallFB framebuffer.
   * Replaces the old _drawWallSlice (ctx.drawImage per column) path.
   *
   * After all columns are done, call _drawWallStickers() then _flushWallFB().
   */
  _drawWallColumn(col, hit, player, torchAdd) {
    const dist   = Math.max(0.1, hit.dist);
    const wallH  = Math.floor(H / dist);
    const top    = Math.floor((H - wallH) / 2);
    const bottom = top + wallH;

    const cellVal   = this.map.getCell(hit.mapX, hit.mapY);
    const isExitWall = (cellVal === 2);
    const isGemDoor  = (cellVal === 3 || cellVal === 4 || cellVal === 5);

    // Brightness (distance + side + torch)
    let brightness = this._flickerVal;
    brightness /= (1 + dist * 0.18);
    if (hit.side === 1) brightness *= 0.7;
    brightness = Math.min(1.2, brightness + (torchAdd || 0) * 0.5);
    const dark = Math.max(0, 1 - brightness);

    // Wall texture selection
    const theme = this.map.theme;
    let wallImg = this.assets.wall;
    if (theme) wallImg = this.assets[theme.wallKey] || this.assets.wall;
    if (isGemDoor && this.assets.wallDoor &&
        this.assets.wallDoor.complete && this.assets.wallDoor.naturalWidth > 0) {
      wallImg = this.assets.wallDoor;
    }

    // ── Texture pixels (Uint32Array) from cache ──────────────────────────────
    // Cache the last-used image pointer so repeated lookups for the same
    // texture (all 320 columns often share one image) cost nothing.
    let texPixels = null;
    let imgW = 0, imgH = 0;
    if (wallImg && wallImg.complete && wallImg.naturalWidth > 0) {
      if (wallImg !== this._wallTexImg) {
        this._wallTexImg    = wallImg;
        this._wallTexPixels = this._getTexPixels(wallImg);
      }
      texPixels = this._wallTexPixels;
      imgW = wallImg.naturalWidth  || wallImg.width;
      imgH = wallImg.naturalHeight || wallImg.height;
    }

    // ── Gem door / secret wall shimmer color ─────────────────────────────────
    let shimR = 0, shimG = 0, shimB = 0, shimA = 0;
    if (isExitWall) {
      const sw = (this.map.secretWalls || []).find(s => s.x === hit.mapX && s.y === hit.mapY);
      if (sw && !sw.opened) {
        shimA = 0.06 + 0.04 * Math.sin(this._time * 3.7 + hit.mapX * 1.3);
        shimR = 200; shimG = 140; shimB = 30;
      }
    } else if (isGemDoor) {
      const gd = (this.map.gemDoors || []).find(d => d.x === hit.mapX && d.y === hit.mapY);
      if (gd && !gd.opened) {
        shimA = 0.12 + 0.08 * Math.sin(this._time * 4.5 + hit.mapX * 2.1 + hit.mapY * 1.7) + 0.18;
        const rgb = GEM_TINTS[cellVal] || '200,200,200';
        const parts = rgb.split(',');
        shimR = parseInt(parts[0], 10);
        shimG = parseInt(parts[1], 10);
        shimB = parseInt(parts[2], 10);
      }
    }

    // Torch tint scalars (applied as an additive orange blend)
    const tAdd = (torchAdd || 0);

    // ── Per-pixel column write into _wallFB ──────────────────────────────────
    // Affine texture stepping: compute texStep once, then just add per row.
    // texPos is a Q24.8 fixed-point counter (<<8 precision).
    if (texPixels) {
      // Texture U coordinate (column within the texture)
      const texX = Math.min((hit.wallX * imgW) | 0, imgW - 1);

      // Vertical texture stepping — Q8 fixed-point (spec §15)
      const texStep = (imgH << 8) / Math.max(1, wallH);
      // Start position: if top < 0 the wall extends above the screen;
      // we must skip the off-screen top portion.
      let texPos = (top < 0) ? ((-top) * texStep) : 0;

      const yStart = Math.max(0, top);
      const yEnd   = Math.min(H, bottom);

      for (let y = yStart; y < yEnd; y++) {
        const texY = (texPos >> 8) & (imgH - 1 < TEX_MASK ? imgH - 1 : TEX_MASK);
        // Clamp texY to valid range (image may not be power-of-two)
        const clampedTexY = texY >= imgH ? imgH - 1 : texY;

        // Read source pixel — RGBA as Uint32 (little-endian: 0xAABBGGRR)
        let px32 = texPixels[clampedTexY * imgW + texX];

        // Extract channels
        let r = ( px32        & 0xFF);
        let g = ((px32 >>  8) & 0xFF);
        let b = ((px32 >> 16) & 0xFF);

        // Distance darkness
        if (dark > 0.02) {
          const invBright = 1 - dark;
          r = (r * invBright) | 0;
          g = (g * invBright) | 0;
          b = (b * invBright) | 0;
        }

        // Shimmer blend (gem doors / secret walls)
        if (shimA > 0.01) {
          r = Math.min(255, r + (shimR * shimA) | 0);
          g = Math.min(255, g + (shimG * shimA) | 0);
          b = Math.min(255, b + (shimB * shimA) | 0);
        }

        // Torch tint — additive orange
        if (tAdd > 0.05) {
          const ta = tAdd * 0.22;
          r = Math.min(255, r + (255 * ta) | 0);
          g = Math.min(255, g + (160 * ta) | 0);
          b = Math.min(255, b + ( 40 * ta) | 0);
        }

        _wallFB[y * W + col] = _packRGB(r, g, b);
        texPos += texStep;
      }
    } else {
      // Fallback: flat-shaded column when texture is missing / loading
      const v = Math.floor(brightness * 160);
      const flatPx = _packRGB(v, (v * 0.8) | 0, (v * 0.6) | 0);
      const yStart = Math.max(0, top);
      const yEnd   = Math.min(H, bottom);
      for (let y = yStart; y < yEnd; y++) {
        _wallFB[y * W + col] = flatPx;
      }
    }

    this._wallFBDirty = true;

    // Record z-buffer entry (needed by sticker / sprite systems)
    this.zBuffer[col] = dist;

    // Update 1D occlusion buffer (spec §17 — used for sticker span clipping)
    _occlude[col] = 1;
  }

  // ─────────────────────────────────────────────────────────
  // Sticker projection — draw raycaster stickers (bullet holes, scorch marks)
  // directly into _wallFB before the single putImageData flush.
  //
  // Each sticker has segment-space coordinates (offset_u, offset_y) already
  // baked in from raycaster.attachSticker() — no per-frame world reprojection.
  //
  // For each hit column we check if the hit tile has stickers, then
  // project their offset_u into screen X and blit a tiny rectangle.
  // ─────────────────────────────────────────────────────────
  _drawWallStickers(hits) {
    if (!this.raycaster.stickers) return;

    for (let col = 0; col < NUM_RAYS; col++) {
      const hit = hits[col];
      if (!hit || hit.dist >= 23.9) continue;  // skip no-hit sentinel (MAX_DIST=24)

      const stickers = this.raycaster.getStickers(hit.mapX, hit.mapY);
      if (!stickers || stickers.length === 0) continue;

      const dist   = Math.max(0.1, hit.dist);
      const wallH  = Math.floor(H / dist);
      const wallTop = Math.floor((H - wallH) / 2);

      for (const stk of stickers) {
        // Face cull: the sticker was placed on one specific face of this wall tile.
        // stk.fromX/fromY is the open-space neighbor tile that face is visible from,
        // which exactly matches hit.prevMapX/prevMapY (the tile the DDA ray was in
        // just before it crossed into this wall).  Reject any ray that came from a
        // different neighbor — i.e. a different face of the same tile.
        // Legacy stickers without fromX (fromX == null) skip the check for safety.
        if (stk.fromX != null && (hit.prevMapX !== stk.fromX || hit.prevMapY !== stk.fromY)) continue;

        // Horizontal match: sticker's offset_u should be close to hit.wallX.
        // offset_u is in [0, FP_ONE]; hit.wallX is in [0, 1).
        const stickerU = stk.offset_u / FP_ONE;
        const du = Math.abs(hit.wallX - stickerU);
        // Accept columns within half the sticker width (in texture-space)
        const halfW = (stk.width / FP_ONE) * 0.5;
        if (du > halfW) continue;

        // Vertical center in screen pixels
        const stickerY_frac = stk.offset_y / FP_ONE; // 0=bottom, 1=top
        const stickerScreenY = wallTop + Math.floor((1 - stickerY_frac) * wallH);

        // Sticker pixel height on screen
        const stickerH_screen = Math.max(2, Math.floor((stk.height / FP_ONE) * wallH));
        const halfH = stickerH_screen >> 1;

        const yStart = Math.max(0, stickerScreenY - halfH);
        const yEnd   = Math.min(H, stickerScreenY + halfH);

        // Try to read pixels from the sticker texture via assets
        const stkImg = this.assets[stk.tex_id];
        const stkPixels = stkImg ? this._getTexPixels(stkImg) : null;

        if (stkPixels) {
          const sw = stkImg.naturalWidth  || stkImg.width;
          const sh = stkImg.naturalHeight || stkImg.height;
          // Map column offset → texture U.
          // The sticker spans wallX in [stickerU - halfW, stickerU + halfW].
          // Map that range linearly to texture U in [0, 1].
          const localU = (hit.wallX - (stickerU - halfW)) / (halfW * 2 + 1e-6);
          const texX = Math.max(0, Math.min(sw - 1, (localU * sw) | 0));
          const vStep = (sh << 8) / Math.max(1, stickerH_screen);
          let vPos = ((yStart - (stickerScreenY - halfH)) * vStep);

          for (let y = yStart; y < yEnd; y++) {
            const texY = Math.min(sh - 1, vPos >> 8);
            const stkPx = stkPixels[texY * sw + texX];
            // Alpha-blend sticker over wall (simple 50% for decals)
            // Skip near-transparent pixels (alpha < 64 in source)
            const alpha = (stkPx >>> 24) & 0xFF;
            if (alpha < 64) { vPos += vStep; continue; }

            const wallIdx = y * W + col;
            const wp = _wallFB[wallIdx];
            const wr = ( wp        & 0xFF);
            const wg = ((wp >>  8) & 0xFF);
            const wb = ((wp >> 16) & 0xFF);
            const sr = ( stkPx        & 0xFF);
            const sg = ((stkPx >>  8) & 0xFF);
            const sb = ((stkPx >> 16) & 0xFF);
            const t  = alpha / 255;
            _wallFB[wallIdx] = _packRGB(
              (wr + (sr - wr) * t) | 0,
              (wg + (sg - wg) * t) | 0,
              (wb + (sb - wb) * t) | 0,
            );
            vPos += vStep;
          }
        } else if (!stkImg) {
          // Fallback: solid dark scorch rectangle — only when no asset is registered
          // at all for this tex_id.  If stkImg exists but isn't loaded yet, skip
          // silently so the wall beneath shows rather than a false soot patch.
          const sootPx = _packRGB(12, 8, 6);
          for (let y = yStart; y < yEnd; y++) {
            _wallFB[y * W + col] = sootPx;
          }
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Legacy _drawWallSlice — kept as a no-op shim so any external
  // call sites compiled before this refactor don't crash at runtime.
  // The real wall drawing now happens in _drawWallColumn().
  // ─────────────────────────────────────────────────────────
  _drawWallSlice(ctx, col, hit, player, torchAdd) {
    // Redirects to the framebuffer path — ctx argument is kept for API compat.
    this._drawWallColumn(col, hit, player, torchAdd);
  }

  // ─────────────────────────────────────────────────────────
  // Floor halos — torch + brazier, unified ImageData path.
  //
  // The original approach called ctx.fillRect(px, py, 1, 1) + ctx.fillStyle
  // once per visible pixel.  When the player stands inside a halo, haloDist
  // approaches 0, haloW/haloH scale as 1/dist and can cover hundreds of pixels,
  // generating thousands of Canvas API round-trips per halo per frame.
  //
  // New approach: accumulate all halo pixels into a single Uint8ClampedArray
  // (additively, so overlapping halos brighten correctly), then emit exactly
  // one ctx.putImageData call for the entire halo layer.  The buffer is cleared
  // with a single TypedArray.fill(0) — one memset vs N×M string allocations.
  //
  // Halo dimensions are hard-capped so standing inside a source can't make the
  // inner loop arbitrarily large.
  // ─────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────
  // Baked torch light patches — call once per level load.
  //
  // For every torch, cast N_PATCH_RAYS rays in a hemispherical fan aligned
  // to the torch face normal and DDA-march each ray until it hits a wall.
  // Store the per-ray reach distance in a Float32Array on the torch object.
  // This is the only moment isWall() is called for torch lighting; render
  // time is a single array lookup per floor pixel.
  //
  // Also stores faceAngle and the angular span so the render loop can do
  // a fast in-range check without any trig.
  // ─────────────────────────────────────────────────────────
  static N_PATCH_RAYS  = 64;    // angular resolution of the baked reach table
  static PATCH_REACH   = 7;     // world-unit hard limit (same as old MAX_REACH)
  static PATCH_FOV     = Math.PI * 1.05; // slightly over 180° so corners aren't clipped

  bakeTorchLightPatches(torches) {
    for (let ti = 0; ti < torches.length; ti++) {
      this._bakeTorchPatch(torches[ti]);
    }
  }

  /**
   * Bake (or re-bake) the light-reach table for a single torch.
   * Called by bakeTorchLightPatches (full bake at level load) and by
   * destroyTorchesOnWall (targeted dirty-patch after a wall opens).
   */
  _bakeTorchPatch(t) {
    const N    = Renderer.N_PATCH_RAYS;
    const HALF = Renderer.PATCH_FOV / 2;
    const STEP = 0.12;

    // Resolve face normal (mapgen always supplies normX/normY; guard anyway)
    let normX = t.normX, normY = t.normY;
    if (normX == null) {
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      normX = 0; normY = 1;
      const nb = [[gx,gy-1,0,-1],[gx,gy+1,0,1],[gx-1,gy,-1,0],[gx+1,gy,1,0]];
      for (const [nx,ny,ndx,ndy] of nb) {
        if (this.map.isWall(nx, ny)) { normX = -ndx; normY = -ndy; break; }
      }
    }
    const faceAngle = Math.atan2(normY, normX);

    const ox = t.x - normX * 0.5;
    const oy = t.y - normY * 0.5;
    t._patchOx       = ox;
    t._patchOy       = oy;
    t._patchFaceAngle = faceAngle;

    if (!t._patchReach || t._patchReach.length !== N) {
      t._patchReach = new Float32Array(N);
    }

    for (let ri = 0; ri < N; ri++) {
      const relAngle = -HALF + (ri / (N - 1)) * Renderer.PATCH_FOV;
      const rayAngle = faceAngle + relAngle;
      const rdx = Math.cos(rayAngle);
      const rdy = Math.sin(rayAngle);

      let reach = 0;
      while (reach < Renderer.PATCH_REACH) {
        reach += STEP;
        if (this.map.isWall(ox + rdx * reach, oy + rdy * reach)) { reach -= STEP; break; }
      }
      t._patchReach[ri] = reach;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Torch floor+wall patch — replaces _drawTorchRaycastFill.
  //
  // Uses the pre-baked per-torch reach tables (no isWall calls at render time).
  // For each floor scanline pixel, the world position is computed via the same
  // incremental floor-caster walk used by _drawTexturedFloorCeiling.  The angle
  // from the torch is quantised to a reach-table bucket; if the pixel's distance
  // is within reach, an additive orange tint is blended into _wallFB.
  //
  // A thin wall-face strip (bottom ~35% of the torch's wall column band) also
  // receives the patch tint so the light appears to project onto both surfaces
  // simultaneously — matching how real torch sconces bleed onto the floor below.
  //
  // All writes go into _wallFB before the single putImageData flush.
  // Zero per-frame isWall calls.  Zero heap allocations.
  // ─────────────────────────────────────────────────────────
  _drawTorchRaycastFill(torches, player) {
    if (!torches.length) return;

    const N        = Renderer.N_PATCH_RAYS;
    const REACH    = Renderer.PATCH_REACH;
    const HALF_FOV_PATCH = Renderer.PATCH_FOV / 2;
    const INV_PATCH_SPAN = (N - 1) / Renderer.PATCH_FOV;

    const out      = _wallImageData.data;   // Uint8ClampedArray alias of _wallFB
    const halfFov  = FOV / 2;
    const mid      = (H / 2) | 0;
    const eyeH     = H / 2;

    // Row-distance cache — build lazily, same formula as floor caster
    if (!this._rowDistCache || this._rowDistCache.length !== mid + 1) {
      this._rowDistCache = new Float32Array(mid + 1);
      for (let dy = 1; dy <= mid; dy++) this._rowDistCache[dy] = eyeH / dy;
    }
    const rowDist = this._rowDistCache;

    // Player floor-ray vectors (same as _drawTexturedFloorCeiling)
    const leftAngle = player.angle - halfFov;
    const rayLX = Math.cos(leftAngle),  rayLY = Math.sin(leftAngle);
    const rayRX = Math.cos(player.angle + halfFov), rayRY = Math.sin(player.angle + halfFov);
    const spanX = rayRX - rayLX,        spanY = rayRY - rayLY;

    for (let ti = 0; ti < torches.length; ti++) {
      const t  = torches[ti];
      const tf = this._torchFlicker[ti] || { val: 1 };
      if (tf.val < 0.02) continue;

      // Bail early if torch is too far to cast any visible light
      const tdx = t.x - player.x, tdy = t.y - player.y;
      const tDistSq = tdx * tdx + tdy * tdy;
      if (tDistSq > (REACH + 1) * (REACH + 1)) continue;

      // Ensure reach table exists (guard against a level that skips bakeTorchLightPatches)
      if (!t._patchReach) this._bakeTorchPatch(t);

      const reach     = t._patchReach;
      const faceAngle = t._patchFaceAngle;
      const ox        = t._patchOx;
      const oy        = t._patchOy;

      // ── Floor scanlines ────────────────────────────────────────────────────
      for (let dy = 1; dy <= mid; dy++) {
        const yFloor = mid + dy;
        if (yFloor >= H) break;
        const rd = rowDist[dy];
        if (rd > REACH + 0.5) continue;

        const stepX = (rd * spanX) / W;
        const stepY = (rd * spanY) / W;
        let wx = player.x + rd * rayLX;
        let wy = player.y + rd * rayLY;
        const dithRow = (yFloor & 3) * 4;

        for (let x = 0; x < W; x++, wx += stepX, wy += stepY) {
          // Z-buffer cull — floor pixel is behind a wall from the player's POV
          // if the wall in this column is closer than the floor distance.
          if (rd > this.zBuffer[x]) continue;

          const fx = wx - ox, fy = wy - oy;
          // Fast distance-squared pre-reject (avoids sqrt for distant pixels)
          const fdistSq = fx * fx + fy * fy;
          if (fdistSq > REACH * REACH) continue;

          // Convert pixel angle relative to face normal → reach table index
          let relAngle = Math.atan2(fy, fx) - faceAngle;
          if (relAngle >  Math.PI) relAngle -= Math.PI * 2;
          if (relAngle < -Math.PI) relAngle += Math.PI * 2;
          if (relAngle < -HALF_FOV_PATCH || relAngle > HALF_FOV_PATCH) continue;

          // Reach table lookup — quantise relAngle to bucket, compare distance
          const ri      = Math.max(0, Math.min(N - 1, ((relAngle + HALF_FOV_PATCH) * INV_PATCH_SPAN) | 0));
          const fdist   = Math.sqrt(fdistSq);
          if (fdist > reach[ri]) continue;

          // Falloff + dither gate (same formula as original)
          const falloff = (1 - fdist / REACH) * tf.val;
          const a255    = (falloff * 80 + 0.5) | 0;
          if (a255 <= 0) continue;
          if (DITHER4[dithRow + (x & 3)] > (falloff * 10 + 0.5) | 0) continue;

          // Additive orange tint into _wallFB byte view
          const di = (yFloor * W + x) * 4;
          out[di]     = Math.min(255, out[di]     + ((255 * a255) >> 8));
          out[di + 1] = Math.min(255, out[di + 1] + ((160 * a255) >> 8));
          out[di + 2] = Math.min(255, out[di + 2] + (( 20 * a255) >> 8));
        }
      }

      // ── Wall-face base strip ───────────────────────────────────────────────
      // Tint the bottom ~35% of the torch's projected wall-column band so the
      // light patch visually bleeds from floor onto the wall face below the torch.
      // Project from the wall-face contact point (same offset as _drawTorchWallGlows)
      // so the strip aligns with the bloom rather than the sprite float position.
      const normX = t.normX || 0, normY = t.normY || 0;
      const wfx = t.x - normX * 0.25 - player.x;
      const wfy = t.y - normY * 0.25 - player.y;
      const ta = _inFrustum(wfx, wfy, player.angle, REACH);
      if (ta !== null) {
        const tDist    = Math.sqrt(wfx * wfx + wfy * wfy);
        const screenX  = Math.floor(((ta + halfFov) / FOV) * W);
        const wallH    = Math.floor(H / Math.max(0.1, tDist));
        const wallTop  = Math.floor((H - wallH) / 2);
        const wallBot  = wallTop + wallH;
        // Cover the lower 35% of the wall face
        const stripTop = Math.max(0, Math.floor(wallBot - wallH * 0.35));
        const stripBot = Math.min(H, wallBot);
        const colSpan  = Math.max(2, Math.floor(wallH * 0.35));
        const bright   = tf.val * Math.max(0, 1 - tDist / REACH);
        if (bright > 0.02) {
          const xMin = Math.max(0, screenX - colSpan);
          const xMax = Math.min(W, screenX + colSpan);
          for (let px = xMin; px < xMax; px++) {
            if (this.zBuffer[px] < tDist) continue;   // occluded column
            const hx = (px - screenX) / (colSpan + 1);
            const radH = Math.abs(hx);
            if (radH > 1) continue;
            for (let py = stripTop; py < stripBot; py++) {
              const vy = (py - stripTop) / (stripBot - stripTop + 1);
              const falloff = (1 - radH) * (1 - vy * vy) * bright;
              if (falloff < 0.02) continue;
              const a255 = (falloff * 60 + 0.5) | 0;
              if (DITHER4[(py & 3) * 4 + (px & 3)] > (falloff * 10 + 0.5) | 0) continue;
              const idx = py * W + px;
              const wp = _wallFB[idx];
              let r = ( wp        & 0xFF);
              let g = ((wp >>  8) & 0xFF);
              let b = ((wp >> 16) & 0xFF);
              r = Math.min(255, r + ((255 * a255) >> 8));
              g = Math.min(255, g + ((130 * a255) >> 8));
              b = Math.min(255, b + ((  8 * a255) >> 8));
              _wallFB[idx] = _packRGB(r, g, b);
            }
          }
        }
      }
    }
  }

    _drawTorchWallGlows(torches, player) {
    const halfFov = FOV / 2;
    for (let i = 0; i < torches.length; i++) {
      const t  = torches[i];
      const tf = this._torchFlicker[i] || { val: 1 };

      // Project from the wall-face contact point (torch position pushed back
      // onto the wall surface by one half-unit along the face normal).
      // This anchors the bloom to the physical wall rather than the sprite float.
      const normX = t.normX || 0, normY = t.normY || 0;
      const wx = t.x - normX * 0.25, wy = t.y - normY * 0.25;
      const dx = wx - player.x, dy = wy - player.y;
      const ta = _inFrustum(dx, dy, player.angle, 8);
      if (ta === null) continue;
      const dist    = Math.sqrt(dx * dx + dy * dy);
      const screenX = Math.floor(((ta + halfFov) / FOV) * W);
      // Use the torch's own projected distance for wall geometry so the glow
      // stays on the torch's face even when something closer occludes the column.
      const wallH   = Math.floor(H / Math.max(0.1, dist));
      const wallTop = Math.floor((H - wallH) / 2);
      // Vertical center matches the sticker (worldZ = 0.55)
      const screenY  = wallTop + Math.floor((1 - 0.55) * wallH);
      const radius   = Math.max(3, Math.floor(wallH * 0.45));
      const bright   = tf.val * Math.max(0, 1 - dist / 7);
      if (bright < 0.02) continue;

      const xMin = Math.max(0, screenX - radius);
      const xMax = Math.min(W - 1, screenX + radius);
      const yMin = Math.max(0, screenY - radius);
      const yMax = Math.min(H - 1, screenY + radius);

      for (let py = yMin; py <= yMax; py++) {
        const dithRow = (py & 3) * 4;
        for (let px = xMin; px <= xMax; px++) {
          const fx = (px - screenX) / (radius + 1);
          const fy = (py - screenY) / (radius + 1);
          const radial = Math.sqrt(fx * fx + fy * fy);
          if (radial > 1) continue;
          // Z-buffer gate — skip if a closer wall column covers this pixel
          if (this.zBuffer[px] < dist) continue;
          const falloff = (1 - radial) * bright;
          if (DITHER4[dithRow + (px & 3)] > (falloff * 10 + 0.5) | 0) continue;
          const idx = py * W + px;
          const wp = _wallFB[idx];
          let r = ( wp        & 0xFF);
          let g = ((wp >>  8) & 0xFF);
          let b = ((wp >> 16) & 0xFF);
          // Additive orange tint
          r = Math.min(255, r + (255 * falloff * 0.5) | 0);
          g = Math.min(255, g + (160 * falloff * 0.3) | 0);
          b = Math.min(255, b + ( 20 * falloff * 0.1) | 0);
          _wallFB[idx] = _packRGB(r, g, b);
        }
      }
    }
  }

  _drawTorchFloorHalos(ctx, player, torches) {
    this._drawHalos(ctx, player, torches);
  }
  _drawBrazierFloorHalos(_ctx, _player) { /* handled inside _drawTorchFloorHalos */ }

  _drawHalos(ctx, player, torches) {
    const halfFov  = FOV / 2;
    const mid      = Math.floor(H / 2);
    const buf      = this._haloImageData.data;
    const zBuf     = this.zBuffer;

    // Zero the buffer — single memset, no per-pixel overhead
    buf.fill(0);

    // Inner helper: paint one elliptical halo into buf.
    // r,g,b in [0,255]; haloAlpha in [0,1] (peak brightness at centre).
    const paintHalo = (screenX, haloDist, haloW, haloH, haloY, haloAlpha, r, g, b) => {
      if (haloAlpha < 0.02 || haloW < 2) return;

      // Cap dimensions: standing inside a torch can't push these past full-screen.
      // Torch/brazier radii at dist=0.2 (the floor): W*0.3/0.2 = 480 → cap at W.
      const capW = Math.min(haloW, W);
      const capH = Math.min(haloH, mid); // never taller than floor half

      const pyMin = Math.max(mid, haloY - capH);
      const pyMax = Math.min(H - 1, haloY + capH);

      for (let py = pyMin; py <= pyMax; py++) {
        const fy  = (py - haloY) / (capH + 1);
        const fy2 = fy * fy;
        const rowW = (capW * Math.sqrt(Math.max(0, 1 - fy2))) | 0;
        if (rowW < 1) continue;

        const pxMin   = Math.max(0, screenX - rowW);
        const pxMax   = Math.min(W - 1, screenX + rowW);
        const dithRow = (py & 3) * 4;

        for (let px = pxMin; px <= pxMax; px++) {
          // Dither gate — same Bayer logic as before
          const fx      = (px - screenX) / (rowW + 1);
          const radial  = Math.sqrt(fx * fx + fy2);
          if (radial > 1) continue;
          if (DITHER4[dithRow + (px & 3)] > (haloAlpha * (1 - radial) * 10 + 0.5) | 0) continue;

          // Z-buffer gate — skip pixels behind a wall
          if (zBuf[px] < haloDist) continue;

          // Additive accumulate, integer arithmetic, clamp via |0 + Math.min
          const a255 = (haloAlpha * (1 - radial) * 255 + 0.5) | 0;
          if (a255 <= 0) continue;

          const idx = (py * W + px) * 4;
          buf[idx]     = Math.min(255, buf[idx]     + ((r * a255) >> 8));
          buf[idx + 1] = Math.min(255, buf[idx + 1] + ((g * a255) >> 8));
          buf[idx + 2] = Math.min(255, buf[idx + 2] + ((b * a255) >> 8));
          buf[idx + 3] = Math.min(255, buf[idx + 3] + a255);
        }
      }
    };

    // ── Torches — wall glow is now handled by _drawTorchWallGlows into _wallFB

    // ── Braziers ─────────────────────────────────────────────
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      if (!d.isBrazier) continue;
      const dx = d.x - player.x, dy = d.y - player.y;
      const ta = _inFrustum(dx, dy, player.angle, 7);
      if (ta === null) continue;
      const dist     = Math.sqrt(dx * dx + dy * dy);
      const bf       = this._brazierFlicker.get(di) || { val: 1 };
      const haloDist = Math.max(0.2, dist);
      const screenX  = Math.floor(((ta + halfFov) / FOV) * W);
      paintHalo(screenX, haloDist,
        Math.floor(W * 0.35  / haloDist),
        Math.floor(H * 0.12  / haloDist),
        mid + Math.floor(H * 0.12 / haloDist),
        bf.val * Math.max(0, 1 - dist / 6) * 0.35,
        255, 120, 30);
    }

    // ── Flush to screen ───────────────────────────────────────
    // putImageData bypasses globalCompositeOperation, so we blit the buffer
    // onto a scratch canvas first, then drawImage that with 'lighter' blending.
    // The scratch canvas is lazily created and reused every frame.
    if (!this._haloCanvas) {
      this._haloCanvas = document.createElement('canvas');
      this._haloCanvas.width  = W;
      this._haloCanvas.height = H;
      this._haloCtx = this._haloCanvas.getContext('2d');
      this._haloCtx.imageSmoothingEnabled = false;
    }
    this._haloCtx.putImageData(this._haloImageData, 0, 0);

    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._haloCanvas, 0, 0);
    ctx.globalCompositeOperation = prevOp;
  }

  // ─────────────��───────────────────────────────────────────
  // Sprite dispatcher — aggressive frustum + distance culling
  // ─────────────────────────────────────────────────────────
  _drawSprites(ctx, player, enemies, projectiles) {
    const halfFov = FOV / 2;
    const pa = player.angle;
    const px = player.x, py = player.y;
    const sprites = [];

    // Enemies (alive + dead flat) — already have dist from EnemyManager
    for (const e of enemies) {
      const dx = e.x - px, dy = e.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_ENEMY_DIST);
      if (sa === null) continue;
      sprites.push({ type: 'enemy', data: e, sa, dist: e.dist });
    }

    // Decor — cull at shorter range (static, never need to see very far)
    for (let di = 0; di < this.map.decor.length; di++) {
      const d = this.map.decor[di];
      const dx = d.x - px, dy = d.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_DECOR_DIST);
      if (sa === null) continue;
      sprites.push({ type: 'decor', data: d, decorIdx: di, sa, dist: Math.sqrt(dx*dx+dy*dy) });
    }

    // Gem key pickups
    for (const gk of (this.map.gemKeyPickups || [])) {
      if (gk.collected) continue;
      const dx = gk.x - px, dy = gk.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PICKUP_DIST);
      if (sa === null) continue;
      sprites.push({ type: 'gemkey', data: gk, sa, dist: Math.sqrt(dx*dx+dy*dy) });
    }

    // Pickups
    for (const p of this.map.pickups) {
      const dx = p.x - px, dy = p.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PICKUP_DIST);
      if (sa === null) continue;
      sprites.push({ type: 'pickup', data: p, sa, dist: Math.sqrt(dx*dx+dy*dy) });
    }

    // Torches — short visibility range.
    // If the torch has a wall sticker registered (the normal case after initLevel
    // wires them up), skip the floor-standing billboard entirely — the sticker
    // painted into _wallFB and the floor halo are sufficient.  Only fall back to
    // the billboard for any torch that somehow has no adjacent wall sticker
    // (e.g. a torch placed in the middle of a room with no nearby wall).
    for (let i = 0; i < (this.map.torches || []).length; i++) {
      const t = this.map.torches[i];
      // Check all 4 cardinal wall neighbours for a registered sticker.
      const gx = Math.floor(t.x), gy = Math.floor(t.y);
      // Use baked wall tile, or scan neighbours as fallback for old saves.
      let hasStickerOnWall = false;
      if (t.wallX != null) {
        hasStickerOnWall = this.raycaster.getStickers(t.wallX, t.wallY)?.length > 0;
      } else {
        hasStickerOnWall = (
          this.raycaster.getStickers(gx,     gy - 1)?.length > 0 ||
          this.raycaster.getStickers(gx,     gy + 1)?.length > 0 ||
          this.raycaster.getStickers(gx - 1, gy    )?.length > 0 ||
          this.raycaster.getStickers(gx + 1, gy    )?.length > 0
        );
      }
      if (hasStickerOnWall) continue;  // sticker path active — no billboard needed
      const dx = t.x - px, dy = t.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_TORCH_DIST);
      if (sa === null) continue;
      sprites.push({ type: 'torch', data: t, torchIdx: i, sa, dist: Math.sqrt(dx*dx+dy*dy) });
    }

    // Exit portal — longer range so it's always findable
    const portal = this.map.exitPortal;
    if (portal) {
      const dx = portal.x - px, dy = portal.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PORTAL_DIST);
      if (sa !== null) {
        sprites.push({ type: 'portal', data: portal, sa, dist: Math.sqrt(dx*dx+dy*dy) });
      }
    }

    // Projectile bolts — crossbow and fire tome only
    for (const bolt of projectiles) {
      if (!bolt.alive) continue;
      const dx = bolt.x - px, dy = bolt.y - py;
      const sa = _inFrustum(dx, dy, pa, MAX_PLASMA_DIST);
      if (sa === null) continue;
      let btype;
      if (bolt.weaponType === 'crossbow') btype = 'crossbow_bolt';
      else if (bolt.weaponType === 'plasma2' || bolt.weaponType === 'cannon') btype = 'plasma';
      else continue; // hitscan weapons don't spawn visible bolts
      sprites.push({ type: btype, data: bolt, sa, dist: Math.sqrt(dx*dx+dy*dy) });
    }

    // Sort back-to-front
    sprites.sort((a, b) => b.dist - a.dist);

    for (const s of sprites) {
      const screenX = Math.floor(((s.sa + halfFov) / FOV) * W);

      if (s.type === 'enemy') {
        this._drawEnemySprite(ctx, s.data, screenX, s.dist, halfFov, s.sa);
      } else if (s.type === 'decor') {
        this._drawDecorSprite(ctx, s.data, s.decorIdx, screenX, s.dist);
      } else if (s.type === 'gemkey') {
        this._drawGemKeySprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'pickup') {
        this._drawPickupSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'torch') {
        this._drawTorchSprite(ctx, s.data, s.torchIdx, screenX, s.dist);
      } else if (s.type === 'portal') {
        this._drawPortalSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'plasma') {
        this._drawPlasmaSprite(ctx, s.data, screenX, s.dist);
      } else if (s.type === 'crossbow_bolt') {
        this._drawCrossbowBolt(ctx, s.data, screenX, s.dist);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Enemy sprite — alive = billboard, dead = flat decal
  // ─────────────────────────────────────────────────────────
  _drawEnemySprite(ctx, e, screenX, dist, halfFov, sa) {
    e.screenX = (sa / halfFov);

    // ── Dead enemy: flat sprite on floor
    if (!e.alive) {
      if (e.deathTimer <= 0) return;
      this._drawDeadEnemyFlat(ctx, e, screenX, dist);
      return;
    }

    // ── Per-type visual config ─────────────────────────────
    let img, heightMult, widthMult, yShift, glowColor, glowAlphaBase;
    glowColor = null;
    glowAlphaBase = 0;
    yShift = 0;

    // Determine animation key and pick frame
    let animKey = null; // which enemyAnims key to use
    if (e.isAbomination) {
      animKey = null; // handled below with direct frame selection
      heightMult = 2.8;
      widthMult  = 1.4;
      glowColor  = e.enraged ? '160,0,255' : '100,0,200';
      glowAlphaBase = 0.18 + 0.1 * Math.sin(this._time * 5);
      if (e.state === 'attack') {
        const ABOM_ATK = [this.assets.abomAtk1, this.assets.abomAtk2, this.assets.abomAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = ABOM_ATK[atkIdx] || this.assets.abomIdle || this.assets.abomination;
      } else if (e.state === 'chase') {
        const ABOM_WLK = [this.assets.abomWlk1, this.assets.abomWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = ABOM_WLK[wlkIdx] || this.assets.abomIdle || this.assets.abomination;
      } else {
        img = this.assets.abomIdle || this.assets.abomination;
      }
    } else if (e.isBoss) {
      // Use individual boss frames: idle / walk / attack
      animKey = null; // handled below with direct frame selection
      heightMult = 2.0;
      widthMult  = 1.0; // 1:1 — enforced to square after clamping
      glowColor  = null; // no ambient glow — green torch effect replaces it
      glowAlphaBase = 0;
      // Pick frame based on state
      if (e.state === 'attack') {
        // 3-frame attack sequence at ~8 fps
        const BOSS_ATK = [this.assets.bossAtk1, this.assets.bossAtk2, this.assets.bossAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = BOSS_ATK[atkIdx] || this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      } else if (e.state === 'chase' || e.charging) {
        // 2-frame walk cycle at ~4 fps
        const BOSS_WLK = [this.assets.bossWlk1, this.assets.bossWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = BOSS_WLK[wlkIdx] || this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      } else {
        // Idle
        img = this.assets.bossIdle || this.assets.trollBoss || this.assets.goblin;
      }
    } else if (e.type === 'bat') {
      animKey = null; // handled below with direct frame selection
      heightMult = 0.7;
      widthMult  = 1.5;
      yShift = -0.12;
      if (e.state === 'attack') {
        const BAT_ATK = [this.assets.batAtk1, this.assets.batAtk2, this.assets.batAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = BAT_ATK[atkIdx] || this.assets.batIdle || this.assets.bat;
      } else if (e.state === 'chase') {
        const BAT_WLK = [this.assets.batWlk1, this.assets.batWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = BAT_WLK[wlkIdx] || this.assets.batIdle || this.assets.bat;
      } else {
        img = this.assets.batIdle || this.assets.bat;
      }
    } else if (e.type === 'spider') {
      animKey = null; // handled below with direct frame selection
      heightMult = 0.75;
      widthMult  = 1.3;
      yShift = 0.14;
      if (e.state === 'attack') {
        const SPD_ATK = [this.assets.spiderAtk1, this.assets.spiderAtk2, this.assets.spiderAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = SPD_ATK[atkIdx] || this.assets.spiderIdle || this.assets.spider;
      } else if (e.state === 'chase') {
        const SPD_WLK = [this.assets.spiderWlk1, this.assets.spiderWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = SPD_WLK[wlkIdx] || this.assets.spiderIdle || this.assets.spider;
      } else {
        img = this.assets.spiderIdle || this.assets.spider;
      }
    } else {
      // Goblin — use individual frames (same pattern as Troll boss)
      animKey = null; // handled below with direct frame selection
      heightMult = 1.0;
      widthMult  = 1.0;
      if (e.state === 'attack') {
        const GOB_ATK = [this.assets.gobAtk1, this.assets.gobAtk2, this.assets.gobAtk3];
        const atkIdx = Math.floor(this._time * 8) % 3;
        img = GOB_ATK[atkIdx] || this.assets.gobIdle || this.assets.goblin;
      } else if (e.state === 'chase') {
        const GOB_WLK = [this.assets.gobWlk1, this.assets.gobWlk2];
        const wlkIdx = Math.floor(this._time * 4) % 2;
        img = GOB_WLK[wlkIdx] || this.assets.gobIdle || this.assets.goblin;
      } else {
        img = this.assets.gobIdle || this.assets.goblin;
      }
    }

    // Pick animated frame — custom mod frames take priority over spritesheet
    // (only runs when animKey is set, i.e. bat/spider/abomination — not goblin/boss)
    {
      const animType = (e.state === 'attack') ? 'attack' : 'walk';
      const fps = (animType === 'attack') ? 6 : 4;
      const customSet = animKey ? customAnimFrames[animKey] : null;
      const customFrameList = customSet ? customSet[animType] : null;
      // Check if any custom frame is loaded for this anim type
      const hasCustomFrames = customFrameList && customFrameList.some(f => f && f.complete && f.naturalWidth > 0);
      if (hasCustomFrames) {
        const frameIdx = Math.floor(this._time * fps) % customFrameList.length;
        const cf = customFrameList[frameIdx];
        if (cf && cf.complete && cf.naturalWidth > 0) img = cf;
        else {
          // Fall back to first loaded custom frame if current slot is empty
          const fallback = customFrameList.find(f => f && f.complete && f.naturalWidth > 0);
          if (fallback) img = fallback;
        }
      } else if (animKey) {
        // Fall back to spritesheet animation
        const anims = this.enemyAnims[animKey];
        if (anims) {
          const sheet = anims[animType] || anims.walk;
          if (sheet && sheet.ready) {
            const frameIdx = Math.floor(this._time * fps) % sheet.frames.length;
            const frame = sheet.getFrame(frameIdx);
            if (frame) img = frame;
          }
        }
      }
    }

    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const imgReady = img instanceof HTMLCanvasElement ? (imgW > 0) : (img.complete && imgW > 0);
    if (!img || !imgReady) return;

    let height = Math.floor((H * heightMult) / Math.max(0.1, dist));
    let width  = Math.floor(height * widthMult);

    // ── Boss: square pixel ratio, 256px max ──
    if (e.isBoss) {
      const side = Math.min(height, 256);
      height = side;
      width  = side;
    }

    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height + height * yShift);
    const left   = screenX - Math.floor(width / 2);

    let bright = this._flickerVal / (1 + dist * 0.15);
    bright = Math.min(1, Math.max(0.1, bright));

    // ── Glow halo for abomination ──
    if (glowColor && glowAlphaBase > 0 && dist < 12) {
      const glowAlpha = glowAlphaBase * Math.max(0, 1 - dist / 12);
      const glowR = Math.floor(width * 0.6);
      for (let sx = Math.max(0, left - glowR); sx < Math.min(W, left + width + glowR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - screenX) / (glowR + width / 2 + 1);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const alpha = glowAlpha * (1 - radial);
        ctx.fillStyle = `rgba(${glowColor},${alpha.toFixed(2)})`;
        ctx.fillRect(sx, Math.max(0, top - 4), 1, height + 8);
      }
    }

    // ── Boss: green torch glow halo (interacts with per-column torch light) ──
    if (e.isBoss && dist < 14) {
      const torchLight = this._torchLight;
      // Sample average torch light across the boss's screen columns
      const clL = Math.max(0, left), clR = Math.min(W, left + width);
      let avgTorch = 0, tSamples = 0;
      for (let sx = clL; sx < clR; sx++) {
        avgTorch += torchLight ? (torchLight[sx] || 0) : 0;
        tSamples++;
      }
      avgTorch = tSamples > 0 ? avgTorch / tSamples : 0;

      // Flicker-driven base pulse (mirrors torch flicker rhythm)
      const flickerBase = this._flickerVal;
      const pulse = flickerBase * (0.55 + 0.35 * Math.sin(this._time * 6.2));
      // Torch proximity boosts the green halo just like torches boost walls
      const torchBoost = Math.min(0.5, avgTorch * 0.8);
      const haloAlpha = (pulse * 0.32 + torchBoost * 0.22) * Math.max(0, 1 - dist / 14);

      const haloR = Math.floor(width * 0.75);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const threshold = (1 - radial) * 16;
        const dval = DITHER4[(Math.floor(top / 4) & 3) * 4 + (sx & 3)];
        if (dval > threshold) continue;
        const alpha = haloAlpha * (1 - radial);
        ctx.fillStyle = `rgba(40,255,80,${alpha.toFixed(2)})`;
        const wallTop = Math.max(0, top - Math.floor(height * 0.2));
        const wallBot = Math.min(H, top + height + Math.floor(height * 0.15));
        ctx.fillRect(sx, wallTop, 1, wallBot - wallTop);
      }

      // Inner flame core — bright green wisps at top of sprite
      const fireH = Math.max(2, Math.floor(height * 0.22));
      const fireW = Math.max(2, Math.floor(width * 0.45));
      const fireX = screenX - Math.floor(fireW / 2);
      const fireY = top - Math.floor(fireH * 0.25);
      const fireAlpha = (pulse * 0.65 + torchBoost * 0.4) * Math.max(0, 1 - dist / 10);
      if (fireAlpha > 0.04) {
        for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          const fx = (sx - fireX) / fireW;
          const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.8);
          if (fa < 0.04) continue;
          ctx.fillStyle = `rgba(60,255,100,${fa.toFixed(2)})`;
          ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.6));
          ctx.fillStyle = `rgba(180,255,160,${(fa * 0.55).toFixed(2)})`;
          ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.25));
        }
      }
    }

    const abomEnragePulse = e.isAbomination && e.enraged
      ? (0.25 + 0.2 * Math.sin(this._time * 10))
      : 0;

    const _dark = 1 - Math.min(1, bright);
    const _pain = e.pain;
    const _abom = abomEnragePulse;
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
      if (_dark > 0.05) {
        sc.fillStyle = `rgba(0,0,0,${_dark})`;
        sc.fillRect(ol, ot, ow, oh);
      }
      if (_pain > 0) {
        sc.fillStyle = `rgba(255,50,0,${Math.min(0.65, _pain * 1.8)})`;
        sc.fillRect(ol, ot, ow, oh);
      }
      if (_abom > 0) {
        sc.fillStyle = `rgba(160,0,255,${_abom})`;
        sc.fillRect(ol, ot, ow, oh);
      }
    });

    // Boss health bars (HUD-style, kept for readability on big fights)
    if (e.isAbomination && dist < 20) {
      this._drawAbominationHealthBar(ctx, e);
    } else if (e.isBoss && dist < 15) {
      this._drawBossHealthBar(ctx, e);
    }
  }

  _drawAbominationHealthBar(ctx, boss) {
    const hp = Math.max(0, boss.health / boss.maxHealth);
    const barW = W - 20;
    const barH = 7;
    const bx = 10, by = 6;
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 6);
    const enraged = boss.enraged;

    ctx.fillStyle = enraged ? `rgba(80,0,80,0.9)` : `rgba(40,0,80,0.85)`;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = enraged ? '#200020' : '#120020';
    ctx.fillRect(bx, by, barW, barH);

    const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    if (enraged) {
      grad.addColorStop(0, '#ff00ff');
      grad.addColorStop(0.5, '#cc00cc');
      grad.addColorStop(1, '#ff44ff');
    } else {
      grad.addColorStop(0, '#8800cc');
      grad.addColorStop(0.5, '#aa00ff');
      grad.addColorStop(1, '#cc44ff');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, Math.floor(barW * hp), barH);

    ctx.strokeStyle = enraged
      ? `rgba(255,0,255,${0.6 + 0.4 * pulse})`
      : `rgba(180,0,255,${0.5 + 0.4 * pulse})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1, by - 1, barW + 2, barH + 2);

    ctx.fillStyle = enraged ? '#ff88ff' : '#cc88ff';
    ctx.font = `bold 6px ${getModFont()}`;
    ctx.textAlign = 'left';
    ctx.fillText(enraged ? '💀 THE ABOMINATION [ENRAGED]' : '💀 THE ABOMINATION', bx, by - 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ddaaff';
    ctx.fillText(`${Math.ceil(boss.health)} / ${boss.maxHealth}`, bx + barW, by - 2);
    ctx.textAlign = 'left';
  }

  _drawBossHealthBar(ctx, boss) {
    const hp = Math.max(0, boss.health / boss.maxHealth);
    const barW = W - 20;
    const barH = 6;
    const bx = 10, by = 6;
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 4);
    ctx.fillStyle = `rgba(120,0,0,0.8)`;
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = '#220000';
    ctx.fillRect(bx, by, barW, barH);
    const grad = ctx.createLinearGradient(bx, 0, bx + barW, 0);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(0.5, '#ff4400');
    grad.addColorStop(1, '#ffaa00');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, Math.floor(barW * hp), barH);
    ctx.strokeStyle = `rgba(255,50,0,${0.6 + 0.4 * pulse})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = '#ff8888';
    ctx.font = `bold 6px ${getModFont()}`;
    ctx.textAlign = 'left';
    ctx.fillText('TROLL WARLORD', bx, by - 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffaaaa';
    ctx.fillText(`${Math.ceil(boss.health)} / ${boss.maxHealth}`, bx + barW, by - 2);
    ctx.textAlign = 'left';
  }

  // Doom-style death flat: squashed sprite lying on floor
  _drawDeadEnemyFlat(ctx, e, screenX, dist) {
    let img;
    if (e.isAbomination)        img = this.assets.abomDead         || this.assets.abominationDead || this.assets.goblin;
    else if (e.isBoss)          img = this.assets.bossDead         || this.assets.trollDead  || this.assets.goblinDead || this.assets.goblin;
    else if (e.type === 'bat')  img = this.assets.batDeadFlat      || this.assets.batDead    || this.assets.goblin;
    else if (e.type === 'spider') img = this.assets.spiderDeadFlat || this.assets.spiderDead || this.assets.goblin;
    else                        img = this.assets.gobDead          || this.assets.goblinDead || this.assets.goblin;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const alpha = Math.min(1, e.deathTimer / 1.5);
    if (alpha <= 0.01) return;

    const flatW = Math.floor(H * 1.1 / Math.max(0.1, dist));
    const flatH = Math.max(2, Math.floor(flatW * 0.22));
    const top = _floorRow(dist) - Math.floor(flatH / 2);
    const left = screenX - Math.floor(flatW / 2);

    const clippedLeft = Math.max(0, left);
    const clippedRight = Math.min(W, left + flatW);
    let anyVisible = false;
    for (let sx = clippedLeft; sx < clippedRight; sx++) {
      if (this.zBuffer[sx] > dist) { anyVisible = true; break; }
    }
    if (!anyVisible) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    this._drawSpriteIsolated(ctx, img, left, top, flatW, flatH, dist, (sc, ol, ot, ow, oh) => {
      sc.fillStyle = `rgba(180,0,0,0.35)`;
      sc.fillRect(ol, ot, ow, oh);
    });
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────
  // Puddle flat decal — rendered BELOW the floor line
  // ─────────────────────────────────────────────────────────
  _drawPuddle(ctx, img, screenX, dist) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    // Place puddle centered on floor line, squashed flat
    const flatW = Math.floor(H * 1.2 / Math.max(0.1, dist));
    const flatH = Math.max(2, Math.floor(flatW * 0.18));
    // Position slightly BELOW the floor line (pushed down by half height)
    const floorY = _floorRow(dist);
    const top = floorY - Math.floor(flatH * 0.3); // mostly below floor line

    const left = screenX - Math.floor(flatW / 2);
    const clippedLeft  = Math.max(0, left);
    const clippedRight = Math.min(W, left + flatW);

    let anyVisible = false;
    for (let sx = clippedLeft; sx < clippedRight; sx++) {
      if (this.zBuffer[sx] > dist) { anyVisible = true; break; }
    }
    if (!anyVisible) return;

    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.25));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness fog → use precache
    this._drawSpriteIsolated(ctx, img, left, top, flatW, flatH, dist, null,
      undefined, undefined, undefined, undefined, dark);
  }

  // ─────────────────────────────────────────────────────────
  // Decor sprite — handles all new decor types
  // ─────────────────────────────────────────────────────────
  _drawDecorSprite(ctx, d, decorIdx, screenX, dist) {
    const type = d.type;

    // ── Puddles: rendered flat on floor ──
    if (d.isPuddle) {
      const puddleImgMap = {
        puddleWater: this.assets.puddleWater,
        puddleSlime: this.assets.puddleSlime,
        puddleBlood: this.assets.puddleBlood,
        puddleMud:   this.assets.puddleMud,
      };
      const img = puddleImgMap[type] || this.assets.puddleWater;
      this._drawPuddle(ctx, img, screenX, dist);
      return;
    }

    // ── Brazier: tall, glowing fire sprite ──
    if (d.isBrazier) {
      this._drawBrazierSprite(ctx, d, decorIdx, screenX, dist);
      return;
    }

    // ── Treasure chest ──
    if (type === 'treasureChest') {
      this._drawBillboard(ctx, this.assets.treasureChest, screenX, dist, 0.65, 0);
      return;
    }

    // ── Table ──
    if (type === 'table') {
      this._drawBillboard(ctx, this.assets.table, screenX, dist, 0.65, 0.12);
      return;
    }

    // ── Chair ──
    if (type === 'chair') {
      this._drawBillboard(ctx, this.assets.chair, screenX, dist, 0.55, 0.15);
      return;
    }

    // ── Cobweb → hatched spider egg cluster ──
    if (type === 'cobweb') {
      this._drawBillboard(ctx, this.assets.spiderEggs, screenX, dist, 0.38, 0.12);
      return;
    }

    // ── Small decors (skull, bones, claypot) via decorSmall atlas ──
    // decorSmall is a 2x2 spritesheet: [skull, bones; claypot, (unused)]
    if (type === 'skull' || type === 'bones' || type === 'claypot') {
      const quadMap = { skull: 0, bones: 1, claypot: 2 };
      const quad = quadMap[type] !== undefined ? quadMap[type] : 0;
      this._drawSmallDecorQuad(ctx, quad, screenX, dist, 0.35);
      return;
    }

    // ── Standard billboard decors ──
    let img;
    let heightScale = 0.85;
    let yOffset = 0;

    if (type === 'barrel') {
      img = this.assets.barrel;
      heightScale = 0.7;
      yOffset = 0.08;
    } else if (type === 'pillar') {
      img = this.assets.pillar;
      heightScale = 0.95;
    } else if (type === 'bookshelf') {
      img = this.assets.bookshelf;
      heightScale = 0.9;
    } else if (type === 'rubble') {
      img = this.assets.rubble;
      heightScale = 0.5;
      yOffset = 0.25;
    } else {
      img = this.assets.pillar;
    }

    this._drawBillboard(ctx, img, screenX, dist, heightScale, yOffset);
  }

  /** Generic billboard renderer: pins bottom to floor, applies z-buffer clip */
  _drawBillboard(ctx, img, screenX, dist, heightScale, yOffset) {
    if (!img || !img.complete || img.naturalWidth === 0) return;

    heightScale = heightScale || 0.85;
    yOffset = yOffset || 0;

    const height = Math.floor((H * heightScale) / Math.max(0.1, dist));
    const width = Math.floor(height * (img.naturalWidth / img.naturalHeight));
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height + height * yOffset);
    const left = screenX - Math.floor(width / 2);
    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.2));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness overlay → use precache
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      undefined, undefined, undefined, undefined, dark);
  }

  /** Draw a quadrant of the decorSmall 2x2 spritesheet (quad 0-3: skull,bones,claypot,cobweb) */
  _drawSmallDecorQuad(ctx, quad, screenX, dist, heightScale) {
    const img = this.assets.decorSmall;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    heightScale = heightScale || 0.35;
    const col = quad % 2;
    const row = Math.floor(quad / 2);
    const fw = img.naturalWidth / 2;
    const fh = img.naturalHeight / 2;
    const sx = col * fw, sy = row * fh;

    const height = Math.floor((H * heightScale) / Math.max(0.1, dist));
    const width  = Math.floor(height * (fw / fh));
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height);
    const left   = screenX - Math.floor(width / 2);
    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.22));
    const dark = 1 - Math.min(1, bright);

    // Fast path: pure darkness overlay → use precache with atlas sub-rect
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      sx, sy, fw, fh, dark);
  }

  /** Brazier: glowing fire billboard with animated flame on top */
  _drawBrazierSprite(ctx, d, decorIdx, screenX, dist) {
    const img = this.assets.brazier;
    const bf = this._brazierFlicker.get(decorIdx) || { val: 1 };
    const flicker = bf.val;

    const height = Math.floor((H * 0.8) / Math.max(0.1, dist));
    const aspectRatio = (img && img.naturalWidth > 0) ? img.naturalWidth / img.naturalHeight : 1;
    const width  = Math.floor(height * aspectRatio);
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height);
    const left   = screenX - Math.floor(width / 2);
    const bright = Math.min(1.1, flicker / (1 + dist * 0.12));

    // Wall halo glow
    if (dist < 5) {
      const haloAlpha = flicker * Math.max(0, 1 - dist / 5) * 0.3;
      const haloR = Math.floor(width * 0.9);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const threshold = (1 - radial) * 16;
        const dval = DITHER4[(Math.floor(top / 4) & 3) * 4 + (sx & 3)];
        if (dval > threshold) continue;
        const alpha = haloAlpha * (1 - radial);
        ctx.fillStyle = `rgba(255,100,10,${alpha.toFixed(2)})`;
        const wallTop = Math.max(0, top - Math.floor(height * 0.3));
        const wallBot = Math.min(H / 2, top + height);
        ctx.fillRect(sx, wallTop, 1, wallBot - wallTop);
      }
    }

    // Brazier body — fast path (pure darkness fog)
    if (img && img.complete && img.naturalWidth > 0) {
      const dark = 1 - Math.min(1, bright);
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
        undefined, undefined, undefined, undefined, dark);
    }

    // Animated fire flicker on top of brazier
    const fireH = Math.max(2, Math.floor(height * 0.4));
    const fireW = Math.max(2, Math.floor(width * 0.6));
    const fireX = screenX - Math.floor(fireW / 2);
    const fireY = top - Math.floor(fireH * 0.4);
    const fireAlpha = flicker * 0.9 * Math.max(0, 1 - dist / 9);

    if (fireAlpha > 0.04 && dist < 9) {
      for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const fx = (sx - fireX) / fireW;
        const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.6);
        if (fa < 0.04) continue;
        ctx.fillStyle = `rgba(255,110,0,${fa.toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.65));
        ctx.fillStyle = `rgba(255,230,60,${(fa * 0.8).toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.3));
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Gem key pickup sprite
  // ─────────────────────────────────────────────────────────
  _drawGemKeySprite(ctx, gk, screenX, dist) {
    const img = this.assets.gemKeys;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    // gemKeys is a 3-wide spritesheet: red | green | blue
    const colorIdx = gk.color === 'red' ? 0 : (gk.color === 'green' ? 1 : 2);
    const fw = Math.floor(img.naturalWidth / 3);
    const fh = img.naturalHeight;
    const sx = colorIdx * fw;

    const bobOffset = Math.floor(Math.sin(this._time * 3.5 + colorIdx) * 3);
    const height = Math.floor((H * 0.45) / Math.max(0.1, dist));
    const width  = Math.floor(height * (fw / fh));
    const floorY = _floorRow(dist);
    const top    = Math.floor(floorY - height) + bobOffset;
    const left   = screenX - Math.floor(width / 2);

    const clL = Math.max(0, left), clR = Math.min(W, left + width);
    let vis = false;
    for (let sx2 = clL; sx2 < clR; sx2++) { if (this.zBuffer[sx2] > dist) { vis = true; break; } }
    if (!vis) return;

    // Colored glow
    const glowRgb = gk.color === 'red' ? '255,60,60' : (gk.color === 'green' ? '60,255,80' : '60,120,255');
    const glowAlpha = 0.3 + 0.2 * Math.sin(this._time * 5);
    for (let sx2 = clL; sx2 < clR; sx2++) {
      if (this.zBuffer[sx2] <= dist + 0.1) continue;
      const fx = (sx2 - screenX) / (width * 0.8);
      const radial = Math.abs(fx);
      if (radial > 1) continue;
      const alpha = glowAlpha * (1 - radial * 0.8);
      ctx.fillStyle = `rgba(${glowRgb},${alpha.toFixed(2)})`;
      ctx.fillRect(sx2, top - 2, 1, height + 4);
    }

    const gemBright = Math.min(1, this._flickerVal / (1 + dist * 0.15));
    const gemDark = 1 - Math.min(1, gemBright);
    // Fast path: pure darkness fog with atlas sub-rect → use precache
    this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
      sx, 0, fw, fh, gemDark);

    // Label at close range
    if (dist < 4) {
      const label = `${gk.color.toUpperCase()} KEY`;
      ctx.fillStyle = `rgba(${glowRgb},${Math.min(0.9, (4-dist)/4)})`;
      ctx.font = `6px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText(label, screenX, top - 2);
      ctx.textAlign = 'left';
    }
  }

  // ─────��───────────────────────────────────────────────────
  // Pickup sprite
  // ─────────────────────────────────────────────────────────
  _drawPickupSprite(ctx, p, screenX, dist) {
    const img = p.type === 'health' ? this.assets.healthPack : this.assets.ammoCrate;
    const bobOffset = Math.floor(Math.sin(this._time * 3) * 3);
    const height = Math.floor((H * 0.5) / Math.max(0.1, dist));
    const width = height;
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height) + bobOffset;
    const left = screenX - Math.floor(width / 2);
    const bright = Math.min(1, this._flickerVal / (1 + dist * 0.15));

    if (img && img.complete && img.naturalWidth > 0) {
      const dark = 1 - Math.min(1, bright);
      if (dist >= 4) {
        // Fast path: pure darkness fog → use precache
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
          undefined, undefined, undefined, undefined, dark);
      } else {
        // Live path: fog + close-range color glow
        const _type = p.type;
        const glowAlpha = Math.min(0.6, (4 - dist) / 4 * 0.6);
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
          if (dark > 0.05) {
            sc.fillStyle = `rgba(0,0,0,${dark})`;
            sc.fillRect(ol, ot, ow, oh);
          }
          sc.fillStyle = _type === 'health' ? `rgba(0,255,100,${glowAlpha})` : `rgba(255,200,0,${glowAlpha})`;
          sc.fillRect(ol, ot, ow, oh);
        });
      }
    }
  }

  // ─────────���───────────────────────────────────────────────
  // Torch sprite
  // ─────────────────────────────────────────────────────────
  _drawTorchSprite(ctx, t, torchIdx, screenX, dist) {
    const img = this.assets.torch;
    const tf = this._torchFlicker[torchIdx] || { val: 1 };
    const flicker = tf.val;

    if (!img || !img.complete || img.naturalWidth === 0) {
      this._drawTorchFallback(ctx, screenX, dist, torchIdx);
      return;
    }

    const height = Math.floor((H * 0.75) / Math.max(0.1, dist));
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const width = Math.floor(height * aspectRatio);
    const top = Math.floor((H - height) / 2);
    const left = screenX - Math.floor(width / 2);
    const bright = Math.min(1.1, flicker / (1 + dist * 0.12));

    if (dist < 5) {
      const haloAlpha = flicker * Math.max(0, 1 - dist / 5) * 0.35;
      const haloR = Math.floor(width * 0.8);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - (left + width / 2)) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const threshold = (1 - radial) * 16;
        const dval = DITHER4[(Math.floor(top / 4) & 3) * 4 + (sx & 3)];
        if (dval > threshold) continue;
        const alpha = haloAlpha * (1 - radial);
        ctx.fillStyle = `rgba(255,140,20,${alpha.toFixed(2)})`;
        const wallTop = Math.max(0, top - Math.floor(height * 0.3));
        const wallBot = Math.min(H / 2, top + height);
        ctx.fillRect(sx, wallTop, 1, wallBot - wallTop);
      }
    }

    {
      // Fast path: pure darkness fog → use precache
      const dark = 1 - Math.min(1, bright);
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, null,
        undefined, undefined, undefined, undefined, dark);
    }

    const fireH = Math.max(2, Math.floor(height * 0.35));
    const fireW = Math.max(2, Math.floor(width * 0.5));
    const fireX = screenX - Math.floor(fireW / 2);
    const fireY = top - Math.floor(fireH * 0.3);
    const fireAlpha = flicker * 0.8 * Math.max(0, 1 - dist / 8);

    if (fireAlpha > 0.05 && dist < 8) {
      for (let sx = Math.max(0, fireX); sx < Math.min(W, fireX + fireW); sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const fx = (sx - fireX) / fireW;
        const fa = fireAlpha * (1 - Math.abs(fx - 0.5) * 1.8);
        if (fa < 0.05) continue;
        ctx.fillStyle = `rgba(255,140,0,${fa.toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.6));
        ctx.fillStyle = `rgba(255,240,80,${(fa * 0.7).toFixed(2)})`;
        ctx.fillRect(sx, fireY, 1, Math.floor(fireH * 0.25));
      }
    }
  }

  _drawTorchFallback(ctx, screenX, dist, torchIdx) {
    const tf = this._torchFlicker[torchIdx] || { val: 1 };
    const h = Math.floor((H * 0.3) / Math.max(0.1, dist));
    const w = Math.floor(h * 0.5);
    const top = Math.floor(H / 2) - h;
    const left = screenX - Math.floor(w / 2);
    const flk = tf.val;
    for (let sx = Math.max(0, left); sx < Math.min(W, left + w); sx++) {
      if (this.zBuffer[sx] <= dist) continue;
      ctx.fillStyle = `rgba(200,80,0,${flk * 0.9})`;
      ctx.fillRect(sx, top + Math.floor(h * 0.3), 1, Math.floor(h * 0.7));
      ctx.fillStyle = `rgba(255,180,0,${flk * 0.8})`;
      ctx.fillRect(sx, top, 1, Math.floor(h * 0.4));
    }
  }

  // ──────────────────────────────────���──────────────────────
  // Exit portal sprite
  // ─────────────────────────────────────────────────────────
  _drawPortalSprite(ctx, portal, screenX, dist) {
    const img = this.assets.exitPortal;
    const time = this._time;
    const height = Math.floor((H * 1.0) / Math.max(0.1, dist));
    const width = height;
    const floorY = _floorRow(dist);
    const top = Math.floor(floorY - height);
    const left = screenX - Math.floor(width / 2);

    const clL = Math.max(0, left), clR = Math.min(W, left + width);

    if (!portal.active) {
      if (img && img.complete && img.naturalWidth > 0) {
        this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
          sc.fillStyle = `rgba(80,0,0,0.7)`;
          sc.fillRect(ol, ot, ow, oh);
        });
      } else {
        for (let sx = clL; sx < clR; sx++) {
          if (this.zBuffer[sx] <= dist) continue;
          ctx.fillStyle = `rgba(120,0,80,0.18)`;
          ctx.fillRect(sx, top, 1, height);
        }
      }
      return;
    }

    const swirl = 0.7 + 0.3 * Math.sin(time * 4);

    if (dist < 8) {
      const haloAlpha = swirl * Math.max(0, 1 - dist / 8) * 0.5;
      const haloR = Math.floor(width * 0.7);
      for (let sx = Math.max(0, left - haloR); sx < Math.min(W, left + width + haloR); sx++) {
        if (this.zBuffer[sx] <= dist + 0.1) continue;
        const fx = (sx - screenX) / (haloR + width / 2);
        const radial = Math.abs(fx);
        if (radial > 1) continue;
        const threshold = (1 - radial) * 16;
        const dval = DITHER4[(Math.floor(top / 4) & 3) * 4 + (sx & 3)];
        if (dval > threshold) continue;
        const alpha = haloAlpha * (1 - radial);
        ctx.fillStyle = `rgba(0,220,200,${alpha.toFixed(2)})`;
        ctx.fillRect(sx, Math.max(0, top - 4), 1, height + 8);
      }
    }

    if (img && img.complete && img.naturalWidth > 0) {
      const _swirl = swirl;
      this._drawSpriteIsolated(ctx, img, left, top, width, height, dist, (sc, ol, ot, ow, oh) => {
        sc.fillStyle = `rgba(0,180,160,${_swirl * 0.25})`;
        sc.fillRect(ol, ot, ow, oh);
      });
    } else {
      for (let sx = clL; sx < clR; sx++) {
        if (this.zBuffer[sx] <= dist) continue;
        const cv = Math.floor(swirl * 200);
        ctx.fillStyle = `rgb(0,${cv},${Math.floor(cv * 0.9)})`;
        ctx.fillRect(sx, top, 1, height);
      }
    }

    if (dist < 3) {
      ctx.fillStyle = `rgba(0,255,220,${Math.min(1, (3-dist))})`;
      ctx.font = `6px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText('EXIT', screenX, top - 3);
      ctx.textAlign = 'left';
    }
  }

  // ─────────────────────────────────────────────────────────
  // Plasma bolt sprite
  // ─────────────────────────────────────────────────────────
  _drawPlasmaSprite(ctx, bolt, screenX, dist) {
    if (dist < 0.3) return;

    const img = this.assets.plasmaBolt;

    const size = Math.floor((H * 0.15) / Math.max(0.1, dist));
    if (size < 1) return;

    const top  = Math.floor(H / 2 - size / 2);
    const left = screenX - Math.floor(size / 2);

    if (img && img.complete && img.naturalWidth > 0) {
      this._drawSpriteIsolated(ctx, img, left, top, size, size, dist - 0.05, null);
    } else {
      for (let sx = Math.max(0, left); sx < Math.min(W, left + size); sx++) {
        if (this.zBuffer[sx] <= dist - 0.05) continue;
        ctx.fillStyle = 'rgba(0,255,220,0.9)';
        ctx.fillRect(sx, top, 1, size);
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Crossbow bolt — uses CRSSBOLT sprite, no effects
  // ─────────────────────────────────────────────────────────
  _drawCrossbowBolt(ctx, bolt, screenX, dist) {
    if (dist < 0.3) return;

    const img = this.assets.crossbowBolt;

    const h = Math.floor((H * 0.10) / Math.max(0.1, dist));
    const w = Math.floor(h * 3.0);
    if (h < 1) return;

    const top  = Math.floor(H / 2 - h / 2);
    const left = screenX - Math.floor(w / 2);

    // Draw directly — projectiles are always in front of walls so skip z-culling
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, left, top, w, h);
    } else {
      // Fallback: simple brown shaft
      ctx.fillStyle = 'rgba(160,100,40,0.95)';
      ctx.fillRect(left, top + Math.floor(h * 0.35), w, Math.max(1, Math.floor(h * 0.3)));
      ctx.fillStyle = 'rgba(200,140,60,0.95)';
      ctx.fillRect(left, top + Math.floor(h * 0.4), w, Math.max(1, Math.floor(h * 0.2)));
    }
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────
  // Cannon explosion billboard — squash → scale → fade
  // Phase 0..0.2 : initial squash (wide, short)
  // Phase 0.2..0.7: scale up
  // Phase 0.7..1 : fade out while still growing
  // ─────────────────────────────────────────────────────────
  _drawExplosions(ctx, player, explosionEffects) {
    const img = this.assets.explosion;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    const halfFov = FOV / 2;

    for (const ex of explosionEffects) {
      const dx = ex.x - player.x;
      const dy = ex.y - player.y;
      const sa = _inFrustum(dx, dy, player.angle, 18);
      if (sa === null) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.15) continue;

      const screenX = Math.floor(((sa + halfFov) / FOV) * W);

      // t goes 0→1 over the explosion lifetime
      const t = 1 - (ex.life / ex.maxLife);

      // Scale: starts small, squashes wide, then grows
      // squash phase (t<0.15): grow width fast, height slow
      // expand phase (t>0.15): grow both uniformly
      const baseSize = Math.floor((H * 0.55) / Math.max(0.2, dist));
      let scaleW, scaleH, alpha;

      if (t < 0.15) {
        // squash: spread wide, height compressed
        const p = t / 0.15;
        scaleW = 0.3 + p * 1.1; // 0.3→1.4
        scaleH = 0.15 + p * 0.45; // 0.15→0.60
        alpha = 1.0;
      } else {
        // expand
        const p = (t - 0.15) / 0.85;
        scaleW = 1.4 + p * 0.6; // 1.4→2.0
        scaleH = 0.6 + p * 1.4; // 0.6→2.0
        // fade out in last 30%
        alpha = t < 0.7 ? 1.0 : 1.0 - ((t - 0.7) / 0.3);
      }

      const w = Math.round(baseSize * scaleW);
      const h = Math.round(baseSize * scaleH);
      const left = screenX - Math.floor(w / 2);
      const top  = Math.floor(H / 2 - h / 2);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, left, top, w, h);
      ctx.restore();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Blood particles — 1×1 red pixels projected to screen
  // ─────────────────────────────────────────────────────────
  _drawBloodParticles(ctx, player, bloodParticles) {
    const halfFov = FOV / 2;
    const imageData = ctx.getImageData(0, 0, W, H);
    const data = imageData.data;

    for (const bp of bloodParticles) {
      const dx = bp.x - player.x;
      const dy = bp.y - player.y;
      const sa = _inFrustum(dx, dy, player.angle, 8);
      if (sa === null) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.1) continue;

      const screenX = Math.floor(((sa + halfFov) / FOV) * W);

      // Proper vertical projection: z=0 is floor, z=1 is ceiling.
      // Wall height at this distance fills H pixels, so 1 world-unit = H/dist screen pixels.
      // Player eye is at z=0.5. Positive z = above horizon → negative screenY offset.
      const projScale = H / Math.max(0.01, dist);
      const zOffset   = (bp.z - 0.5) * projScale; // positive = above horizon
      const screenY   = Math.floor(H / 2 - zOffset);

      if (screenX < 0 || screenX >= W || screenY < 0 || screenY >= H) continue;

      const t = Math.max(0, bp.life / bp.maxLife);
      const alpha = Math.floor(t * 230);
      const idx = (screenY * W + screenX) * 4;
      data[idx]     = 180;
      data[idx + 1] = 0;
      data[idx + 2] = 0;
      data[idx + 3] = alpha;
    }

    ctx.putImageData(imageData, 0, 0);
  }

  // ─────────────────────────────────────────────────────────
  // Gun rendering
  // Weapon sprites are served by WeaponSpriteManager (own offscreen canvas)
  // rather than the shared atlas, enabling per-frame torch effects.
  // ─────────────────────────────────────────────────────────
  _drawGun(ctx, player, muzzleFlash) {
    const weaponId = player.equippedWeapon || 'pistol';
    const muzzle = this.assets.muzzle;

    // Resolve gun canvas from WeaponSpriteManager (native res, decoupled from atlas)
    let gun = null;
    if (this.weaponManager) {
      gun = this.weaponManager.get(weaponId);
    }
    // Fallback: legacy assets.gun (should rarely be needed)
    if (!gun) gun = this.assets.gun;

    const bobX = Math.sin(player.bobPhase) * 4 * (player.bobAmp || 0);
    const bobY = Math.abs(Math.cos(player.bobPhase)) * 5 * (player.bobAmp || 0);

    const swayAmt = (1 - (player.bobAmp || 0));
    const swayX = Math.sin(this._time * 1.1) * 2 * swayAmt;
    const swayY = Math.cos(this._time * 0.7) * 1.5 * swayAmt;

    const kick = player.weaponKick || 0;
    const kickY = kick * 10;
    const kickX = kick * 2;

    let animY = 0;
    if (player.weaponAnim === 'shoot') {
      const f = player.weaponFrame || 0;
      animY = Math.sin(f * Math.PI) * 12;
    }

    const tilt = player.strafeTilt || 0;

    // ── Torch proximity — use fire-tinted canvas when near a light source ──
    let torchFlicker = 0;
    if (this.weaponManager && gun) {
      const torches = this.map.torches || [];
      let closestTorchDist = Infinity;
      for (const t of torches) {
        const dx = player.x - t.x, dy = player.y - t.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < closestTorchDist) closestTorchDist = d;
      }
      // Also check braziers as light sources
      for (const d of (this.map.decor || [])) {
        if (!d.isBrazier) continue;
        const dx = player.x - d.x, dy = player.y - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestTorchDist) closestTorchDist = dist;
      }
      if (closestTorchDist < 6) {
        torchFlicker = Math.max(0, 1 - closestTorchDist / 6);
        const torchCanvas = this.weaponManager.getTorchCanvas(weaponId, torchFlicker, this._time);
        if (torchCanvas) gun = torchCanvas;
      }
    }

    // ── Muzzle flash — composite onto weapon canvas (black pixels masked) ──
    if (muzzleFlash && this.weaponManager && FLASH_IDS.has(weaponId)) {
      const flashIntensity = (typeof muzzleFlash === 'number') ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0;
      if (flashIntensity > 0) {
        // applyMuzzleFlash handles torch-tinting internally when torchFlicker > 0
        const flashCanvas = this.weaponManager.applyMuzzleFlash(weaponId, flashIntensity, torchFlicker, this._time);
        if (flashCanvas) gun = flashCanvas;
      }
    }

    // ── Recoil scale + offset: zoom toward camera when firing ──
    const flashIntensityForRecoil = muzzleFlash
      ? (typeof muzzleFlash === 'number' ? Math.max(0, Math.min(1, muzzleFlash)) : 1.0)
      : 0;
    let recoilScale = 1 + flashIntensityForRecoil * 0.12;   // up to 12% upscale
    let recoilOffY  = flashIntensityForRecoil * 14;          // push down (toward player)
    let recoilOffX  = 0;

    // ── Sword fire state: arc down-left, scale down, pivot from bottom-centre ──
    if (weaponId === 'sword' && player.weaponAnim === 'shoot') {
      const f = Math.max(0, Math.min(1, player.weaponFrame || 0)); // 0→1 over animation
      const swingCurve = Math.sin(f * Math.PI);                    // peaks at mid-swing
      recoilOffX   = -swingCurve * 38;   // slide left up to 38px
      recoilOffY  += swingCurve * 28;    // slide down up to 28px (stays bottom-bound)
      recoilScale  = 1 - swingCurve * 0.15;  // shrink up to 15% at peak
    }

    const gw = 128, gh = 128;
    const gx = Math.floor(W / 2 - gw / 2 + bobX + swayX + kickX + recoilOffX);
    const gy = Math.floor(H - gh + bobY + swayY + kickY + animY + recoilOffY);

    // Pivot from bottom-centre so scaling keeps the grip planted at screen bottom
    const pivotX = W / 2;
    const pivotY = H;

    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(tilt);
    ctx.scale(recoilScale, recoilScale);
    ctx.translate(-pivotX, -pivotY);

    const gunReady = gun instanceof HTMLCanvasElement ? (gun.width > 0)
                                                      : (gun && gun.complete && gun.naturalWidth > 0);
    if (gunReady) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(gun, gx, gy, gw, gh);
    } else {
      // Placeholder while sprite loads
      ctx.fillStyle = '#888';
      ctx.fillRect(gx + 20, gy + 30, 40, 20);
      ctx.fillRect(gx + 35, gy + 20, 10, 15);
    }

    ctx.restore();
  }

  // ────────────────��────────────────────────────────────────
  // Post-process effects
  // ─────────────────────────────────────────────────────────
  _drawScanlines(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let y = 0; y < H; y += 2) {
      ctx.fillRect(0, y, W, 1);
    }
  }

  _drawVignette(ctx) {
    const grad = ctx.createRadialGradient(W/2, H/2, H*0.3, W/2, H/2, H*0.9);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
}
