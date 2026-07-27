/**
 * midi.js — MIDI file loader & player
 *
 * Features:
 *   • Load individual .mid/.midi files
 *   • Load a FOLDER of .mid/.midi files → random-play per level
 *   • Optional SF2-style soundfont via WebAudioFont CDN (real instrument samples)
 *   • Fallback: oscillator-based synthesis when no soundfont is loaded
 *   ��� Volume control, play/pause/stop, onEnd callback
 *   • Multi-listener event system: on(event, fn) / off(event, fn)
 *     Events: 'load' | 'play' | 'end' | 'error' | 'sfload' | 'playlistload'
 */

// ─── WebAudioFont instrument cache ──────────────────────────────��────────────
const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PROGRAMS = {
  0:  '_tone_0000_FluidR3_GM_sf2_file',   // Acoustic Grand Piano
  24: '_tone_0240_FluidR3_GM_sf2_file',   // Acoustic Guitar nylon
  40: '_tone_0400_FluidR3_GM_sf2_file',   // Violin
  48: '_tone_0480_FluidR3_GM_sf2_file',   // Strings
  56: '_tone_0560_FluidR3_GM_sf2_file',   // Trumpet
  73: '_tone_0730_FluidR3_GM_sf2_file',   // Flute
};

// Maximum simultaneous voices. Raising past 24 can stutter on weak hardware.
const MAX_VOICES = 24;

