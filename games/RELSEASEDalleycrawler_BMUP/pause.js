/**
 * pause.js — Pause menu + controls configuration overlay
 *
 * Renders entirely on the game canvas (no DOM overlays), using the
 * canvas 2D context passed in from Game.render().
 *
 * DEFAULT BINDINGS (keyboard codes → action labels):
 *   Move Left   : ArrowLeft / KeyA
 *   Move Right  : ArrowRight / KeyD
 *   Move Up     : ArrowUp / KeyW
 *   Move Down   : ArrowDown / KeyS
 *   Punch       : KeyJ / KeyZ
 *   Kick        : KeyK / KeyX
 *   Jump        : KeyL / KeyC
 *   Super       : ShiftLeft / KeyU
 *   Confirm     : Space
 *
 * The "configure controls" screen lets the player rebind up to two keys
 * per action (primary + alternate). The bindings are stored in
 * localStorage so they persist across sessions, and also exported for
 * the InputHandler to pick up dynamically.
 */

// ── Action definitions ──────────────────────────────────────────────────────

export const ACTIONS = [
  { id: 'left',    label: 'Move Left',   defaults: ['ArrowLeft',  'KeyA']       },
  { id: 'right',   label: 'Move Right',  defaults: ['ArrowRight', 'KeyD']       },
  { id: 'up',      label: 'Move Up',     defaults: ['ArrowUp',    'KeyW']       },
  { id: 'down',    label: 'Move Down',   defaults: ['ArrowDown',  'KeyS']       },
  { id: 'punch',   label: 'Punch',       defaults: ['KeyJ',       'KeyZ']       },
  { id: 'kick',    label: 'Kick',        defaults: ['KeyK',       'KeyX']       },
  { id: 'jump',    label: 'Jump',        defaults: ['KeyL',       'KeyC']       },
  { id: 'super',   label: 'Super Move',  defaults: ['ShiftLeft',  'KeyU']       },
  { id: 'confirm', label: 'Confirm',     defaults: ['Space',      'Enter']      },
  { id: 'pause',   label: 'Pause',       defaults: ['Escape',     'KeyP']       },
];

const STORAGE_KEY = 'beatEmUp_bindings_v4';

import { cues } from './audioCues.js';

// Purge all older versioned keys so stale bindings can never resurface.
try {
  localStorage.removeItem('beatEmUp_bindings_v1');
  localStorage.removeItem('beatEmUp_bindings_v2');
  localStorage.removeItem('beatEmUp_bindings_v3');
} catch (_) {}

// Pretty-print a key code string
function prettyKey(code) {
  const MAP = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
    AltLeft: 'L-ALT', AltRight: 'R-ALT',
  };
  if (MAP[code]) return MAP[code];
  // KeyA → A,  Digit1 → 1, etc.
  if (code.startsWith('Key'))   return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

// ── Bindings store ───────────────────────────────────────────────────────────

export class Bindings {
  constructor() {
    this._map = {};   // actionId → [primary, alternate]
    this._load();
  }

