// audio.js
// AlleyCrawler Web Audio mixer
//
// Architecture
// ────────────
// All SFX are decoded into AudioBuffers at load time (fetch → decodeAudioData).
// Playback creates a fresh AudioBufferSourceNode per call — instantaneous start,
// no src-reassignment delay, no voice-pool eviction.
//
// Signal chain (SFX):
//   BufferSourceNode → GainNode (per-play volume)
//                    → this._sfxGain  (sfxVolume)
//                    → this._masterGain (masterVolume)
//                    → AudioContext.destination
//
// Signal chain (Music):
//   <audio> element  → MediaElementSourceNode
//                    → this._musicGain (musicVolume)
//                    → this._masterGain
//                    → AudioContext.destination
//
// The <audio> element is kept for music so it can loop seamlessly and be
// swapped without re-decoding a potentially large file into memory.

export class AudioManager {
  constructor() {
    this._ctx         = null;   // AudioContext — created on first unlock()
    this._masterGain  = null;
    this._sfxGain     = null;
    this._musicGain   = null;

    // Raw volume scalars — applied to gain nodes once context exists
    this.masterVolume = 1.0;
    this.sfxVolume    = 1.0;
    this.musicVolume  = 1.0;

    this.unlocked = false;

    // id → { type: 'single'|'variation', buffers: AudioBuffer[], index }
    this.sounds = new Map();

    // Promises for in-flight loads — lets unlock() await all pending decodes
    this._loadPromises = [];

    // Play calls that arrived before unlock() — { id, volume }
    this._pendingPlays = [];

    // ── Music channel ─────────────────────────────────────────────────────────
    this._musicEl          = new Audio();
    this._musicEl.loop     = true;
    this._musicEl.crossOrigin = 'anonymous'; // required for MediaElementSource
    this._musicSource      = null;   // MediaElementSourceNode (created once)
    this._musicTrackId     = null;
    this._pendingMusicVol  = 1.0;
  }

  // ── Context bootstrap ──────────────────────────────────────────────────────
  //
  // AudioContext must be created (or resumed) inside a user-gesture handler.
  // We call _ensureContext() from unlock() and also lazily from play() so
  // a context is always available when needed.
  //
  _ensureContext() {
    if (this._ctx) {
      // Context may be suspended if the page was backgrounded
      if (this._ctx.state === 'suspended') this._ctx.resume();
      return;
    }

    this._ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Build the shared gain graph
    this._masterGain = this._ctx.createGain();
    this._sfxGain    = this._ctx.createGain();
    this._musicGain  = this._ctx.createGain();

    this._sfxGain.connect(this._masterGain);
    this._musicGain.connect(this._masterGain);
    this._masterGain.connect(this._ctx.destination);

    this._masterGain.gain.value = this.masterVolume;
    this._sfxGain.gain.value    = this.sfxVolume;
    this._musicGain.gain.value  = this.musicVolume;

    // Wire the music element into the graph (done once, node is reused)
    this._musicSource = this._ctx.createMediaElementSource(this._musicEl);
    this._musicSource.connect(this._musicGain);
  }

  // ── Unlock ─────────────────────────────────────────────────────────────────
  //
  // Call from the first user-gesture handler in main.js.
  // Creates the AudioContext, waits for any in-flight decodes to settle,
  // then flushes the pending-play queue.
  //
  async unlock() {
    if (this.unlocked) return;
    this.unlocked = true;

    this._ensureContext();

    // Wait for all sounds that were registered before the first gesture.
    // Without this, a sound queued before unlock might play before its buffer
    // is decoded — _playNow would silently skip it.
    await Promise.allSettled(this._loadPromises);

    // Flush queued plays
    for (const { id, volume } of this._pendingPlays) {
      this._playNow(id, volume);
    }
    this._pendingPlays = [];

    // Resume music that was queued before unlock
    if (this._musicEl.src && this._musicEl.paused) {
      this._musicEl.play().catch(() => {});
    }
  }

  // ── Sound registration ─────────────────────────────────────────────────────
  //
  // Both load() and loadVariation() kick off a fetch+decode immediately.
  // The resulting Promise is pushed to _loadPromises so unlock() can await
  // the full set before flushing the play queue.
  //

  load(id, url) {
    const promise = this._fetchAndDecode(url).then(buffer => {
      this.sounds.set(id, { type: 'single', buffers: [buffer], index: 0 });
    }).catch(err => {
      console.warn(`audio: failed to load "${id}" from ${url}`, err);
    });
    this._loadPromises.push(promise);
  }

