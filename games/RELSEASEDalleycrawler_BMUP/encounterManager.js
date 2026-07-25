/**
 * encounterManager.js — Encounter state machine.
 *
 * The EncounterManager owns:
 *   - The list of active enemies for the current encounter
 *   - Active food/SP pickups (dropped by props or collected)
 *   - Active props (breakable objects across the full level)
 *   - The scroll-lock state and bounds
 *   - The GO!! prompt timer
 *   - Encounter trigger edge-detection (prevPlayerX)
 *
 * Status values (read by Game to branch its own phase logic):
 *   'searching'   — player walking freely, watching for the next trigger
 *   'locking'     — trigger fired this frame (game should apply scroll lock)
 *   'active'      — scroll locked, enemies alive
 *   'bossIntro'   — boss encounter just started (delay before 'active')
 *   'goPrompt'    — all enemies dead, GO!! banner showing
 *   'completed'   — GO!! finished; game may unlock camera and advance
 *   'encCleared'  — boss was cleared (game handles level-end vs victory)
 *
 * The Game reads `status`, `isLocked`, `scrollLockX`, `scrollRightLimit`,
 * `activeEnemies`, `activeFood`, `activeProps`, `currentEncounter`,
 * `encounterIdx`, and `goPromptTimer` to drive camera, HUD, and overlay.
 */

import { Enemy, Boss, FoodItem, SpItem, Prop, HitEffect, LANE_MIN_Z, LANE_MAX_Z } from './entities.js';
import { cues } from './audioCues.js';

// Constants mirrored from game.js for camera right-limit computation.
// The Game passes rendererW so we don't import from renderer.
const SAFE_Z_MIN   = LANE_MIN_Z + 30;
const SAFE_Z_MAX   = LANE_MAX_Z - 30;
const MID_Z        = (SAFE_Z_MIN + SAFE_Z_MAX) * 0.5;

// Props within this world-X radius of the camera are considered "active"
// (updated and checked for player collisions). Props outside are dormant.
const PROP_ACTIVE_RADIUS = 400;

// After a prop is broken its debris lingers for this many frames then is culled.
const PROP_DEBRIS_LIFE = 45;

