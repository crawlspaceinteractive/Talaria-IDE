/**
 * TouchControls — dual-joystick mobile HUD overlay.
 *
 * Layout (landscape):
 *  ┌──────────────────────────────────────────────────────┐
 *  │  [LEFT JOY]          [FIRE][USE]      [RIGHT JOY]    │
 *  │  WASD movement       buttons          look/turn       │
 *  │  [WPN▲][WPN▼]                 [PAUSE][MAP] top-right  │
 *  └──────────────────────────────────────────────────────┘
 *
 * Left joystick  → W/A/S/D keys  (move + strafe)
 * Right joystick → mouseDX/DY    (look / turn)
 * FIRE button    → keys['shoot']
 * USE  button    → keys['e']
 * WPN▲ / WPN▼   → scroll weapon slot up / down
 * PAUSE button   → top-right → calls onPause callback directly
 * MAP button     → top-right → calls onMap callback directly
 *
 * Callbacks (set after construction):
 *   touchControls.onPause      = () => { ... }
 *   touchControls.onMap        = () => { ... }
 *   touchControls.onWeaponNext = () => { ... }
 *   touchControls.onWeaponPrev = () => { ... }
 */

const STICK_RADIUS   = 52;    // outer ring radius (px)
const STICK_KNOB     = 22;    // inner knob radius (px)
const DEAD_ZONE      = 8;     // px dead-zone before input registers
const TURN_SPEED_MUL = 3.2;   // right-stick horizontal turn sensitivity

export class TouchControls {
  /**
   * @param {HTMLElement} container  — the #game-container element
   * @param {object}      input      — InputManager instance
   */
  constructor(container, input) {
    this._container = container;
    this._input = input;
    this._visible = false;

    // Direct action callbacks — wire these up in main.js
    this.onPause      = null;
    this.onMap        = null;
    this.onWeaponNext = null;
    this.onWeaponPrev = null;

    // Only mount on touch-capable devices
    if (!('ontouchstart' in window) && !navigator.maxTouchPoints) return;

    this._buildOverlay(container);
    this._visible = true;
  }

  // ─── Build DOM ──────────────────────────────────────────────────────────────

  _buildOverlay(container) {
    // Overlay canvas for joystick drawing
    const cv = document.createElement('canvas');
    cv.id = 'touch-overlay';
    cv.style.cssText = [
      'position:absolute',
      'top:0', 'left:0', 'right:0', 'bottom:0',
      'width:100%', 'height:100%',
      'pointer-events:none',
      'z-index:30',
      'touch-action:none',
      'image-rendering:pixelated',
    ].join(';');
    container.appendChild(cv);
    this._cv  = cv;
    this._ctx = cv.getContext('2d');

    // ── Left joystick zone (left 38%) ────────────────────────────────────
    const leftZone = document.createElement('div');
    leftZone.id = 'touch-left-zone';
    leftZone.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'width:38%', 'bottom:80px',
      'z-index:31',
      'touch-action:none',
    ].join(';');
    container.appendChild(leftZone);
    this._leftZone = leftZone;

    // ── Right joystick zone (right 38%, above button row) ────────────────
    const rightZone = document.createElement('div');
    rightZone.id = 'touch-right-zone';
    rightZone.style.cssText = [
      'position:absolute',
      'top:0', 'right:0',
      'width:38%', 'bottom:80px',
      'z-index:31',
      'touch-action:none',
    ].join(';');
    container.appendChild(rightZone);
    this._rightZone = rightZone;

    // ── Fire button ───────────────────────────────────────────────────────
    const fireBtn = this._makeBtn('FIRE', '#7b1a10', '#c0392b');
    fireBtn.id = 'touch-fire-btn';
    fireBtn.style.cssText += [
      'position:absolute',
      'right:calc(38% + 12px)',
      'bottom:20px',
      'width:88px', 'height:88px',
      'border-radius:50%',
      'z-index:31',
      'font-size:9px',
    ].join(';');
    container.appendChild(fireBtn);
    this._fireBtn = fireBtn;

    // ── USE button ────────────────────────────────────────────────────────
    const useBtn = this._makeBtn('USE', '#1a4a6b', '#2471a3');
    useBtn.id = 'touch-use-btn';
    useBtn.style.cssText += [
      'position:absolute',
      'right:calc(38% + 112px)',
      'bottom:20px',
      'width:66px', 'height:66px',
      'border-radius:50%',
      'z-index:31',
      'font-size:9px',
    ].join(';');
    container.appendChild(useBtn);
    this._useBtn = useBtn;

