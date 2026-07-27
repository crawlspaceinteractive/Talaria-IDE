/**
 * devpanel.js — Dev-panel chrome that wraps the real FroyoGame canvas.
 *
 * This module does NOT touch game.js, physics.js, camera.js, or any
 * gameplay/render code. It only:
 *   1. Builds the panel DOM (left/right/bottom chrome) around the existing
 *      #froyo-canvas, leaving the canvas element itself untouched so
 *      game.renderer keeps writing to the exact same element.
 *   2. Polls the live `game` instance (the same FroyoGame created in
 *      main.js) once per animation frame and mirrors its real state into
 *      the panel — camera.yaw/pitch/fovMul, player.state/jumpTokens,
 *      hud.sprinkles/lives, gameState, frame count, measured frame time.
 *   3. Exposes a couple of read-only conveniences (FPS, frame ms) computed
 *      by timing the real tick() via requestAnimationFrame deltas — these
 *      numbers are NOT fabricated gameplay data, just wall-clock timing of
 *      whatever main.js's loop is already doing.
 *
 * NOTE on triangle/profiler stats: engine/profiler.js exists in the repo
 * but is never imported by game.js or renderer.js, so there is no live
 * triangle-count signal to read. Rather than invent fake numbers, this
 * panel omits a triangle counter entirely. If you wire profiler.resetFrame()
 * / endFrame() calls into game.js's render path later, this panel's
 * updateLoop() is the right place to read profiler.trisIn/trisDrawn/etc.
 *
 * USAGE (see main.js):
 *   import { mountDevPanel, attachDevPanel } from "./devpanel.js";
 *   const { canvas, shell, viewport } = mountDevPanel(root);
 *   const game = new FroyoGame(canvas);
 *   attachDevPanel(game);
 */
import { STATE } from "./engine/state.js";
import { MOVE, JUMPM } from "./engine/luts.js";
import { sfxGetVolume, sfxSetVolume, bgmGetVolume, bgmSetVolume } from "./engine/audio.js";
// Same module instance game.js already imports (ES modules are singletons
// per resolved URL), so reading progress here doesn't create a second atlas
// or trigger a second load — it just observes the one game.js kicked off.
import { getAtlasProgress, isAtlasReady } from "./game/islandatlas.js";

const MOVE_NAMES = ["IDLE", "WALK", "CHARGE", "AIRBORNE", "GLIDE"];
const JUMPM_NAMES = ["GROUNDED", "JUMPING", "DOUBLE_JUMP", "FALLING"];

