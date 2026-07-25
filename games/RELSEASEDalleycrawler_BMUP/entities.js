/**
 * Entity system — Player, Enemy, Boss, FoodItem, HitEffect
 * Beat em up logic: 8-direction movement, combat, AI
 */

import { GamepadManager, BTN, AXIS } from './gamepad.js';
import { PHYS, applyFriction, applyGravity } from './physics.js';
import { calculateHit } from './combat.js';
import { cues } from './audioCues.js';

export const WORLD_WIDTH = 20000; // large enough that the per-enemy X clamp never triggers during normal play
export const WORLD_DEPTH = 800;
// Render-space Z: higher Z = farther from camera (toward horizon, higher on screen).
// fov/z projection: z=120 ≈ bottom of screen (near camera), z=600 ≈ horizon.
export const LANE_MIN_Z = 120;  // near camera  (bottom of screen)
export const LANE_MAX_Z = 480;  // far / horizon (upper portion of screen)

// ---- Input ----

/**
 * Maps gamepad state (from GamepadManager) onto the same key-code strings
 * that the keyboard path uses.  This means all player / game logic that
 * calls input.isDown() / input.wasPressed() works identically for both
 * keyboard and controller — no changes needed anywhere else.
 *
 * Standard gamepad → key-code mapping used here:
 *   Left-stick X / D-pad left|right → ArrowLeft / ArrowRight / KeyA / KeyD
 *   Left-stick Y / D-pad up|down    → ArrowUp   / ArrowDown  / KeyW / KeyS
 *   A (0)  → Punch  (KeyJ / KeyZ)
 *   X (2)  → Kick   (KeyK / KeyX)
 *   B (1)  → Jump   (KeyL / KeyC)
 *   Y (3)  → Super  (ShiftLeft)
 *   Start  → Space  (confirm on end/game-over screens)
 */
