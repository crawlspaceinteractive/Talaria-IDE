/**
 * ps1fx.js — PS1-authentic post effects
 *
 *   - Vertex jitter: screen coords are integer-snapped during projection (handled in renderer.js).
 *   - Affine UV warp: linear interp without perspective correction (default in renderer.js).
 *   - Ordered dithering: 4x4 Bayer used during shading.
 *   - 15-bit color quantization: each channel masked to top 5 bits.
 *
 * All color operations use integer arithmetic exclusively (no floats).
 * Blend factors are passed as 0..255 integers internally where possible.
 */
import { BAYER_4X4 } from "./luts.js";

// Pack RGB (0-255) to 32-bit ABGR (canvas little-endian layout: 0xAABBGGRR).
export function rgba(r, g, b, a = 255) {
  return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

// Unpack 32-bit ABGR.
export function unpack(c) {
  return {
    r: c & 0xff,
    g: (c >>> 8) & 0xff,
    b: (c >>> 16) & 0xff,
    a: (c >>> 24) & 0xff,
  };
}

// Quantize a 32-bit color to 15-bit (5/5/5) per PS1 framebuffer fidelity.
// With optional ordered dither using BAYER_4X4 at pixel (x, y).
// All arithmetic is integer: threshold addition then mask to top 5 bits.
export function quantize15(c, x, y) {
  const r = c & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = (c >>> 16) & 0xff;
  const a = c >>> 24;
  const bx = x & 3, by = y & 3;
  const t = BAYER_4X4[by * 4 + bx] - 7; // -7..8  (integer threshold)
  // Each channel: add threshold, clamp 0..255, mask top 5 bits
  let rv = r + t; if (rv < 0) rv = 0; else if (rv > 255) rv = 255; rv &= 0xf8;
  let gv = g + t; if (gv < 0) gv = 0; else if (gv > 255) gv = 255; gv &= 0xf8;
  let bv = b + t; if (bv < 0) bv = 0; else if (bv > 255) bv = 255; bv &= 0xf8;
  return (a << 24) | (bv << 16) | (gv << 8) | rv;
}

// Darken color (for depth fog / shadow). t in 0..1, t=0 leaves color, t=1 -> black.
// Uses 8-bit fixed-point: inv256 = round((1-t)*256), multiply channels by inv256>>8.
export function shade(c, t) {
  if (t <= 0) return c;
  if (t >= 1) return c & 0xff000000;
  // inv in 0..256 (8-bit fixed point for 1-t)
  const inv = (256 - (t * 256 + 0.5) | 0);
  const r = ((c & 0xff) * inv) >> 8;
  const g = (((c >>> 8) & 0xff) * inv) >> 8;
  const b = (((c >>> 16) & 0xff) * inv) >> 8;
  const a = c >>> 24;
  return (a << 24) | (b << 16) | (g << 8) | r;
}

// Tint toward another color. t=0 keeps c, t=1 returns target.
// Uses 8-bit fixed-point blend: factor = round(t * 256).
export function tint(c, target, t) {
  if (t <= 0) return c;
  if (t >= 1) return (c & 0xff000000) | (target & 0x00ffffff);
  const f = (t * 256 + 0.5) | 0; // 0..256
  const cr = c & 0xff,      tr = target & 0xff;
  const cg = (c >>> 8) & 0xff,  tg = (target >>> 8) & 0xff;
  const cb = (c >>> 16) & 0xff, tb = (target >>> 16) & 0xff;
  const r = cr + (((tr - cr) * f) >> 8);
  const g = cg + (((tg - cg) * f) >> 8);
  const b = cb + (((tb - cb) * f) >> 8);
  const a = c >>> 24;
  return (a << 24) | (b << 16) | (g << 8) | r;
}