    // ── Weapon scroll UP button ───────────────────────────────────────────
    const wpnUpBtn = this._makeBtn('WPN▲', '#2a1a4a', '#5b3a8a');
    wpnUpBtn.id = 'touch-wpn-up-btn';
    wpnUpBtn.style.cssText += [
      'position:absolute',
      'left:8px',
      'bottom:90px',
      'width:56px', 'height:44px',
      'border-radius:6px',
      'z-index:31',
      'font-size:6px',
    ].join(';');
    container.appendChild(wpnUpBtn);
    this._wpnUpBtn = wpnUpBtn;

    // ── Weapon scroll DOWN button ─────────────────────────────────────────
    const wpnDnBtn = this._makeBtn('WPN▼', '#2a1a4a', '#5b3a8a');
    wpnDnBtn.id = 'touch-wpn-dn-btn';
    wpnDnBtn.style.cssText += [
      'position:absolute',
      'left:8px',
      'bottom:38px',
      'width:56px', 'height:44px',
      'border-radius:6px',
      'z-index:31',
      'font-size:6px',
    ].join(';');
    container.appendChild(wpnDnBtn);
    this._wpnDnBtn = wpnDnBtn;

    // ── Pause button ──────────────────────────────────────────────────────
    const pauseBtn = this._makeBtn('II', '#222', '#444');
    pauseBtn.id = 'touch-pause-btn';
    pauseBtn.style.cssText += [
      'position:absolute',
      'top:8px', 'right:8px',
      'width:48px', 'height:48px',
      'border-radius:6px',
      'z-index:32',
      'font-size:13px',
      'letter-spacing:2px',
    ].join(';');
    container.appendChild(pauseBtn);
    this._pauseBtn = pauseBtn;

    // ── Map button ────────────────────────────────────────────────────────
    const mapBtn = this._makeBtn('MAP', '#1a3a1a', '#2d6a2d');
    mapBtn.id = 'touch-map-btn';
    mapBtn.style.cssText += [
      'position:absolute',
      'top:8px', 'right:64px',
      'width:48px', 'height:48px',
      'border-radius:6px',
      'z-index:32',
      'font-size:8px',
    ].join(';');
    container.appendChild(mapBtn);
    this._mapBtn = mapBtn;

