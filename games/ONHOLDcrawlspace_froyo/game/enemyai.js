/**
 * enemyai.js — Enemy AI: patrol, chase, and ranged projectile attack
 *
 * Enemy types:
 *   Regular enemy (boss:false) — player-scale, 2 HP, normal speed
 *   Boss enemy   (boss:true)  — 2× larger, 6 HP, slower but harder-hitting,
 *                               fires 2 projectiles at once, faster attack rate
 *
 * Enemy state machine:
 *   PATROL  → wanders on home island; turns at edges
 *   CHASE   → detects player within aggro radius; charges toward them
 *   ATTACK  → fires a slow homing projectile when in range
 *   STUNNED → brief freeze after player ice-breath hit; recovers
 *
 * HP system:
 *   Each freeze-thaw cycle reduces hp by 1.
 *   At hp: 0, the enemy dies and bursts.
 */

const AGGRO_RADIUS    = 60;
const CHASE_SPEED     = 0.06;
const BOSS_CHASE_SPEED= 0.035;  // boss is slower but menacing
const PATROL_SPEED    = 0.03;
const BOSS_PATROL_SPEED = 0.018;
const ATTACK_RANGE    = 28;
const BOSS_ATTACK_RANGE = 40;   // boss fires from further away
const ATTACK_COOLDOWN = 140;
const BOSS_ATTACK_COOLDOWN = 80; // boss fires more often
const PROJ_SPEED      = 0.12;
const BOSS_PROJ_SPEED = 0.09;   // boss shots slower but harder to dodge
const PROJ_LIFE       = 180;
const PROJ_HIT_RADIUS = 2.5;
const BOSS_PROJ_HIT_RADIUS = 4.0; // boss projectiles bigger
const PROJ_GRAVITY    = 0.004;
const STUN_FRAMES     = 90;
const BOB_SPEED       = 0.055;
const BOSS_BOB_SPEED  = 0.03;   // boss bobs slowly
const PATROL_TURN_CHANCE = 0.01;
const DEATH_FRAMES    = 45;     // boss death takes longer

export const projectiles = []; // global list, cleared on world reset

export function resetProjectiles() {
  projectiles.length = 0;
}

const enemyAIInstances = new WeakMap();

class EnemyAIBase {
  constructor(enemy) {
    this.e = enemy;
    this.e._attackCooldown = this.e._attackCooldown || 0;
  }

  get isBoss() {
    return !!this.e.boss;
  }

  get bobSpeed() {
    return this.isBoss ? BOSS_BOB_SPEED : BOB_SPEED;
  }

  get patrolSpeed() {
    return this.isBoss ? BOSS_PATROL_SPEED : PATROL_SPEED;
  }

  get chaseSpeed() {
    return this.isBoss ? BOSS_CHASE_SPEED : CHASE_SPEED;
  }

  get attackRange() {
    return this.isBoss ? BOSS_ATTACK_RANGE : ATTACK_RANGE;
  }

  get attackCooldown() {
    return this.isBoss ? BOSS_ATTACK_COOLDOWN : ATTACK_COOLDOWN;
  }

  get projSpeed() {
    return this.isBoss ? BOSS_PROJ_SPEED : PROJ_SPEED;
  }

  get fireHeight() {
    return this.isBoss ? 3.0 : 1.5;
  }

  step(player, platforms, frame, hud, flashFn) {
    const e = this.e;

    if (e.dead) {
      if (e.deathT > 0) e.deathT--;
      return;
    }

    e.bobPhase = (e.bobPhase + this.bobSpeed) % (Math.PI * 2);

    if (e.frozen) {
      this.stepFrozen(frame, hud, flashFn);
      return;
    }

    if (e._hurtT > 0) e._hurtT--;

    const dx = player.x - e.x;
    const dz = player.z - e.z;
    const dist2D = Math.sqrt(dx * dx + dz * dz);
    const dy = player.y - e.y;

    if (dist2D > AGGRO_RADIUS) {
      this.patrol(platforms);
    } else {
      this.chase(dx, dz, dist2D);
      if (dist2D < this.attackRange) {
        this.tryAttack(player, dist2D, dy, hud, flashFn);
      }
    }

    _groundEnemy(e, platforms);
  }

  stepFrozen() {
    const e = this.e;
    e.frozenT--;
    if (e.frozenT <= 0) {
      e.frozen = false;
      e.frozenT = 0;
      if (e.hp !== undefined) {
        e.hp--;
        if (e.hp <= 0) {
          e.dead = true;
          e.deathT = DEATH_FRAMES;
          return;
        }
      }
      e._hurtT = this.isBoss ? 30 : 18;
    }
  }

  patrol(platforms) {
    const e = this.e;
    if (!e._patrolAngle || Math.random() < PATROL_TURN_CHANCE) {
      e._patrolAngle = Math.random() * Math.PI * 2;
    }
    e.x += Math.sin(e._patrolAngle) * this.patrolSpeed;
    e.z += Math.cos(e._patrolAngle) * this.patrolSpeed;
    _clampToIsland(e, platforms);
  }

  chase(dx, dz, dist2D) {
    const e = this.e;
    if (dist2D > 0.5) {
      const nx = dx / dist2D;
      const nz = dz / dist2D;
      e.x += nx * this.chaseSpeed;
      e.z += nz * this.chaseSpeed;
      e._patrolAngle = Math.atan2(nx, nz);
    }
  }

