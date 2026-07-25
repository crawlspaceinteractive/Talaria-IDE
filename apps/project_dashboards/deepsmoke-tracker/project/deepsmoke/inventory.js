// Deepsmoke — item registry, identity block drops, 36-slot inventory, crafting recipes, item icons.

// itemId -> { name, block? (placeable voxel id), tex? (textures key), stack, tool? }
export const ITEMS = {
  dirt:       { name: 'Dirt',           block: 1,  tex: 'dirt',      stack: 64 },
  rock:       { name: 'Rock',           block: 2,  tex: 'rock',      stack: 64 },
  brick:      { name: 'Brick',          block: 3,  tex: 'brick',     stack: 64 },
  sand:       { name: 'Sand',           block: 11, tex: 'sand',      stack: 64 },
  panel:      { name: 'Panel',          block: 16, tex: 'placed',    stack: 64 },
  grass:      { name: 'Grass',          block: 17, tex: 'grass',     stack: 64 },
  snow:       { name: 'Snow',           block: 18, tex: 'snow',      stack: 64 },
  ice:        { name: 'Ice',            block: 19, tex: 'ice',       stack: 64 },
  sandstone:  { name: 'Sandstone',      block: 20, tex: 'sandstone', stack: 64 },
  slate:      { name: 'Slate',          block: 21, tex: 'slate',     stack: 64 },
  shroom:     { name: 'Glowshroom',     block: 22, tex: 'shroom',    stack: 64 },
  crystal:    { name: 'Crystal',        block: 23, tex: 'crystal',   stack: 64 },
  log:        { name: 'Log',            block: 24, tex: 'log',       stack: 64 },
  leaf:       { name: 'Leaves',         block: 25, tex: 'leaf',      stack: 64 },
  planks:     { name: 'Planks',         block: 26, tex: 'planks',    stack: 64 },
  table:      { name: 'Crafting Bench', block: 27, tex: 'table',     stack: 64 },
  chest:      { name: 'Chest',          block: 28, tex: 'chest',     stack: 64 },
  oven:       { name: 'Oven',           block: 30, tex: 'oven',      stack: 64 },
  glass:      { name: 'Glass',          block: 31, tex: 'glass',     stack: 64 },
  lantern:    { name: 'Glow Lantern',   block: 32, tex: 'lantern',   stack: 64 },
  banner:     { name: 'Waypoint Banner',block: 33, tex: 'banner',    stack: 16 },
  still:      { name: 'Wood-Gas Still', block: 34, tex: 'still',     stack: 8 },
  charge:     { name: 'Blast Charge',   block: 35, tex: 'charge',    stack: 16 },
  hauler_track: { name: 'Hauler Track', block: 36, tex: 'haulerTrack', stack: 64 },
  steam_hauler: { name: 'Steam Hauler',                                stack: 1 },
  cargo_cart: { name: 'Cargo Cart Segment',                               stack: 8 },
  stick:      { name: 'Stick', stack: 64 },
  copper_ingot: { name: 'Copper Ingot', stack: 64, ingot: 'copper', color: '#b87333' },
  iron_ingot:   { name: 'Iron Ingot',   stack: 64, ingot: 'iron',   color: '#9aa2ae' },
  silver_ingot: { name: 'Silver Ingot', stack: 64, ingot: 'silver', color: '#e3e8f0' },
  gold_ingot:   { name: 'Gold Ingot',   stack: 64, ingot: 'gold',   color: '#ffd873' },
  wood_pick:  { name: 'Wooden Pick', stack: 1, tool: { kind: 'pick', mult: 1.5, tier: 1 } },
  stone_pick: { name: 'Stone Pick',  stack: 1, tool: { kind: 'pick', mult: 2,   tier: 2 } },
  wood_axe:   { name: 'Wooden Axe',  stack: 1, tool: { kind: 'axe',  mult: 2.2 } },
  stone_axe:  { name: 'Stone Axe',   stack: 1, tool: { kind: 'axe',  mult: 3 } },
};

