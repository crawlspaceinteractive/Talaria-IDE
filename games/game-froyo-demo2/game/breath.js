/**
 * breath.js — Ice Breath beam system (Spec Section VII)
 *
 *   Fractional stepping (0.25 increments), no collision tunneling.
 *   On hit:
 *     - apply freeze/damage state to enemies
 *     - break sprinkle jars (crystals) and breakables (crates)
 *     - spawn particles via BREATH_SPREAD_LUT
 *
 *   v0.2.6 fixes:
 *     - FREEZE_RADIUS expanded to actually hit enemy billboards (~3 wu)
 *     - CRYSTAL_RADIUS / BREAKABLE_RADIUS expanded to match object sizes
 *     - Breakables (sprinkle jars) now properly broken by ice breath
 *     - Particles continue spawning PAST breakable hits (don't stop)
 */
import { BREATH_STEP_LUT, BREATH_SPREAD_DIR_LUT, sinDeg, cosDeg } from "../engine/luts.js";

export function createBreathSystem() {
  return {
    particles: [],
    active: false,
    cooldown: 0,
    rand: 0xC0FFEE01,
  };
}

function breathRand(breath) {
  breath.rand = (breath.rand * 1664525 + 1013904223) >>> 0;
  return breath.rand / 0x100000000;
}

const MAX_RANGE       = 6.0;
const FREEZE_RADIUS   = 3.5;   // match enemy billboard half-width ~2.8 + margin
const CRYSTAL_RADIUS  = 2.2;   // match crystal half-size ~1.76
const BREAKABLE_RADIUS= 2.6;   // match crate half-size ~2.24
// How far in front of the player to anchor the breath origin (the "muzzle").
const MUZZLE_OFFSET = 0.40;
// Slight upward bias so breath spawns at "face" height, not feet.
const MUZZLE_Y = 0.10;

export function fireBreath(breath, player, world, fireYaw) {
  if (breath.cooldown > 0) return;
  breath.active = true;
  breath.cooldown = 8; // frames before next allowed

  const yaw = fireYaw;
  const dirX = sinDeg(yaw);
  const dirZ = cosDeg(yaw);

  // Origin = player center, offset forward by MUZZLE_OFFSET and up by MUZZLE_Y.
  const ox = player.x + dirX * MUZZLE_OFFSET;
  const oy = player.y + MUZZLE_Y;
  const oz = player.z + dirZ * MUZZLE_OFFSET;

  // Track if we hit something that should stop the beam
  let beamStopped = false;

  for (let i = 1; i < BREATH_STEP_LUT.length; i++) {
    const d = BREATH_STEP_LUT[i];
    if (d > MAX_RANGE) break;
    const px = ox + dirX * d;
    const py = oy;
    const pz = oz + dirZ * d;

    if (!beamStopped) {
      // Crystals — broken by ice breath
      for (const c of world.crystals) {
        if (c.broken) continue;
        const dx = c.x - px, dy = c.y - py, dz = c.z - pz;
        if (dx * dx + dy * dy + dz * dz < CRYSTAL_RADIUS * CRYSTAL_RADIUS) {
          c.broken = true;
          c.shatterT = 24;
          beamStopped = true;
        }
      }

      // Breakable crates (sprinkle jars) — broken by ice breath
      if (world.breakables) {
        for (const b of world.breakables) {
          if (b.broken) continue;
          const dx = b.x - px, dy = b.y - py, dz = b.z - pz;
          if (dx * dx + dy * dy + dz * dz < BREAKABLE_RADIUS * BREAKABLE_RADIUS) {
            b.broken = true;
            b.shatterT = 24;
            beamStopped = true;
          }
        }
      }

      // Enemies — freeze on first hit, kill on second hit while frozen
      for (const e of world.enemies) {
        if (e.dead) continue;
        const dx = e.x - px, dy = e.y - py, dz = e.z - pz;
        // Use the enemy's own hit radius (boss has a larger one)
        const hitR = e.hitRadius ?? FREEZE_RADIUS;
        if (dx * dx + dy * dy + dz * dz < hitR * hitR) {
          if (e.frozen) {
            // Second hit while frozen: instant kill
            e.dead = true;
            e.frozen = false;
            e.deathT = 30; // shatter animation countdown
          } else {
            e.frozen = true;
            e.frozenT = e.boss ? 120 : 240; // boss thaws faster
          }
          beamStopped = true;
        }
      }
    }

    // Always spawn breath particles along the full path (visual beam)
    if ((i & 1) === 0) {
      for (let s = 0; s < BREATH_SPREAD_DIR_LUT.length; s += 2) {
        const ca = BREATH_SPREAD_DIR_LUT[s];
        const sa = BREATH_SPREAD_DIR_LUT[s + 1];
        const sx = dirX * ca - dirZ * sa;
        const sz = dirX * sa + dirZ * ca;
        breath.particles.push({
          x: px + (breathRand(breath) - 0.5) * 0.1,
          y: py + (breathRand(breath) - 0.5) * 0.1,
          z: pz + (breathRand(breath) - 0.5) * 0.1,
          vx: sx * 0.12,
          vy: (breathRand(breath) - 0.5) * 0.012,
          vz: sz * 0.12,
          life: 18 + (breathRand(breath) * 8) | 0,
          age: 0,
        });
      }
      // Stop emitting new steps once beam hit something solid
      if (beamStopped) break;
    }
  }
}

export function stepBreath(breath) {
  if (breath.cooldown > 0) breath.cooldown--;
  for (let i = breath.particles.length - 1; i >= 0; i--) {
    const p = breath.particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.z += p.vz;
    // Tiny downward drift so the cloud settles rather than launching upward.
    p.vy -= 0.0006;
    p.age++;
    if (p.age >= p.life) breath.particles.splice(i, 1);
  }
}

export function stepBreakables(world) {
  for (const c of world.crystals) {
    if (c.broken && c.shatterT > 0) c.shatterT--;
  }
  if (world.breakables) {
    for (const b of world.breakables) {
      if (b.broken && b.shatterT > 0) b.shatterT--;
    }
  }
  for (const e of world.enemies) {
    if (e.dead) {
      if (e.deathT > 0) e.deathT--;
      continue;
    }
    if (e.frozen) {
      e.frozenT--;
      if (e.frozenT <= 0) e.frozen = false;
    } else {
      // Idle bob
      e.bobPhase += 0.06;
    }
  }
}
