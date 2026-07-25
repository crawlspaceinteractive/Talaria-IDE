/**
 * track.js — Inline spline track system for the Froyo Racer engine
 *
 * A track is defined as an array of CONTROL POINTS (plain objects) directly
 * in the game code — no external files, no asset loading.
 *
 * Control point schema:
 *   { x, y, z,          — world-space position of the centreline
 *     width,            — half-width of the road (left + right of centreline)
 *     surface,          — SURFACE.* (defaults to SURFACE.TARMAC)
 *     bankAngle,        — lateral bank in degrees (positive = banked left / into corner)
 *     wallLeft,         — boolean: build a barrier on the left edge
 *     wallRight,        — boolean: build a barrier on the right edge
 *   }
 *
 * Interpolation:
 *   Catmull-Rom spline through all control points.
 *   TRACK_SUBDIVISIONS sub-segments are generated between each pair of
 *   consecutive control points, giving smooth curves without hand-placing
 *   every vertex.
 *
 * Segment schema (generated, used by physics + renderer):
 *   { cx, cy, cz,       — segment centreline position
 *     nx, nz,           — outward normal (XZ plane) — left/right edge direction
 *     tx, tz,           — tangent (forward direction along track)
 *     width,            — half-width (left + right)
 *     bankAngle,
 *     surface,
 *     wallLeft,
 *     wallRight,
 *     segIndex,         — index into _segments[]
 *   }
 *
 * Main exports:
 *   buildTrack(controlPoints)  — compile control points → segment array
 *   getTrackMesh(track, camera)— per-frame triangle list for the renderer
 *   nearestSegment(track, x, z)— fast nearest-segment lookup for physics
 *   surfaceAt(track, x, z)     — SURFACE.* for the car's current position
 *   groundYAt(track, x, z)     — road surface Y with banking applied
 *
 * Bundled tracks:
 *   TRACK_HIGHLAND_CIRCUIT     — sweeping mountain loop
 *   TRACK_CITY_SPRINT          — tight urban figure-8
 *   TRACK_COASTAL_LOOP         — long high-speed coastal ring
 */

import {
  SURFACE, SURFACE_LUT,
  sinDeg, cosDeg,
} from "./luts.js";
import { rgba } from "./ps1fx.js";
import { buildFace } from "./renderer.js";

// ---- Constants ---------------------------------------------------------------
const TRACK_SUBDIVISIONS = 6;  // Catmull-Rom steps between each pair of control points
const WALL_HEIGHT        = 1.8; // metres
const WALL_THICKNESS     = 0.3;

// Road colours (packed ABGR as used by the software renderer)
const COLOR_TARMAC       = rgba(48,  48,  52);   // near-black asphalt
const COLOR_TARMAC_MARK  = rgba(220, 220, 210);  // lane markings
const COLOR_GRAVEL       = rgba(170, 155, 115);
const COLOR_GRASS        = rgba(55,  130, 50);
const COLOR_KERB_A       = rgba(220, 30,  30);   // red kerb stripe
const COLOR_KERB_B       = rgba(240, 240, 240);  // white kerb stripe
const COLOR_WALL         = rgba(200, 195, 185);  // concrete barrier

// Surface colour lookup (indexed by SURFACE.*)
const SURFACE_COLORS = [
  COLOR_TARMAC,   // TARMAC
  COLOR_GRAVEL,   // GRAVEL
  COLOR_GRASS,    // GRASS
  COLOR_KERB_A,   // KERB — alternated per segment with COLOR_KERB_B in the builder
];

// ---- buildTrack -------------------------------------------------------------
/**
 * Compile an array of raw control points into a flat segment array.
 *
 * @param {Array}  pts — control points (see schema above)
 * @returns {object}   — { segments, length, closed }
 *   segments — Float32-backed segment array
 *   length   — total arc length (world units)
 *   closed   — whether the last segment connects back to the first
 */
