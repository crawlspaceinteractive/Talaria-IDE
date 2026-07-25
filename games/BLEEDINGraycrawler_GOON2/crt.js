/**
 * crt.js — CRT post-process overlay via Three.js
 *
 * ARCHITECTURE:
 *   The WebGL overlay canvas is mounted on document.body with position:fixed
 *   covering 100vw × 100vh at z-index:9999.  It sits ABOVE every game element
 *   (canvas, HUD, menus, modals) acting as a true screen wrapper.
 *   pointer-events:none ensures all input passes through.
 *
 *   The game canvas gets CSS filter:contrast(1.25) for the retro contrast boost.
 *   The overlay canvas gets CSS filter:blur(1px) for phosphor softness.
 *
 *   WebGL uses alpha:true.  The shader only outputs opaque (alpha=1) pixels where
 *   the CRT darkens the image — scanline dark rows, shadowmask, barrel border,
 *   vignette — and near-zero alpha on bright pixels so underlying DOM shows through.
 */

let THREE = null;

async function ensureThree() {
  if (THREE) return THREE;
  const mod = await import(
    "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js"
  );
  THREE = mod;
  return THREE;
}

// ---------------------------------------------------------------------------
// Vertex shader — fullscreen quad
// ---------------------------------------------------------------------------
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Fragment shader — outputs only darkness (transparent where bright)
//
// Key insight: we output black with varying alpha.
//   alpha = 0  → fully see-through (bright areas pass DOM content through)
//   alpha = 1  → fully opaque black (dark rows, barrel border, vignette)
//
// This composites multiplicatively over everything beneath — HUD, menus,
// game canvas — applying the CRT effect to the whole screen.
// ---------------------------------------------------------------------------
const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform vec2  uVirtualRes;
  uniform float uDarkness;
  uniform float uMaskStrength;
  uniform int   uMaskType;
  uniform float uFlicker;
  uniform float uWarp;
  uniform float uSweep;
  uniform float uTime;

  vec2 warpCoords(vec2 uv, float bend) {
    if (bend == 0.0) return uv;
    vec2 dc = uv - 0.5;
    float dist = dot(dc, dc);
    dc *= 1.0 + dist * bend * (1.0 + dist * bend);
    return dc + 0.5;
  }

  void main() {
    vec2 screenUv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 warpedUv = warpCoords(screenUv, uWarp);

    /* Black barrel border */
    if (warpedUv.x < 0.0 || warpedUv.x > 1.0 ||
        warpedUv.y < 0.0 || warpedUv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    vec2 coord = warpedUv * uVirtualRes;

    /* Start with 0 darkness (fully transparent) */
    float dark = 0.0;

    /* Scanlines — every other row gets darkened */
    float scanRow = mod(floor(coord.y), 2.0);
    if (scanRow >= 1.0) {
      dark = max(dark, 1.0 - uDarkness);  /* uDarkness=0.9 → dark=0.1 */
    }

    /* Shadowmask */
    if (uMaskType == 0) {
      float xm = mod(floor(coord.x), 3.0);
      float subDim = (xm < 1.0) ? 0.0 : (xm < 2.0) ? 0.08 : 0.14;
      dark = max(dark, subDim);
    } else if (uMaskType == 1) {
      float dg = mod(floor(coord.x) + mod(floor(coord.y), 2.0) * 1.5, 3.0);
      if (dg >= 1.5) dark = max(dark, 1.0 - uMaskStrength);
    } else {
      float vg = mod(floor(coord.x), 2.0);
      if (vg >= 1.0) dark = max(dark, 1.0 - uMaskStrength);
    }

    /* Vignette — darken edges */
    vec2 vd = warpedUv - 0.5;
    float vig = dot(vd, vd) * 1.2;
    dark = max(dark, vig * 0.35);

    /* Rolling sweep bar — brief bright streak (adds slight glow, doesn't darken) */
    float sweepBar = sin((warpedUv.y * 4.0) - (uTime * 0.003));
    float sweepLight = (sweepBar > 0.95) ? uSweep : 0.0;
    dark = max(0.0, dark - sweepLight);

    /* 60 Hz flicker */
    dark = clamp(dark + uFlicker, 0.0, 1.0);

    /* Output: black at computed alpha */
    gl_FragColor = vec4(0.0, 0.0, 0.0, dark);
  }
`;

// ---------------------------------------------------------------------------
// Defaults  (1px blur, 1.25 contrast as requested)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  scale:       600,    // virtual vertical resolution for scanlines
  darkness:    0.90,   // scanline bright-row multiplier (0.9 = 10% dim)
  maskStr:     0.88,   // shadowmask weight
  maskType:    0,      // 0=RGB stripe, 1=diagonal, 2=vertical
  flicker:     0.02,   // 60Hz flicker amplitude
  warp:        0.08,   // barrel distortion
  sweep:       0.04,   // rolling sweep bar intensity
  softness:    1.0,    // CSS blur(px) on overlay canvas
  sharpness:   1.25,   // CSS contrast() on game canvas
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * createCRT(mountEl, gameCanvas, opts?)
 *   mountEl    — the game container (used only to find the canvas; overlay goes on body)
 *   gameCanvas — the game's 2D canvas element
 *   Returns a handle for tickCRT().
 */
export async function createCRT(mountEl, gameCanvas, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  await ensureThree();

  // Apply contrast boost to the game canvas so the 3D view pops
  gameCanvas.style.filter = `contrast(${cfg.sharpness})`;

  // Remove any existing overlay
  const existing = document.getElementById('crt-overlay');
  if (existing) existing.remove();

  // Create the overlay canvas and mount it on document.body at position:fixed
  // so it truly covers everything — game canvas, HUD, menus — regardless of DOM order.
  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.id = 'crt-overlay';
  overlayCanvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
    filter: blur(${cfg.softness}px);
    pointer-events: none;
    z-index: 9999;
    image-rendering: pixelated;
  `;
  document.body.appendChild(overlayCanvas);

  // Three.js WebGL renderer — alpha:true so transparent pixels pass through
  const threeRenderer = new THREE.WebGLRenderer({
    canvas:            overlayCanvas,
    alpha:             true,
    antialias:         false,
    premultipliedAlpha: false,
  });
  threeRenderer.setPixelRatio(1);
  threeRenderer.setClearColor(0x000000, 0); // transparent clear

  const scene  = new THREE.Scene();
  const cam    = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const uniforms = {
    uVirtualRes:   { value: new THREE.Vector2(160, cfg.scale) },
    uDarkness:     { value: cfg.darkness   },
    uMaskStrength: { value: cfg.maskStr    },
    uMaskType:     { value: cfg.maskType   },
    uFlicker:      { value: 0.0            },
    uWarp:         { value: cfg.warp       },
    uSweep:        { value: cfg.sweep      },
    uTime:         { value: 0.0            },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms,
    transparent:    true,
    blending:       THREE.NormalBlending,
    depthTest:      false,
    depthWrite:     false,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  const handle = { threeRenderer, scene, cam, uniforms, cfg, overlayCanvas };
  _resize(handle);
  window.addEventListener('resize', () => _resize(handle));

  return handle;
}

function _resize(handle) {
  const { threeRenderer, uniforms, cfg } = handle;
  const w = window.innerWidth  || 640;
  const h = window.innerHeight || 480;
  threeRenderer.setSize(w, h);
  const aspect = w / h;
  uniforms.uVirtualRes.value.set(cfg.scale * aspect, cfg.scale);
}

/**
 * tickCRT(handle, timestamp)
 *   Call once per frame (after game draw).
 */
export function tickCRT(handle, timestamp) {
  if (!handle) return;
  const { threeRenderer, scene, cam, uniforms, cfg } = handle;
  uniforms.uFlicker.value = Math.abs(Math.sin(timestamp * 0.05) * cfg.flicker);
  uniforms.uTime.value    = timestamp;
  threeRenderer.render(scene, cam);
}
