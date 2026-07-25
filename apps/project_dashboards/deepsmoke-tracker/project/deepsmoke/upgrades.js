// Deepsmoke — gear upgrade tree + persistent goblin profile (localStorage save-game state).
import { BLOCK } from './world.js';

export const ORE_KEYS = ['copper', 'iron', 'silver', 'gold'];

export const ORE_INFO = {
  copper: { name: 'Copper', color: '#b87333', block: BLOCK.COPPER, mineTier: 1 },
  iron:   { name: 'Iron',   color: '#9aa2ae', block: BLOCK.IRON,   mineTier: 2 },
  silver: { name: 'Silver', color: '#e3e8f0', block: BLOCK.SILVER, mineTier: 3 },
  gold:   { name: 'Gold',   color: '#ffd873', block: BLOCK.GOLD,   mineTier: 4 },
};

export const ORE_BLOCK_KEY = {};
for (const k of ORE_KEYS) ORE_BLOCK_KEY[ORE_INFO[k].block] = k;

// tier index in profile is 0-based into these arrays
export const TRACKS = {
  drill: {
    label: 'DRILL', slot: 'TOOL', tiers: [
      { name: 'Brass Bit Mk I',  speed: 1.0, mineTier: 1, desc: 'Chews copper ore' },
      { name: 'Copper Chomper',  speed: 1.3, mineTier: 2, desc: 'Mines iron · 30% faster', cost: { copper: 5 } },
      { name: 'Iron Fang',       speed: 1.6, mineTier: 3, desc: 'Mines silver · 60% faster', cost: { copper: 4, iron: 6 } },
      { name: 'Silver Screamer', speed: 2.0, mineTier: 4, desc: 'Mines gold · 2× speed', cost: { iron: 6, silver: 6 } },
      { name: 'Gilded Gnasher',  speed: 2.5, mineTier: 4, desc: '2.5× drill speed', cost: { silver: 6, gold: 8 } },
    ],
  },
  tank: {
    label: 'BOILER', slot: 'BACK', tiers: [
      { name: 'Standard Boiler', cap: 100, desc: '100 fuel capacity' },
      { name: 'Twin Boiler',     cap: 135, desc: '135 fuel capacity', cost: { copper: 4, iron: 2 } },
      { name: 'Grand Boiler',    cap: 175, desc: '175 fuel capacity', cost: { iron: 5, silver: 4 } },
    ],
  },
  plate: {
    label: 'PLATING', slot: 'BODY', tiers: [
      { name: 'Cloth Weave',    mult: 1.0,  desc: 'No hazard protection' },
      { name: 'Copper Jacket',  mult: 0.65, desc: '-35% hazard damage', cost: { copper: 6 } },
      { name: 'Iron Carapace',  mult: 0.4,  desc: '-60% hazard damage', cost: { iron: 5, silver: 3 } },
    ],
  },
};

// camp projects — built one at a time, mats come from the player's BAG only (manual gathering)
export const CAMP_PROJECTS = [
  { id: 'palisade', name: 'Log Palisade',   mats: { log: 14 },                      desc: 'Log wall + gate banner ring the camp. Pure goblin pride.' },
  { id: 'depot',    name: 'Fuel Depot',     mats: { planks: 8, copper_ingot: 2 },   desc: 'Can rack by the fire: +1 spare can each dig, grab refills at the rack (3 per dig).' },
  { id: 'storage',  name: 'Storage Crate',  mats: { planks: 8 },                    desc: 'Camp chest (in its own lodge) that keeps its contents between digs.' },
  { id: 'turbine',  name: 'Vacuum Turbine', mats: { copper_ingot: 4, glass: 2 },    desc: 'Ore vacuum reach grows 4.5 → 7 blocks.' },
  { id: 'boiler',   name: 'Boiler House',   mats: { rock: 20, iron_ingot: 4 },      desc: "Standing in camp slowly refills yours AND Grub's boiler." },
  { id: 'bunk',     name: "Grub's Bunk",    mats: { planks: 6, leaf: 8 },           desc: 'A rested Grub packs 2 spare cans every dig.' },
];

const KEY = 'deepsmoke_profile_v1';
const PLAYER_NAME_MAX = 18;

export function sanitizePlayerName(raw, fallback = 'MINER') {
  const base = (typeof raw === 'string' ? raw : '').trim().replace(/\s+/g, ' ');
  if (!base) return fallback;
  const clipped = base.slice(0, PLAYER_NAME_MAX);
  return clipped || fallback;
}

export function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    if (p && p.bank) {
      p.drill = Math.min(p.drill | 0, TRACKS.drill.tiers.length - 1);
      p.tank = Math.min(p.tank | 0, TRACKS.tank.tiers.length - 1);
      p.plate = Math.min(p.plate | 0, TRACKS.plate.tiers.length - 1);
      if (!p.projects || typeof p.projects !== 'object') {
        // migrate old tiered camp saves → per-project flags
        p.projects = {};
        const c = p.camp | 0;
        if (c >= 1) { p.projects.palisade = true; p.projects.depot = true; }
        if (c >= 2) { p.projects.storage = true; p.projects.turbine = true; }
        if (c >= 3) { p.projects.boiler = true; }
      }
      if (!Array.isArray(p.campChest)) p.campChest = null;
      for (const k of ORE_KEYS) p.bank[k] = p.bank[k] | 0;
      p.playerName = sanitizePlayerName(p.playerName);
      // 1.4 persistence — extensible fields reserved for future phases
      if (typeof p.grubLoyalty !== 'number' || !Number.isFinite(p.grubLoyalty)) p.grubLoyalty = 0;
      if (!p.blueprints || typeof p.blueprints !== 'object' || Array.isArray(p.blueprints)) p.blueprints = {};
      return p;
    }
  } catch (e) { /* fresh profile */ }
  return {
    drill: 0,
    tank: 0,
    plate: 0,
    projects: {},
    campChest: null,
    playerName: 'MINER',
    grubLoyalty: 0,  // reserved (1.4 spec) — future loyalty mechanic persists here
    blueprints: {},  // reserved (1.4 spec) — future blueprint unlocks persist here
    bank: { copper: 0, iron: 0, silver: 0, gold: 0 },
  };
}

export function saveProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* private mode */ }
}

export const gear = p => ({
  drill: TRACKS.drill.tiers[p.drill],
  tank: TRACKS.tank.tiers[p.tank],
  plate: TRACKS.plate.tiers[p.plate],
});

export function canAfford(p, cost) {
  return ORE_KEYS.every(k => (p.bank[k] || 0) >= (cost[k] || 0));
}

export function buy(p, track) {
  const next = TRACKS[track].tiers[p[track] + 1];
  if (!next || !canAfford(p, next.cost)) return false;
  for (const k of ORE_KEYS) p.bank[k] -= (next.cost[k] || 0);
  p[track]++;
  saveProfile(p);
  return true;
}
