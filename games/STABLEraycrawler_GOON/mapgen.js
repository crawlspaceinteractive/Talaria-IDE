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
export const GEM_WALL_IDS = { red: 3, green: 4, blue: 5 }; // grid cell values for gem doors
export const GEM_KEY_ITEMS = { red: 'gem_red', green: 'gem_green', blue: 'gem_blue' };

// ── BFS reachability check ────────────────────────────────────────────────
// Returns true if worldPos (wx,wy) is reachable from (startX,startY) walking
// only through cells that pass the walkable predicate (does not treat gemWallId as blocked).
function _bfsReachable(grid, w, h, startGX, startGY, targetGX, targetGY, blockedFn) {
  if (startGX === targetGX && startGY === targetGY) return true;
  const visited = new Uint8Array(w * h);
  const queue = [[startGX, startGY]];
  visited[startGY * w + startGX] = 1;
  while (queue.length > 0) {
    const [cx, cy] = queue.shift();
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (visited[ny * w + nx]) continue;
      if (blockedFn(nx, ny)) continue;
      visited[ny * w + nx] = 1;
      if (nx === targetGX && ny === targetGY) return true;
      queue.push([nx, ny]);
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

    // ── Solid wall check (for non-gem-door logic) ──────────────────────────
    function _isSolidWallLocal(gx, gy) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
      const v = grid[gy][gx];
      return v === 1 || v === 2; // 3/4/5 are gem doors, passable for BFS purposes
    }

    function _isSolidWallFull(gx, gy) {
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
      const v = grid[gy][gx];
      return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
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
        // side 3: east wall  — torch on west face,  faces west  (-X)
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

    // ── Secret walls ──────────────────────────────────────────────────────���─
    const SECRET_WALL_MIN = 5;
    const secretWalls = [];
    const TREASURE_TYPES = ['health', 'ammo', 'score'];

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
        let adjOpen = false;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          if (!_isSolidWallLocal(swx + dx, swy + dy)) { adjOpen = true; break; }
        }
        if (!adjOpen) continue;
        grid[swy][swx] = 2;
        const treasure = TREASURE_TYPES[Math.floor(Math.random() * TREASURE_TYPES.length)];
        secretWalls.push({ x: swx, y: swy, treasure, unlocked: false, opened: false, isGemDoor: false, gemColor: null });
        return true;
      }
      return false;
    }

    for (let ri = 1; ri < rooms.length - 1; ri++) {
      if (Math.random() < 0.6) _tryPlaceSecret(ri);
    }
    if (secretWalls.length < SECRET_WALL_MIN) {
      const midRooms = [];
      for (let ri = 1; ri < rooms.length - 1; ri++) midRooms.push(ri);
      for (let i = midRooms.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [midRooms[i], midRooms[j]] = [midRooms[j], midRooms[i]];
      }
      for (const ri of midRooms) {
        if (secretWalls.length >= SECRET_WALL_MIN) break;
        const r = rooms[ri];
        const alreadyHas = secretWalls.some(s => s.x >= r.x - 1 && s.x <= r.x + r.w && s.y >= r.y - 1 && s.y <= r.y + r.h);
        if (!alreadyHas) _tryPlaceSecret(ri);
      }
    }

    // ── Gem Doors ───────────────────────────────────────────────────────────
    // Strategy: BFS-flood from start room to find ALL reachable open cells,
    // then for each candidate mid-room, scan its border cells (open corridor
    // tiles adjacent to the room) as door candidates.  A candidate is valid
    // if temporarily walling it off makes the mid-room's center unreachable
    // from start.  Key is placed in the largest reachable-from-start room.
    const gemDoors = []; // { x, y, color, opened }
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

      for (const ri of midRoomIndices) {
        if (gemDoors.length >= numGemDoors) break;

        const availColors = GEM_COLORS.filter(c => !usedColors.has(c));
        if (availColors.length === 0) break;
        const color = availColors[Math.floor(Math.random() * availColors.length)];
        const doorId = GEM_WALL_IDS[color];

        const r = rooms[ri];

        // Collect border corridor cells: open-floor (value 0) cells just outside the room rect
        // that connect the room to the rest of the dungeon.
        const borderCandidates = [];
        const roomCells = new Set();
        for (let ry2 = r.y; ry2 < r.y + r.h; ry2++)
          for (let rx2 = r.x; rx2 < r.x + r.w; rx2++)
            roomCells.add(ry2 * w + rx2);

        for (let bx = r.x - 1; bx <= r.x + r.w; bx++) {
          for (let by = r.y - 1; by <= r.y + r.h; by++) {
            if (bx < 1 || bx >= w - 1 || by < 1 || by >= h - 1) continue;
            if (roomCells.has(by * w + bx)) continue;
            if (grid[by][bx] !== 0 && grid[by][bx] !== 1) continue; // only open floor or plain wall
            // Must be adjacent to at least one room cell
            let adjRoom = false;
            for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
              if (roomCells.has((by+dy)*w+(bx+dx))) { adjRoom = true; break; }
            }
            if (adjRoom) borderCandidates.push([bx, by]);
          }
        }

        // Shuffle border candidates
        for (let i = borderCandidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [borderCandidates[i], borderCandidates[j]] = [borderCandidates[j], borderCandidates[i]];
        }

        let placed = false;
        for (const [dwx, dwy] of borderCandidates) {
          const origVal = grid[dwy][dwx];
          // Temporarily place the gem door here
          grid[dwy][dwx] = doorId;

          // BFS from start: does the room center become unreachable?
          const reachable = _bfsFlood(startGX, startGY, (nx, ny) => {
            const v = grid[ny][nx];
            return v === 1 || v === 2 || v === doorId;
          });

          const roomReachable = reachable.has(r.cy * w + r.cx) ||
            // also check any open cell in the room
            (() => {
              for (let ry2 = r.y; ry2 < r.y + r.h; ry2++)
                for (let rx2 = r.x; rx2 < r.x + r.w; rx2++)
                  if (grid[ry2][rx2] === 0 && reachable.has(ry2 * w + rx2)) return true;
              return false;
            })();

          if (!roomReachable) {
            // Door successfully gates the room. Find key placement in reachable zone.
            let keyX = -1, keyY = -1;

            // Prefer rooms reachable from start — pick the one with most open cells (biggest safe room)
            let bestRoomIdx = -1, bestRoomSize = 0;
            for (let rri = 0; rri < rooms.length; rri++) {
              const rr = rooms[rri];
              if (rri === ri) continue; // don't put key in gated room
              // Count open cells in this room that are reachable
              let cnt = 0;
              for (let ry2 = rr.y; ry2 < rr.y + rr.h; ry2++)
                for (let rx2 = rr.x; rx2 < rr.x + rr.w; rx2++)
                  if (grid[ry2][rx2] === 0 && reachable.has(ry2 * w + rx2)) cnt++;
              if (cnt > bestRoomSize) { bestRoomSize = cnt; bestRoomIdx = rri; }
            }

            if (bestRoomIdx >= 0) {
              const kr = rooms[bestRoomIdx];
              // Place key near center of that room
              outer3: for (let ky = kr.y; ky < kr.y + kr.h; ky++) {
                for (let kx = kr.x; kx < kr.x + kr.w; kx++) {
                  if (grid[ky][kx] === 0 && reachable.has(ky * w + kx)) {
                    keyX = kx + 0.5; keyY = ky + 0.5; break outer3;
                  }
                }
              }
            }

            // Fallback: any reachable open cell not in the gated room
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
              gemDoors.push({ x: dwx, y: dwy, color, opened: false });
              gemKeyPickups.push({ type: GEM_KEY_ITEMS[color], item: GEM_KEY_ITEMS[color], x: keyX, y: keyY, color });
              placed = true;
              break;
            }
          }

          // Revert if not successfully placed
          if (!placed) {
            grid[dwy][dwx] = origVal;
          }
        }
      }
    }

    return {
      grid,
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
      secretWalls,
      gemDoors,
      gemKeyPickups,
      rooms,
      theme,
      isBossLevel,
      isAbominationLevel,
      isWall(x, y) {
        const gx = Math.floor(x);
        const gy = Math.floor(y);
        if (gx < 0 || gx >= w || gy < 0 || gy >= h) return true;
        const cell = this.grid[gy][gx];
        if (cell === 2) {
          const sw = this.secretWalls.find(s => s.x === gx && s.y === gy);
          return sw ? !sw.opened : true;
        }
        if (cell === 3 || cell === 4 || cell === 5) {
          const gd = this.gemDoors.find(d => d.x === gx && d.y === gy);
          return gd ? !gd.opened : true;
        }
        return cell === 1;
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