export class InputHandler {
  constructor(bindings) {
    this._bindings   = bindings || null;
    this.keys        = {};
    this.justPressed = {};

    // ── Keyboard ──────────────────────────────────────────────────────────
    // _kbHeld tracks what the physical keyboard is holding independently of
    // gamepad state, so we can safely share the keys[] map between both sources.
    this._kbHeld = {};

    window.addEventListener('keydown', e => {
      if (!this.keys[e.code]) this.justPressed[e.code] = true;
      this.keys[e.code]   = true;
      this._kbHeld[e.code] = true;
      if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => {
      this._kbHeld[e.code] = false;
      // Only clear shared keys[] if gamepad isn't also holding this code
      if (!this._gpHeld?.[e.code]) this.keys[e.code] = false;
    });

    // ── Gamepad ───────────────────────────────────────────────────────────
    this._gp = new GamepadManager({ deadzone: 0.2 });

    // Virtual key names that the gamepad drives (held = isDown, first frame = wasPressed)
    // We keep a parallel set for gamepad-held states so release is clean.
    this._gpHeld = {};   // code -> true while gamepad considers it held

    this._gp.on('update', (pads) => this._syncGamepad(pads));

    // Show a brief on-screen hint when a controller connects
    this._gp.on('connected', (pad) => {
      this._showControllerToast(`🎮 Controller connected: ${pad.id.slice(0, 32)}`);
    });
    this._gp.on('disconnected', (pad) => {
      // Release all virtual gamepad keys so nothing gets stuck
      for (const code of Object.keys(this._gpHeld)) {
        this._gpHeld[code] = false;
        this.keys[code]    = false;
      }
      this._showControllerToast('🎮 Controller disconnected');
    });

    this._gp.start();
  }

  // ── Gamepad sync (called every poll frame by GamepadManager) ─────────────

  _syncGamepad(pads) {
    if (pads.length === 0) return;
    const pad = pads[0]; // player 1 = first connected controller

    // Build the set of virtual codes we want held this frame
    const want = new Set();

    // --- Buttons ---
    if (pad.buttons[BTN.A]?.pressed)      want.add('KeyJ');       // punch
    if (pad.buttons[BTN.X]?.pressed)      want.add('KeyK');       // kick
    if (pad.buttons[BTN.B]?.pressed)      want.add('KeyL');       // jump
    if (pad.buttons[BTN.Y]?.pressed)      want.add('ShiftLeft');  // super
    if (pad.buttons[BTN.START]?.pressed) { want.add('Space'); want.add('Escape'); } // confirm + pause
    if (pad.buttons[BTN.UP]?.pressed)     want.add('ArrowUp');
    if (pad.buttons[BTN.DOWN]?.pressed)   want.add('ArrowDown');
    if (pad.buttons[BTN.LEFT]?.pressed)   want.add('ArrowLeft');
    if (pad.buttons[BTN.RIGHT]?.pressed)  want.add('ArrowRight');

    // --- Left stick (circular deadzone already handled by GamepadManager) ---
    const stick = this._gp.getStick(0, AXIS.LEFT_X, AXIS.LEFT_Y);
    if (stick.x < -0.3) want.add('ArrowLeft');
    if (stick.x >  0.3) want.add('ArrowRight');
    if (stick.y < -0.3) want.add('ArrowUp');
    if (stick.y >  0.3) want.add('ArrowDown');

    // --- D-pad fallback already captured via BTN.UP/DOWN/LEFT/RIGHT above ---

    // Apply: press (first-frame) and release transitions
    const allCodes = new Set([...Object.keys(this._gpHeld), ...want]);
    for (const code of allCodes) {
      const wasHeld = !!this._gpHeld[code];
      const isHeld  = want.has(code);

      if (isHeld && !wasHeld) {
        // Button just pressed via gamepad — inject into justPressed
        // (only if keyboard hasn't already claimed this slot this frame)
        if (!this.keys[code]) this.justPressed[code] = true;
        this.keys[code]   = true;
        this._gpHeld[code] = true;
      } else if (!isHeld && wasHeld) {
        // Button released via gamepad
        this._gpHeld[code] = false;
        // Only clear keys[] if keyboard isn't also holding it
        if (!this._isKeyboardHolding(code)) {
          this.keys[code] = false;
        }
      }
    }
  }

  /**
   * Returns true if the physical keyboard currently has this key-code down.
   * We can't query this directly from KeyboardEvent state, so we rely on the
   * fact that keyup events clear keys[code] — if it's still true AND gpHeld
   * is false (or being released), the keyboard must be holding it.
   *
   * This is conservative: in the rare edge case where both keyboard and gamepad
   * hold the same code and gamepad releases first, we keep the key "down" which
   * is the correct behaviour.
   */
  _isKeyboardHolding(code) {
    // We track keyboard separately via _kbHeld to be unambiguous
    return !!this._kbHeld?.[code];
  }

  isDown(code)    { return !!this.keys[code]; }
  wasPressed(code){ return !!this.justPressed[code]; }
  flush()         {
    this.justPressed    = {};
    this._chordsThisFrame = null; // invalidate chord cache each tick
  }

  /** Check if any key bound to an action is currently held */
  actionDown(actionId) {
    if (!this._bindings) return false;
    return this._bindings.codesFor(actionId).some(c => !!this.keys[c]);
  }

  /** Check if any key bound to an action was just pressed this frame */
  actionPressed(actionId) {
    if (!this._bindings) return false;
    return this._bindings.codesFor(actionId).some(c => !!this.justPressed[c]);
  }

  // ── Chord detection ─────────────────────────────────────────────────────────
  //
  // A chord fires when BOTH inputs are satisfied simultaneously:
  //   - at least one was JUST pressed this frame (edge trigger)
  //   - the other is either just-pressed OR currently held
  //
  // The chord set is computed lazily once per tick and cached until flush().
  //
  // Supported chords  (id → [actionA, actionB]):
  //   fwdJump    forward  + jump
  //   backJump   backward + jump
  //   upJump     up       + jump
  //   downJump   down     + jump
  //   punchJump  punch    + jump
  //   kickJump   kick     + jump
  //   superJump  super    + jump

  _buildChords() {
    const chordDefs = [
      ['fwdJump',   'right', 'jump'],
      ['backJump',  'left',  'jump'],
      ['upJump',    'up',    'jump'],
      ['downJump',  'down',  'jump'],
      ['punchJump', 'punch', 'jump'],
      ['kickJump',  'kick',  'jump'],
      ['superJump', 'super', 'jump'],
    ];

    const fired = new Set();
    for (const [id, actionA, actionB] of chordDefs) {
      const aDown    = this.actionDown(actionA);
      const bDown    = this.actionDown(actionB);
      const aPressed = this.actionPressed(actionA);
      const bPressed = this.actionPressed(actionB);

      // Chord fires if both are held and at least one just arrived this frame
      if ((aDown || aPressed) && (bDown || bPressed) && (aPressed || bPressed)) {
        fired.add(id);
      }
    }
    this._chordsThisFrame = fired;
  }

  /** Returns true if the named chord fired this frame */
  chordPressed(chordId) {
    if (!this._chordsThisFrame) this._buildChords();
    return this._chordsThisFrame.has(chordId);
  }

  // ── Toast helper — shows a small transient message in the game UI ─────────
  _showControllerToast(msg) {
    try {
      let toast = document.getElementById('gp-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'gp-toast';
        toast.style.cssText = [
          'position:fixed','bottom:8px','left:50%','transform:translateX(-50%)',
          'background:rgba(0,0,0,0.75)','color:#fff','font:bold 11px Courier New',
          'padding:4px 10px','border-radius:4px','pointer-events:none',
          'z-index:9999','transition:opacity 0.4s',
        ].join(';');
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.opacity = '1';
      clearTimeout(toast._hideTimer);
      toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
    } catch (_) {}
  }
}

// ---- Player ----
export class Player {
  constructor(x, z) {
    this.type = 'player';
    this.id = 'player1';
    this.x = x;
    this.z = z;
    this.prevX = x;      // render interpolation — spec §28
    this.prevZ = z;
    this.prevJumpY = 0;
    this.vy = 0;
    this.jumpY = 0;      // visual-only Y offset (positive = up on screen)
    this.vx = 0;
    this.vz = 0;
    this.w = 22;
    this.h = 36;
    this.speed = 2.2;
    this.facing = 1;

    this.hp = 100;
    this.maxHp = 100;
    this.lives = 3;
    this.score = 0;

    this.state = 'idle';
    this.stateTimer = 0;
    this.animFrame = 0;
    this.hitFlash = 0;

    // Respawn state
    this.respawning  = false;
    this.respawnTimer = 0;          // counts down from RESPAWN_FALL_FRAMES
    this.iframeTimer  = 0;          // invincibility frames after landing
    this.RESPAWN_FALL_FRAMES = 40;  // ~0.67s drop time at 60hz
    this.RESPAWN_IFRAME_FRAMES = 60; // 1 second of iframes

    this.attackCooldown = 0;
    this.hurtCooldown = 0;
    this.comboCount = 0;
    this.comboTimer = 0;

    this.attackHitbox = null;
    this.attackType = null;

    // Input buffer
    this.inputBuffer = null;
    this.bufferTimer = 0;

    // Super move
    // superCharge counts UP from 0 → SUPER_COOLDOWN; filled by pickups/combo only.
    this.SUPER_COOLDOWN = 100;
    this.superCharge   = 100; // start with full meter
    this.superActive = false;
    this.superTimer = 0;
    this.SUPER_COST = 25;
  }

  // Returns true if player is currently airborne (includes aerial attacks)
  get isAirborne() {
    return this.jumpY > 0;
  }

  update(input, enemies, hitEffects, scrollLocked) {
    // Snapshot prev positions for render interpolation (spec §28)
    this.prevX     = this.x;
    this.prevZ     = this.z;
    this.prevJumpY = this.jumpY;

    this.stateTimer++;
    this.animFrame += 0.15;
    if (this.hitFlash > 0) this.hitFlash--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.hurtCooldown > 0) this.hurtCooldown--;
    if (this.comboTimer > 0) this.comboTimer--;
    else this.comboCount = 0;
    // SP does NOT recharge automatically — no decrement here.

    // Respawn iframe countdown
    if (this.iframeTimer > 0) {
      this.iframeTimer--;
      // Flash every 4 frames: hitFlash is used by the renderer to switch to blank sprite.
      // Keep hitFlash cycling so renderer knows to flash.
      if (this.iframeTimer > 0) {
        this.hitFlash = (this.iframeTimer % 8 < 4) ? 2 : 0;
      }
    }

    // Buffer countdown
    if (this.bufferTimer > 0) this.bufferTimer--;
    else this.inputBuffer = null;

    if (this.state === 'down') {
      // Zero velocity so the player can't drift while knocked down
      this.vx = 0;
      this.vz = 0;
      // Cancel super if it was active when we got knocked down
      if (this.superActive) {
        this.superActive = false;
        this.superTimer  = 0;
      }
      if (this.stateTimer > 80) {
        this.state = 'idle';
        this.hp = Math.min(this.maxHp, this.hp + 20);
        this.hurtCooldown = 90;
      }
      return;
    }

    // Super active — spin and hit all nearby enemies
    // (runs only when NOT in down/dead; down is handled above)
    if (this.superActive) {
      this.superTimer--;
      this._superAttack(enemies, hitEffects);
      if (this.superTimer <= 0) {
        this.superActive = false;
        this.state = 'idle';
      }
    }

    // Jump physics — delegated to physics.js (applyGravity owns jumpY + vy integration).
    // Variable-height scaling: ascending + holding = floatier (0.55×), released = fast-hop (1.6×).
    if (this.jumpY > 0 || (this.state === 'jump' && this.vy > 0)) {
      const wasAirborne = this.jumpY > 0 || this.vy > 0;
      applyGravity(this, input.actionDown('jump'));

      if (wasAirborne && this.jumpY <= 0) {
        // ── Cleanup Phase (respawnEvent → activeGameplay) ─────────────────────
        // applyGravity already zeroed jumpY + vy on landing; we clean up the
        // rest of the respawn-era state so nothing bleeds into normal gameplay.
        if (this.respawning) {
          // Explicit cleanup: zero out all respawn-era velocity state.
          // The drop used vy = -6 with gravity each frame; ensure nothing
          // from that sequence leaks into activeGameplay physics.
          this.vy         = 0;   // belt-and-suspenders: kill any residual fast-fall
          this.vx         = 0;   // no horizontal carry-over from drop entry
          this.vz         = 0;
          this.respawning = false;
          // iframeTimer continues running — invincibility window stays active
        }

        cues.play('land');

        // Only reset to idle if not mid-attack; attack auto-clears above
        if (this.state === 'jump') this.state = 'idle';
      }
    }

    // Combat state — auto-clear after 16 frames
    if (this.state === 'punch' || this.state === 'kick') {
      if (this.stateTimer > 16) {
        this.state = this.isAirborne ? 'jump' : 'idle';
        this.attackHitbox = null;
        this.attackType = null;
        this._hitThisSwing = null; // clear per-swing dedup set when attack ends
      } else if (this.stateTimer >= 4 && this.stateTimer <= 12) {
        // Aerial attacks deal 1.25x damage (jump attack bonus)
        this._checkHits(enemies, hitEffects, this.isAirborne ? 1.25 : 1.0);
      }
    }

    if (this.state === 'hurt') {
      // Zero velocity — player shouldn't slide during stagger
      this.vx = 0;
      this.vz = 0;
      // Flush any buffered attack so it can't fire the instant hurt ends
      this.inputBuffer = null;
      this.bufferTimer = 0;
      if (this.stateTimer > 20) this.state = 'idle';
      return;
    }

    // ── INPUT BUFFERING (store only; fire deferred until after chord resolution) ──
    if (input.actionPressed('punch')) {
      this.inputBuffer = 'punch';
      this.bufferTimer = 8;
    }
    if (input.actionPressed('kick')) {
      this.inputBuffer = 'kick';
      this.bufferTimer = 8;
    }

    // canAction window computed here; buffer is fired after chords so chords
    // that include punch/kick can consume the buffer before it fires.
    const canAction = ['idle', 'walk', 'jump'].includes(this.state) ||
                      (['punch', 'kick'].includes(this.state) && this.stateTimer > 10);

    // Jump fires whenever jump is just-pressed and the player is not airborne.
    // Allowed from any state except down/dead — jump-cancels attacks freely.
    const canJump = !this.isAirborne &&
                    this.state !== 'down' &&
                    this.state !== 'dead';
    if (input.actionPressed('jump') && canJump) {
      this._startJump();
    }

    if (input.actionPressed('super') && !this.superActive) {
      // Always attempt super — cost is settled inside _startSuper.
      // Charge ready  → free (drain meter).
      // No charge     → blood super (costs 33% max HP; blocked only if it would kill).
      const chargeReady = this.superCharge >= this.SUPER_COOLDOWN;
      const hpCost      = Math.max(1, (this.maxHp * 0.33 + 0.5) | 0);
      // Allow blood super only when the player has more than 50 HP to spend.
      if (chargeReady || this.hp > 50) {
        this._startSuper(hitEffects, chargeReady);
      }
    }

    // ── DEFERRED BUFFER FIRE ──
    // Now that chords have had first chance to consume the buffer, fire any
    // remaining buffered attack (plain punch/kick, not part of a chord).
    if (canAction && this.inputBuffer) {
      this._startAttack(this.inputBuffer, hitEffects);
      this.inputBuffer = null;
      this.bufferTimer = 0;
    }

    // ── MOVEMENT ──
    // Render-space: higher Z = farther from camera (horizon, up on screen).
    // Up = toward horizon = +Z | Down = toward camera = -Z
    let mx = 0, mz = 0;
    if (input.actionDown('left'))  mx -= 1;
    if (input.actionDown('right')) mx += 1;
    if (input.actionDown('up'))    mz += 1;  // UP key = toward horizon = +Z (farther, up on screen)
    if (input.actionDown('down'))  mz -= 1;  // DOWN key = toward camera = -Z (closer, down on screen)

    const moving = (mx !== 0 || mz !== 0);

    if (moving) {
      // Diagonal normalisation: ||(1,1)|| = √2; divide to keep cardinal-equal speed.
      const diag = (mx !== 0 && mz !== 0);
      const len  = diag ? 1.4142135 : 1.0;
      // Air control: full speed in the air with a slight bonus (PHYS.AIR_CONTROL).
      const currentSpeed = this.isAirborne ? this.speed * PHYS.AIR_CONTROL : this.speed;

      // Overwrite velocity with current input direction (max air control — no momentum bleed).
      this.vx = (mx / len) * currentSpeed;
      this.vz = (mz / len) * currentSpeed;
      if (mx !== 0) this.facing = mx;
      if (!['punch', 'kick', 'super', 'jump', 'hurt', 'down'].includes(this.state)) this.state = 'walk';
    } else {
      // No directional input — let physics.js bleed off ground velocity (zero air friction).
      applyFriction(this);
      if (this.state === 'walk' && !this.isAirborne) this.state = 'idle';
    }

    this.x += this.vx;
    this.z = Math.max(LANE_MIN_Z, Math.min(LANE_MAX_Z, this.z + this.vz));
  }

  _startAttack(type, hitEffects) {
    // While in jump, transition to punch/kick but remember to return to jump
    this.state = type;
    this.stateTimer = 0;
    // Snappier cooldowns (was 28/22 → now 15/12)
    this.attackCooldown = type === 'kick' ? 15 : 12;
    this.attackType = type;
    cues.play(type); // 'punch' or 'kick'
    // Rebuild the manual attackHitbox so game.js prop-hit check still works
    // (em.checkPropHits reads p.attackHitbox directly, independent of calculateHit)
    const reach = type === 'kick' ? 55 : 45;
    this.attackHitbox = {
      x: this.x + this.facing * reach * 0.5,
      z: this.z,
      w: reach,
      d: 40,
      damage: type === 'kick' ? 18 : 12,
      knockback: type === 'kick' ? 80 : 40,
    };
    // Reset per-swing hit set so each new attack can register on fresh targets
    this._hitThisSwing = new Set();
  }

  _startJump() {
    this.state = 'jump';
    this.stateTimer = 0;
    this.vy = 5.5;
    this.jumpY = 0;
    cues.play('jump');
  }

  _startSuper(hitEffects, chargeReady) {
    if (chargeReady) {
      // Meter super — drain the bar, no HP cost.
      this.superCharge = 0;
    } else {
      // Blood super — costs 33% of max HP; also clear any partial charge.
      const hpCost = Math.max(1, (this.maxHp * 0.33 + 0.5) | 0);
      this.hp = Math.max(1, this.hp - hpCost);
      this.superCharge = 0;
    }
    this.hitFlash = 4;
    this.superActive  = true;
    this.superTimer   = 45;
    this.state        = 'super';
    this.stateTimer   = 0;
    this.attackCooldown = 0;
    // Clear any lingering hitbox so it doesn't register on the same frame
    this.attackHitbox = null;
    this.attackType   = null;
    // Clear input buffer so a queued punch/kick doesn't fire right after super ends
    this.inputBuffer  = null;
    this.bufferTimer  = 0;
  }

  _superAttack(enemies, hitEffects) {
    if (this.superTimer % 3 !== 0) return;
    const SUPER_RANGE_SQ = 80 * 80; // squared to avoid Math.sqrt (spec §41)
    for (const e of enemies) {
      if (e.state === 'dead') continue;
      const dx = e.x - this.x;
      const dz = e.z - this.z;
      if (dx*dx + dz*dz < SUPER_RANGE_SQ) {
        const dir = dx > 0 ? 1 : -1;
        e.takeDamage(8, dir, 60);
        hitEffects.push(new HitEffect(e.x, e.z, 'SUPER!'));
        this.score += 15;
      }
    }
  }

  _checkHits(enemies, hitEffects, dmgMult = 1.0) {
    // Only check for hits during the "active" frames of the animation
    if (this.stateTimer < 4 || this.stateTimer > 12) return;
    if (!this.attackType) return;

    // Ensure per-swing set exists (guard against state restored without _startAttack)
    if (!this._hitThisSwing) this._hitThisSwing = new Set();

    for (const e of enemies) {
      // Skip dead enemies, mercy-invincibility frames, or already-hit-this-swing targets
      if (e.state === 'dead' || e.hitFlash > 0) continue;
      if (this._hitThisSwing.has(e.id)) continue;

      // calculateHit derives the strike volume from ATTACK_DATA — no manual hitbox needed
      const result = calculateHit(this, e, this.attackType);
      if (!result) continue;

      const isCrit   = result.type === 'crit';
      const finalDmg = (result.damage * dmgMult) | 0;

      cues.playHitResult(result);

      // Route to the correct damage method:
      //   Enemy / Boss → takeDamage(dmg, fromDir, knockback)
      //   Prop / Destructible → hit(dmg)  [returns drop array, ignored here]
      if (typeof e.takeDamage === 'function') {
        e.takeDamage(finalDmg, this.facing, result.kb);
      } else if (typeof e.hit === 'function') {
        e.hit(finalDmg);
      }

      // Mark this target as hit so the same swing can't double-tap it
      this._hitThisSwing.add(e.id);

      this.comboCount++;
      this.comboTimer = 90;
      this.score += finalDmg * this.comboCount;
      // Each hit charges SP by a fixed amount (capped at max)
      this.superCharge = Math.min(this.SUPER_COOLDOWN, this.superCharge + 8);

      // Trigger visual feedback — crit flag determines which effect to spawn
      const effectType = isCrit ? 'crit_spark' : 'punch_impact';

      // Deterministic hit-effect jitter: LUT phase from comboCount — no Math.sin
      const jitterX = lutSin(this.comboCount * 43, 10);
      hitEffects.push(new HitEffect(e.x + jitterX, e.z, effectType));

      // One hit registered per active frame — break so we don't multi-hit
      // different enemies in a single frame (feels fairer and more readable).
      break;
    }
  }

  takeDamage(dmg) {
    // No damage while airborne
    if (this.isAirborne) return;
    if (this.hurtCooldown > 0) return;
    // No damage during active iframes (respawn invincibility)
    if (this.iframeTimer > 0) return;
    this.hp -= dmg;
    this.hitFlash = 8;
    this.hurtCooldown = 40;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'down';
      this.stateTimer = 0;
      if (this.lives > 0) {
        // Lives remain — fire respawn event; life is deducted inside _doRespawn
        window.dispatchEvent(new CustomEvent('respawnEvent', {
          detail: { score: this.score ?? 0 }
        }));
      } else {
        // Lives exhausted — fire the authoritative game-over event immediately.
        window.dispatchEvent(new CustomEvent('gameoverEvent', {
          detail: { score: this.score ?? 0 }
        }));
      }
    } else {
      this.state = 'hurt';
      this.stateTimer = 0;
    }
  }

