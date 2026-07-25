/**
 * menu.js — Main Menu
 *
 * Rendered entirely on the game canvas (no DOM overlays).
 * Supports keyboard, gamepad (via InputHandler), and mouse/touch.
 *
 * Items:
 *   START GAME   — fires onStart()
 *   OPTIONS      — fires onOptions() (maps to pause configure-controls)
 *   QUIT TO MENU — no-op when already on menu (kept for future extensibility)
 *
 * Public API:
 *   new MainMenu(canvas, ctx, bindings)
 *   menu.onStart    = fn   ← wired by Game
 *   menu.onOptions  = fn   ← wired by Game (opens configure-controls)
 *   menu.open()
 *   menu.close()
 *   menu.update(inputHandler)
 *   menu.render(frameCount)
 *   menu.active      ← boolean
 *
 * Also exports launchMainMenu() for backward compat with deathMenu.js.
 */

import { cues } from './audioCues.js';

const ITEMS = ['START GAME', 'CONFIGURE CONTROLS'];

export class MainMenu {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx    = ctx;

    this.active   = false;
    this.cursor   = 0;
    this.frame    = 0;

    // Callbacks — assign after construction
    this.onStart   = null;
    this.onOptions = null;

    // Nav cooldown (prevent held-key repeat spam)
    this._navCooldown = 0;

    // Mouse / touch
    this._mouseX  = -1;
    this._mouseY  = -1;
    this._clicked = false;

    this._boundMouseMove  = this._onMouseMove.bind(this);
    this._boundMouseDown  = this._onMouseDown.bind(this);
    this._boundTouchStart = this._onTouchStart.bind(this);
    this._boundKeyDown    = this._onKeyDown.bind(this);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  open() {
    this.active   = true;
    this.cursor   = 0;
    this.frame    = 0;
    this._clicked = false;

    this.canvas.addEventListener('mousemove',  this._boundMouseMove);
    this.canvas.addEventListener('mousedown',  this._boundMouseDown);
    this.canvas.addEventListener('touchstart', this._boundTouchStart, { passive: true });
    window.addEventListener('keydown', this._boundKeyDown);
  }

  close() {
    this.active = false;

    this.canvas.removeEventListener('mousemove',  this._boundMouseMove);
    this.canvas.removeEventListener('mousedown',  this._boundMouseDown);
    this.canvas.removeEventListener('touchstart', this._boundTouchStart);
    window.removeEventListener('keydown', this._boundKeyDown);
  }

  // ── Input listeners ────────────────────────────────────────────────────────

