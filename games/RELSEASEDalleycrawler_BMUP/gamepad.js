/**
 * gamepad.js — Portable Gamepad API wrapper
 *
 * Drop this file into any game project and use GamepadManager to handle
 * controller input without worrying about browser quirks, sandbox errors,
 * or polling boilerplate.
 *
 * USAGE:
 *   import { GamepadManager, BTN, AXIS } from './gamepad.js';
 *
 *   const gp = new GamepadManager();
 *
 *   gp.on('connected',    (pad) => console.log('Pad connected:', pad.id));
 *   gp.on('disconnected', (pad) => console.log('Pad disconnected:', pad.id));
 *   gp.on('update',       (pads) => { ... read pad.buttons / pad.axes ... });
 *   gp.on('chord',        ({ name, padIndex }) => console.log(name, 'on pad', padIndex));
 *
 *   gp.start();  // begins the rAF poll loop
 *   gp.stop();   // stops polling (call in cleanup / scene teardown)
 *
 * READING INPUT (inside 'update' callback):
 *   pads  — array of active GamepadSnapshot objects (null slots filtered out)
 *
 *   pad.index              — controller slot (0-3)
 *   pad.id                 — browser-reported controller name string
 *   pad.mapping            — 'standard' | '' | other
 *   pad.buttons[i].pressed — boolean
 *   pad.buttons[i].value   — 0.0 – 1.0  (analog triggers)
 *   pad.axes[i]            — -1.0 – 1.0
 *
 * CONVENIENCE HELPERS (available on the manager instance):
 *   gp.isPressed(padIndex, buttonIndex)   → boolean
 *   gp.justPressed(padIndex, buttonIndex) → boolean (true only on first frame)
 *   gp.justReleased(padIndex, buttonIndex)→ boolean
 *   gp.axisValue(padIndex, axisIndex)     → number (-1 to 1, deadzone applied)
 *   gp.getStick(padIndex, xAxis, yAxis)   → { x, y }  (circular deadzone)
 *   gp.vibrate(padIndex, options)         → void  (haptic feedback)
 *
 * CUSTOM BUTTON REMAPPING:
 *   All button helpers resolve logical indices through a per-pad remapping
 *   table before checking state. This lets individual games handle non-standard
 *   controllers without modifying this file.
 *
 *   // Map physical button 2 → logical BTN.A, physical 1 → logical BTN.B, etc.
 *   gp.setButtonMap(padIndex, { [BTN.A]: 2, [BTN.B]: 1 });
 *
 *   // Clear the map for a pad (go back to 1:1 physical indices)
 *   gp.clearButtonMap(padIndex);
 *
 *   // Read the current map (useful when building a calibration UI)
 *   gp.getButtonMap(padIndex);  // → { [logicalIndex]: physicalIndex, ... }
 *
 *   The 'update' event still delivers raw physical snapshots — the remapping
 *   only affects isPressed / justPressed / justReleased so the game logic
 *   can query by logical name while the calibration screen reads raw indices.
 *
 * CHORD (MULTI-BUTTON) INPUTS:
 *   A chord fires once when all its required buttons become simultaneously
 *   held — specifically on the frame the last required button crosses the
 *   pressed threshold (justPressed semantics).
 *
 *   // Define a chord by name + array of logical button indices
 *   gp.defineChord('PAUSE',       [BTN.LT, BTN.START]);
 *   gp.defineChord('SUPER_MOVE',  [BTN.LB, BTN.RB, BTN.A]);
 *
 *   // Optional options object:
 *   //   exclusive: true  (default) — all chord buttons must be down AND no
 *   //                                 other buttons may be held simultaneously
 *   //   exclusive: false           — chord buttons just all need to be held
 *   //                                 (other buttons can be down, e.g. movement)
 *   gp.defineChord('DASH', [BTN.LB, BTN.A], { exclusive: false });
 *
 *   // Listen for a specific chord
 *   gp.onChord('PAUSE', ({ name, padIndex }) => openPauseMenu());
 *
 *   // Or catch all chords via the 'chord' event
 *   gp.on('chord', ({ name, padIndex }) => console.log(name, 'fired on pad', padIndex));
 *
 *   // Remove a chord listener
 *   gp.offChord('PAUSE', myHandler);
 *
 *   // Remove a chord definition entirely
 *   gp.removeChord('PAUSE');
 *
 *   // Query chord state imperatively (useful outside of event callbacks)
 *   gp.isChordActive(padIndex, 'PAUSE')      → boolean  (all buttons currently held)
 *   gp.chordJustFired(padIndex, 'PAUSE')     → boolean  (fired this frame)
 *
 * STANDARD BUTTON MAP (mapping === 'standard'):
 *   0  A        1  B        2  X        3  Y
 *   4  LB       5  RB       6  LT       7  RT
 *   8  Select   9  Start   10  L3      11  R3
 *  12  D-Up    13  D-Down  14  D-Left  15  D-Right
 *  16  Home
 *
 * STANDARD AXIS MAP:
 *   0  Left  X   1  Left  Y   2  Right X   3  Right Y
 */