  /** Called by Game when respawnEvent is received. */
  _doRespawn(spawnX, spawnZ, dropStartY) {
    // Deduct one life (check already passed in takeDamage)
    this.lives = Math.max(0, this.lives - 1);

    // Restore full health and special
    this.hp          = this.maxHp;
    this.superCharge = this.SUPER_COOLDOWN;

    // Position player at top of screen with drop-in velocity
    this.x          = spawnX;
    this.z          = spawnZ;
    this.prevX      = spawnX;
    this.prevZ      = spawnZ;
    this.jumpY      = dropStartY;   // visual height — will fall to 0 (gravity pulls down)
    this.prevJumpY  = dropStartY;
    this.vy         = -6.0;         // negative vy = falling; gravity makes it more negative each frame

    // Clear all combat state
    this.vx          = 0;
    this.vz          = 0;
    this.state       = 'jump';      // reuse jump state so gravity applies
    this.stateTimer  = 0;
    this.hitFlash    = 0;
    this.attackHitbox = null;
    this.attackType   = null;
    this.inputBuffer  = null;
    this.bufferTimer  = 0;
    this.superActive  = false;
    this.superTimer   = 0;
    this.hurtCooldown = 0;
    this.attackCooldown = 0;
    this.comboCount   = 0;
    this.comboTimer   = 0;

    // Respawn drop tracking
    this.respawning   = true;
    this.respawnTimer = this.RESPAWN_FALL_FRAMES;
    this.iframeTimer  = this.RESPAWN_IFRAME_FRAMES;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.hitFlash = 6;
  }
}

