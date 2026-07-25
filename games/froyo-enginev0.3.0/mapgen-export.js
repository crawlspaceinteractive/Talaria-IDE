/**
 * mapgen-export.js — Helpers for exporting Froyo worldgen data into an editor
 * scene format and restoring world metadata from scene exports.
 */

const DEFAULT_RENDER = {
  width: 320,
  height: 200,
  bgColor: '#ffffff',
  bgType: 'solid',
  bgGradA: '#1a0040',
  bgGradB: '#004080',
  bgGradDir: 'to bottom',
  bgImageFit: 'cover',
};

const DEFAULT_LIGHTING = { ambient: 60, sun: 120 };
const DEFAULT_CAMERA = { position: [0, 2, 5], target: [0, 0, 0] };
const DEFAULT_TITLE = {
  text: '', colorMode: 'flat', color: '#ffffff',
  gradA: '#ff4488', gradB: '#44aaff', gradDir: '90deg',
  size: 40, depth: 2, font: '', fontRaw: '', pos: { x: 0, y: 0 },
};

function padHex(value) {
  const hex = Number(value).toString(16).padStart(6, '0');
  return `#${hex}`;
}

function normalizeColor(value) {
  if (typeof value === 'number') return padHex(value >>> 0);
  if (typeof value === 'string') return value;
  return '#888888';
}

function parseColor(value) {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return 0xff000000 | Number.parseInt(hex, 16);
    }
    if (/^[0-9a-fA-F]{8}$/.test(hex)) {
      return Number.parseInt(hex, 16) >>> 0;
    }
  }
  return 0xff888888;
}

function makePlatformName(platform, index) {
  if (platform.type === 'parent') return 'Portal island';
  if (platform.type === 'bridge') return `Bridge ${index}`;
  if (platform.type === 'island' && platform.biome) return `Island (${platform.biome}) ${index}`;
  return `Platform ${index}`;
}

function summarizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return blocks.map(b => ({
    wx: b.wx, wy: b.wy, wz: b.wz,
    sx: b.sx, sy: b.sy, sz: b.sz,
    shape: b.shape || null,
    yaw: b.yaw || 0,
    top: normalizeColor(b.top),
    side: normalizeColor(b.side),
  }));
}