export class MidiPlayer {
  // ─── IndexedDB persistence helpers ─────────────────────────────────────────
  static _idbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open('goon-midi', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks');
      };
      req.onsuccess = (e) => res(e.target.result);
      req.onerror   = () => rej(req.error);
    });
  }

  static async _idbSave(key, value) {
    try {
      const db = await MidiPlayer._idbOpen();
      return new Promise((res, rej) => {
        const tx  = db.transaction('tracks', 'readwrite');
        const req = tx.objectStore('tracks').put(value, key);
        req.onsuccess = () => { db.close(); res(); };
        req.onerror   = () => { db.close(); rej(req.error); };
      });
    } catch(e) { /* non-fatal */ }
  }

  static async _idbLoad(key) {
    try {
      const db = await MidiPlayer._idbOpen();
      return new Promise((res) => {
        const tx  = db.transaction('tracks', 'readonly');
        const req = tx.objectStore('tracks').get(key);
        req.onsuccess = () => { db.close(); res(req.result ?? null); };
        req.onerror   = () => { db.close(); res(null); };
      });
    } catch(e) { return null; }
  }

  static async _idbClear() {
    try {
      const db = await MidiPlayer._idbOpen();
      return new Promise((res) => {
        const tx = db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').clear();
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror    = () => { db.close(); res(); };
      });
    } catch(e) { /* non-fatal */ }
  }

  constructor() {
    this.isLoaded   = false;
    this.isPlaying  = false;
    this.isPaused   = false;
    this.fileName   = '';
    this.volume     = 0.5;

    // Playlist (folder-loaded files)
    this.playlist       = [];
    this.playlistIndex  = -1;
    this.autoAdvance    = true;

    // Soundfont
    this.soundfontName  = '';
    this._sfReady       = false;
    this._sfInstruments = {};
    this._sfPrograms = [];
    this._nearestProgramCache = {};
    this._zoneLUT = {};
    this._sfLoading     = false;
    this._customSF      = null;

    // Internal
    this._ready       = false;
    this._pendingFile = null;
    this._midiData    = null;
    this._player      = null;
    this._audioCtx    = null;
    this._masterGain  = null;
    this._activeNotes = {};   // key → voice object
    this._voiceQueue  = [];   // insertion-ordered keys for LRU steal
    this._progMap     = {};
    this._drumBuf     = null; // reusable noise buffer for ch10

    // ── Multi-listener event registry ──────────────────────────────────────
    // Map: eventName → Set<Function>
    this._listeners = {
      load:        new Set(),
      play:        new Set(),
      end:         new Set(),
      error:       new Set(),
      sfload:      new Set(),
      playlistload: new Set(),
    };

    // Legacy single-slot callback shims (kept for back-compat; prefer on/off)
    // These are no-ops here; _emit calls the listener sets directly.
    this.onLoad         = null;
    this.onPlay         = null;
    this.onEnd          = null;
    this.onError        = null;
    this.onSFLoad       = null;
    this.onPlaylistLoad = null;

    this._loadMidiLib();
  }

  // ─── Multi-listener API ─────────────────��────────────��────────────���─────
  /**
   * Register a listener for an event.
   * @param {string} event  'load'|'play'|'end'|'error'|'sfload'|'playlistload'
   * @param {Function} fn   Callback. Receives event-specific arguments.
   * @returns {Function}    The same fn (for easy off() later).
   */
  on(event, fn) {
    if (this._listeners[event]) this._listeners[event].add(fn);
    return fn;
  }

  /**
   * Remove a listener registered with on().
   */
  off(event, fn) {
    if (this._listeners[event]) this._listeners[event].delete(fn);
  }

  /**
   * Fire all listeners for an event, plus the legacy single-slot callback.
   */
  _emit(event, ...args) {
    if (this._listeners[event]) {
      for (const fn of this._listeners[event]) {
        try { fn(...args); } catch(e) { console.error('[MidiPlayer] listener error:', e); }
      }
    }
    // Legacy shim
    const legacyMap = {
      load:        this.onLoad,
      play:        this.onPlay,
      end:         this.onEnd,
      error:       this.onError,
      sfload:      this.onSFLoad,
      playlistload: this.onPlaylistLoad,
    };
    const cb = legacyMap[event];
    if (typeof cb === 'function') {
      try { cb(...args); } catch(e) {}
    }
  }

  // ─── Library bootstrap ──────────────────────────────────────────────────────
  _loadMidiLib() {
    if (window.MidiPlayer) { this._ready = true; this._restoreFromIDB(); return; }
    if (document.querySelector('script[data-midilib]')) {
      const poll = setInterval(() => {
        if (window.MidiPlayer) { this._ready = true; clearInterval(poll); this._flushPending(); }
      }, 100);
      return;
    }
    const s = document.createElement('script');
    s.setAttribute('data-midilib', 'true');
    s.src = './midi-player.js';
    s.onload  = () => { this._ready = true; this._flushPending(); };
    s.onerror = () => console.warn('[MidiPlayer] Failed to load midi-player-js from CDN');
    document.head.appendChild(s);
  }

  _flushPending() {
    if (this._pendingFile) {
      const f = this._pendingFile;
      this._pendingFile = null;
      this.loadFile(f);
    } else {
      // Try to restore persisted MIDI from IndexedDB
      this._restoreFromIDB();
    }
  }

  async _restoreFromIDB() {
    try {
      // Prefer playlist over single track
      const pl = await MidiPlayer._idbLoad('playlist');
      if (pl && Array.isArray(pl) && pl.length) {
        this.playlist      = pl.map(t => ({ name: t.name, data: t.data }));
        this.playlistIndex = -1;
        this._emit('playlistload', this.playlist.length);
        return;
      }
      const single = await MidiPlayer._idbLoad('single');
      if (single && single.name && single.data) {
        this._midiData = single.data;
        this.fileName  = single.name;
        this.isLoaded  = true;
        this._emit('load', single.name);
      }
    } catch(e) { /* non-fatal */ }
  }

  // ─── Single MIDI file ──────────────────────────────────────────��────────────
  loadFile(file) {
    if (!this._ready) { this._pendingFile = file; return; }
    this.stop();
    this.fileName = file.name;
    this.isLoaded = false;
    const reader = new FileReader();
    reader.onload  = (e) => {
      this._midiData = e.target.result;
      this.isLoaded  = true;
      // Persist single file to IDB so it survives page reloads
      MidiPlayer._idbSave('single', { name: file.name, data: e.target.result })
        .then(() => MidiPlayer._idbSave('playlist', null)).catch(() => {});
      this._emit('load', file.name);
    };
    reader.onerror = () => { this._emit('error', 'Failed to read MIDI file'); };
    reader.readAsArrayBuffer(file);
  }

  // ─── Playlist (folder) ──────────────────────────────────────────────────────
  loadFolder(files) {
    const midiFiles = Array.from(files).filter(f =>
      f.name.toLowerCase().endsWith('.mid') || f.name.toLowerCase().endsWith('.midi')
    );
    if (!midiFiles.length) {
      this._emit('error', 'No MIDI files found in folder');
      return;
    }
    this.playlist      = [];
    this.playlistIndex = -1;
    let pending        = midiFiles.length;

    midiFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload  = (e) => {
        this.playlist.push({ name: file.name, data: e.target.result });
        pending--;
        if (pending === 0) {
          this.playlist.sort((a, b) => a.name.localeCompare(b.name));
          // Persist playlist to IDB (clear single-track slot)
          MidiPlayer._idbSave('playlist', this.playlist.map(t => ({ name: t.name, data: t.data })))
            .then(() => MidiPlayer._idbSave('single', null)).catch(() => {});
          this._emit('playlistload', this.playlist.length);
        }
      };
      reader.onerror = () => { pending--; };
      reader.readAsArrayBuffer(file);
    });
  }

  playRandom() {
    if (!this.playlist.length) {
      if (this.isLoaded) { this.stop(); this.play(); }
      return;
    }
    this.stop();

    let idx = this.playlistIndex;
    if (this.playlist.length > 1) {
      while (idx === this.playlistIndex) {
        idx = Math.floor(Math.random() * this.playlist.length);
      }
    } else {
      idx = 0;
    }
    this.playlistIndex = idx;
    const track        = this.playlist[idx];
    this._midiData     = track.data;
    this.fileName      = track.name;
    this.isLoaded      = true;
    this.play();
  }

  // ─── Soundfont loading ───────────────────────────────────────────────────────
  loadBuiltinSoundfont() {
    if (this._sfLoading || this._sfReady) return;
    this._sfLoading    = true;
    this.soundfontName = 'FluidR3 GM (WebAudioFont)';

    const programs  = Object.entries(WAF_PROGRAMS);
    let   remaining = programs.length;

    programs.forEach(([prog, varName]) => {
      if (window[varName]) {
        this._sfInstruments[prog] = window[varName];
        remaining--;
        if (remaining === 0) this._onSFReady();
        return;
      }
      const s = document.createElement('script');
      s.src     = `${WAF_BASE}${varName}.js`;
      s.onload  = () => {
        if (window[varName]) this._sfInstruments[prog] = window[varName];
        remaining--;
        if (remaining === 0) this._onSFReady();
      };
      s.onerror = () => { remaining--; if (remaining === 0) this._onSFReady(); };
      document.head.appendChild(s);
    });
  }

  loadSoundfontFile(file) {
    this.soundfontName = file.name;
    this._sfReady   = false;
    this._sfLoading = false;
    this._sfInstruments = {};
    this.loadBuiltinSoundfont();
    const reader = new FileReader();
    reader.onload  = (e) => { this._customSF = e.target.result; };
    reader.readAsArrayBuffer(file);
  }

  _onSFReady() {
    this._sfPrograms = Object.keys(this._sfInstruments).map(Number);
    this._nearestProgramCache = {};
    this._zoneLUT = {};

    for (const prog of this._sfPrograms) {
      const instrument = this._sfInstruments[prog];
      const lut = new Array(128);

      if (instrument?.zones?.length) {
        for (let note = 0; note < 128; note++) {
          lut[note] =
            instrument.zones.find(z =>
              z.keyRangeLow <= note &&
              z.keyRangeHigh >= note
            ) || instrument.zones[0];
        }
      }

      this._zoneLUT[prog] = lut;
    }

    this._sfReady   = true;
    this._sfLoading = false;
    this._emit('sfload', this.soundfontName);
  }

  // ─── Playback ──────────────���──────────────────────────────────────────────���─
  play() {
    if (!this.isLoaded || !this._midiData) return;
    if (!this._ready) { this._emit('error', 'MIDI library not ready'); return; }

    try {
      if (!window.MidiPlayer) { this._emit('error', 'MIDI library not ready'); return; }
      if (this._player) { try { this._player.stop(); } catch(e) {} }

      this._ensureAudioCtx();

      // Disconnect the old master gain before creating a new one to prevent
      // orphaned gain nodes accumulating on the audio graph across level loads.
      if (this._masterGain) {
        try { this._masterGain.disconnect(); } catch(e) {}
      }
      this._masterGain = this._audioCtx.createGain();
      this._masterGain.gain.value = this.volume;
      this._masterGain.connect(this._audioCtx.destination);

      this._activeNotes = {};
      this._voiceQueue  = [];
      this._drumBuf     = null;
      this._progMap     = {};

      const Player  = window.MidiPlayer.Player;
      this._player  = new Player((event) => this._handleMidiEvent(event));
      this._player.loadArrayBuffer(this._midiData);
      this._player.on('endOfFile', () => {
        this.isPlaying = false;
        this._emit('end');
      });
      this._player.play();
      this.isPlaying = true;
      this.isPaused  = false;
      this._emit('play');
    } catch(err) {
      console.error('[MidiPlayer] play error:', err);
      this._emit('error', 'Playback error: ' + err.message);
    }
  }

  pause() {
    if (!this.isPlaying || !this._player) return;
    try {
      this._player.pause();
      this.isPlaying = false;
      this.isPaused  = true;
      if (this._masterGain && this._audioCtx) {
        this._masterGain.gain.setTargetAtTime(0, this._audioCtx.currentTime, 0.1);
      }
    } catch(e) {}
  }

  resume() {
    if (!this.isPaused || !this._player) return;
    try {
      if (this._audioCtx && this._audioCtx.state === 'suspended') this._audioCtx.resume();
      if (this._masterGain && this._audioCtx) {
        this._masterGain.gain.setTargetAtTime(this.volume, this._audioCtx.currentTime, 0.1);
      }
      this._player.play();
      this.isPlaying = true;
      this.isPaused  = false;
      this._emit('play');
    } catch(e) {}
  }

  stop() {
    if (this._player) { try { this._player.stop(); } catch(e) {} }
    if (this._activeNotes) {
      for (const key of Object.keys(this._activeNotes)) {
        try { this._activeNotes[key].stop(0); } catch(e) {}
      }
      this._activeNotes = {};
      this._voiceQueue  = [];
    }
    if (this._wafSources) {
      this._wafSources.forEach(s => { try { s.stop(); } catch(e) {} });
      this._wafSources = [];
    }
    this._drumBuf  = null;
    this.isPlaying = false;
    this.isPaused  = false;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._masterGain && this._audioCtx) {
      this._masterGain.gain.setTargetAtTime(this.volume, this._audioCtx.currentTime, 0.05);
    }
  }

  destroy() {
    this.stop();
    if (this._audioCtx) { try { this._audioCtx.close(); } catch(e) {} this._audioCtx = null; }
  }

  // ─── Audio context helper ─────────────────���─────────────────────────────────
  _ensureAudioCtx() {
    if (!this._audioCtx) {
      this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    if (!this._wafSources) this._wafSources = [];
  }

  // ─── Note frequency ──────────���─────��────────────────────────────────────────
  _noteFrequency(note) { return 440 * Math.pow(2, (note - 69) / 12); }

  // ─── Voice management ────────────────────────────────────────────────────────
  /**
   * Register a new voice under `key`, stealing the oldest if at MAX_VOICES.
   */
  _registerVoice(key, voice) {
    // Evict oldest if at cap
    if (this._voiceQueue.length >= MAX_VOICES) {
      const oldest = this._voiceQueue.shift();
      if (this._activeNotes[oldest]) {
        try { this._activeNotes[oldest].stop(this._audioCtx.currentTime); } catch(e) {}
        delete this._activeNotes[oldest];
      }
    }
    // Replace same key without growing queue
    if (this._activeNotes[key]) {
      try { this._activeNotes[key].stop(this._audioCtx.currentTime + 0.02); } catch(e) {}
      const idx = this._voiceQueue.indexOf(key);
      if (idx !== -1) this._voiceQueue.splice(idx, 1);
    }
    this._activeNotes[key] = voice;
    this._voiceQueue.push(key);
  }

  _releaseVoice(key, t) {
    if (!this._activeNotes[key]) return;
    try { this._activeNotes[key].stop(t); } catch(e) {}
    delete this._activeNotes[key];
    const idx = this._voiceQueue.indexOf(key);
    if (idx !== -1) this._voiceQueue.splice(idx, 1);
  }

  // ─── MIDI event handler ─────────────────────────────────────────────────────
  _handleMidiEvent(event) {
    if (!this._audioCtx || !this._masterGain) return;
    const ctx = this._audioCtx;

    if (event.name === 'Program Change') {
      this._progMap[event.channel] = event.value;
      return;
    }

    if (event.name === 'Note on' && event.velocity > 0) {
      const key = `${event.channel}_${event.noteNumber}`;
      const vel = event.velocity / 127;

      // ── WebAudioFont path ──────────────────────────────────────────────────
      if (this._sfReady) {
        const prog = this._progMap[event.channel] ?? 0;

        let nearest = this._nearestProgramCache[prog];

        if (nearest === undefined) {
          const progKeys = this._sfPrograms;
          nearest = progKeys.reduce((a, b) =>
            Math.abs(b - prog) < Math.abs(a - prog) ? b : a,
            progKeys[0] ?? 0);
          this._nearestProgramCache[prog] = nearest;
        }

        const instrument = this._sfInstruments[nearest];

        if (instrument && instrument.zones) {
          const zone =
            this._zoneLUT[nearest]?.[event.noteNumber] ||
            instrument.zones[0];

          if (zone && zone.buffer) {
            const bufSrc  = ctx.createBufferSource();
            bufSrc.buffer = zone.buffer;
            if (zone.loopStart && zone.loopEnd && zone.loopStart < zone.loopEnd) {
              bufSrc.loop      = true;
              bufSrc.loopStart = zone.loopStart / ctx.sampleRate;
              bufSrc.loopEnd   = zone.loopEnd   / ctx.sampleRate;
            }
            const semitones    = event.noteNumber - (zone.baseRootKey ?? 60);
            bufSrc.detune.value = semitones * 100;
            bufSrc.playbackRate.value = zone.coarseTune ? Math.pow(2, zone.coarseTune / 12) : 1;

            const gn = ctx.createGain();
            gn.gain.setValueAtTime(vel * 0.7, ctx.currentTime);
            bufSrc.connect(gn);
            gn.connect(this._masterGain);
            bufSrc.start(ctx.currentTime);
            this._wafSources.push(bufSrc);

            bufSrc.onended = () => {
              const idx = this._wafSources.indexOf(bufSrc);
              if (idx !== -1) this._wafSources.splice(idx, 1);
            };

            this._registerVoice(key, {
              stop: (t) => {
                const releaseTime = t || ctx.currentTime;
                gn.gain.setTargetAtTime(0, releaseTime, 0.05);
                try { bufSrc.stop(releaseTime + 0.30); } catch(e) {}
              }
            });
            return;
          }
        }
      }

      // ── Oscillator fallback ────────────────────────────────────────────────
      // Channel 10 = drums: reuse a single pooled noise buffer
      if (event.channel === 10) {
        if (!this._drumBuf) {
          const bufSize    = Math.floor(ctx.sampleRate * 0.08);
          this._drumBuf    = ctx.createBuffer(1, bufSize, ctx.sampleRate);
          const data       = this._drumBuf.getChannelData(0);
          for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
        }
        const noise   = ctx.createBufferSource();
        noise.buffer  = this._drumBuf;
        const gn      = ctx.createGain();
        gn.gain.setValueAtTime(vel * 0.25, ctx.currentTime);
        gn.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        noise.connect(gn); gn.connect(this._masterGain);
        noise.start(ctx.currentTime);
        noise.stop(ctx.currentTime + 0.08);
        // Drums are very short — don't register as sustained voices
        return;
      }

      const freq  = this._noteFrequency(event.noteNumber);
      const osc   = ctx.createOscillator();
      const gn    = ctx.createGain();
      const waves = ['sine', 'triangle', 'square', 'sawtooth'];
      osc.type    = waves[event.channel % waves.length];
      osc.frequency.value = freq;
      gn.gain.setValueAtTime(0, ctx.currentTime);
      gn.gain.linearRampToValueAtTime(vel * 0.18, ctx.currentTime + 0.01);
      osc.connect(gn); gn.connect(this._masterGain);
      osc.start(ctx.currentTime);

      this._registerVoice(key, {
        stop: (t) => {
          const releaseTime = t || ctx.currentTime;
          gn.gain.setTargetAtTime(0, releaseTime, 0.05);
          try { osc.stop(releaseTime + 0.15); } catch(e) {}
        }
      });

    } else if (event.name === 'Note off' || (event.name === 'Note on' && event.velocity === 0)) {
      const key = `${event.channel}_${event.noteNumber}`;
      this._releaseVoice(key, ctx.currentTime);
    }
  }
}
