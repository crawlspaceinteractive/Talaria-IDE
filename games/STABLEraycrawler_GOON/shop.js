// ===== SHOP MODULE =====
// Renders and manages the between-depth shop screen.
// Navigation: WASD/Arrow keys move between items, A/D or Left/Right switch tabs,
// Enter/Space = buy/equip, Escape = continue.

import { SHOP_BUY_SFX_URL } from './assets.js';

/** Returns the active mod font or the default retro font. */
function getModFont() {
  return window.__modFont__ || "'Press Start 2P', 'Courier New', monospace";
}

export const WEAPONS = [
  {
    id: 'pistol',
    name: 'PLASMA BLASTER',
    desc: 'Arcane flames. Reliable.',
    cost: 0,
    damage: 45,
    cooldown: 0.22,
    ammoPerShot: 1,
    spread: 0,
    pellets: 1,
    hitscan: true,
    color: '#ff6600',
    tags: ['FLASH'],
    owned: true,   // default weapon
  },
  {
    id: 'shotgun',
    name: 'SHOTGUN',
    desc: '5 pellets, close range.',
    cost: 150,
    damage: 18,
    cooldown: 0.75,
    ammoPerShot: 3,
    spread: 0.18,
    pellets: 5,
    hitscan: true,
    color: '#ff9900',
    tags: ['FLASH'],
    owned: false,
  },
  {
    id: 'crossbow',
    name: 'CROSSBOW',
    desc: 'Rapid fire. Light bolts.',
    cost: 200,
    damage: 30,
    cooldown: 0.12,
    ammoPerShot: 1,
    spread: 0.02,
    pellets: 1,
    color: '#88ffaa',
    tags: ['NOFLASH'],
    owned: false,
  },
  {
    id: 'cannon',
    name: 'CANNON',
    desc: 'Massive damage, slow reload.',
    cost: 300,
    damage: 200,
    cooldown: 2.2,
    ammoPerShot: 5,
    spread: 0,
    pellets: 1,
    color: '#ff4444',
    tags: ['FLASH'],
    owned: false,
  },
  {
    id: 'sword',
    name: 'SHADOW SWORD',
    desc: 'Melee only. Instant kill range.',
    cost: 250,
    damage: 999,
    cooldown: 0.5,
    ammoPerShot: 0,
    spread: 0,
    pellets: 0,
    melee: true,
    meleeRange: 1.5,
    color: '#cc66ff',
    tags: ['NOFLASH'],
    owned: false,
  },
  {
    // Fire Tome: wide burst of 7 arcane bolts
    id: 'plasma2',
    name: 'FIRE TOME',
    desc: '7 arcane bolts, wide burst.',
    cost: 400,
    damage: 28,
    cooldown: 0.85,
    ammoPerShot: 4,
    spread: 0.32,
    pellets: 7,
    color: '#ff00ff',
    tags: ['FLASH'],
    owned: false,
  },
];

// ── Perpetual (stackable) upgrades ───────────────────────────────────────────
export const UPGRADES = [
  {
    id: 'boots',
    name: 'BOOTS OF SPEED',
    desc: '+20% movement speed.',
    baseCost: 120,
    cost: 120,
    stat: 'speed',
    value: 1.2,
    icon: '👟',
    stackable: true,
    purchased: false,
    purchaseCount: 0,
  },
  {
    id: 'backpack',
    name: 'MANA POUCH',
    desc: '+50 max mana. +25 now.',
    baseCost: 100,
    cost: 100,
    stat: 'ammo',
    value: 50,
    icon: '🎒',
    stackable: true,
    purchased: false,
    purchaseCount: 0,
  },
  {
    id: 'cloak',
    name: 'CLOAK OF STEALTH',
    desc: 'Enemies half detection range.',
    baseCost: 180,
    cost: 180,
    stat: 'stealth',
    value: 0.5,
    icon: '🌑',
    stackable: false,
    purchased: false,
    purchaseCount: 0,
  },
  {
    id: 'amulet',
    name: 'AMULET OF VIGOR',
    desc: '+40 max health. Heals to max.',
    baseCost: 200,
    cost: 200,
    stat: 'maxHealth',
    value: 40,
    icon: '💎',
    stackable: true,
    purchased: false,
    purchaseCount: 0,
  },
  {
    id: 'tome',
    name: 'TOME OF FIRE',
    desc: '+20% damage per purchase.',
    baseCost: 220,
    cost: 220,
    stat: 'damageMult',
    value: 1.20,
    icon: '📖',
    stackable: true,
    purchased: false,
    purchaseCount: 0,
  },
];

