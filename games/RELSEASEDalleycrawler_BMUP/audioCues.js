/**
 * audioCues.js — Game-event → sound-ID mapping layer.
 *
 * PURPOSE
 * -------
 * Keeps audio logic out of gameplay code.  Entity/combat systems call a
 * single named cue (e.g. 'hit', 'crit', 'jump'); this module decides which
 * AudioManager ID to play and at what volume.  Future devs adding sounds
 * edit only the CUE_MAP below — nothing else changes.
 *
 * USAGE
 * -----
 *   import { cues } from './audioCues.js';
 *
 *   // In entities.js — Player attack swing:
 *   cues.play('punch');
 *
 *   // In entities.js — after calculateHit returns a result:
 *   if (result.type === 'crit')   cues.play('crit');
 *   else                          cues.play('hit');
 *
 *   // In encounterManager.js — enemy defeated:
 *   cues.play('enemyDown');
 *
 * HOOK POINTS (where to call cues.play in entities.js)
 * ----------------------------------------------------
 *   Player.update()  — attack state machine, on the frame attackFrame fires:
 *     cues.play('punch')  or  cues.play('kick')
 *
 *   Player.update()  — on jump state entry (jumpY transitions from 0):
 *     cues.play('jump')
 *
 *   Player.update()  — on landing (jumpY returns to 0, was > 0 last frame):
 *     cues.play('land')
 *
 *   Enemy.takeDamage(result)  — receives the calculateHit result object:
 *     cues.play(result.type === 'crit' ? 'crit' : 'hit')
 *
 *   EncounterManager  — when an enemy transitions to dead / death anim starts:
 *     cues.play('enemyDown')
 *
 *   MainMenu / PauseMenu  — cursor movement:
 *     cues.play('menuMove')
 *
 *   MainMenu / PauseMenu  — confirm / select:
 *     cues.play('menuConfirm')
 *
 * ADDING NEW CUES
 * ---------------
 *   1. Register the sound in main.js with audio.load() or audio.loadVariation().
 *   2. Add an entry to CUE_MAP below.
 *   3. Call cues.play('yourCue') from the relevant entity/system.
 *   Done — no other files need changing.
 *
 * VOLUME GUIDELINES
 * -----------------
 *   1.0  — primary player actions (punch, kick, jump)
 *   0.85 — hit/damage feedback (hit, crit, enemyDown)
 *   0.6  — ambient / secondary (land, menu navigation)
 */

// ── CUE_MAP ──────────────────────────────────────────────────────────────────
//
// key   : cue name called by game systems
// id    : AudioManager sound ID (registered in main.js)
// vol   : playback volume (0–1), multiplied by sfxVolume × masterVolume
//
// To silence a cue temporarily without removing call sites, set vol to 0.
//
const CUE_MAP = {
  // ── Combat — attacker side ────────────────────────────────────────────────
  punch:       { id: 'punch',      vol: 1.0  },
  kick:        { id: 'kick',       vol: 1.0  },

  // ── Combat — defender side ────────────────────────────────────────────────
  hit:         { id: 'hit',        vol: 0.85 },
  crit:        { id: 'crit',       vol: 0.85 },

  // ── Enemy lifecycle ───────────────────────────────────────────────────────
  enemyDown:   { id: 'enemyDown',  vol: 0.85 },

  // ── Player movement ───────────────────────────────────────────────────────
  jump:        { id: 'jump',       vol: 1.0  },
  land:        { id: 'land',       vol: 0.6  },

  // ── Menu / UI ─────────────────────────────────────────────────────────────
  menuMove:    { id: 'menuMove',   vol: 0.6  },
  menuConfirm: { id: 'menuConfirm',vol: 0.6  },
};

// ── AudioCues ─────────────────────────────────────────────────────────────────

class AudioCues {
  /**
   * @param {import('./audio.js').AudioManager} manager
   */
  constructor(manager) {
    this._manager = manager;
  }

  /**
   * Play a named game cue.
   *
   * Silent no-op if:
   *   · the cue isn't in CUE_MAP (typo safety — warns in dev)
   *   · the AudioManager doesn't have the sound loaded yet (graceful degradation)
   *
   * @param {string} cueName
   */
  play(cueName) {
    const entry = CUE_MAP[cueName];

    if (!entry) {
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`audioCues: unknown cue "${cueName}"`);
      }
      return;
    }

    if (!this._manager.has(entry.id)) {
      // Sound not loaded yet — silently skip.
      // This covers the window between page load and audio.load() completing.
      return;
    }

    this._manager.play(entry.id, entry.vol);
  }

  /**
   * Convenience: play the correct hit cue from a calculateHit result object.
   *
   * Usage in Enemy.takeDamage(result):
   *   cues.playHitResult(result);
   *
   * @param {{ type: 'normal' | 'crit' }} result
   */
  playHitResult(result) {
    this.play(result.type === 'crit' ? 'crit' : 'hit');
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────
//
// Imported by audio.js at module evaluation time, so the manager reference
// is injected lazily via init() to avoid circular-import issues.
//
let _instance = null;

/**
 * Call once in main.js after audio is constructed:
 *   import { initCues, cues } from './audioCues.js';
 *   initCues(audio);
 *
 * @param {import('./audio.js').AudioManager} manager
 */
export function initCues(manager) {
  _instance = new AudioCues(manager);
}

/**
 * The live singleton — import and call from anywhere after initCues().
 * Safe to import at module top level; play() is a no-op until initCues() runs.
 */
export const cues = new Proxy(
  {},
  {
    get(_target, prop) {
      if (!_instance) return () => {};          // pre-init safety
      return _instance[prop].bind(_instance);
    },
  }
);
