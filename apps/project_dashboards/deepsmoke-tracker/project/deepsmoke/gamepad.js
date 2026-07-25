/**
 * gamepad.js — Portable Gamepad API wrapper
 *
 * Drop this file into any game project and use GamepadManager to handle
 * controller input without worrying about browser quirks, sandbox errors,
 * or polling boilerplate.
 */

export class GamepadManager {
  constructor({ deadzone = 0.1 } = {}) {
    this._deadzone = deadzone;
    this._handlers = { connected: [], disconnected: [], update: [], chord: [] };
    this._rafId = null;
    this._running = false;

    // Snapshot of previous frame's button states for edge detection
    this._prevButtons = {}; // padIndex -> bool[]
    this._currButtons = {}; // padIndex -> bool[]

    // Per-pad button remapping tables: { [logicalIndex]: physicalIndex }
    this._buttonMaps = {}; // padIndex -> { [logicalIndex]: physicalIndex }

    // Chord system
    this._chords = new Map(); // Map<name, { buttons: number[], exclusive: boolean }>
    this._chordFiredThisFrame = new Map(); // Map<name, Set<padIndex>>
    this._chordHandlers = new Map(); // Map<name, fn[]>

    this._onConnected = this._onConnected.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
    this._poll = this._poll.bind(this);

    window.addEventListener('gamepadconnected', this._onConnected);
    window.addEventListener('gamepaddisconnected', this._onDisconnected);
  }

  // Public API