export class GamepadManager {
  constructor({ deadzone = 0.1 } = {}) {
    this._deadzone    = deadzone;
    this._handlers    = { connected: [], disconnected: [], update: [], chord: [] };
    this._rafId       = null;
    this._running     = false;

    // Snapshot of previous frame's button states for edge detection
    this._prevButtons = {}; // padIndex -> bool[]
    this._currButtons = {}; // padIndex -> bool[]

    // Per-pad button remapping tables: { [logicalIndex]: physicalIndex }
    this._buttonMaps  = {}; // padIndex -> { [logicalIndex]: physicalIndex }

    // ── Chord system ──────────────────────────────────────────────────────────
    // _chords: Map<name, { buttons: number[], exclusive: boolean }>
    this._chords         = new Map();
    // Per-chord, per-pad fired state for this frame (for chordJustFired())
    // _chordFiredThisFrame: Map<name, Set<padIndex>>
    this._chordFiredThisFrame = new Map();
    // Named chord listeners: Map<name, fn[]>
    this._chordHandlers  = new Map();

    this._onConnected    = this._onConnected.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
    this._poll           = this._poll.bind(this);

    window.addEventListener('gamepadconnected',    this._onConnected);
    window.addEventListener('gamepaddisconnected', this._onDisconnected);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Register an event listener.  event: 'connected' | 'disconnected' | 'update' | 'chord' */
  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn);
    return this;
  }

  /** Remove a previously registered listener. */
  off(event, fn) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== fn);
    }
    return this;
  }

  /**
   * Start the polling loop. Safe to call multiple times.
   *
   * Also probes for gamepads that were already connected before this call
   * (e.g. Chrome "sleeping" pads that don't re-fire gamepadconnected).
   */
  start() {
    if (this._running) return this;
    this._running = true;

    // Dual-poll: surface any pads already present but silent
    this._safeGetGamepads().forEach(pad => {
      if (pad) this._emit('connected', pad);
    });

    this._rafId = requestAnimationFrame(this._poll);
    return this;
  }

  /** Stop the polling loop. */
  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    return this;
  }

  /** Fully tear down — stops polling and removes window listeners. */
  destroy() {
    this.stop();
    window.removeEventListener('gamepadconnected',    this._onConnected);
    window.removeEventListener('gamepaddisconnected', this._onDisconnected);
    return this;
  }

  // ─── Button remapping (optional — let individual games handle this) ──────────

  /**
   * Set a custom button map for a specific pad.
   *
   * The map is a plain object keyed by **logical** button index (e.g. BTN.A)
   * with values that are the **physical** button index on that controller.
   *
   * You only need to supply entries that differ from the 1:1 default.
   * Any logical button not listed falls through to its own index unchanged.
   *
   * @example
   *   // Logitech pad with swapped face buttons
   *   gp.setButtonMap(0, { [BTN.A]: 1, [BTN.B]: 0, [BTN.X]: 3, [BTN.Y]: 2 });
   *
   * @param {number} padIndex
   * @param {Record<number, number>} map  — { logicalIndex: physicalIndex }
   */
  setButtonMap(padIndex, map) {
    this._buttonMaps[padIndex] = { ...map };
    return this;
  }

  /**
   * Remove the custom map for a pad, reverting to 1:1 physical indices.
   * @param {number} padIndex
   */
  clearButtonMap(padIndex) {
    delete this._buttonMaps[padIndex];
    return this;
  }

  /**
   * Return the current button map for a pad (or an empty object if none is set).
   * Handy for a calibration screen that needs to inspect or persist the map.
   * @param {number} padIndex
   * @returns {Record<number, number>}
   */
  getButtonMap(padIndex) {
    return this._buttonMaps[padIndex] ? { ...this._buttonMaps[padIndex] } : {};
  }

  // ─── Chord (multi-button) API ──────────────────────────────────────────────

  /**
   * Register a named chord — a combination of buttons that must all be held
   * at the same time. The chord fires once on the frame the last required
   * button is pressed (i.e. justPressed semantics for the combo as a whole).
   *
   * Button indices are **logical** (go through remapping like isPressed does).
   *
   * @param {string}   name           — unique chord name, e.g. 'PAUSE'
   * @param {number[]} buttons        — array of logical button indices
   * @param {object}   [options]
   * @param {boolean}  [options.exclusive=true]
   *   true  → all chord buttons must be held AND no other buttons may be down.
   *           Good for combinations you never want to fire mid-gameplay (pause,
   *           screenshot, dev shortcuts).
   *   false → only the chord buttons need to be held; other buttons are ignored.
   *           Good for modified actions like "sprint + jump" where the player
   *           is also pressing a direction.
   * @returns {this}
   */
  defineChord(name, buttons, { exclusive = true } = {}) {
    if (!Array.isArray(buttons) || buttons.length < 2) {
      console.warn(`[GamepadManager] defineChord('${name}'): requires at least 2 buttons.`);
      return this;
    }
    this._chords.set(name, { buttons: [...buttons], exclusive });
    if (!this._chordHandlers.has(name)) this._chordHandlers.set(name, []);
    return this;
  }

  /**
   * Remove a chord definition and all its named listeners.
   * @param {string} name
   * @returns {this}
   */
  removeChord(name) {
    this._chords.delete(name);
    this._chordHandlers.delete(name);
    this._chordFiredThisFrame.delete(name);
    return this;
  }

  /**
   * Subscribe to a named chord event.
   * The callback receives { name, padIndex }.
   *
   * @param {string}   name
   * @param {Function} fn
   * @returns {this}
   */
  onChord(name, fn) {
    if (!this._chordHandlers.has(name)) this._chordHandlers.set(name, []);
    this._chordHandlers.get(name).push(fn);
    return this;
  }

  /**
   * Remove a named chord listener.
   * @param {string}   name
   * @param {Function} fn
   * @returns {this}
   */
  offChord(name, fn) {
    if (this._chordHandlers.has(name)) {
      this._chordHandlers.set(
        name,
        this._chordHandlers.get(name).filter(h => h !== fn)
      );
    }
    return this;
  }

  /**
   * Returns true if all buttons in the named chord are currently held on the
   * given pad (respects exclusive mode).
   *
   * @param {number} padIndex
   * @param {string} name
   * @returns {boolean}
   */
  isChordActive(padIndex, name) {
    const chord = this._chords.get(name);
    if (!chord) return false;
    return this._chordHeld(padIndex, chord);
  }

  /**
   * Returns true if the named chord fired on this frame for the given pad.
   * Cleared at the start of the next poll frame.
   *
   * @param {number} padIndex
   * @param {string} name
   * @returns {boolean}
   */
  chordJustFired(padIndex, name) {
    return this._chordFiredThisFrame.get(name)?.has(padIndex) ?? false;
  }

  /**
   * Return an array of all defined chord names.
   * @returns {string[]}
   */
  get chordNames() {
    return [...this._chords.keys()];
  }

  // ─── Input helpers (call after 'update' fires, or anywhere in your game loop)

  /** Returns true while button is held. */
  isPressed(padIndex, buttonIndex) {
    return !!(this._currButtons[padIndex]?.[this._resolve(padIndex, buttonIndex)]);
  }

  /** Returns true only on the first frame the button is pressed. */
  justPressed(padIndex, buttonIndex) {
    const phys = this._resolve(padIndex, buttonIndex);
    return !!(this._currButtons[padIndex]?.[phys]) &&
           !(this._prevButtons[padIndex]?.[phys]);
  }

  /** Returns true only on the first frame the button is released. */
  justReleased(padIndex, buttonIndex) {
    const phys = this._resolve(padIndex, buttonIndex);
    return !(this._currButtons[padIndex]?.[phys]) &&
           !!(this._prevButtons[padIndex]?.[phys]);
  }

  /**
   * Raw axis value with per-axis deadzone applied.
   * Returns 0 if the raw value is within the deadzone threshold.
   */
  axisValue(padIndex, axisIndex) {
    const pads = this._safeGetGamepads();
    const pad  = pads[padIndex];
    if (!pad) return 0;
    const v = pad.axes[axisIndex] ?? 0;
    return Math.abs(v) < this._deadzone ? 0 : v;
  }

  /**
   * Get a stick's X/Y as an object with a **circular deadzone**.
   *
   * A circular deadzone discards the whole stick input when the physical
   * displacement magnitude is below the threshold, rather than clamping
   * each axis independently (which creates a cross-shaped dead region).
   *
   * @param {number} padIndex
   * @param {number} xAxis  — default 0 (left stick X)
   * @param {number} yAxis  — default 1 (left stick Y)
   * @returns {{ x: number, y: number }}
   */
  getStick(padIndex, xAxis = 0, yAxis = 1) {
    const pads = this._safeGetGamepads();
    const pad  = pads[padIndex];
    if (!pad) return { x: 0, y: 0 };

    const x = pad.axes[xAxis] ?? 0;
    const y = pad.axes[yAxis] ?? 0;
    const magnitude = Math.sqrt(x * x + y * y);

    if (magnitude < this._deadzone) {
      return { x: 0, y: 0 };
    }
    return { x, y };
  }

  /**
   * Trigger haptic rumble on a controller that supports the Vibration API.
   *
   * @param {number} padIndex  — controller slot (0-3)
   * @param {object} [options]
   * @param {number} [options.duration=200]         — milliseconds
   * @param {number} [options.strongMagnitude=1.0]  — low-frequency motor (0–1)
   * @param {number} [options.weakMagnitude=1.0]    — high-frequency motor (0–1)
   * @param {number} [options.startDelay=0]         — milliseconds before start
   * @returns {Promise|null}  resolves when the effect completes, or null if unsupported
   */
  vibrate(padIndex, {
    duration       = 200,
    strongMagnitude = 1.0,
    weakMagnitude   = 1.0,
    startDelay      = 0,
  } = {}) {
    const pads = this._safeGetGamepads();
    const pad  = pads[padIndex];
    if (pad?.vibrationActuator) {
      return pad.vibrationActuator.playEffect('dual-rumble', {
        startDelay,
        duration,
        strongMagnitude,
        weakMagnitude,
      }).catch(() => null); // silently ignore if browser rejects the effect
    }
    return null;
  }

  /** Number of currently connected controllers. */
  get count() {
    return this._safeGetGamepads().filter(Boolean).length;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Resolve a logical button index to its physical index via the pad's
   * button map. Falls back to the logical index itself if no mapping exists.
   * @param {number} padIndex
   * @param {number} logicalIndex
   * @returns {number} physicalIndex
   */
  _resolve(padIndex, logicalIndex) {
    const map = this._buttonMaps[padIndex];
    if (!map) return logicalIndex;
    return map[logicalIndex] ?? logicalIndex;
  }

  /**
   * Check whether a chord's buttons are all currently held on padIndex,
   * honouring the chord's exclusive flag.
   * @param {number} padIndex
   * @param {{ buttons: number[], exclusive: boolean }} chord
   * @returns {boolean}
   */
  _chordHeld(padIndex, chord) {
    const curr = this._currButtons[padIndex];
    if (!curr) return false;

    // All required buttons must be pressed (through remapping)
    const allHeld = chord.buttons.every(btn => curr[this._resolve(padIndex, btn)]);
    if (!allHeld) return false;

    if (chord.exclusive) {
      // Build the set of physical indices that belong to this chord
      const chordPhysSet = new Set(chord.buttons.map(b => this._resolve(padIndex, b)));
      // No button outside the chord may be held
      for (let i = 0; i < curr.length; i++) {
        if (curr[i] && !chordPhysSet.has(i)) return false;
      }
    }

    return true;
  }

  /**
   * Detect which chords fired this frame and emit/track them.
   * A chord fires on the frame where:
   *   (a) all required buttons are currently held, AND
   *   (b) at least one of the required buttons was NOT held last frame
   *       (i.e. the combo was just completed — not merely held from before).
   *
   * @param {number} padIndex
   */
  _evalChords(padIndex) {
    for (const [name, chord] of this._chords) {
      const held = this._chordHeld(padIndex, chord);
      if (!held) continue;

      const prev = this._prevButtons[padIndex];
      // At least one chord button must be newly pressed this frame
      const justCompleted = chord.buttons.some(btn => {
        const phys = this._resolve(padIndex, btn);
        return !!(this._currButtons[padIndex][phys]) && !(prev?.[phys]);
      });

      if (!justCompleted) continue;

      // Track for chordJustFired()
      if (!this._chordFiredThisFrame.has(name)) {
        this._chordFiredThisFrame.set(name, new Set());
      }
      this._chordFiredThisFrame.get(name).add(padIndex);

      const payload = { name, padIndex };

      // Fire named listeners
      const named = this._chordHandlers.get(name) || [];
      for (const fn of named) {
        try { fn(payload); } catch (_) {}
      }

      // Fire catch-all 'chord' event
      this._emit('chord', payload);
    }
  }

  _safeGetGamepads() {
    try {
      return navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    } catch (_) {
      return [];
    }
  }

  _onConnected(e) {
    this._emit('connected', e.gamepad);
  }

  _onDisconnected(e) {
    const g = e.gamepad;
    delete this._prevButtons[g.index];
    delete this._currButtons[g.index];
    this._emit('disconnected', g);
  }

  _poll() {
    if (!this._running) return;

    // Clear per-frame chord fired tracking
    this._chordFiredThisFrame.clear();

    const rawPads = this._safeGetGamepads();
    const pads    = [];

    for (const pad of rawPads) {
      if (!pad) continue;

      // First time we see this pad index (fresh connect or reuse after disconnect):
      // seed _prevButtons with all-false so justPressed never reads stale data.
      if (!this._prevButtons[pad.index]) {
        this._prevButtons[pad.index] = new Array(pad.buttons.length).fill(false);
      }

      // Snapshot button pressed states for edge detection
      this._prevButtons[pad.index] = this._currButtons[pad.index] || this._prevButtons[pad.index];
      this._currButtons[pad.index] = pad.buttons.map(b => b.pressed);

      // Evaluate chords for this pad now that curr/prev are up to date
      this._evalChords(pad.index);

      // Build a plain-object snapshot (safe to pass around; no live host objects)
      pads.push({
        index:   pad.index,
        id:      pad.id,
        mapping: pad.mapping,
        buttons: pad.buttons.map(b => ({
          pressed: b.pressed,
          touched: b.touched,
          value:   b.value,
        })),
        axes: Array.from(pad.axes),
        hasVibration: !!(pad.vibrationActuator),
      });
    }

    // Always emit update — even with an empty array — so games that use
    // the 'update' event as their primary tick keep running when no
    // controllers are connected or after a disconnect.
    this._emit('update', pads);

    this._rafId = requestAnimationFrame(this._poll);
  }

  _emit(event, data) {
    for (const fn of this._handlers[event] || []) {
      try { fn(data); } catch (_) { /* don't let listener errors kill the loop */ }
    }
  }
}

// ─── Named button constants for the Standard Gamepad mapping ──────────────────
export const BTN = {
  A:       0,
  B:       1,
  X:       2,
  Y:       3,
  LB:      4,
  RB:      5,
  LT:      6,
  RT:      7,
  SELECT:  8,
  START:   9,
  L3:     10,
  R3:     11,
  UP:     12,
  DOWN:   13,
  LEFT:   14,
  RIGHT:  15,
  HOME:   16,
};

// ─── Named axis constants ─────────────────────────────────────────────────────
export const AXIS = {
  LEFT_X:  0,
  LEFT_Y:  1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
};
