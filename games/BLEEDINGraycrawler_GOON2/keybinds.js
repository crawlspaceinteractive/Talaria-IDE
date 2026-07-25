/**
 * keybinds.js — Bindable input system for Goblin Dungeon
 *
 * Maps logical game actions to keyboard keys and/or gamepad buttons.
 * Bindings are persisted to localStorage and can be remapped via a UI.
 *
 * ACTIONS:
 *   moveForward, moveBack, strafeLeft, strafeRight
 *   shoot, use, map, pause
 *   weapon1 … weapon6
 *
 * Each action has:
 *   { keys: string[], gpBtn: number|null }
 *
 * UI:
 *   KeybindUI — renders a remap screen into a container element.
 */

import { BTN } from './gamepad.js';

const STORAGE_KEY = 'goblin_keybinds_v1';

// ── Default bindings ──────────────────────────────────────────────────��──────
const DEFAULTS = {
  moveForward:  { keys: ['w', 'W', 'ArrowUp'],    gpBtn: BTN.UP,    label: 'MOVE FORWARD'    },
  moveBack:     { keys: ['s', 'S', 'ArrowDown'],   gpBtn: BTN.DOWN,  label: 'MOVE BACK'       },
  strafeLeft:   { keys: ['a', 'A'],                gpBtn: BTN.LEFT,  label: 'STRAFE LEFT'     },
  strafeRight:  { keys: ['d', 'D'],                gpBtn: BTN.RIGHT, label: 'STRAFE RIGHT'    },
  turnLeft:     { keys: ['ArrowLeft'],             gpBtn: null,      label: 'TURN LEFT'       },
  turnRight:    { keys: ['ArrowRight'],            gpBtn: null,      label: 'TURN RIGHT'      },
  shoot:        { keys: [' '],                     gpBtn: BTN.RT,    label: 'SHOOT'           },
  use:          { keys: ['e', 'E', 'f', 'F'],      gpBtn: BTN.A,     label: 'USE / INTERACT'  },
  map:          { keys: ['q', 'Q'],                gpBtn: BTN.SELECT, label: 'AUTOMAP'        },
  weapon1:      { keys: ['1'],                     gpBtn: null,      label: 'WEAPON 1'        },
  weapon2:      { keys: ['2'],                     gpBtn: null,      label: 'WEAPON 2'        },
  weapon3:      { keys: ['3'],                     gpBtn: null,      label: 'WEAPON 3'        },
  weapon4:      { keys: ['4'],                     gpBtn: null,      label: 'WEAPON 4'        },
  weapon5:      { keys: ['5'],                     gpBtn: null,      label: 'WEAPON 5'        },
  weapon6:      { keys: ['6'],                     gpBtn: null,      label: 'WEAPON 6'        },
  weaponNext:   { keys: [']'],                     gpBtn: BTN.RB,    label: 'WEAPON NEXT'     },
  weaponPrev:   { keys: ['['],                     gpBtn: BTN.LB,    label: 'WEAPON PREV'     },
};

// Pretty-print a key for display
export function keyLabel(key) {
  const MAP = {
    ' ': 'SPACE', 'ArrowUp': '↑', 'ArrowDown': '↓',
    'ArrowLeft': '←', 'ArrowRight': '→',
    'Escape': 'ESC', 'Enter': 'ENTER', 'Shift': 'SHIFT',
    'Control': 'CTRL', 'Alt': 'ALT', 'Tab': 'TAB',
    'Backspace': 'BKSP', 'Delete': 'DEL',
  };
  return MAP[key] || key.toUpperCase();
}

export function gpBtnLabel(btn) {
  if (btn === null || btn === undefined) return '—';
  const NAMES = {
    [BTN.A]: 'A', [BTN.B]: 'B', [BTN.X]: 'X', [BTN.Y]: 'Y',
    [BTN.LB]: 'LB', [BTN.RB]: 'RB', [BTN.LT]: 'LT', [BTN.RT]: 'RT',
    [BTN.SELECT]: 'SEL', [BTN.START]: 'START',
    [BTN.UP]: 'D↑', [BTN.DOWN]: 'D↓', [BTN.LEFT]: 'D←', [BTN.RIGHT]: 'D→',
  };
  return NAMES[btn] !== undefined ? NAMES[btn] : `B${btn}`;
}