export function worldPlatformToSceneObject(platform, index = 0) {
  return {
    name: makePlatformName(platform, index),
    type: platform.glbModel ? 'GLB' : 'PRIM',
    triCount: platform.glbModel?.faceCount || 0,
    shadeMode: 'base',
    baseColor: normalizeColor(platform.color),
    gradColorA: '#ff4488',
    gradColorB: '#44aaff',
    gradAxis: 'y',
    textureRepeat: 1,
    autoRotate: false,
    transform: {
      position: [platform.x, platform.y, platform.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    mapgen: {
      worldType: platform.type,
      biome: platform.biome || null,
      glbName: platform.glbName || null,
      glbScaleMul: platform.glbScaleMul || 1.0,
      moving: !!platform.moving,
      moveAxis: platform.moveAxis || null,
      moveAmp: platform.moveAmp || null,
      color: normalizeColor(platform.color),
      sideColor: normalizeColor(platform.side),
      blocks: summarizeBlocks(platform.blocks),
      portal: !!platform.isPortalIsland,
    },
  };
}

export function worldToSceneData(world, options = {}) {
  const render = { ...DEFAULT_RENDER, ...(options.render || {}) };
  const lighting = { ...DEFAULT_LIGHTING, ...(options.lighting || {}) };
  const camera = { ...(options.camera || DEFAULT_CAMERA) };
  const title = { ...DEFAULT_TITLE, ...(options.title || {}) };

  const objects = Array.isArray(world.platforms)
    ? world.platforms.map((platform, index) => worldPlatformToSceneObject(platform, index))
    : [];

  return {
    _version: 1,
    meta: {
      createdAt: new Date().toISOString(),
      source: 'froyo-mapgen',
      seed: options.seed ?? null,
      renderer: 'froyo-engine',
    },
    render,
    lighting,
    camera,
    title,
    objects,
    mapgen: {
      spawn: world.spawn || null,
      portal: world.portal || null,
      crystals: world.crystals || null,
      enemies: world.enemies || null,
      breakables: world.breakables || null,
      decorations: world.decorations || null,
      windZones: world.windZones || null,
      voronoiCells: world.voronoiCells ? world.voronoiCells.map(cell => ({
        angle: cell.angle,
        arcHalf: cell.arcHalf,
        minR: cell.minR,
        maxR: cell.maxR,
      })) : null,
      platforms: world.platforms ? world.platforms.map(platform => ({
        type: platform.type,
        x: platform.x, y: platform.y, z: platform.z,
        sx: platform.sx, sy: platform.sy, sz: platform.sz,
        biome: platform.biome || null,
        glbName: platform.glbName || null,
        glbScaleMul: platform.glbScaleMul || 1.0,
        moving: !!platform.moving,
        moveAxis: platform.moveAxis || null,
        moveAmp: platform.moveAmp || null,
        blocks: summarizeBlocks(platform.blocks),
      })) : null,
    },
  };
}

function parsePlatform(platform) {
  const p = {
    ...platform,
    color: parseColor(platform.color),
    side: parseColor(platform.side),
  };
  if (Array.isArray(p.blocks)) {
    p.blocks = p.blocks.map(b => ({
      ...b,
      top: parseColor(b.top),
      side: parseColor(b.side),
    }));
  }

  // If the platform carries an inline mesh (from scene editor export),
  // convert it into a runtime-like `glbModel` so physics/rendering can
  // operate directly on triangle faces.
  if (p.inlineMesh) {
    try {
      const im = p.inlineMesh;

      let verts, indices, normals = null, colors = null;

      // New compact binary format: im.bin (base64) with header; or legacy arrays
      if (typeof im.bin === 'string') {
        // Decode base64 to ArrayBuffer
        let binary = null;
        if (typeof atob === 'function') {
          const str = atob(im.bin);
          const buf = new Uint8Array(str.length);
          for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
          binary = buf.buffer;
        } else if (typeof Buffer !== 'undefined') {
          // Node fallback (unlikely in browser) for tests
          const b = Buffer.from(im.bin, 'base64');
          binary = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
        if (!binary) throw new Error('base64 decode failed');

        const dv = new DataView(binary);
        // Check magic 'IMSH'
        const m0 = dv.getUint8(0), m1 = dv.getUint8(1), m2 = dv.getUint8(2), m3 = dv.getUint8(3);
        if (m0 !== 0x49 || m1 !== 0x4d || m2 !== 0x53 || m3 !== 0x48) throw new Error('bad inlineMesh magic');
        let off = 4;
        const vCount = dv.getUint32(off, true); off += 4;
        const nCount = dv.getUint32(off, true); off += 4;
        const iCount = dv.getUint32(off, true); off += 4;
        const cCount = dv.getUint32(off, true); off += 4;

        verts = new Float32Array(binary, off, vCount); off += vCount * 4;
        if (nCount > 0) normals = new Float32Array(binary, off, nCount), off += nCount * 4;
        indices = new Uint32Array(binary, off, iCount); off += iCount * 4;
        if (cCount > 0) colors = new Uint8Array(binary, off, cCount), off += cCount;
      } else if (Array.isArray(im.vertices) && Array.isArray(im.indices)) {
        verts = Float32Array.from(im.vertices);
        indices = Uint32Array.from(im.indices);
        normals = im.normals ? Float32Array.from(im.normals) : null;
        colors = im.colors ? Uint8Array.from(im.colors) : null;
      }

      if (verts && indices) {
        // Compute bounding box of raw mesh vertices
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let vi = 0; vi < verts.length; vi += 3) {
          const vx = verts[vi], vy = verts[vi + 1], vz = verts[vi + 2];
          if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
          if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
          if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
        }

        // Bounding box center — used to pivot the model at its own center,
        // matching how islandatlas.js builds faces (centered, then world-translated).
        const localCX = (minX + maxX) * 0.5;
        const localCY = (minY + maxY) * 0.5;
        const localCZ = (minZ + maxZ) * 0.5;

        // Scene editor normalizes each loaded GLB to fit 2 world units on its
        // longest axis (scale = 2 / maxDim), then applies the user's transform
        // scale on top. We recover the effective uniform scale from the transform.
        const txScale = p.transform?.scale ?? [1, 1, 1];
        const uniformScale = Array.isArray(txScale)
          ? Math.max(txScale[0] ?? 1, txScale[1] ?? 1, txScale[2] ?? 1)
          : 1;
        // glbScaleMul is an additional engine-side multiplier (e.g. 2× for portal island)
        const scaleMul = (p.glbScaleMul ?? 1.0) * uniformScale;

        // Half-extents in world units (raw mesh units × combined scale)
        const rawHalfW = (maxX - minX) * 0.5;
        const rawHalfD = (maxZ - minZ) * 0.5;
        const rawHalfH = (maxY - minY) * 0.5;
        const halfW = rawHalfW * scaleMul;
        const halfD = rawHalfD * scaleMul;
        // topY: distance from model origin (localCY) to top surface, in world units
        const topY  = rawHalfH * scaleMul;

        // Build faces with vertices centered around localCX/CY/CZ but NOT
        // pre-scaled. Physics multiplies by glbScaleMul at collision time,
        // and buildMeshTris multiplies by model.scale at render time.
        const faceCount = (indices.length / 3) | 0;
        const faces = new Float32Array(faceCount * 9);
        for (let i = 0; i < faceCount; i++) {
          const i0 = indices[i * 3] * 3;
          const i1 = indices[i * 3 + 1] * 3;
          const i2 = indices[i * 3 + 2] * 3;
          faces[i * 9 + 0] = verts[i0]     - localCX;
          faces[i * 9 + 1] = verts[i0 + 1] - localCY;
          faces[i * 9 + 2] = verts[i0 + 2] - localCZ;
          faces[i * 9 + 3] = verts[i1]     - localCX;
          faces[i * 9 + 4] = verts[i1 + 1] - localCY;
          faces[i * 9 + 5] = verts[i1 + 2] - localCZ;
          faces[i * 9 + 6] = verts[i2]     - localCX;
          faces[i * 9 + 7] = verts[i2 + 1] - localCY;
          faces[i * 9 + 8] = verts[i2 + 2] - localCZ;
        }

        // Store localCX/CY/CZ on meshData so buildMeshTris (geometry.js) can
        // apply the same centering pivot when rendering.
        const meshData = { vertices: verts, normals, indices, colors,
                           localCX, localCY, localCZ };

        const model = {
          meshData,
          faces,
          faceCount,
          topY,
          halfW,
          halfD,
          // model.scale = 1.0 so game.js effectiveScale = 1.0 * glbScaleMul = scaleMul
          scale: 1.0,
          id: p.name || null,
        };

        p.glbModel = model;
        // World position: the scene editor's transform.position is the Three.js
        // world center of the model (after normalization). The engine treats
        // glbWorldX/Y/Z as the model's pivot (same as localCX/CY/CZ offset).
        const txPos = p.transform?.position ?? [p.x ?? 0, p.y ?? 0, p.z ?? 0];
        p.glbWorldX = Array.isArray(txPos) ? (txPos[0] ?? p.x ?? 0) : (p.x ?? 0);
        p.glbWorldY = Array.isArray(txPos) ? (txPos[1] ?? p.y ?? 0) : (p.y ?? 0);
        p.glbWorldZ = Array.isArray(txPos) ? (txPos[2] ?? p.z ?? 0) : (p.z ?? 0);

        // Engine platform position: walkable surface = glbWorldY + topY
        p.x = p.glbWorldX;
        p.y = p.glbWorldY + topY;
        p.z = p.glbWorldZ;

        // Half-extents for AABB broad-phase (physics + frustum cull)
        p.sx = halfW;
        p.sy = topY;
        p.sz = halfD;

        // Ensure type is set for renderer/physics routing
        if (!p.type) p.type = 'island';

        // glbScaleMul carries the full effective scale so physics.js (which multiplies
        // faces by glbScaleMul) and game.js (effectiveScale = model.scale * glbScaleMul)
        // both produce the correct world-unit geometry.
        p.glbScaleMul = scaleMul;
      }
    } catch (e) {
      console.warn('Failed to convert inlineMesh to glbModel', e);
    }
    // remove inline mesh payload to keep world smaller
    delete p.inlineMesh;
  }
  return p;
}

export function sceneDataToWorld(sceneData) {
  if (!sceneData) return null;
  const world = {
    spawn: sceneData.mapgen?.spawn || null,
    portal: sceneData.mapgen?.portal || null,
    crystals: Array.isArray(sceneData.mapgen?.crystals) ? sceneData.mapgen.crystals : [],
    enemies: Array.isArray(sceneData.mapgen?.enemies) ? sceneData.mapgen.enemies : [],
    breakables: Array.isArray(sceneData.mapgen?.breakables) ? sceneData.mapgen.breakables : [],
    decorations: Array.isArray(sceneData.mapgen?.decorations) ? sceneData.mapgen.decorations : [],
    windZones: Array.isArray(sceneData.mapgen?.windZones) ? sceneData.mapgen.windZones : [],
    voronoiCells: Array.isArray(sceneData.mapgen?.voronoiCells) ? sceneData.mapgen.voronoiCells : [],
    platforms: Array.isArray(sceneData.mapgen?.platforms) ? sceneData.mapgen.platforms.map(parsePlatform) : [],
  };

  if ((!world.platforms || world.platforms.length === 0) && Array.isArray(sceneData.objects)) {
    const inferred = sceneData.objects
      .filter(obj => obj.mapgen)
      .map(obj => parsePlatform({
        ...obj.mapgen,
        // Pass the full transform so parsePlatform can read position + scale
        transform: obj.transform,
        x: obj.transform?.position?.[0] ?? 0,
        y: obj.transform?.position?.[1] ?? 0,
        z: obj.transform?.position?.[2] ?? 0,
        name: obj.name,
        type: obj.mapgen?.worldType || obj.type || 'island',
      }));

    if (inferred.length > 0) {
      world.platforms = inferred;
    }
  }

  // For scene-editor exports that include both mapgen.platforms (engine layout)
  // AND objects[].mapgen.inlineMesh (embedded geometry), patch the inline mesh
  // onto already-parsed platforms so they can render + collide without needing
  // the original GLB files.
  if (world.platforms.length > 0 && Array.isArray(sceneData.objects)) {
    for (const obj of sceneData.objects) {
      if (!obj.mapgen?.inlineMesh) continue;
      // Match by name or position to find the corresponding platform
      const objName = obj.name || '';
      const objX = obj.transform?.position?.[0] ?? 0;
      const objY = obj.transform?.position?.[1] ?? 0;
      const objZ = obj.transform?.position?.[2] ?? 0;
      const match = world.platforms.find(p =>
        (p.glbName && objName.toLowerCase().includes(p.glbName.toLowerCase())) ||
        (Math.abs(p.x - objX) < 0.5 && Math.abs(p.z - objZ) < 0.5)
      );
      if (match && !match.glbModel) {
        // Re-parse just this platform with the inline mesh attached
        const patched = parsePlatform({
          ...obj.mapgen,
          transform: obj.transform,
          x: objX, y: objY, z: objZ,
          name: obj.name,
          type: match.type || 'island',
          glbScaleMul: match.glbScaleMul ?? 1.0,
        });
        if (patched.glbModel) {
          match.glbModel  = patched.glbModel;
          match.glbWorldX = patched.glbWorldX;
          match.glbWorldY = patched.glbWorldY;
          match.glbWorldZ = patched.glbWorldZ;
          // Keep the engine layout's sx/sz/sy (already correct from worldToSceneData)
          if (!match.sx) match.sx = patched.sx;
          if (!match.sz) match.sz = patched.sz;
        }
      }
    }
  }

  if (Array.isArray(sceneData.objects)) {
    const objects = sceneData.objects;
    if (!Array.isArray(world.enemies)) world.enemies = [];
    if (!Array.isArray(world.crystals)) world.crystals = [];
    if (!Array.isArray(world.breakables)) world.breakables = [];
    if (!Array.isArray(world.decorations)) world.decorations = [];

    for (const obj of objects) {
      const name = (obj.name || '').toLowerCase();
      const pos = {
        x: obj.transform?.position?.[0] ?? 0,
        y: obj.transform?.position?.[1] ?? 0,
        z: obj.transform?.position?.[2] ?? 0,
      };

      if (name.includes('froyo') || name.includes('spawn') || name.includes('player')) {
        world.spawn = pos;
      }

      if (name.includes('portal')) {
        world.portal = {
          x: pos.x,
          y: pos.y,
          z: pos.z,
          target: world.spawn || { x: 0, y: 0, z: 0 },
          radius: 1.0,
        };
      }

      if (name.includes('sun')) {
        world.enemies.push({
          x: pos.x,
          y: pos.y,
          z: pos.z,
          frozen: false,
          frozenT: 0,
          hp: name.includes('boss') ? 6 : 2,
          bobPhase: 0,
          boss: name.includes('boss'),
          hitRadius: name.includes('boss') ? 5.5 : 2.0,
        });
      }

      if (name.includes('sprinkle') || name.includes('crystal')) {
        world.crystals.push({
          x: pos.x,
          y: pos.y,
          z: pos.z,
          broken: false,
          shatterT: 0,
        });
      }

      if (name.includes('breakable') || name.includes('crate')) {
        world.breakables.push({
          x: pos.x,
          y: pos.y,
          z: pos.z,
          broken: false,
          shatterT: 0,
        });
      }
    }
  }

  if (!world.spawn || typeof world.spawn.x !== 'number' || typeof world.spawn.y !== 'number' || typeof world.spawn.z !== 'number') {
    world.spawn = { x: 0, y: 1, z: 0 };
  }

  if (!world.portal || typeof world.portal.x !== 'number' || typeof world.portal.y !== 'number' || typeof world.portal.z !== 'number') {
    world.portal = {
      x: 0,
      y: world.spawn.y,
      z: 0,
      target: { ...world.spawn },
      radius: 1.0,
    };
  } else if (!world.portal.target || typeof world.portal.target.x !== 'number') {
    world.portal.target = { ...world.spawn };
  }

  return world;
}