const STYLE = `
  :root {
    --dp-bg:      #0a0a12;
    --dp-panel:   #11111e;
    --dp-border:  #2a2a44;
    --dp-accent:  #7b68ee;
    --dp-green:   #4ade80;
    --dp-amber:   #fbbf24;
    --dp-red:     #f87171;
    --dp-text:    #c8c8e8;
    --dp-dim:     #5a5a7a;
    --dp-mono:    'Courier New', monospace;
  }
  #froyo-devshell {
    display: grid;
    grid-template-columns: 200px 1fr 200px;
    grid-template-rows: 32px 1fr 88px;
    width: 100%; height: 100%;
    gap: 1px;
    background: var(--dp-border);
    font-family: var(--dp-mono);
    font-size: 12px;
    color: var(--dp-text);
  }
  #dp-header {
    grid-column: 1 / -1;
    background: var(--dp-panel);
    display: flex; align-items: center; gap: 12px; padding: 0 12px;
    border-bottom: 1px solid var(--dp-border);
  }
  #dp-header .dp-logo { font-weight: bold; color: var(--dp-accent); letter-spacing: 2px; font-size: 12px; text-transform: uppercase; }
  #dp-header .dp-sep { flex: 1; }
  .dp-badge { font-size: 9px; padding: 2px 6px; border-radius: 3px; border: 1px solid; letter-spacing: 1px; }
  .dp-badge-ok    { color: var(--dp-green); border-color: var(--dp-green); }
  .dp-badge-amber { color: var(--dp-amber); border-color: var(--dp-amber); }
  .dp-badge-dim   { color: var(--dp-dim);   border-color: var(--dp-dim); }
  #dp-left, #dp-right { background: var(--dp-panel); padding: 8px 0; overflow-y: auto; }
  #dp-viewport {
    background: #000; position: relative;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  #dp-viewport canvas { image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
  #dp-bottom {
    grid-column: 1 / -1; background: var(--dp-panel);
    border-top: 1px solid var(--dp-border);
    display: flex; gap: 1px; overflow: hidden;
  }
  .dp-col { flex: 1; padding: 6px 10px; border-right: 1px solid var(--dp-border); min-width: 0; }
  .dp-col:last-child { border-right: none; }
  .dp-section-head {
    padding: 4px 10px 3px; font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--dp-dim); border-bottom: 1px solid var(--dp-border); margin-bottom: 3px;
  }
  .dp-stat { padding: 2px 10px; font-size: 10px; color: var(--dp-dim); display: flex; justify-content: space-between; }
  .dp-stat span { color: var(--dp-text); }
  .dp-stat.dp-flag-on span { color: var(--dp-green); }
  .dp-ctrl-row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; }
  .dp-ctrl-label { font-size: 9px; color: var(--dp-dim); width: 56px; flex-shrink: 0; }
  .dp-ctrl-row input[type=range] { flex: 1; -webkit-appearance: none; height: 3px; background: var(--dp-border); border-radius: 2px; outline: none; }
  .dp-ctrl-row input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 9px; height: 9px; border-radius: 50%; background: var(--dp-accent); cursor: pointer; }
  .dp-ctrl-val { font-size: 9px; color: var(--dp-accent); width: 26px; text-align: right; }
  .dp-input-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; padding: 4px 10px; }
  .dp-input-key { border: 1px solid var(--dp-border); border-radius: 3px; text-align: center; font-size: 8px; padding: 3px 1px; color: var(--dp-dim); }
  .dp-input-key.active { background: rgba(123,104,238,0.25); border-color: var(--dp-accent); color: var(--dp-accent); }
  #dp-viewport::-webkit-scrollbar, #dp-left::-webkit-scrollbar, #dp-right::-webkit-scrollbar { width: 4px; }
  #dp-left::-webkit-scrollbar-thumb, #dp-right::-webkit-scrollbar-thumb { background: var(--dp-border); border-radius: 2px; }
`;

/**
 * mountDevPanel(root)
 *
 * Builds the dev-panel DOM inside `root` (the #game-root element).
 * Returns { canvas, shell, viewport } — `canvas` is the same #froyo-canvas
 * element main.js already expects to hand to `new FroyoGame(canvas)`.
 * Nothing about the canvas's id, size attributes, or pixel content is
 * altered. `viewport` is the canvas's direct parent — pass this (not
 * `shell`) to anything that wants to overlay just the game view, like
 * createTouchOverlay or createCRT.
 */
