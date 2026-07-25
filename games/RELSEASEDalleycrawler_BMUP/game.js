/**
 * game.js — Thin orchestrator.
 *
 * Top-level phase FSM:
 *   menu      → MainMenu shown; no simulation running
 *   playing   → Normal gameplay (EncounterManager active)
 *   levelEnd  → "Level X Clear!" screen, wait for confirm
 *   gameOver  → DeathMenu overlay
 *   victory   → Victory screen, wait for confirm → menu
 *
 * Responsibilities retained here:
 *   - Phase FSM
 *   - Camera smoothing + interpolation
 *   - Render pass (entities → renderer)
 *   - HUD updates
 *   - Overlay rendering (GO!!, boss bar, combos, end-screens)
 *   - Pause menu integration
 *   - MainMenu integration
 *
 * Responsibilities delegated:
 *   - Level data build    → levelFactory.js
 *   - Enemy/food spawn    → EncounterManager
 *   - Encounter FSM       → EncounterManager
 *   - Scroll-lock state   → EncounterManager
 */

import { Player, HitEffect, InputHandler, WORLD_WIDTH, LANE_MIN_Z, LANE_MAX_Z } from './entities.js';
import { Renderer } from './renderer.js';
import { PauseMenu, Bindings } from './pause.js';
import { buildLevel } from './levelFactory.js';
import { EncounterManager } from './encounterManager.js';
import { DeathMenu } from './deathMenu.js';
import { MainMenu } from './menu.js';

// ── Camera constants ────────────────────────────────────────────────────────
const CAM_SMOOTH    = 0.08;
const CAM_LOOKAHEAD = 4;

export class Game {
  constructor(canvas) {
    this.canvas   = canvas;
    this.renderer = new Renderer(canvas);
    this.bindings = new Bindings();
    this.input    = new InputHandler(this.bindings);
    this.pause    = new PauseMenu(this.bindings);

    this.levelIdx   = 0;
    this.frameCount = 0;

    // Top-level phase: 'menu' | 'playing' | 'levelEnd' | 'gameOver' | 'victory'
    this.phase      = 'menu';
    this.phaseTimer = 0;

    this.player     = null;
    this.hitEffects = [];

    // Camera
    this.cameraX     = 0;
    this.prevCameraX = 0;
    this.targetCamX  = 0;
    this.skyScrollX  = 0;

    // HUD elements
    this.hudLeft  = document.getElementById('hud-left');
    this.hudRight = document.getElementById('hud-right');

    // ── Main Menu ──────────────────────────────────────────────────────────
    this.mainMenu = new MainMenu(canvas, this.renderer.ctx);

    this.mainMenu.onStart = () => {
      this._startGame();
    };

    this.mainMenu.onOptions = () => {
      // Open the configure-controls sub-screen of PauseMenu directly.
      // We re-use PauseMenu infrastructure: mark it active and jump to 'controls'.
      this.pause.active  = true;
      this.pause.screen  = 'controls';
      this.pause.ctrlCursor = 0;
      this.pause.listening  = false;
      // Temporarily store that we entered from the main menu so ESC returns there.
      this._pauseFromMenu = true;
      this.mainMenu.close();
    };

    this.mainMenu.open();

    // ── Pause keyboard hook ────────────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
      // Pause not available on menu or terminal phases
      if (this.phase === 'menu') return;
      if ((e.code === 'Escape' || e.code === 'KeyP') && !this.pause.active) {
        const blockPhases = ['levelEnd', 'gameOver', 'victory'];
        if (!blockPhases.includes(this.phase)) {
          this.pause.open();
          e.preventDefault();
          return;
        }
      }
      if (this.pause.active) {
        this.pause.handleKey(e, true);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (this.pause.active) this.pause.handleKey(e, false);
    });

    // ── EncounterManager (initialised but not started until _startGame) ────
    this.em = new EncounterManager();

    // ── Death menu ─────────────────────────────────────────────────────────
    this.deathMenu = new DeathMenu(canvas, this.renderer.ctx);

    this.deathMenu.onNewRun = () => {
      this._startGame();
    };

    this.deathMenu.onMainMenu = () => {
      this._goToMenu();
    };

    // ── Global events ──────────────────────────────────────────────────────

    this._onGameover = () => {
      if (this.phase === 'gameOver' || this.phase === 'victory') return;
      this.phase      = 'gameOver';
      this.phaseTimer = 0;
      if (this.em) this.em.isLocked = false;
    };
    window.addEventListener('gameoverEvent', this._onGameover);

