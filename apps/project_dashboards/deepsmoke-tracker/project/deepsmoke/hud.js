// Deepsmoke — pixel steampunk HUD: chunky offscreen-blitted brass dials on
// riveted plates, dark-glass readouts, 12-seg drill ring, comms feed.
// All text: white with a solid black drop shadow (wtxt helper).
// API unchanged: createHUD(root) → { say, update(dt, data), flash, reset }.
const FONT = '"Pixelify Sans", monospace';

export function createHUD(root) {
  const cv = document.createElement('canvas');
  cv.id = 'hud-canvas';
  root.appendChild(cv);
  const g = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1, P = 2;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    P = Math.max(2, Math.round(Math.min(W, H) / 220)); // pixel unit
  }
  resize();
  window.addEventListener('resize', resize);

  const msgs = [];
  let flashA = 0, flashColor = '#ff4433', time = 0;

  function say(name, text) { msgs.push({ name, text, t: 0 }); if (msgs.length > 4) msgs.shift(); }
  function flash(color = '#ff4433') { flashA = 0.55; flashColor = color; }
  function reset() { msgs.length = 0; flashA = 0; }

  const fs = n => Math.round(Math.max(11, n * P)); // font px, floor for tiny screens

  // white text + SOLID black drop shadow (the game's one text style)
  function wtxt(str, x, y, alpha = 1) {
    g.globalAlpha = alpha;
    g.fillStyle = '#000';
    g.fillText(str, x + P, y + P);
    g.fillStyle = '#fff';
    g.fillText(str, x, y);
    g.globalAlpha = 1;
  }

  // ---------- tiny 34×34 offscreen dial, blitted chunky ----------
  const dialCv = document.createElement('canvas');
  dialCv.width = 34; dialCv.height = 34;
  const dg = dialCv.getContext('2d');

  function paintDial(f, locked, wob) {
    dg.clearRect(0, 0, 34, 34);
    for (let y = 0; y < 34; y++) for (let x = 0; x < 34; x++) {
      const ddx = x + 0.5 - 17, ddy = y + 0.5 - 17, r = Math.hypot(ddx, ddy);
      if (r > 16.5) continue;
      let c;
      if (r > 15.2) c = '#4a3608';                                    // outer line
      else if (r > 12.8) c = ddx + ddy < -6 ? '#E9CD9C'               // brass ring
        : ddx + ddy > 6 ? '#8B6914' : '#C4934A';
      else if (r > 11.9) c = '#4a3608';                               // inner line
      else c = locked ? '#46423c' : '#f2e6c8';                        // face
      dg.fillStyle = c; dg.fillRect(x, y, 1, 1);
    }
    // ticks
    dg.fillStyle = '#6b5a2a';
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * 0.75 + (i / 8) * Math.PI * 1.5;
      dg.fillRect(Math.round(16.5 + Math.cos(a) * 10), Math.round(16.5 + Math.sin(a) * 10), 1, 1);
    }
    // needle (pixel-stepped)
    const a = Math.PI * 0.75 + (1 - f) * Math.PI * 1.5 + wob;
    dg.fillStyle = locked ? '#888888' : `hsl(${Math.round(f * 120)},80%,38%)`;
    for (let t = 0; t <= 9; t += 0.5)
      dg.fillRect(Math.round(16.5 + Math.cos(a) * t), Math.round(16.5 + Math.sin(a) * t), 1, 1);
    // hub
    dg.fillStyle = '#8B6914'; dg.fillRect(15, 15, 4, 4);
    dg.fillStyle = '#E9CD9C'; dg.fillRect(15, 15, 2, 2);
  }

  // ---------- pixel chrome helpers ----------
  function plate(x, y, w, h) {
    g.fillStyle = '#3a2a08'; g.fillRect(x - P, y - P, w + 2 * P, h + 2 * P);
    g.fillStyle = '#C4934A'; g.fillRect(x, y, w, h);
    g.fillStyle = '#E9CD9C'; g.fillRect(x, y, w, P); g.fillRect(x, y, P, h);
    g.fillStyle = '#8B6914'; g.fillRect(x, y + h - P, w, P); g.fillRect(x + w - P, y, P, h);
    g.fillStyle = '#5a4408'; // corner rivets
    g.fillRect(x + 2 * P, y + 2 * P, P, P);
    g.fillRect(x + w - 3 * P, y + 2 * P, P, P);
    g.fillRect(x + 2 * P, y + h - 3 * P, P, P);
    g.fillRect(x + w - 3 * P, y + h - 3 * P, P, P);
  }
  function face(x, y, w, h, a = 1) {
    g.globalAlpha = a;
    g.fillStyle = '#141008'; g.fillRect(x - P, y - P, w + 2 * P, h + 2 * P);
    g.fillStyle = 'rgba(12,22,20,.88)'; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(140,220,190,.09)'; g.fillRect(x, y, w, 2 * P); // glass sheen
    g.globalAlpha = 1;
  }
  function diamond(x, y, c, a = 1) {
    g.globalAlpha = a; g.fillStyle = c;
    g.fillRect(x + 2 * P, y, P, P);
    g.fillRect(x + P, y + P, 3 * P, P);
    g.fillRect(x, y + 2 * P, 5 * P, P);
    g.fillRect(x + P, y + 3 * P, 3 * P, P);
    g.fillRect(x + 2 * P, y + 4 * P, P, P);
    g.globalAlpha = 1;
  }

  function dial(x, y, s, fuel, max, label, locked) {
    const f = Math.max(0, Math.min(1, fuel / Math.max(1, max || 100)));
    const wob = f < 0.25 && !locked ? Math.sin(time * 18) * 0.05 : 0;
    paintDial(f, locked, wob);
    g.drawImage(dialCv, x, y, 34 * s, 34 * s);
    g.textAlign = 'center';
    g.font = `bold ${Math.max(10, 4 * s)}px ${FONT}`;
    // dial labels are BLACK — the cream dial face makes white text invisible
    // (LOCKED keeps white: the locked face is dark)
    if (locked) {
      wtxt('LOCKED', x + 17 * s, y + 24.5 * s);
    } else {
      g.fillStyle = '#000';
      g.fillText(label, x + 17 * s, y + 24.5 * s);
    }
    // low-fuel chunky steam puffs
    if (f < 0.25 && !locked) {
      g.fillStyle = '#ebf0f5';
      for (let i = 0; i < 3; i++) {
        const pt = (time * 0.9 + i * 0.37) % 1;
        const sz = s * (2 + Math.round(pt * 2));
        g.globalAlpha = 0.5 * (1 - pt);
        g.fillRect(x + (20 + i * 5) * s, Math.round((y + 2 * s - pt * 14 * s) / s) * s, sz, sz);
      }
      g.globalAlpha = 1;
    }
  }

  // ---------- compass wayfinding glyphs (5-wide pixel maps) ----------
  const GLYPHS = {
    camp:  ['..#..', '.###.', '#####', '#.#.#'],
    grub:  ['#...#', '#####', '.###.', '.#.#.'],
    flag:  ['####.', '.###.', '####.', '#....', '#....'],
    chest: ['#####', '#...#', '#####', '..#..', '#####'],
  };
  function drawGlyph(kind, color, x, y) {
    const rows = GLYPHS[kind];
    if (!rows) return;
    g.fillStyle = color;
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < 5; c++)
        if (rows[r][c] === '#') g.fillRect(x + c * P, y + r * P, P, P);
  }

  // ---------- hazard stripe pattern (LOCKED banner edges) ----------
  const stripeCv = document.createElement('canvas');
  stripeCv.width = 8; stripeCv.height = 8;
  {
    const sg = stripeCv.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      sg.fillStyle = ((x + y) & 7) < 4 ? '#d9a516' : '#14100a';
      sg.fillRect(x, y, 1, 1);
    }
  }
  let stripePat = null;
  function hazardStripes(y, h) {
    if (!stripePat) stripePat = g.createPattern(stripeCv, 'repeat');
    const u = Math.max(1, Math.round(P / 2));
    g.save();
    g.translate(0, y);
    g.scale(u, u);
    g.fillStyle = stripePat;
    g.fillRect(0, 0, Math.ceil(W / u), Math.ceil(h / u));
    g.restore();
  }

  function update(dt, d) {
    time += dt;
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = false;
    g.textBaseline = 'alphabetic';
    if (!d || d.state !== 'play') { flashA = Math.max(0, flashA - dt * 1.4); return; }

    const compact = W < 700;
    const m = 3 * P;

    // low-fuel red visor glow
    if (d.fuel < 25 && !d.locked) {
      const pulse = 0.16 + 0.13 * Math.sin(time * 6) + (25 - d.fuel) * 0.006;
      const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
      vg.addColorStop(0, 'rgba(200,30,20,0)');
      vg.addColorStop(1, `rgba(200,30,20,${Math.max(0, pulse)})`);
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    // damage flash
    if (flashA > 0) {
      g.fillStyle = flashColor;
      g.globalAlpha = flashA;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      flashA = Math.max(0, flashA - dt * 1.6);
    }

    // ---------- bottom-left: dials on riveted plates ----------
    const s1 = P, s2 = Math.max(2, Math.round(P * 0.6));
    const D1 = 34 * s1, D2 = 34 * s2;
    const pw1 = D1 + 4 * P, ph1 = D1 + 4 * P;
    const pw2 = D2 + 4 * P, ph2 = D2 + 4 * P;
    const p1x = m + P, p1y = H - m - ph1;
    const p2x = p1x + pw1 + 3 * P, p2y = H - m - ph2;
    plate(p1x, p1y, pw1, ph1);
    plate(p2x, p2y, pw2, ph2);
    dial(p1x + 2 * P, p1y + 2 * P, s1, d.fuel, d.fuelMax || 100, 'FUEL', d.locked);
    dial(p2x + 2 * P, p2y + 2 * P, s2, d.grubFuel, 100, 'GRUB', d.grubLocked);

    // ---------- resource glass above dials (ores + cans; hotbar shows blocks) ----------
    const fw = Math.max(pw1 + 3 * P + pw2, 62 * P);
    const fh = 14 * P;
    const fx = p1x, fy = p1y - 3 * P - fh;
    face(fx, fy, fw, fh);
    // row 1 — carried ore (diamond glyphs stay colored as icons; counts white)
    const ores = d.ores || {};
    const oreOrder = [['copper', '#b87333'], ['iron', '#9aa2ae'], ['silver', '#e3e8f0'], ['gold', '#ffd873']];
    g.textAlign = 'left';
    g.font = `bold ${fs(4)}px ${FONT}`;
    for (let i = 0; i < 4; i++) {
      const [k, c] = oreOrder[i];
      const n = ores[k] || 0;
      const ox = fx + 3 * P + i * 15 * P, oy = fy + 2 * P;
      const a = n > 0 ? 1 : 0.25;
      diamond(ox, oy, c, a);
      wtxt(`×${n}`, ox + 6.5 * P, oy + 4.5 * P, a);
    }
    // row 2 — fuel cans
    const ry = fy + 8 * P;
    for (let i = 0; i < 3; i++) {
      const cx0 = fx + 3 * P + i * 6 * P;
      g.globalAlpha = i < (d.cans || 0) ? 1 : 0.22;
      g.fillStyle = '#C4934A'; g.fillRect(cx0 + P, ry, 2 * P, P);
      g.fillStyle = '#1E3A8A'; g.fillRect(cx0, ry + P, 4 * P, 4 * P);
      g.fillStyle = '#60A5FA'; g.fillRect(cx0, ry + P, P, P);
      g.globalAlpha = 1;
    }

    // ---------- top-center: pixelated compass bar ----------
    const cbw = Math.min(76 * P, W - 30 * P), cbh = 9 * P;
    const cbx = Math.round((W / 2 - cbw / 2) / P) * P, cby = m;
    plate(cbx, cby, cbw, cbh);
    face(cbx + 2 * P, cby + 2 * P, cbw - 4 * P, cbh - 4 * P);
    {
      const hd = ((-(d.yaw || 0) * 180 / Math.PI) % 360 + 360) % 360;
      const ppd = (cbw - 8 * P) / 150; // ~150° visible across the bar
      const LBL = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
      g.save();
      g.beginPath(); g.rect(cbx + 2 * P, cby + 2 * P, cbw - 4 * P, cbh - 4 * P); g.clip();
      g.textAlign = 'center';
      for (let a = 0; a < 360; a += 15) {
        let delta = a - hd;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        if (Math.abs(delta) > 80) continue;
        const x = Math.round((W / 2 + delta * ppd) / P) * P;
        const lbl = LBL[a];
        if (lbl) {
          g.font = `bold ${fs(3.5)}px ${FONT}`;
          wtxt(lbl, x, cby + cbh - 3 * P);
        } else {
          g.fillStyle = '#6b7a8a';
          g.fillRect(x, cby + 3 * P, P, 2 * P);
        }
      }
      // wayfinding markers: camp / grub / banners / salvage chests
      if (d.markers) for (const mk of d.markers) {
        let delta = mk.ang - hd;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        if (Math.abs(delta) > 80) continue;
        const x = Math.round((W / 2 + delta * ppd) / P) * P;
        const rows = GLYPHS[mk.kind];
        const gh = rows ? rows.length : 4;
        g.fillStyle = 'rgba(0,0,0,.5)';
        g.fillRect(x - 3 * P, cby + P, 7 * P, gh * P + 2 * P);
        drawGlyph(mk.kind, mk.color, x - 2 * P, cby + 2 * P);
      }
      g.restore();
      // gold heading notches, top & bottom center
      const ncx = Math.round(W / 2 / P) * P - P;
      g.fillStyle = '#ffd873';
      g.fillRect(ncx, cby + P, 2 * P, 2 * P);
      g.fillRect(ncx, cby + cbh - 3 * P, 2 * P, 2 * P);
    }

    // ---------- top-center: score/depth riveted plate (below compass) ----------
    g.font = `bold ${fs(6)}px ${FONT}`;
    const scoreTxt = `SCORE ${d.score}`;
    const tw = Math.max(g.measureText(scoreTxt).width + 10 * P, 40 * P);
    const tx = Math.round(W / 2 - tw / 2), ty = cby + cbh + 3 * P, th = 16 * P;
    plate(tx, ty, tw, th);
    face(tx + 2 * P, ty + 2 * P, tw - 4 * P, th - 4 * P);
    g.textAlign = 'center';
    wtxt(scoreTxt, W / 2, ty + 9 * P);
    g.font = `bold ${fs(3.5)}px ${FONT}`;
    wtxt(`DEPTH ${d.depth}m`, W / 2, ty + 13.5 * P);

    // ---------- pixel crosshair + 12-seg drill ring ----------
    const cx = Math.round(W / 2 / P) * P, cy = Math.round(H / 2 / P) * P;
    const arms = [
      [cx - 5 * P, cy - P / 2, 3 * P, P],
      [cx + 2 * P, cy - P / 2, 3 * P, P],
      [cx - P / 2, cy - 5 * P, P, 3 * P],
      [cx - P / 2, cy + 2 * P, P, 3 * P],
    ];
    g.fillStyle = 'rgba(8,12,10,.6)';
    for (const [ax, ay, aw, ah] of arms) g.fillRect(ax - P / 2, ay - P / 2, aw + P, ah + P);
    g.fillStyle = 'rgba(255,255,255,.9)';
    for (const [ax, ay, aw, ah] of arms) g.fillRect(ax, ay, aw, ah);
    if (d.drillProgress > 0) {
      const lit = Math.ceil(d.drillProgress * 12);
      for (let i = 0; i < 12; i++) {
        const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
        const rx = Math.round((cx + Math.cos(a) * 9 * P) / P) * P - P;
        const ryy = Math.round((cy + Math.sin(a) * 9 * P) / P) * P - P;
        g.fillStyle = i < lit ? '#ffd873' : 'rgba(18,16,10,.55)';
        g.fillRect(rx, ryy, 2 * P, 2 * P);
      }
    }
    // talk/use prompt on visor glass
    if (d.prompt) {
      g.font = `bold ${fs(4)}px ${FONT}`;
      const pw = g.measureText(d.prompt).width;
      face(Math.round(W / 2 - pw / 2) - 3 * P, cy + 16 * P, pw + 6 * P, 8 * P, 0.9);
      g.textAlign = 'center';
      wtxt(d.prompt, W / 2, cy + 21.5 * P);
    }

    // ---------- comms feed on visor glass, bottom-center ----------
    for (const mm of msgs) mm.t += dt;
    const vis = msgs.filter(mm => mm.t < 5.2);
    if (vis.length) {
      g.font = `bold ${fs(4)}px ${FONT}`;
      const baseY = H - (compact ? 150 : 190);
      const lh = fs(4) + 2 * P;
      let maxW = 0, maxA = 0;
      for (const mm of vis) {
        maxW = Math.max(maxW, g.measureText(`${mm.name}: ${mm.text}`).width);
        maxA = Math.max(maxA, mm.t > 4 ? Math.max(0, 1 - (mm.t - 4)) : 1);
      }
      if (maxA > 0) {
        const top = baseY - (vis.length - 1) * lh - fs(4) - 2 * P;
        face(Math.round(W / 2 - maxW / 2) - 4 * P, top, maxW + 8 * P, (vis.length - 1) * lh + fs(4) + 5 * P, 0.8 * maxA);
        g.textAlign = 'center';
        for (let i = 0; i < vis.length; i++) {
          const mm = vis[i];
          const a = mm.t > 4 ? Math.max(0, 1 - (mm.t - 4)) : 1;
          wtxt(`${mm.name}: ${mm.text}`, W / 2, baseY - (vis.length - 1 - i) * lh, a);
        }
      }
    }
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t > 5.2) msgs.splice(i, 1);

    // ---------- SUIT LOCKED banner with hazard stripes ----------
    if (d.locked) {
      const bh = 26 * P;
      const by = Math.round(H / 2 - bh / 2) - 4 * P;
      g.fillStyle = 'rgba(96,12,8,.82)';
      g.fillRect(0, by, W, bh);
      hazardStripes(by, 3 * P);
      hazardStripes(by + bh - 3 * P, 3 * P);
      g.textAlign = 'center';
      g.font = `bold ${fs(7)}px ${FONT}`;
      wtxt('SUIT LOCKED — FUEL EMPTY', W / 2, by + 12 * P);
      g.font = `bold ${fs(4)}px ${FONT}`;
      wtxt('Grub is coming... hold tight', W / 2, by + 19 * P);
    }
  }

  return { say, update, flash, reset };
}
