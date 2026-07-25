/**
 * hud.js — HUD overlay (Spec Section XI)
 *
 *   Rendered last. No gameplay interaction. SPIN_SMEAR_LUT drives incremental
 *   transitions when values change.
 *
 *   v0.2.6: All GUI elements scaled down by half to suit 160×100 resolution.
 */
import { drawText, drawRect, rgba } from "./renderer.js";
import { SCREEN_W, SCREEN_H, SPIN_SMEAR_LUT } from "./luts.js";

export function createHUD() {
  return {
    sprinkles: 0,
    lives: 5,
    spinSprinklesT: 0,
    spinLivesT: 0,
    flashMessage: "",
    flashT: 0,
    enemiesLeft: 0,
    portalOpen: false,
  };
}

export function notifySprinkles(hud, newValue) {
  if (newValue !== hud.sprinkles) {
    hud.sprinkles = newValue;
    hud.spinSprinklesT = SPIN_SMEAR_LUT.length - 1;
  }
}
export function notifyLives(hud, newValue) {
  if (newValue !== hud.lives) {
    hud.lives = newValue;
    hud.spinLivesT = SPIN_SMEAR_LUT.length - 1;
  }
}
export function flashMessage(hud, text, frames = 90) {
  hud.flashMessage = text;
  hud.flashT = frames;
}

export function tickHUD(hud) {
  if (hud.spinSprinklesT > 0) hud.spinSprinklesT--;
  if (hud.spinLivesT > 0) hud.spinLivesT--;
  if (hud.flashT > 0) hud.flashT--;
}

const WHITE  = rgba(255, 255, 255);
const PINK   = rgba(255, 110, 180);
const CYAN   = rgba(120, 230, 255);
const BLACK  = rgba(0, 0, 0);
const PANEL  = rgba(20, 14, 36);

// Scale-0.5 versions of all HUD panels
// Font scale stays at 1 (smallest already), panels & positions halved

function smearText(rd, text, x, y, color, t, scale = 1) {
  if (t > 0) {
    const f = SPIN_SMEAR_LUT[SPIN_SMEAR_LUT.length - 1 - t];
    drawText(rd, text, x - 1, y + (f.yOff * 0.5 | 0), rgba(110, 70, 140), scale);
    drawText(rd, text, x + 1, y + (f.yOff * 0.5 | 0), rgba(110, 70, 140), scale);
    drawText(rd, text, x,     y + (f.yOff * 0.5 | 0), color, scale);
  } else {
    drawText(rd, text, x, y, color, scale);
  }
}

export function drawHUD(rd, hud, debug) {
  // Sprinkles (top-left) — half sized: 55×9 panel
  drawRect(rd, 2, 2, 55, 9, PANEL);
  drawRect(rd, 2, 2, 55, 9, PINK, false);
  drawText(rd, "SPR", 4, 3, PINK, 1);
  smearText(rd, String(hud.sprinkles).padStart(4, "0"), 22, 3, WHITE, hud.spinSprinklesT, 1);

  // Lives (top-right) — half sized: 43×9 panel
  const lx = SCREEN_W - 45;
  drawRect(rd, lx, 2, 43, 9, PANEL);
  drawRect(rd, lx, 2, 43, 9, CYAN, false);
  drawText(rd, "LVS", lx + 2, 3, CYAN, 1);
  smearText(rd, String(hud.lives).padStart(2, "0"), lx + 24, 3, WHITE, hud.spinLivesT, 1);

  // Enemy counter + portal status (bottom-left) — half sized
  {
    const ex = 2;
    const ey = SCREEN_H - 12;
    if (hud.portalOpen) {
      const label = "PORTAL!";
      const w = label.length * 5 + 7;
      drawRect(rd, ex, ey, w, 8, PANEL);
      drawRect(rd, ex, ey, w, 8, rgba(255, 80, 220), false);
      drawText(rd, label, ex + 3, ey + 2, rgba(255, 80, 220), 1);
    } else if (hud.enemiesLeft > 0) {
      const label = `ENM:${hud.enemiesLeft}`;
      const w = label.length * 5 + 7;
      drawRect(rd, ex, ey, w, 8, PANEL);
      drawRect(rd, ex, ey, w, 8, rgba(255, 140, 60), false);
      drawText(rd, label, ex + 3, ey + 2, rgba(255, 200, 100), 1);
    }
  }

  // Flash message (center-bottom) — half sized
  if (hud.flashT > 0 && hud.flashMessage) {
    const w = hud.flashMessage.length * 5 + 8;
    const fx = (SCREEN_W - w) >> 1;
    const fy = SCREEN_H - 20;
    drawRect(rd, fx, fy, w, 9, PANEL);
    drawRect(rd, fx, fy, w, 9, PINK, false);
    drawText(rd, hud.flashMessage, fx + 4, fy + 2, WHITE, 1);
  }

  // Debug overlay (Select) — half sized
  if (debug) {
    const dx = 2, dy = 14;
    drawRect(rd, dx, dy, 115, 60, PANEL);
    drawRect(rd, dx, dy, 115, 60, CYAN, false);
    drawText(rd, "DBG", dx + 2, dy + 2, CYAN, 1);
    let row = dy + 10;
    for (const line of debug) {
      drawText(rd, line, dx + 2, row, WHITE, 1);
      row += 6;
    }
  }
}

export function drawCenterPanel(rd, lines, accentColor = PINK) {
  // Compute max width
  let mw = 0;
  for (const ln of lines) mw = Math.max(mw, ln.text.length * 5 * (ln.scale || 1));
  const w = mw + 20;
  const h = lines.length * 8 + 10;
  const px = (SCREEN_W - w) >> 1;
  const py = (SCREEN_H - h) >> 1;
  drawRect(rd, px, py, w, h, PANEL);
  drawRect(rd, px, py, w, h, accentColor, false);
  let cy = py + 5;
  for (const ln of lines) {
    const scale = ln.scale || 1;
    const tw = ln.text.length * 5 * scale;
    drawText(rd, ln.text, px + ((w - tw) >> 1), cy, ln.color || WHITE, scale);
    cy += 6 * scale + 2;
  }
}