  // Register an event listener. event: 'connected' | 'disconnected' | 'update' | 'chord'
  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn);
    return this;
  }

  // Remove a previously registered listener.
  off(event, fn) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter(h => h !== fn);
    }
    return this;
  }

  // Start the polling loop. Safe to call multiple times.
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

  // Stop the polling loop.
  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    return this;
  }

  // Fully tear down — stops polling and removes window listeners.
  destroy() {
    this.stop();
    window.removeEventListener('gamepadconnected', this._onConnected);
    window.removeEventListener('gamepaddisconnected', this._onDisconnected);
    return this;
  }

  // Button remapping

  // Set a custom button map for a specific pad.
  setButtonMap(padIndex, map) {
    this._buttonMaps[padIndex] = { ...map };
    return this;
  }

  // Remove the custom map for a pad, reverting to 1:1 physical indices.
  clearButtonMap(padIndex) {
    delete this._buttonMaps[padIndex];
    return this;
  }

  // Return the current button map for a pad (or an empty object if none is set).
  getButtonMap(padIndex) {
    return this._buttonMaps[padIndex] ? { ...this._buttonMaps[padIndex] } : {};
  }

  // Chord (multi-button) API

  // Register a named chord.
  defineChord(name, buttons, { exclusive = true } = {}) {
    if (!Array.isArray(buttons) || buttons.length < 2) {
      console.warn(`[GamepadManager] defineChord('${name}'): requires at least 2 buttons.`);
      return this;
    }
    this._chords.set(name, { buttons: [...buttons], exclusive });
    if (!this._chordHandlers.has(name)) this._chordHandlers.set(name, []);
    return this;
  }

  // Remove a chord definition and all its named listeners.
  removeChord(name) {
    this._chords.delete(name);
    this._chordHandlers.delete(name);
    this._chordFiredThisFrame.delete(name);
    return this;
  }

  // Subscribe to a named chord event.
  onChord(name, fn) {
    if (!this._chordHandlers.has(name)) this._chordHandlers.set(name, []);
    this._chordHandlers.get(name).push(fn);
    return this;
  }

  // Remove a named chord listener.
  offChord(name, fn) {
    if (this._chordHandlers.has(name)) {
      this._chordHandlers.set(
        name,
        this._chordHandlers.get(name).filter(h => h !== fn)
      );
    }
    return this;
  }

  // Returns true if all buttons in the named chord are currently held.
  isChordActive(padIndex, name) {
    const chord = this._chords.get(name);
    if (!chord) return false;
    return this._chordHeld(padIndex, chord);
  }

  // Returns true if the named chord fired on this frame for the given pad.
  chordJustFired(padIndex, name) {
    return this._chordFiredThisFrame.get(name)?.has(padIndex) ?? false;
  }

  // Return an array of all defined chord names.
  get chordNames() {
    return [...this._chords.keys()];
  }

  // Input helpers

  // Returns true while button is held.
  isPressed(padIndex, buttonIndex) {
    return !!(this._currButtons[padIndex]?.[this._resolve(padIndex, buttonIndex)]);
  }

  // Returns true only on the first frame the button is pressed.
  justPressed(padIndex, buttonIndex) {
    const phys = this._resolve(padIndex, buttonIndex);
    return !!(this._currButtons[padIndex]?.[phys]) &&
      !(this._prevButtons[padIndex]?.[phys]);
  }

  // Returns true only on the first frame the button is released.
  justReleased(padIndex, buttonIndex) {
    const phys = this._resolve(padIndex, buttonIndex);
    return !(this._currButtons[padIndex]?.[phys]) &&
      !!(this._prevButtons[padIndex]?.[phys]);
  }

  // Raw axis value with per-axis deadzone applied.
  axisValue(padIndex, axisIndex) {
    const pads = this._safeGetGamepads();
    const pad = pads[padIndex];
    if (!pad) return 0;
    const v = pad.axes[axisIndex] ?? 0;
    return Math.abs(v) < this._deadzone ? 0 : v;
  }

  // Get a stick's X/Y as an object with a circular deadzone.
  getStick(padIndex, xAxis = 0, yAxis = 1) {
    const pads = this._safeGetGamepads();
    const pad = pads[padIndex];
    if (!pad) return { x: 0, y: 0 };

    const x = pad.axes[xAxis] ?? 0;
    const y = pad.axes[yAxis] ?? 0;
    const magnitude = Math.sqrt(x * x + y * y);

    if (magnitude < this._deadzone) return { x: 0, y: 0 };
    return { x, y };
  }

  // Trigger haptic rumble if supported.
  vibrate(padIndex, {
    duration = 200,
    strongMagnitude = 1.0,
    weakMagnitude = 1.0,
    startDelay = 0,
  } = {}) {
    const pads = this._safeGetGamepads();
    const pad = pads[padIndex];
    if (pad?.vibrationActuator) {
      return pad.vibrationActuator.playEffect('dual-rumble', {
        startDelay,
        duration,
        strongMagnitude,
        weakMagnitude,
      }).catch(() => null);
    }
    return null;
  }

  // Number of currently connected controllers.
  get count() {
    return this._safeGetGamepads().filter(Boolean).length;
  }

  // Internal

  // Resolve a logical button index to its physical index via the pad's map.
  _resolve(padIndex, logicalIndex) {
    const map = this._buttonMaps[padIndex];
    if (!map) return logicalIndex;
    return map[logicalIndex] ?? logicalIndex;
  }

  // Check whether a chord's buttons are all currently held.
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

  // Detect which chords fired this frame and emit/track them.
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
      if (!this._chordFiredThisFrame.has(name)) this._chordFiredThisFrame.set(name, new Set());
      this._chordFiredThisFrame.get(name).add(padIndex);

      const payload = { name, padIndex };

      // Fire named listeners
      const named = this._chordHandlers.get(name) || [];
      for (const fn of named) {
        try {
          fn(payload);
        } catch (_) {}
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
    const pads = [];

    for (const pad of rawPads) {
      if (!pad) continue;

      // First time we see this pad index: seed _prevButtons with all-false
      if (!this._prevButtons[pad.index]) {
        this._prevButtons[pad.index] = new Array(pad.buttons.length).fill(false);
      }

      // Snapshot button pressed states for edge detection
      this._prevButtons[pad.index] = this._currButtons[pad.index] || this._prevButtons[pad.index];
      this._currButtons[pad.index] = pad.buttons.map(b => b.pressed);

      // Evaluate chords for this pad now that curr/prev are up to date
      this._evalChords(pad.index);

      // Build a plain-object snapshot
      pads.push({
        index: pad.index,
        id: pad.id,
        mapping: pad.mapping,
        buttons: pad.buttons.map(b => ({
          pressed: b.pressed,
          touched: b.touched,
          value: b.value,
        })),
        axes: Array.from(pad.axes),
        hasVibration: !!pad.vibrationActuator,
      });
    }

    // Always emit update (even empty) so event-driven ticks still run.
    this._emit('update', pads);

    this._rafId = requestAnimationFrame(this._poll);
  }

  _emit(event, data) {
    for (const fn of this._handlers[event] || []) {
      try {
        fn(data);
      } catch (_) {
        // Listener errors should never kill the poll loop.
      }
    }
  }
}

// Named button constants for the Standard Gamepad mapping.
export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
};

// Named axis constants.
export const AXIS = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
};
