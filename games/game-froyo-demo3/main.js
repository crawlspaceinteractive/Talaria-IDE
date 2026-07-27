/**
 * main.js — Entry point for Froyo Engine.
 *
 * Mounts the dev-panel chrome (camera/state/profiler readouts, audio
 * sliders, input grid) around the game canvas, then boots FroyoGame exactly
 * as before. The CRT shader overlay (Three.js) is layered on top via crt.js.
 *
 * Everything below the dev-panel chrome — FroyoGame itself, the touch
 * overlay, the CRT hook, file-based map/save loading — is unchanged from
 * the original bare-canvas main.js. The dev panel is purely observational:
 * it polls game.camera / game.player / game.world / game.hud each frame
 * and never calls into gameplay logic, except for the two audio sliders,
 * which call the same sfxSetVolume/bgmSetVolume exports game.js itself
 * uses for its in-game settings menu.
 */
import { FroyoGame } from "./game/game.js";
//import { createCRT, tickCRT } from "./crt.js";
import { createTouchOverlay } from "./engine/touch.js";
import { mountDevPanel, attachDevPanel } from "./devpanel.js";

document.addEventListener("DOMContentLoaded", async () => {
  const root = document.getElementById("game-root");
  if (!root) return;

  // ---- Dev-panel shell (camera/state/profiler chrome around the canvas) ---
  // mountDevPanel() builds the panel DOM and returns the same kind of
  // #froyo-canvas element the old bare shell created — same id, same
  // 320×200 size — so FroyoGame's constructor and renderer.js are handed
  // an identical canvas to what they got before.
  const { canvas, shell, viewport } = mountDevPanel(root);

  // File inputs for map/save loading — kept as plain hidden inputs appended
  // to the shell, same as the original bare-canvas version.
  const loadMapInput = document.createElement("input");
  loadMapInput.id = "froyo-load-map";
  loadMapInput.type = "file";
  loadMapInput.accept = "application/json";
  loadMapInput.style.display = "none";
  shell.appendChild(loadMapInput);

  const loadSaveInput = document.createElement("input");
  loadSaveInput.id = "froyo-load-save";
  loadSaveInput.type = "file";
  loadSaveInput.accept = ".froyo,application/json";
  loadSaveInput.style.display = "none";
  shell.appendChild(loadSaveInput);

  // ---- Boot game -----------------------------------------------------------
  const game = new FroyoGame(canvas);

  // ---- Dev panel live readouts — purely observational, see devpanel.js ----
  attachDevPanel(game);

  // ---- Touch controls overlay (mobile only, no-op on desktop) ─────────────
  // Anchored on the viewport (the canvas's direct parent), not the whole
  // dev-panel shell, so the virtual joystick/buttons sit over the game view
  // only — not stretched across the side panels too.
  createTouchOverlay(viewport, game.input);

  // ---- CRT overlay — async; initialises Three.js in background -----------
  // Pass the game canvas so the shader can sample it as a texture. Mounts
  // onto the viewport (not the full dev-panel shell) for the same reason
  // the touch overlay does above — createCRT absolutely-positions its
  // overlay canvas to fill whatever element it's given.
  let crt = null;
//  createCRT(viewport, canvas).then(handle => {
//   crt = handle;
// }).catch(err => {
//    // CRT failed (e.g. no WebGL2) — game still runs fine without it
//    console.warn("CRT overlay unavailable:", err);
//  });

  game.onRequestLoadMap = () => loadMapInput.click();
  game.onRequestSceneEditor = () => {
    window.location.href = "./tools/scene-editor.html";
  };
  game.onRequestLoadFroyo = () => loadSaveInput.click();

  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    return _raf(function(ts) {
      cb(ts);
      if (crt) tickCRT(crt, ts);
    });
  };

  game.start();

  loadMapInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const sceneData = JSON.parse(text);
      const success = game.loadWorldFromSceneData(sceneData);
      if (!success) throw new Error("Invalid scene data");
      alert("Map imported successfully. Start a new game to play it.");
    } catch (err) {
      console.error("Failed to import map:", err);
      alert("Unable to load map file. Please select a valid JSON scene export.");
    }
    loadMapInput.value = "";
  });

  loadSaveInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const saveData = JSON.parse(text);
      const success = game.loadFroyoSave(saveData);
      if (!success) throw new Error("Invalid save data");
      alert("Froyo save loaded successfully.");
    } catch (err) {
      console.error("Failed to load Froyo save:", err);
      alert("Unable to load save file. Please select a valid .froyo JSON save.");
    }
    loadSaveInput.value = "";
  });

  // Clean up on page unload
  window.addEventListener("beforeunload", () => game.stop());
});