// ── Hat items (cosmetic, own-once) ────────────────────────────────────────────
export const HAT_ITEMS = [
  {
    id: 'hat',
    name: 'WIZARD HAT',
    desc: 'A stylish brim overlay.',
    productKey: 'hat',
    icon: '🎩',
    owned: false,
    equipped: false,
  },
];

// Tab order for left/right navigation
const TAB_ORDER = ['weapons', 'upgrades', 'hats', 'continue'];

export class Shop {
  constructor(canvas, ctx, assets, payments) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.assets = assets;
    this.payments = payments || null;
    this.score = 0;
    this.onClose = null;
    this.onHatEquipped = null;  // callback(bool equipped)

    this._tab = 'weapons';
    this._selectedWeapon = null;
    this._selectedUpgrade = null;
    this._hoveredItem = null;
    this._message = '';
    this._messageTimer = 0;
    this._time = 0;
    this._scrollOffset = 0;

    // Keyboard/gamepad cursor
    this._cursor = 0;  // index within current tab's item list
    this._navCooldown = 0; // prevents key repeat spam

    // Clone to avoid mutating module-level arrays across runs
    this.weapons  = WEAPONS.map(w => ({ ...w }));
    this.upgrades = UPGRADES.map(u => ({ ...u }));
    this.hats     = HAT_ITEMS.map(h => ({ ...h }));

    // Buy sound
    this._buySfx = null;
    try {
      this._buySfx = new Audio(SHOP_BUY_SFX_URL);
      this._buySfx.volume = 0.6;
    } catch(e) {}