export function mountDevPanel(root) {
  if (!document.getElementById("froyo-devpanel-style")) {
    const styleEl = document.createElement("style");
    styleEl.id = "froyo-devpanel-style";
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);
  }

  root.innerHTML = `
    <div id="froyo-devshell">
      <div id="dp-header">
        <div class="dp-logo">Froyo Engine</div>
        <div class="dp-badge dp-badge-ok" id="dp-badge-state">LOADING</div>
        <div class="dp-badge dp-badge-dim" id="dp-badge-pad">NO PAD</div>
        <div class="dp-sep"></div>
        <div class="dp-badge dp-badge-ok" id="dp-badge-fps">-- FPS</div>
      </div>

      <div id="dp-left">
        <div class="dp-section-head">camera</div>
        <div class="dp-stat">yaw<span id="dp-cam-yaw">0°</span></div>
        <div class="dp-stat">pitch<span id="dp-cam-pitch">0°</span></div>
        <div class="dp-stat">fovMul<span id="dp-cam-fov">1.00</span></div>
        <div class="dp-stat">pos x<span id="dp-cam-x">0.00</span></div>
        <div class="dp-stat">pos y<span id="dp-cam-y">0.00</span></div>
        <div class="dp-stat">pos z<span id="dp-cam-z">0.00</span></div>

        <div class="dp-section-head" style="margin-top:6px">player</div>
        <div class="dp-stat">move<span id="dp-move-mode">IDLE</span></div>
        <div class="dp-stat">jump<span id="dp-jump-mode">GROUNDED</span></div>
        <div class="dp-stat">tokens<span id="dp-tokens">2</span></div>
        <div class="dp-stat">grounded<span id="dp-grounded">YES</span></div>
        <div class="dp-stat">state<span id="dp-state-bits">0x00</span></div>

        <div class="dp-section-head" style="margin-top:6px">world</div>
        <div class="dp-stat">platforms<span id="dp-world-platforms">0</span></div>
        <div class="dp-stat">enemies left<span id="dp-world-enemies">0</span></div>
        <div class="dp-stat">portal<span id="dp-world-portal">closed</span></div>
      </div>

      <div id="dp-viewport"></div>

      <div id="dp-right">
        <div class="dp-section-head">audio</div>
        <div class="dp-ctrl-row">
          <div class="dp-ctrl-label">sfx vol</div>
          <input type="range" id="dp-sl-sfx" min="0" max="100" value="80" step="1">
          <div class="dp-ctrl-val" id="dp-sl-sfx-v">80</div>
        </div>
        <div class="dp-ctrl-row">
          <div class="dp-ctrl-label">bgm vol</div>
          <input type="range" id="dp-sl-bgm" min="0" max="100" value="55" step="1">
          <div class="dp-ctrl-val" id="dp-sl-bgm-v">55</div>
        </div>

        <div class="dp-section-head" style="margin-top:6px">hud</div>
        <div class="dp-stat">sprinkles<span id="dp-hud-sprinkles">0</span></div>
        <div class="dp-stat">lives<span id="dp-hud-lives">0</span></div>
        <div class="dp-stat">debug overlay<span id="dp-debug-state">off</span></div>

        <div class="dp-section-head" style="margin-top:6px">input</div>
        <div class="dp-input-grid" id="dp-key-grid"></div>
        <div class="dp-stat" style="margin-top:4px">hold TAB<span>engine debug</span></div>
      </div>

      <div id="dp-bottom">
        <div class="dp-col">
          <div class="dp-section-head">frame time</div>
          <div class="dp-stat">ms<span id="dp-p-ms">0.0</span></div>
          <div class="dp-stat">fps<span id="dp-p-fps">0</span></div>
          <div class="dp-stat">frame<span id="dp-p-frame">0</span></div>
        </div>
        <div class="dp-col">
          <div class="dp-section-head">state flags</div>
          <div class="dp-stat" id="dp-sf-walk">WALK<span>—</span></div>
          <div class="dp-stat" id="dp-sf-charge">CHARGE<span>—</span></div>
          <div class="dp-stat" id="dp-sf-jump">JUMP<span>—</span></div>
          <div class="dp-stat" id="dp-sf-glide">GLIDE<span>—</span></div>
          <div class="dp-stat" id="dp-sf-hit">HIT<span>—</span></div>
        </div>
        <div class="dp-col">
          <div class="dp-section-head">velocity</div>
          <div class="dp-stat">vx<span id="dp-vx">0.000</span></div>
          <div class="dp-stat">vy<span id="dp-vy">0.000</span></div>
          <div class="dp-stat">vz<span id="dp-vz">0.000</span></div>
        </div>
        <div class="dp-col" style="border-right:none">
          <div class="dp-section-head">atlas / cache</div>
          <div class="dp-stat">island atlas<span id="dp-atlas">0%</span></div>
          <div class="dp-stat">geom precache<span id="dp-geomcache">0%</span></div>
          <div class="dp-stat">game state<span id="dp-gamestate">LOADING</span></div>
        </div>
      </div>
    </div>
  `;

  const viewport = document.getElementById("dp-viewport");
  const canvas = document.createElement("canvas");
  canvas.id = "froyo-canvas";
  canvas.width = 320;
  canvas.height = 200;
  canvas.style.cssText = `
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    display: block;
  `;
  viewport.appendChild(canvas);

  function scaleCanvas() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    const s = Math.min(w / 320, h / 200);
    canvas.style.width = (320 * s) + "px";
    canvas.style.height = (200 * s) + "px";
  }
  window.addEventListener("resize", scaleCanvas);
  scaleCanvas();

  // Audio sliders — these call the real audio.js setters directly,
  // and are seeded from the real current volume on mount.
  const sfxSlider = document.getElementById("dp-sl-sfx");
  const sfxVal = document.getElementById("dp-sl-sfx-v");
  sfxSlider.value = Math.round(sfxGetVolume() * 100);
  sfxVal.textContent = sfxSlider.value;
  sfxSlider.addEventListener("input", () => {
    sfxVal.textContent = sfxSlider.value;
    sfxSetVolume(+sfxSlider.value / 100);
  });

  const bgmSlider = document.getElementById("dp-sl-bgm");
  const bgmVal = document.getElementById("dp-sl-bgm-v");
  bgmSlider.value = Math.round(bgmGetVolume() * 100);
  bgmVal.textContent = bgmSlider.value;
  bgmSlider.addEventListener("input", () => {
    bgmVal.textContent = bgmSlider.value;
    bgmSetVolume(+bgmSlider.value / 100);
  });

  return { canvas, shell: document.getElementById("froyo-devshell"), viewport };
}