    // ── Joystick state objects ────────────────────────────────────────────
    // ox/oy/kx/ky are stored in CANVAS-space (absolute within container)
    this._leftStick  = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };
    this._rightStick = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };

    // Right-stick accumulated turn
    this._input._touchTurnX = 0;

    // Touching anything switches input back to touch mode
    container.addEventListener('touchstart', () => {
      this._input.lastInputType = 'touch';
    }, { passive: true });

    // ── Wire events ────────────────────────────────────────��──────────────
    this._setupLeftStickEvents(leftZone);
    this._setupRightStickEvents(rightZone);
    this._setupBtnEvents(fireBtn, 'shoot');
    this._setupBtnEvents(useBtn,  'e');
    this._setupCallbackBtn(pauseBtn, () => { if (this.onPause) this.onPause(); });
    this._setupCallbackBtn(mapBtn,   () => { if (this.onMap)   this.onMap();   });
    this._setupCallbackBtn(wpnUpBtn, () => { if (this.onWeaponPrev) this.onWeaponPrev(); });
    this._setupCallbackBtn(wpnDnBtn, () => { if (this.onWeaponNext) this.onWeaponNext(); });

    // ── Resize / draw ─────────────────────────────────────────────────────
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();
    this._raf = requestAnimationFrame(this._drawLoop.bind(this));
  }

  _makeBtn(label, bgDark, bgLight) {
    const btn = document.createElement('div');
    btn.textContent = label;
    btn.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:' + bgLight,
      'border:3px solid ' + bgDark,
      'color:#fff',
      'font-family:"Press Start 2P","Courier New",monospace',
      'font-size:10px',
      'letter-spacing:1px',
      'text-shadow:1px 1px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000',
      'user-select:none',
      '-webkit-user-select:none',
      'touch-action:none',
      'opacity:0.82',
      'transition:opacity 0.1s,background 0.1s',
    ].join(';');
    return btn;
  }

  // ─── Button events ───────────────────────────��──────────────────────────���───

  /** Button that writes to input.keys (held state). */
  _setupBtnEvents(el, key) {
    const press = (e) => {
      e.preventDefault();
      el.style.opacity = '1';
      el.style.filter  = 'brightness(1.3)';
      this._input.keys[key] = true;
    };
    const release = (e) => {
      e.preventDefault();
      el.style.opacity = '0.82';
      el.style.filter  = '';
      this._input.keys[key] = false;
    };
    el.addEventListener('touchstart',  press,   { passive: false });
    el.addEventListener('touchend',    release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
  }

  /**
   * Button that fires a one-shot callback on touchstart (no held state).
   * This bypasses the broken keyboard-event-dispatch approach entirely.
   */
  _setupCallbackBtn(el, callback) {
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      el.style.opacity = '1';
      el.style.filter  = 'brightness(1.3)';
      try { callback(); } catch(err) {}
    }, { passive: false });

    const release = (e) => {
      e.preventDefault();
      el.style.opacity = '0.82';
      el.style.filter  = '';
    };
    el.addEventListener('touchend',    release, { passive: false });
    el.addEventListener('touchcancel', release, { passive: false });
  }

  // ─── Left joystick — WASD ────────────────────────────────────────────────────

  _setupLeftStickEvents(zone) {
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (this._leftStick.active) continue;
        // Convert to canvas-space (container-relative)
        const cRect = this._container.getBoundingClientRect();
        const ox = t.clientX - cRect.left;
        const oy = t.clientY - cRect.top;
        this._leftStick = { active: true, id: t.identifier, ox, oy, kx: ox, ky: oy };
      }
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const ls = this._leftStick;
        if (!ls.active || t.identifier !== ls.id) continue;
        const cRect = this._container.getBoundingClientRect();
        const rawX = t.clientX - cRect.left;
        const rawY = t.clientY - cRect.top;

        const dx = rawX - ls.ox;
        const dy = rawY - ls.oy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > STICK_RADIUS) {
          const s = STICK_RADIUS / dist;
          ls.kx = ls.ox + dx * s;
          ls.ky = ls.oy + dy * s;
        } else {
          ls.kx = rawX;
          ls.ky = rawY;
        }

        this._applyLeftStick(dx, dy);
      }
    }, { passive: false });

    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this._leftStick.id) continue;
        this._leftStick = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };
        this._input.keys['w'] = false;
        this._input.keys['a'] = false;
        this._input.keys['s'] = false;
        this._input.keys['d'] = false;
      }
    };
    zone.addEventListener('touchend',    end, { passive: false });
    zone.addEventListener('touchcancel', end, { passive: false });
  }

  _applyLeftStick(dx, dy) {
    const inp = this._input;
    // Y axis → forward / back
    inp.keys['w'] = dy < -DEAD_ZONE;
    inp.keys['s'] = dy >  DEAD_ZONE;
    // X axis → strafe left / right
    inp.keys['a'] = dx < -DEAD_ZONE;
    inp.keys['d'] = dx >  DEAD_ZONE;
  }

  // ─── Right joystick — look / turn ────────────────────────────────────────────

  _setupRightStickEvents(zone) {
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (this._rightStick.active) continue;
        // Convert to canvas-space (container-relative)
        const cRect = this._container.getBoundingClientRect();
        const ox = t.clientX - cRect.left;
        const oy = t.clientY - cRect.top;
        this._rightStick = { active: true, id: t.identifier, ox, oy, kx: ox, ky: oy };
      }
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const rs = this._rightStick;
        if (!rs.active || t.identifier !== rs.id) continue;
        const cRect = this._container.getBoundingClientRect();
        const rawX = t.clientX - cRect.left;
        const rawY = t.clientY - cRect.top;

        const dx = rawX - rs.ox;
        const dy = rawY - rs.oy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > STICK_RADIUS) {
          const s = STICK_RADIUS / dist;
          rs.kx = rs.ox + dx * s;
          rs.ky = rs.oy + dy * s;
        } else {
          rs.kx = rawX;
          rs.ky = rawY;
        }

        this._applyRightStick(dx, dy);
      }
    }, { passive: false });

    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this._rightStick.id) continue;
        this._rightStick = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };
        // Hard-zero turn — no drift
        this._input._touchTurnX = 0;
        this._input.mouseDX     = 0;
      }
    };
    zone.addEventListener('touchend',    end, { passive: false });
    zone.addEventListener('touchcancel', end, { passive: false });
  }

  _applyRightStick(dx, dy) {
    if (Math.abs(dx) > DEAD_ZONE) {
      this._input._touchTurnX = (dx / STICK_RADIUS) * TURN_SPEED_MUL;
    } else {
      this._input._touchTurnX = 0;
      this._input.mouseDX     = 0;
    }
    // dy could feed vertical look if the game ever supports it
  }

  // ─── Draw loop ──────────────────────────────────────────────────────────────

  _resize() {
    const cv   = this._cv;
    const rect = this._container.getBoundingClientRect();
    cv.width   = rect.width;
    cv.height  = rect.height;
  }

  _drawLoop() {
    // Only pump right-stick turn into mouseDX when the overlay is visible.
    // Prevents touch look-input from bleeding through after the controls are hidden.
    if (this._visible && this._cv && this._cv.style.display !== 'none') {
      if (this._input._touchTurnX) {
        this._input.mouseDX += this._input._touchTurnX;
      }
    }

    this._draw();
    this._raf = requestAnimationFrame(this._drawLoop.bind(this));
  }

  _draw() {
    const cv  = this._cv;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, cv.width, cv.height);

    this._drawStick(ctx, this._leftStick,  'rgba(120,200,255,0.55)', 'rgba(120,200,255,0.25)');
    this._drawStick(ctx, this._rightStick, 'rgba(255,200,100,0.55)', 'rgba(255,200,100,0.25)');
  }

  _drawStick(ctx, st, knobColor, ringFill) {
    if (!st.active) return;

    // Outer ring
    ctx.beginPath();
    ctx.arc(st.ox, st.oy, STICK_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.fillStyle = ringFill;
    ctx.fill();

    // Direction line
    const dx = st.kx - st.ox, dy = st.ky - st.oy;
    if (Math.sqrt(dx * dx + dy * dy) > 2) {
      ctx.beginPath();
      ctx.moveTo(st.ox, st.oy);
      ctx.lineTo(st.kx, st.ky);
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Knob
    ctx.beginPath();
    ctx.arc(st.kx, st.ky, STICK_KNOB, 0, Math.PI * 2);
    ctx.fillStyle = knobColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  // ─── Show / hide ────────────────────────────────────────────────────────────

  show() {
    if (!this._cv) return;
    this._visible                 = true;
    this._cv.style.display        = '';
    this._leftZone.style.display  = '';
    this._rightZone.style.display = '';
    this._fireBtn.style.display   = '';
    this._useBtn.style.display    = '';
    this._wpnUpBtn.style.display  = '';
    this._wpnDnBtn.style.display  = '';
    this._pauseBtn.style.display  = '';
    this._mapBtn.style.display    = '';
  }

  hide() {
    if (!this._cv) return;
    this._visible                 = false;
    this._cv.style.display        = 'none';
    this._leftZone.style.display  = 'none';
    this._rightZone.style.display = 'none';
    this._fireBtn.style.display   = 'none';
    this._useBtn.style.display    = 'none';
    this._wpnUpBtn.style.display  = 'none';
    this._wpnDnBtn.style.display  = 'none';
    this._pauseBtn.style.display  = 'none';
    this._mapBtn.style.display    = 'none';

    // Release everything
    this._input.keys['w']     = false;
    this._input.keys['a']     = false;
    this._input.keys['s']     = false;
    this._input.keys['d']     = false;
    this._input.keys['shoot'] = false;
    this._input.keys['e']     = false;
    this._input._touchTurnX   = 0;
    this._input.mouseDX       = 0;

    this._leftStick  = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };
    this._rightStick = { active: false, id: null, ox: 0, oy: 0, kx: 0, ky: 0 };
  }

  /**
   * Call every frame from main.js update() so hiding during non-play phases works.
   * Also hides touch controls when gamepad or keyboard+mouse input was last detected.
   */
  syncVisibility(phase, paused) {
    // Auto-hide touch controls when a gamepad or keyboard is being used
    const inputType = this._input.lastInputType || 'touch';
    const deviceAllowsTouch = (inputType === 'touch');
    const shouldShow = phase === 'playing' && !paused && deviceAllowsTouch;
    if (shouldShow) this.show(); else this.hide();
  }
}