export function buildTrack(pts) {
  if (!pts || pts.length < 2) throw new Error("[track] Need at least 2 control points");
  const closed = _isClosedLoop(pts);
  const segments = [];

  // Catmull-Rom through pts
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];

    for (let s = 0; s < TRACK_SUBDIVISIONS; s++) {
      const t  = s / TRACK_SUBDIVISIONS;
      const t1 = (s + 1) / TRACK_SUBDIVISIONS;

      // Interpolate position and properties
      const pos  = _catmullRom(p0, p1, p2, p3, t);
      const pos1 = _catmullRom(p0, p1, p2, p3, t1);

      // Tangent = forward direction along the track
      const tx = pos1.x - pos.x;
      const tz = pos1.z - pos.z;
      const tLen = Math.sqrt(tx * tx + tz * tz) || 1;
      const txN = tx / tLen;
      const tzN = tz / tLen;

      // Normal (90° to tangent, in XZ plane)
      const nx =  tzN;
      const nz = -txN;

      // Lerp properties
      const t01 = t;
      const width      = p1.width      + (p2.width      - p1.width)      * t01;
      const bankAngle  = (p1.bankAngle ?? 0) + ((p2.bankAngle ?? 0) - (p1.bankAngle ?? 0)) * t01;
      const surface    = t01 < 0.5 ? (p1.surface ?? SURFACE.TARMAC) : (p2.surface ?? SURFACE.TARMAC);
      const wallLeft   = p1.wallLeft  ?? false;
      const wallRight  = p1.wallRight ?? false;

      segments.push({
        cx: pos.x, cy: pos.y, cz: pos.z,
        nx, nz, tx: txN, tz: tzN,
        width,
        bankAngle,
        surface,
        wallLeft,
        wallRight,
        segIndex: segments.length,
      });
    }
  }

  // Arc length
  let length = 0;
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i - 1], b = segments[i];
    const dx = b.cx - a.cx, dz = b.cz - a.cz;
    length += Math.sqrt(dx * dx + dz * dz);
  }

  return { segments, length, closed, controlPoints: pts };
}

// ---- nearestSegment ---------------------------------------------------------
/**
 * Find the index of the segment closest to (x, z).
 * Uses a linear scan — fast enough for a single car at 60fps.
 * For multiple cars or AI, cache and walk forward from last result.
 *
 * @param {object} track  — result of buildTrack()
 * @param {number} x, z
 * @returns {number}      — index into track.segments[]
 */
export function nearestSegment(track, x, z) {
  const segs = track.segments;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = x - s.cx, dz = z - s.cz;
    const d = dx * dx + dz * dz;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// ---- surfaceAt --------------------------------------------------------------
/**
 * Return the SURFACE.* constant under position (x, z).
 * If the car is outside the road width → SURFACE.GRASS.
 */
export function surfaceAt(track, x, z) {
  const idx = nearestSegment(track, x, z);
  const seg = track.segments[idx];

  // Lateral distance from centreline
  const dx = x - seg.cx, dz = z - seg.cz;
  const lat = dx * seg.nx + dz * seg.nz; // signed lateral offset
  const absLat = Math.abs(lat);

  if (absLat > seg.width + 1.2) return SURFACE.GRASS;  // well off road
  if (absLat > seg.width - 0.4) return SURFACE.KERB;    // on the kerb
  return seg.surface;
}

// ---- groundYAt --------------------------------------------------------------
/**
 * Return the world Y of the road surface at (x, z), with banking applied.
 * Banking tilts the road laterally — the car Y should match this.
 */
export function groundYAt(track, x, z) {
  const idx = nearestSegment(track, x, z);
  const seg = track.segments[idx];

  // Lateral offset from centreline
  const dx = x - seg.cx, dz = z - seg.cz;
  const lat = dx * seg.nx + dz * seg.nz;

  // Banking: road tilts by bankAngle degrees across its width
  const bankRad = (seg.bankAngle ?? 0) * Math.PI / 180;
  const bankY   = lat * Math.sin(bankRad);

  return seg.cy + bankY;
}

// ---- getTrackMesh -----------------------------------------------------------
/**
 * Build the per-frame triangle list for the visible portion of the track.
 * Only segments within the camera frustum (rough sphere test) are meshed.
 *
 * @param {object} track   — built track
 * @param {object} camera  — engine camera (x, y, z, yaw, pitch, fovMul)
 * @param {number} frame   — current frame count (for kerb colour animation)
 * @returns {Array}        — triangle records for renderer.drawTris()
 */
export function getTrackMesh(track, camera, frame) {
  const segs = track.segments;
  const tris = [];
  const CULL_DIST_SQ = 160 * 160; // only mesh within 160 world units

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const dx = s.cx - camera.x, dz = s.cz - camera.z;
    if (dx * dx + dz * dz > CULL_DIST_SQ) continue;

    const next = segs[(i + 1) % segs.length];

    // Road quad: four corners
    //   left/right of current segment → left/right of next segment
    const bankRad = (s.bankAngle ?? 0) * Math.PI / 180;
    const bankSlope = Math.sin(bankRad);
    const halfW = s.width;

    const lx0 = s.cx    - s.nx * halfW,  lz0 = s.cz    - s.nz * halfW,  ly0 = s.cy    - halfW * bankSlope;
    const rx0 = s.cx    + s.nx * halfW,  rz0 = s.cz    + s.nz * halfW,  ry0 = s.cy    + halfW * bankSlope;

    const bankNext = (next.bankAngle ?? 0) * Math.PI / 180;
    const bankSlopeN = Math.sin(bankNext);
    const halfWN = next.width;

    const lx1 = next.cx - next.nx * halfWN, lz1 = next.cz - next.nz * halfWN, ly1 = next.cy - halfWN * bankSlopeN;
    const rx1 = next.cx + next.nx * halfWN, rz1 = next.cz + next.nz * halfWN, ry1 = next.cy + halfWN * bankSlopeN;

    // Pick road colour
    let roadColor;
    if (s.surface === SURFACE.KERB) {
      roadColor = (i & 2) ? COLOR_KERB_A : COLOR_KERB_B;
    } else {
      roadColor = SURFACE_COLORS[s.surface] ?? COLOR_TARMAC;
    }

    // Road surface quad (two triangles)
    const roadPts = [
      { x: lx0, y: ly0, z: lz0 },
      { x: rx0, y: ry0, z: rz0 },
      { x: rx1, y: ry1, z: rz1 },
      { x: lx1, y: ly1, z: lz1 },
    ];
    for (const t of buildFace(roadPts, roadColor, camera)) tris.push(t);

    // Gravel trap / grass runoff strips (±0.5 extra on each side)
    const RUNOFF = 3.5;
    const runoffColor = rgba(150, 138, 100); // dirt/gravel mix

    const gllx = lx0 - s.nx * RUNOFF,  gllz = lz0 - s.nz * RUNOFF,  glly = ly0;
    const gllx1= lx1 - next.nx * RUNOFF, gllz1 = lz1 - next.nz * RUNOFF, glly1 = ly1;
    for (const t of buildFace([
      { x: gllx,  y: glly,  z: gllz  },
      { x: lx0,   y: ly0,   z: lz0   },
      { x: lx1,   y: ly1,   z: lz1   },
      { x: gllx1, y: glly1, z: gllz1 },
    ], runoffColor, camera)) tris.push(t);

    const grrx = rx0 + s.nx * RUNOFF,  grrz = rz0 + s.nz * RUNOFF,  grry = ry0;
    const grrx1= rx1 + next.nx * RUNOFF, grrz1 = rz1 + next.nz * RUNOFF, grry1 = ry1;
    for (const t of buildFace([
      { x: rx0,   y: ry0,   z: rz0   },
      { x: grrx,  y: grry,  z: grrz  },
      { x: grrx1, y: grry1, z: grrz1 },
      { x: rx1,   y: ry1,   z: rz1   },
    ], runoffColor, camera)) tris.push(t);

    // Barriers / armco
    if (s.wallLeft)  _buildWall(lx0, ly0, lz0, lx1, ly1, lz1, tris, camera);
    if (s.wallRight) _buildWall(rx0, ry0, rz0, rx1, ry1, rz1, tris, camera);
  }

  return tris;
}