// ─── Key grid (mirrors the same keys input.js actually maps) ────────────────
const KEY_LABELS = [
  ["W", "KeyW"], ["A", "KeyA"], ["S", "KeyS"], ["D", "KeyD"],
  ["SPC", "Space"], ["J", "KeyJ"], ["K", "KeyK"], ["L", "KeyL"],
  ["SHF", "ShiftLeft"], ["CTRL", "ControlLeft"], ["Q", "KeyQ"], ["E", "KeyE"],
  ["ENT", "Enter"], ["TAB", "Tab"], ["LB", "KeyU"], ["RB", "KeyI"],
];
let _heldKeys = new Set();
let _keyGridBuilt = false;

function _trackKeysOnce() {
  if (_keyGridBuilt) return;
  window.addEventListener("keydown", e => _heldKeys.add(e.code));
  window.addEventListener("keyup", e => _heldKeys.delete(e.code));
  window.addEventListener("blur", () => _heldKeys.clear());
}

function _updateKeyGrid() {
  _trackKeysOnce();
  const grid = document.getElementById("dp-key-grid");
  if (!grid) return;
  if (!_keyGridBuilt) {
    grid.innerHTML = "";
    for (const [label, code] of KEY_LABELS) {
      const el = document.createElement("div");
      el.className = "dp-input-key";
      el.id = "dp-key-" + code;
      el.textContent = label;
      grid.appendChild(el);
    }
    _keyGridBuilt = true;
  }
  for (const [, code] of KEY_LABELS) {
    const el = document.getElementById("dp-key-" + code);
    if (el) el.classList.toggle("active", _heldKeys.has(code));
  }
}

/**
 * attachDevPanel(game)
 *
 * Starts a polling loop (its own rAF, independent of game.tick) that reads
 * live fields off the real `game` instance and writes them into the panel
 * DOM. Does not call into game.js logic, does not mutate game state (other
 * than the audio volume setters wired to the sliders above, which call the
 * same exported functions game.js itself uses for its settings menu).
 */