// blockId -> itemId it drops when broken — EVERY breakable block drops its mini version.
// Ores/RELIC/CACHE keep their own pickup flow. CRACKED(7)/VENT(6)/DART(8) crumble to plain rock.
// BEDROCK/CAMPBASE never break.
export const BLOCK_DROP = {
  1: 'dirt', 2: 'rock', 3: 'brick', 6: 'rock', 7: 'rock', 8: 'rock', 11: 'sand',
  16: 'panel', 17: 'grass', 18: 'snow', 19: 'ice', 20: 'sandstone', 21: 'slate',
  22: 'shroom', 23: 'crystal', 24: 'log', 25: 'leaf', 26: 'planks', 27: 'table', 28: 'chest',
  30: 'oven', 31: 'glass', 32: 'lantern', 33: 'banner', 34: 'still', 35: 'charge', 36: 'hauler_track',
};

// ---------- inventory (hotbar = slots 0..8) ----------
export function createInventory(size = 36) {
  const inv = {
    slots: Array(size).fill(null), // {id, n} | null
    sel: 0,
    rev: 0, // bumped on every mutation — hotbar/panels re-render when it changes
    add(id, n = 1) {
      const max = ITEMS[id].stack;
      for (let i = 0; i < size && n > 0; i++) {
        const s = inv.slots[i];
        if (s && s.id === id && s.n < max) { const t = Math.min(n, max - s.n); s.n += t; n -= t; }
      }
      for (let i = 0; i < size && n > 0; i++) {
        if (!inv.slots[i]) { const t = Math.min(n, max); inv.slots[i] = { id, n: t }; n -= t; }
      }
      inv.rev++;
      return n; // leftover that didn't fit
    },
    count(id) {
      let n = 0;
      for (const s of inv.slots) if (s && s.id === id) n += s.n;
      return n;
    },
    take(id, n) {
      if (inv.count(id) < n) return false;
      for (let i = size - 1; i >= 0 && n > 0; i--) {
        const s = inv.slots[i];
        if (!s || s.id !== id) continue;
        const t = Math.min(n, s.n);
        s.n -= t; n -= t;
        if (s.n <= 0) inv.slots[i] = null;
      }
      inv.rev++;
      return true;
    },
    canFit(id, n) {
      const max = ITEMS[id].stack;
      let room = 0;
      for (const s of inv.slots) {
        if (!s) room += max;
        else if (s.id === id) room += max - s.n;
        if (room >= n) return true;
      }
      return room >= n;
    },
    selected() { return inv.slots[inv.sel]; },
    consumeSel() {
      const s = inv.slots[inv.sel];
      if (!s) return;
      s.n--;
      if (s.n <= 0) inv.slots[inv.sel] = null;
      inv.rev++;
    },
  };
  return inv;
}

// ---------- crafting ----------
export const RECIPES = [
  { out: 'planks',     n: 4, cost: { log: 1 } },
  { out: 'stick',      n: 4, cost: { planks: 2 } },
  { out: 'table',      n: 1, cost: { planks: 4 } },
  { out: 'wood_pick',  n: 1, cost: { planks: 3, stick: 2 }, bench: true },
  { out: 'wood_axe',   n: 1, cost: { planks: 3, stick: 2 }, bench: true },
  { out: 'stone_pick', n: 1, cost: { rock: 3, stick: 2 },   bench: true },
  { out: 'stone_axe',  n: 1, cost: { rock: 3, stick: 2 },   bench: true },
  { out: 'chest',      n: 1, cost: { planks: 8 },           bench: true },
  { out: 'oven',       n: 1, cost: { rock: 8 },             bench: true },
  { out: 'lantern',    n: 1, cost: { crystal: 1, glass: 1, stick: 1 } },
  { out: 'banner',     n: 2, cost: { planks: 2, stick: 1 } },
  { out: 'still',      n: 1, cost: { rock: 6, glass: 2, copper_ingot: 1 }, bench: true },
  { out: 'charge',     n: 1, cost: { sand: 3, crystal: 2, stick: 1 },      bench: true },
  { out: 'hauler_track', n: 6, cost: { planks: 3, iron_ingot: 1 },         bench: true },
  { out: 'cargo_cart', n: 1, cost: { planks: 6, iron_ingot: 1, glass: 1 }, bench: true },
  { out: 'steam_hauler', n: 1, cost: { planks: 12, iron_ingot: 8, copper_ingot: 4, glass: 4, cargo_cart: 1 }, bench: true },
];