// Deterministic unique-ID counter — no Math.random() per engine rules.
let _entitySeq = 0;
function nextId(prefix) { return `${prefix}_${++_entitySeq}`; }

// Deterministic AI stagger: each enemy gets a different initial phase
// based on its sequence number so they don't all attack simultaneously.
function aiStagger(seq) { return (seq * 23) % 60; }

// ── Compact integer sin/cos LUT (256 entries, period 256 steps = 2π) ──────��──
// Values are in the range [-256, 256] (fixed-point with implicit /256 scale).
// Usage: SIN_LUT[phase & 255] / 256.0  (avoids Math.sin in hot AI loops)
const _LUT_SIZE = 256;
const SIN_LUT = new Int16Array(_LUT_SIZE);
const COS_LUT = new Int16Array(_LUT_SIZE);
for (let i = 0; i < _LUT_SIZE; i++) {
  const rad = (i / _LUT_SIZE) * Math.PI * 2;
  SIN_LUT[i] = Math.round(Math.sin(rad) * 256);
  COS_LUT[i] = Math.round(Math.cos(rad) * 256);
}
// Returns a value in [-scale, scale] deterministically from an integer phase
function lutSin(phase, scale = 1.0) { return (SIN_LUT[phase & 255] / 256) * scale; }
function lutCos(phase, scale = 1.0) { return (COS_LUT[phase & 255] / 256) * scale; }