// ---- Internal helpers -------------------------------------------------------

function _buildWall(x0, y0, z0, x1, y1, z1, tris, camera) {
  const h = WALL_HEIGHT;
  const pts = [
    { x: x0, y: y0,     z: z0 },
    { x: x1, y: y1,     z: z1 },
    { x: x1, y: y1 + h, z: z1 },
    { x: x0, y: y0 + h, z: z0 },
  ];
  for (const t of buildFace(pts, COLOR_WALL, camera)) tris.push(t);
}

function _isClosedLoop(pts) {
  const first = pts[0], last = pts[pts.length - 1];
  const dx = first.x - last.x, dz = first.z - last.z;
  return Math.sqrt(dx * dx + dz * dz) < 5.0;
}

/** Catmull-Rom interpolation between p1 and p2 (p0 and p3 are neighbours). */
function _catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2*p1.x) + (-p0.x + p2.x)*t + (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*t2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x)*t3),
    y: 0.5 * ((2*p1.y) + (-p0.y + p2.y)*t + (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*t2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y)*t3),
    z: 0.5 * ((2*p1.z) + (-p0.z + p2.z)*t + (2*p0.z - 5*p1.z + 4*p2.z - p3.z)*t2 + (-p0.z + 3*p1.z - 3*p2.z + p3.z)*t3),
  };
}

// ============================================================================
// BUNDLED TRACKS — inline control point arrays
// ============================================================================

/**
 * TRACK_HIGHLAND_CIRCUIT
 * A flowing mountain loop with sweeping cambered bends, a long back straight,
 * and one tight hairpin.  All surfaces tarmac except a gravel trap section.
 * Length ≈ 3.2 km equivalent at world scale.
 */
