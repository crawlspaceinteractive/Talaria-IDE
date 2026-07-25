// Deepsmoke — INFINITE voxel world: chunk-streamed deterministic noise gen, biomes, instanced rendering, physics, raycast.
import * as THREE from 'three';

export const BLOCK = {
  AIR:0, DIRT:1, ROCK:2, BRICK:3, RELIC:4, CACHE:5, VENT:6, CRACKED:7, DART:8, WATER:9,
  BEDROCK:10, SAND:11, COPPER:12, IRON:13, SILVER:14, GOLD:15, PLACED:16,
  GRASS:17, SNOW:18, ICE:19, SANDSTONE:20, SLATE:21, SHROOM:22, CRYSTAL:23,
  LOG:24, LEAF:25, PLANKS:26, TABLE:27, CHEST:28, CAMPBASE:29,
  OVEN:30, GLASS:31, LANTERN:32, BANNER:33, STILL:34, CHARGE:35, TRACK:36,
};
// CAMPBASE: the camp's foundation — bedrock dressed as grass; can't be drilled out from under HQ
export const isUnbreakable = id => id === BLOCK.BEDROCK || id === BLOCK.CAMPBASE;
export const HARDNESS = {
  1:0.5, 2:0.9, 3:1.2, 4:0.8, 5:0.6, 6:1.0, 7:0.35, 8:1.5, 11:0.4, 12:1.0, 13:1.4,
  14:1.7, 15:2.2, 16:0.45, 17:0.45, 18:0.3, 19:0.75, 20:0.7, 21:1.4, 22:0.25, 23:1.9,
  24:0.9, 25:0.15, 26:0.6, 27:0.7, 28:0.7, 30:1.2, 31:0.3,
  32:0.4, 33:0.3, 34:1.0, 35:0.4, 36:0.55,
};
export const SY = 352, GROUND_Y = 288;

// blocks that fill the player's pack as placeable panels when drilled
export const PACKABLE = [BLOCK.DIRT, BLOCK.ROCK, BLOCK.SAND, BLOCK.BRICK, BLOCK.CRACKED, BLOCK.PLACED,
  BLOCK.GRASS, BLOCK.SNOW, BLOCK.ICE, BLOCK.SANDSTONE, BLOCK.SLATE, BLOCK.SHROOM];

const isSolidId = id => id !== BLOCK.AIR && id !== BLOCK.WATER;

const CS = 16;             // chunk size in x/z
const GEN_R = 3;           // generation radius (chunks) around the streaming center
const UNLOAD_R = GEN_R + 2; // beyond this, chunk meshes are unloaded (data kept)

