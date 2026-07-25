/**
 * deathMenu.js — End-game overlay rendered to canvas.
 *
 * Shows when the player dies (hp <= 0, lives = 0).
 *
 * Three action buttons (keyboard + mouse/touch):
 *   [L] LEADERBOARD   — fetch & display top scores
 *   [M] MAIN MENU     — calls launchMainMenu() hook from menu.js
 *   [N] NEW RUN       — restarts from level 0
 *
 * Keyboard shortcuts:
 *   L / ArrowUp / W   → highlight / confirm LEADERBOARD
 *   M                 → highlight / confirm MAIN MENU
 *   N / Space / Enter → highlight / confirm NEW RUN
 *   ArrowDown / S     → cycle selection downward
 *   ArrowUp / W       → cycle selection upward
 *
 * Usage:
 *   const dm = new DeathMenu(canvas, ctx);
 *   dm.open(score);              // show overlay
 *   dm.update(inputHandler);     // call each tick while active
 *   dm.render(frameCount);       // call each render while active
 *   dm.close();                  // hide (called automatically after action)
 *   // dm.onNewRun, dm.onMainMenu, dm.onLeaderboard = callbacks
 */

import { launchMainMenu } from './menu.js';

const ITEMS = ['LEADERBOARD', 'MAIN MENU', 'NEW RUN'];

// Simple in-memory leaderboard (top 10 by score, this session).
// Replace with a real backend call when available.
const _board = [];
const BOARD_MAX = 10;

function _submitScore(score) {
  _board.push({ score, ts: Date.now() });
  _board.sort((a, b) => b.score - a.score);
  if (_board.length > BOARD_MAX) _board.length = BOARD_MAX;
}

function _getRank(score) {
  // 1-based rank of this score in the board
  const idx = _board.findIndex(e => e.score === score && e.ts === _board[_board.findIndex(e2 => e2.score === score && e2.ts >= e.ts)].ts);
  return idx === -1 ? _board.length : idx + 1;
}

export class DeathMenu {
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx    = ctx;

    this.active     = false;
    this.score      = 0;
    this.cursor     = 2;        // default: NEW RUN
    this.showBoard  = false;
    this.openTimer  = 0;        // frames since open (for entrance animation)

    // Callbacks — assign before calling open()
    this.onNewRun      = null;
    this.onMainMenu    = null;
    this.onLeaderboard = null;  // optional; built-in board shown by default

    // Input debounce
    this._upHeld   = false;
    this._downHeld = false;
    this._confirmHeld = false;

    // Mouse / touch
    this._mouseX = -1;
    this._mouseY = -1;
    this._clicked = false;

    this._boundMouseMove  = this._onMouseMove.bind(this);
    this._boundMouseDown  = this._onMouseDown.bind(this);
    this._boundTouchStart = this._onTouchStart.bind(this);
    this._boundKeyDown    = this._onKeyDown.bind(this);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  open(score) {
    this.score     = score;
    this.cursor    = 2;     // pre-select NEW RUN
    this.showBoard = false;
    this.openTimer = 0;
    this.active    = true;
    this._clicked  = false;

    _submitScore(score);

    // Attach pointer/key listeners
    this.canvas.addEventListener('mousemove',  this._boundMouseMove);
    this.canvas.addEventListener('mousedown',  this._boundMouseDown);
    this.canvas.addEventListener('touchstart', this._boundTouchStart, { passive: true });
    window.addEventListener('keydown', this._boundKeyDown);
  }

  close() {
    this.active    = false;
    this.showBoard = false;

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
    if (k === 'ArrowUp'   || k === 'KeyW') { this.cursor = (this.cursor - 1 + ITEMS.length) % ITEMS.length; e.preventDefault(); }
    if (k === 'ArrowDown' || k === 'KeyS') { this.cursor = (this.cursor + 1) % ITEMS.length; e.preventDefault(); }
    if (k === 'KeyL') { this.cursor = 0; this._triggerCurrent(); e.preventDefault(); }
    if (k === 'KeyM') { this.cursor = 1; this._triggerCurrent(); e.preventDefault(); }
    if (k === 'KeyN' || k === 'Space' || k === 'Enter') { this.cursor = 2; this._triggerCurrent(); e.preventDefault(); }
    if (k === 'Escape') { this.cursor = 2; this._triggerCurrent(); }
  }