export function attachDevPanel(game) {
  let lastTs = performance.now();
  let emaMs = 16.6;

  function frame(ts) {
    requestAnimationFrame(frame);
    const dtMs = ts - lastTs;
    lastTs = ts;
    // Only fold in plausible deltas (skip the first frame / tab-away spikes)
    if (dtMs > 0 && dtMs < 250) emaMs += (dtMs - emaMs) * 0.08;

    const fps = Math.min(999, Math.round(1000 / Math.max(emaMs, 0.001)));

    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    setText("dp-badge-fps", fps + " FPS");
    setText("dp-p-ms", emaMs.toFixed(1));
    setText("dp-p-fps", fps);
    setText("dp-p-frame", game.frame ?? 0);

    setText("dp-badge-state", game.gameState ?? "—");
    setText("dp-gamestate", game.gameState ?? "—");

    const padBadge = document.getElementById("dp-badge-pad");
    if (padBadge && game.input) {
      const connected = game.input.isGamepadConnected();
      padBadge.textContent = connected ? "PAD OK" : "NO PAD";
      padBadge.className = "dp-badge " + (connected ? "dp-badge-ok" : "dp-badge-dim");
    }

    if (game.camera) {
      setText("dp-cam-yaw", game.camera.yaw.toFixed(1) + "°");
      setText("dp-cam-pitch", game.camera.pitch.toFixed(1) + "°");
      setText("dp-cam-fov", game.camera.fovMul.toFixed(2));
      setText("dp-cam-x", game.camera.x.toFixed(2));
      setText("dp-cam-y", game.camera.y.toFixed(2));
      setText("dp-cam-z", game.camera.z.toFixed(2));
    }

    if (game.player) {
      const p = game.player;
      // movementMode/jumpMode aren't stored on the player object itself in
      // game.js (they're locals inside _tickGameplay), so we re-derive the
      // same discrete values from the real bitwise state + grounded flag —
      // same inputs game.js itself uses, no shadow physics involved.
      let moveIdx = MOVE.IDLE, jumpIdx = JUMPM.GROUNDED;
      if (p.state & STATE.DEAD) moveIdx = MOVE.IDLE;
      else if (p.state & STATE.GLIDE) moveIdx = MOVE.GLIDE;
      else if (p.state & STATE.CHARGE) moveIdx = MOVE.CHARGE;
      else if (p.state & (STATE.JUMP | STATE.DOUBLE_JUMP)) moveIdx = MOVE.AIRBORNE;
      else if (p.state & STATE.WALK) moveIdx = MOVE.WALK;
      if (!p.grounded) {
        if (p.state & STATE.DOUBLE_JUMP) jumpIdx = JUMPM.DOUBLE_JUMP;
        else if (p.state & STATE.JUMP) jumpIdx = JUMPM.JUMPING;
        else jumpIdx = JUMPM.FALLING;
      }
      setText("dp-move-mode", MOVE_NAMES[moveIdx]);
      setText("dp-jump-mode", JUMPM_NAMES[jumpIdx]);
      setText("dp-tokens", p.jumpTokens);
      const grEl = document.getElementById("dp-grounded");
      if (grEl) { grEl.textContent = p.grounded ? "YES" : "NO"; grEl.style.color = p.grounded ? "var(--dp-green)" : "var(--dp-amber)"; }
      setText("dp-state-bits", "0x" + p.state.toString(16).padStart(2, "0").toUpperCase());
      setText("dp-vx", p.vx.toFixed(3));
      setText("dp-vy", p.vy.toFixed(3));
      setText("dp-vz", p.vz.toFixed(3));

      const setFlag = (id, bit) => {
        const el = document.getElementById(id);
        if (!el) return;
        const on = !!(p.state & bit);
        const span = el.querySelector("span");
        if (span) span.textContent = on ? "ON" : "—";
        el.classList.toggle("dp-flag-on", on);
      };
      setFlag("dp-sf-walk", STATE.WALK);
      setFlag("dp-sf-charge", STATE.CHARGE);
      setFlag("dp-sf-jump", STATE.JUMP | STATE.DOUBLE_JUMP);
      setFlag("dp-sf-glide", STATE.GLIDE);
      setFlag("dp-sf-hit", STATE.HIT);
    }

    if (game.world) {
      setText("dp-world-platforms", Array.isArray(game.world.platforms) ? game.world.platforms.length : 0);
      const aliveEnemies = Array.isArray(game.world.enemies) ? game.world.enemies.filter(e => !e.dead).length : 0;
      setText("dp-world-enemies", aliveEnemies);
      setText("dp-world-portal", aliveEnemies === 0 ? "open" : "closed");
    }

    if (game.hud) {
      setText("dp-hud-sprinkles", game.hud.sprinkles ?? 0);
      setText("dp-hud-lives", game.hud.lives ?? 0);
    }

    const debugEl = document.getElementById("dp-debug-state");
    if (debugEl) {
      debugEl.textContent = game.debugOpen ? "on (TAB held)" : "off";
      debugEl.style.color = game.debugOpen ? "var(--dp-green)" : "var(--dp-dim)";
    }

    // Loading / precache progress — only meaningful while these are in flight,
    // but harmless to keep reading afterward (will just read 100%).
    setText("dp-atlas", Math.round(getAtlasProgress() * 100) + "%" + (isAtlasReady() ? " (ready)" : ""));
    if (typeof game._geomCacheProgress === "number") {
      setText("dp-geomcache", Math.round(game._geomCacheProgress * 100) + "%");
    }

    _updateKeyGrid();
  }

  requestAnimationFrame(frame);
}
