import { GamepadManager, BTN, AXIS } from './gamepad.js';

// Deepsmoke — keyboard + pointer-lock mouse + touch (joystick / look drag / buttons) + gamepad.
export function createInput(root, canvas) {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const st = {
    move: { x: 0, z: 0 },      // strafe / forward (-1..1)
    lookDX: 0, lookDY: 0,
    drill: false,
    jumpHeld: false,
    edges: { jump: false, throw: false, use: false, transfer: false, place: false, inv: false, slot: -1, wheel: 0 },
    active: false,
    isTouch,
    padIndex: null,
    padMove: { x: 0, z: 0 },
    padDrill: false,
    padJumpHeld: false,
  };

  const keys = {};
  window.addEventListener('keydown', e => {
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyQ', 'KeyI', 'Tab'].includes(e.code)) e.preventDefault();
    if (keys[e.code]) return;
    keys[e.code] = true;
    if (e.code === 'Space') { st.jumpHeld = true; st.edges.jump = true; }
    if (e.code === 'KeyE') st.edges.use = true;
    if (e.code === 'KeyF') st.edges.transfer = true;
    if (e.code === 'KeyG') st.edges.throw = true;
    if (e.code === 'KeyQ') st.edges.place = true;
    if (e.code === 'KeyI' || e.code === 'Tab') st.edges.inv = true;
    if (e.code.startsWith('Digit')) {
      const d = +e.code.slice(5);
      if (d >= 1 && d <= 9) st.edges.slot = d - 1;
    }
  });
  window.addEventListener('wheel', e => {
    if (st.active) st.edges.wheel += Math.sign(e.deltaY);
  }, { passive: true });
  window.addEventListener('keyup', e => {
    keys[e.code] = false;
    if (e.code === 'Space') st.jumpHeld = false;
  });

  function updateKeyMove() {
    if (isTouch && touchMoveActive) return;
    st.move.x = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    st.move.z = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  }

  // ----- gamepad -----
  const gp = new GamepadManager({ deadzone: 0.16 });
  const PAD_LOOK_X = 0.06;
  const PAD_LOOK_Y = 0.045;

  function pickPrimaryPad(pads) {
    if (st.padIndex !== null && pads.some(p => p.index === st.padIndex)) return st.padIndex;
    return pads.length ? pads[0].index : null;
  }

  gp.on('connected', pad => {
    if (st.padIndex === null) st.padIndex = pad.index;
  });

  gp.on('disconnected', () => {
    let pads = [];
    try {
      pads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    } catch {}
    st.padIndex = pickPrimaryPad(pads);
    if (st.padIndex === null) {
      st.padMove.x = 0; st.padMove.z = 0;
      st.padDrill = false;
      st.padJumpHeld = false;
    }
  });

  gp.on('update', pads => {
    st.padIndex = pickPrimaryPad(pads);
    if (st.padIndex === null) {
      st.padMove.x = 0; st.padMove.z = 0;
      st.padDrill = false;
      st.padJumpHeld = false;
      return;
    }

    const moveStick = gp.getStick(st.padIndex, AXIS.LEFT_X, AXIS.LEFT_Y);
    st.padMove.x = moveStick.x;
    st.padMove.z = -moveStick.y;

    if (!st.active) {
      st.padDrill = false;
      st.padJumpHeld = false;
      return;
    }

    const lookStick = gp.getStick(st.padIndex, AXIS.RIGHT_X, AXIS.RIGHT_Y);
    st.lookDX += lookStick.x * PAD_LOOK_X;
    st.lookDY += lookStick.y * PAD_LOOK_Y;

    st.padDrill = gp.isPressed(st.padIndex, BTN.RT);
    st.padJumpHeld = gp.isPressed(st.padIndex, BTN.A);

    if (gp.justPressed(st.padIndex, BTN.A)) st.edges.jump = true;
    if (gp.justPressed(st.padIndex, BTN.B)) st.edges.use = true;
    if (gp.justPressed(st.padIndex, BTN.X)) st.edges.throw = true;
    if (gp.justPressed(st.padIndex, BTN.Y)) st.edges.transfer = true;
    if (gp.justPressed(st.padIndex, BTN.RB) || gp.justPressed(st.padIndex, BTN.LB)) st.edges.place = true;
    if (gp.justPressed(st.padIndex, BTN.SELECT) || gp.justPressed(st.padIndex, BTN.L3)) st.edges.inv = true;
    if (gp.justPressed(st.padIndex, BTN.LEFT)) st.edges.wheel -= 1;
    if (gp.justPressed(st.padIndex, BTN.RIGHT)) st.edges.wheel += 1;
  });

  gp.start();
  window.addEventListener('beforeunload', () => gp.destroy(), { once: true });

  // ----- mouse (desktop) -----
  let dragging = false, lastMX = 0, lastMY = 0;
  const locked = () => document.pointerLockElement === canvas;

  canvas.addEventListener('click', () => {
    if (st.active && !isTouch && !locked()) {
      try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch {} // cooldown after ESC-exit can reject; drag-look covers the gap
    }
  });
  document.addEventListener('pointerlockchange', () => { if (!locked()) st.drill = false; });
  window.addEventListener('mousemove', e => {
    if (!st.active) return;
    if (locked()) { st.lookDX += e.movementX * 0.0022; st.lookDY += e.movementY * 0.0022; }
    else if (dragging) {
      st.lookDX += (e.clientX - lastMX) * 0.0035; st.lookDY += (e.clientY - lastMY) * 0.0035;
      lastMX = e.clientX; lastMY = e.clientY;
    }
  });
  canvas.addEventListener('mousedown', e => {
    if (!st.active || isTouch) return;
    if (e.button === 0) { st.drill = true; dragging = true; lastMX = e.clientX; lastMY = e.clientY; }
    if (e.button === 2) st.edges.place = true;
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 0) { st.drill = false; dragging = false; }
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ----- touch -----
  let touchMoveActive = false;
  let joyId = null, joyOX = 0, joyOY = 0;
  let lookId = null, lookLX = 0, lookLY = 0;
  const btns = [];
  let talkBtn = null;

  if (isTouch) {
    const mkBtn = (label, css, onDown, onUp) => {
      const b = document.createElement('div');
      b.className = 'touch-btn';
      b.textContent = label;
      Object.assign(b.style, css);
      b.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); b.classList.add('active'); onDown && onDown(); }, { passive: false });
      b.addEventListener('touchend', e => { e.preventDefault(); b.classList.remove('active'); onUp && onUp(); });
      root.appendChild(b);
      btns.push(b);
      return b;
    };
    mkBtn('DRILL', { right: '18px', bottom: '96px', width: '84px', height: '84px', fontSize: '15px' },
      () => { st.drill = true; }, () => { st.drill = false; });
    mkBtn('JUMP', { right: '116px', bottom: '30px', width: '68px', height: '68px' },
      () => { st.jumpHeld = true; st.edges.jump = true; }, () => { st.jumpHeld = false; });
    mkBtn('THROW', { right: '18px', bottom: '196px', width: '60px', height: '60px', fontSize: '11px' },
      () => { st.edges.throw = true; });
    mkBtn('FUEL', { right: '92px', bottom: '176px', width: '60px', height: '60px', fontSize: '11px' },
      () => { st.edges.use = true; });
    mkBtn('GIVE', { right: '160px', bottom: '116px', width: '56px', height: '56px', fontSize: '11px' },
      () => { st.edges.transfer = true; });
    mkBtn('PLACE', { right: '18px', bottom: '264px', width: '56px', height: '56px', fontSize: '11px' },
      () => { st.edges.place = true; });
    mkBtn('PACK', { right: '14px', top: '14px', width: '52px', height: '52px', fontSize: '11px' },
      () => { st.edges.inv = true; });
    talkBtn = mkBtn('TALK', { left: '50%', bottom: '150px', marginLeft: '-46px', width: '92px', height: '48px', fontSize: '13px' },
      () => { st.edges.use = true; });
    talkBtn.dataset.contextual = '1';
    talkBtn.style.display = 'none';

    // joystick visual
    const joyBase = document.createElement('div');
    Object.assign(joyBase.style, {
      position: 'absolute', width: '110px', height: '110px', borderRadius: '9999px',
      border: '2px solid rgba(96,165,250,.6)', background: 'rgba(30,58,138,.3)',
      display: 'none', pointerEvents: 'none', transform: 'translate(-50%,-50%)',
    });
    const joyNub = document.createElement('div');
    Object.assign(joyNub.style, {
      position: 'absolute', width: '44px', height: '44px', borderRadius: '9999px',
      background: 'rgba(96,165,250,.8)', display: 'none', pointerEvents: 'none', transform: 'translate(-50%,-50%)',
    });
    root.appendChild(joyBase); root.appendChild(joyNub);
    btns.push(joyBase, joyNub);

    canvas.addEventListener('touchstart', e => {
      if (!st.active) return;
      for (const t of e.changedTouches) {
        if (t.clientX < window.innerWidth * 0.45 && joyId === null) {
          joyId = t.identifier; joyOX = t.clientX; joyOY = t.clientY;
          touchMoveActive = true;
          joyBase.style.display = joyNub.style.display = 'block';
          joyBase.style.left = joyNub.style.left = joyOX + 'px';
          joyBase.style.top = joyNub.style.top = joyOY + 'px';
        } else if (lookId === null) {
          lookId = t.identifier; lookLX = t.clientX; lookLY = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
      if (!st.active) return;
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          let dx = (t.clientX - joyOX) / 44, dy = (t.clientY - joyOY) / 44;
          const m = Math.hypot(dx, dy);
          if (m > 1) { dx /= m; dy /= m; }
          st.move.x = dx; st.move.z = -dy;
          joyNub.style.left = joyOX + dx * 44 + 'px';
          joyNub.style.top = joyOY + dy * 44 + 'px';
        } else if (t.identifier === lookId) {
          st.lookDX += (t.clientX - lookLX) * 0.006;
          st.lookDY += (t.clientY - lookLY) * 0.006;
          lookLX = t.clientX; lookLY = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });

    const endTouch = e => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyId) {
          joyId = null; touchMoveActive = false;
          st.move.x = 0; st.move.z = 0;
          joyBase.style.display = joyNub.style.display = 'none';
        }
        if (t.identifier === lookId) lookId = null;
      }
    };
    canvas.addEventListener('touchend', endTouch);
    canvas.addEventListener('touchcancel', endTouch);
  }

  return {
    get move() {
      updateKeyMove();
      if (st.active && !(isTouch && touchMoveActive)) {
        if (Math.abs(st.padMove.x) > 0.08 || Math.abs(st.padMove.z) > 0.08) {
          st.move.x = st.padMove.x;
          st.move.z = st.padMove.z;
        }
      }
      return st.move;
    },
    get drill() { return st.drill || (st.active && st.padDrill); },
    get jumpHeld() { return st.jumpHeld || (st.active && st.padJumpHeld); },
    get edges() { return st.edges; },
    get isTouch() { return isTouch; },
    get gamepad() { return gp; },
    get gamepadIndex() { return st.padIndex; },
    takeLook() {
      const d = { dx: st.lookDX, dy: st.lookDY };
      st.lookDX = 0; st.lookDY = 0;
      return d;
    },
    consumeEdges() {
      st.edges.jump = false; st.edges.throw = false; st.edges.use = false; st.edges.transfer = false;
      st.edges.place = false; st.edges.inv = false; st.edges.slot = -1; st.edges.wheel = 0;
    },
    setActive(a) {
      st.active = a;
      st.drill = false;
      if (!a) {
        st.padDrill = false;
        st.padJumpHeld = false;
      }
      for (const b of btns) if (b.classList.contains('touch-btn'))
        b.style.display = (a && !b.dataset.contextual) ? 'flex' : 'none';
      if (!a && document.pointerLockElement) document.exitPointerLock?.();
    },
    showTalk(v, label) {
      if (!talkBtn) return; // desktop no-op
      talkBtn.textContent = label || 'TALK';
      talkBtn.style.display = (v && st.active) ? 'flex' : 'none';
    },
  };
}