  // ── Per-tick update ────────────────────────────────────────────────────────

  update() {
    if (!this.active) return;
    this.openTimer++;

    // Handle pending mouse click
    if (this._clicked) {
      this._clicked = false;
      const hit = this._hitTest(this._mouseX, this._mouseY);
      if (hit !== -1) {
        this.cursor = hit;
        this._triggerCurrent();
      }
    }
  }

  _triggerCurrent() {
    if (!this.active) return;

    switch (this.cursor) {
      case 0: // LEADERBOARD
        this.showBoard = !this.showBoard; // toggle board sub-view
        if (typeof this.onLeaderboard === 'function') this.onLeaderboard(_board);
        break;

      case 1: // MAIN MENU
        this.close();
        if (typeof this.onMainMenu === 'function') {
          this.onMainMenu();
        } else {
          // Default: call the menu.js stub, pass onNewRun as fallback
          launchMainMenu(this.canvas.parentElement, this.onNewRun);
        }
        break;

      case 2: // NEW RUN
        this.close();
        if (typeof this.onNewRun === 'function') this.onNewRun();
        break;
    }
  }

  // Returns button index under (px, py), or -1
  _hitTest(px, py) {
    const W   = this.canvas.width;
    const H   = this.canvas.height;
    const bW  = 140;
    const bH  = 22;
    const bX  = (W - bW) / 2;
    const baseY = H / 2 + 18;

    for (let i = 0; i < ITEMS.length; i++) {
      const bY = baseY + i * (bH + 8);
      if (px >= bX && px <= bX + bW && py >= bY && py <= bY + bH) return i;
    }
    return -1;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(frameCount) {
    if (!this.active) return;

    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;

    // Entrance: slide in from black over 20 frames
    const enterT = Math.min(1, this.openTimer / 20);

    // ── Backdrop ─────────────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = 0.82 * enterT;
    ctx.fillStyle   = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    if (enterT < 0.3) return; // wait for backdrop before drawing text

    const fade = Math.min(1, (enterT - 0.3) / 0.7);

    ctx.save();
    ctx.globalAlpha = fade;

    // ── Panel ─────────────────────────────────────────────────────────────
    const pW = 200, pH = 160;
    const pX = (W - pW) / 2;
    const pY = H / 2 - 75;

    ctx.fillStyle   = 'rgba(10,0,0,0.9)';
    ctx.strokeStyle = '#ff2200';
    ctx.lineWidth   = 1.5;
    _roundRect(ctx, pX, pY, pW, pH, 4);
    ctx.fill();
    ctx.stroke();

    // Corner accents
    ctx.strokeStyle = '#ff6600';
    ctx.lineWidth = 0.5;
    const ca = 8;
    [[pX, pY], [pX+pW, pY], [pX, pY+pH], [pX+pW, pY+pH]].forEach(([cx, cy]) => {
      const sx = cx === pX ? 1 : -1;
      const sy = cy === pY ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx + sx*ca, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy*ca);
      ctx.stroke();
    });

    // ── Title ─────────────────────────────────────────────────────────────
    const pulse = Math.abs(Math.sin(frameCount * 0.08));
    ctx.font      = 'bold 16px Courier New';
    ctx.fillStyle = `rgb(255,${34 + (pulse * 40)|0},0)`;
    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 8;
    ctx.fillText('GAME OVER', W / 2, pY + 22);
    ctx.shadowBlur = 0;

    // ── Score ─────────────────────────────────────────────────────────────
    ctx.font      = '9px Courier New';
    ctx.fillStyle = '#ffff88';
    ctx.fillText(`SCORE: ${this.score}`, W / 2, pY + 37);

    // Rank in session leaderboard
    const rank = _board.findIndex(e => e.score === this.score) + 1 || _board.length;
    ctx.fillStyle = rank === 1 ? '#ffdd00' : '#888';
    ctx.fillText(`SESSION RANK: #${rank} / ${_board.length}`, W / 2, pY + 49);

    // ── Buttons ───────────────────────────────────────────────────────────
    const bW  = 140, bH = 22;
    const bX  = (W - bW) / 2;
    const baseY = pY + 64;

    // Hover detection
    const hoveredBtn = this._hitTest(this._mouseX, this._mouseY);
    if (hoveredBtn !== -1) this.cursor = hoveredBtn;

    const COLORS = [
      ['#00ddff', '#003344'],  // Leaderboard
      ['#ffaa00', '#332200'],  // Main Menu
      ['#44ff66', '#003311'],  // New Run
    ];

    ITEMS.forEach((label, i) => {
      const by       = baseY + i * (bH + 8);
      const selected = this.cursor === i;
      const [fg, bg] = COLORS[i];

      // Button background
      ctx.fillStyle   = selected ? bg : 'rgba(20,20,20,0.8)';
      ctx.strokeStyle = selected ? fg : '#333';
      ctx.lineWidth   = selected ? 1.5 : 0.5;
      _roundRect(ctx, bX, by, bW, bH, 3);
      ctx.fill();
      ctx.stroke();

      // Blinking selection arrow
      if (selected) {
        const blinkOn = Math.floor(frameCount / 8) % 2 === 0;
        if (blinkOn) {
          ctx.fillStyle   = fg;
          ctx.font        = 'bold 9px Courier New';
          ctx.textAlign   = 'left';
          ctx.fillText('▶', bX + 4, by + bH / 2 + 3);
        }
      }

      // Key hint
      const keys = ['[L]', '[M]', '[N]'];
      ctx.font      = '7px Courier New';
      ctx.fillStyle = selected ? fg : '#555';
      ctx.textAlign = 'left';
      ctx.fillText(keys[i], bX + 16, by + bH / 2 + 2);

      // Label
      ctx.font      = selected ? 'bold 10px Courier New' : '9px Courier New';
      ctx.fillStyle = selected ? fg : '#aaa';
      ctx.textAlign = 'center';
      ctx.fillText(label, W / 2 + 10, by + bH / 2 + 3);
    });

    // ── Leaderboard sub-panel ─────────────────────────────────────────────
    if (this.showBoard && this.cursor === 0) {
      this._renderBoard(ctx, W, H, frameCount);
    }

    ctx.restore();
  }

  _renderBoard(ctx, W, H, frameCount) {
    const bpW = 180, bpH = Math.min(160, _board.length * 18 + 36);
    const bpX = (W - bpW) / 2;
    const bpY = H / 2 + 80;

    ctx.fillStyle   = 'rgba(0,5,20,0.95)';
    ctx.strokeStyle = '#00ddff';
    ctx.lineWidth   = 1;
    _roundRect(ctx, bpX, bpY, bpW, bpH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.font      = 'bold 9px Courier New';
    ctx.fillStyle = '#00ddff';
    ctx.textAlign = 'center';
    ctx.fillText('SESSION LEADERBOARD', W / 2, bpY + 14);

    _board.forEach((entry, i) => {
      const row = bpY + 28 + i * 16;
      const isMine = entry.score === this.score;
      ctx.font      = isMine ? 'bold 8px Courier New' : '8px Courier New';
      ctx.fillStyle = isMine ? '#ffdd00' : (i < 3 ? '#ffffff' : '#777');
      ctx.textAlign = 'left';
      ctx.fillText(`#${i+1}`, bpX + 8, row);
      ctx.textAlign = 'right';
      ctx.fillText(entry.score.toLocaleString(), bpX + bpW - 8, row);
    });
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