// ---- Enemy AI ----
export class Enemy {
  constructor(x, z, variant = 0) {
    this.type = 'enemy';
    this.id = nextId('enemy');
    this.x = x;
    this.z = z;
    this.prevX = x;  // render interpolation — spec §28
    this.prevZ = z;
    this.vx = 0;
    this.vz = 0;
    this.w = 20;
    this.h = 32;
    this.variant = variant;
    this.facing = -1;

    const variants = [
      { hp: 40,  speed: 0.9, attackDmg: 8,  color: '#cc2200', name: 'GRUNT'  },
      { hp: 70,  speed: 1.2, attackDmg: 14, color: '#882200', name: 'THUG'   },
      { hp: 25,  speed: 1.6, attackDmg: 6,  color: '#cc6600', name: 'RUNNER' },
    ];
    const v = variants[variant % variants.length];
    this.hp = v.hp;
    this.maxHp = v.hp;
    this.speed = v.speed;
    this.attackDmg = v.attackDmg;
    this.color = v.color;
    this.name = v.name;

    this.state = 'idle';
    this.stateTimer = 0;
    this.animFrame = 0;
    this.hitFlash = 0;

    this.aiTimer = aiStagger(_entitySeq); // deterministic stagger — no Math.random()
    this.attackCooldown = 0;
    this.knockbackVx = 0;
    this.knockbackVz = 0;
  }

