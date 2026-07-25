/**
 * touch.js — Mobile virtual controls for Froyo Engine
 *
 * Renders a floating virtual joystick (left side) and action buttons
 * (right side) as an absolutely-positioned overlay on top of the game canvas.
 *
 * Feeds directly into InputController's public state so no changes are needed
 * in the core input pipeline. The overlay calls patchInput(inputCtrl) once to
 * get a reference, then mutates:
 *   inputCtrl.axisX, inputCtrl.axisY        — from joystick
 *   inputCtrl.mask                          — A / X / START bits
 *
 * The overlay is shown only on touch devices (ontouchstart in window).
 * It uses pointer events so stylus + touch both work.
 */

import { BTN_FLAGS } from "./input.js";

// ─── Layout constants ────────────────────────────────────────────────────────
const JOY_R     = 52;   // outer ring radius px
const JOY_KNOB  = 22;   // inner knob radius px
const BTN_R     = 34;   // action button radius px
const SAFE_EDGE = 24;   // px from screen edge

const ALPHA_IDLE   = "rgba(255,255,255,0.18)";
const ALPHA_ACTIVE = "rgba(255,255,255,0.50)";
const ALPHA_RING   = "rgba(255,255,255,0.10)";

export function createTouchOverlay(container, inputCtrl) {
  // Only mount on touch-capable devices
  if (!("ontouchstart" in window) && !navigator.maxTouchPoints) return null;

  // ── Build DOM ─────────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.id = "froyo-touch";
  overlay.style.cssText = `
    position: absolute; inset: 0;
    pointer-events: none;
    z-index: 10;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  `;
  container.style.position = "relative";
  container.appendChild(overlay);

  // ── Joystick ─────────────────────────────────────────────────────────────
  const joyOuter = _circle(JOY_R, ALPHA_RING);
  const joyKnob  = _circle(JOY_KNOB, ALPHA_IDLE);
  overlay.appendChild(joyOuter);
  overlay.appendChild(joyKnob);

  // ── Action buttons ────────────────────────────────────────────────────────
  // A (Jump), X (Ice Breath), START
  const btnA     = _btn("A",     "rgba(100,200,255,0.35)", BTN_R);
  const btnX     = _btn("X",     "rgba(160,255,160,0.35)", BTN_R);
  const btnStart = _btn("▶",     "rgba(255,255,255,0.22)", 22);
  overlay.appendChild(btnA);
  overlay.appendChild(btnX);
  overlay.appendChild(btnStart);

  // ── State ─────────────────────────────────────────────────────────────────
  let joyActive = false;
  let joyBaseX = 0, joyBaseY = 0;
  let joyPointerId = null;

  // Map pointerId → button element for multi-touch
  const btnPtrs = new Map(); // ptId → {flag, el}

  // ── Position helpers ──────────────────────────────────────────────────────
  function layout() {
    const w = overlay.offsetWidth  || window.innerWidth;
    const h = overlay.offsetHeight || window.innerHeight;

    // Joystick: bottom-left
    const jx = SAFE_EDGE + JOY_R;
    const jy = h - SAFE_EDGE - JOY_R;
    _place(joyOuter, jx - JOY_R, jy - JOY_R, JOY_R * 2, JOY_R * 2);
    _placeKnob(joyKnob, jx, jy);

    // Buttons: bottom-right staggered
    const ax = w - SAFE_EDGE - BTN_R;
    const ay = h - SAFE_EDGE - BTN_R;
    _place(btnA,     ax - BTN_R,      ay - BTN_R,          BTN_R * 2, BTN_R * 2);
    _place(btnX,     ax - BTN_R * 3,  ay - BTN_R * 3,      BTN_R * 2, BTN_R * 2);
    _place(btnStart, w / 2 - 22,       SAFE_EDGE,           44,        44);
  }

  // ── Joystick events ───────────────────────────────────────────────────────
  overlay.addEventListener("pointerdown", onPointerDown, { passive: false });
  overlay.addEventListener("pointermove", onPointerMove, { passive: false });
  overlay.addEventListener("pointerup",   onPointerUp,   { passive: false });
  overlay.addEventListener("pointercancel", onPointerUp, { passive: false });

  function _inJoyZone(px, py) {
    const w = overlay.offsetWidth  || window.innerWidth;
    const h = overlay.offsetHeight || window.innerHeight;
    // Left 40% of screen, bottom 50%
    return px < w * 0.45 && py > h * 0.50;
  }

  function _inBtnEl(el, px, py) {
    const r = el.getBoundingClientRect();
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  }

  function onPointerDown(e) {
    e.preventDefault();
    const px = e.clientX, py = e.clientY;

    // Check action buttons first (right side)
    for (const [flag, el] of [[BTN_FLAGS.A, btnA], [BTN_FLAGS.X, btnX], [BTN_FLAGS.START, btnStart]]) {
      if (_inBtnEl(el, px, py)) {
        btnPtrs.set(e.pointerId, { flag, el });
        overlay.setPointerCapture(e.pointerId);
        el.style.background = ALPHA_ACTIVE;
        // Inject into inputCtrl — set bit + prevMask stays off → justPressed fires
        inputCtrl.mask     |= flag;
        // We'll clear it on pointerup; for now also mark prevMask to avoid sticky
        return;
      }
    }

    // Joystick zone
    if (joyPointerId === null && _inJoyZone(px, py)) {
      joyPointerId = e.pointerId;
      overlay.setPointerCapture(e.pointerId);
      joyActive = true;
      joyBaseX = px;
      joyBaseY = py;
      joyKnob.style.background = ALPHA_ACTIVE;
    }
  }

  function onPointerMove(e) {
    if (e.pointerId === joyPointerId) {
      const dx = e.clientX - joyBaseX;
      const dy = e.clientY - joyBaseY;
      const len = Math.sqrt(dx * dx + dy * dy);
      const maxLen = JOY_R * 0.85;
      const clampedLen = Math.min(len, maxLen);
      const nx = len > 1 ? dx / len : 0;
      const ny = len > 1 ? dy / len : 0;

      // Update knob visual position
      const w = overlay.offsetWidth  || window.innerWidth;
      const h = overlay.offsetHeight || window.innerHeight;
      const jx = SAFE_EDGE + JOY_R;
      const jy = h - SAFE_EDGE - JOY_R;
      _placeKnob(joyKnob, jx + nx * clampedLen, jy + ny * clampedLen);

      // Feed into input: axisX = nx (X right), axisY = ny (Y down = forward in camera space)
      inputCtrl._touchAxisX = nx * Math.min(len / maxLen, 1);
      inputCtrl._touchAxisY = ny * Math.min(len / maxLen, 1);
    }
  }

  function onPointerUp(e) {
    if (e.pointerId === joyPointerId) {
      joyActive = false;
      joyPointerId = null;
      inputCtrl._touchAxisX = 0;
      inputCtrl._touchAxisY = 0;
      const w = overlay.offsetWidth  || window.innerWidth;
      const h = overlay.offsetHeight || window.innerHeight;
      _placeKnob(joyKnob, SAFE_EDGE + JOY_R, h - SAFE_EDGE - JOY_R);
      joyKnob.style.background = ALPHA_IDLE;
    }
    const btn = btnPtrs.get(e.pointerId);
    if (btn) {
      btn.el.style.background = btn.el === btnStart ? "rgba(255,255,255,0.22)" :
        btn.el === btnA ? "rgba(100,200,255,0.35)" : "rgba(160,255,160,0.35)";
      btnPtrs.delete(e.pointerId);
      // Clear the bit on release
      inputCtrl.mask &= ~btn.flag;
    }
  }

  // ── Sample hook — called each frame by InputController.sample() patch ─────
  // We monkey-patch InputController.sample to inject touch axes into the merge.
  // Done AFTER construction so the original sample is already bound.
  const _origSample = inputCtrl.sample.bind(inputCtrl);
  inputCtrl.sample = function() {
    _origSample();
    // Inject touch axes: override if touch is moving (non-zero)
    const tx = inputCtrl._touchAxisX || 0;
    const ty = inputCtrl._touchAxisY || 0;
    if (Math.abs(tx) > 0.02 || Math.abs(ty) > 0.02) {
      inputCtrl.axisX = tx;
      inputCtrl.axisY = ty;
    }
    // Touch button bits are already merged into mask by pointerdown/up above.
    // Re-apply them here so they survive the sample() reset cycle:
    for (const { flag } of btnPtrs.values()) {
      inputCtrl.mask |= flag;
    }
  };

  // ── Initial layout + resize ───────────────────────────────────────────────
  layout();
  window.addEventListener("resize", layout);

  return { overlay, destroy() {
    window.removeEventListener("resize", layout);
    overlay.remove();
  }};
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
function _circle(r, bg) {
  const el = document.createElement("div");
  el.style.cssText = `
    position: absolute;
    width:  ${r * 2}px;
    height: ${r * 2}px;
    border-radius: 50%;
    background: ${bg};
    border: 2px solid rgba(255,255,255,0.22);
    box-sizing: border-box;
    pointer-events: auto;
    touch-action: none;
  `;
  return el;
}

function _btn(label, bg, r) {
  const el = document.createElement("div");
  el.style.cssText = `
    position: absolute;
    width:  ${r * 2}px;
    height: ${r * 2}px;
    border-radius: 50%;
    background: ${bg};
    border: 2px solid rgba(255,255,255,0.35);
    box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    color: rgba(255,255,255,0.9);
    font-family: monospace;
    font-size: ${r < 30 ? 14 : 20}px;
    font-weight: bold;
    pointer-events: auto;
    touch-action: none;
    transition: background 0.05s;
  `;
  el.textContent = label;
  return el;
}

function _place(el, x, y, w, h) {
  el.style.left   = x + "px";
  el.style.top    = y + "px";
  el.style.width  = w + "px";
  el.style.height = h + "px";
}

function _placeKnob(knob, cx, cy) {
  const r = parseInt(knob.style.width) / 2 || JOY_KNOB;
  knob.style.left = (cx - r) + "px";
  knob.style.top  = (cy - r) + "px";
}
