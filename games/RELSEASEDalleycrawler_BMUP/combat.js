/**
 * combat.js — Volume-based collision and hit resolution.
 *
 * Limb hierarchy:
 *   Limb  (abstract blueprint)
 *   ├── Arm   — tighter Z depth, higher crit bonus, surgical lane-lock
 *   └── Leg   — wider Z sweep, lower crit bonus, forgiving lane alignment
 *
 * Attack definitions are Limb instances; calculateHit is data-driven and
 * requires no changes as new moves are added.
 */

// ── Limb base class ──────────────────────────────────────────────────────────
//
// reach      : half-extent of the hitbox along the attacker's facing axis (px)
// depth      : half-extent along the Z (lane) axis
// height     : full vertical window that counts as a hit (px)
// yOffset    : height of the strike centre above the floor (jumpY = 0)
// damage     : base HP removed on a normal hit
// knockback  : base impulse magnitude passed to takeDamage
//
// Default sweet-spot values are intentionally generous here; subclasses
// tighten or relax them to express the limb's physical character.
//
class Limb {
  constructor(reach, depth, height, yOffset, damage, knockback) {
    this.reach     = reach;
    this.depth     = depth;
    this.height    = height;
    this.yOffset   = yOffset;
    this.damage    = damage;
    this.knockback = knockback;

    // Overridden by Arm / Leg subclasses
    this.sweetReach = 10;   // px window at the tip that awards a crit
    this.sweetBonus = 1.5;  // damage × this on crit
  }
}

// ── Arm ──────────────────────────────────────────────────────────────────────
//
// An Arm extends from the shoulder/chest as a compact rectangular prism.
//
// Design intent — surgical accuracy:
//   · Smaller Z depth  → player must be more precisely aligned on the enemy's
//     lane to land a hit at all.
//   · Tight sweet-spot → the "tip" window is narrow but the bonus is big,
//     rewarding players who space their punches perfectly.
//
class Arm extends Limb {
  constructor(reach, depth, height, yOffset, damage, knockback) {
    super(reach, depth, height, yOffset, damage, knockback);
    this.sweetReach = 10;   // narrow tip window — precision rewarded
    this.sweetBonus = 2.0;  // high bonus — this is the "Nat 20" punch
  }
}

// ── Leg ──────────────────────────────────────────────────────────────────────
//
// A Leg sweeps a wider arc in the Z plane.
//
// Design intent — sweeping zone control:
//   · Larger Z depth  → can clip enemies even when not perfectly lane-aligned,
//     creating that satisfying "boot everything in range" feel.
//   · Wider sweet-spot → tip window is more forgiving spatially, but the bonus
//     is lower — the Leg is a bludgeon, not a scalpel.
//
class Leg extends Limb {
  constructor(reach, depth, height, yOffset, damage, knockback) {
    super(reach, depth, height, yOffset, damage, knockback);
    this.sweetReach = 14;   // wider tip window — sweep-friendly
    this.sweetBonus = 1.25; // modest bonus — power over precision
  }
}

// ── ATTACK_DATA ───────────────────────────────────────────────────────────────
//
// Single source of truth for all move definitions.
// Add new entries here — calculateHit requires zero changes.
//
//                reach  depth  height  yOffset  damage  knockback
//
// height must be >= yOffset so the vertical window actually covers the floor plane.
// yOffset centres the strike volume above the floor; height is the full vertical
// span of that volume.  With both entities grounded (jumpY = 0):
//   dy = |hbY - 0| = yOffset
//   pass condition: dy < height  →  yOffset < height
// So height must exceed yOffset.  We keep yOffset for the visual/feel intent
// and set height generously to swallow the full grounded contact zone.
export const ATTACK_DATA = {
  punch: new Arm(   45,    30,    60,     20,      12,      40),
  kick:  new Leg(   55,    40,    55,     18,      18,      80),
};

// ── calculateHit ─────────────────────────────────────────────────────────────
//
// Checks whether an attacker's strike volume intersects with a target.
//
// attacker : { x, z, jumpY, facing }   (player or any entity throwing the hit)
// target   : { x, z, jumpY?, w }       (enemy or any hittable entity)
// moveType : 'punch' | 'kick'          (key into ATTACK_DATA)
//
// Returns:
//   null                              — no intersection
//   { type: 'normal', damage, kb }   — standard hit
//   { type: 'crit',   damage, kb }   — sweet-spot tip hit
//
export function calculateHit(attacker, target, moveType) {
  const data = ATTACK_DATA[moveType];
  if (!data) return null;

  // Centre of the strike volume (hand / foot position)
  const hbX = attacker.x + attacker.facing * data.reach * 0.5;
  const hbZ = attacker.z;
  const hbY = (attacker.jumpY || 0) + data.yOffset;

  const dx = Math.abs(target.x - hbX);
  const dz = Math.abs(target.z - hbZ);
  const dy = Math.abs(hbY - (target.jumpY || 0));

  // ── 1. Sweet-spot check — very tip of the reach ──────────────────────────
  //
  // Arm  (punch): sweetReach 10 × depth threshold 30 % → tight lane lock.
  // Leg  (kick) : sweetReach 14 × depth threshold 40 % → wider sweep window.
  //
  // The depth threshold scales proportionally so each limb type uses its own
  // Z character even at the tip.
  //
  const sweetX    = attacker.x + attacker.facing * data.reach * 0.9;
  const distToTip = Math.abs(target.x - sweetX);

  // Arm has tighter Z at tip (30 %); Leg is more forgiving (40 %).
  // Derive threshold from the limb's own depth so subclass values propagate.
  const sweetDepthPct = data instanceof Leg ? 0.40 : 0.30;

  if (
    distToTip < data.sweetReach * 0.5 &&
    dz        < data.depth * sweetDepthPct &&
    dy        < data.height * 0.5
  ) {
    return {
      type:   'crit',
      damage: (data.damage   * data.sweetBonus) | 0,
      kb:      data.knockback * 1.5,
    };
  }

  // ── 2. Standard AABB volume check ────────────────────────────────────────
  //
  // target.w is treated as a square pushbox radius on both X and Z axes.
  //
  if (
    dx < (data.reach  + target.w) * 0.5 &&
    dz < (data.depth  + target.w) * 0.5 &&
    dy < data.height
  ) {
    return {
      type:   'normal',
      damage:  data.damage,
      kb:      data.knockback,
    };
  }

  return null;
}