  update(player) {
    // Snapshot prev positions for render interpolation (spec §28)
    this.prevX = this.x;
    this.prevZ = this.z;

    this.stateTimer++;
    this.animFrame += 0.12;
    if (this.hitFlash > 0) this.hitFlash--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    this.aiTimer++;

    if (this.state === 'dead') return;

    this.knockbackVx *= 0.75;
    this.knockbackVz *= 0.75;

    if (this.state === 'stun') {
      if (this.stateTimer > 35) this.state = 'idle';
      this.x += this.knockbackVx;
      this.z += this.knockbackVz;
      this._clamp();
      return;
    }

    const dx = player.x - this.x;
    const dz = player.z - this.z;
    const distSq = dx*dx + dz*dz; // squared — avoids Math.sqrt for threshold checks
    const dist = distSq > 0 ? Math.sqrt(distSq) : 0; // only used for dx/dz normalisation
    this.facing = dx > 0 ? 1 : -1;

    if (this.state === 'attack') {
      if (this.stateTimer > 25) {
        this.state = 'idle';
        // Only deal damage if player is grounded (not airborne) — squared threshold: 55² = 3025
        if (distSq < 3025 && player.hurtCooldown === 0 && !player.isAirborne) {
          player.takeDamage(this.attackDmg);
        }
      }
      return;
    }

    if (distSq > 2025) { // 45² = 2025
      const len = dist || 1;
      // LUT-based jitter: integer phase derived from aiTimer (deterministic, no Math.sin)
      const jitter = lutSin(this.aiTimer * 7, 0.3); // 7 ≈ maps 0..255 over ~36 ticks
      this.vx = (dx / len + jitter) * this.speed;
      this.vz = (dz / len) * this.speed;
      this.state = 'walk';
    } else if (distSq < 2025 && this.attackCooldown === 0) { // 45² = 2025
      this.state = 'attack';
      this.stateTimer = 0;
      // Deterministic cooldown jitter: stagger each enemy differently via aiTimer parity
      this.attackCooldown = 60 + (this.aiTimer % 30);
      this.vx = 0; this.vz = 0;
    } else {
      if (this.aiTimer % 40 === 0) {
        // Deterministic idle wander using LUT — no Math.sin/cos
        this.vx = lutSin(this.aiTimer * 9, this.speed);
        this.vz = lutCos(this.aiTimer * 17, this.speed * 0.5);
      }
      this.state = 'idle';
    }

    this.x += this.vx + this.knockbackVx;
    this.z += this.vz + this.knockbackVz;
    this._clamp();
  }

