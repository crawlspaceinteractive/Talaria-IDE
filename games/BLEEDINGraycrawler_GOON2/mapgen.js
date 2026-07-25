import { makeSeg, BSPMap, buildBSP, SEG_FLAG_TWO_SIDED, SEG_FLAG_TOGGLEABLE } from './bsp.js';

// Level themes: each level gets a theme
export const LEVEL_THEMES = [
  null,                   // index 0 unused
  { name: 'CAVE',         wallKey: 'wallCave',    floorKey: 'floorCave',    ceiling: [12,10,8],   ceilTop: [6,5,4],    floorTint: [22,15,10], decors: ['rubble','skull','bones','puddleMud'],              label: 'DAMP CAVES' },
  { name: 'DUNGEON',      wallKey: 'wallDungeon', floorKey: 'floor',        ceiling: [8,10,12],   ceilTop: [4,5,6],    floorTint: [18,22,14], decors: ['pillar','table','chair','skull','cobweb'],              label: 'GOBLIN LAIR' },
  { name: 'RUINS',        wallKey: 'wallRuins',   floorKey: 'floorCave',    ceiling: [20,18,12],  ceilTop: [10,9,6],   floorTint: [28,22,12], decors: ['rubble','pillar','bones','puddleBlood','claypot'],              label: 'ANCIENT RUINS' },
  { name: 'LIBRARY',      wallKey: 'wallLibrary', floorKey: 'floorLibrary', ceiling: [22,18,14],  ceilTop: [12,10,8],  floorTint: [30,22,14], decors: ['bookshelf','barrel','table','chair','cobweb','skull'],           label: 'CURSED LIBRARY' },
  { name: 'DEEP_DUNGEON', wallKey: 'wallDungeon', floorKey: 'floor',        ceiling: [4,4,8],     ceilTop: [2,2,4],    floorTint: [14,10,18], decors: ['pillar','rubble','bookshelf','brazier','puddleSlime','bones'],  label: 'THE DEEP' },
];

// GEM DOOR COLORS
export const GEM_COLORS = ['red', 'green', 'blue'];
export const GEM_WALL_IDS = { red: 3, green: 4, blue: 5 }; // kept for backwards-compat key lookups
export const GEM_KEY_ITEMS = { red: 'gem_red', green: 'gem_green', blue: 'gem_blue' };

// ── BFS reachability check ────────────────────────────────────────────────
// Returns true if worldPos (wx,wy) is reachable from (startX,startY) walking
// only through cells that pass the walkable predicate (does not treat gemWallId as blocked).
// BFS neighbour direction offsets (flat index deltas computed per call to
// avoid recomputing w*dy each iteration).
const _BFS_DX = [-1, 1,  0, 0];
const _BFS_DY = [ 0, 0, -1, 1];

function _bfsReachable(grid, w, h, startGX, startGY, targetGX, targetGY, blockedFn) {
  if (startGX === targetGX && startGY === targetGY) return true;
  const n = w * h;
  const visited = new Uint8Array(n);
  // Head-pointer queue: two flat Int32Arrays for x and y coordinates.
  // Array.shift() is O(n); head-pointer dequeue is O(1) with zero GC.
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  let head = 0, tail = 0;
  qx[tail] = startGX; qy[tail] = startGY; tail++;
  visited[startGY * w + startGX] = 1;
  while (head < tail) {
    const cx = qx[head], cy = qy[head]; head++;
    for (let d = 0; d < 4; d++) {
      const nx = cx + _BFS_DX[d];
      const ny = cy + _BFS_DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (visited[ni]) continue;
      if (blockedFn(nx, ny)) continue;
      visited[ni] = 1;
      if (nx === targetGX && ny === targetGY) return true;
      qx[tail] = nx; qy[tail] = ny; tail++;
    }
  }
  return false;
}

