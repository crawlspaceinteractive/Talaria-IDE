let nextId = 1;

const ENEMY_RADIUS = 0.125;
const BOSS_RADIUS  = 0.175;
const ABOM_RADIUS  = 0.25;

// How long (seconds) an enemy stays active after losing LOS.
// Keeps them from snap-freezing when the player ducks behind a corner.
const LOS_MEMORY_SECS = 5.0;

// Maximum distance (tiles) beyond which we don't even bother doing LOS.
// Enemies further than this are always dormant.
const LOS_MAX_DIST = 32;

// ─── Base Enemy ─────────────────────────────────────────────────────────────
export class Enemy {
  constructor(x, y, level, type = 'goblin') {
    this.id   = nextId++;
    this.x    = x;
    this.y    = y;
    this.type = type;
    this.alive = true;

    const stats = ENEMY_STATS[type] || ENEMY_STATS.goblin;
    this.health     = stats.baseHP  + level * stats.hpPerLevel;
    this.maxHealth  = this.health;
    this.speed      = stats.baseSpeed + level * stats.speedPerLevel;
    this.damage     = stats.damage + level * stats.damagePerLevel;
    this.detectRange= stats.detectRange;
    this.attackRange= stats.attackRange;
    this.attackCooldownBase = stats.attackCooldown;
    this.scoreValue = stats.scoreValue;
    this.goldValue  = stats.goldValue;

    this.state         = 'idle';
    this.angle         = Math.random() * Math.PI * 2;
    this.attackCooldown= 0;
    this.alertTimer    = 0;
    this.dist          = 0;
    this.screenX       = 0;
    this.deathTimer    = 0;
    this.pain          = 0;
    this.isBoss        = false;
    this.isAbomination = false;

    // LOS-gate: how many seconds of AI activity remain after last confirmed LOS.
    // 0 = dormant; positive = recently had sight of player.
    this.losMemory     = 0;
  }
}

// ─── Enemy stat templates ────────────────────────────────────────────────────
export const ENEMY_STATS = {
  goblin: {
    baseHP: 60, hpPerLevel: 20,
    baseSpeed: 1.2, speedPerLevel: 0.0,
    damage: 8, damagePerLevel: 2,
    detectRange: 8, attackRange: 1.0, attackCooldown: 1.2,
    scoreValue: 100, goldValue: 10,
  },
  bat: {
    baseHP: 20, hpPerLevel: 8,
    baseSpeed: 2.8, speedPerLevel: 0.0,
    damage: 5, damagePerLevel: 1,
    detectRange: 12, attackRange: 0.8, attackCooldown: 0.7,
    scoreValue: 50, goldValue: 5,
  },
  spider: {
    baseHP: 35, hpPerLevel: 12,
    baseSpeed: 1.8, speedPerLevel: 0.0,
    damage: 12, damagePerLevel: 3,
    detectRange: 7, attackRange: 0.9, attackCooldown: 1.0,
    scoreValue: 75, goldValue: 8,
  },
};

// ─── Troll Boss ──────────────────────────────────────────────────────────────
export class TrollBoss extends Enemy {
  constructor(x, y, depth) {
    super(x, y, depth, 'goblin');
    this.isBoss  = true;
    this.health  = 500 + depth * 300;
    this.maxHealth = this.health;
    this.speed   = 1.6 + depth * 0.0;
    this.damage  = 18 + depth * 3;
    this.radius  = BOSS_RADIUS;
    this.deathTimer = 12.0;
    this.chargeTimer   = 0;
    this.charging      = false;
    this.roarTimer     = 0;
    this.scoreValue    = 2000;
    this.goldValue     = 200;
  }
}

// ─── Abomination Boss (every 25 floors) ──────────────────────────────────────
export class Abomination extends Enemy {
  constructor(x, y, depth) {
    super(x, y, depth, 'goblin');
    this.isAbomination = true;
    this.isBoss   = true;
    this.health   = 3000 + depth * 500;
    this.maxHealth= this.health;
    this.speed    = 1.2 + depth * 0.0;
    this.damage   = 35 + depth * 5;
    this.radius   = ABOM_RADIUS;
    this.deathTimer = 18.0;
    this.chargeTimer   = 0;
    this.charging      = false;
    this.roarTimer     = 0;
    this.slamTimer     = 0;
    this.enraged       = false;
    this.scoreValue    = 10000;
    this.goldValue     = 800;
  }
}

