/**
 * levelFactory.js — Pure data builders, no runtime state.
 *
 * Exports:
 *   makePrng(seed)         → deterministic LCG RNG
 *   buildLevel(levelIdx)   → { encounters, props, totalLength }
 *
 * Encounter shape:
 *   { triggerX, isBoss, enemies: [{variant, offsetX, offsetZ}] }
 *
 * Props shape (scattered breakables independent of encounters):
 *   { x, z, variant }   variant: 0=crate, 1=barrel, 2=trash(SP)
 *
 * No Math.random(). No side-effects. Safe to call at any time for debug injection.
 */

// ── Deterministic seeded RNG (Xorshift32) ──────────────────────────────────
export function makePrng(seed) {
  let s = (seed ^ 0xdeadbeef) >>> 0;
  return function nextInt(n) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s = s >>> 0;
    return s % n;
  };
}

// ── Encounter spacing constants ─────────────────────────────────────────────
const ENCOUNTER_SPACING = 500;

// Predefined Z offsets to keep enemies visually separated without randomness
const Z_OFFSETS  = [0, -40, 40, -20, 20, -60, 60];
// Predefined X offsets: alternating sides, staggered distances
const X_OFFSETS  = [160, -120, 200, -180, 140, -160, 220];

// ── Prop placement constants ─────────────────────────────────────────────────
// Lane Z range: LANE_MIN_Z=120..LANE_MAX_Z=480 (from entities.js)
// We keep props away from extremes so they render inside the visible floor band.
const LANE_MIN_Z = 120;
const LANE_MAX_Z = 480;

// ── buildLevel ──────────────────────────────────────────────────────────────
export function buildLevel(levelIdx) {
  const rng = makePrng(levelIdx * 0x9e3779b9 + 1);

  const encounterCount = 5 + Math.min(10, levelIdx * 2 + rng(4));
  const encounters = [];
  let x = 600; // first encounter starts 600 world units from start

  for (let i = 0; i < encounterCount; i++) {
    const isBoss = (i === encounterCount - 1);
    const enemyCount = isBoss ? 1 : Math.min(6, 2 + levelIdx + rng(3));
    const enemies = [];

    if (isBoss) {
      // Boss always spawns right-of-centre, always on-screen when triggered
      enemies.push({ variant: 'boss', offsetX: 200, offsetZ: 0 });
    } else {
      for (let j = 0; j < enemyCount; j++) {
        const variantRange = Math.min(3, 1 + levelIdx);
        const variant = rng(variantRange);
        enemies.push({
          variant,
          offsetX: X_OFFSETS[j % X_OFFSETS.length],
          offsetZ: Z_OFFSETS[j % Z_OFFSETS.length],
        });
      }
    }

    encounters.push({ triggerX: x, isBoss, enemies });
    x += ENCOUNTER_SPACING;
  }

  const totalLength = x + 400;

  // ── Scatter breakable props across the full level ────────────────────────
  // Props are placed independently of encounters — they populate the streets
  // between fights and inside fight arenas alike.
  //
  // Density: roughly 1 prop per 80 world units; props cluster in groups of
  // 2-4 to feel like natural street clutter.
  //
  // variant distribution: 40% crate, 35% barrel, 25% trash (SP drop)
  const props = [];
  const propRng = makePrng(levelIdx * 0x1337beef + 2);

  // Place clusters from x=100 (near start) to totalLength-200 (before end)
  // Props must not exceed this world X — leave a clear runway before the level end.
  const PROP_X_MAX = totalLength - 200;

  let px = 100 + propRng(60);
  while (px < PROP_X_MAX) {
    const clusterSize = 1 + propRng(2); // 1-2 props per cluster (~15% of prior density)
    for (let k = 0; k < clusterSize; k++) {
      const propX = px + k * (20 + propRng(30));
      // Clamp each cluster member so it can't overshoot the safe zone,
      // even when the cluster stride pushes it past the origin bound.
      if (propX >= PROP_X_MAX) break;

      // Z: spread across the lane with a bias toward the middle
      const midZ  = (LANE_MIN_Z + LANE_MAX_Z) * 0.5;
      const spread = (LANE_MAX_Z - LANE_MIN_Z) * 0.35;
      const rawZ  = midZ + Z_OFFSETS[(propRng(Z_OFFSETS.length))] * (spread / 60);
      const propZ = Math.max(LANE_MIN_Z + 20, Math.min(LANE_MAX_Z - 20, rawZ | 0));

      // Variant: 0=crate, 1=barrel, 2=trash
      const roll = propRng(100);
      const variant = roll < 40 ? 0 : roll < 75 ? 1 : 2;

      props.push({ x: propX | 0, z: propZ, variant });
    }
    px += 400 + propRng(200); // wide gap between clusters — keeps total ~15% of prior count
  }

  return { encounters, props, totalLength };
}