export class MapGen {
  static generate(w, h, level) {
    // Cycle through themes 1-4 for infinite depth (skip index 0 = null)
    const themeIdx = ((level - 1) % (LEVEL_THEMES.length - 1)) + 1;
    const theme = LEVEL_THEMES[themeIdx] || LEVEL_THEMES[1];

    const grid = [];
    for (let y = 0; y < h; y++) {
      grid.push(new Array(w).fill(1));
    }

    const rooms = [];
    const attempts = 80;
    const minRoom = 3, maxRoom = 6 + level;

    for (let i = 0; i < attempts; i++) {
      const rw = minRoom + Math.floor(Math.random() * (maxRoom - minRoom));
      const rh = minRoom + Math.floor(Math.random() * (maxRoom - minRoom));
      const rx = 1 + Math.floor(Math.random() * (w - rw - 2));
      const ry = 1 + Math.floor(Math.random() * (h - rh - 2));

      // Fast AABB rejection: skip the O(rw*rh) cell scan if no placed room
      // overlaps (including 1-cell margin) this candidate's bounding box.
      // Eliminates the full grid scan for the majority of failed placements.
      const cLeft = rx - 1, cRight = rx + rw + 1, cTop = ry - 1, cBot = ry + rh + 1;
      let aabbConflict = false;
      for (let ri = 0; ri < rooms.length; ri++) {
        const r = rooms[ri];
        if (cLeft < r.x + r.w + 1 && cRight > r.x - 1 &&
            cTop  < r.y + r.h + 1 && cBot   > r.y - 1) {
          aabbConflict = true;
          break;
        }
      }
      if (aabbConflict) continue;

      if (MapGen._roomFits(grid, rx, ry, rw, rh)) {
        MapGen._carveRoom(grid, rx, ry, rw, rh);
        rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + Math.floor(rw/2), cy: ry + Math.floor(rh/2) });
      }
    }

    rooms.sort((a, b) => a.cx - b.cx);
    for (let i = 1; i < rooms.length; i++) {
      const a = rooms[i-1], b = rooms[i];
      MapGen._carveCorridor(grid, a.cx, a.cy, b.cx, b.cy);
    }

    if (rooms.length < 2) {
      MapGen._carveRoom(grid, 1, 1, 5, 5);
      MapGen._carveRoom(grid, w-7, h-7, 5, 5);
      rooms.push({ x:1, y:1, w:5, h:5, cx: 3, cy: 3 });
      rooms.push({ x:w-7, y:h-7, w:5, h:5, cx: w-4, cy: h-4 });
      MapGen._carveCorridor(grid, 3, 3, w-4, h-4);
    }

    const start = rooms[0];
    const startX = start.cx + 0.5;
    const startY = start.cy + 0.5;
    const startGX = start.cx;
    const startGY = start.cy;

    // ── Solid wall check ───────────────────────────────────────────────────
    // Grid only ever contains 0 (open) or 1 (solid).
    // Toggleables (secret walls, gem doors) are stored separately in the
    // `toggleables` array and are NOT encoded in the grid — surrounding walls
    // are always normal solid wall cells (value 1).
    function _isSolidWallLocal(gx, gy) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
      return grid[gy][gx] === 1;
    }

    function _isSolidWallFull(gx, gy) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
      return grid[gy][gx] === 1;
    }

    // ── Robust spawn validator ──────────────────────────────────���─────────
    function _isOpenFloor(wx, wy, radius) {
      radius = radius || 0.45;
      const gx = Math.floor(wx);
      const gy = Math.floor(wy);

      if (gx < 1 || gx >= w - 1 || gy < 1 || gy >= h - 1) return false;
      if (_isSolidWallLocal(gx, gy)) return false;

      if (_isSolidWallLocal(gx - 1, gy)) return false;
      if (_isSolidWallLocal(gx + 1, gy)) return false;
      if (_isSolidWallLocal(gx, gy - 1)) return false;
      if (_isSolidWallLocal(gx, gy + 1)) return false;

      if (_isSolidWallLocal(gx - 1, gy - 1)) return false;
      if (_isSolidWallLocal(gx + 1, gy - 1)) return false;
      if (_isSolidWallLocal(gx - 1, gy + 1)) return false;
      if (_isSolidWallLocal(gx + 1, gy + 1)) return false;

      const SAMPLES = 16;
      for (let s = 0; s < SAMPLES; s++) {
        const a = (s / SAMPLES) * Math.PI * 2;
        const sx = Math.floor(wx + Math.cos(a) * radius);
        const sy = Math.floor(wy + Math.sin(a) * radius);
        if (_isSolidWallLocal(sx, sy)) return false;
      }

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tx = gx + dx;
          const ty = gy + dy;
          if (!_isSolidWallLocal(tx, ty)) continue;
          const clampX = Math.max(tx, Math.min(tx + 1, wx));
          const clampY = Math.max(ty, Math.min(ty + 1, wy));
          const distSq = (wx - clampX) * (wx - clampX) + (wy - clampY) * (wy - clampY);
          if (distSq < radius * radius) return false;
        }
      }

      return true;
    }

    const isAbominationLevel = (level % 25 === 0);
    const isBossLevel = !isAbominationLevel && (level % 5 === 0);
    const enemies = [];

    function _placeEnemyInRoom(r, type, isBoss, isAbomination) {
      const spawnRadius = isAbomination ? 1.15 : (isBoss ? 1.05 : 0.45);
      const margin = Math.max(spawnRadius + 0.6, 1.2);

      for (let attempt = 0; attempt < 60; attempt++) {
        const ex = r.x + margin + Math.random() * Math.max(0.01, r.w - margin * 2);
        const ey = r.y + margin + Math.random() * Math.max(0.01, r.h - margin * 2);
        if (_isOpenFloor(ex, ey, spawnRadius)) {
          enemies.push({ x: ex, y: ey, type: type || 'goblin', isBoss: !!isBoss, isAbomination: !!isAbomination });
          return true;
        }
      }
      const step = 0.5;
      for (let fy = r.y + margin; fy < r.y + r.h - margin; fy += step) {
        for (let fx = r.x + margin; fx < r.x + r.w - margin; fx += step) {
          if (_isOpenFloor(fx, fy, spawnRadius)) {
            enemies.push({ x: fx, y: fy, type: type || 'goblin', isBoss: !!isBoss, isAbomination: !!isAbomination });
            return true;
          }
        }
      }
      return false;
    }

    function _randomEnemyType() {
      const r = Math.random();
      if (level < 3) return 'goblin';
      if (level < 6) return r < 0.6 ? 'goblin' : (r < 0.8 ? 'bat' : 'spider');
      const batChance    = Math.min(0.3, 0.05 * level);
      const spiderChance = Math.min(0.3, 0.04 * level);
      if (r < batChance) return 'bat';
      if (r < batChance + spiderChance) return 'spider';
      return 'goblin';
    }

    if (isAbominationLevel) {
      const bossRoom = rooms[rooms.length - 1];
      if (!_placeEnemyInRoom(bossRoom, 'goblin', true, true)) {
        enemies.push({ x: bossRoom.cx + 0.5, y: bossRoom.cy + 0.5, type: 'goblin', isBoss: true, isAbomination: true });
      }
      for (let i = 1; i < rooms.length - 1; i++) {
        const r = rooms[i];
        const count = 2 + Math.floor(Math.random() * 3);
        for (let j = 0; j < count; j++) _placeEnemyInRoom(r, _randomEnemyType(), false, false);
      }
    } else if (isBossLevel) {
      const bossRoom = rooms[rooms.length - 1];
      if (!_placeEnemyInRoom(bossRoom, 'goblin', true, false)) {
        enemies.push({ x: bossRoom.cx + 0.5, y: bossRoom.cy + 0.5, type: 'goblin', isBoss: true, isAbomination: false });
      }
      for (let i = 1; i < rooms.length - 1; i++) {
        const r = rooms[i];
        _placeEnemyInRoom(r, _randomEnemyType(), false, false);
      }
    } else {
      for (let i = 1; i < rooms.length; i++) {
        const r = rooms[i];
        const count = 1 + Math.floor(Math.random() * (1 + Math.min(level, 6)));
        for (let j = 0; j < count; j++) {
          _placeEnemyInRoom(r, _randomEnemyType(), false, false);
        }
      }
    }

    // Pickups
    const pickups = [];
    const pickupRooms = rooms.slice(1);
    pickupRooms.forEach((r, i) => {
      if (i % 3 === 0) {
        pickups.push({ type: 'health', x: r.x + 0.5 + Math.random() * (r.w - 1), y: r.y + 0.5 + Math.random() * (r.h - 1) });
      } else if (i % 3 === 1) {
        pickups.push({ type: 'ammo', x: r.x + 0.5 + Math.random() * (r.w - 1), y: r.y + 0.5 + Math.random() * (r.h - 1) });
      }
    });

    // ── Decorations ────────────────────────────────────────────────────────
    // Decor types that are "puddles" (floor-level rendering)
    const PUDDLE_TYPES = new Set(['puddleWater','puddleSlime','puddleBlood','puddleMud']);
    // Decor types that are "wall-adjacent" (cobwebs)
    const WALL_ADJACENT_TYPES = new Set(['cobweb']);
    // Types that need 2-wide room
    const TALL_TYPES = new Set(['pillar','bookshelf','table']);

    function _torchIsOnWall(tx, ty) {
      const gx = Math.floor(tx);
      const gy = Math.floor(ty);
      return (
        _isSolidWallLocal(gx,     gy - 1) ||
        _isSolidWallLocal(gx,     gy + 1) ||
        _isSolidWallLocal(gx - 1, gy    ) ||
        _isSolidWallLocal(gx + 1, gy    )
      );
    }

    const decor = [];
    for (let i = 1; i < rooms.length; i++) {
      const r = rooms[i];
      // Place 5-25 decorations per room
      const decorCount = 5 + Math.floor(Math.random() * 5);
      const decorTypes = theme.decors;

      for (let di = 0; di < decorCount; di++) {
        if (Math.random() > 0.75) continue;
        const type = decorTypes[Math.floor(Math.random() * decorTypes.length)];
        let dx, dy;

        if (WALL_ADJACENT_TYPES.has(type)) {
          // Place cobweb in a corner
          const corners = [
            [r.x + 0.5, r.y + 0.5],
            [r.x + r.w - 0.5, r.y + 0.5],
            [r.x + 0.5, r.y + r.h - 0.5],
            [r.x + r.w - 0.5, r.y + r.h - 0.5],
          ];
          const corner = corners[Math.floor(Math.random() * corners.length)];
          dx = corner[0]; dy = corner[1];
        } else {
          dx = r.x + 1 + Math.floor(Math.random() * Math.max(1, r.w - 2)) + 0.5;
          dy = r.y + 1 + Math.floor(Math.random() * Math.max(1, r.h - 2)) + 0.5;
        }

        decor.push({ type, x: dx, y: dy, zOffset: 0, isPuddle: PUDDLE_TYPES.has(type) });
      }
    }

    // Also scatter standalone puddles/bones/skulls in corridors (few random tiles)
    const SCATTER_TYPES = ['puddleBlood','puddleMud','puddleWater','bones','skull','claypot'];
    for (let yi = 1; yi < h - 1; yi++) {
      for (let xi = 1; xi < w - 1; xi++) {
        if (grid[yi][xi] !== 0) continue;
        if (Math.random() > 0.03) continue; // sparse
        const type = SCATTER_TYPES[Math.floor(Math.random() * SCATTER_TYPES.length)];
        decor.push({ type, x: xi + 0.5, y: yi + 0.5, zOffset: 0, isPuddle: PUDDLE_TYPES.has(type) });
      }
    }

    // ── Torches ──────────────────────────────────────────────────────────
    const torches = [];
    const usedWalls = new Set(); // prevent more than one torch per wall tile
    for (let ri = 0; ri < rooms.length; ri++) {
      const r = rooms[ri];
      const count = 1 + Math.floor(Math.random() * 2);
      for (let t = 0; t < count; t++) {
        const side = Math.floor(Math.random() * 4);
        let tx, ty, wallX, wallY, normX, normY;
        // side 0: north wall — torch on south face, faces south (+Y)
        // side 1: south wall — torch on north face, faces north (-Y)
        // side 2: west wall  — torch on east face,  faces east  (+X)
        // side 3: east wall  ��� torch on west face,  faces west  (-X)
        if      (side === 0) { tx = r.x + 1 + Math.floor(Math.random() * (r.w - 2)) + 0.5; ty = r.y + 0.5;       wallX = Math.floor(tx); wallY = r.y - 1;      normX =  0; normY =  1; }
        else if (side === 1) { tx = r.x + 1 + Math.floor(Math.random() * (r.w - 2)) + 0.5; ty = r.y + r.h - 0.5; wallX = Math.floor(tx); wallY = r.y + r.h;    normX =  0; normY = -1; }
        else if (side === 2) { tx = r.x + 0.5;       ty = r.y + 1 + Math.floor(Math.random() * (r.h - 2)) + 0.5; wallX = r.x - 1;        wallY = Math.floor(ty); normX =  1; normY =  0; }
        else                 { tx = r.x + r.w - 0.5; ty = r.y + 1 + Math.floor(Math.random() * (r.h - 2)) + 0.5; wallX = r.x + r.w;      wallY = Math.floor(ty); normX = -1; normY =  0; }
        if (!_torchIsOnWall(tx, ty)) continue;
        const wallKey = `${wallX},${wallY}`;
        if (usedWalls.has(wallKey)) continue;
        usedWalls.add(wallKey);
        torches.push({ x: tx, y: ty, wallX, wallY, normX, normY, flickerPhase: Math.random() * Math.PI * 2, flickerSpeed: 3 + Math.random() * 4, zOffset: 0 });
      }

      // Braziers: 30% chance per room (provide warmth like torches)
      if (Math.random() < 0.3 && r.w >= 3 && r.h >= 3) {
        const bx = r.x + 1 + Math.floor(Math.random() * (r.w - 2)) + 0.5;
        const by = r.y + 1 + Math.floor(Math.random() * (r.h - 2)) + 0.5;
        decor.push({ type: 'brazier', x: bx, y: by, zOffset: 0, isPuddle: false, isBrazier: true,
          flickerPhase: Math.random() * Math.PI * 2, flickerSpeed: 5 + Math.random() * 4 });
      }
    }

    // Exit portal
    const lastRoom = rooms[rooms.length - 1];
    let portalX = lastRoom.cx + 0.5;
    let portalY = lastRoom.cy + 0.5;
    if (_isSolidWallLocal(Math.floor(portalX), Math.floor(portalY))) {
      outer: for (let py = lastRoom.y; py < lastRoom.y + lastRoom.h; py++) {
        for (let px = lastRoom.x; px < lastRoom.x + lastRoom.w; px++) {
          if (!_isSolidWallLocal(px, py)) { portalX = px + 0.5; portalY = py + 0.5; break outer; }
        }
      }
    }
    const exitPortal = { x: portalX, y: portalY, active: false, zOffset: 0 };

    // ── Secret walls ────────────────────────────────────────────────────────
    // Secret walls are stored as toggleables — they do NOT set grid cells to 2.
    // The cell remains value 1 (solid wall) until the player opens it, at which
    // point main.js sets grid[y][x] = 0 to carve the passage.
    const SECRET_WALL_MIN = 5;
    const toggleables = []; // master list — both secret walls and gem doors
    const TREASURE_TYPES = ['health', 'ammo', 'score'];

    // Determine the facing of a toggleable: which direction does the open space face?
    function _wallFacing(wx, wy) {
      if (!_isSolidWallLocal(wx, wy - 1)) return 'N';
      if (!_isSolidWallLocal(wx, wy + 1)) return 'S';
      if (!_isSolidWallLocal(wx - 1, wy)) return 'W';
      if (!_isSolidWallLocal(wx + 1, wy)) return 'E';
      return 'N'; // fallback
    }

    function _tryPlaceSecret(ri) {
      const r = rooms[ri];
      const candidates = [];
      for (let x = r.x; x < r.x + r.w; x++) {
        candidates.push([x, r.y - 1]);
        candidates.push([x, r.y + r.h]);
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        candidates.push([r.x - 1, y]);
        candidates.push([r.x + r.w, y]);
      }
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      for (const [swx, swy] of candidates) {
        if (swx < 1 || swx >= w - 1 || swy < 1 || swy >= h - 1) continue;
        if (grid[swy][swx] !== 1) continue;

        // Count open neighbours — must be exactly 1 (inset rule).
        // A secret wall that juts out of a wall corner would expose side faces
        // that have no toggleable seg covering them, leaving rendering holes.
        // Exactly-one-open-face means the tile is flush/inset like a torch.
        let openFaces = 0;
        let openDir = null;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          if (!_isSolidWallLocal(swx + dx, swy + dy)) {
            openFaces++;
            openDir = [dx, dy];
          }
        }
        if (openFaces !== 1) continue;

        // Grid cell stays at 1 (solid wall) — toggleable is a separate object
        const treasure = TREASURE_TYPES[Math.floor(Math.random() * TREASURE_TYPES.length)];
        const facing = _wallFacing(swx, swy);
        toggleables.push({ type: 'secret', x: swx, y: swy, facing, treasure, unlocked: false, opened: false, isGemDoor: false, gemColor: null });
        return true;
      }
      return false;
    }

    for (let ri = 1; ri < rooms.length - 1; ri++) {
      if (Math.random() < 0.6) _tryPlaceSecret(ri);
    }
    // Count placed secrets so far
    const secretCount = () => toggleables.filter(t => t.type === 'secret').length;
    if (secretCount() < SECRET_WALL_MIN) {
      const midRooms = [];
      for (let ri = 1; ri < rooms.length - 1; ri++) midRooms.push(ri);
      for (let i = midRooms.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [midRooms[i], midRooms[j]] = [midRooms[j], midRooms[i]];
      }
      for (const ri of midRooms) {
        if (secretCount() >= SECRET_WALL_MIN) break;
        const r = rooms[ri];
        const alreadyHas = toggleables.some(t => t.type === 'secret' && t.x >= r.x - 1 && t.x <= r.x + r.w && t.y >= r.y - 1 && t.y <= r.y + r.h);
        if (!alreadyHas) _tryPlaceSecret(ri);
      }
    }

    // ── Gem Doors ───────────────────────────────────────────────────────────
    // Gem doors are stored as toggleables — they do NOT set grid cells to 3/4/5.
    // BFS testing: since the door tile must be a wall cell (value 1), we test
    // by treating it as already blocked (it is) — no temporary mutation needed.
    // We use open floor cells adjacent to the wall tile as the "corridor entry"
    // for connectivity tests instead.
    const gemKeyPickups = []; // { type, item, x, y, color }

    const numGemDoors = level < 3 ? 0 : Math.min(3, Math.floor(level / 4));

    // Helper: BFS collecting ALL reachable cells from (sx,sy), treating blockedFn cells as walls
    function _bfsFlood(sx, sy, blockedFn) {
      const visited = new Uint8Array(w * h);
      const reachable = new Set();
      const queue = [[sx, sy]];
      visited[sy * w + sx] = 1;
      reachable.add(sy * w + sx);
      while (queue.length > 0) {
        const [cx, cy] = queue.shift();
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (visited[ny * w + nx]) continue;
          if (blockedFn(nx, ny)) continue;
          visited[ny * w + nx] = 1;
          reachable.add(ny * w + nx);
          queue.push([nx, ny]);
        }
      }
      return reachable;
    }

    if (numGemDoors > 0 && rooms.length >= 4) {
      // Mid rooms: indices 2..length-2 (skip start=0 and last)
      const midRoomIndices = [];
      for (let ri = 2; ri < rooms.length - 1; ri++) midRoomIndices.push(ri);

      // Shuffle mid rooms
      for (let i = midRoomIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [midRoomIndices[i], midRoomIndices[j]] = [midRoomIndices[j], midRoomIndices[i]];
      }

      const usedColors = new Set();
      const gemDoorCount = () => toggleables.filter(t => t.type === 'gemdoor').length;

      for (const ri of midRoomIndices) {
        if (gemDoorCount() >= numGemDoors) break;

        const availColors = GEM_COLORS.filter(c => !usedColors.has(c));
        if (availColors.length === 0) break;
        const color = availColors[Math.floor(Math.random() * availColors.length)];

        const r = rooms[ri];

        // Collect border wall cells (value=1) just outside the room that border an open
        // corridor cell on the other side — these are viable gem door locations.
        const borderCandidates = [];
        const roomCells = new Set();
        for (let ry2 = r.y; ry2 < r.y + r.h; ry2++)
          for (let rx2 = r.x; rx2 < r.x + r.w; rx2++)
            roomCells.add(ry2 * w + rx2);

        for (let bx = r.x - 1; bx <= r.x + r.w; bx++) {
          for (let by = r.y - 1; by <= r.y + r.h; by++) {
            if (bx < 1 || bx >= w - 1 || by < 1 || by >= h - 1) continue;
            if (roomCells.has(by * w + bx)) continue;
            if (grid[by][bx] !== 1) continue; // door must be a solid wall cell
            // Must be adjacent to at least one room cell
            let adjRoom = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              if (roomCells.has((by+dy)*w+(bx+dx))) { adjRoom = true; break; }
            }
            if (!adjRoom) continue;
            // Must also be adjacent to at least one open cell outside the room (the corridor side)
            let adjOpen = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              const nx2 = bx + dx, ny2 = by + dy;
              if (!roomCells.has(ny2 * w + nx2) && grid[ny2] && grid[ny2][nx2] === 0) { adjOpen = true; break; }
            }
            if (adjOpen) borderCandidates.push([bx, by]);
          }
        }

        // Shuffle border candidates
        for (let i = borderCandidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [borderCandidates[i], borderCandidates[j]] = [borderCandidates[j], borderCandidates[i]];
        }

        for (const [dwx, dwy] of borderCandidates) {
          // BFS from start treating this wall cell as permanently blocked (it already is, value=1).
          // We want to check: does the room become unreachable WITHOUT using this cell?
          // Since cell is already 1 (blocked), we just BFS normally and see if room is unreachable.
          const reachable = _bfsFlood(startGX, startGY, (nx, ny) => {
            return grid[ny][nx] !== 0;
          });

          const roomReachable = (() => {
            for (let ry2 = r.y; ry2 < r.y + r.h; ry2++)
              for (let rx2 = r.x; rx2 < r.x + r.w; rx2++)
                if (grid[ry2][rx2] === 0 && reachable.has(ry2 * w + rx2)) return true;
            return false;
          })();

          if (!roomReachable) {
            // This wall cell is the bottleneck that gates the room — perfect door location!
            // Find key placement in the reachable zone.
            let keyX = -1, keyY = -1;

            let bestRoomIdx = -1, bestRoomSize = 0;
            for (let rri = 0; rri < rooms.length; rri++) {
              const rr = rooms[rri];
              if (rri === ri) continue;
              let cnt = 0;
              for (let ry2 = rr.y; ry2 < rr.y + rr.h; ry2++)
                for (let rx2 = rr.x; rx2 < rr.x + rr.w; rx2++)
                  if (grid[ry2][rx2] === 0 && reachable.has(ry2 * w + rx2)) cnt++;
              if (cnt > bestRoomSize) { bestRoomSize = cnt; bestRoomIdx = rri; }
            }

            if (bestRoomIdx >= 0) {
              const kr = rooms[bestRoomIdx];
              outer3: for (let ky = kr.y; ky < kr.y + kr.h; ky++) {
                for (let kx = kr.x; kx < kr.x + kr.w; kx++) {
                  if (grid[ky][kx] === 0 && reachable.has(ky * w + kx)) {
                    keyX = kx + 0.5; keyY = ky + 0.5; break outer3;
                  }
                }
              }
            }

            if (keyX < 0) {
              for (const cell of reachable) {
                const cx2 = cell % w, cy2 = Math.floor(cell / w);
                if (grid[cy2][cx2] === 0 && !roomCells.has(cell)) {
                  keyX = cx2 + 0.5; keyY = cy2 + 0.5; break;
                }
              }
            }

            if (keyX > 0) {
              usedColors.add(color);
              const facing = _wallFacing(dwx, dwy);
              toggleables.push({ type: 'gemdoor', x: dwx, y: dwy, facing, color, opened: false, unlocked: false, isGemDoor: true, gemColor: color, treasure: null });
              gemKeyPickups.push({ type: GEM_KEY_ITEMS[color], item: GEM_KEY_ITEMS[color], x: keyX, y: keyY, color });
              break;
            }
          }
        }
      }
    }
    // Build backwards-compat views for main.js interaction loops
    const secretWalls = toggleables.filter(t => t.type === 'secret');
    const gemDoors    = toggleables.filter(t => t.type === 'gemdoor');

    // ── BSP geometry ──────────────────────────────────────────────────────────
    //
    // Strategy:
    //   1. Assign every open floor cell a sector index.
    //      - Each room gets its own sector (index = room index).
    //      - Corridor cells (open but not inside any room rect) get a shared
    //        "corridor" sector per connected corridor run — we flood-fill from
    //        each unassigned open cell after rooms are assigned.
    //   2. Walk every open cell's 4 edges:
    //      - Edge toward a solid wall  → solid seg (frontSector = this cell's sector)
    //      - Edge toward open cell in SAME sector → no seg (interior, invisible)
    //      - Edge toward open cell in DIFFERENT sector → portal seg (two-sided)
    //   3. Build BSP from the collected segs.

    // ── Step 1: assign sector indices ────────────────────────────────────────
    const UNASSIGNED = -1;
    const sectorGrid = new Int16Array(w * h).fill(UNASSIGNED);

    // Room sectors — indices 0..rooms.length-1
    const sectors = rooms.map((r, i) => ({
      id:        i,
      isRoom:    true,
      floorH:    0,
      ceilH:     1,
      floorTex:  theme.floorKey,
      ceilTex:   theme.wallKey,
      lightLevel: 1.0,
    }));

    for (let ri = 0; ri < rooms.length; ri++) {
      const r = rooms[ri];
      for (let cy = r.y; cy < r.y + r.h; cy++) {
        for (let cx = r.x; cx < r.x + r.w; cx++) {
          if (grid[cy][cx] === 0) sectorGrid[cy * w + cx] = ri;
        }
      }
    }

    // Corridor sectors — flood-fill unassigned open cells
    let nextSectorId = rooms.length;
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (grid[cy][cx] !== 0) continue;
        if (sectorGrid[cy * w + cx] !== UNASSIGNED) continue;

        // New corridor sector — ceiling uses wall texture (same as rooms) but
        // with a darker lightLevel so halls feel tighter/shadier than rooms.
        const sid = nextSectorId++;
        sectors.push({
          id:        sid,
          isRoom:    false,
          floorH:    0,
          ceilH:     1,
          floorTex:  theme.floorKey,
          ceilTex:   theme.wallKey,   // same texture, darker via lightLevel
          lightLevel: 0.72,   // corridors noticeably darker than rooms (was 0.85)
        });

        // Flood-fill all connected unassigned open cells into this sector
        const queue = [[cx, cy]];
        sectorGrid[cy * w + cx] = sid;
        while (queue.length > 0) {
          const [qx, qy] = queue.pop();
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (grid[ny][nx] !== 0) continue;
            if (sectorGrid[ny * w + nx] !== UNASSIGNED) continue;
            sectorGrid[ny * w + nx] = sid;
            queue.push([nx, ny]);
          }
        }
      }
    }

    // ── Step 2: emit segs ───────────────���─────────────────────────────────────
    //
    // Each open cell's 4 edges are checked. We only emit each shared edge once
    // by only processing neighbour cells that are "ahead" (right or below) for
    // the interior/portal case, but we always emit solid segs facing outward.
    //
    // Edge directions and the seg they produce (winding: front = open space):
    //   North edge (y → y-1 is solid):  seg from (cx,cy) to (cx+1,cy)    — faces south (+Y)
    //   South edge (y+1 is solid):       seg from (cx+1,cy+1) to (cx,cy+1) — faces north (-Y)
    //   West  edge (x-1 is solid):       seg from (cx,cy+1) to (cx,cy)    — faces east  (+X)
    //   East  edge (x+1 is solid):       seg from (cx+1,cy) to (cx+1,cy+1)— faces west  (-X)
    //
    // Portal segs (between two open cells of different sectors) use the same
    // winding but carry both frontSector and backSector, plus TWO_SIDED flag.
    // We emit them only once: when the neighbour index is greater (right/south).
    //
    // IMPORTANT: toggleable tiles (secret walls, gem doors) are injected below
    // as SEG_FLAG_TOGGLEABLE segs.  We must NOT emit a regular solid seg for the
    // same face — that would produce two overlapping wall columns (double-wall).
    // Build a Set of toggleable tile keys so the edge loop can skip them.
    const _togTileKeys = new Set(toggleables.map(t => `${t.x},${t.y}`));

    const segs = [];

    // Resolve texId for a wall cell — pure solid wall, always the theme texture.
    // Toggleables (secret walls, gem doors) are NOT in the grid anymore so we
    // never need special texIds here.
    function _wallTexId(gx, gy) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return theme.wallKey;
      return theme.wallKey;
    }

    function _pushSolidSeg(x1, y1, x2, y2, frontSid, texId, wallGX, wallGY) {
      // Skip if this wall tile is a toggleable — the toggleable injection below
      // will emit its own SEG_FLAG_TOGGLEABLE seg for this face.  Emitting a
      // regular solid seg here too causes a double-wall (two stacked columns).
      if (_togTileKeys.has(`${wallGX},${wallGY}`)) return;
      const s = makeSeg(x1, y1, x2, y2, frontSid, -1, texId);
      s.wallTileX = wallGX;
      s.wallTileY = wallGY;
      segs.push(s);
    }

    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (grid[cy][cx] !== 0) continue;
        const sid = sectorGrid[cy * w + cx];

        // North edge: wall at (cx, cy-1), open space at (cx, cy) which is SOUTH of the wall.
        // Front face must point south (+Y) into open space.
        // Left-hand normal of seg (A→B) = (-dy, dx).  To get normal=(0,+1) we need dx=+1,dy=0
        // → seg goes LEFT-TO-RIGHT (west→east): (cx, cy) → (cx+1, cy).
        {
          const ny = cy - 1;
          if (ny < 0 || grid[ny][cx] !== 0) {
            _pushSolidSeg(cx, cy, cx + 1, cy, sid, _wallTexId(cx, ny), cx, ny);
          } else {
            const nsid = sectorGrid[ny * w + cx];
            if (nsid !== sid) {
              segs.push(makeSeg(cx, cy, cx + 1, cy, sid, nsid, null, SEG_FLAG_TWO_SIDED));
            }
          }
        }

        // South edge: wall at (cx, cy+1), open space at (cx, cy) which is NORTH of the wall.
        // Front face must point north (-Y).
        // Left-hand normal = (0,-1) requires dx=-1,dy=0
        // → seg goes RIGHT-TO-LEFT (east→west): (cx+1, cy+1) → (cx, cy+1).
        {
          const ny = cy + 1;
          if (ny >= h || grid[ny][cx] !== 0) {
            _pushSolidSeg(cx + 1, cy + 1, cx, cy + 1, sid, _wallTexId(cx, ny), cx, ny);
          } else {
            const nsid = sectorGrid[ny * w + cx];
            if (nsid !== sid && ny > cy) {
              segs.push(makeSeg(cx + 1, cy + 1, cx, cy + 1, sid, nsid, null, SEG_FLAG_TWO_SIDED));
            }
          }
        }

        // West edge: wall at (cx-1, cy), open space at (cx, cy) which is EAST of the wall.
        // Front face must point east → seg goes SOUTH-TO-NORTH (bottom→top, i.e. cy+1→cy).
        {
          const nx = cx - 1;
          if (nx < 0 || grid[cy][nx] !== 0) {
            _pushSolidSeg(cx, cy + 1, cx, cy, sid, _wallTexId(nx, cy), nx, cy);
          } else {
            const nsid = sectorGrid[cy * w + nx];
            if (nsid !== sid) {
              // Already emitted as east edge of (cx-1) — skip
            }
          }
        }

        // East edge: wall at (cx+1, cy), open space at (cx, cy) which is WEST of the wall.
        // Front face must point west → seg goes NORTH-TO-SOUTH (top→bottom, i.e. cy→cy+1).
        {
          const nx = cx + 1;
          if (nx >= w || grid[cy][nx] !== 0) {
            _pushSolidSeg(cx + 1, cy, cx + 1, cy + 1, sid, _wallTexId(nx, cy), nx, cy);
          } else {
            const nsid = sectorGrid[cy * w + nx];
            if (nsid !== sid && nx > cx) {
              segs.push(makeSeg(cx + 1, cy, cx + 1, cy + 1, sid, nsid, null, SEG_FLAG_TWO_SIDED));
            }
          }
        }
      }
    }

    // ── Step 2b: inject toggleable faces into the seg list ────────────────────
    //
    // Each toggleable (secret wall / gem door) is represented as a regular BSP seg
    // with SEG_FLAG_TOGGLEABLE set and a `toggleRef` pointing back to the toggleable
    // object.  The renderer checks seg.toggleRef.opened to decide whether to draw
    // the face or skip it entirely.
    //
    // Face winding follows the same convention as solid segs:
    //   facing 'N' → open space is SOUTH of the wall → seg runs west→east  (cx, cy) → (cx+1, cy)
    //   facing 'S' → open space is NORTH             → seg runs east→west  (cx+1, cy+1) → (cx, cy+1)
    //   facing 'W' → open space is EAST              → seg runs south→north (cx, cy+1) → (cx, cy)
    //   facing 'E' → open space is WEST              → seg runs north→south (cx+1, cy) → (cx+1, cy+1)
    //
    // The seg is given the frontSector of the open cell adjacent to the toggleable.
    // We use -1 for backSector (toggleable tile acts as void until opened).

    for (const tog of toggleables) {
      const tx = tog.x, ty = tog.y;
      let sx1, sy1, sx2, sy2;
      switch (tog.facing) {
        case 'N': sx1 = tx;     sy1 = ty;     sx2 = tx + 1; sy2 = ty;     break;
        case 'S': sx1 = tx + 1; sy1 = ty + 1; sx2 = tx;     sy2 = ty + 1; break;
        case 'W': sx1 = tx;     sy1 = ty + 1; sx2 = tx;     sy2 = ty;     break;
        case 'E': sx1 = tx + 1; sy1 = ty;     sx2 = tx + 1; sy2 = ty + 1; break;
        default:  sx1 = tx;     sy1 = ty;     sx2 = tx + 1; sy2 = ty;     break;
      }

      // Find the sector of the open cell that faces this toggleable
      let frontSid = 0;
      // The open cell is one step in the direction the face is looking FROM
      let ocx = tx, ocy = ty;
      switch (tog.facing) {
        case 'N': ocy = ty + 1; break; // face looks south; open cell is south of wall
        case 'S': ocy = ty - 1; break;
        case 'W': ocx = tx + 1; break;
        case 'E': ocx = tx - 1; break;
      }
      if (ocx >= 0 && ocx < w && ocy >= 0 && ocy < h) {
        const sid = sectorGrid[ocy * w + ocx];
        if (sid >= 0) frontSid = sid;
      }

      // Texture: gem door uses wallDoor key, secret uses theme wall key
      const togTexId = tog.type === 'gemdoor' ? 'wallDoor' : theme.wallKey;

      const ts = makeSeg(sx1, sy1, sx2, sy2, frontSid, -1, togTexId,
                         SEG_FLAG_TOGGLEABLE);
      ts.wallTileX = tx;
      ts.wallTileY = ty;
      ts.toggleRef = tog;
      segs.push(ts);
    }

    // ── Step 3: build BSP tree ────────────────────────────────────────────────
    const bspRoot = buildBSP(segs, sectors);
    const bspMap  = new BSPMap(bspRoot, segs, sectors);

    return {
      grid,
      sectorGrid,   // Int16Array(w*h) — cell (gx,gy) → sector index; -1 = solid
      width: w,
      height: h,
      startX,
      startY,
      startAngle: Math.random() * Math.PI * 2,
      enemies,
      pickups,
      decor,
      torches,
      exitPortal,
      exitWallX: -1,
      exitWallY: -1,
      secretDoorUnlocked: false,
      secretDoorOpen: false,
      toggleables,
      secretWalls,
      gemDoors,
      gemKeyPickups,
      rooms,
      theme,
      isBossLevel,
      isAbominationLevel,
      bspMap,
      isWall(x, y) {
        const gx = Math.floor(x);
        const gy = Math.floor(y);
        if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
        // Grid is purely 0/1 now. Toggleables open by setting grid[y][x]=0.
        return this.grid[gy][gx] === 1;
      },
      getCell(x, y) {
        const gx = Math.floor(x);
        const gy = Math.floor(y);
        if (gx < 0 || gx >= w || gy < 0 || gy >= h) return 1;
        return this.grid[gy][gx];
      },
      checkPickup(px, py) {
        const r = 0.4;
        for (let i = 0; i < this.pickups.length; i++) {
          const p = this.pickups[i];
          const dx = p.x - px, dy = p.y - py;
          if (dx*dx + dy*dy < r*r) return i;
        }
        return -1;
      },
      checkGemKeyPickup(px, py) {
        const r = 0.45;
        for (let i = 0; i < this.gemKeyPickups.length; i++) {
          const p = this.gemKeyPickups[i];
          if (p.collected) continue;
          const dx = p.x - px, dy = p.y - py;
          if (dx*dx + dy*dy < r*r) return i;
        }
        return -1;
      }
    };
  }

  static _roomFits(grid, rx, ry, rw, rh) {
    for (let y = ry - 1; y < ry + rh + 1; y++) {
      for (let x = rx - 1; x < rx + rw + 1; x++) {
        if (y < 0 || y >= grid.length || x < 0 || x >= grid[0].length) return false;
        if (grid[y][x] === 0) return false;
      }
    }
    return true;
  }

  static _carveRoom(grid, rx, ry, rw, rh) {
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        grid[y][x] = 0;
      }
    }
  }

  static _carveCorridor(grid, x1, y1, x2, y2) {
    let x = x1, y = y1;
    while (x !== x2) {
      if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) grid[y][x] = 0;
      x += x2 > x1 ? 1 : -1;
    }
    while (y !== y2) {
      if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) grid[y][x] = 0;
      y += y2 > y1 ? 1 : -1;
    }
    if (y >= 0 && y < grid.length && x >= 0 && x < grid[0].length) grid[y][x] = 0;
  }
}