// ─── Enemy Manager ───────────────────────────────────────────────────────────
export class EnemyManager {
  constructor(map, level, raycaster) {
    this.map       = map;
    this.level     = level;
    this.raycaster = raycaster || null;  // optional; enables LOS gate when provided
    this.list      = map.enemies.map(e => {
      if (e.isAbomination) return new Abomination(e.x, e.y, level);
      if (e.isBoss)        return new TrollBoss(e.x, e.y, level);
      return new Enemy(e.x, e.y, level, e.type || 'goblin');
    });
  }

  // ── Cylinder-swept wall collision ────────────────────────────────────────
  // Tests 5 probe points around the cylinder edge for wall penetration,
  // then attempts axis-decomposed sliding so enemies hug corners properly.
  _circleWall(cx, cy, r) {
    // 8 cardinal + diagonal probes around the circle
    const probes = [
      [cx + r, cy], [cx - r, cy],
      [cx, cy + r], [cx, cy - r],
      [cx + r * 0.707, cy + r * 0.707],
      [cx + r * 0.707, cy - r * 0.707],
      [cx - r * 0.707, cy + r * 0.707],
      [cx - r * 0.707, cy - r * 0.707],
    ];
    for (const [px, py] of probes) {
      if (this.map.isWall(px, py)) return true;
    }
    return false;
  }

  _moveWithCollision(enemy, dx, dy) {
    const r = enemy.isAbomination ? ABOM_RADIUS : (enemy.isBoss ? BOSS_RADIUS : ENEMY_RADIUS);

    // Try full move
    if (!this._circleWall(enemy.x + dx, enemy.y + dy, r)) {
      enemy.x += dx;
      enemy.y += dy;
      return;
    }
    // Try X only (slide along Y axis)
    if (dx !== 0 && !this._circleWall(enemy.x + dx, enemy.y, r)) {
      enemy.x += dx;
      return;
    }
    // Try Y only (slide along X axis)
    if (dy !== 0 && !this._circleWall(enemy.x, enemy.y + dy, r)) {
      enemy.y += dy;
    }
    // Fully blocked — no movement
  }