// ---------- oven smelting: cost = bag items (incl. log fuel), ore = carried vault-ore ----------
export const OVEN_RECIPES = [
  { out: 'glass',        n: 2, cost: { sand: 2, log: 1 } },
  { out: 'copper_ingot', n: 1, cost: { log: 1 }, ore: { copper: 2 } },
  { out: 'iron_ingot',   n: 1, cost: { log: 1 }, ore: { iron: 2 } },
  { out: 'silver_ingot', n: 1, cost: { log: 1 }, ore: { silver: 2 } },
  { out: 'gold_ingot',   n: 1, cost: { log: 1 }, ore: { gold: 2 } },
];

export function canSmelt(inv, ores, r) {
  for (const k in r.cost) if (inv.count(k) < r.cost[k]) return false;
  if (r.ore) for (const k in r.ore) if ((ores[k] || 0) < r.ore[k]) return false;
  return inv.canFit(r.out, r.n);
}

export function smelt(inv, ores, r) {
  for (const k in r.cost) inv.take(k, r.cost[k]);
  if (r.ore) for (const k in r.ore) ores[k] -= r.ore[k];
  inv.add(r.out, r.n);
}

export function canCraft(inv, r, nearBench) {
  if (r.bench && !nearBench) return false;
  for (const k in r.cost) if (inv.count(k) < r.cost[k]) return false;
  return inv.canFit(r.out, r.n);
}

export function craft(inv, r) {
  for (const k in r.cost) inv.take(k, r.cost[k]);
  inv.add(r.out, r.n);
}

// ---------- icons: 32px canvases (block items reuse world textures) ----------
function drawToolIcon(g, id) {
  const px = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
  if (id === 'cargo_cart') {
    px(3, 11, 26, 10, '#a07a3a');
    px(4, 9, 24, 2, '#d4b483');
    px(6, 12, 6, 7, '#6b4a2a');
    px(20, 12, 6, 7, '#6b4a2a');
    px(6, 22, 7, 7, '#3c3a36');
    px(19, 22, 7, 7, '#3c3a36');
    px(8, 24, 3, 3, '#9aa2ae');
    px(21, 24, 3, 3, '#9aa2ae');
    return;
  }
  if (id === 'steam_hauler') {
    px(2, 18, 28, 7, '#8d959e');
    px(7, 11, 14, 8, '#c4934a');
    px(19, 9, 10, 10, '#9aa2ae');
    px(4, 8, 4, 8, '#3c3a36');
    px(5, 6, 2, 2, '#c4934a');
    px(4, 24, 6, 6, '#3c3a36');
    px(22, 24, 6, 6, '#3c3a36');
    px(6, 26, 2, 2, '#9aa2ae');
    px(24, 26, 2, 2, '#9aa2ae');
    return;
  }
  // diagonal wooden handle, bottom-left to top-right
  for (let i = 0; i < 9; i++) px(4 + i * 2.5, 24 - i * 2.5, 4, 4, i % 2 ? '#8a5a2a' : '#a97a3f');
  if (id === 'stick') return;
  const head = id.startsWith('wood') ? '#b08948' : '#8d959e';
  const dark = id.startsWith('wood') ? '#7a5a28' : '#5a616b';
  if (id.endsWith('pick')) {
    px(12, 2, 18, 4, head); px(26, 5, 4, 8, head); px(10, 5, 4, 7, head);
    px(13, 6, 13, 2, dark);
  } else { // axe
    px(17, 2, 12, 11, head); px(14, 4, 4, 8, head);
    px(19, 10, 10, 3, dark);
  }
}

function drawIngotIcon(g, color) {
  // stacked metal bar, isometric-ish
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(5, 20, 24, 6);
  g.fillStyle = color;
  g.beginPath(); g.moveTo(8, 12); g.lineTo(24, 12); g.lineTo(28, 20); g.lineTo(4, 20); g.closePath(); g.fill();
  g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(9, 13, 12, 2);
  g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(4, 18, 24, 2);
}

export function makeIcons(textures) {
  const icons = {}, urls = {};
  for (const id in ITEMS) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const it = ITEMS[id];
    if (it.tex && textures[it.tex]) g.drawImage(textures[it.tex].image, 0, 0, 32, 32);
    else if (it.ingot) drawIngotIcon(g, it.color);
    else drawToolIcon(g, id);
    icons[id] = c;
  }
  const iconURL = id => urls[id] || (urls[id] = icons[id].toDataURL());
  return { icons, iconURL };
}