// ── KeybindManager ────────────────────────────────────────────────────────────
export class KeybindManager {
  constructor() {
    this._binds = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this._deepCloneDefaults();
      const saved = JSON.parse(raw);
      // Merge saved over defaults so new actions added in updates still appear
      const merged = this._deepCloneDefaults();
      for (const action of Object.keys(merged)) {
        if (saved[action]) {
          if (Array.isArray(saved[action].keys)) merged[action].keys = saved[action].keys;
          if (saved[action].gpBtn !== undefined) merged[action].gpBtn = saved[action].gpBtn;
        }
      }
      return merged;
    } catch(e) {
      return this._deepCloneDefaults();
    }
  }

  _save() {
    try {
      // Only save keys + gpBtn (not label — that comes from DEFAULTS)
      const toSave = {};
      for (const [action, bind] of Object.entries(this._binds)) {
        toSave[action] = { keys: bind.keys, gpBtn: bind.gpBtn };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch(e) {}
  }

  _deepCloneDefaults() {
    const out = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      out[k] = { ...v, keys: [...v.keys] };
    }
    return out;
  }

  reset() {
    this._binds = this._deepCloneDefaults();
    this._save();
  }

  getActions() {
    return Object.keys(this._binds);
  }

  getBind(action) {
    return this._binds[action] || null;
  }

  /** Set the primary keyboard key for an action (replaces first non-modifier key). */
  setKey(action, key) {
    if (!this._binds[action]) return;
    this._binds[action].keys = [key];
    this._save();
  }

  /** Set the gamepad button for an action (null = unbound). */
  setGpBtn(action, btnIndex) {
    if (!this._binds[action]) return;
    this._binds[action].gpBtn = btnIndex;
    this._save();
  }

  /** Check if a keyboard key activates an action. */
  keyMatchesAction(action, key) {
    const bind = this._binds[action];
    if (!bind) return false;
    return bind.keys.includes(key) || bind.keys.includes(key.toLowerCase());
  }

  /** Check if a gamepad button index activates an action. */
  gpBtnMatchesAction(action, btnIndex) {
    const bind = this._binds[action];
    if (!bind) return false;
    return bind.gpBtn === btnIndex;
  }

  /**
   * Build an `isActive(action)` checker from an InputManager's keys dict
   * plus an optional GamepadManager.
   */
  buildChecker(keys, gp, padIndex = 0) {
    return (action) => {
      const bind = this._binds[action];
      if (!bind) return false;
      // Keyboard
      for (const k of bind.keys) {
        if (keys[k] || keys[k.toLowerCase()]) return true;
      }
      // Gamepad
      if (gp && bind.gpBtn !== null && bind.gpBtn !== undefined) {
        if (gp.isPressed(padIndex, bind.gpBtn)) return true;
      }
      return false;
    };
  }
}

// Singleton export so every module shares one instance
export const keybinds = new KeybindManager();

// ── KeybindUI ─────────────────────────────────────────────────────────────────
/**
 * Renders a keybind editor into `container`.
 * @param {HTMLElement} container
 * @param {KeybindManager} km
 * @param {GamepadManager|null} gp
 */
