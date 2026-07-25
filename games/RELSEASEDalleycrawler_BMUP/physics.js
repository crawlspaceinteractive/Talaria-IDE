/**
 * physics.js — Discrete world constants and motion logic.
 * Inspired by Quake-style movement: high air control, zero air friction.
 *
 * Engine contract (spec §41):
 *  - No Math.random()
 *  - No floating-point gameplay math that bypasses fixed-timestep integration
 *  - Entities NEVER integrate themselves — physics module owns the "how"
 *  - Friction applied only on the ground (zero air friction = full air control)
 */

export const PHYS = {
  GRAVITY:         0.42,  // Base world gravity (subtracted from vy each tick)
  FLOOR_FRICTION:  0.82,  // Velocity retention on ground (1.0 = ice, 0.0 = glue)
  AIR_CONTROL:     1.1,   // Speed multiplier while airborne
  STOP_THRESHOLD:  0.1,   // Velocity magnitude at which we snap to zero
};

/**
 * applyFriction — bleeds off horizontal velocity when grounded.
 *
 * Only fires when jumpY <= 0 (entity is on the floor).
 * Airborne entities retain full momentum — zero air friction.
 *
 * @param {object} entity — must expose { jumpY, vx, vz }
 */
export function applyFriction(entity) {
  if (entity.jumpY <= 0) {
    entity.vx *= PHYS.FLOOR_FRICTION;
    entity.vz *= PHYS.FLOOR_FRICTION;

    if (Math.abs(entity.vx) < PHYS.STOP_THRESHOLD) entity.vx = 0;
    if (Math.abs(entity.vz) < PHYS.STOP_THRESHOLD) entity.vz = 0;
  }
}

/**
 * applyGravity — integrates vy and jumpY with variable-height jump scaling.
 *
 * Variable-height logic (Quake / Celeste style):
 *   Ascending + holding jump  → scale 0.55  (floatier, longer arc)
 *   Ascending + released jump → scale 1.6   (fast short-hop)
 *   Descending                → scale 1.0   (neutral fall)
 *
 * When jumpY reaches 0 the entity is snapped to the floor and vy is zeroed —
 * the caller (Player.update) then runs its own landing-cleanup phase.
 *
 * @param {object}  entity        — must expose { jumpY, vy }
 * @param {boolean} isHoldingJump — true while the jump button is still held
 */
export function applyGravity(entity, isHoldingJump) {
  if (entity.jumpY > 0 || entity.vy > 0) {
    entity.jumpY += entity.vy;

    // Variable gravity scale: only the ascending phase is affected.
    let scale = 1.0;
    if (entity.vy > 0) {
      scale = isHoldingJump ? 0.55 : 1.6;
    }

    entity.vy -= PHYS.GRAVITY * scale;

    // Floor landing
    if (entity.jumpY <= 0) {
      entity.jumpY = 0;
      entity.vy    = 0;
    }
  }
}