  _defaults() {
    const out = {};
    for (const a of ACTIONS) out[a.id] = [...a.defaults];
    return out;
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // Merge saved over defaults so new actions added later still work
        const merged = { ...this._defaults(), ...saved };

        // Sanity-check: reject any save where directional keys are cross-wired.
        // If 'up' contains ArrowDown (or vice versa) the binding file is corrupt.
        const upCodes   = merged['up']   || [];
        const downCodes = merged['down'] || [];
        const corrupt =
          upCodes.includes('ArrowDown') || upCodes.includes('KeyS') ||
          downCodes.includes('ArrowUp') || downCodes.includes('KeyW');

        if (corrupt) {
          // Wipe the bad save and fall through to defaults
          localStorage.removeItem(STORAGE_KEY);
        } else {
          this._map = merged;
          return;
        }
      }
    } catch (_) {}
    this._map = this._defaults();
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._map)); } catch (_) {}
  }

  reset() {
    this._map = this._defaults();
    this.save();
  }

  /** Returns [primary, alternate] for an action */
  get(actionId) {
    return this._map[actionId] || ACTIONS.find(a => a.id === actionId)?.defaults || [];
  }

  /** Set one slot (slotIdx 0=primary, 1=alternate) for an action */
  set(actionId, slotIdx, code) {
    if (!this._map[actionId]) this._map[actionId] = [...(ACTIONS.find(a => a.id === actionId)?.defaults || [])];
    this._map[actionId][slotIdx] = code;
    this.save();
  }

  /** Returns all bound codes for an action (for isDown checks) */
  codesFor(actionId) {
    return (this._map[actionId] || []).filter(Boolean);
  }

  /** Build a reverse map: keyCode → actionId (first match wins) */
  buildReverseMap() {
    const rev = {};
    for (const [actionId, codes] of Object.entries(this._map)) {
      for (const code of codes) {
        if (code && !rev[code]) rev[code] = actionId;
      }
    }
    return rev;
  }
}

// ── Pause Menu renderer ──────────────────────────────────────────────────────

const MENU_ITEMS = ['RESUME', 'CONFIGURE CONTROLS', 'RESET BINDINGS', 'QUIT TO TITLE'];

export class PauseMenu {
  constructor(bindings) {
    this.bindings    = bindings;
    this.active      = false;
    this.screen      = 'main';    // 'main' | 'controls'

    // Main menu cursor
    this.cursor      = 0;

    // Controls screen state
    this.ctrlCursor  = 0;         // which action row is selected
    this.ctrlSlot    = -1;        // which slot (-1=none, 0=primary, 1=alt) is listening
    this.listening   = false;     // waiting for a key press to bind

    // Gamepad nav (avoid repeat-firing)
    this._navCooldown = 0;

    // Queued actions the Game needs to act on
    this._pendingQuit = false;
  }

  get wantsQuit() {
    const v = this._pendingQuit;
    this._pendingQuit = false;
    return v;
  }

  open() {
    this.active   = true;
    this.screen   = 'main';
    this.cursor   = 0;
    this.listening = false;
  }

  close() {
    this.active   = false;
    this.listening = false;
  }

  // ── Input handling (called by Game before normal input, only when active) ──

  /**
   * Returns true if the pause menu consumed the event and the game
   * should NOT process it further.
   */
  handleKey(e, isDown) {
    if (!this.active) return false;

    // Always block propagation while paused
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }

    if (!isDown) return true; // eat keyup events silently