  loadVariation(id, urls) {
    const promise = Promise.all(urls.map(u => this._fetchAndDecode(u))).then(buffers => {
      this.sounds.set(id, { type: 'variation', buffers, index: 0 });
    }).catch(err => {
      console.warn(`audio: failed to load variation "${id}"`, err);
    });
    this._loadPromises.push(promise);
  }

  async _fetchAndDecode(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    // AudioContext may not exist yet — create a temporary one just for decode,
    // then discard it. decodeAudioData is a pure CPU operation; no gesture needed.
    const ctx = this._ctx || new (window.AudioContext || window.webkitAudioContext)();
    return ctx.decodeAudioData(arrayBuffer);
  }

  has(id) {
    return this.sounds.has(id);
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  play(id, volume = 1.0) {
    if (!this.has(id)) return;

    if (!this.unlocked) {
      // Queue — cap at 4 so a pre-gesture burst doesn't flood on unlock
      this._pendingPlays.push({ id, volume });
      if (this._pendingPlays.length > 4) this._pendingPlays.shift();
      return;
    }

    this._playNow(id, volume);
  }

  _playNow(id, volume) {
    const entry = this.sounds.get(id);
    if (!entry) return;

    // Ensure context is alive (could have been suspended by the browser)
    this._ensureContext();

    // Pick buffer (advance variation index)
    const buffer = entry.buffers[entry.index];
    entry.index = (entry.index + 1) % entry.buffers.length;

    if (!buffer) return;

    // AudioBufferSourceNode is single-use by design — create a new one per play.
    // This is the intended Web Audio API pattern; nodes are lightweight.
    const source = this._ctx.createBufferSource();
    source.buffer = buffer;

    // Per-play gain so individual cues can be louder/quieter independently of
    // the global sfx bus.
    const gainNode = this._ctx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, volume));

    source.connect(gainNode);
    gainNode.connect(this._sfxGain);

    source.start(0);

    // Let the GC collect source + gain once playback ends — no manual cleanup needed.
  }

  stopAll() {
    this._pendingPlays = [];
    // There's no "stop all" for fire-and-forget BufferSourceNodes.
    // The cleanest approach is to mute the SFX bus instantly, then restore.
    // Sounds that have already started will be cut off; new ones won't play
    // until sfxVolume is restored.
    if (this._sfxGain) {
      this._sfxGain.gain.setTargetAtTime(0, this._ctx.currentTime, 0.01);
    }
  }

  // ── Music channel ──────────────────────────────────────────────────────────

  /**
   * Load and play a looping music track.
   * Safe to call before unlock() — playback begins on unlock.
   *
   * @param {string} id   — track label (re-calling with same id while playing is a no-op)
   * @param {string} url  — path to audio file
   * @param {number} vol  — per-track volume scalar (default 1.0)
   */
  playMusic(id, url, vol = 1.0) {
    if (this._musicTrackId === id && !this._musicEl.paused) return;

    this._musicEl.pause();
    this._musicEl.src         = url;
    this._musicEl.currentTime = 0;
    this._musicTrackId        = id;
    this._pendingMusicVol     = vol;

    // Apply volume — if gain node doesn't exist yet, the raw element volume
    // is set as a fallback so it isn't silent even without the context graph.
    if (this._musicGain) {
      this._musicGain.gain.value = Math.max(0, Math.min(1, vol * this.musicVolume));
    } else {
      this._musicEl.volume = Math.max(0, Math.min(1, vol * this.musicVolume * this.masterVolume));
    }

    if (this.unlocked) {
      this._musicEl.play().catch(() => {});
    }
  }

  /**
   * Stop music.
   * @param {boolean} [reset=true] — seek to start (default) or just pause
   */
  stopMusic(reset = true) {
    this._musicEl.pause();
    if (reset) this._musicEl.currentTime = 0;
    this._musicTrackId = null;
  }

  // ── Volume controls ────────────────────────────────────────────────────────
  //
  // Changes are applied to the gain graph immediately if the context exists,
  // so volume slider changes take effect in real time with no glitch.
  //

  setMasterVolume(v) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this._masterGain) this._masterGain.gain.value = this.masterVolume;
  }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this._sfxGain) this._sfxGain.gain.value = this.sfxVolume;
  }

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this._musicGain) this._musicGain.gain.value = this.musicVolume;
  }
}

export const audio = new AudioManager();
