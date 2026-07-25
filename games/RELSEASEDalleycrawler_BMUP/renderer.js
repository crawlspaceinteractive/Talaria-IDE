/**
 * Pseudo-3D Renderer — Genesis-inspired
 * Optimisations applied:
 *  1. Uint32Array pixel buffer  — 1 write per pixel instead of 4
 *  2. Incremental worldX        — add stepX per sx instead of multiply
 *  3. Math.sin LUT + ternary clamp — no trig inside hot loops
 *  4. Offscreen wall canvas     — drawImage replaces JS pixel copy
 *  5. CSS scanline overlay      — zero CPU scanline pass (div in HTML)
 */

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 320;
    this.H = 224;
    canvas.width  = this.W;
    canvas.height = this.H;

    this.horizonY = 60;

    // ── Uint32 pixel buffer ──────────────────────────────────────────
    this._image  = this.ctx.createImageData(this.W, this.H);
    this._buf32  = new Uint32Array(this._image.data.buffer);

    // Pre-fill alpha channel: since we write ABGR with (255 << 24), alpha
    // is always 255 — but initialise once so "missed" pixels are opaque black.
    this._buf32.fill(0xFF000000);

    // ── Sky strips (pre-baked per-row RGB) ──────────────────────────
    this.skyStrips = this._bakeSky();

    // ── Scanline table ───────────────────────────────────────────────
    this.scanlineTable = this._buildScanlineTable();

    // ── Sin LUT (1024 entries, covers 0..2π) ─────────────────────────
    this._sinLUT = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      this._sinLUT[i] = Math.sin((i / 1024) * Math.PI * 2);
    }

    // ── Offscreen wall canvas (baked once, blitted each frame) ───────
    const { WALL_BAND_H, TILE_W } = this._computeWallDims();
    this.WALL_BAND_H = WALL_BAND_H;
    this.TILE_W      = TILE_W;

    // wallCanvas is wide enough to tile across the full scroll range.
    // Width = TILE_W, Height = WALL_BAND_H.
    this.wallCanvas  = document.createElement('canvas');
    this.wallCanvas.width  = TILE_W;
    this.wallCanvas.height = WALL_BAND_H;
    this._wallCtx = this.wallCanvas.getContext('2d');

    // wallLitCanvas: same size, holds only the lit-window layer so we
    // can redraw just the flickering windows each frame without touching
    // the static stone.
    this.wallLitCanvas = document.createElement('canvas');
    this.wallLitCanvas.width  = TILE_W;
    this.wallLitCanvas.height = WALL_BAND_H;
    this._wallLitCtx = this.wallLitCanvas.getContext('2d');

    // windowList: [{x, y, w, h, seed}] — used for per-frame flicker
    this._windowList = [];

    this._bakeWallCanvas();
  }

  // ─────────────────────────────────────────────
  //  BAKE HELPERS
  // ─────────────────────────────────────────────

  _computeWallDims() {
    const WALL_BAND_H = ((this.H / 2) | 0) - this.horizonY; // 52px
    const TILE_W      = this.W * 2;
    return { WALL_BAND_H, TILE_W };
  }

  _bakeSky() {
    const strips = [];
    const total  = this.horizonY;
    for (let y = 0; y < total; y++) {
      const t = y / total;
      const r = (10  + t * 140) | 0;
      const g = (20  + t * 160) | 0;
      const b = (80  + t * 160) | 0;
      const cloud = (Math.sin(y * 0.7) * 0.5 + 0.5) * 12 * (1 - t * 0.7);
      const cr = (r + cloud) | 0; const clampCR = cr > 255 ? 255 : cr;
      const cg = (g + cloud) | 0; const clampCG = cg > 255 ? 255 : cg;
      const cb = (b + cloud) | 0; const clampCB = cb > 255 ? 255 : cb;
      // Pack as ABGR for little-endian Uint32 (alpha=255 in high byte)
      strips.push(0xFF000000 | (clampCB << 16) | (clampCG << 8) | clampCR);
    }
    return strips;
  }

  _buildScanlineTable() {
    const table = [];
    // camHeight tuned so that:
    //   LANE_MAX_Z=480 (far/horizon) projects to sy≈112 (top of floor zone = H/2)
    //   LANE_MIN_Z=120 (near/camera) projects to sy≈223 (near bottom of screen)
    // Formula: worldZ = (camHeight * fov) / (sy - horizonY)
    // At sy=112: worldZ=480 → camHeight = 480 * (112-60) / 200 = 124.8 ≈ 125
    const fov = 200, camHeight = 125;
    for (let sy = this.horizonY; sy < this.H; sy++) {
      const screenDy = sy - this.horizonY;
      if (screenDy === 0) { table.push({ worldZ: 99999, xScale: 0.001 }); continue; }
      const worldZ = (camHeight * fov) / screenDy;
      const xScale = worldZ / fov;
      table.push({ worldZ, xScale });
    }
    return table;
  }

  /**
   * Draw the static building stone / unlit windows into wallCanvas once.
   * Collect lit-window rects into _windowList for per-frame flicker.
   */
  _bakeWallCanvas() {
    const W    = this.W;
    const { WALL_BAND_H, TILE_W } = this;
    const ctx  = this._wallCtx;

    const wallR = 80, wallG = 72, wallB = 64;
    const darkR = 50, darkG = 44, darkB = 40;
    const winOffR = 30, winOffG = 50, winOffB = 90; // unlit window

    // Fill background with wall colour first
    ctx.fillStyle = `rgb(${wallR},${wallG},${wallB})`;
    ctx.fillRect(0, 0, TILE_W, WALL_BAND_H);

    const TILE_COL = 40;

    for (let row = 0; row < WALL_BAND_H; row++) {
      const bandT = row / WALL_BAND_H;
      const floor = bandT < 0.5 ? 0 : 1;

      for (let wx = 0; wx < TILE_W; wx += TILE_COL) {
        const col = wx; // tile-local x = 0..TILE_COL-1

        // Shade the brick block
        const shade = 1 - bandT * 0.2;
        const r = (wallR * shade) | 0;
        const g = (wallG * shade) | 0;
        const b = (wallB * shade) | 0;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(wx, row, TILE_COL, 1);

        // Vertical mortar seam (left 2px of tile)
        ctx.fillStyle = `rgb(${darkR},${darkG},${darkB})`;
        ctx.fillRect(wx, row, 2, 1);
      }
    }

    // Horizontal floor divider mortar band (row positions where bandT ≈ 0.5)
    const mortarRow0 = Math.round(WALL_BAND_H * 0.5) - 1;
    ctx.fillStyle = `rgb(${darkR},${darkG},${darkB})`;
    ctx.fillRect(0, mortarRow0, TILE_W, 2);

    // Windows per column per floor
    this._windowList = [];
    for (let colStart = 0; colStart < TILE_W; colStart += TILE_COL) {
      for (let floor = 0; floor < 2; floor++) {
        // Window bounds in band coords
        const bandStartFrac = floor === 0 ? 0     : 0.5;
        const bandEndFrac   = floor === 0 ? 0.5   : 1.0;
        const wy  = Math.round(WALL_BAND_H * (bandStartFrac + 0.06));
        const wh  = Math.round(WALL_BAND_H * (bandEndFrac   - bandStartFrac) * 0.68);
        const wx  = colStart + 8;
        const ww  = 21; // 28-8=20px inner, +1 for pixel perfect

        const windowSeed = (colStart / TILE_COL) * 2 + floor;
        const isLit = (windowSeed * 7 + 13) % 5 !== 0;

        if (isLit) {
          // Base lit colour baked; flicker layer drawn each frame
          ctx.fillStyle = `rgb(200,180,80)`;
          ctx.fillRect(wx, wy, ww, wh);
          this._windowList.push({ x: wx, y: wy, w: ww, h: wh, seed: windowSeed });
        } else {
          ctx.fillStyle = `rgb(${winOffR},${winOffG},${winOffB})`;
          ctx.fillRect(wx, wy, ww, wh);
        }
      }
    }
  }

  // ─────────────────────────────────────────────
  //  MAIN RENDER
  // ─────────────────────────────────────────────

  render(state) {
    const { cameraX, entities, worldWidth, skyScrollX, frameCount } = state;
    const W = this.W, H = this.H;
    const buf32 = this._buf32;

    // 1. Sky — fills rows 0..horizonY-1
    this._renderSky(buf32, frameCount, cameraX);

    // 2. Ground — fills rows H/2..H-1
    this._renderGround(buf32, cameraX, worldWidth);

    // Flush the pixel buffer (sky + ground)
    this.ctx.putImageData(this._image, 0, 0);

    // 3. Building wall — drawImage from offscreen canvas (GPU blit)
    this._blitWall(cameraX, frameCount);

    // 4. Entities
    this._renderEntities(entities, cameraX);

    // Scanlines are now a CSS overlay — zero CPU cost here.
  }

  // ─────────────────────────────────────────────
  //  SKY  (Uint32 writes + per-row sin LUT)
  // ─────────────────────────────────────────────

  _renderSky(buf32, frameCount, cameraX) {
    const W        = this.W;
    const strips   = this.skyStrips;
    const horizonY = this.horizonY;
    const sinLUT   = this._sinLUT;
    // Keep as float — truncate only at the per-row modulo so we don't
    // introduce a 1-pixel stutter every time the integer boundary flips.
    const parallaxX = cameraX * 0.2;

    for (let sy = 0; sy < horizonY; sy++) {
      const basePixel = strips[sy]; // packed ABGR, no cloud modulation yet

      // Per-row sky-skew — compute once, not per pixel
      // LUT index: map (sy * 0.05 + frameCount * 0.002) → 0..1023
      const lutIdx = ((sy * 0.05 + frameCount * 0.002) * (1024 / (Math.PI * 2)) + 4096) & 1023;
      const skewAmt = sinLUT[lutIdx] * 3;
      // Use Math.floor + positive modulo so the shift is always in [0, W)
      // and transitions smoothly as a float — no integer snap artifacts.
      const rowShift = ((parallaxX + skewAmt) % W + W * 2) % W;

      const rowBase = sy * W;

      // Extract base RGB from packed pixel
      const bR = basePixel & 0xFF;
      const bG = (basePixel >> 8)  & 0xFF;
      const bB = (basePixel >> 16) & 0xFF;

      for (let sx = 0; sx < W; sx++) {
        const cx = ((sx + rowShift) % W + W) % W | 0;

        // Cloud: two sin waves — use LUT
        const i1 = ((cx * 0.04 + sy * 0.08) * (1024 / (Math.PI * 2)) + 4096) & 1023;
        const i2 = ((cx * 0.02 - sy * 0.05 + frameCount * 0.003) * (1024 / (Math.PI * 2)) + 4096) & 1023;
        let cloudVal = sinLUT[i1] * 15 + sinLUT[i2] * 8;
        if (cloudVal < 0) cloudVal = 0;

        let r = (bR + cloudVal) | 0; r = r > 255 ? 255 : r;
        let g = (bG + cloudVal) | 0; g = g > 255 ? 255 : g;
        let b = (bB + cloudVal) | 0; b = b > 255 ? 255 : b;

        buf32[rowBase + sx] = 0xFF000000 | (b << 16) | (g << 8) | r;
      }
    }
  }

  // ─────────────────────────────────────────────
  //  BUILDING WALL — GPU blit via drawImage
  // ─────────────────────────────────────────────

  _blitWall(cameraX, frameCount) {
    const { WALL_BAND_H, TILE_W } = this;
    const W        = this.W;
    const wallTop  = this.horizonY;
    // Keep as float and use Math.floor only at drawImage source coords
    // so the wall slides 1 sub-pixel at a time with no integer snapping.
    const wallShiftF = ((cameraX * 0.7) % TILE_W + TILE_W * 2) % TILE_W;
    const sinLUT   = this._sinLUT;

    // --- Draw per-frame lit-window flicker into wallLitCanvas ---
    const litCtx = this._wallLitCtx;
    // Clear previous flicker frame
    litCtx.clearRect(0, 0, TILE_W, WALL_BAND_H);

    for (const win of this._windowList) {
      const lutIdx = ((frameCount * 0.04 + win.seed) * (1024 / (Math.PI * 2)) + 4096) & 1023;
      const flicker = 1 + sinLUT[lutIdx] * 0.08;
      const r = (200 * flicker) | 0; const cr = r > 255 ? 255 : r;
      const g = (180 * flicker) | 0; const cg = g > 255 ? 255 : g;
      const b = (80  * flicker) | 0; // never reaches 255
      litCtx.fillStyle = `rgb(${cr},${cg},${b})`;
      litCtx.fillRect(win.x, win.y, win.w, win.h);
    }

    // --- Blit static wall layer then flicker layer ---
    // Tile across W pixels starting at wallShiftF.
    // drawImage accepts float source coords — no integer truncation needed here;
    // the browser bilinear-samples the sub-pixel offset automatically.
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, wallTop, W, WALL_BAND_H);
    ctx.clip();

    // Segment 1: wallShiftF → TILE_W (length = TILE_W - wallShiftF)
    const seg1W = TILE_W - wallShiftF;
    // Screen width for seg1 is min(seg1W, W) — if seg1W already covers the
    // entire screen we only need one draw call.
    const draw1W = Math.min(seg1W, W);

    ctx.drawImage(this.wallCanvas,
      wallShiftF, 0, draw1W, WALL_BAND_H,
      0,          wallTop, draw1W, WALL_BAND_H
    );
    // Segment 2 wraps around from 0 if we haven't filled W pixels yet
    if (draw1W < W) {
      const draw2W = W - draw1W;
      ctx.drawImage(this.wallCanvas,
        0, 0, draw2W, WALL_BAND_H,
        draw1W, wallTop, draw2W, WALL_BAND_H
      );
    }

    // Overlay flicker layer with the same tiling
    ctx.drawImage(this.wallLitCanvas,
      wallShiftF, 0, draw1W, WALL_BAND_H,
      0,          wallTop, draw1W, WALL_BAND_H
    );
    if (draw1W < W) {
      const draw2W = W - draw1W;
      ctx.drawImage(this.wallLitCanvas,
        0, 0, draw2W, WALL_BAND_H,
        draw1W, wallTop, draw2W, WALL_BAND_H
      );
    }

    ctx.restore();
  }

  // ─────────────────────────────────────────────
  //  GROUND PLANE  (Uint32 + incremental X)
  // ─────────────────────────────────────────────

  _renderGround(buf32, cameraX, worldWidth) {
    const W        = this.W;
    const H        = this.H;
    const horizonY = this.horizonY;
    const table    = this.scanlineTable;

    // Z range: LANE_MIN_Z=120 (near camera, bottom of screen) to LANE_MAX_Z=480 (far, top of floor).
    // Curb sits just below the wall/sidewalk boundary — at the far edge of the walkable lane.
    // NEAR_Z: start of the visible near-camera ground colour blend.
    // FAR_CUTOFF: beyond this worldZ the scanline is hidden behind the wall; skip it.
    const LANE_DEPTH  = 320;  // 120..480 = 360 units; blend zone is most of it
    const NEAR_Z      = 130;  // near-camera edge colour starts here
    const FAR_CUTOFF  = 510;  // a little past LANE_MAX_Z to avoid pop-in
    const wallBottom  = (H / 2) | 0;

    const gNR = 72, gNG = 72, gNB = 76; // near ground (darker, close to camera)
    const gFR = 56, gFG = 56, gFB = 60; // far ground  (darker still, toward horizon)
    const curbR = 120, curbG = 118, curbB = 110;
    const wallR = 80,  wallG = 72,  wallB = 64;

    for (let sy = horizonY; sy < H; sy++) {
      if (sy < wallBottom) continue;

      const ti = sy - horizonY;
      const { worldZ, xScale } = table[ti];
      if (worldZ > FAR_CUTOFF) continue;

      // Per-scanline colour blend (done once, not per pixel)
      const playT = worldZ < NEAR_Z ? 0 : worldZ > NEAR_Z + LANE_DEPTH ? 1
                    : (worldZ - NEAR_Z) / LANE_DEPTH;

      let sr = (gFR + (gNR - gFR) * playT) | 0;
      let sg = (gFG + (gNG - gFG) * playT) | 0;
      let sb = (gFB + (gNB - gFB) * playT) | 0;

      if (worldZ < NEAR_Z) {
        const wallT = (NEAR_Z - worldZ) / NEAR_Z;
        sr = (sr + (wallR - sr) * wallT) | 0;
        sg = (sg + (wallG - sg) * wallT) | 0;
        sb = (sb + (wallB - sb) * wallT) | 0;
      }

      const tileZ = (worldZ / 40) | 0;
      // Precompute worldZ mod for grid lines (constant per scanline)
      const gridZ = (worldZ % 40 + 40) % 40;
      const onGridZ = gridZ < 1.5;

      // Curb: the sidewalk/road transition at the far lane boundary (near LANE_MAX_Z=480)
      const isCurb = worldZ > 462 && worldZ < 498;

      const rowBase  = sy * W;
      // Incremental X: start worldX for sx=0, then add stepX each pixel
      let worldX = cameraX + (0 - W * 0.5) * xScale;
      const stepX = xScale;

      for (let sx = 0; sx < W; sx++) {
        worldX += stepX;

        let pr, pg, pb;

        if (isCurb) {
          pr = curbR; pg = curbG; pb = curbB;
        } else {
          const tileX = (worldX / 40) | 0;
          const checker = (tileX + tileZ) & 1;
          const gridXv = (worldX % 40 + 40) % 40;
          const onGrid = (gridXv < 1.5) || onGridZ;

          if (onGrid) {
            pr = (sr * 0.72) | 0;
            pg = (sg * 0.72) | 0;
            pb = (sb * 0.72) | 0;
          } else {
            pr = sr + checker * 6;
            pg = sg + checker * 6;
            pb = sb + checker * 5;
          }
        }

        buf32[rowBase + sx] = 0xFF000000 | (pb << 16) | (pg << 8) | pr;
      }
    }
  }

  // ─────────────────────────────────────────────
  //  ENTITIES  (depth-sorted, offscreen-culled)
  // ─────────────────────────────────────────────

  _renderEntities(entities, cameraX) {
    const ctx      = this.ctx;
    const W        = this.W;
    const H        = this.H;
    const horizonY = this.horizonY;
    const fov      = 200;
    const camHeight = 125; // must match _buildScanlineTable: LANE_MAX_Z=480 → sy≈112=H/2

    const sorted = [...entities].sort((a, b) => b.z - a.z);

    for (const ent of sorted) {
      const dz = ent.z;
      if (dz <= 0) continue;

      // camHeight=125, fov=200 — must match _buildScanlineTable exactly
      const screenScale = fov / dz;
      const screenX = (W * 0.5) + (ent.x - cameraX) * screenScale;
      const screenY = horizonY  + camHeight * screenScale;

      const baseW = ent.w || 20;
      const baseH = ent.h || 32;
      const sw = baseW * screenScale;
      const sh = baseH * screenScale;

      const drawX = screenX - sw * 0.5;
      const drawY = screenY - sh;

      if (drawX + sw < 0 || drawX > W || drawY + sh < 0 || drawY > H) continue;

      this._drawEntity(ctx, ent, drawX, drawY, sw, sh, screenScale);

      // Shadow — skip on invisible iframe frames
      const _iframeInvisible = ent.type === 'player' && ent.iframeTimer > 0 && (ent.iframeTimer % 8) < 4;

      // Shadow — use groundZ if available (player airborne) so shadow stays on floor
      const shadowDz = ent.groundZ || dz;
      const shadowScale = fov / shadowDz;
      const shadowScreenX = (W * 0.5) + (ent.x - cameraX) * shadowScale;
      const shadowScreenY = horizonY + camHeight * shadowScale;
      if (_iframeInvisible) continue; // skip shadow + label for invisible frame
      ctx.save();
      // Shadow fades with distance: strong near camera (Z=120), faint at horizon (Z=480)
      // Tuned for new Z range: 1/(dz*0.004+0.3) gives ~0.8 at Z=120, ~0.35 at Z=480
      ctx.globalAlpha = 0.45 * Math.min(1, 1 / (shadowDz * 0.004 + 0.3));
      ctx.fillStyle = '#000';
      ctx.beginPath();
      // Slightly larger shadow when airborne to show separation from ground
      const shadowW = (ent.groundZ ? sw * 0.65 : sw * 0.5);
      ctx.ellipse(shadowScreenX, shadowScreenY, shadowW, shadowW * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawEntity(ctx, ent, dx, dy, sw, sh, scale) {
    // Respawn iframe flash: skip draw entirely on "off" frames (empty image effect)
    if (ent.type === 'player' && ent.iframeTimer > 0) {
      // Flash on for 4 frames, off for 4 frames
      if ((ent.iframeTimer % 8) < 4) return; // invisible frame
      // On frame — draw normally below (no hitFlash override during iframes)
    }

    ctx.save();
    if (ent.hitFlash > 0 && !(ent.iframeTimer > 0)) ctx.filter = 'brightness(10)';

    if      (ent.type === 'player')    this._drawPlayer(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'boss')      this._drawBoss(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'enemy')     this._drawEnemy(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'hitEffect') this._drawHitEffect(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'food')      this._drawFood(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'spItem')    this._drawSpItem(ctx, ent, dx, dy, sw, sh);
    else if (ent.type === 'prop')      this._drawProp(ctx, ent, dx, dy, sw, sh);
    else {
      ctx.fillStyle = ent.color || '#888';
      ctx.fillRect(dx, dy, sw, sh);
    }

    ctx.restore();

    if (ent.type === 'enemy' && ent.hp !== undefined) {
      const hpRatio = ent.hp / ent.maxHp;
      const bw = sw, bh = Math.max(2, sh * 0.06), by = dy - bh - 2;
      ctx.fillStyle = '#333';
      ctx.fillRect(dx, by, bw, bh);
      ctx.fillStyle = hpRatio > 0.5 ? '#0f0' : hpRatio > 0.25 ? '#ff0' : '#f00';
      ctx.fillRect(dx, by, bw * hpRatio, bh);
    }

    if (ent.type === 'player' && scale > 0.5) {
      ctx.font = `${Math.max(8, 9 * scale)}px Courier New`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
      ctx.fillText('P1', dx + sw / 2, dy - 4);
    }
  }

  // ─────────────────────────────────────────────
  //  ENTITY DRAW SUB-ROUTINES
  // ─────────────────────────────────────────────

  _drawPlayer(ctx, ent, dx, dy, sw, sh) {
    const facingRight = ent.facing >= 0;

    ctx.fillStyle = '#2255ff';
    ctx.fillRect(dx + sw * 0.2, dy + sh * 0.35, sw * 0.6, sh * 0.45);
    ctx.fillStyle = '#ffcc88';
    ctx.fillRect(dx + sw * 0.25, dy + sh * 0.05, sw * 0.5, sh * 0.3);
    ctx.fillStyle = '#000';
    if (facingRight) ctx.fillRect(dx + sw * 0.55, dy + sh * 0.13, sw * 0.1, sh * 0.07);
    else             ctx.fillRect(dx + sw * 0.32, dy + sh * 0.13, sw * 0.1, sh * 0.07);
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(dx + sw * 0.2, dy + sh * 0.53, sw * 0.6, sh * 0.06);
    ctx.fillStyle = '#113388';
    ctx.fillRect(dx + sw * 0.22, dy + sh * 0.8, sw * 0.22, sh * 0.2);
    ctx.fillRect(dx + sw * 0.56, dy + sh * 0.8, sw * 0.22, sh * 0.2);

    const airborne = ent.jumpY > 0;

    if (ent.state === 'punch') {
      const punchExt = Math.min(1, ent.stateTimer / 6) * sw * 0.4;
      ctx.fillStyle = airborne ? '#ffffaa' : '#ffcc88';
      if (facingRight) ctx.fillRect(dx + sw * 0.8, dy + sh * 0.35, punchExt, sh * 0.12);
      else             ctx.fillRect(dx - punchExt + sw * 0.2, dy + sh * 0.35, punchExt, sh * 0.12);
      // Aerial impact star
      if (airborne) {
        ctx.fillStyle = 'rgba(255,255,100,0.6)';
        ctx.fillRect(dx + (facingRight ? sw * 0.85 : -sw*0.05), dy + sh * 0.2, sw * 0.18, sh * 0.18);
      }
    }
    if (ent.state === 'kick') {
      const kickExt = Math.min(1, ent.stateTimer / 6) * sh * 0.25;
      ctx.fillStyle = airborne ? '#aaddff' : '#113388';
      if (facingRight) ctx.fillRect(dx + sw * 0.6, dy + sh * 0.7 - kickExt * 0.3, sw * 0.45, sh * 0.15);
      else             ctx.fillRect(dx - sw * 0.05, dy + sh * 0.7 - kickExt * 0.3, sw * 0.45, sh * 0.15);
      // Aerial kick trail
      if (airborne) {
        ctx.fillStyle = 'rgba(120,200,255,0.4)';
        if (facingRight) ctx.fillRect(dx + sw * 0.5, dy + sh * 0.55, sw * 0.6, sh * 0.1);
        else             ctx.fillRect(dx - sw * 0.1, dy + sh * 0.55, sw * 0.6, sh * 0.1);
      }
    }
    if (ent.state === 'jump' || airborne) {
      ctx.fillStyle = '#88aaff';
      ctx.fillRect(dx + sw * 0.1, dy - sh * 0.08, sw * 0.8, sh * 0.08);
    }
  }

  _drawEnemy(ctx, ent, dx, dy, sw, sh) {
    const facingRight = ent.facing >= 0;
    const isStunned   = ent.state === 'stun';
    const bodyColor   = isStunned ? '#885500' : '#cc2200';
    const skinColor   = isStunned ? '#cc9966' : '#ffaa66';

    ctx.fillStyle = bodyColor;
    ctx.fillRect(dx + sw * 0.2, dy + sh * 0.35, sw * 0.6, sh * 0.45);
    ctx.fillStyle = skinColor;
    ctx.fillRect(dx + sw * 0.25, dy + sh * 0.05, sw * 0.5, sh * 0.3);
    ctx.fillStyle = '#fff';
    ctx.fillRect(dx + sw * 0.3, dy + sh * 0.1, sw * 0.4, sh * 0.12);
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(dx + sw * 0.33, dy + sh * 0.12, sw * 0.14, sh * 0.08);
    ctx.fillRect(dx + sw * 0.53, dy + sh * 0.12, sw * 0.14, sh * 0.08);
    ctx.fillStyle = '#550000';
    ctx.fillRect(dx + sw * 0.22, dy + sh * 0.8, sw * 0.22, sh * 0.2);
    ctx.fillRect(dx + sw * 0.56, dy + sh * 0.8, sw * 0.22, sh * 0.2);

    if (ent.state === 'attack') {
      ctx.fillStyle = skinColor;
      const ext = Math.sin(ent.stateTimer * 0.3) * sw * 0.35;
      if (facingRight) ctx.fillRect(dx + sw * 0.8, dy + sh * 0.38, Math.abs(ext), sh * 0.12);
      else             ctx.fillRect(dx + sw * 0.2 - Math.abs(ext), dy + sh * 0.38, Math.abs(ext), sh * 0.12);
    }
    if (isStunned) {
      ctx.font = `${Math.max(6, sw * 0.3)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText('★', dx + sw / 2, dy);
    }
  }

  _drawBoss(ctx, ent, dx, dy, sw, sh) {
    const facingRight = ent.facing >= 0;
    const isEnraged   = ent.phase === 2;
    const baseColor   = isEnraged ? '#cc0044' : '#880088';
    const skinColor   = isEnraged ? '#ffaacc' : '#ddaadd';

    if (isEnraged) {
      ctx.save();
      ctx.shadowColor = '#ff0044';
      ctx.shadowBlur  = 12 + Math.abs(Math.sin(ent.animFrame * 0.5)) * 8;
      ctx.fillStyle   = 'rgba(200,0,60,0.15)';
      ctx.fillRect(dx - sw*0.1, dy - sh*0.05, sw*1.2, sh*1.1);
      ctx.restore();
    }

    ctx.fillStyle = baseColor;
    ctx.fillRect(dx + sw*0.15, dy + sh*0.33, sw*0.7, sh*0.48);
    ctx.fillStyle = skinColor;
    ctx.fillRect(dx + sw*0.2, dy + sh*0.04, sw*0.6, sh*0.3);
    ctx.fillStyle = '#fff';
    ctx.fillRect(dx + sw*0.25, dy + sh*0.1, sw*0.2, sh*0.12);
    ctx.fillRect(dx + sw*0.55, dy + sh*0.1, sw*0.2, sh*0.12);
    ctx.fillStyle = isEnraged ? '#ff0000' : '#aa00aa';
    ctx.fillRect(dx + sw*0.29, dy + sh*0.12, sw*0.12, sh*0.08);
    ctx.fillRect(dx + sw*0.59, dy + sh*0.12, sw*0.12, sh*0.08);
    ctx.fillStyle = isEnraged ? '#880022' : '#551155';
    ctx.fillRect(dx + sw*0.04, dy + sh*0.33, sw*0.14, sh*0.2);
    ctx.fillRect(dx + sw*0.82, dy + sh*0.33, sw*0.14, sh*0.2);
    ctx.fillStyle = isEnraged ? '#660022' : '#440044';
    ctx.fillRect(dx + sw*0.18, dy + sh*0.8, sw*0.26, sh*0.2);
    ctx.fillRect(dx + sw*0.56, dy + sh*0.8, sw*0.26, sh*0.2);

    if (ent.chargeActive) {
      ctx.fillStyle = 'rgba(255,100,100,0.5)';
      if (facingRight) ctx.fillRect(dx - sw*0.4, dy + sh*0.3, sw*0.4, sh*0.25);
      else             ctx.fillRect(dx + sw,     dy + sh*0.3, sw*0.4, sh*0.25);
    }
    if (ent.state === 'attack') {
      ctx.fillStyle = skinColor;
      const ext = Math.sin(ent.stateTimer * 0.25) * sw * 0.45;
      if (facingRight) ctx.fillRect(dx + sw*0.85, dy + sh*0.35, Math.abs(ext), sh*0.14);
      else             ctx.fillRect(dx + sw*0.15 - Math.abs(ext), dy + sh*0.35, Math.abs(ext), sh*0.14);
    }
    if (ent.state === 'stun') {
      ctx.font = `${Math.max(6, sw * 0.3)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillText('★', dx + sw / 2, dy - 2);
    }

    ctx.font = `bold ${Math.max(5, sw * 0.28)}px Courier New`;
    ctx.fillStyle = isEnraged ? '#ff4488' : '#dd88ff';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    ctx.fillText(isEnraged ? 'BOSS★' : 'BOSS', dx + sw/2, dy - 3);
  }

  _drawFood(ctx, ent, dx, dy, sw, sh) {
    const cx = dx + sw / 2, cy = dy + sh / 2;
    ctx.save();
    ctx.shadowColor = ent.color || '#ffaa00';
    ctx.shadowBlur  = 6;

    if (ent.kind === 'pizza') {
      ctx.fillStyle = '#ffcc00';
      ctx.beginPath();
      ctx.moveTo(cx, dy);
      ctx.lineTo(dx + sw, dy + sh);
      ctx.lineTo(dx, dy + sh);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ff4400';
      ctx.fillRect(cx - sw*0.15, cy, sw*0.1, sh*0.15);
      ctx.fillRect(cx + sw*0.05, cy - sh*0.1, sw*0.1, sh*0.1);
    } else if (ent.kind === 'chicken') {
      ctx.fillStyle = '#ffdd88';
      ctx.beginPath();
      ctx.ellipse(cx, cy - sh*0.1, sw*0.35, sh*0.4, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#c8a060';
      ctx.fillRect(cx - sw*0.08, cy + sh*0.28, sw*0.16, sh*0.25);
    } else {
      ctx.fillStyle = '#ee2222';
      ctx.beginPath();
      ctx.ellipse(cx, cy + sh*0.05, sw*0.38, sh*0.4, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.fillStyle = '#228833';
      ctx.fillRect(cx - sw*0.05, dy, sw*0.1, sh*0.22);
    }

    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.max(5, sw * 0.4)}px Courier New`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`+${ent.healAmount}`, cx, dy - 2);
    ctx.restore();
  }

  _drawProp(ctx, ent, dx, dy, sw, sh) {
    // variant: 0=crate, 1=barrel, 2=trash
    const broken = ent.broken;
    const t = broken ? Math.max(0, 1 - ent.breakTimer / 20) : 1; // fade on break

    ctx.save();
    ctx.globalAlpha = t;

    if (ent.variant === 0) {
      // Crate — brown wooden box
      const c1 = broken ? '#5a3a10' : '#8b5a2b';
      const c2 = broken ? '#3a2008' : '#5a3a10';
      ctx.fillStyle = c1;
      ctx.fillRect(dx, dy, sw, sh);
      // Wood planks
      ctx.fillStyle = c2;
      ctx.fillRect(dx, dy + sh * 0.33, sw, sh * 0.07);
      ctx.fillRect(dx, dy + sh * 0.66, sw, sh * 0.07);
      ctx.fillRect(dx + sw * 0.33, dy, sw * 0.07, sh);
      ctx.fillRect(dx + sw * 0.66, dy, sw * 0.07, sh);
      if (broken) {
        // Debris splinters
        ctx.fillStyle = '#c8864a';
        ctx.fillRect(dx - sw*0.2, dy + sh*0.1, sw*0.3, sh*0.15);
        ctx.fillRect(dx + sw*0.9, dy + sh*0.5, sw*0.35, sh*0.1);
        ctx.fillRect(dx + sw*0.2, dy + sh*1.05, sw*0.4, sh*0.12);
      }
    } else if (ent.variant === 1) {
      // Barrel — grey metal drum
      const c1 = broken ? '#445566' : '#6688aa';
      const c2 = broken ? '#223344' : '#445566';
      ctx.fillStyle = c1;
      // Rounded barrel shape using fillRect with offset
      ctx.fillRect(dx + sw*0.1, dy, sw*0.8, sh);
      ctx.fillRect(dx, dy + sh*0.15, sw, sh*0.7);
      // Bands
      ctx.fillStyle = c2;
      ctx.fillRect(dx, dy + sh*0.2, sw, sh*0.06);
      ctx.fillRect(dx, dy + sh*0.74, sw, sh*0.06);
      if (broken) {
        // Dented top + spill
        ctx.fillStyle = 'rgba(80,120,160,0.5)';
        ctx.fillRect(dx - sw*0.1, dy + sh*0.8, sw*1.2, sh*0.25);
      }
    } else {
      // Trash can — dark green metal bin
      const c1 = broken ? '#2a4a2a' : '#3a6a3a';
      const c2 = broken ? '#1a2a1a' : '#2a4a2a';
      ctx.fillStyle = c1;
      // Trapezoidal can (wider at top)
      ctx.beginPath();
      ctx.moveTo(dx + sw*0.05, dy + sh);
      ctx.lineTo(dx + sw*0.95, dy + sh);
      ctx.lineTo(dx + sw*0.85, dy);
      ctx.lineTo(dx + sw*0.15, dy);
      ctx.closePath();
      ctx.fill();
      // Lid
      ctx.fillStyle = c2;
      ctx.fillRect(dx + sw*0.1, dy - sh*0.08, sw*0.8, sh*0.1);
      // Horizontal ridges
      ctx.fillStyle = c2;
      ctx.fillRect(dx + sw*0.05, dy + sh*0.35, sw*0.9, sh*0.05);
      ctx.fillRect(dx + sw*0.05, dy + sh*0.65, sw*0.9, sh*0.05);
      if (broken) {
        // Scattered trash
        ctx.fillStyle = '#888866';
        ctx.fillRect(dx - sw*0.15, dy + sh*0.9, sw*0.3, sh*0.12);
        ctx.fillRect(dx + sw*0.8, dy + sh*0.7, sw*0.25, sh*0.1);
      }
    }

    // HP pip indicators on intact props (only if scale is reasonable)
    if (!broken && ent.maxHp > 1) {
      const pipW = sw * 0.18;
      const pipH = sh * 0.05;
      const pipY = dy - pipH - 2;
      for (let i = 0; i < ent.maxHp; i++) {
        const pipX = dx + (i * (pipW + 1));
        ctx.fillStyle = i < ent.hp ? '#ffff44' : '#333';
        ctx.fillRect(pipX, pipY, pipW, pipH);
      }
    }

    ctx.restore();
  }

  _drawSpItem(ctx, ent, dx, dy, sw, sh) {
    const cx = dx + sw / 2, cy = dy + sh / 2;
    ctx.save();
    ctx.shadowColor = '#00ddff';
    ctx.shadowBlur  = 8;

    // Cyan diamond / star shape
    ctx.fillStyle = '#00ddff';
    ctx.beginPath();
    ctx.moveTo(cx, dy);
    ctx.lineTo(dx + sw, cy);
    ctx.lineTo(cx, dy + sh);
    ctx.lineTo(dx, cy);
    ctx.closePath();
    ctx.fill();

    // Inner highlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx, dy + sh*0.25);
    ctx.lineTo(dx + sw*0.7, cy);
    ctx.lineTo(cx, dy + sh*0.5);
    ctx.lineTo(dx + sw*0.3, cy);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.max(5, sw * 0.4)}px Courier New`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('SP', cx, dy - 2);
    ctx.restore();
  }

  _drawHitEffect(ctx, ent, dx, dy, sw, sh) {
    const t  = ent.life / ent.maxLife;
    ctx.globalAlpha = t;
    const cx = dx + sw / 2, cy = dy + sh / 2;
    const r  = sw * 0.6 * t;

    const isCritSpark   = ent.text === 'crit_spark';
    const isPunchImpact = ent.text === 'punch_impact';

    if (isCritSpark) {
      // Gold starburst — 8 spikes alternating long/short
      const colors = ['#ffe000', '#ff8800', '#ffffff'];
      ctx.fillStyle = colors[Math.floor(ent.animFrame % colors.length)];
      for (let i = 0; i < 8; i++) {
        const a   = (i / 8) * Math.PI * 2;
        const len = i % 2 === 0 ? r * 1.2 : r * 0.6;
        ctx.fillRect(cx + Math.cos(a) * len - 2, cy + Math.sin(a) * len - 2, 4, 4);
      }
      ctx.font = `bold ${Math.max(10, sw * 0.6)}px Courier New`;
      ctx.fillStyle = '#ffe000';
      ctx.textAlign = 'center';
      ctx.fillText('CRIT!', cx, cy - r * 0.3);
    } else if (isPunchImpact) {
      // White spark ring — 6 particles
      const colors = ['#ffffff', '#ffff00', '#ff8800'];
      ctx.fillStyle = colors[Math.floor(ent.animFrame % colors.length)];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.fillRect(cx + Math.cos(a) * r - 2, cy + Math.sin(a) * r - 2, 4, 4);
      }
      ctx.font = `bold ${Math.max(8, sw * 0.5)}px Courier New`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('POW!', cx, cy);
    } else {
      // Legacy / fallback: render raw text label (combo escalation strings, SUPER!, etc.)
      const colors = ['#ffffff', '#ffff00', '#ff8800'];
      ctx.fillStyle = colors[Math.floor(ent.animFrame % colors.length)];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.fillRect(cx + Math.cos(a) * r - 2, cy + Math.sin(a) * r - 2, 4, 4);
      }
      ctx.font = `bold ${Math.max(8, sw * 0.5)}px Courier New`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(ent.text || 'POW!', cx, cy);
    }
  }

  // ─────────────────────────────────────────────
  //  UTILS
  // ─────────────────────────────────────────────

  worldToScreen(wx, wz, cameraX, cameraY) {
    const fov = 200, camHeight = 125;
    const dz  = wz - (cameraY || 0);
    if (dz <= 0) return null;
    const scale = fov / dz;
    const sx = this.W / 2 + (wx - cameraX) * scale;
    const sy = this.horizonY + camHeight * scale;
    return { x: sx, y: sy, scale };
  }

  resize(containerWidth) {
    const scale = Math.min(containerWidth / this.W, window.innerHeight / this.H);
    this.canvas.style.width  = (this.W * scale) + 'px';
    this.canvas.style.height = (this.H * scale) + 'px';
  }
}
