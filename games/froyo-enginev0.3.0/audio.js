/**
 * audio.js — Synth sound effects via Web Audio API (no CDN, no files)
 *
 * All sounds are procedurally generated oscillator bursts.
 * AudioContext is lazily created on first play (respects autoplay policy).
 */

let _ctx = null;

function getCtx() {
  if (!_ctx) {
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn("[audio] Web Audio API not available:", e);
      return null;
    }
  }
  // Resume context if suspended (required after user gesture on some browsers)
  if (_ctx.state === "suspended") _ctx.resume();
  return _ctx;
}

// ─── FX volume master ─────────────────────────────────────────────────────────
let _fxVolume = 0.8;  // default FX gain (0-1)

/** Get current FX volume. */
export function sfxGetVolume() { return _fxVolume; }

/** Set FX volume (0–1). All subsequent sounds use this level. */
export function sfxSetVolume(v) { _fxVolume = Math.max(0, Math.min(1, v)); }

/**
 * Low-level helper: schedule a single oscillator burst.
 * @param {string} type  — oscillator type: sine|square|sawtooth|triangle
 * @param {number} freq0 — start frequency Hz
 * @param {number} freq1 — end frequency Hz (linear ramp over duration)
 * @param {number} gain  — peak volume 0..1  (scaled by _fxVolume)
 * @param {number} duration — seconds
 * @param {number} [delay=0] — seconds from now
 */
function tone(type, freq0, freq1, gain, duration, delay = 0) {
  const ctx = getCtx();
  if (!ctx) return;
  gain = gain * _fxVolume;
  if (gain < 0.001) return;
  const now = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.connect(env);
  env.connect(ctx.destination);
  osc.type = type;
  osc.frequency.setValueAtTime(freq0, now);
  osc.frequency.linearRampToValueAtTime(freq1, now + duration);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.start(now);
  osc.stop(now + duration + 0.01);
}

/**
 * Noise burst (filtered white noise) for percussive events.
 */