  _onMouseMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    this._mouseX = (e.clientX - r.left) * scaleX;
    this._mouseY = (e.clientY - r.top)  * scaleY;
  }

  _onMouseDown(e) {
    this._onMouseMove(e);
    this._clicked = true;
  }

  _onTouchStart(e) {
    if (!e.touches.length) return;
    const r = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    this._mouseX = (e.touches[0].clientX - r.left) * scaleX;
    this._mouseY = (e.touches[0].clientY - r.top)  * scaleY;
    this._clicked = true;
  }

  _onKeyDown(e) {
    if (!this.active) return;
    const k = e.code;
    if (k === 'ArrowUp'   || k === 'KeyW') { this.cursor = (this.cursor - 1 + ITEMS.length) % ITEMS.length; cues.play('menuMove'); e.preventDefault(); }
    if (k === 'ArrowDown' || k === 'KeyS') { this.cursor = (this.cursor + 1) % ITEMS.length; cues.play('menuMove'); e.preventDefault(); }
    if (k === 'Enter' || k === 'Space' || k === 'KeyJ' || k === 'KeyZ') {
      e.preventDefault();
      this._select();
    }
  }

  // ── Per-tick update (called by Game while phase === 'menu') ───────────────

  update(input) {
    if (!this.active) return;
    this.frame++;

    // Gamepad / action-based nav (respects nav cooldown)
    if (this._navCooldown > 0) {
      this._navCooldown--;
    } else {
      let moved = false;
      if (input && input.actionPressed && input.actionPressed('up')) {
        this.cursor = (this.cursor - 1 + ITEMS.length) % ITEMS.length;
        moved = true;
      }
      if (input && input.actionPressed && input.actionPressed('down')) {
        this.cursor = (this.cursor + 1) % ITEMS.length;
        moved = true;
      }
      if (moved) {
        this._navCooldown = 10;
        cues.play('menuMove');
      }

      if (input && input.actionPressed && input.actionPressed('punch')) {
        this._select();
      }
      if (input && input.actionPressed && input.actionPressed('confirm')) {
        this._select();
      }
    }

    // Mouse / touch click
    if (this._clicked) {
      this._clicked = false;
      const hit = this._hitTest(this._mouseX, this._mouseY);
      if (hit !== -1) {
        this.cursor = hit;
        this._select();
      }
    }

    // Hover cursor from mouse position
    const hovered = this._hitTest(this._mouseX, this._mouseY);
    if (hovered !== -1) this.cursor = hovered;
  }

  _select() {
    cues.play('menuConfirm');
    switch (this.cursor) {
      case 0: // START GAME
        if (typeof this.onStart === 'function') this.onStart();
        break;
      case 1: // CONFIGURE CONTROLS
        if (typeof this.onOptions === 'function') this.onOptions();
        break;
    }
  }

  // Hit-test against rendered button rects — must mirror _drawButtons() layout
  _hitTest(px, py) {
    if (px < 0 || py < 0) return -1;
    const W     = this.canvas.width;
    const H     = this.canvas.height;
    const bW    = 160;
    const bH    = 22;
    const bX    = (W - bW) / 2;
    const baseY = H / 2 + 10;

    for (let i = 0; i < ITEMS.length; i++) {
      const by = baseY + i * (bH + 10);
      if (px >= bX && px <= bX + bW && py >= by && py <= by + bH) return i;
    }
    return -1;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(frameCount) {
    if (!this.active) return;

    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    const cx  = W / 2;

    // ── Backdrop ──────────────────────────────────────────────────────────
    ctx.save();

    // Gradient background — deep navy-to-black
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#000814');
    grad.addColorStop(1, '#010006');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Animated scanline shimmer
    const shimmerY = (frameCount * 1.5) % H;
    ctx.globalAlpha = 0.04;
    ctx.fillStyle   = '#ffffff';
    ctx.fillRect(0, shimmerY, W, 2);
    ctx.globalAlpha = 1;

    // Decorative horizontal rule
    ctx.strokeStyle = '#ff2200';
    ctx.lineWidth   = 0.5;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(10, H / 2 - 2);
    ctx.lineTo(W - 10, H / 2 - 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ── Title ─────────────────────────────────────────────────────────────
    const pulse = Math.abs(Math.sin(frameCount * 0.05));

    // Red glow behind title
    ctx.shadowColor = '#ff2200';
    ctx.shadowBlur  = 18 + pulse * 10;
    ctx.font        = `bold 36px "Courier New", monospace`;
    ctx.fillStyle   = `rgb(255,${30 + (pulse * 30) | 0},0)`;
    ctx.textAlign   = 'center';
    ctx.fillText('BMUP ENGINE', cx, H / 2 - 44);
    ctx.shadowBlur  = 0;

    // Subtitle
    ctx.font      = '8px "Courier New", monospace';
    ctx.fillStyle = '#884400';
    ctx.fillText('by Crawlspace Interactive', cx, H / 2 - 26);

    // ── Buttons ───────────────────────────────────────────────────────────
    const bW    = 160;
    const bH    = 22;
    const bX    = (W - bW) / 2;
    const baseY = H / 2 + 10;

    const COLORS = [
      ['#44ff66', '#003311'],   // START GAME   — green
      ['#00ddff', '#003344'],   // CONFIGURE     — cyan
    ];

    ITEMS.forEach((label, i) => {
      const by       = baseY + i * (bH + 10);
      const selected = this.cursor === i;
      const [fg, bg] = COLORS[i];
      const btnPulse = selected ? Math.abs(Math.sin(frameCount * 0.12)) : 0;

      // Button BG
      ctx.fillStyle   = selected ? bg : 'rgba(15,15,15,0.85)';
      ctx.strokeStyle = selected ? fg : '#333';
      ctx.lineWidth   = selected ? 1.5 : 0.5;
      _roundRect(ctx, bX, by, bW, bH, 3);
      ctx.fill();
      ctx.stroke();

      // Selection glow
      if (selected) {
        ctx.globalAlpha = 0.12 + btnPulse * 0.12;
        ctx.fillStyle   = fg;
        _roundRect(ctx, bX, by, bW, bH, 3);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Arrow blink
        if (Math.floor(frameCount / 8) % 2 === 0) {
          ctx.fillStyle = fg;
          ctx.font      = 'bold 10px "Courier New", monospace';
          ctx.textAlign = 'left';
          ctx.fillText('▶', bX + 6, by + bH / 2 + 3);
        }
      }

      // Label
      ctx.font      = selected ? `bold 11px "Courier New", monospace` : `10px "Courier New", monospace`;
      ctx.fillStyle = selected ? fg : '#888';
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, by + bH / 2 + 4);
    });

    // ── Footer ────────────────────────────────────────────────────────────
    ctx.font      = '7px "Courier New", monospace';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ Navigate   ENTER/J Select   🎮 Gamepad supported', cx, H - 8);

    ctx.restore();
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── Backward-compat export for deathMenu.js ───────────────────────────────────
// deathMenu.js imports launchMainMenu; Game will now intercept onMainMenu before
// this fires, but keep the export so the import doesn't break.
export function launchMainMenu(root, onNew) {
  // No-op stub — Game.deathMenu.onMainMenu is wired directly to Game._goToMenu().
  // Fallback: if called without wiring, restart immediately.
  console.log('[menu.js] launchMainMenu called — forwarding to onNew');
  if (typeof onNew === 'function') onNew();
}