  tryAttack(player, dist2D, dy, hud, flashFn) {
    const e = this.e;
    if (!e._attackCooldown) e._attackCooldown = Math.floor(Math.random() * this.attackCooldown);
    e._attackCooldown--;
    if (e._attackCooldown <= 0) {
      e._attackCooldown = this.attackCooldown;
      this.fireAttack(player, dist2D, dy, hud, flashFn);
    }
  }

  fireAttack(player, dist2D, dy) {
    _fireProjectile(this.e, player, dist2D, dy, this.projSpeed, 0);
  }
}

class RegularEnemyAI extends EnemyAIBase {
}

class BossEnemyAI extends EnemyAIBase {
  fireAttack(player, dist2D, dy) {
    _fireProjectile(this.e, player, dist2D, dy, this.projSpeed, -0.12);
    _fireProjectile(this.e, player, dist2D, dy, this.projSpeed,  0.00);
    _fireProjectile(this.e, player, dist2D, dy, this.projSpeed,  0.12);
  }
}

export class PyramidEnemyAI extends EnemyAIBase {
  constructor(enemy) {
    super(enemy);
    enemy.shape = "pyramid";
  }
}

function getEnemyAI(enemy) {
  let ai = enemyAIInstances.get(enemy);
  if (!ai) {
    ai = enemy.boss ? new BossEnemyAI(enemy) : new RegularEnemyAI(enemy);
    enemyAIInstances.set(enemy, ai);
  }
  return ai;
}

/**
 * stepEnemyAI — advance all enemies for one frame.
 */
export function stepEnemyAI(enemies, player, platforms, frame, hud, flashFn) {
  for (const e of enemies) {
    getEnemyAI(e).step(player, platforms, frame, hud, flashFn);
  }

  // Step projectiles
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const proj = projectiles[i];
    proj.x += proj.vx;
    proj.y += proj.vy;
    proj.z += proj.vz;
    proj.vy -= PROJ_GRAVITY;
    proj.life--;

    const pdx = player.x - proj.x;
    const pdy = player.y - proj.y;
    const pdz = player.z - proj.z;
    const hitR = proj.boss ? BOSS_PROJ_HIT_RADIUS : PROJ_HIT_RADIUS;
    if (Math.sqrt(pdx*pdx + pdy*pdy + pdz*pdz) < hitR) {
      if (player.hitT <= 0 && !(player.state & 0x80)) {
        player.hitT = 45;
        player.vy = 0.15;
        const norm = Math.sqrt(pdx*pdx + pdz*pdz) + 0.001;
        // Boss projectiles hit harder
        const knockback = proj.boss ? 0.20 : 0.12;
        player.vx -= (pdx / norm) * knockback;
        player.vz -= (pdz / norm) * knockback;
        flashFn(hud, proj.boss ? "BOSS HIT!" : "OUCH!", 40);
      }
      projectiles.splice(i, 1);
      continue;
    }

    if (proj.life <= 0) {
      projectiles.splice(i, 1);
    }
  }
}

function _fireProjectile(e, player, dist2D, dy, speed, sideOffset) {
  const dx = player.x - e.x;
  const dz = player.z - e.z;
  const dist3 = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.001;
  // Apply side offset for spread (perpendicular to direction)
  const nx = dx / dist3, nz = dz / dist3;
  const px = -nz, pz = nx; // perpendicular
  projectiles.push({
    x: e.x,
    y: e.y + (e.boss ? 3.0 : 1.5), // fire from face height
    z: e.z,
    vx: (dx / dist3) * speed + px * sideOffset,
    vy: (dy / dist3) * speed + 0.05,
    vz: (dz / dist3) * speed + pz * sideOffset,
    life: PROJ_LIFE,
    boss: !!e.boss,
  });
}

function _clampToIsland(e, platforms) {
  if (!e._homeIsland) {
    let best = null, bestD = Infinity;
    for (const p of platforms) {
      if (p.type !== "island" && p.type !== "island_block") continue;
      const dx = e.x - p.x, dz = e.z - p.z;
      const d = dx*dx + dz*dz;
      if (d < bestD) { bestD = d; best = p; }
    }
    e._homeIsland = best;
  }
  if (!e._homeIsland) return;
  const h = e._homeIsland;
  const margin = 2.0;
  if (e.x < h.x - h.sx + margin) { e.x = h.x - h.sx + margin; e._patrolAngle = null; }
  if (e.x > h.x + h.sx - margin) { e.x = h.x + h.sx - margin; e._patrolAngle = null; }
  if (e.z < h.z - h.sz + margin) { e.z = h.z - h.sz + margin; e._patrolAngle = null; }
  if (e.z > h.z + h.sz - margin) { e.z = h.z + h.sz - margin; e._patrolAngle = null; }
}

function _groundEnemy(e, platforms) {
  let bestY = e.y - 5;
  for (const p of platforms) {
    const dx = e.x - p.x;
    const dz = e.z - p.z;
    if (Math.abs(dx) > p.sx + 1 || Math.abs(dz) > p.sz + 1) continue;
    if (p.y <= e.y + 0.5 && p.y > bestY) {
      bestY = p.y;
    }
  }
  if (bestY > e.y - 5) {
    // Boss sits higher above platform to account for larger visual
    e.y = bestY + (e.boss ? 1.2 : 0.7) * 8;
  }
}