function noise(filterFreq, gain, duration, delay = 0) {
  const ctx = getCtx();
  if (!ctx) return;
  gain = gain * _fxVolume;
  if (gain < 0.001) return;
  const now = ctx.currentTime + delay;
  const bufSize = ctx.sampleRate * duration;
  const buf = ctx.createBuffer(1, bufSize | 0, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = filterFreq;
  filter.Q.value = 0.8;
  const env = ctx.createGain();
  src.connect(filter);
  filter.connect(env);
  env.connect(ctx.destination);
  env.gain.setValueAtTime(gain, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + duration);
  src.start(now);
  src.stop(now + duration + 0.01);
}

// ─── Public sound effects ─────────────────────────────────────────────────────

/** Player jumps (first jump) */
export function sfxJump() {
  tone("square", 280, 520, 0.18, 0.12);
  tone("sine",   280, 520, 0.10, 0.15);
}

/** Player double-jumps */
export function sfxDoubleJump() {
  tone("square", 380, 700, 0.18, 0.10);
  tone("square", 500, 900, 0.12, 0.10, 0.06);
}

/** Ice breath fires */
export function sfxIceBreath() {
  noise(900, 0.15, 0.35);
  tone("sine", 600, 200, 0.08, 0.35);
  tone("sawtooth", 300, 100, 0.05, 0.35, 0.05);
}

/** Crystal shatters */
export function sfxCrystalBreak() {
  noise(2200, 0.2, 0.25);
  tone("sine",  1200, 400, 0.12, 0.3);
  tone("sine",  1800, 600, 0.08, 0.2, 0.05);
}

/** Crate breaks */
export function sfxCrateBreak() {
  noise(400, 0.25, 0.22);
  tone("sawtooth", 180, 60, 0.15, 0.22);
}

/** Enemy hit (frozen) */
export function sfxEnemyFrozen() {
  tone("sine", 1000, 400, 0.15, 0.28);
  tone("square", 800, 300, 0.08, 0.28, 0.05);
}

/** Enemy dies */
export function sfxEnemyDie() {
  tone("sawtooth", 400, 80, 0.2, 0.4);
  noise(600, 0.1, 0.3, 0.05);
}

/** Player gets hit */
export function sfxPlayerHit() {
  tone("sawtooth", 300, 100, 0.2, 0.3);
  noise(500, 0.15, 0.2, 0.05);
}

/** Enemy fires projectile */
export function sfxEnemyShoot() {
  tone("sawtooth", 600, 200, 0.12, 0.18);
  tone("sine",     400, 150, 0.06, 0.18, 0.04);
}

/** Wind zone ambience (short whoosh) */
export function sfxWind() {
  noise(300, 0.10, 0.6);
  tone("sine", 200, 80, 0.05, 0.6);
}

/** Portal open fanfare */
export function sfxPortalOpen() {
  tone("sine",   440, 880, 0.15, 0.2);
  tone("sine",   550, 1100, 0.12, 0.2, 0.15);
  tone("triangle", 660, 1320, 0.1, 0.25, 0.3);
}

/** Collect sprinkle (crystal reward) */
export function sfxCollect() {
  tone("sine", 800, 1400, 0.13, 0.15);
  tone("sine", 1000, 1800, 0.08, 0.15, 0.07);
}

/** Land after fall */
export function sfxLand(speed) {
  // Harder landing = louder, lower thud
  const intensity = Math.min(1, speed * 5);
  noise(250, 0.15 * intensity, 0.18);
  tone("sine", 120, 60, 0.1 * intensity, 0.18);
}

// ─── Background Music ─────────────────────────────────────────────────────────
// Streams the uploaded "Fire Village - Nekroturge" MP3 via an <audio> element
// routed through Web Audio API so volume can be adjusted alongside SFX.
// Falls back to direct <audio> playback if AudioContext is unavailable.
// Use a relative path so the asset can live inside the repository's `music/` folder.

const BGM_URL = "music/background.mp3";

let _bgmAudio = null;       // HTMLAudioElement
let _bgmSource = null;      // MediaElementAudioSourceNode
let _bgmGain  = null;       // GainNode
let _bgmVolume = 0.55;
let _bgmStarted = false;

function _ensureBgmAudio() {
  if (_bgmAudio) return;
  _bgmAudio = new Audio();
  _bgmAudio.src = BGM_URL;
  _bgmAudio.loop = true;
  _bgmAudio.preload = "auto";
  _bgmAudio.crossOrigin = "anonymous";
  _bgmAudio.volume = 1.0; // volume controlled by GainNode when routed

  // Wire into AudioContext if one is available
  const ctx = getCtx();
  if (ctx && !_bgmSource) {
    try {
      _bgmSource = ctx.createMediaElementSource(_bgmAudio);
      _bgmGain   = ctx.createGain();
      _bgmGain.gain.value = _bgmVolume;
      _bgmSource.connect(_bgmGain);
      _bgmGain.connect(ctx.destination);
    } catch (e) {
      // Already attached to a different context, or browser limitation — fall back
      _bgmSource = null;
      _bgmGain   = null;
      _bgmAudio.volume = _bgmVolume;
      console.warn("[audio] BGM AudioContext routing failed, using direct volume:", e);
    }
  } else if (!ctx) {
    // No AudioContext — control volume directly on the element
    _bgmAudio.volume = _bgmVolume;
  }
}

/** Start background music. Safe to call multiple times (no-op if already playing). */
export function bgmStart() {
  if (_bgmStarted) return;
  _bgmStarted = true;
  _ensureBgmAudio();
  _bgmAudio.play().catch(err => {
    // Autoplay policy: retry on next user interaction
    console.warn("[audio] BGM play blocked:", err);
    _bgmStarted = false;
  });
}

/** Stop background music. */
export function bgmStop() {
  if (!_bgmAudio) return;
  _bgmAudio.pause();
  _bgmAudio.currentTime = 0;
  _bgmStarted = false;
}

/** Get current BGM volume (0–1). */
export function bgmGetVolume() { return _bgmVolume; }

/** Adjust BGM volume (0–1). Takes effect immediately. */
export function bgmSetVolume(v) {
  _bgmVolume = Math.max(0, Math.min(1, v));
  if (_bgmGain) {
    _bgmGain.gain.value = _bgmVolume;
  } else if (_bgmAudio) {
    _bgmAudio.volume = _bgmVolume;
  }
}
