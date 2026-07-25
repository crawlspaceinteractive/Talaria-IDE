/**
 * state.js — Bitwise + Discrete state resolution (Spec Section III/IV/V)
 *
 *   inputMask + groundedness → playerState (bitwise) → discrete movementMode/jumpMode
 *
 * Per spec rules:
 *   STATE_DEAD overrides all systems
 *   STATE_FROZEN blocks updates
 *   STATE_HIT modifies damping only
 *   STATE_GLIDE overrides vertical clamp
 *   STATE_CHARGE applies last in velocity stack
 */
import { BTN_FLAGS } from "./input.js";
import { MOVE, JUMPM } from "./luts.js";

export const STATE = {
  NONE:        0b00000000,
  WALK:        0b00000001,
  CHARGE:      0b00000010,
  JUMP:        0b00000100,
  DOUBLE_JUMP: 0b00001000,
  GLIDE:       0b00010000,
  HIT:         0b00100000,
  FROZEN:      0b01000000,
  DEAD:        0b10000000,
};

/**
 * Update the player's bitwise state flags from input + grounded info.
 * Uses jumpTokens (2 = full, 1 = first spent, 0 = both spent) instead of
 * the old canDoubleJump / hasDoubleJumped boolean pair.
 * Mutates and returns `prevPlayerState`.
 */
export function resolveBitwise(prev, ctx) {
  const { input, grounded, justLanded, axisX, axisY, jumpTokens, glideArmed } = ctx;
  let s = prev;

  // Lock once dead — nothing changes the state until an external respawn.
  if (s & STATE.DEAD) return s;

  // FROZEN blocks updates entirely
  if (s & STATE.FROZEN) return s;

  // HIT recovers after a few frames; handled in physics layer (decremented timer there)
  // For pure resolution we just leave it.

  // Walking flag — true when stick is deflected and grounded.
  const moving = Math.abs(axisX) > 0.05 || Math.abs(axisY) > 0.05;
  if (grounded && moving) s |= STATE.WALK;
  else s &= ~STATE.WALK;

  // CHARGE — held while RT is down AND grounded (or just started). Spec: applies last.
  if (input.isDown(BTN_FLAGS.RT) && grounded) s |= STATE.CHARGE;
  else s &= ~STATE.CHARGE;

  // JUMP / DOUBLE_JUMP — driven by jump tokens.
  //   jumpTokens 2 → first jump available (grounded or just spawned)
  //   jumpTokens 1 → first jump spent, double-jump still available
  //   jumpTokens 0 → both spent, glide phase
  if (input.justPressed(BTN_FLAGS.A)) {
    if (grounded) {
      // Token 2→1: ground jump
      s |= STATE.JUMP;
      s &= ~STATE.DOUBLE_JUMP;
      s &= ~STATE.GLIDE;
    } else if (jumpTokens === 1) {
      // Token 1→0: double jump in air
      s &= ~STATE.JUMP;
      s |= STATE.DOUBLE_JUMP;
      s &= ~STATE.GLIDE;
    }
    // jumpTokens === 0: both spent, pressing A does nothing for jumping
  }
  if (justLanded) {
    s &= ~STATE.JUMP;
    s &= ~STATE.DOUBLE_JUMP;
    s &= ~STATE.GLIDE;
  }

  // GLIDE — activates after both tokens are spent (jumpTokens === 0) ONLY if
  // the jump button was held at any point during the post-double-jump fall.
  // glideArmed is tracked in game.js and passed in via ctx.
  if (!grounded && jumpTokens === 0 && glideArmed) {
    s |= STATE.GLIDE;
  } else if (grounded) {
    s &= ~STATE.GLIDE;
  }

  return s;
}

/**
 * Resolve discrete movementMode + jumpMode from bitwise + grounded.
 * Returns { movementMode, jumpMode }.
 */
export function resolveDiscrete(playerState, grounded) {
  let movementMode;
  let jumpMode;

  // Movement mode — priority order per spec
  if (playerState & STATE.DEAD) {
    movementMode = MOVE.IDLE;
  } else if (playerState & STATE.GLIDE) {
    movementMode = MOVE.GLIDE;
  } else if (playerState & STATE.CHARGE) {
    movementMode = MOVE.CHARGE;
  } else if (playerState & (STATE.JUMP | STATE.DOUBLE_JUMP)) {
    movementMode = MOVE.AIRBORNE;
  } else if (playerState & STATE.WALK) {
    movementMode = MOVE.WALK;
  } else {
    movementMode = MOVE.IDLE;
  }

  // Jump mode
  if (!grounded) {
    if (playerState & STATE.DOUBLE_JUMP) jumpMode = JUMPM.DOUBLE_JUMP;
    else if (playerState & STATE.JUMP) jumpMode = JUMPM.JUMPING;
    else jumpMode = JUMPM.FALLING;
  } else {
    jumpMode = JUMPM.GROUNDED;
  }

  return { movementMode, jumpMode };
}