    this._onRespawn = () => {
      if (!this.player) return;
      const p = this.player;
      const spawnX    = this.cameraX;
      const spawnZ    = 300;
      const dropStart = 200;
      p._doRespawn(spawnX, spawnZ, dropStart);
    };
    window.addEventListener('respawnEvent', this._onRespawn);
  }

  // ── Start / restart a full game run ────────────────────────────────────────

  _startGame() {
    this.mainMenu.close();
    if (this.deathMenu.active) this.deathMenu.close();
    this.pause.active    = false;
    this._pauseFromMenu  = false;
    this.player          = null;
    this.levelIdx        = 0;
    this._initLevel(0);
    this.phase           = 'playing';
    this.input.flush();
  }

  // ── Return to main menu ─────────────────────────────────────────────────────

  _goToMenu() {
    if (this.deathMenu.active) this.deathMenu.close();
    this.pause.active   = false;
    this._pauseFromMenu = false;
    this.player         = null;
    this.hitEffects     = [];
    this.phase          = 'menu';
    this.phaseTimer     = 0;
    this._clearHUD();
    this.mainMenu.open();
    this.input.flush();
  }

  // ── Level init ──────────────────────────────────────────────────────────────

  _initLevel(levelIdx) {
    if (this.deathMenu && this.deathMenu.active) this.deathMenu.close();

    const levelData = buildLevel(levelIdx);

    if (!this.player) {
      this.player = new Player(0, 300);
    } else {
      this.player.x  = 0;
      this.player.z  = 300;
      this.player.vx = 0;
      this.player.vz = 0;
    }

    this.hitEffects  = [];
    this.cameraX     = 0;
    this.prevCameraX = 0;
    this.targetCamX  = 0;
    this.skyScrollX  = 0;
    this.phase       = 'playing';
    this.phaseTimer  = 0;

    this.level = levelData;
    this.em.reset(levelData, this.player.x);
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  update() {
    this.frameCount++;
    this.phaseTimer = Math.max(0, this.phaseTimer - 1);

    // ── Menu phase ──────────────────────────────────────────────────────────
    if (this.phase === 'menu') {
      // If pause controls screen was opened from menu, let it run
      if (this.pause.active) {
        this.pause.tickGamepad(this.input);
        // ESC / back from controls → re-open menu
        if (!this.pause.active || (this.pause.screen === 'main' && this._pauseFromMenu)) {
          this.pause.active   = false;
          this._pauseFromMenu = false;
          this.mainMenu.open();
        }
        this.input.flush();
        return;
      }
      this.mainMenu.update(this.input);
      this.input.flush();
      return;
    }

    // ── Pause (during gameplay) ─────────────────────────────────────────────
    if (!this.pause.active && this.input.actionPressed('pause')) {
      const blockPhases = ['levelEnd', 'gameOver', 'victory'];
      if (!blockPhases.includes(this.phase)) {
        this.pause.open();
      }
    }

    if (this.pause.active) {
      this.pause.tickGamepad(this.input);

      if (this.pause.wantsQuit) {
        // "QUIT TO TITLE" from in-game pause → back to main menu
        this._goToMenu();
        return;
      }

      this.input.flush();
      return;
    }

    // ── Death menu ──────────────────────────────────────────────────────────
    if (this.deathMenu.active) {
      this.deathMenu.update();
      this.input.flush();
      return;
    }

    // ── Branch on top-level phase ───────────────────────────────────────────
    if (this.phase === 'playing') {
      this._updatePlaying();
    } else if (this.phase === 'levelEnd') {
      if (this.phaseTimer <= 0 && this.input.actionPressed('confirm')) {
        this.levelIdx++;
        this._initLevel(this.levelIdx);
        this.input.flush();
        return;
      }
    } else if (this.phase === 'gameOver') {
      if (this.phaseTimer <= 0 && !this.deathMenu.active) {
        this.deathMenu.open(this.player ? this.player.score : 0);
        this.input.flush();
        return;
      }
    } else if (this.phase === 'victory') {
      if (this.phaseTimer <= 0 && this.input.actionPressed('confirm')) {
        this._goToMenu();
        return;
      }
    }

    this._updateHUD();
    this.input.flush();
  }

  // ── Playing update ──────────────────────────────────────────────────────────

  _updatePlaying() {
    const p  = this.player;
    const em = this.em;

    const worldLeft = this.cameraX - (this.renderer.W / 2) + 20;

    p.update(this.input, em.activeEnemies.slice(), this.hitEffects, em.isLocked);

    if (p.attackHitbox) {
      em.checkPropHits(p.attackHitbox, p.attackHitbox.damage, this.hitEffects);
    }

    p.x = Math.max(worldLeft, p.x);
    if (em.isLocked) p.x = Math.min(em.scrollRightLimit, p.x);

    const emResult = em.update(
      p.x,
      this.cameraX,
      this.renderer.W,
      this.hitEffects,
      p,
    );

    if (emResult.waveClearScore > 0) {
      p.score += emResult.waveClearScore;
    }

    this._reactToEncounterStatus(p, emResult);

    this.hitEffects = this.hitEffects.filter(fx => fx.update());

    // Game over fallback check
    if (
      this.phase !== 'gameOver' &&
      p.hp <= 0 && p.lives === 0 &&
      p.state === 'down' && p.stateTimer > 80
    ) {
      this.phase      = 'gameOver';
      this.phaseTimer = 0;
      em.isLocked = false;
    }

    this._updateCamera(p);
  }

  _reactToEncounterStatus(p, emResult) {
    const em = this.em;

    switch (em.status) {
      case 'bossIntro':
      case 'goPrompt':
      case 'completed':
        break;

      case 'encCleared':
        if (emResult.bossJustCleared) {
          if (this.levelIdx >= 2) {
            this.phase      = 'victory';
            this.phaseTimer = 120;
          } else {
            this.phase      = 'levelEnd';
            this.phaseTimer = 120;
          }
        }
        em.acknowledgeEncCleared();
        break;

      default:
        break;
    }
  }

  _updateCamera(p) {
    const em = this.em;

    this.prevCameraX = this.cameraX;

    if (em.isLocked && (em.status === 'active' || em.status === 'bossIntro')) {
      this.targetCamX = this.cameraX;
      this.skyScrollX += p.vx * 0.15;
      return;
    }

    if (em.status === 'goPrompt') {
      const maxCam = em.scrollLockX + 80;
      const rawTarget = p.x + p.vx * CAM_LOOKAHEAD;
      this.targetCamX = Math.min(maxCam, Math.max(this.cameraX, rawTarget));
      this.targetCamX = Math.max(0, this.targetCamX);
      this.cameraX   += (this.targetCamX - this.cameraX) * CAM_SMOOTH;
      this.skyScrollX += p.vx * 0.15;
      return;
    }

    const rawTarget = p.x + p.vx * CAM_LOOKAHEAD;
    this.targetCamX = Math.max(0, rawTarget);
    this.cameraX   += (this.targetCamX - this.cameraX) * CAM_SMOOTH;
    this.skyScrollX += p.vx * 0.15;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  render(alpha = 1) {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

    // ── Menu phase: render menu over a black canvas ─────────────────────────
    if (this.phase === 'menu') {
      // Clear to black (menu draws its own backdrop)
      const ctx = this.renderer.ctx;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.renderer.W, this.renderer.H);

      this.mainMenu.render(this.frameCount);

      // If controls screen is open on top of menu, render it
      if (this.pause.active) {
        this.pause.render(ctx, this.renderer.W, this.renderer.H, this.frameCount);
      }
      return;
    }

    // ── Gameplay render ─────────────────────────────────────────────────────
    const p = this.player;
    if (!p) return;

    const JUMP_Z_SCALE = 0.55;

    const renderPX     = p.prevX     + t * (p.x      - p.prevX);
    const renderPZ     = p.prevZ     + t * (p.z      - p.prevZ);
    const renderPJumpY = p.prevJumpY + t * (p.jumpY  - p.prevJumpY);
    const renderPlayer = {
      ...p,
      x:       renderPX,
      z:       renderPZ + renderPJumpY * JUMP_Z_SCALE,
      jumpY:   renderPJumpY,
      groundZ: renderPZ,
    };

    const foodRender = this.em.activeFood.map(f => {
      const rx = f.prevX + t * (f.x - f.prevX);
      const rz = f.prevZ + t * (f.z - f.prevZ);
      return { ...f, x: rx, z: rz + (f.visualZ - f.z) };
    });

    const enemyRender = this.em.activeEnemies
      .filter(e => e.state !== 'dead')
      .map(e => ({
        ...e,
        x: e.prevX + t * (e.x - e.prevX),
        z: e.prevZ + t * (e.z - e.prevZ),
      }));

    const propRender = this.em.activeProps.map(pp => ({
      ...pp,
      x: pp.prevX + t * (pp.x - pp.prevX),
      z: pp.prevZ + t * (pp.z - pp.prevZ),
    }));

    const allEntities = [renderPlayer, ...propRender, ...enemyRender, ...this.hitEffects, ...foodRender];

    const renderCamX = this.prevCameraX + t * (this.cameraX - this.prevCameraX);

    this.renderer.render({
      cameraX:    renderCamX,
      cameraY:    0,
      entities:   allEntities,
      worldWidth: WORLD_WIDTH,
      worldDepth: LANE_MAX_Z,
      skyScrollX: this.skyScrollX,
      frameCount: this.frameCount,
    });

    this._renderOverlay(p);
    this.deathMenu.render(this.frameCount);
    this.pause.render(this.renderer.ctx, this.renderer.W, this.renderer.H, this.frameCount);
  }

  // ── Overlay rendering ────────────────────────────────────────────────────────

  _renderOverlay(p) {
    const ctx = this.renderer.ctx;
    const W   = this.renderer.W;
    const H   = this.renderer.H;
    const em  = this.em;

    // GO!! prompt
    if (em.status === 'goPrompt') {
      const pulse     = Math.abs(Math.sin(this.frameCount * 0.15));
      const fadeAlpha = Math.min(1, em.goPromptTimer / 15);
      ctx.save();
      ctx.globalAlpha = fadeAlpha;
      ctx.font        = 'bold 16px Courier New';
      ctx.fillStyle   = `rgb(255, ${180 + pulse * 75 | 0}, 0)`;
      ctx.textAlign   = 'right';
      ctx.shadowColor = '#000';
      ctx.shadowBlur  = 6;
      const chevronX  = W - 6 + Math.sin(this.frameCount * 0.3) * 3;
      ctx.fillText('GO!! >', chevronX, H / 2 - 10);
      ctx.font        = '9px Courier New';
      ctx.fillStyle   = '#fff';
      ctx.fillText('AREA CLEAR', chevronX, H / 2 + 6);
      ctx.restore();
    }

    // Boss intro banner
    if (em.status === 'bossIntro') {
      const a = Math.min(1, em.bossIntroTimer / em.BOSS_INTRO_DURATION);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle   = 'rgba(80,0,0,0.55)';
      ctx.fillRect(0, H / 2 - 22, W, 38);
      ctx.font        = 'bold 18px Courier New';
      ctx.fillStyle   = '#ff2200';
      ctx.textAlign   = 'center';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
      ctx.fillText('BOSS INCOMING!', W / 2, H / 2 - 4);
      ctx.font        = '9px Courier New';
      ctx.fillStyle   = '#ffaa00';
      ctx.fillText('PREPARE YOURSELF', W / 2, H / 2 + 10);
      ctx.restore();
    }

    // Boss HP bar
    const boss = em.activeEnemies.find(e => e.type === 'boss' && e.state !== 'dead');
    if (boss) {
      const bw = W - 20, bh = 7, bx = 10, by = H - 18;
      const ratio    = boss.hp / boss.maxHp;
      const barColor = boss.phase === 2 ? '#ff2200' : '#cc00cc';
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle   = '#111';
      ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle   = barColor;
      ctx.fillRect(bx, by, bw * ratio, bh);
      const pulse     = Math.abs(Math.sin(this.frameCount * 0.1)) * 0.3;
      ctx.fillStyle   = `rgba(255,255,255,${pulse})`;
      ctx.fillRect(bx, by, bw * ratio, bh / 2);
      ctx.font        = 'bold 7px Courier New';
      ctx.fillStyle   = '#fff';
      ctx.textAlign   = 'center';
      ctx.fillText(boss.phase === 2 ? '★ BOSS ENRAGED ★' : '★ BOSS ★', W / 2, by - 2);
      ctx.restore();
    }

    // Scroll lock border glow
    if (em.isLocked && em.status === 'active') {
      ctx.save();
      ctx.globalAlpha = 0.18 + Math.abs(Math.sin(this.frameCount * 0.05)) * 0.1;
      ctx.fillStyle   = '#ff2200';
      ctx.fillRect(0, 0, 4, H);
      ctx.fillRect(W - 4, 0, 4, H);
      ctx.restore();
    }

    // Combo display
    if (p.comboCount >= 2 && p.comboTimer > 0) {
      const a = Math.min(1, p.comboTimer / 30);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font        = `bold ${10 + Math.min(p.comboCount, 8)}px Courier New`;
      ctx.fillStyle   = p.comboCount >= 4 ? '#ff8800' : '#ffff44';
      ctx.textAlign   = 'right';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
      ctx.fillText(`${p.comboCount}x COMBO!`, W - 8, 30);
      ctx.restore();
    }

    // Super move flash
    if (p.superActive) {
      const st = p.superTimer / 45;
      ctx.save();
      ctx.globalAlpha = st * 0.35;
      const grad = ctx.createRadialGradient(W/2, H*0.7, 0, W/2, H*0.7, 80);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(1, 'rgba(80,180,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // Level end
    if (this.phase === 'levelEnd') {
      ctx.save();
      ctx.fillStyle   = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, 0, W, H);
      ctx.font        = 'bold 20px Courier New';
      ctx.fillStyle   = '#ffff00';
      ctx.textAlign   = 'center';
      ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
      ctx.fillText(`LEVEL ${this.levelIdx + 1} CLEAR!`, W / 2, H / 2 - 22);
      ctx.font        = '12px Courier New';
      ctx.fillStyle   = '#fff';
      ctx.fillText(`SCORE: ${p.score}`, W / 2, H / 2);
      ctx.font        = '10px Courier New';
      ctx.fillStyle   = '#aaa';
      ctx.fillText('PRESS SPACE FOR NEXT LEVEL', W / 2, H / 2 + 18);
      ctx.restore();
    }

    // Victory
    if (this.phase === 'victory') {
      const pulse = Math.abs(Math.sin(this.frameCount * 0.05));
      ctx.save();
      ctx.fillStyle   = 'rgba(0,0,20,0.75)';
      ctx.fillRect(0, 0, W, H);
      ctx.font        = 'bold 22px Courier New';
      ctx.fillStyle   = `rgb(255, ${200 + pulse * 55 | 0}, 0)`;
      ctx.textAlign   = 'center';
      ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 14;
      ctx.fillText('VICTORY!!', W / 2, H / 2 - 22);
      ctx.font        = '12px Courier New';
      ctx.fillStyle   = '#ffff88';
      ctx.shadowBlur  = 0;
      ctx.fillText(`FINAL SCORE: ${p.score}`, W / 2, H / 2);
      ctx.font        = '10px Courier New';
      ctx.fillStyle   = '#aaa';
      ctx.fillText('PRESS SPACE TO RETURN TO MENU', W / 2, H / 2 + 18);
      ctx.restore();
    }
  }

  // ── HUD ─────────────────────────────────────────────────────────────────────

  _updateHUD() {
    const p = this.player;
    if (!p) return;

    const em        = this.em;
    const alive     = em.aliveCount;
    const totalEnc  = this.level.encounters.length;

    const hpPct    = Math.max(0, p.hp / p.maxHp * 100);
    const hpColor  = hpPct > 50 ? '#22ff44' : hpPct > 25 ? '#ffff00' : '#ff2200';
    const livesStr = '♥'.repeat(Math.max(0, p.lives));

    const chargeReady  = p.superCharge >= p.SUPER_COOLDOWN;
    const hpThreshold  = (p.maxHp * 0.33 + 0.5) | 0;
    const bloodReady   = !chargeReady && p.hp <= hpThreshold;
    const superReady   = chargeReady || bloodReady;
    const superPct     = Math.min(100, (p.superCharge / p.SUPER_COOLDOWN) * 100);
    const superColor   = chargeReady ? '#00ddff' : bloodReady ? '#ff4400' : '#335566';

    this.hudLeft.innerHTML = `
      <div style="margin-bottom:2px">
        <span style="color:#aaa;font-size:9px">HP </span>
        <span style="display:inline-block;width:78px;height:7px;background:#333;vertical-align:middle;border:1px solid #555">
          <span style="display:block;height:100%;width:${hpPct}%;background:${hpColor}"></span>
        </span>
        <span style="color:#888;font-size:9px;margin-left:3px">${p.hp}/${p.maxHp}</span>
      </div>
      <div style="margin-bottom:2px">
        <span style="color:#aaa;font-size:9px">SP </span>
        <span style="display:inline-block;width:50px;height:5px;background:#333;vertical-align:middle;border:1px solid #444">
          <span style="display:block;height:100%;width:${superPct}%;background:${superColor}"></span>
        </span>
        <span style="color:${chargeReady ? '#00ddff' : '#ff4400'};font-size:8px;margin-left:3px">${chargeReady ? 'READY!' : bloodReady ? 'BLOOD!' : ''}</span>
      </div>
      <div><span style="color:#ff5555;font-size:10px">${livesStr}</span></div>
    `;

    const encLabel = em.isLocked
      ? `ENC ${em.encounterIdx}/${totalEnc} [${alive} left]`
      : `ENC ${em.encounterIdx}/${totalEnc}`;

    this.hudRight.innerHTML = `
      <div style="text-align:right;color:#ffff44;font-size:10px">SCORE: ${p.score}</div>
      <div style="text-align:right;color:#aaa;font-size:9px">LVL ${this.levelIdx + 1} | ${encLabel}</div>
    `;
  }

  _clearHUD() {
    if (this.hudLeft)  this.hudLeft.innerHTML  = '';
    if (this.hudRight) this.hudRight.innerHTML = '';
  }
}