export function buildKeybindUI(container, km, gp) {
  container.innerHTML = '';

  const FONT = "'Press Start 2P','Courier New',monospace";
  const MENU_GFX = "url('https://vtelpopqybfytrgzkomj.supabase.co/storage/v1/object/public/game-assets/public/9f509457-a9ea-4f36-833c-dd820c597ef0/d7eb80a7-ff8e-4ac3-86e2-c556c89b37c9/fdb63185-ff37-475a-b318-2752bb8dfe27.png')";

  // Waiting-for-key state
  let _waitingAction = null;
  let _waitingMode   = null; // 'key' | 'gpbtn'
  let _waitingRow    = null;

  const cancelWait = () => {
    _waitingAction = null;
    _waitingMode   = null;
    if (_waitingRow) { _waitingRow.classList.remove('kb-waiting'); _waitingRow = null; }
  };

  // Key listener for capture mode
  const _keyListener = (e) => {
    if (!_waitingAction || _waitingMode !== 'key') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { cancelWait(); return; }
    km.setKey(_waitingAction, e.key);
    cancelWait();
    render();
  };

  // Gamepad poll for capture mode
  let _gpPollId = null;
  const startGpPoll = (action) => {
    stopGpPoll();
    _gpPollId = setInterval(() => {
      if (!gp) { stopGpPoll(); cancelWait(); return; }
      const pads = gp._safeGetGamepads();
      for (const pad of pads) {
        if (!pad) continue;
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i].pressed) {
            km.setGpBtn(action, i);
            stopGpPoll();
            cancelWait();
            render();
            return;
          }
        }
      }
    }, 60);
  };
  const stopGpPoll = () => {
    if (_gpPollId !== null) { clearInterval(_gpPollId); _gpPollId = null; }
  };

  // Cleanup function stored on container for external teardown
  container._keybindCleanup = () => {
    stopGpPoll();
    window.removeEventListener('keydown', _keyListener, true);
  };

  const render = () => {
    container.innerHTML = '';

    // Inject CSS once
    if (!document.getElementById('kb-ui-style')) {
      const s = document.createElement('style');
      s.id = 'kb-ui-style';
      s.textContent = `
        .kb-row {
          display:flex;align-items:center;gap:6px;
          padding:4px 0;border-bottom:1px solid rgba(0,255,80,0.1);
        }
        .kb-row.kb-waiting { background:rgba(255,200,0,0.08); }
        .kb-label {
          flex:1;color:#fff;font-size:6px;letter-spacing:1px;
          font-family:'Press Start 2P','Courier New',monospace;
          text-shadow:-1px -1px 0 #000,1px 1px 0 #000;
        }
        .kb-badge {
          display:inline-block;min-width:40px;padding:2px 5px;
          background:rgba(0,0,0,0.55);border:1px solid rgba(0,255,80,0.3);
          color:#fff;font-size:5px;letter-spacing:1px;text-align:center;
          font-family:'Press Start 2P','Courier New',monospace;cursor:pointer;
          white-space:nowrap;
          text-shadow:-1px -1px 0 #000,1px 1px 0 #000;
        }
        .kb-badge:hover { border-color:#00ff50;background:rgba(0,80,30,0.5); }
        .kb-badge.active { border-color:#ffdd44;color:#ffdd44; }
        .kb-sep { color:#aaa;font-size:5px;font-family:'Press Start 2P','Courier New',monospace; }
        .kb-reset-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(0,0,0,0.6);
          border: 1px solid rgba(255,255,255,0.18);
          margin-top: 10px;
          padding: 0 24px;
          height: 48px;
          min-width: 200px;
          cursor: pointer;
          font-family: 'Press Start 2P','Courier New',monospace;
          font-size: 7px;
          letter-spacing: 1px;
          color: #fff;
          text-transform: uppercase;
          text-shadow: 2px 2px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000;
          transition: background 0.08s, border-color 0.08s;
        }
        .kb-reset-btn:hover { background: rgba(0,0,0,0.78); border-color: rgba(255,80,80,0.55); text-shadow: 2px 2px 0 #000,0 0 14px #fff,0 0 6px #ff4444; }
        .kb-reset-btn:active { background: rgba(0,0,0,0.9); transform: translateY(1px); }
        .kb-hint {
          color:#aaa;font-size:5px;font-family:'Press Start 2P','Courier New',monospace;
          margin:6px 0 10px;letter-spacing:1px;
          text-shadow:-1px -1px 0 #000,1px 1px 0 #000;
        }
      `;
      document.head.appendChild(s);
    }

    // Section wrapper
    const wrap = document.createElement('div');
    wrap.style.cssText = `border:none;padding:10px 16px;min-width:280px;max-width:340px;
      border-image:${MENU_GFX} 0 33% 0 33% fill / 0 13px 0 13px / 0px round stretch;
      image-rendering:pixelated;`;

    const title = document.createElement('div');
    title.style.cssText = `color:#fff;font-size:6px;letter-spacing:2px;margin-bottom:6px;
      text-transform:uppercase;font-family:${FONT};
      text-shadow:-1px -1px 0 #000,1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000;`;
    title.textContent = '🎮 KEY BINDINGS';
    wrap.appendChild(title);

    const hint = document.createElement('div');
    hint.className = 'kb-hint';
    hint.textContent = 'CLICK KEY/BTN BADGE TO REBIND  •  ESC = CANCEL';
    wrap.appendChild(hint);

    for (const action of km.getActions()) {
      const bind = km.getBind(action);
      if (!bind) continue;

      const row = document.createElement('div');
      row.className = 'kb-row';
      if (_waitingAction === action) row.classList.add('kb-waiting');

      const label = document.createElement('span');
      label.className = 'kb-label';
      label.textContent = bind.label;
      row.appendChild(label);

      // Primary key badge
      const keyBadge = document.createElement('span');
      keyBadge.className = 'kb-badge' + (_waitingAction === action && _waitingMode === 'key' ? ' active' : '');
      keyBadge.title = 'Click to remap keyboard key';
      const displayKey = bind.keys[0] ? keyLabel(bind.keys[0]) : '?';
      keyBadge.textContent = _waitingAction === action && _waitingMode === 'key'
        ? '[ PRESS KEY ]' : displayKey;
      keyBadge.addEventListener('click', () => {
        if (_waitingAction === action && _waitingMode === 'key') { cancelWait(); return; }
        cancelWait();
        _waitingAction = action;
        _waitingMode   = 'key';
        _waitingRow    = row;
        row.classList.add('kb-waiting');
        // Update badge text inline
        keyBadge.textContent = '[ PRESS KEY ]';
        keyBadge.classList.add('active');
        window.addEventListener('keydown', _keyListener, true);
      });
      row.appendChild(keyBadge);

      // Separator
      const sep = document.createElement('span');
      sep.className = 'kb-sep';
      sep.textContent = '/';
      row.appendChild(sep);

      // Gamepad badge
      const gpBadge = document.createElement('span');
      gpBadge.className = 'kb-badge' + (_waitingAction === action && _waitingMode === 'gpbtn' ? ' active' : '');
      gpBadge.title = 'Click to remap gamepad button';
      gpBadge.textContent = _waitingAction === action && _waitingMode === 'gpbtn'
        ? '[ PRESS BTN ]' : gpBtnLabel(bind.gpBtn);
      gpBadge.addEventListener('click', () => {
        if (!gp) { gpBadge.textContent = 'NO PAD'; setTimeout(() => render(), 1200); return; }
        if (_waitingAction === action && _waitingMode === 'gpbtn') { cancelWait(); stopGpPoll(); return; }
        cancelWait(); stopGpPoll();
        _waitingAction = action;
        _waitingMode   = 'gpbtn';
        _waitingRow    = row;
        row.classList.add('kb-waiting');
        gpBadge.textContent = '[ PRESS BTN ]';
        gpBadge.classList.add('active');
        startGpPoll(action);
      });
      row.appendChild(gpBadge);

      wrap.appendChild(row);
    }

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'kb-reset-btn';
    resetBtn.textContent = '↺ RESET TO DEFAULTS';
    resetBtn.addEventListener('click', () => {
      cancelWait(); stopGpPoll();
      km.reset();
      render();
    });
    wrap.appendChild(resetBtn);

    container.appendChild(wrap);
  };

  render();

  // Cleanup key listener when container is removed
  window.addEventListener('keydown', _keyListener, true);
  return () => { stopGpPoll(); window.removeEventListener('keydown', _keyListener, true); };
}