export class EncounterManager {
  constructor() {
    // ── Persistent across level ─────────────────────────────────────────────
    this.encounters    = [];     // level encounter data (set by reset())
    this.encounterIdx  = 0;      // which encounter we're on (or just cleared)

    // ── Per-encounter state ─────────────────────────────────────────────────
    this.activeEnemies    = [];
    this.activeFood       = [];  // FoodItem / SpItem pickups on the ground
    this.currentEncounter = null;

    // ── Props — level-wide, persist across encounters ──────────────���────────
    this.allProps    = [];   // full prop data from levelFactory
    this.activeProps = [];   // Prop instances currently in active radius

    // ── Status FSM ─────────────────────────────────────────────────────────
    // searching | locking | active | bossIntro | goPrompt | completed | encCleared
    this.status = 'searching';

    // ── Scroll lock ─────────────────────────────────────────────────────────
    this.isLocked         = false;
    this.scrollLockX      = 0;    // camera X when lock was engaged
    this.scrollRightLimit = Infinity;

    // ── GO!! prompt ─────────────────────────────────────────────────────────
    this.goPromptTimer = 0;
    this.GO_PROMPT_DURATION = 90; // frames

    // ── Boss intro ──────────────────────────────────────────────────────────
    this.bossIntroTimer = 0;
    this.BOSS_INTRO_DURATION = 90; // frames

    // ── Trigger edge-detection ───────────────────────────────────────────────
    this._prevPlayerX = 0;

    // ── Spawn freshness guard ─────────────────────────────────────────────
    this._activeFrames = 0;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Called by Game._initLevel() — reset all state for a new level. */
  reset(levelData, playerX) {
    this.encounters    = levelData.encounters;
    this.encounterIdx  = 0;
    this.activeEnemies = [];
    this.activeFood    = [];
    this.currentEncounter = null;

    // Instantiate all props from level data (they stream in/out by proximity)
    this.allProps = (levelData.props || []).map(pd => new Prop(pd.x, pd.z, pd.variant));
    this.activeProps = [];

    this.status           = 'searching';
    this.isLocked         = false;
    this.scrollLockX      = 0;
    this.scrollRightLimit = Infinity;
    this.goPromptTimer    = 0;
    this.bossIntroTimer   = 0;
    this._activeFrames    = 0;

    // Seed prevPlayerX so the first trigger doesn't fire immediately
    this._prevPlayerX = playerX;
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  /**
   * Call once per simulation tick.
   *
   * @param {number} playerX   — current player world X (post-movement)
   * @param {number} cameraX   — current camera X (used for scroll right-limit)
   * @param {number} rendererW — canvas pixel width (used for scroll right-limit)
   * @param {object} hitEffects — array to push HitEffect into (food pickup text)
   * @param {Player} player    — player object (food pickup + game-over check)
   * @returns {{ encJustCleared: boolean, bossJustCleared: boolean, waveClearScore: number }}
   */
  update(playerX, cameraX, rendererW, hitEffects, player) {
    const result = {
      encJustCleared:  false,
      bossJustCleared: false,
      waveClearScore:  0,
    };

    switch (this.status) {

      // ── SEARCHING: watch for the player to cross the next trigger ──────────
      case 'searching': {
        if (this.encounterIdx < this.encounters.length) {
          const enc = this.encounters[this.encounterIdx];
          if (this._prevPlayerX < enc.triggerX && playerX >= enc.triggerX) {
            this._triggerEncounter(enc, cameraX, rendererW);
          }
        }
        break;
      }

      // ── LOCKING: transition frame ──────────────────────────────────────────
      case 'locking': {
        this.status = this.currentEncounter?.isBoss ? 'bossIntro' : 'active';
        break;
      }

      // ── BOSS INTRO: countdown before combat ───────────────────────────────
      case 'bossIntro': {
        this.bossIntroTimer--;
        if (this.bossIntroTimer <= 0) {
          this.status = 'active';
        }
        break;
      }

      // ── ACTIVE: enemies alive, scroll locked ──────────────────────────────
      case 'active': {
        this._activeFrames++;
        this._updateEnemies(player);
        this._updatePickups(player, hitEffects);

        if (this._activeFrames >= 10) {
          const alive = this.activeEnemies.filter(e => e.state !== 'dead');
          if (alive.length === 0) {
            this._waveCleared(result, player, cameraX);
          }
        }
        break;
      }

      // ── GO PROMPT: show banner until player walks past the right boundary ──
      case 'goPrompt': {
        this.goPromptTimer++;
        if (playerX >= this.scrollRightLimit) {
          this._unlock(playerX);
          this.status = 'completed';
        }
        break;
      }

      // ── COMPLETED / ENCCLEARED: Game reads these and calls acknowledge* ───
      case 'completed':
      case 'encCleared':
        break;
    }

    // Update pickups in every non-active status so food dropped by props
    // while the player is freely walking (searching) is still collectable.
    // 'active' already calls _updatePickups inside its own branch above.
    if (this.status !== 'active') {
      this._updatePickups(player, hitEffects);
    }

    // ── Props: stream in/out by proximity; update active set ────────────────
    this._updateProps(playerX, cameraX, player, hitEffects);

    // ── prevPlayerX logic ────────────────────────────────────────────────────
    if (this.status === 'searching') {
      this._prevPlayerX = playerX;
    } else if (this.status === 'completed') {
      this._prevPlayerX = playerX;
      this.status = 'searching';
    }

    return result;
  }

  // ── Called by Game after reading 'completed' status ───────────────────────
  acknowledge() {
    if (this.status === 'completed') this.status = 'searching';
  }

  // ── Called by Game after reading 'encCleared' status ─────────────────────
  acknowledgeEncCleared() {
    if (this.status === 'encCleared') this.status = 'searching';
  }

  // ── Public helpers ─────────────────────────────────────���───────────────────

  get aliveCount() {
    return this.activeEnemies.filter(e => e.state !== 'dead').length;
  }

  get currentIsBoss() {
    return this.currentEncounter?.isBoss ?? false;
  }

  /**
   * Called by Game when the player lands a hit (punch/kick attack hitbox).
   * Checks all active props for overlap and applies damage.
   * Returns an array of new drop entities (FoodItem / SpItem) spawned by broken props.
   */
  checkPropHits(attackHitbox, damage, hitEffects) {
    const drops = [];
    for (const prop of this.activeProps) {
      if (prop.broken) continue;
      const dx = Math.abs(prop.x - attackHitbox.x);
      const dz = Math.abs(prop.z - attackHitbox.z);
      if (dx < (attackHitbox.w + prop.w) * 0.5 && dz < (attackHitbox.d + prop.w) * 0.5) {
        const newDrops = prop.hit(damage);
        for (const drop of newDrops) {
          this.activeFood.push(drop);
          const label = drop.type === 'spItem' ? '+SP' : `+${drop.healAmount}HP`;
          hitEffects.push(new HitEffect(prop.x, prop.z, label));
        }
        drops.push(...newDrops);
        // Only hit one prop per swing (prevents clearing entire cluster in 1 frame)
        break;
      }
    }
    return drops;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _triggerEncounter(enc, cameraX, rendererW) {
    this.currentEncounter = enc;
    this.isLocked         = true;
    // Snap scrollLockX to the exact camera position this tick so the camera
    // freeze point is stable — no lag drift between trigger and lock.
    this.scrollLockX      = cameraX;
    this._activeFrames    = 0;

    // The right boundary the player must reach to end the GO!! phase.
    // Half-screen to the right of the lock point — gives the player room to walk
    // without immediately exiting the prompt.
    this.scrollRightLimit = cameraX + (rendererW * 0.5) - 20;

    const HALF_SCREEN_W = 120;
    this.activeEnemies = [];

    for (let idx = 0; idx < enc.enemies.length; idx++) {
      const ed = enc.enemies[idx];

      let ex;
      if (ed.variant === 'boss') {
        ex = cameraX + HALF_SCREEN_W * 0.6;
      } else {
        const side    = (idx % 2 === 0) ? 1 : -1;
        const baseOff = side * (HALF_SCREEN_W * 0.4 + (idx >> 1) * 30);
        const extraOff = (ed.offsetX || 0) * 0.3;
        ex = cameraX + baseOff + extraOff;
        ex = Math.max(cameraX - HALF_SCREEN_W + 10,
              Math.min(cameraX + HALF_SCREEN_W - 10, ex));
      }

      const rawZ = MID_Z + (ed.offsetZ || 0);
      const ez = Math.max(SAFE_Z_MIN, Math.min(SAFE_Z_MAX, rawZ));

      if (ed.variant === 'boss') {
        this.activeEnemies.push(new Boss(ex, ez));
      } else {
        this.activeEnemies.push(new Enemy(ex, ez, ed.variant));
      }
    }

    if (this.activeEnemies.length === 0) {
      this._unlock(this._prevPlayerX);
      this.encounterIdx++;
      this.currentEncounter = null;
      return;
    }

    if (enc.isBoss) {
      this.bossIntroTimer = this.BOSS_INTRO_DURATION;
      this.status = 'bossIntro';
    } else {
      this.status = 'active';
    }
  }

  _waveCleared(result, player, cameraX) {
    const enc = this.currentEncounter;
    const scoreGain = enc.isBoss ? 2000 : 500;
    result.waveClearScore = scoreGain;
    this.encounterIdx++;

    if (enc.isBoss) {
      result.bossJustCleared = true;
      this.isLocked = false;
      this.status   = 'encCleared';
    } else {
      result.encJustCleared = true;
      this.goPromptTimer = 0;
      this.status = 'goPrompt';
    }
  }

  _unlock(currentPlayerX) {
    this.isLocked      = false;
    this.scrollRightLimit = Infinity;
    this._prevPlayerX  = currentPlayerX;
  }

  _updateEnemies(player) {
    const snap = this.activeEnemies.slice();
    for (const e of snap) {
      if (e.state === 'dead') continue;
      const prevState = e.state;
      e.update(player);
      // Fire the down cue on the exact frame the enemy transitions to dead
      if (e.state === 'dead' && prevState !== 'dead') {
        cues.play('enemyDown');
      }
    }
  }

  _updatePickups(player, hitEffects) {
    for (const f of this.activeFood) {
      f.update();
      if (!f.collected && player.state !== 'dead') {
        const dx = Math.abs(player.x - f.x);
        const dz = Math.abs(player.z - f.z);
        if (dx < 30 && dz < 30) {
          f.collected = true;
          if (f.type === 'spItem') {
            // Charge SP upward toward SUPER_COOLDOWN (no auto-regen, pickups only)
            player.superCharge = Math.min(player.SUPER_COOLDOWN, player.superCharge + f.spAmount);
            player.score += 30;
            hitEffects.push(new HitEffect(f.x, f.z, '+SP!'));
          } else {
            player.heal(f.healAmount);
            player.score += 50;
            hitEffects.push(new HitEffect(f.x, f.z, `+${f.healAmount}HP`));
          }
        }
      }
    }
    this.activeFood = this.activeFood.filter(f => !f.collected);
  }

  _updateProps(playerX, cameraX, player, hitEffects) {
    // 1. Stream dormant props into the active set when in range
    for (const prop of this.allProps) {
      if (prop.broken && prop.breakTimer > PROP_DEBRIS_LIFE) continue; // fully culled
      if (this.activeProps.includes(prop)) continue;
      if (Math.abs(prop.x - playerX) < PROP_ACTIVE_RADIUS) {
        this.activeProps.push(prop);
      }
    }

    // 2. Update active props
    for (const prop of this.activeProps) {
      prop.update();
    }

    // 3. Cull debris that has finished its animation
    this.activeProps = this.activeProps.filter(
      p => !p.broken || p.breakTimer <= PROP_DEBRIS_LIFE
    );
  }
}