  _separateEnemies() {
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (!a.alive) continue;
      const ra = a.isAbomination ? ABOM_RADIUS : (a.isBoss ? BOSS_RADIUS : ENEMY_RADIUS);
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (!b.alive) continue;
        const rb = b.isAbomination ? ABOM_RADIUS : (b.isBoss ? BOSS_RADIUS : ENEMY_RADIUS);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        const minD = ra + rb;
        if (distSq < minD * minD && distSq > 0.0001) {
          const dist = Math.sqrt(distSq);
          const push = (minD - dist) / 2;
          const nx = (dx / dist) * push;
          const ny = (dy / dist) * push;
          // Push each entity back only if the destination is clear of walls
          if (!a.isBoss && !this._circleWall(a.x - nx, a.y - ny, ra)) { a.x -= nx; a.y -= ny; }
          if (!b.isBoss && !this._circleWall(b.x + nx, b.y + ny, rb)) { b.x += nx; b.y += ny; }
        }
      }
    }
  }

  // ── Cylinder vs player separation ────────────────────────────────────────
  // Call once per frame after enemies.update() to push living enemies away
  // from the player's cylinder and optionally push the player back.
  separateFromPlayer(player, PLAYER_RADIUS) {
    const pr = PLAYER_RADIUS || 0.25;
    for (const e of this.list) {
      if (!e.alive) continue;
      const er = e.isAbomination ? ABOM_RADIUS : (e.isBoss ? BOSS_RADIUS : ENEMY_RADIUS);
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const distSq = dx * dx + dy * dy;
      const minD = pr + er;
      if (distSq < minD * minD && distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        const overlap = minD - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        // Push enemy fully away; push player back only if enemy is a boss
        const enemyShare = e.isBoss ? 0.3 : 0.7;
        const playerShare = 1.0 - enemyShare;
        // Enemy push (wall-checked)
        const ex = nx * overlap * enemyShare;
        const ey = ny * overlap * enemyShare;
        if (!this._circleWall(e.x + ex, e.y + ey, er)) {
          e.x += ex; e.y += ey;
        } else if (!this._circleWall(e.x + ex, e.y, er)) {
          e.x += ex;
        } else if (!this._circleWall(e.x, e.y + ey, er)) {
          e.y += ey;
        }
        // Player push (wall-checked using simple margin)
        const ppx = player.x - nx * overlap * playerShare;
        const ppy = player.y - ny * overlap * playerShare;
        if (!this.map.isWall(ppx, ppy)) {
          player.x = ppx; player.y = ppy;
        } else if (!this.map.isWall(ppx, player.y)) {
          player.x = ppx;
        } else if (!this.map.isWall(player.x, ppy)) {
          player.y = ppy;
        }
      }
    }
  }

  // ── LOS helper ─────────────────────────────────────────────────────────────
  // Returns true if the enemy has (or recently had) a clear line of sight to
  // the player.  Uses the raycaster when available; falls back to distance-only.
  _checkLOS(e, px, py, dist) {
    // Always active when within melee/near range regardless of LOS
    if (dist < 2.5) return true;
    // Hard distance cutoff — skip expensive LOS cast for very far enemies
    if (dist > LOS_MAX_DIST) {
      e.losMemory = 0;
      return false;
    }

    let hasLOS = false;
    if (this.raycaster) {
      hasLOS = this.raycaster.hasLOS(px, py, e.x, e.y);
    } else {
      // No raycaster: treat any enemy within detect range as visible
      hasLOS = dist < (e.detectRange || 10);
    }

    if (hasLOS) {
      e.losMemory = LOS_MEMORY_SECS;  // refresh full memory on confirmed LOS
      return true;
    }
    // LOS blocked — still active if memory hasn't expired
    return e.losMemory > 0;
  }

  update(dt, player, state) {
    const px = player.x, py = player.y;
    const stealthMult = player.stealthMult || 1.0;

    for (const e of this.list) {
      if (!e.alive) {
        if (e.deathTimer > 0) e.deathTimer -= dt;
        continue;
      }

      const dx = px - e.x;
      const dy = py - e.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // ── LOS gate: skip all AI processing for enemies out of sight ──────────
      // Tick down memory timer every frame for this enemy
      if (e.losMemory > 0) e.losMemory -= dt;
      const active = this._checkLOS(e, px, py, dist);
      if (!active) {
        // Dormant: freeze enemy in idle, still tick cooldowns minimally
        e.state = 'idle';
        continue;
      }
      // ──────────────────────────────────────────────────���────────────────────

      e.attackCooldown -= dt;
      if (e.pain > 0) e.pain -= dt;

      if (e.isAbomination) {
        this._updateAbomination(e, dt, player, state, dx, dy, dist, stealthMult);
      } else if (e.isBoss) {
        this._updateBoss(e, dt, player, state, dx, dy, dist, stealthMult);
      } else if (e.type === 'bat') {
        this._updateBat(e, dt, player, state, dx, dy, dist, stealthMult);
      } else if (e.type === 'spider') {
        this._updateSpider(e, dt, player, state, dx, dy, dist, stealthMult);
      } else {
        this._updateGoblin(e, dt, player, state, dx, dy, dist, stealthMult);
      }
    }
    this._separateEnemies();
  }

  _updateGoblin(e, dt, player, state, dx, dy, dist, stealthMult) {
    const detectRange = e.detectRange * stealthMult;
    if (e.state === 'idle') {
      if (dist < detectRange) { e.state = 'chase'; e.alertTimer = 0.5; }
    } else {
      if (dist < e.attackRange) {
        e.state = 'attack';
        if (e.attackCooldown <= 0) {
          const dmg = e.damage + Math.random() * 7;
          player.health -= dmg;
          e.attackCooldown = e.attackCooldownBase + Math.random() * 0.5;
          state.damageFlashTimer = 0.3;
          document.getElementById('damage-flash').style.background = `rgba(255,0,0,0.5)`;
        }
      } else if (dist < detectRange * 1.5) {
        e.state = 'chase';
        if (e.pain <= 0) {
          const speed = e.speed * dt;
          this._moveWithCollision(e, (dx / dist) * speed, (dy / dist) * speed);
        }
      } else {
        e.state = 'idle';
      }
      e.angle = Math.atan2(dy, dx);
    }
  }

  _updateBat(e, dt, player, state, dx, dy, dist, stealthMult) {
    // Bats are fast and erratic — they zigzag toward the player
    const detectRange = e.detectRange * stealthMult;
    if (e.state === 'idle') {
      if (dist < detectRange) e.state = 'chase';
    } else {
      // Add a small oscillation to the movement direction for swooping feel
      const wobble = Math.sin(Date.now() * 0.006 + e.id * 0.7) * 0.4;
      const wobbleAngle = Math.atan2(dy, dx) + wobble;
      const speed = e.speed * dt;
      if (dist > e.attackRange) {
        e.state = 'chase';
        if (e.pain <= 0) {
          this._moveWithCollision(e,
            Math.cos(wobbleAngle) * speed,
            Math.sin(wobbleAngle) * speed);
        }
      } else {
        e.state = 'attack';
        if (e.attackCooldown <= 0) {
          const dmg = e.damage + Math.random() * 4;
          player.health -= dmg;
          e.attackCooldown = e.attackCooldownBase;
          state.damageFlashTimer = 0.2;
          document.getElementById('damage-flash').style.background = `rgba(255,0,0,0.35)`;
        }
      }
      e.angle = wobbleAngle;
    }
  }

  _updateSpider(e, dt, player, state, dx, dy, dist, stealthMult) {
    // Spiders: lurk, then rush in spurts
    const detectRange = e.detectRange * stealthMult;
    if (e.state === 'idle') {
      if (dist < detectRange) { e.state = 'chase'; e.alertTimer = 0.3; }
    } else {
      if (dist < e.attackRange) {
        e.state = 'attack';
        if (e.attackCooldown <= 0) {
          const dmg = e.damage + Math.random() * 6;
          player.health -= dmg;
          e.attackCooldown = e.attackCooldownBase;
          state.damageFlashTimer = 0.25;
          document.getElementById('damage-flash').style.background = `rgba(180,0,255,0.4)`;
        }
      } else if (dist < detectRange * 1.8) {
        e.state = 'chase';
        // Spiders do a burst-speed rush every ~2 seconds
        if (!e._rushTimer) e._rushTimer = 0;
        e._rushTimer -= dt;
        const rushing = e._rushTimer <= 0 && e._rushTimer > -0.5;
        if (e._rushTimer <= -0.5) e._rushTimer = 1.5 + Math.random() * 1.5;
        const speed = (rushing ? e.speed * 2.5 : e.speed * 0.5) * dt;
        if (e.pain <= 0) {
          this._moveWithCollision(e, (dx / dist) * speed, (dy / dist) * speed);
        }
      } else {
        e.state = 'idle';
      }
      e.angle = Math.atan2(dy, dx);
    }
  }

  _updateBoss(e, dt, player, state, dx, dy, dist, stealthMult) {
    if (e.state === 'idle' && dist < 12) {
      e.state = 'chase';
      e.roarTimer = 3.0;
      state.bossRoar = true;
    }
    if (e.state === 'idle') return;
    e.angle = Math.atan2(dy, dx);
    e.chargeTimer -= dt;
    if (e.chargeTimer <= 0 && dist < 6 && e.attackCooldown <= 0) {
      e.charging = true;
      e.chargeTimer = 4.0 + Math.random() * 2;
    }
    const speed = (e.charging ? e.speed * 2.8 : e.speed) * dt;
    if (dist > (e.charging ? 0.9 : 1.2)) {
      if (e.pain <= 0) this._moveWithCollision(e, (dx / dist) * speed, (dy / dist) * speed);
    }
    const hitRange = e.charging ? 1.4 : 1.0;
    if (dist < hitRange) {
      e.state = 'attack';
      if (e.attackCooldown <= 0) {
        const dmg = (e.charging ? 35 : e.damage) + Math.random() * 10;
        player.health -= dmg;
        e.attackCooldown = e.charging ? 1.8 : 1.0;
        e.charging = false;
        state.damageFlashTimer = 0.4;
        document.getElementById('damage-flash').style.background = `rgba(255,0,0,0.7)`;
        state.screenShake = 0.25;
      }
    } else {
      e.state = 'chase';
    }
    if (e.roarTimer > 0) e.roarTimer -= dt;
  }

  _updateAbomination(e, dt, player, state, dx, dy, dist, stealthMult) {
    if (e.state === 'idle' && dist < 16) {
      e.state = 'chase';
      e.roarTimer = 4.0;
      state.bossRoar = true;
      state.bossRoarType = 'abomination';
    }
    if (e.state === 'idle') return;
    e.angle = Math.atan2(dy, dx);

    // Enrage below 50% HP
    if (!e.enraged && e.health < e.maxHealth * 0.5) {
      e.enraged = true;
      state.bossRoar = true;
      state.bossRoarType = 'abomination_enrage';
    }

    const speedMult = e.enraged ? 1.6 : 1.0;
    e.chargeTimer -= dt;
    if (e.chargeTimer <= 0 && dist < 8 && e.attackCooldown <= 0) {
      e.charging = true;
      e.chargeTimer = 3.0 + Math.random() * 2;
    }
    const speed = (e.charging ? e.speed * 3.2 : e.speed * speedMult) * dt;
    if (dist > (e.charging ? 1.2 : 1.5)) {
      if (e.pain <= 0) this._moveWithCollision(e, (dx / dist) * speed, (dy / dist) * speed);
    }

    // Ground slam: wide area hit when very close
    e.slamTimer -= dt;
    if (e.slamTimer <= 0) {
      e.slamTimer = 5.0 + Math.random() * 3;
      if (dist < 2.5) {
        player.health -= e.damage * 1.5 + Math.random() * 20;
        state.damageFlashTimer = 0.6;
        document.getElementById('damage-flash').style.background = `rgba(180,0,0,0.85)`;
        state.screenShake = 0.5;
      }
    }

    const hitRange = e.charging ? 1.8 : 1.3;
    if (dist < hitRange) {
      e.state = 'attack';
      if (e.attackCooldown <= 0) {
        const dmg = e.damage + (e.enraged ? 15 : 0) + Math.random() * 15;
        player.health -= dmg;
        e.attackCooldown = e.charging ? 2.0 : 1.2;
        e.charging = false;
        state.damageFlashTimer = 0.5;
        document.getElementById('damage-flash').style.background = `rgba(180,0,0,0.8)`;
        state.screenShake = 0.35;
      }
    } else {
      e.state = 'chase';
    }
    if (e.roarTimer > 0) e.roarTimer -= dt;
  }

  applyDamage(target, amount) {
    if (!target || !target.alive) return false;
    target.health -= amount;
    target.pain = 0.05;
    if (target.health <= 0) {
      target.alive = false;
      target.deathTimer = target.isAbomination ? 20.0 : (target.isBoss ? 15.0 : 8.0);
      return true;
    }
    target.state = 'chase';
    return false;
  }

  allDead() {
    return this.list.every(e => !e.alive);
  }

  getVisible(player, raycaster) {
    const result = [];
    const ALIVE_MAX_SQ = 26 * 26;   // matches MAX_ENEMY_DIST in renderer
    const DEAD_MAX_SQ  = 16 * 16;   // dead corpses only visible close-up
    for (const e of this.list) {
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const distSq = dx * dx + dy * dy;
      // Quick distance pre-cull — renderer does frustum cull, this avoids sqrt on far enemies
      const maxSq = e.alive ? ALIVE_MAX_SQ : DEAD_MAX_SQ;
      if (distSq > maxSq) continue;
      e.dist = Math.sqrt(distSq);
      result.push(e);
    }
    result.sort((a, b) => b.dist - a.dist);
    return result;
  }
}