// ── Dirty BSP rebake ──────────────────────────────────────────────────────────
//
// Call this whenever an interactive object (secret wall, gem door, or any
// future dynamic object) changes the map topology.  It re-runs the full
// sector-assignment + seg-emission + BSP build against the map's *current*
// grid and toggleables, then hotswaps map.bspMap in-place.
//
// Cost: O(W×H) for sector flood-fill + O(segs²) for BSP build.
// Typical map: ~40×40 cells → a few thousand segs → <2 ms on modern hardware.
// Only called on player interaction, never per-frame.
//
export function rebakeBSP(map) {
  const grid        = map.grid;
  const w           = map.width;
  const h           = map.height;
  const rooms       = map.rooms;
  const toggleables = map.toggleables;
  const theme       = map.theme;

  // ── Step 1: sector assignment ─────────────────────────────────────────────
  const UNASSIGNED = -1;
  const sectorGrid = new Int16Array(w * h).fill(UNASSIGNED);

  const sectors = rooms.map((r, i) => ({
    id:         i,
    isRoom:     true,
    floorH:     0,
    ceilH:      1,
    floorTex:   theme.floorKey,
    ceilTex:    theme.wallKey,
    lightLevel: 1.0,
  }));

  // Assign room sectors
  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    for (let cy = r.y; cy < r.y + r.h; cy++) {
      for (let cx = r.x; cx < r.x + r.w; cx++) {
        if (grid[cy] && grid[cy][cx] === 0) sectorGrid[cy * w + cx] = ri;
      }
    }
  }

  // Flood-fill remaining open cells (corridors + newly opened toggleable cells)
  let nextSectorId = rooms.length;
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (grid[cy][cx] !== 0) continue;
      if (sectorGrid[cy * w + cx] !== UNASSIGNED) continue;

      const sid = nextSectorId++;
      sectors.push({
        id:         sid,
        isRoom:     false,
        floorH:     0,
        ceilH:      1,
        floorTex:   theme.floorKey,
        ceilTex:    theme.wallKey,
        lightLevel: 0.72,
      });

      const queue = [[cx, cy]];
      sectorGrid[cy * w + cx] = sid;
      while (queue.length > 0) {
        const [qx, qy] = queue.pop();
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          if (grid[ny][nx] !== 0) continue;
          if (sectorGrid[ny * w + nx] !== UNASSIGNED) continue;
          sectorGrid[ny * w + nx] = sid;
          queue.push([nx, ny]);
        }
      }
    }
  }

  // ── Step 2: seg emission ──────────────────────────────────────────────────
  // Build a set of toggleable tile keys for which we must NOT emit a regular
  // solid seg (their faces are covered by SEG_FLAG_TOGGLEABLE segs below).
  // Opened toggleables have grid[y][x]=0 already, so the open-cell loop sees
  // them as floor and produces portal segs naturally — no toggleable seg needed.
  const _togTileKeys = new Set(
    toggleables.filter(t => !t.opened).map(t => `${t.x},${t.y}`)
  );

  const segs = [];

  function _wallTexId() { return theme.wallKey; }

  function _pushSolidSeg(x1, y1, x2, y2, frontSid, texId, wallGX, wallGY) {
    if (_togTileKeys.has(`${wallGX},${wallGY}`)) return;
    const s = makeSeg(x1, y1, x2, y2, frontSid, -1, texId);
    s.wallTileX = wallGX;
    s.wallTileY = wallGY;
    segs.push(s);
  }

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      if (grid[cy][cx] !== 0) continue;
      const sid = sectorGrid[cy * w + cx];

      // North edge
      {
        const ny = cy - 1;
        if (ny < 0 || grid[ny][cx] !== 0) {
          _pushSolidSeg(cx, cy, cx + 1, cy, sid, _wallTexId(), cx, ny);
        } else {
          const nsid = sectorGrid[ny * w + cx];
          if (nsid !== sid) {
            segs.push(makeSeg(cx, cy, cx + 1, cy, sid, nsid, null, SEG_FLAG_TWO_SIDED));
          }
        }
      }

      // South edge
      {
        const ny = cy + 1;
        if (ny >= h || grid[ny][cx] !== 0) {
          _pushSolidSeg(cx + 1, cy + 1, cx, cy + 1, sid, _wallTexId(), cx, ny);
        } else {
          const nsid = sectorGrid[ny * w + cx];
          if (nsid !== sid && ny > cy) {
            segs.push(makeSeg(cx + 1, cy + 1, cx, cy + 1, sid, nsid, null, SEG_FLAG_TWO_SIDED));
          }
        }
      }

      // West edge
      {
        const nx = cx - 1;
        if (nx < 0 || grid[cy][nx] !== 0) {
          _pushSolidSeg(cx, cy + 1, cx, cy, sid, _wallTexId(), nx, cy);
        }
        // else: already emitted as east edge of (cx-1) — skip
      }

      // East edge
      {
        const nx = cx + 1;
        if (nx >= w || grid[cy][nx] !== 0) {
          _pushSolidSeg(cx + 1, cy, cx + 1, cy + 1, sid, _wallTexId(), nx, cy);
        } else {
          const nsid = sectorGrid[cy * w + nx];
          if (nsid !== sid && nx > cx) {
            segs.push(makeSeg(cx + 1, cy, cx + 1, cy + 1, sid, nsid, null, SEG_FLAG_TWO_SIDED));
          }
        }
      }
    }
  }

  // Inject still-closed toggleable faces as SEG_FLAG_TOGGLEABLE segs
  for (const tog of toggleables) {
    if (tog.opened) continue; // opened cells are now real floor — no seg needed

    const tx = tog.x, ty = tog.y;
    let sx1, sy1, sx2, sy2;
    switch (tog.facing) {
      case 'N': sx1 = tx;     sy1 = ty;     sx2 = tx + 1; sy2 = ty;     break;
      case 'S': sx1 = tx + 1; sy1 = ty + 1; sx2 = tx;     sy2 = ty + 1; break;
      case 'W': sx1 = tx;     sy1 = ty + 1; sx2 = tx;     sy2 = ty;     break;
      case 'E': sx1 = tx + 1; sy1 = ty;     sx2 = tx + 1; sy2 = ty + 1; break;
      default:  sx1 = tx;     sy1 = ty;     sx2 = tx + 1; sy2 = ty;     break;
    }

    let ocx = tx, ocy = ty;
    switch (tog.facing) {
      case 'N': ocy = ty + 1; break;
      case 'S': ocy = ty - 1; break;
      case 'W': ocx = tx + 1; break;
      case 'E': ocx = tx - 1; break;
    }

    let frontSid = 0;
    if (ocx >= 0 && ocx < w && ocy >= 0 && ocy < h) {
      const sid = sectorGrid[ocy * w + ocx];
      if (sid >= 0) frontSid = sid;
    }

    const togTexId = tog.type === 'gemdoor' ? 'wallDoor' : theme.wallKey;
    const ts = makeSeg(sx1, sy1, sx2, sy2, frontSid, -1, togTexId, SEG_FLAG_TOGGLEABLE);
    ts.wallTileX = tx;
    ts.wallTileY = ty;
    ts.toggleRef = tog;
    segs.push(ts);
  }

  // ── Step 3: build BSP and hotswap ────────────────────────────────────────
  const bspRoot = buildBSP(segs, sectors);
  map.bspMap      = new BSPMap(bspRoot, segs, sectors);
  map.sectorGrid  = sectorGrid;   // also refresh sectorGrid so renderer sees new topology
}