  _clamp() {
    this.x = Math.max(-WORLD_WIDTH/2, Math.min(WORLD_WIDTH/2, this.x));
    this.z = Math.max(LANE_MIN_Z, Math.min(LANE_MAX_Z, this.z));
  }

  takeDamage(dmg, fromDir, knockback) {
    this.hp -= dmg;
    this.hitFlash = 10;
    this.knockbackVx = fromDir * knockback * 0.12;
    this.knockbackVz = knockback * 0.04;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
    } else {
      this.state = 'stun';
      this.stateTimer = 0;
    }
  }
}

// ---- Boss ----
export class Boss extends Enemy {
  constructor(x, z) {
    super(x, z, 0);
    this.type = 'boss';
    this.name = 'BOSS';
    this.w = 30;
    this.h = 48;
    this.hp = 300;
    this.maxHp = 300;
    this.speed = 0.8;
    this.attackDmg = 22;
    this.color = '#880088';
    this.phase = 1;
    this.chargeTimer = 0;
    this.chargeActive = false;
    this.chargeVx = 0;
  }

  update(player) {
    // Snapshot prev positions for render interpolation (spec §28)
    this.prevX = this.x;
    this.prevZ = this.z;

    this.stateTimer++;
    this.animFrame += 0.1;
    if (this.hitFlash > 0) this.hitFlash--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    this.aiTimer++;

    if (this.state === 'dead') return;

    if (this.hp < this.maxHp * 0.5) this.phase = 2;

    this.knockbackVx *= 0.85;
    this.knockbackVz *= 0.85;

    if (this.state === 'stun') {
      if (this.stateTimer > 20) this.state = 'idle';
      this.x += this.knockbackVx;
      this.z += this.knockbackVz;
      this._clamp();
      return;
    }

    const dx = player.x - this.x;
    const dz = player.z - this.z;
    const distSq = dx*dx + dz*dz; // squared for threshold comparisons — no Math.sqrt needed
    const dist = distSq > 0 ? Math.sqrt(distSq) : 0; // only used for vector normalisation
    this.facing = dx > 0 ? 1 : -1;

    const chargeInterval = this.phase === 2 ? 100 : 180;
    if (this.chargeActive) {
      this.x += this.chargeVx;
      this.z += this.knockbackVz;
      this._clamp();
      this.chargeTimer--;
      if (distSq < 3600 && player.hurtCooldown === 0 && !player.isAirborne) { // 60² = 3600
        player.takeDamage(this.attackDmg * 1.5 | 0);
        this.chargeActive = false;
      }
      if (this.chargeTimer <= 0) { this.chargeActive = false; this.state = 'idle'; }
      return;
    }

    if (this.state === 'attack') {
      if (this.stateTimer > 30) {
        this.state = 'idle';
        if (distSq < 4225 && player.hurtCooldown === 0 && !player.isAirborne) { // 65² = 4225
          player.takeDamage(this.attackDmg);
        }
      }
      return;
    }

    if (this.aiTimer % chargeInterval === 0 && distSq > 6400) { // 80² = 6400
      this.chargeActive = true;
      this.chargeTimer = 30;
      const len = dist || 1;
      const spd = this.phase === 2 ? 5 : 3.5;
      this.chargeVx = (dx / len) * spd;
      this.knockbackVz = (dz / len) * spd * 0.4;
      this.state = 'walk';
      return;
    }

    if (distSq > 3600) { // 60² = 3600
      const len = dist || 1;
      const spd = this.phase === 2 ? this.speed * 1.5 : this.speed;
      this.vx = (dx / len) * spd;
      this.vz = (dz / len) * spd;
      this.state = 'walk';
    } else if (this.attackCooldown === 0) {
      this.state = 'attack';
      this.stateTimer = 0;
      const cd = this.phase === 2 ? 45 : 70;
      this.attackCooldown = cd + (this.aiTimer % 20); // deterministic jitter
      this.vx = 0; this.vz = 0;
    } else {
      this.state = 'idle';
    }

    this.x += this.vx + this.knockbackVx;
    this.z += this.vz + this.knockbackVz;
    this._clamp();
  }

