import { GamepadManager } from './gamepad.js';
import { keybinds } from './keybinds.js';

/**
 * lastInputType: 'touch' | 'keyboard' | 'gamepad'
 * Updated whenever the user generates input from that device.
 * Touch controls hide themselves when lastInputType !== 'touch'.
 */
export class InputManager {
  constructor(canvas) {
    this.keys    = {};
    this.mouseDX = 0;
    this._canvas = canvas;

    // Tracks the most-recently-used input device
    this.lastInputType = 'touch'; // assume touch until proven otherwise

    // ── Gamepad ────────────────────────────────────────────────────────────
    this.gp       = new GamepadManager({ deadzone: 0.15 });
    this.padIndex = 0; // which controller slot to read
    this._gpConnected = false;

    this.gp.on('connected', () => {
      this._gpConnected = true;
      this.lastInputType = 'gamepad';
    });
    this.gp.on('disconnected', () => {
      this._gpConnected = (this.gp.count > 0);
      if (!this._gpConnected) this.lastInputType = 'touch';
    });
    this.gp.start();

    // ── Keyboard ──��─────────���───────────────────────────────────────────────
    window.addEventListener('keydown', e => {
      this.keys[e.key] = true;
      this.keys[e.key.toLowerCase()] = true;
      this.lastInputType = 'keyboard';
    });
    window.addEventListener('keyup', e => {
      this.keys[e.key] = false;
      this.keys[e.key.toLowerCase()] = false;
    });

    // Track the timestamp of the last real touch so we can suppress
    // the synthetic mouse events browsers fire ~300 ms after touch input.
    this._lastTouchTime = 0;

    // Suppress synthetic mouse events from touch — browsers synthesize
    // mousemove/mousedown after touch; these must not flip lastInputType
    // away from 'touch' or trigger shoot via the canvas mousedown handler.
    const isSyntheticMouseEvent = (e) => {
      // InputDeviceCapabilities API (Chrome/Android)
      if (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return true;
      // Fallback: if a real touchstart happened within the last 800 ms, treat
      // any mouse event as synthetic (iOS Safari doesn't expose sourceCapabilities)
      if (Date.now() - this._lastTouchTime < 800) return true;
      return false;
    };

    // Update _lastTouchTime whenever any touch occurs on the page
    document.addEventListener('touchstart', () => {
      this._lastTouchTime = Date.now();
    }, { passive: true });

    // Mouse movement → keyboard/mouse mode (ignore synthetic touch-generated moves)
    document.addEventListener('mousemove', (e) => {
      if (isSyntheticMouseEvent(e)) return;
      if (this.lastInputType !== 'keyboard') this.lastInputType = 'keyboard';
    }, { passive: true });

    // Release all keys on focus loss to prevent stuck movement
    window.addEventListener('blur', () => {
      for (const k in this.keys) this.keys[k] = false;
      this.mouseDX = 0;
    });

    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) {
        for (const k in this.keys) this.keys[k] = false;
        this.mouseDX = 0;
      }
    });

    // Mouse shoot — ignore synthetic events from touch (fire btn handles its own key)
    canvas.addEventListener('mousedown', e => {
      if (isSyntheticMouseEvent(e)) return;
      if (e.button === 0) this.keys['shoot'] = true;
    });
    canvas.addEventListener('mouseup', e => {
      if (isSyntheticMouseEvent(e)) return;
      if (e.button === 0) this.keys['shoot'] = false;
    });
    window.addEventListener('mouseup', e => {
      if (isSyntheticMouseEvent(e)) return;
      if (e.button === 0) this.keys['shoot'] = false;
    });

    document.addEventListener('mousemove', e => {
      if (isSyntheticMouseEvent(e)) return;
      if (document.pointerLockElement === canvas) {
        this.mouseDX += e.movementX;
        this.lastInputType = 'keyboard';
      }
    });

    // Build the keybind action checker (re-built on demand so it's always fresh)
    this._checker = null;
  }

  /** Returns true while an action is active (keyboard OR gamepad). */
  action(name) {
    if (!this._checker) {
      this._checker = keybinds.buildChecker(this.keys, this.gp, this.padIndex);
    }
    return this._checker(name);
  }

  /** Call each frame before reading actions so the checker uses live keys. */
  tick() {
    // Rebuild checker each frame so it always closes over the live keys dict
    this._checker = keybinds.buildChecker(this.keys, this.gp, this.padIndex);

    // Apply gamepad left-stick / d-pad to synthetic key-like flags so
    // existing keys-dict reads still work in code that hasn't been migrated.
    const stick = this.gp.getStick(this.padIndex, 0, 1);
    const DEAD  = 0.25;

    // Left stick — movement
    this._gpFwd   = stick.y < -DEAD;
    this._gpBack  = stick.y >  DEAD;
    this._gpLeft  = stick.x < -DEAD;
    this._gpRight = stick.x >  DEAD;

    // Right stick — turning
    const rs = this.gp.getStick(this.padIndex, 2, 3);
    this.gpTurnX = rs.x; // exposed for main.js look/turn

    // D-pad movement (also covered by keybinds gpBtn, but mirrored here for smooth repeat)
    if (this.gp.isPressed(this.padIndex, 12)) this._gpFwd   = true;
    if (this.gp.isPressed(this.padIndex, 13)) this._gpBack  = true;
    if (this.gp.isPressed(this.padIndex, 14)) this._gpLeft  = true;
    if (this.gp.isPressed(this.padIndex, 15)) this._gpRight = true;

    // Weapon scroll — edge-triggered (fire once per press, not held)
    const wpnNextNow = this.action('weaponNext');
    const wpnPrevNow = this.action('weaponPrev');
    this.gpWpnNext = wpnNextNow && !this._prevWpnNext;
    this.gpWpnPrev = wpnPrevNow && !this._prevWpnPrev;
    this._prevWpnNext = wpnNextNow;
    this._prevWpnPrev = wpnPrevNow;

    // ── Detect any gamepad activity → set lastInputType ────────────────────
    // Check any button pressed or any stick beyond deadzone
    const anyGpActivity = (() => {
      const pad = this.gp._safeGetGamepads ? this.gp._safeGetGamepads()[this.padIndex] : null;
      if (!pad) return false;
      for (let i = 0; i < pad.buttons.length; i++) {
        if (pad.buttons[i].value > 0.1) return true;
      }
      for (const v of pad.axes) {
        if (Math.abs(v) > 0.15) return true;
      }
      return false;
    })();
    if (anyGpActivity) this.lastInputType = 'gamepad';

    // ── Menu navigation — edge-triggered ───────────────────────────────────
    // D-pad up/down + left-stick up/down for menu navigation
    const menuUp    = this.gp.isPressed(this.padIndex, 12) || stick.y < -0.5;
    const menuDown  = this.gp.isPressed(this.padIndex, 13) || stick.y >  0.5;
    const menuLeft  = this.gp.isPressed(this.padIndex, 14) || stick.x < -0.5;
    const menuRight = this.gp.isPressed(this.padIndex, 15) || stick.x >  0.5;
    // A = select, B = back, START = pause
    const menuSel  = this.gp.justPressed(this.padIndex, 0);  // A
    const menuBack = this.gp.justPressed(this.padIndex, 1);  // B
    const menuStart= this.gp.justPressed(this.padIndex, 9);  // START

    this.gpMenuUp    = menuUp    && !this._prevMenuUp;
    this.gpMenuDown  = menuDown  && !this._prevMenuDown;
    this.gpMenuLeft  = menuLeft  && !this._prevMenuLeft;
    this.gpMenuRight = menuRight && !this._prevMenuRight;
    this.gpMenuSel   = menuSel;
    this.gpMenuBack  = menuBack;
    this.gpMenuStart = menuStart;

    this._prevMenuUp    = menuUp;
    this._prevMenuDown  = menuDown;
    this._prevMenuLeft  = menuLeft;
    this._prevMenuRight = menuRight;

    // ── Map toggle — SELECT button (edge-triggered) ────────────────────────
    const mapNow = this.gp.justPressed(this.padIndex, 8); // SELECT
    this.gpMap = mapNow;

    // ── Pause — START button (edge-triggered) ───────────────────────��──────
    this.gpPause = menuStart;
  }

  /** Is the gamepad connected? */
  get gamepadConnected() {
    return this._gpConnected || this.gp.count > 0;
  }

  teardown() {
    this.gp.destroy();
  }
}