    if (this.screen === 'main') {
      return this._handleMainKey(e.code);
    } else {
      return this._handleCtrlKey(e.code);
    }
  }

  _handleMainKey(code) {
    if (code === 'ArrowUp'   || code === 'KeyW') { this.cursor = (this.cursor - 1 + MENU_ITEMS.length) % MENU_ITEMS.length; cues.play('menuMove'); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.cursor = (this.cursor + 1) % MENU_ITEMS.length; cues.play('menuMove'); return true; }

    if (code === 'Enter' || code === 'Space' || code === 'KeyJ') {
      this._selectMain();
      return true;
    }
    if (code === 'Escape' || code === 'KeyP') {
      this.close();
      return true;
    }
    return true;
  }

  _selectMain() {
    cues.play('menuConfirm');
    switch (this.cursor) {
      case 0: this.close(); break;
      case 1: this.screen = 'controls'; this.ctrlCursor = 0; this.listening = false; break;
      case 2: this.bindings.reset(); break;
      case 3: this._pendingQuit = true; this.close(); break;
    }
  }

  _handleCtrlKey(code) {
    if (this.listening) {
      // Reject modifier-only presses
      const BAD = ['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight'];
      if (BAD.includes(code) && !['ShiftLeft','ShiftRight'].includes(code)) return true;
      // Escape cancels rebind
      if (code === 'Escape') {
        this.listening = false;
        this.ctrlSlot  = -1;
        return true;
      }
      // Commit binding
      const action = ACTIONS[this.ctrlCursor];
      if (action) {
        this.bindings.set(action.id, this.ctrlSlot, code);
      }
      this.listening = false;
      this.ctrlSlot  = -1;
      return true;
    }

    // Normal navigation
    if (code === 'ArrowUp'   || code === 'KeyW') { this.ctrlCursor = (this.ctrlCursor - 1 + ACTIONS.length) % ACTIONS.length; cues.play('menuMove'); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.ctrlCursor = (this.ctrlCursor + 1) % ACTIONS.length; cues.play('menuMove'); return true; }
    if (code === 'Escape'    || code === 'KeyP') { this.screen = 'main'; return true; }

    // ← / → cycle between primary / alt slot
    if (code === 'ArrowLeft' || code === 'KeyA') {
      this.ctrlSlot = 0;
      this._startListen(0);
      return true;
    }
    if (code === 'ArrowRight' || code === 'KeyD') {
      this.ctrlSlot = 1;
      this._startListen(1);
      return true;
    }
    // Enter / Space / J → start listening on primary slot
    if (code === 'Enter' || code === 'Space') {
      this._startListen(0);
      return true;
    }
    return true;
  }

  _startListen(slot) {
    this.ctrlSlot  = slot;
    this.listening = true;
  }

  // Gamepad navigation (call once per game frame while paused)
  tickGamepad(input) {
    if (!this.active) return;
    if (this._navCooldown > 0) { this._navCooldown--; return; }

    const up    = input.isDown('ArrowUp');
    const down  = input.isDown('ArrowDown');
    const left  = input.isDown('ArrowLeft');
    const right = input.isDown('ArrowRight');
    const fire  = input.wasPressed('KeyJ') || input.wasPressed('Space');
    const back  = input.wasPressed('KeyK');

    let moved = false;
    if (this.screen === 'main') {
      if (up)   { this.cursor = (this.cursor - 1 + MENU_ITEMS.length) % MENU_ITEMS.length; moved = true; }
      if (down) { this.cursor = (this.cursor + 1) % MENU_ITEMS.length; moved = true; }
      if (fire) { this._selectMain(); moved = true; }
      if (back) { this.close(); moved = true; }
    } else {
      if (!this.listening) {
        if (up)    { this.ctrlCursor = (this.ctrlCursor - 1 + ACTIONS.length) % ACTIONS.length; moved = true; }
        if (down)  { this.ctrlCursor = (this.ctrlCursor + 1) % ACTIONS.length; moved = true; }
        if (left)  { this._startListen(0); moved = true; }
        if (right) { this._startListen(1); moved = true; }
        if (fire)  { this._startListen(0); moved = true; }
        if (back)  { this.screen = 'main'; moved = true; }
      }
    }

    if (moved) {
      this._navCooldown = 10;
      if (up || down) cues.play('menuMove');
    }
  }

  // ── Canvas rendering ────────────────────────────────────────────────────────

  render(ctx, W, H, frameCount) {
    if (!this.active) return;

    // Dim background
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle   = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;

    if (this.screen === 'main') {
      this._drawMainMenu(ctx, W, H, frameCount);
    } else {
      this._drawControlsMenu(ctx, W, H, frameCount);
    }

    ctx.restore();
  }

  _drawMainMenu(ctx, W, H, frameCount) {
    const cx = W / 2;

    // Title
    ctx.font      = 'bold 18px "Courier New", monospace';
    ctx.fillStyle = '#ffff44';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 6;
    ctx.fillText('PAUSED', cx, H / 2 - 48);

    ctx.shadowBlur = 0;

    const itemH   = 18;
    const startY  = H / 2 - 14;

    MENU_ITEMS.forEach((item, i) => {
      const y       = startY + i * itemH;
      const sel     = i === this.cursor;
      const pulse   = sel ? Math.abs(Math.sin(frameCount * 0.12)) : 0;

      ctx.font = sel ? 'bold 11px "Courier New", monospace' : '10px "Courier New", monospace';

      if (sel) {
        // Selection highlight bar
        ctx.globalAlpha = 0.25 + pulse * 0.15;
        ctx.fillStyle   = '#ffff44';
        ctx.fillRect(cx - 70, y - 10, 140, 14);
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = sel ? `rgb(255,255,${100 + pulse * 155 | 0})` : '#cccccc';
      ctx.fillText((sel ? '> ' : '  ') + item, cx, y);
    });

    // Footer hint
    ctx.font      = '8px "Courier New", monospace';
    ctx.fillStyle = '#666';
    ctx.fillText('↑↓ Navigate   ENTER/J Confirm   ESC Resume', cx, H - 12);
  }

  _drawControlsMenu(ctx, W, H, frameCount) {
    const cx = W / 2;

    // Title
    ctx.font      = 'bold 12px "Courier New", monospace';
    ctx.fillStyle = '#00ddff';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText('CONFIGURE CONTROLS', cx, 14);
    ctx.shadowBlur = 0;

    // Column headers
    const colLabel  = cx - 60;
    const colPrim   = cx + 15;
    const colAlt    = cx + 55;
    const rowStart  = 26;
    const rowH      = 14;

    ctx.font      = '7px "Courier New", monospace';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('ACTION',    colLabel, rowStart);
    ctx.textAlign = 'center';
    ctx.fillText('PRIMARY',   colPrim,  rowStart);
    ctx.fillText('ALT',       colAlt,   rowStart);

    // Divider
    ctx.fillStyle = '#444';
    ctx.fillRect(cx - 80, rowStart + 2, 160, 1);

    ACTIONS.forEach((action, i) => {
      const y   = rowStart + 10 + i * rowH;
      const sel = i === this.ctrlCursor;
      const [prim, alt] = this.bindings.get(action.id);

      // Row highlight
      if (sel) {
        const pulse = Math.abs(Math.sin(frameCount * 0.12));
        ctx.globalAlpha = 0.2 + pulse * 0.1;
        ctx.fillStyle   = '#00ddff';
        ctx.fillRect(cx - 80, y - 9, 160, 12);
        ctx.globalAlpha = 1;
      }

      // Action label
      ctx.font      = sel ? 'bold 8px "Courier New", monospace' : '8px "Courier New", monospace';
      ctx.fillStyle = sel ? '#fff' : '#aaa';
      ctx.textAlign = 'left';
      ctx.fillText(action.label, colLabel, y);

      // Primary slot
      const drawSlot = (code, slotIdx, x) => {
        const isListening = this.listening && sel && this.ctrlSlot === slotIdx;
        const text = isListening
          ? (frameCount % 20 < 10 ? '[  ?  ]' : '[     ]')
          : (code ? prettyKey(code) : '---');

        ctx.textAlign = 'center';
        ctx.font      = '8px "Courier New", monospace';

        // Slot box
        ctx.strokeStyle = isListening ? '#ffff00' : (sel ? '#00ddff' : '#444');
        ctx.lineWidth   = isListening ? 1.5 : 0.5;
        ctx.strokeRect(x - 17, y - 9, 34, 11);

        ctx.fillStyle = isListening ? '#ffff00' : (sel ? '#00ddff' : '#777');
        ctx.fillText(text, x, y);
      };

      drawSlot(prim, 0, colPrim);
      drawSlot(alt,  1, colAlt);
    });

    // Footer hints
    ctx.font      = '7px "Courier New", monospace';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    const footY   = H - 18;
    ctx.fillText('↑↓ Select action   ← Set Primary   → Set Alt   ESC/K Back', cx, footY);
    if (this.listening) {
      ctx.fillStyle = '#ffff00';
      ctx.font      = 'bold 8px "Courier New", monospace';
      ctx.fillText('Press any key to bind — ESC to cancel', cx, footY - 11);
    }
  }
}