  takeDamage(dmg, fromDir, knockback) {
    super.takeDamage(dmg * 0.7 | 0, fromDir, knockback * 0.4);
  }
}

// ---- Food Item ----
export class FoodItem {
  constructor(x, z, kind = 'pizza') {
    this.type = 'food';
    this.id = nextId('food');
    this.x = x;
    this.z = z;
    this.prevX = x;  // render interpolation — spec §28
    this.prevZ = z;
    this.w = 16;
    this.h = 14;
    this.kind = kind;
    this.collected = false;
    // Deterministic bob offset: use x position as phase — avoids Math.random() / Math.PI
    // Period = _LUT_SIZE (256), timer increments as integer-scaled phase into SIN_LUT
    this.bobTimer = ((x * 5) | 0) % _LUT_SIZE; // integer phase, wraps cleanly

    const healAmounts = { pizza: 40, chicken: 25, apple: 15 };
    this.healAmount = healAmounts[kind] || 20;
    this.color = kind === 'pizza' ? '#ffaa00' : kind === 'chicken' ? '#ffdd88' : '#ff4444';
  }

  update() {
    // Advance by 1 LUT step every 3 frames (≈ 5Hz bob at 60fps) — integer, no FP drift
    this._bobAccum = ((this._bobAccum || 0) + 1) % 3;
    if (this._bobAccum === 0) this.bobTimer = (this.bobTimer + 1) & 255;
  }

  get visualZ() {
    // SIN_LUT values are in [-256, 256]; divide by 128 to get [-2, 2] offset
    return this.z + SIN_LUT[this.bobTimer] / 128;
  }
}

// ---- SP Charge Item ----
// Dropped by destroyed props. Restores super-move charge instead of HP.
export class SpItem {
  constructor(x, z) {
    this.type = 'spItem';
    this.id = nextId('sp');
    this.x = x;
    this.z = z;
    this.prevX = x;
    this.prevZ = z;
    this.w = 14;
    this.h = 14;
    this.collected = false;
    this.spAmount = 30;           // partial super bar refill
    this.bobTimer = ((x * 7) | 0) % _LUT_SIZE;
    this.color = '#00ddff';
  }

  update() {
    this._bobAccum = ((this._bobAccum || 0) + 1) % 3;
    if (this._bobAccum === 0) this.bobTimer = (this.bobTimer + 1) & 255;
  }

  get visualZ() {
    return this.z + SIN_LUT[this.bobTimer] / 128;
  }
}

// ---- Breakable Prop ----
// Crates / barrels / trash cans scattered across the level.
// Hit by player attacks; when broken they eject food or SP pickups.
//
// variant: 0 = crate (food), 1 = barrel (food), 2 = trash (SP)
export class Prop {
  constructor(x, z, variant = 0, rng) {
    this.type = 'prop';
    this.id = nextId('prop');
    this.x = x;
    this.z = z;
    this.prevX = x;
    this.prevZ = z;
    this.w = 18;
    this.h = 18;
    this.variant = variant;
    this.broken = false;
    this.breakTimer = 0;   // counts up after breaking (for debris anim)
    this.hitFlash = 0;

    // HP: crate=2 hits, barrel=3 hits, trash=1 hit
    const hpTable = [2, 3, 1];
    this.hp = hpTable[variant % hpTable.length];
    this.maxHp = this.hp;

    // Drop table: variant 2 (trash) drops SP; others drop food
    this.dropsSP = (variant === 2);
    const foodKinds = ['apple', 'chicken', 'pizza'];
    // Deterministic food kind from position
    this.foodKind = foodKinds[((x * 3 + z) | 0) % foodKinds.length];
  }

  update() {
    this.prevX = this.x;
    this.prevZ = this.z;
    if (this.hitFlash > 0) this.hitFlash--;
    if (this.broken) this.breakTimer++;
  }

  /** Called by player hit-check. Returns array of drop entities (food/SP) on break, else []. */
  hit(dmg) {
    if (this.broken) return [];
    this.hp -= dmg;
    this.hitFlash = 8;
    if (this.hp <= 0) {
      this.hp = 0;
      this.broken = true;
      this.breakTimer = 0;
      // Return drop(s)
      if (this.dropsSP) {
        return [new SpItem(this.x, this.z)];
      } else {
        return [new FoodItem(this.x, this.z, this.foodKind)];
      }
    }
    return [];
  }
}

// ---- Hit Effect ----
export class HitEffect {
  constructor(x, z, text = 'POW!') {
    this.type = 'hitEffect';
    this.id = nextId('fx');
    this.x = x;
    this.z = z;
    this.w = 30;
    this.h = 20;
    this.text = text;
    this.life = 22;
    this.maxLife = 22;
    this.animFrame = 0;
  }

  update() {
    this.life--;
    this.animFrame++;
    this.z += 0.4;  // float toward horizon (+z = up on screen in render-space)
    return this.life > 0;
  }
}
