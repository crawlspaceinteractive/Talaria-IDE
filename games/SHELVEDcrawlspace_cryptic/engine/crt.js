/**
 * crt.js — CRT post-process overlay via Three.js
 *
 * Each frame the game's 2D canvas is uploaded as a WebGL texture.
 * The CRT shader samples that texture, warps it with barrel distortion,
 * overlays scanlines + shadowmask + sweep bar, and blits to the overlay
 * canvas that sits on top.  The game canvas is hidden once CRT is active.
 *
 * Usage:
 *   import { createCRT, tickCRT } from "./crt.js";
 *   const crt = await createCRT(mountEl, gameCanvas);
 *   // in your game loop:
 *   tickCRT(crt, timestamp);
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
// Shader — samples the game canvas texture, applies CRT effects.
// ---------------------------------------------------------------------------
const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uScreen;    // game canvas texture
  uniform vec2  uVirtualRes;    // scanline grid resolution
  uniform float uDarkness;      // scanline opacity (dark row brightness)
  uniform float uMaskStrength;  // shadowmask base weight
  uniform int   uMaskType;
  uniform float uFlicker;
  uniform float uWarp;
  uniform float uSweep;
  uniform int   uColorMode;
  uniform float uTime;
  uniform float uSharpness;     // unsharp-mask radius in UV units
  uniform vec2  uTexelSize;     // 1/textureSize

  vec2 warpCoords(vec2 uv, float bend) {
    if (bend == 0.0) return uv;
    vec2 dc = uv - 0.5;
    float dist = dot(dc, dc);
    dc *= 1.0 + dist * bend * (1.0 + dist * bend);
    return dc + 0.5;
  }

  /* Simple 5-sample unsharp mask — sharpens game image before CRT processing */
  vec3 sharpen(sampler2D tex, vec2 uv, float strength) {
    float s = strength;
    vec3 center = texture2D(tex, uv).rgb;
    vec3 blur =
      texture2D(tex, uv + vec2( s,  0.0)).rgb +
      texture2D(tex, uv + vec2(-s,  0.0)).rgb +
      texture2D(tex, uv + vec2( 0.0,  s)).rgb +
      texture2D(tex, uv + vec2( 0.0, -s)).rgb;
    blur *= 0.25;
    return clamp(center + (center - blur) * 1.5, 0.0, 1.0);
  }

  void main() {
    /* Three.js UVs have origin at bottom-left; flip Y to match canvas top-left */
    vec2 screenUv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 warpedUv = warpCoords(screenUv, uWarp);

    /* Outside warped bounds → black border */
    if (warpedUv.x < 0.0 || warpedUv.x > 1.0 ||
        warpedUv.y < 0.0 || warpedUv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    /* Sample the game canvas (flip Y for GL origin) — with optional sharpen */
    vec2 sampleUv = vec2(warpedUv.x, 1.0 - warpedUv.y);
    vec3 color;
    if (uSharpness > 0.0) {
      color = sharpen(uScreen, sampleUv, uSharpness * uTexelSize.x);
    } else {
      color = texture2D(uScreen, sampleUv).rgb;
    }

    vec2 coord = warpedUv * uVirtualRes;

    /* Scanlines — dark rows at (1 - uDarkness) attenuation */
    float scanline = mod(floor(coord.y), 2.0) < 1.0 ? 1.0 : uDarkness;
    color *= scanline;

    /* Shadowmask */
    vec3 mask = vec3(uMaskStrength);
    if (uMaskType == 0) {
      float xm = mod(floor(coord.x), 3.0);
      if (xm < 1.0)      mask.r = 1.0;
      else if (xm < 2.0) mask.g = 1.0;
      else               mask.b = 1.0;
    } else if (uMaskType == 1) {
      float dg = mod(floor(coord.x) + mod(floor(coord.y), 2.0) * 1.5, 3.0);
      if (dg < 1.5) mask = vec3(1.0);
    } else {
      float vg = mod(floor(coord.x), 2.0);
      if (vg < 1.0) mask = vec3(1.0);
    }
    color *= mask;

    /* Rolling sweep bar */
    float sweepBar = sin((warpedUv.y * 4.0) - (uTime * 0.003));
    if (sweepBar > 0.95) color -= uSweep;

    /* 60 Hz flicker */
    color -= uFlicker;

    /* Color profiles */
    if (uColorMode == 1) {
      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(gray * 1.0, gray * 0.7, gray * 0.1);
    } else if (uColorMode == 2) {
      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(gray * 0.1, gray * 1.0, gray * 0.2);
    } else if (uColorMode == 3) {
      float gray = dot(color, vec3(0.299, 0.587, 0.114));
      color = vec3(gray);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Defaults — per user spec:
//   Scanline Count 600   → scale = 600  (virtual scanline rows)
//   Scanline Opacity 0.90 → darkness = 0.90 (dark rows at 90% brightness)
//   Screen Softness 1px  → CSS blur(1px) on the final overlay canvas
//   Game Sharp 1.25px    → unsharp-mask radius 1.25 px on source texture
//   Shadowmask Weight 1  → maskStr = 1.0
// ---------------------------------------------------------------------------
const DEFAULTS = {
  scale:       600,    // scanline count (virtual vertical resolution)
  darkness:    0.90,   // scanline opacity — dark row multiplier (0=black, 1=none)
  maskStr:     1.0,    // shadowmask weight
  maskType:    0,      // 0=RGB stripe, 1=diagonal, 2=vertical
  flicker:     0.02,   // 60Hz flicker amplitude
  warp:        0.08,   // barrel distortion strength
  sweep:       0.05,   // rolling sweep bar intensity
  colorMode:   0,      // 0=colour, 1=amber, 2=green, 3=mono
  softness:    1.0,    // CSS blur radius (px) on overlay canvas — Screen Softness
  sharpness:   1.25,   // unsharp-mask radius (px) on game source — Game Sharp
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * createCRT(mountEl, gameCanvas, opts?)
 *   mountEl   — the container element (same parent as gameCanvas).
 *   gameCanvas — the game's 2D canvas element to composite.
 *   Returns a handle for tickCRT().
 */
export async function createCRT(mountEl, gameCanvas, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  await ensureThree();

  // Hide the raw game canvas — the CRT canvas will display its pixels instead.
  gameCanvas.style.display = "none";

  // Overlay canvas — same size, sits where the game canvas was.
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.style.cssText = `
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    display: block;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
    filter: blur(${cfg.softness}px);
  `;
  mountEl.style.position = "relative";
  mountEl.appendChild(overlayCanvas);

  // Three.js WebGL renderer
  const renderer = new THREE.WebGLRenderer({
    canvas:    overlayCanvas,
    alpha:     false,
    antialias: false,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);

  // Orthographic fullscreen quad
  const scene   = new THREE.Scene();
  const camera3 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Texture that wraps the game canvas — updated each frame.
  const screenTex = new THREE.CanvasTexture(gameCanvas);
  screenTex.minFilter = THREE.LinearFilter;
  screenTex.magFilter = THREE.LinearFilter;
  screenTex.generateMipmaps = false;

  // Texel size for sharpen kernel (based on game canvas native resolution)
  const texW = gameCanvas.width  || 160;
  const texH = gameCanvas.height || 100;

  const uniforms = {
    uScreen:      { value: screenTex },
    uVirtualRes:  { value: new THREE.Vector2(160, cfg.scale) },
    uDarkness:    { value: cfg.darkness    },
    uMaskStrength:{ value: cfg.maskStr     },
    uMaskType:    { value: cfg.maskType    },
    uFlicker:     { value: 0.0             },
    uWarp:        { value: cfg.warp        },
    uSweep:       { value: cfg.sweep       },
    uColorMode:   { value: cfg.colorMode   },
    uTime:        { value: 0.0             },
    uSharpness:   { value: cfg.sharpness   },
    uTexelSize:   { value: new THREE.Vector2(1.0 / texW, 1.0 / texH) },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader:   VERT,
    fragmentShader: FRAG,
    uniforms,
  });

  const geo  = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);

  const handle = { renderer, scene, camera3, uniforms, cfg, overlayCanvas, screenTex };
  _resize(handle);
  window.addEventListener("resize", () => _resize(handle));

  return handle;
}

function _resize(handle) {
  const { renderer, uniforms, cfg } = handle;
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  // Keep vertical = scanline count; horizontal scales with aspect ratio
  uniforms.uVirtualRes.value.set(cfg.scale * aspect, cfg.scale);
}

/**
 * tickCRT(handle, timestamp)
 *   Call once per frame AFTER the game has called present().
 */
export function tickCRT(handle, timestamp) {
  const { renderer, scene, camera3, uniforms, cfg, screenTex } = handle;

  // Mark the canvas texture dirty so Three.js re-uploads it.
  screenTex.needsUpdate = true;

  uniforms.uFlicker.value = Math.abs(Math.sin(timestamp * 0.05) * cfg.flicker);
  uniforms.uTime.value    = timestamp;

  renderer.render(scene, camera3);
}
