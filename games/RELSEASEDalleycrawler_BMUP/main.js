import { Game } from './game.js';
import { audio } from './audio.js';
import { initCues } from './audioCues.js';

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('game-root');
  const canvas = document.getElementById('gameCanvas');

  // Responsive sizing
  function resize() {
    const W = root.clientWidth || window.innerWidth;
    const H = window.innerHeight;
    const scaleW = W / 320;
    const scaleH = (H - 20) / 224;
    const scale = Math.min(scaleW, scaleH, 3);

    canvas.style.width  = Math.floor(320 * scale) + 'px';
    canvas.style.height = Math.floor(224 * scale) + 'px';
    root.style.width    = canvas.style.width;
  }

  resize();
  window.addEventListener('resize', resize);

  const game = new Game(canvas);

  // Allow systems to access the mixer through Game
  game.audio = audio;

  // Wire the cue layer — must happen after audio is assigned so the Proxy
  // resolves to a live AudioCues instance before any entity code runs.
  initCues(audio);

  // ── PCM Sound Registration ──────────────────────────────────────────────

  audio.loadVariation('menuMove', [
    './sfx/menu_move1.wav',
    './sfx/menu_move2.wav'
  ]);

  audio.load('menuConfirm', './sfx/menu_confirm.wav');

  audio.loadVariation('punch', [
    './sfx/punch1.wav',
    './sfx/punch2.wav',
    './sfx/punch3.wav'
  ]);

  audio.loadVariation('kick', [
    './sfx/kick1.wav',
    './sfx/kick2.wav'
  ]);

  audio.loadVariation('hit', [
    './sfx/hit1.wav',
    './sfx/hit2.wav',
    './sfx/hit3.wav'
  ]);

  audio.load('crit', './sfx/crit.wav');

  audio.load('jump', './sfx/jump.wav');
  audio.load('land', './sfx/land.wav');
  audio.load('enemyDown', './sfx/enemy_down.wav');

  // ── Music Registration ─────────────────────────────────────────────────
  // Tracks are NOT preloaded here — call audio.playMusic(id, url) from the
  // phase that needs them (game.js for in-game BGM, menu.js for title music).
  // Example:
  //   audio.playMusic('bgm_street', './music/street.ogg');
  //   audio.playMusic('bgm_boss',   './music/boss.ogg', 0.9);
  //   audio.stopMusic();

  // ── Browser Audio Unlock ───────────────────────────────────────────────

  const unlockAudio = () => {
    audio.unlock();

    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
    window.removeEventListener('gamepadconnected', unlockAudio);
  };

  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  window.addEventListener('gamepadconnected', unlockAudio);

  // ── Main Loop ──────────────────────────────────────────────────────────

  let lastTime = -1;
  let accumulator = 0;

  const TARGET_FPS = 60;
  const FRAME_MS = 1000 / TARGET_FPS;
  const MAX_CATCHUP_MS = FRAME_MS * 4;

  function loop(timestamp) {
    if (lastTime < 0) lastTime = timestamp;

    const dt = Math.min(
      timestamp - lastTime,
      MAX_CATCHUP_MS
    );

    lastTime = timestamp;
    accumulator += dt;

    while (accumulator >= FRAME_MS) {
      game.update();
      accumulator -= FRAME_MS;
    }

    const alpha = accumulator / FRAME_MS;

    game.render(alpha);

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
});