export function createWorld(scene, textures, worldSeed) {
  const chunks = new Map(); // "cx,cz" -> chunk
  const ckey = (cx, cz) => cx + ',' + cz;
  const lidx = (lx, y, lz) => lx + lz * CS + y * CS * CS;

  // ---------- NOISE (deterministic per world seed — works for any coords, incl. negative) ----------
  // worldSeed: optional — co-op passes the room's shared seed so every crew member digs the SAME world
  const seed = worldSeed ?? Math.random() * 1747;
  const fract = n => n - Math.floor(n);
  const hash2 = (x, z) => fract(Math.sin(x * 127.1 + z * 311.7 + seed) * 43758.5453);
  const hash3 = (x, y, z) => fract(Math.sin(x * 127.1 + y * 269.5 + z * 311.7 + seed) * 43758.5453);
  const sm = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  function vnoise2(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = sm(x - xi), zf = sm(z - zi);
    const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
    return lerp(lerp(a, b, xf), lerp(c, d, xf), zf);
  }
  const fbm2 = (x, z) => (vnoise2(x, z) + 0.5 * vnoise2(x * 2.13 + 31.7, z * 2.13 + 17.3)) / 1.5;
  function vnoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), xf);
    const c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), xf);
    const c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), xf);
    const c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), xf);
    return lerp(lerp(c00, c10, yf), lerp(c01, c11, yf), zf);
  }
  // per-chunk deterministic RNG (mulberry32)
  function chunkRng(cx, cz) {
    let s = (Math.floor(seed * 65536) ^ Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263)) | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- camp & column predictors ----------
  const campX = 24, campZ = 9;
  const spawn = new THREE.Vector3(campX + 0.5, GROUND_Y + 0.01, campZ + 0.5);
  const campDist = (x, z) => Math.max(Math.abs(x - campX), Math.abs(z - campZ));

  function biomeAt(x, z, cd) {
    if (cd <= 8) return 'plains';
    const bn = fbm2(x * 0.019 + 103.7, z * 0.019 + 53.1);
    if (bn < 0.18) return 'desert';
    if (bn < 0.36) return 'valley';
    if (bn < 0.56) return 'plains';
    if (bn < 0.72) return 'butte';
    if (bn < 0.88) return 'mountain';
    return 'floating_islands';
  }
  function colHeight(x, z, biome = biomeAt(x, z, campDist(x, z))) {
    const macro = fbm2(x * 0.0075, z * 0.0075);
    const detail = fbm2(x * 0.032 + 24.3, z * 0.032 + 91.7) - 0.5;
    let h = GROUND_Y - 10 + (macro - 0.5) * 22 + detail * 10;
    if (biome === 'desert') {
      const dune = fbm2(x * 0.028 + 301.2, z * 0.028 + 18.9) - 0.5;
      h -= 16;
      h += dune * 18;
    } else if (biome === 'valley') {
      const v = Math.abs(fbm2(x * 0.014 + 411.1, z * 0.014 + 77.5) - 0.5) * 2;
      h -= 22 + (1 - v) * 26;
    } else if (biome === 'butte') {
      const mesa = Math.max(0, fbm2(x * 0.02 + 711.7, z * 0.02 + 287.3) - 0.47);
      h += 8 + mesa * 110;
      if (mesa > 0.27) h = Math.round(h / 4) * 4; // flatter butte tops
    } else if (biome === 'mountain') {
      const ridge = Math.abs(fbm2(x * 0.015 + 517.1, z * 0.015 + 137.7) - 0.5) * 2;
      h += 24 + (1 - ridge) * 95 + detail * 18;
    } else if (biome === 'floating_islands') {
      const swell = fbm2(x * 0.023 + 613.4, z * 0.023 + 992.7) - 0.5;
      h -= 14;
      h += swell * 16;
    }
    const cd = campDist(x, z);
    if (cd <= 6) h = GROUND_Y;
    else if (cd <= 11) h = lerp(GROUND_Y, h, (cd - 6) / 5);
    return Math.min(SY - 4, Math.max(20, Math.round(h)));
  }
  // Keep spawn in plains and clamp to a sensible surface band around camp height.
  spawn.y = Math.max(GROUND_Y - 6, Math.min(GROUND_Y + 6, colHeight(campX, campZ, 'plains'))) + 0.01;
  const caveAt = (x, y, z, h) =>
    y >= 2 && y < h - 3 && !(campDist(x, z) <= 8 && y >= GROUND_Y - 12) &&
    vnoise3(x * 0.11, y * 0.13, z * 0.11) > (y > GROUND_Y - 70 ? 0.645 : 0.62);

  const vents = [], darts = [], canSpawns = [];

  // ---------- entrance stair: precomputed edits, applied when their chunks generate ----------
  const edits = new Map(); // ckey -> [{x,y,z,t,id?}]
  function addEdit(x, y, z, t, id) {
    if (y < 0 || y >= SY) return;
    const k = ckey(Math.floor(x / CS), Math.floor(z / CS));
    if (!edits.has(k)) edits.set(k, []);
    edits.get(k).push({ x, y, z, t, id });
  }
  (function buildEntrance() {
    // square spiral staircase descending from the surface, just south of camp
    const x0 = campX - 4, x1 = campX + 3, z0 = campZ + 5, z1 = campZ + 12;
    const ring = [];
    for (let x = x0; x <= x1; x++) ring.push([x, z0]);
    for (let z = z0 + 1; z <= z1; z++) ring.push([x1, z]);
    for (let x = x1 - 1; x >= x0; x--) ring.push([x, z1]);
    for (let z = z1 - 1; z > z0; z--) ring.push([x0, z]);
    let idx = campX - x0; // start directly south of camp center
    let y = GROUND_Y - 1;
    while (y > 3) {
      const [x, z] = ring[idx % ring.length];
      for (let k = 0; k < 3; k++) addEdit(x, y + k, z, 'air');
      if (hash3(x, y, z) < 0.08) addEdit(x, y + 3, z, 'cracked'); // seeded — identical for co-op crews
      idx++; y--;
    }
    // bottom chamber with a welcome stash
    const [bx, bz] = ring[idx % ring.length];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let k = 0; k < 3; k++)
      addEdit(bx + dx, y + k, bz + dz, 'air');
    addEdit(bx - 3, y + 1, bz, 'relic');
    addEdit(bx + 3, y + 1, bz, 'cache');
    addEdit(bx, y, bz, 'can');
  })();

  // ---------- chunk generation ----------
  function genChunk(cx, cz) {
    const data = new Uint8Array(CS * SY * CS);
    const heights = new Uint16Array(CS * CS);
    const c = { cx, cz, x0: cx * CS, z0: cz * CS, data, heights, meshes: {}, dirty: true, active: true };
    const rng = chunkRng(cx, cz);
    const ri = (a, b) => Math.floor(a + rng() * (b - a + 1));
    const chunkBiome = biomeAt(c.x0 + (CS >> 1), c.z0 + (CS >> 1), campDist(c.x0 + (CS >> 1), c.z0 + (CS >> 1)));
    const inLocal = (lx, y, lz) => lx >= 0 && lx < CS && lz >= 0 && lz < CS && y > 0 && y < SY;
    const topSolidLocal = (lx, lz, yStart = SY - 2) => {
      if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) return 0;
      for (let y = Math.min(SY - 2, yStart); y >= 1; y--) {
        const id = data[lidx(lx, y, lz)];
        if (id !== BLOCK.AIR && id !== BLOCK.WATER) return y;
      }
      return 0;
    };

    // 1) terrain columns + noise caves
    for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
      const x = c.x0 + lx, z = c.z0 + lz;
      const cd = campDist(x, z);
      const biome = biomeAt(x, z, cd);
      const h = colHeight(x, z, biome);
      heights[lx + lz * CS] = h;
      for (let y = 0; y < h; y++) {
        let id;
        if (y === 0) id = BLOCK.BEDROCK;
        else if (y === h - 1) id = cd <= 5 ? BLOCK.CAMPBASE
          : (biome === 'desert' || biome === 'butte') ? BLOCK.SAND
            : biome === 'mountain' ? BLOCK.SNOW : BLOCK.GRASS;
        else if (y >= h - 4) {
          if (biome === 'desert' || biome === 'butte') id = y >= h - 2 ? BLOCK.SAND : BLOCK.SANDSTONE;
          else if (biome === 'mountain') id = y >= h - 2 && hash3(x, y, z) < 0.5 ? BLOCK.ICE : BLOCK.SLATE;
          else if (biome === 'floating_islands') id = y >= h - 2 ? BLOCK.DIRT : BLOCK.ROCK;
          else if (biome === 'valley') id = BLOCK.DIRT;
          else id = BLOCK.DIRT;
        } else if (y < Math.max(18, Math.floor(GROUND_Y * 0.16))) id = BLOCK.SLATE;
        else id = BLOCK.ROCK;
        data[lidx(lx, y, lz)] = id;
      }
      for (let y = 2; y < h - 3; y++)
        if (caveAt(x, y, z, h)) data[lidx(lx, y, lz)] = BLOCK.AIR;
    }

    // 1.5) floating-island biome — suspended landmasses above the surface
    if (chunkBiome === 'floating_islands' && rng() < 0.96) {
      const islandCount = ri(1, 3);
      for (let n = 0; n < islandCount; n++) {
        const cx2 = ri(3, CS - 4), cz2 = ri(3, CS - 4);
        const surface = heights[cx2 + cz2 * CS];
        const cy = Math.min(SY - 10, Math.max(surface + 16, GROUND_Y + 26 + ri(6, 34)));
        const rx = ri(3, 6), rz = ri(3, 6), ry = ri(2, 4);
        for (let dy = -ry * 2; dy <= ry; dy++) for (let dz = -rz; dz <= rz; dz++) for (let dx = -rx; dx <= rx; dx++) {
          const lx = cx2 + dx, lz = cz2 + dz, y = cy + dy;
          if (!inLocal(lx, y, lz)) continue;
          const nx = dx / rx;
          const nz = dz / rz;
          const ny = dy < 0 ? dy / (ry * 1.9) : dy / ry;
          const mask = nx * nx + nz * nz + ny * ny;
          const wiggle = (hash3(c.x0 + lx, y + 211, c.z0 + lz) - 0.5) * 0.18;
          if (mask > 1.02 + wiggle) continue;
          if (data[lidx(lx, y, lz)] !== BLOCK.AIR) continue;
          data[lidx(lx, y, lz)] = dy > -1 ? BLOCK.DIRT : BLOCK.ROCK;
        }
        for (let dz = -rz - 1; dz <= rz + 1; dz++) for (let dx = -rx - 1; dx <= rx + 1; dx++) {
          const lx = cx2 + dx, lz = cz2 + dz;
          if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) continue;
          const top = topSolidLocal(lx, lz, cy + ry + 2);
          if (top < cy - ry * 2 || top <= 0 || top >= SY - 2) continue;
          if (data[lidx(lx, top + 1, lz)] !== BLOCK.AIR) continue;
          data[lidx(lx, top, lz)] = top > GROUND_Y + 88 ? BLOCK.SNOW : BLOCK.GRASS;
          if (top > 1 && data[lidx(lx, top - 1, lz)] === BLOCK.ROCK) data[lidx(lx, top - 1, lz)] = BLOCK.DIRT;
        }
        const roots = ri(1, 3);
        for (let r = 0; r < roots; r++) {
          const lx = cx2 + ri(-rx + 1, rx - 1), lz = cz2 + ri(-rz + 1, rz - 1);
          const top = topSolidLocal(lx, lz, cy + ry + 2);
          if (top < cy - 2) continue;
          const len = ri(1, 3);
          for (let k = 1; k <= len; k++) {
            const y = top - k;
            if (!inLocal(lx, y, lz)) break;
            if (data[lidx(lx, y, lz)] !== BLOCK.AIR) break;
            data[lidx(lx, y, lz)] = BLOCK.ROCK;
          }
        }
        if (rng() < 0.45) {
          const top = topSolidLocal(cx2, cz2, cy + ry + 2);
          if (inLocal(cx2, top + 1, cz2) && data[lidx(cx2, top + 1, cz2)] === BLOCK.AIR) {
            data[lidx(cx2, top + 1, cz2)] = rng() < 0.55 ? BLOCK.CACHE : BLOCK.RELIC;
          }
        }
      }
    }

    // 2) rooms (fully inside the chunk, brick shell + decorations included)
    const nRooms = ri(1, 2);
    for (let r = 0; r < nRooms; r++) {
      if (rng() < 0.2) continue;
      const w = ri(4, 7), hh = ri(3, 4), d = ri(4, 7);
      const rx = ri(2, CS - 2 - w), rz = ri(2, CS - 2 - d);
      const ry = ri(3, Math.max(8, GROUND_Y - 9));
      if (rng() < 0.25) { // brick shell
        for (let y = ry - 1; y <= ry + hh; y++) for (let lz = rz - 1; lz <= rz + d; lz++) for (let lx = rx - 1; lx <= rx + w; lx++) {
          if (y < 1 || y >= SY) continue;
          const id = data[lidx(lx, y, lz)];
          if (isSolidId(id) && id !== BLOCK.BEDROCK) data[lidx(lx, y, lz)] = BLOCK.BRICK;
        }
      }
      for (let y = ry; y < ry + hh; y++) for (let lz = rz; lz < rz + d; lz++) for (let lx = rx; lx < rx + w; lx++)
        if (data[lidx(lx, y, lz)] !== BLOCK.BEDROCK) data[lidx(lx, y, lz)] = BLOCK.AIR;

      // relics & caches embedded in walls
      const n = ri(2, 4);
      for (let i = 0; i < n; i++) {
        const ix = ri(rx, rx + w - 1), iy = ri(ry, ry + hh - 1), iz = ri(rz, rz + d - 1);
        const dirs = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[0,1,0]];
        const [dx, dy, dz] = dirs[ri(0, 5)];
        const wx = ix + dx, wy = iy + dy, wz = iz + dz;
        if (wx < 0 || wx >= CS || wz < 0 || wz >= CS || wy < 1 || wy >= SY) continue;
        const id = data[lidx(wx, wy, wz)];
        if (isSolidId(id) && id !== BLOCK.BEDROCK && id !== BLOCK.VENT && id !== BLOCK.DART)
          data[lidx(wx, wy, wz)] = rng() < 0.55 ? BLOCK.RELIC : BLOCK.CACHE;
      }
      // steam vent in the floor
      if (rng() < 0.45) {
        const vx = ri(rx, rx + w - 1), vz = ri(rz, rz + d - 1);
        if (ry - 1 > 0 && isSolidId(data[lidx(vx, ry - 1, vz)]) && data[lidx(vx, ry - 1, vz)] !== BLOCK.BEDROCK &&
            data[lidx(vx, ry, vz)] === BLOCK.AIR) {
          data[lidx(vx, ry - 1, vz)] = BLOCK.VENT;
          vents.push({ x: c.x0 + vx, y: ry - 1, z: c.z0 + vz, phase: rng() * 3.5 });
        }
      }
      // dart wall
      if (rng() < 0.35 && ry < GROUND_Y - 10) {
        const wx = rng() < 0.5 ? rx - 1 : rx + w;
        if (wx >= 0 && wx < CS) {
          for (let lz = rz; lz < rz + Math.min(d, 3); lz++) {
            const id = data[lidx(wx, ry + 1, lz)];
            if (isSolidId(id) && id !== BLOCK.BEDROCK) {
              data[lidx(wx, ry + 1, lz)] = BLOCK.DART;
              darts.push({ x: c.x0 + wx, y: ry + 1, z: c.z0 + lz, timer: 0 });
            }
          }
        }
      }
      // fuel can
      if (rng() < 0.35) {
        const fx = ri(rx, rx + w - 1), fz = ri(rz, rz + d - 1);
        let fy = ry;
        if (data[lidx(fx, fy, fz)] === BLOCK.WATER) fy = ry + Math.ceil(hh / 2);
        canSpawns.push(new THREE.Vector3(c.x0 + fx + 0.5, fy + 0.4, c.z0 + fz + 0.5));
      }
      // flooded lower half
      if (ry < GROUND_Y - 80 && rng() < 0.4) {
        const wl = ry + Math.max(1, Math.floor(hh / 2)) - 1;
        for (let y = ry; y <= wl; y++) for (let lz = rz; lz < rz + d; lz++) for (let lx = rx; lx < rx + w; lx++)
          if (data[lidx(lx, y, lz)] === BLOCK.AIR) data[lidx(lx, y, lz)] = BLOCK.WATER;
      }

      // rare steam-engine chamber with segment carts (minecart replacement setpiece)
      if (rng() < 0.17) {
        const axisX = rng() < 0.5;
        const ex = ri(rx + 1, rx + w - 2), ez = ri(rz + 1, rz + d - 2);
        const ey = ry;
        const segMax = Math.max(1, Math.min(4, axisX ? (rx + w - 2 - ex) : (rz + d - 2 - ez)));
        const segs = ri(1, segMax);
        const place = (px, py, pz, id) => {
          if (px < 0 || px >= CS || pz < 0 || pz >= CS || py < 1 || py >= SY) return;
          if (data[lidx(px, py, pz)] === BLOCK.AIR) data[lidx(px, py, pz)] = id;
        };
        place(ex, ey, ez, BLOCK.STILL);
        place(ex, ey + 1, ez, BLOCK.LANTERN);
        place(ex - (axisX ? 1 : 0), ey, ez - (axisX ? 0 : 1), BLOCK.CHARGE);
        for (let s = 1; s <= segs; s++) {
          const cx2 = ex + (axisX ? s : 0), cz2 = ez + (axisX ? 0 : s);
          place(cx2, ey, cz2, s % 2 ? BLOCK.CHEST : BLOCK.PLANKS);
          if (rng() < 0.3) canSpawns.push(new THREE.Vector3(c.x0 + cx2 + 0.5, ey + 0.4, c.z0 + cz2 + 0.5));
          if (rng() < 0.22) place(cx2, ey + 1, cz2, BLOCK.CACHE);
        }
      }
    }

    // 2.5) surface castles — can spawn in plains or floating-island biomes
    const castleChance = chunkBiome === 'floating_islands' ? 0.23 : chunkBiome === 'plains' ? 0.1 : 0;
    if (castleChance > 0 && rng() < castleChance) {
      const half = 4;
      const floatingCastle = chunkBiome === 'floating_islands';
      let site = null;
      for (let tries = 0; tries < 20 && !site; tries++) {
        const lx = ri(half + 2, CS - half - 3);
        const lz = ri(half + 2, CS - half - 3);
        const gx = c.x0 + lx, gz = c.z0 + lz;
        const cd = campDist(gx, gz);
        if (cd <= 14) continue;
        const biome = biomeAt(gx, gz, cd);
        if (floatingCastle ? biome !== 'floating_islands' : biome !== 'plains') continue;
        const y = floatingCastle ? topSolidLocal(lx, lz) : heights[lx + lz * CS] - 1;
        if (!inLocal(lx, y, lz)) continue;
        if (floatingCastle && y < GROUND_Y + 18) continue;
        if (!floatingCastle && (y < GROUND_Y - 20 || y > GROUND_Y + 32)) continue;
        let ok = true;
        for (let dz = -half - 1; dz <= half + 1 && ok; dz++) for (let dx = -half - 1; dx <= half + 1 && ok; dx++) {
          const tx = lx + dx, tz = lz + dz;
          if (tx < 0 || tx >= CS || tz < 0 || tz >= CS) { ok = false; break; }
          const ty = floatingCastle ? topSolidLocal(tx, tz) : heights[tx + tz * CS] - 1;
          if (ty <= 0) { ok = false; break; }
          if (Math.abs(ty - y) > (floatingCastle ? 3 : 2)) { ok = false; break; }
          if (!inLocal(tx, ty + 1, tz) || data[lidx(tx, ty + 1, tz)] !== BLOCK.AIR) { ok = false; break; }
        }
        if (ok) site = { lx, lz, y, floating: floatingCastle };
      }
      if (site) {
        const wallId = site.floating ? BLOCK.SLATE : BLOCK.BRICK;
        const fillId = site.floating ? BLOCK.ROCK : BLOCK.DIRT;
        const wallTop = site.y + (site.floating ? 7 : 6);
        const towerTop = wallTop + 3;
        for (let dz = -half - 1; dz <= half + 1; dz++) for (let dx = -half - 1; dx <= half + 1; dx++) {
          const lx = site.lx + dx, lz = site.lz + dz;
          if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) continue;
          for (let y = Math.max(1, site.y - (site.floating ? 3 : 1)); y <= site.y; y++) {
            const i = lidx(lx, y, lz);
            if (data[i] === BLOCK.AIR || y === site.y) data[i] = fillId;
          }
          if (site.floating && Math.abs(dx) + Math.abs(dz) > half + 1 && rng() < 0.35) {
            const len = ri(1, 3);
            for (let k = 1; k <= len; k++) {
              const y = site.y - k;
              if (!inLocal(lx, y, lz)) break;
              if (data[lidx(lx, y, lz)] !== BLOCK.AIR) break;
              data[lidx(lx, y, lz)] = BLOCK.ROCK;
            }
          }
        }
        for (let y = site.y + 1; y <= towerTop + 1; y++) for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
          const lx = site.lx + dx, lz = site.lz + dz;
          if (!inLocal(lx, y, lz)) continue;
          if (data[lidx(lx, y, lz)] !== BLOCK.BEDROCK && data[lidx(lx, y, lz)] !== BLOCK.CAMPBASE) data[lidx(lx, y, lz)] = BLOCK.AIR;
        }
        for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
          const lx = site.lx + dx, lz = site.lz + dz;
          if (!inLocal(lx, site.y, lz)) continue;
          data[lidx(lx, site.y, lz)] = wallId;
        }
        for (let y = site.y + 1; y <= wallTop; y++) for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
          const edge = Math.abs(dx) === half || Math.abs(dz) === half;
          if (!edge) continue;
          const lx = site.lx + dx, lz = site.lz + dz;
          if (!inLocal(lx, y, lz)) continue;
          data[lidx(lx, y, lz)] = wallId;
        }
        const gateZ = site.lz - half;
        for (let gx = -1; gx <= 1; gx++) for (let y = site.y + 1; y <= site.y + 3; y++) {
          const lx = site.lx + gx;
          if (!inLocal(lx, y, gateZ)) continue;
          data[lidx(lx, y, gateZ)] = BLOCK.AIR;
          if (inLocal(lx, y, gateZ + 1)) data[lidx(lx, y, gateZ + 1)] = BLOCK.AIR;
        }
        for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
          const edge = Math.abs(dx) === half || Math.abs(dz) === half;
          if (!edge || ((dx + dz + 32) & 1)) continue;
          const lx = site.lx + dx, lz = site.lz + dz;
          if (!inLocal(lx, wallTop + 1, lz)) continue;
          data[lidx(lx, wallTop + 1, lz)] = wallId;
        }
        const towers = [[-half, -half], [half, -half], [-half, half], [half, half]];
        for (const [tx, tz] of towers) {
          const lx = site.lx + tx, lz = site.lz + tz;
          for (let y = site.y + 1; y <= towerTop; y++) {
            if (!inLocal(lx, y, lz)) continue;
            data[lidx(lx, y, lz)] = wallId;
          }
          if (inLocal(lx, towerTop + 1, lz)) data[lidx(lx, towerTop + 1, lz)] = BLOCK.LANTERN;
        }
        if (inLocal(site.lx - 2, site.y + 1, site.lz)) data[lidx(site.lx - 2, site.y + 1, site.lz)] = BLOCK.CACHE;
        if (inLocal(site.lx + 2, site.y + 1, site.lz + 1)) data[lidx(site.lx + 2, site.y + 1, site.lz + 1)] = BLOCK.RELIC;
        canSpawns.push(new THREE.Vector3(c.x0 + site.lx + 0.5, site.y + 1.35, c.z0 + site.lz + 0.5));
      }
    }

    // 3) cave flora: glowshrooms on cave floors, crystals in deep slate
    const airPredict = (x, y, z) => {
      const lx = x - c.x0, lz = z - c.z0;
      if (lx >= 0 && lx < CS && lz >= 0 && lz < CS) return y >= SY || data[lidx(lx, y, lz)] === BLOCK.AIR;
      const h = colHeight(x, z, biomeAt(x, z, campDist(x, z)));
      return y >= h || caveAt(x, y, z, h);
    };
    for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
      const x = c.x0 + lx, z = c.z0 + lz;
      const h = heights[lx + lz * CS];
      for (let y = 2; y < Math.min(h - 4, GROUND_Y - 6); y++) {
        const below = data[lidx(lx, y - 1, lz)];
        if (data[lidx(lx, y, lz)] === BLOCK.AIR && isSolidId(below) && below !== BLOCK.BEDROCK && hash3(x, y + 77, z) < 0.045)
          data[lidx(lx, y, lz)] = BLOCK.SHROOM;
      }
      for (let y = 1; y < Math.min(h - 1, Math.max(20, Math.floor(GROUND_Y * 0.36))); y++) {
        if (data[lidx(lx, y, lz)] !== BLOCK.SLATE || hash3(x, y + 313, z) > 0.05) continue;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])
          if (airPredict(x + dx, y + dy, z + dz)) { data[lidx(lx, y, lz)] = BLOCK.CRYSTAL; break; }
      }
    }

    // 3.5) surface trees — plains/floating-island grass + sparse mountain pines (canopy kept in-chunk)
    for (let lz = 2; lz < CS - 2; lz++) for (let lx = 2; lx < CS - 2; lx++) {
      const x = c.x0 + lx, z = c.z0 + lz;
      if (campDist(x, z) <= 7) continue;
      const h = heights[lx + lz * CS];
      const surf = data[lidx(lx, h - 1, lz)];
      const roll = hash2(x * 3.7, z * 3.7);
      const isTree = (surf === BLOCK.GRASS && roll < 0.05) || (surf === BLOCK.SNOW && roll < 0.02);
      if (!isTree || h >= SY - 8 || data[lidx(lx, h, lz)] !== BLOCK.AIR) continue;
      const th = 4 + Math.floor(hash2(x * 7.1, z * 7.3) * 3); // trunk 4–6 tall
      const top = h + th - 1;
      for (let y = h; y <= top; y++) data[lidx(lx, y, lz)] = BLOCK.LOG;
      const leaf = (px, py, pz) => {
        if (px < 0 || px >= CS || pz < 0 || pz >= CS || py < 1 || py >= SY) return;
        if (data[lidx(px, py, pz)] === BLOCK.AIR) data[lidx(px, py, pz)] = BLOCK.LEAF;
      };
      for (let dy = -1; dy <= 0; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dz === 0) continue;                    // trunk column
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // skip corners
        leaf(lx + dx, top + dy, lz + dz);
      }
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
        if (dx || dz) leaf(lx + dx, top + 1, lz + dz);
      leaf(lx, top + 1, lz); leaf(lx, top + 2, lz);
    }

    // 4) ore veins — deeper = rarer & richer
    function veinsGen(id, count, yMin, yMax, len) {
      for (let i = 0; i < count; i++) {
        let lx = ri(1, CS - 2), y = ri(yMin, yMax), lz = ri(1, CS - 2);
        for (let j = 0; j < len; j++) {
          const cur = data[lidx(lx, y, lz)];
          if (cur === BLOCK.ROCK || cur === BLOCK.DIRT || cur === BLOCK.SLATE || cur === BLOCK.SANDSTONE)
            data[lidx(lx, y, lz)] = id;
          lx = Math.min(CS - 2, Math.max(1, lx + ri(-1, 1)));
          y = Math.min(yMax, Math.max(1, y + ri(-1, 1)));
          lz = Math.min(CS - 2, Math.max(1, lz + ri(-1, 1)));
        }
      }
    }
    const copperMax = Math.max(18, GROUND_Y - 10);
    const ironMax = Math.max(10, GROUND_Y - 50);
    const silverMax = Math.max(8, GROUND_Y - 120);
    const goldMax = Math.max(6, GROUND_Y - 190);
    veinsGen(BLOCK.COPPER, 18, 12, copperMax, 5);
    veinsGen(BLOCK.IRON, 14, 8, ironMax, 5);
    veinsGen(BLOCK.SILVER, 10, 4, silverMax, 4);
    veinsGen(BLOCK.GOLD, 8, 1, goldMax, 4);

    // 5) apply precomputed feature edits (entrance stair etc.)
    const ed = edits.get(ckey(cx, cz));
    if (ed) for (const e of ed) {
      const lx = e.x - c.x0, lz = e.z - c.z0;
      const cur = data[lidx(lx, e.y, lz)];
      if (e.t === 'air') { if (cur !== BLOCK.BEDROCK) data[lidx(lx, e.y, lz)] = BLOCK.AIR; }
      else if (e.t === 'cracked') { if (isSolidId(cur) && cur !== BLOCK.BEDROCK) data[lidx(lx, e.y, lz)] = BLOCK.CRACKED; }
      else if (e.t === 'relic' || e.t === 'cache') {
        if (isSolidId(cur) && cur !== BLOCK.BEDROCK) data[lidx(lx, e.y, lz)] = e.t === 'relic' ? BLOCK.RELIC : BLOCK.CACHE;
      } else if (e.t === 'can') canSpawns.push(new THREE.Vector3(e.x + 0.5, e.y + 0.4, e.z + 0.5));
      else if (e.t === 'set') { // persistence layer: saved edit replayed into a fresh chunk
        if (cur !== BLOCK.BEDROCK) data[lidx(lx, e.y, lz)] = e.id | 0;
      }
    }

    chunks.set(ckey(cx, cz), c);
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) { // refresh neighbor border faces
      const n = chunks.get(ckey(cx + dx, cz + dz));
      if (n) n.dirty = true;
    }
    return c;
  }

  // ---------- voxel access ----------
  const chunkOf = (x, z) => chunks.get(ckey(Math.floor(x / CS), Math.floor(z / CS)));
  function get(x, y, z) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0) return BLOCK.BEDROCK;
    if (y >= SY) return BLOCK.AIR;
    const c = chunkOf(x, z);
    if (c) return c.data[lidx(x - c.x0, y, z - c.z0)];
    // ungenerated: predict from column height (solid ground, no surprises)
    return y === 0 ? BLOCK.BEDROCK : (y < colHeight(x, z) ? BLOCK.ROCK : BLOCK.AIR);
  }
  function set(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0 || y >= SY) return;
    const c = chunkOf(x, z);
    if (!c) return;
    const lx = x - c.x0, lz = z - c.z0;
    c.data[lidx(lx, y, lz)] = id;
    c.dirty = true;
    if (lx === 0) { const n = chunkOf(x - 1, z); if (n) n.dirty = true; }
    if (lx === CS - 1) { const n = chunkOf(x + 1, z); if (n) n.dirty = true; }
    if (lz === 0) { const n = chunkOf(x, z - 1); if (n) n.dirty = true; }
    if (lz === CS - 1) { const n = chunkOf(x, z + 1); if (n) n.dirty = true; }
  }
  // persistence layer: replay a saved edit — direct set if the chunk exists,
  // else defer via the pre-gen edit overlay so it lands when the chunk generates.
  function applySavedEdit(x, y, z, id) {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < 0 || y >= SY) return;
    if (chunkOf(x, z)) set(x, y, z, id | 0);
    else addEdit(x, y, z, 'set', id | 0);
  }
  const isSolidCell = (x, y, z) => isSolidId(get(x, y, z));
  const isWaterCell = (x, y, z) => get(x, y, z) === BLOCK.WATER;
  function heightAt(x, z) {
    x = Math.floor(x); z = Math.floor(z);
    const c = chunkOf(x, z);
    if (c) return c.heights[(x - c.x0) + (z - c.z0) * CS];
    return colHeight(x, z);
  }

  // ---------- streaming ----------
  function update(center, syncAll = false) {
    const ccx = Math.floor(center.x / CS), ccz = Math.floor(center.z / CS);
    const pending = [];
    for (let dz = -GEN_R; dz <= GEN_R; dz++) for (let dx = -GEN_R; dx <= GEN_R; dx++) {
      const c = chunks.get(ckey(ccx + dx, ccz + dz));
      if (!c) pending.push([ccx + dx, ccz + dz, dx * dx + dz * dz]);
      else if (!c.active) { c.active = true; c.dirty = true; }
    }
    pending.sort((a, b) => a[2] - b[2]);
    const budget = syncAll ? pending.length : 2;
    for (let i = 0; i < pending.length && i < budget; i++) genChunk(pending[i][0], pending[i][1]);
    // unload far meshes (voxel data + your edits are kept forever)
    for (const c of chunks.values()) {
      if (!c.active) continue;
      if (Math.max(Math.abs(c.cx - ccx), Math.abs(c.cz - ccz)) > UNLOAD_R) {
        for (const k of Object.keys(c.meshes)) { group.remove(c.meshes[k]); c.meshes[k].dispose(); }
        c.meshes = {};
        c.active = false;
      }
    }
  }

  // ---------- RENDERING ----------
  const texFor = {
    1: textures.dirt, 2: textures.rock, 3: textures.brick, 4: textures.relic, 5: textures.cache,
    6: textures.vent, 7: textures.cracked, 8: textures.dart, 9: textures.water, 10: textures.bedrock,
    11: textures.sand, 12: textures.copperOre, 13: textures.ironOre, 14: textures.silverOre,
    15: textures.goldOre, 16: textures.placed, 17: textures.grass, 18: textures.snow, 19: textures.ice,
    20: textures.sandstone, 21: textures.slate, 22: textures.shroom, 23: textures.crystal,
    24: textures.log, 25: textures.leaf, 26: textures.planks, 27: textures.table, 28: textures.chest,
    29: textures.campBase, 30: textures.oven, 31: textures.glass,
    32: textures.lantern, 33: textures.banner, 34: textures.still, 35: textures.charge, 36: textures.haulerTrack,
  };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const group = new THREE.Group();
  scene.add(group);

  const matCache = {};
  function matFor(id) {
    if (matCache[id]) return matCache[id];
    const map = texFor[id];
    let m;
    if (id === BLOCK.WATER) m = new THREE.MeshLambertMaterial({ map, transparent: true, opacity: 0.55, depthWrite: false });
    else if (id === BLOCK.GLASS) m = new THREE.MeshLambertMaterial({ map, transparent: true, opacity: 0.55 });
    else {
      const opts = { map };
      if (id === BLOCK.RELIC) { opts.emissive = new THREE.Color(0x4466dd); opts.emissiveMap = map; opts.emissiveIntensity = 0.55; }
      if (id === BLOCK.CACHE) { opts.emissive = new THREE.Color(0xcc9922); opts.emissiveMap = map; opts.emissiveIntensity = 0.35; }
      if (id === BLOCK.GOLD) { opts.emissive = new THREE.Color(0x66500a); opts.emissiveMap = map; opts.emissiveIntensity = 0.3; }
      if (id === BLOCK.SHROOM) { opts.emissive = new THREE.Color(0x1a9a8a); opts.emissiveMap = map; opts.emissiveIntensity = 0.7; }
      if (id === BLOCK.CRYSTAL) { opts.emissive = new THREE.Color(0x8a3ad0); opts.emissiveMap = map; opts.emissiveIntensity = 0.6; }
      if (id === BLOCK.LANTERN) { opts.emissive = new THREE.Color(0xffaa33); opts.emissiveMap = map; opts.emissiveIntensity = 0.9; }
      if (id === BLOCK.CHARGE) { opts.emissive = new THREE.Color(0xaa2200); opts.emissiveMap = map; opts.emissiveIntensity = 0.25; }
      m = new THREE.MeshLambertMaterial(opts);
    }
    matCache[id] = m;
    return m;
  }

  const NB = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const m4 = new THREE.Matrix4();

  function rebuildChunk(c) {
    const lists = {};
    for (let y = 0; y < SY; y++) for (let lz = 0; lz < CS; lz++) for (let lx = 0; lx < CS; lx++) {
      const id = c.data[lidx(lx, y, lz)];
      if (id === BLOCK.AIR) continue;
      const x = c.x0 + lx, z = c.z0 + lz;
      let exposed = false;
      for (const [dx, dy, dz] of NB) {
        const nid = get(x + dx, y + dy, z + dz);
        if (nid === BLOCK.AIR || (id !== BLOCK.WATER && nid === BLOCK.WATER) ||
            (nid === BLOCK.GLASS && id !== BLOCK.GLASS)) { exposed = true; break; }
      }
      if (!exposed) continue;
      (lists[id] || (lists[id] = [])).push(x, y, z);
    }
    const ids = new Set([...Object.keys(lists), ...Object.keys(c.meshes)]);
    for (const key of ids) {
      const id = +key;
      const cells = lists[id] || [];
      const need = cells.length / 3;
      let mesh = c.meshes[id];
      if (need === 0) { if (mesh) mesh.count = 0; continue; }
      if (!mesh || mesh.userData.capacity < need) {
        if (mesh) { group.remove(mesh); mesh.dispose(); }
        mesh = new THREE.InstancedMesh(geo, matFor(id), need + 80);
        mesh.userData.capacity = need + 80;
        mesh.frustumCulled = false;
        if (id === BLOCK.WATER) mesh.renderOrder = 2;
        c.meshes[id] = mesh;
        group.add(mesh);
      }
      for (let i = 0; i < need; i++) {
        m4.makeTranslation(cells[i * 3] + 0.5, cells[i * 3 + 1] + 0.5, cells[i * 3 + 2] + 0.5);
        mesh.setMatrixAt(i, m4);
      }
      mesh.count = need;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function flush() {
    for (const c of chunks.values()) {
      if (!c.active || !c.dirty) continue;
      c.dirty = false;
      rebuildChunk(c);
    }
  }

  // ---------- PHYSICS ----------
  // prop colliders — AABBs for camp furniture (tents, crates, NPCs...) resolved after voxels
  let propColliders = [];
  const setColliders = l => { propColliders = l || []; };

  function resolveProps(ent, axis) {
    const half = ent.w / 2, e = 0.001;
    for (const c of propColliders) {
      if (ent.pos.x + half <= c.x0 || ent.pos.x - half >= c.x1 ||
          ent.pos.y + ent.h <= c.y0 || ent.pos.y >= c.y1 ||
          ent.pos.z + half <= c.z0 || ent.pos.z - half >= c.z1) continue;
      if (axis === 'y') {
        if (ent.vel.y <= 0 && ent.pos.y >= c.y1 - 0.6) { ent.pos.y = c.y1 + e; ent.onGround = true; ent.vel.y = 0; }
        else if (ent.vel.y > 0) { ent.pos.y = c.y0 - ent.h - e; ent.vel.y = 0; }
      } else if (axis === 'x') {
        ent.pos.x = ent.vel.x > 0 ? c.x0 - half - e : c.x1 + half + e;
        ent.vel.x = 0;
      } else {
        ent.pos.z = ent.vel.z > 0 ? c.z0 - half - e : c.z1 + half + e;
        ent.vel.z = 0;
      }
    }
  }

  function boxCells(ent) {
    const half = ent.w / 2, e = 1e-6;
    return {
      x0: Math.floor(ent.pos.x - half), x1: Math.floor(ent.pos.x + half - e),
      y0: Math.floor(ent.pos.y), y1: Math.floor(ent.pos.y + ent.h - e),
      z0: Math.floor(ent.pos.z - half), z1: Math.floor(ent.pos.z + half - e),
    };
  }

  function resolveAxis(ent, axis) {
    const half = ent.w / 2, e = 0.001;
    for (let pass = 0; pass < 3; pass++) {
      const b = boxCells(ent);
      let hit = false;
      for (let y = b.y0; y <= b.y1 && !hit; y++) for (let z = b.z0; z <= b.z1 && !hit; z++) for (let x = b.x0; x <= b.x1 && !hit; x++) {
        if (!isSolidCell(x, y, z)) continue;
        hit = true;
        if (axis === 'y') {
          if (ent.vel.y <= 0) { ent.pos.y = y + 1 + e; ent.onGround = true; } else ent.pos.y = y - ent.h - e;
          ent.vel.y = 0;
        } else if (axis === 'x') {
          ent.pos.x = ent.vel.x > 0 ? x - half - e : x + 1 + half + e;
          ent.vel.x = 0;
        } else {
          ent.pos.z = ent.vel.z > 0 ? z - half - e : z + 1 + half + e;
          ent.vel.z = 0;
        }
      }
      if (!hit) break;
    }
  }

  function moveEntity(ent, dt) {
    dt = Math.min(dt, 0.05);
    const fx = Math.floor(ent.pos.x), fz = Math.floor(ent.pos.z);
    ent.inWater = isWaterCell(fx, Math.floor(ent.pos.y + 0.2), fz) || isWaterCell(fx, Math.floor(ent.pos.y + ent.h * 0.5), fz);
    const g = 24 * (ent.inWater ? 0.25 : 1);
    ent.vel.y -= g * dt;
    if (ent.inWater) {
      const dr = Math.max(0, 1 - 3.5 * dt);
      ent.vel.x *= dr; ent.vel.z *= dr;
      ent.vel.y *= Math.max(0, 1 - 2.2 * dt);
      if (ent.swimUp) ent.vel.y += 26 * dt;
      ent.vel.y = Math.max(-3.2, Math.min(3.5, ent.vel.y));
    }
    ent.onGround = false;
    ent.pos.y += ent.vel.y * dt; resolveAxis(ent, 'y'); resolveProps(ent, 'y');
    ent.pos.x += ent.vel.x * dt; resolveAxis(ent, 'x'); resolveProps(ent, 'x');
    ent.pos.z += ent.vel.z * dt; resolveAxis(ent, 'z'); resolveProps(ent, 'z');
  }

  const headInWater = ent => isWaterCell(Math.floor(ent.pos.x), Math.floor(ent.pos.y + ent.h - 0.15), Math.floor(ent.pos.z));

  // Amanatides & Woo voxel DDA
  function raycast(origin, dir, maxDist) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const inv = v => Math.abs(v) < 1e-9 ? Infinity : 1 / Math.abs(v);
    const tdx = inv(dir.x), tdy = inv(dir.y), tdz = inv(dir.z);
    const frac = (v) => v - Math.floor(v);
    let tmx = tdx === Infinity ? Infinity : (dir.x > 0 ? (1 - frac(origin.x)) : frac(origin.x)) * tdx;
    let tmy = tdy === Infinity ? Infinity : (dir.y > 0 ? (1 - frac(origin.y)) : frac(origin.y)) * tdy;
    let tmz = tdz === Infinity ? Infinity : (dir.z > 0 ? (1 - frac(origin.z)) : frac(origin.z)) * tdz;
    let prev = { x, y, z }, t = 0;
    for (let i = 0; i < 160; i++) {
      const id = get(x, y, z);
      if (isSolidId(id)) return { x, y, z, id, prev, dist: t };
      prev = { x, y, z };
      if (tmx <= tmy && tmx <= tmz) { t = tmx; x += stepX; tmx += tdx; }
      else if (tmy <= tmz) { t = tmy; y += stepY; tmy += tdy; }
      else { t = tmz; z += stepZ; tmz += tdz; }
      if (t > maxDist) return null;
    }
    return null;
  }

  function entityOverlapsCell(ent, x, y, z) {
    const half = ent.w / 2;
    return ent.pos.x + half > x && ent.pos.x - half < x + 1 &&
           ent.pos.y + ent.h > y && ent.pos.y < y + 1 &&
           ent.pos.z + half > z && ent.pos.z - half < z + 1;
  }

  function dispose() {
    for (const c of chunks.values()) for (const k of Object.keys(c.meshes)) { group.remove(c.meshes[k]); c.meshes[k].dispose(); }
    chunks.clear();
    for (const k of Object.keys(matCache)) matCache[k].dispose();
    scene.remove(group);
    geo.dispose();
  }

  // synchronous first slice around camp so the run starts on solid ground
  update(spawn, true);
  flush();
  const biomeAtWorld = (x, z) => {
    const fx = Math.floor(x), fz = Math.floor(z);
    return biomeAt(fx, fz, campDist(fx, fz));
  };

  return {
    BLOCK, SY, GROUND_Y, seed, applySavedEdit,
    get, set, isSolidCell, isWaterCell, headInWater, heightAt,
    moveEntity, raycast, flush, dispose, entityOverlapsCell, update, setColliders,
    vents, darts, canSpawns, spawn, biomeAt: biomeAtWorld,
  };
}
