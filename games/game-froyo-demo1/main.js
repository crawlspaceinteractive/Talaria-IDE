/**
 * main.js — Entry point for Froyo Engine.
 *
 * Mounts a fullscreen game canvas and boots FroyoGame.
 * The CRT shader overlay (Three.js) is layered on top via crt.js.
 * No UI chrome — pure game canvas + CRT effect.
 */
import { FroyoGame } from "./game.js";
//import { createCRT, tickCRT } from "./crt.js";
import { createTouchOverlay } from "./touch.js";

document.addEventListener("DOMContentLoaded", async () => {
  const root = document.getElementById("game-root");
  if (!root) return;

  // ---- Fullscreen canvas shell (no bezel, no help card) -------------------
  root.innerHTML = `
    <div id="froyo-shell" style="
      position: fixed; inset: 0;
      background: #000;
      display: flex; align-items: center; justify-content: center;
    ">
      <canvas id="froyo-canvas" width="320" height="200" style="
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
        display: block;
      "></canvas>
      <input id="froyo-load-map" type="file" accept="application/json" style="display:none" />
      <input id="froyo-load-save" type="file" accept=".froyo,application/json" style="display:none" />
    </div>
  `;

  const shell  = document.getElementById("froyo-shell");
  const canvas = document.getElementById("froyo-canvas");

  // ---- Boot game -----------------------------------------------------------
  const game = new FroyoGame(canvas);

  // ---- Touch controls overlay (mobile only, no-op on desktop) ─────────────
  createTouchOverlay(shell, game.input);

  // ---- CRT overlay — async; initialises Three.js in background -----------
  // Pass the game canvas so the shader can sample it as a texture.
//  let crt = null;
//  createCRT(shell, canvas).then(handle => {
//   crt = handle;
// }).catch(err => {
//    // CRT failed (e.g. no WebGL2) — game still runs fine without it
//    console.warn("CRT overlay unavailable:", err);
//  });

  // ---- Patch the game loop to also tick the CRT each frame ----------------
  // We intercept by wrapping requestAnimationFrame so the CRT fires after
  // every game present() without modifying game.js.
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function(cb) {
    return _raf(function(ts) {
      cb(ts);
      if (crt) tickCRT(crt, ts);
    });
  };

  game.start();

  const loadMapInput = document.getElementById("froyo-load-map");
  const loadSaveInput = document.getElementById("froyo-load-save");
  game.onRequestLoadMap = () => loadMapInput.click();
  game.onRequestSceneEditor = () => {
    window.location.href = "scene-editor.html";
  };
  game.onRequestLoadFroyo = () => loadSaveInput.click();

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