export const TRACK_HIGHLAND_CIRCUIT = buildTrack([
  // Start/finish straight
  { x:   0, y:  0,   z:   0,  width: 7, wallLeft: true,  wallRight: true  },
  { x:  30, y:  0,   z:   0,  width: 7, wallLeft: false, wallRight: false },
  { x:  60, y:  0,   z:   0,  width: 7 },
  // Turn 1: sweeping right
  { x:  90, y:  0,   z:   5,  width: 7, bankAngle: -8 },
  { x: 115, y:  0,   z:  20,  width: 7, bankAngle: -10 },
  { x: 130, y:  0,   z:  40,  width: 7, bankAngle: -8  },
  // Short straight climbing
  { x: 132, y:  2,   z:  65,  width: 7 },
  { x: 130, y:  4,   z:  90,  width: 7 },
  // Hairpin — wide entry, tight apex
  { x: 125, y:  5,   z: 115,  width: 9  },
  { x: 110, y:  5.5, z: 128,  width: 7, bankAngle: 12 },
  { x:  90, y:  5.5, z: 132,  width: 6, bankAngle: 14 },
  { x:  70, y:  5,   z: 128,  width: 7, bankAngle: 10 },
  { x:  58, y:  4.5, z: 115,  width: 8  },
  // Back straight — long flat section, gravel trap on entry
  { x:  50, y:  3,   z:  95,  width: 7, surface: SURFACE.GRAVEL },
  { x:  48, y:  2,   z:  75,  width: 7 },
  { x:  45, y:  1,   z:  55,  width: 8, wallLeft: true  },
  { x:  42, y:  0,   z:  35,  width: 8 },
  { x:  30, y:  0,   z:  18,  width: 7 },
  // Close loop back to start
  { x:   0, y:  0,   z:   0,  width: 7, wallLeft: true, wallRight: true  },
]);

/**
 * TRACK_CITY_SPRINT
 * Tight technical layout through an urban block grid.
 * Lots of 90° corners, armco on both sides, no elevation.
 */
export const TRACK_CITY_SPRINT = buildTrack([
  { x:   0, y: 0, z:   0,  width: 5.5, wallLeft: true, wallRight: true },
  { x:  40, y: 0, z:   0,  width: 5.5, wallLeft: true, wallRight: true },
  { x:  55, y: 0, z:  10,  width: 5,   wallLeft: true, wallRight: true },
  { x:  60, y: 0, z:  35,  width: 5,   wallLeft: true, wallRight: true },
  { x:  60, y: 0, z:  60,  width: 5.5, wallLeft: true, wallRight: true },
  { x:  50, y: 0, z:  72,  width: 5,   bankAngle:  6,  wallLeft: true, wallRight: true },
  { x:  30, y: 0, z:  75,  width: 5,   wallLeft: true, wallRight: true },
  { x:  10, y: 0, z:  75,  width: 5,   wallLeft: true, wallRight: true },
  { x:  -5, y: 0, z:  65,  width: 5,   wallLeft: true, wallRight: true },
  { x:  -8, y: 0, z:  45,  width: 5.5, wallLeft: true, wallRight: true },
  { x:  -5, y: 0, z:  25,  width: 5,   wallLeft: true, wallRight: true },
  { x:   0, y: 0, z:   0,  width: 5.5, wallLeft: true, wallRight: true },
]);

/**
 * TRACK_COASTAL_LOOP
 * Long, high-speed circuit hugging an imaginary coastline.
 * Wide road, elevation changes, kerb zones on fast sweepers.
 */
export const TRACK_COASTAL_LOOP = buildTrack([
  { x:   0, y:  0,  z:   0,   width: 9  },
  { x:  60, y:  0,  z:   0,   width: 9  },
  { x: 120, y:  0,  z:  10,   width: 9,  bankAngle: -6  },
  { x: 160, y:  2,  z:  40,   width: 8,  bankAngle: -10 },
  { x: 170, y:  5,  z:  80,   width: 8  },
  { x: 165, y:  8,  z: 120,   width: 9,  bankAngle:  5  },
  { x: 145, y: 10,  z: 150,   width: 9,  bankAngle:  8  },
  { x: 110, y: 10,  z: 165,   width: 9  },
  { x:  75, y:  9,  z: 162,   width: 8,  bankAngle: -5, surface: SURFACE.KERB },
  { x:  45, y:  7,  z: 150,   width: 8,  bankAngle: -8  },
  { x:  20, y:  4,  z: 130,   width: 9  },
  { x:   5, y:  2,  z: 100,   width: 9,  wallRight: true },
  { x:   0, y:  0,  z:  60,   width: 9,  wallRight: true },
  { x:   0, y:  0,  z:   0,   width: 9  },
]);

// ---- Track registry — easy lookup by name -----------------------------------
export const TRACKS = {
  highland: TRACK_HIGHLAND_CIRCUIT,
  city:     TRACK_CITY_SPRINT,
  coastal:  TRACK_COASTAL_LOOP,
};