    this._clickHandler = this._onClick.bind(this);
    this._keyHandler   = this._onKey.bind(this);
    canvas.addEventListener('click', this._clickHandler);
    window.addEventListener('keydown', this._keyHandler);
  }

  destroy() {
    this.canvas.removeEventListener('click', this._clickHandler);
    window.removeEventListener('keydown', this._keyHandler);
  }

  setScore(s)  { this.score = s; }
  setGold(g)   { this.score = g; }
  setPlayer(p) { this._player = p; }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _currentItems() {
    if (this._tab === 'weapons')  return this.weapons;
    if (this._tab === 'upgrades') return this.upgrades;
    if (this._tab === 'hats')     return this.hats;
    return [];
  }

  _clampCursor() {
    const items = this._currentItems();
    if (items.length === 0) { this._cursor = 0; return; }
    this._cursor = Math.max(0, Math.min(this._cursor, items.length - 1));
  }

  _tabIndex() { return TAB_ORDER.indexOf(this._tab); }

  _switchTab(dir) {
    let idx = (this._tabIndex() + dir + TAB_ORDER.length) % TAB_ORDER.length;
    this._tab = TAB_ORDER[idx];
    this._cursor = 0;
  }

  // ── Keyboard handler ───────────────────────────────────────────────────────

  _onKey(e) {
    const k = e.key;
    // Up / W
    if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      e.preventDefault();
      this._cursor = Math.max(0, this._cursor - 1);
      return;
    }
    // Down / S
    if (k === 'ArrowDown' || k === 's' || k === 'S') {
      e.preventDefault();
      const items = this._currentItems();
      this._cursor = Math.min(items.length - 1, this._cursor + 1);
      return;
    }
    // Left / A — prev tab
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      e.preventDefault();
      this._switchTab(-1);
      return;
    }
    // Right / D — next tab
    if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      e.preventDefault();
      this._switchTab(1);
      return;
    }
    // Enter / Space — confirm
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      this._confirmCursor();
      return;
    }
    // Escape — continue / close
    if (k === 'Escape') {
      e.preventDefault();
      this._doClose();
      return;
    }
  }

  // ── Gamepad tick (called from main.js gameLoop when phase === 'shop') ───────
  tickGamepad(input) {
    if (!input) return;

    this._navCooldown = Math.max(0, this._navCooldown - 1);
    if (this._navCooldown > 0) return;

    // Up/down from input
    const up   = input.gpMenuUp   || input._gpBack;
    const down = input.gpMenuDown || input._gpFwd;
    const left  = input._gpLeft;
    const right = input._gpRight;
    const sel   = input.gpMenuSel;
    const back  = input.gpMenuBack;

    if (up) {
      this._cursor = Math.max(0, this._cursor - 1);
      this._navCooldown = 10;
    } else if (down) {
      const items = this._currentItems();
      this._cursor = Math.min(items.length - 1, this._cursor + 1);
      this._navCooldown = 10;
    } else if (left) {
      this._switchTab(-1);
      this._navCooldown = 14;
    } else if (right) {
      this._switchTab(1);
      this._navCooldown = 14;
    } else if (sel) {
      this._confirmCursor();
      this._navCooldown = 20;
    } else if (back) {
      this._doClose();
      this._navCooldown = 20;
    }
  }

  // ── Confirm the currently highlighted item ─────────────────────────────────

  _confirmCursor() {
    if (this._tab === 'continue') { this._doClose(); return; }

    if (this._tab === 'weapons') {
      const w = this.weapons[this._cursor];
      if (!w) return;
      if (w.owned) {
        if (this._player) this._player.equippedWeapon = w.id;
        this._showMsg(`EQUIPPED: ${w.name}`);
      } else if (w.cost <= this.score) {
        this.score -= w.cost;
        w.owned = true;
        if (this._player) this._player.equippedWeapon = w.id;
        this._playBuySfx();
        this._showMsg(`BOUGHT: ${w.name}!`);
      } else {
        this._showMsg('NOT ENOUGH GOLD!');
      }
      return;
    }

    if (this._tab === 'upgrades') {
      const u = this.upgrades[this._cursor];
      if (!u) return;
      const canBuy = u.stackable || u.purchaseCount === 0;
      if (!canBuy) { this._showMsg('ALREADY MAXED!'); return; }
      const scaledCost = u.stackable
        ? Math.floor(u.baseCost * Math.pow(1.4, u.purchaseCount))
        : u.cost;
      if (scaledCost > this.score) { this._showMsg('NOT ENOUGH GOLD!'); return; }
      this.score -= scaledCost;
      u.purchased = true;
      u.purchaseCount = (u.purchaseCount || 0) + 1;
      this._applyUpgrade(u);
      this._playBuySfx();
      this._showMsg(`UPGRADE: ${u.name}!`);
      return;
    }

    if (this._tab === 'hats') {
      const h = this.hats[this._cursor];
      if (!h) return;
      if (h.owned) {
        h.equipped = !h.equipped;
        if (h.equipped) this.hats.forEach((oh, oi) => { if (oi !== this._cursor) oh.equipped = false; });
        if (this.onHatEquipped) this.onHatEquipped(h.equipped ? h.id : null);
        this._showMsg(h.equipped ? 'HAT EQUIPPED!' : 'HAT REMOVED');
        this._playBuySfx();
      } else {
        this._buyHatWithPayments(h);
      }
    }
  }

  update(dt) {
    this._time += dt;
    if (this._messageTimer > 0) this._messageTimer -= dt;
  }

  _playBuySfx() {
    if (!this._buySfx) return;
    try { this._buySfx.cloneNode().play().catch(() => {}); } catch(e) {}
  }

  draw() {
    const ctx = this.ctx;
    const W = 320, H = 240;

    // Background
    const bg = this.assets.shopBg;
    if (bg && bg.complete && bg.naturalWidth > 0) {
      ctx.drawImage(bg, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#0a0a14';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#111122';
      for (let y = 0; y < H; y += 12) {
        for (let x = (y % 24 === 0 ? 0 : 6); x < W; x += 24) {
          ctx.fillRect(x, y, 22, 10);
        }
      }
    }

    // Header
    const pulse = 0.7 + 0.3 * Math.sin(this._time * 3);
    ctx.fillStyle = `rgba(0,0,0,0.75)`;
    ctx.fillRect(0, 0, W, 22);
    ctx.fillStyle = `rgba(255,200,50,${pulse})`;
    ctx.font = `bold 11px ${getModFont()}`;
    ctx.textAlign = 'center';
    ctx.fillText('DUNGEON MERCHANT', W / 2, 14);

    // Gold display
    ctx.fillStyle = '#ffdd44';
    ctx.font = `6px ${getModFont()}`;
    ctx.textAlign = 'left';
    ctx.fillText(`GOLD: ${this.score}`, 6, 14);

    // Tabs
    this._drawTabs(ctx, W);

    // Items list
    if (this._tab === 'weapons') {
      this._drawWeapons(ctx, W, H);
    } else if (this._tab === 'upgrades') {
      this._drawUpgrades(ctx, W, H);
    } else if (this._tab === 'hats') {
      this._drawHats(ctx, W, H);
    }

    // Message
    if (this._messageTimer > 0) {
      const alpha = Math.min(1, this._messageTimer);
      ctx.fillStyle = `rgba(0,0,0,${alpha * 0.75})`;
      ctx.fillRect(W / 2 - 80, H / 2 - 10, 160, 18);
      ctx.fillStyle = `rgba(255,220,80,${alpha})`;
      ctx.font = `bold 7px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText(this._message, W / 2, H / 2 + 2);
    }

    // Footer
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, H - 18, W, 18);
    ctx.fillStyle = '#666';
    ctx.font = `6px ${getModFont()}`;
    ctx.textAlign = 'center';
    ctx.fillText('W/S:MOVE  A/D:TAB  ENTER:BUY  ESC:CONTINUE', W / 2, H - 6);

    ctx.textAlign = 'left';
  }

  _drawTabs(ctx, W) {
    const tabs = [
      { id: 'weapons',  label: 'WEAPONS' },
      { id: 'upgrades', label: 'UPGRADES' },
      { id: 'hats',     label: '🎩 HATS' },
      { id: 'continue', label: 'CONTINUE' },
    ];
    const tabW = 66, tabH = 14, tabY = 24;
    tabs.forEach((t, i) => {
      const tx = 4 + i * (tabW + 3);
      const active = this._tab === t.id;
      ctx.fillStyle = active ? '#ffdd44' : (t.id === 'continue' ? '#44ff88' : (t.id === 'hats' ? '#9944ff' : '#333'));
      ctx.fillRect(tx, tabY, tabW, tabH);
      ctx.strokeStyle = active ? '#ff8800' : '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(tx, tabY, tabW, tabH);
      ctx.fillStyle = active ? '#000' : (t.id === 'continue' ? '#002200' : (t.id === 'hats' ? '#ffccff' : '#aaa'));
      ctx.font = `bold 5px ${getModFont()}`;
      ctx.textAlign = 'center';
      ctx.fillText(t.label, tx + tabW / 2, tabY + 9);
    });
    this._tabRects = tabs.map((t, i) => ({ id: t.id, x: 4 + i * (tabW + 3), y: tabY, w: tabW, h: tabH }));
    ctx.textAlign = 'left';
  }

  _drawWeapons(ctx, W, H) {
    const startY = 44;
    const rowH = 28;
    const listH = H - 60;
    const maxVisible = Math.floor(listH / rowH);
    this._weaponRects = [];
    this._clampCursor();

    for (let i = 0; i < Math.min(this.weapons.length, maxVisible); i++) {
      const w = this.weapons[i];
      const ry = startY + i * rowH;
      const isEquipped = this._player && this._player.equippedWeapon === w.id;
      const isOwned = w.owned;
      const isFocused = (i === this._cursor);

      let rowColor = 'rgba(20,20,35,0.85)';
      if (isEquipped) rowColor = 'rgba(0,80,60,0.85)';
      else if (isOwned) rowColor = 'rgba(30,30,60,0.85)';
      if (isFocused) rowColor = 'rgba(80,60,10,0.95)';

      ctx.fillStyle = rowColor;
      ctx.fillRect(6, ry, W - 12, rowH - 2);

      // Focus border
      if (isFocused) {
        ctx.strokeStyle = '#ffdd44';
        ctx.lineWidth = 2;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
        // Cursor arrow
        ctx.fillStyle = '#ffdd44';
        ctx.font = `bold 8px ${getModFont()}`;
        ctx.textAlign = 'left';
        ctx.fillText('▶', 6, ry + rowH / 2 + 3);
      } else {
        ctx.strokeStyle = isEquipped ? '#44ffcc' : (isOwned ? '#44aaff' : '#333');
        ctx.lineWidth = 1;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
      }

      ctx.fillStyle = w.color;
      ctx.fillRect(14, ry + 4, 4, rowH - 10);

      ctx.fillStyle = isOwned ? '#ffffff' : '#aaaaaa';
      ctx.font = `bold 7px ${getModFont()}`;
      ctx.textAlign = 'left';
      ctx.fillText(w.name, 22, ry + 9);

      ctx.fillStyle = '#777';
      ctx.font = `6px ${getModFont()}`;
      ctx.fillText(w.desc, 22, ry + 18);

      ctx.fillStyle = '#aaffaa';
      ctx.font = `6px ${getModFont()}`;
      ctx.textAlign = 'right';
      ctx.fillText(`DMG:${w.damage}`, W - 10, ry + 9);

      if (isEquipped) {
        ctx.fillStyle = '#44ffcc';
        ctx.fillText('[EQUIPPED]', W - 10, ry + 19);
      } else if (isOwned) {
        ctx.fillStyle = '#4488ff';
        ctx.fillText('[EQUIP]', W - 10, ry + 19);
      } else {
        ctx.fillStyle = w.cost <= this.score ? '#ffdd44' : '#884400';
        ctx.fillText(`${w.cost}G`, W - 10, ry + 19);
      }

      ctx.textAlign = 'left';
      this._weaponRects.push({ idx: i, x: 6, y: ry, w: W - 12, h: rowH - 2 });
    }
  }

  _drawUpgrades(ctx, W, H) {
    const startY = 44;
    const rowH = 28;
    const listH = H - 60;
    const maxVisible = Math.floor(listH / rowH);
    this._upgradeRects = [];
    this._clampCursor();

    for (let i = 0; i < Math.min(this.upgrades.length, maxVisible); i++) {
      const u = this.upgrades[i];
      const ry = startY + i * rowH;
      const hasPurchased = u.purchaseCount > 0;
      const canBuyAgain = u.stackable || !hasPurchased;
      const isFocused = (i === this._cursor);

      let rowColor = hasPurchased ? 'rgba(20,40,20,0.85)' : 'rgba(20,20,35,0.85)';
      if (isFocused) rowColor = 'rgba(80,60,10,0.95)';

      ctx.fillStyle = rowColor;
      ctx.fillRect(6, ry, W - 12, rowH - 2);

      if (isFocused) {
        ctx.strokeStyle = '#ffdd44';
        ctx.lineWidth = 2;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
        ctx.fillStyle = '#ffdd44';
        ctx.font = `bold 8px ${getModFont()}`;
        ctx.textAlign = 'left';
        ctx.fillText('▶', 6, ry + rowH / 2 + 3);
      } else {
        ctx.strokeStyle = hasPurchased ? '#44ff88' : '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
      }

      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(u.icon, 14, ry + 14);

      ctx.fillStyle = hasPurchased ? '#88ffaa' : '#cccccc';
      ctx.font = `bold 7px ${getModFont()}`;
      ctx.fillText(u.name, 30, ry + 9);

      ctx.fillStyle = '#777';
      ctx.font = `6px ${getModFont()}`;
      const countLabel = u.stackable && u.purchaseCount > 0 ? ` [x${u.purchaseCount}]` : '';
      ctx.fillText(u.desc + countLabel, 30, ry + 18);

      ctx.textAlign = 'right';
      if (!canBuyAgain) {
        ctx.fillStyle = '#44ff88';
        ctx.fillText('[ACTIVE]', W - 10, ry + 14);
      } else {
        const scaledCost = u.stackable ? Math.floor(u.baseCost * Math.pow(1.4, u.purchaseCount)) : u.cost;
        ctx.fillStyle = scaledCost <= this.score ? '#ffdd44' : '#884400';
        ctx.fillText(`${scaledCost}G`, W - 10, ry + 14);
      }
      ctx.textAlign = 'left';
      this._upgradeRects.push({ idx: i, x: 6, y: ry, w: W - 12, h: rowH - 2 });
    }
  }

  _drawHats(ctx, W, H) {
    const startY = 44;
    this._hatRects = [];
    this._clampCursor();

    // Info blurb
    ctx.fillStyle = 'rgba(80,0,120,0.5)';
    ctx.fillRect(6, startY, W - 12, 18);
    ctx.fillStyle = '#cc88ff';
    ctx.font = `6px ${getModFont()}`;
    ctx.textAlign = 'center';
    ctx.fillText('COSMETIC ITEMS — PURCHASED WITH STARDUST ✧', W / 2, startY + 12);
    ctx.textAlign = 'left';

    const rowH = 38;
    for (let i = 0; i < this.hats.length; i++) {
      const h = this.hats[i];
      const ry = startY + 24 + i * rowH;
      const isEquipped = h.equipped && h.owned;
      const isOwned = h.owned;
      const isFocused = (i === this._cursor);

      let rowColor = isEquipped ? 'rgba(40,0,80,0.9)' : (isOwned ? 'rgba(20,0,40,0.85)' : 'rgba(20,20,35,0.85)');
      if (isFocused) rowColor = 'rgba(80,60,10,0.95)';

      ctx.fillStyle = rowColor;
      ctx.fillRect(6, ry, W - 12, rowH - 2);

      if (isFocused) {
        ctx.strokeStyle = '#ffdd44';
        ctx.lineWidth = 2;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
        ctx.fillStyle = '#ffdd44';
        ctx.font = `bold 8px ${getModFont()}`;
        ctx.textAlign = 'left';
        ctx.fillText('▶', 6, ry + rowH / 2 + 3);
      } else {
        ctx.strokeStyle = isEquipped ? '#cc44ff' : (isOwned ? '#6622aa' : '#333');
        ctx.lineWidth = 1;
        ctx.strokeRect(6, ry, W - 12, rowH - 2);
      }

      ctx.font = '18px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(h.icon, 14, ry + 22);

      ctx.fillStyle = isOwned ? '#ffccff' : '#aaaaaa';
      ctx.font = `bold 7px ${getModFont()}`;
      ctx.fillText(h.name, 40, ry + 11);

      ctx.fillStyle = '#777';
      ctx.font = `6px ${getModFont()}`;
      ctx.fillText(h.desc, 40, ry + 21);

      ctx.textAlign = 'right';
      if (isEquipped) {
        ctx.fillStyle = '#cc44ff';
        ctx.fillText('[WEARING]', W - 10, ry + 16);
        ctx.fillStyle = '#888';
        ctx.fillText('[ENTER TO REMOVE]', W - 10, ry + 26);
      } else if (isOwned) {
        ctx.fillStyle = '#9944ff';
        ctx.fillText('[EQUIP]', W - 10, ry + 16);
      } else {
        const pulse = 0.7 + 0.3 * Math.sin(this._time * 4);
        ctx.fillStyle = `rgba(255,200,80,${pulse})`;
        ctx.fillText('[BUY ✧]', W - 10, ry + 16);
      }
      ctx.textAlign = 'left';
      this._hatRects.push({ idx: i, x: 6, y: ry, w: W - 12, h: rowH - 2 });
    }
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = 320 / rect.width;
    const scaleY = 240 / rect.height;
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top)  * scaleY;

    // Tab clicks
    if (this._tabRects) {
      for (const tr of this._tabRects) {
        if (mx >= tr.x && mx <= tr.x + tr.w && my >= tr.y && my <= tr.y + tr.h) {
          if (tr.id === 'continue') {
            this._doClose();
          } else {
            this._tab = tr.id;
            this._cursor = 0;
          }
          return;
        }
      }
    }

    // Weapon list clicks
    if (this._tab === 'weapons' && this._weaponRects) {
      for (const wr of this._weaponRects) {
        if (mx >= wr.x && mx <= wr.x + wr.w && my >= wr.y && my <= wr.y + wr.h) {
          this._cursor = wr.idx;
          const w = this.weapons[wr.idx];
          if (w.owned) {
            if (this._player) this._player.equippedWeapon = w.id;
            this._showMsg(`EQUIPPED: ${w.name}`);
          } else if (w.cost <= this.score) {
            this.score -= w.cost;
            w.owned = true;
            if (this._player) this._player.equippedWeapon = w.id;
            this._playBuySfx();
            this._showMsg(`BOUGHT: ${w.name}!`);
          } else {
            this._showMsg('NOT ENOUGH GOLD!');
          }
          return;
        }
      }
    }

    // Upgrade list clicks
    if (this._tab === 'upgrades' && this._upgradeRects) {
      for (const ur of this._upgradeRects) {
        if (mx >= ur.x && mx <= ur.x + ur.w && my >= ur.y && my <= ur.y + ur.h) {
          this._cursor = ur.idx;
          const u = this.upgrades[ur.idx];
          const canBuy = u.stackable || u.purchaseCount === 0;
          if (!canBuy) {
            this._showMsg('ALREADY MAXED!');
            return;
          }
          const scaledCost = u.stackable
            ? Math.floor(u.baseCost * Math.pow(1.4, u.purchaseCount))
            : u.cost;
          if (scaledCost > this.score) {
            this._showMsg('NOT ENOUGH GOLD!');
            return;
          }
          this.score -= scaledCost;
          u.purchased = true;
          u.purchaseCount = (u.purchaseCount || 0) + 1;
          this._applyUpgrade(u);
          this._playBuySfx();
          this._showMsg(`UPGRADE: ${u.name}!`);
          return;
        }
      }
    }

    // Hat list clicks
    if (this._tab === 'hats' && this._hatRects) {
      for (const hr of this._hatRects) {
        if (mx >= hr.x && mx <= hr.x + hr.w && my >= hr.y && my <= hr.y + hr.h) {
          this._cursor = hr.idx;
          const h = this.hats[hr.idx];
          if (h.owned) {
            h.equipped = !h.equipped;
            if (h.equipped) {
              this.hats.forEach((oh, oi) => { if (oi !== hr.idx) oh.equipped = false; });
            }
            if (this.onHatEquipped) this.onHatEquipped(h.equipped ? h.id : null);
            this._showMsg(h.equipped ? 'HAT EQUIPPED!' : 'HAT REMOVED');
            this._playBuySfx();
          } else {
            this._buyHatWithPayments(h);
          }
          return;
        }
      }
    }
  }

  async _buyHatWithPayments(h) {
    if (!this.payments) {
      if (this.score >= 500) {
        this.score -= 500;
        h.owned = true;
        h.equipped = true;
        this.hats.forEach((oh) => { if (oh.id !== h.id) oh.equipped = false; });
        if (this.onHatEquipped) this.onHatEquipped(h.id);
        this._playBuySfx();
        this._showMsg('HAT PURCHASED!');
      } else {
        this._showMsg('NOT ENOUGH GOLD! (500G)');
      }
      return;
    }
    this._showMsg('PURCHASING...');
    try {
      const success = await this.payments.prompt(h.productKey || 'hat');
      if (success) {
        h.owned = true;
        h.equipped = true;
        this.hats.forEach((oh) => { if (oh.id !== h.id) oh.equipped = false; });
        if (this.onHatEquipped) this.onHatEquipped(h.id);
        this._playBuySfx();
        this._showMsg('HAT PURCHASED! ✧');
      } else {
        this._showMsg('PURCHASE CANCELLED');
      }
    } catch(err) {
      this._showMsg('PURCHASE FAILED');
    }
  }

  _applyUpgrade(u) {
    if (!this._player) return;
    switch (u.stat) {
      case 'speed':
        this._player.speedMult = (this._player.speedMult || 1.0) * u.value;
        break;
      case 'ammo':
        this._player.maxAmmo = (this._player.maxAmmo || 999) + u.value;
        this._player.ammo = Math.min(this._player.maxAmmo, this._player.ammo + 25);
        break;
      case 'stealth':
        this._player.stealthMult = u.value;
        break;
      case 'maxHealth':
        this._player.maxHealth = (this._player.maxHealth || 100) + u.value;
        this._player.health = this._player.maxHealth;
        break;
      case 'damageMult':
        this._player.damageMult = (this._player.damageMult || 1.0) * u.value;
        break;
    }
  }

  _showMsg(txt) {
    this._message = txt;
    this._messageTimer = 1.8;
  }

  _doClose() {
    if (this.onClose) this.onClose(this.score, this.weapons, this.upgrades, this.hats);
  }
}
