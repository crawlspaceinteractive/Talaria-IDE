// engine/textureloader.js
// CPU-side image texture loader/sampler for the software renderer.
// Engine-only: callers provide fully resolved URLs.

const _textureCache = new Map();

export async function loadTexture(url, opts = {}) {
  if (!url) return null;
  const key = `${url}|${opts.wrap !== false ? "wrap" : "clamp"}`;
  if (_textureCache.has(key)) return _textureCache.get(key);

  const promise = loadImageBitmapTexture(url, opts).catch(err => {
    console.warn("[texture] failed to load", url, err);
    return null;
  });
  _textureCache.set(key, promise);
  return promise;
}

async function loadImageBitmapTexture(url, opts = {}) {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    url,
    width: canvas.width,
    height: canvas.height,
    data: imageData.data,
    wrap: opts.wrap !== false,
    nearest: true,
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

export function sampleTextureNearest(tex, u, v) {
  if (!tex || !tex.data || tex.width <= 0 || tex.height <= 0) return 0xffffffff;

  let x = Math.floor(u * tex.width);
  let y = Math.floor(v * tex.height);

  if (tex.wrap) {
    x = ((x % tex.width) + tex.width) % tex.width;
    y = ((y % tex.height) + tex.height) % tex.height;
  } else {
    x = x < 0 ? 0 : x >= tex.width ? tex.width - 1 : x;
    y = y < 0 ? 0 : y >= tex.height ? tex.height - 1 : y;
  }

  const i = (y * tex.width + x) * 4;
  const r = tex.data[i];
  const g = tex.data[i + 1];
  const b = tex.data[i + 2];
  const a = tex.data[i + 3];
  return (a << 24) | (b << 16) | (g << 8) | r;
}

export function tintTexelRGBA(texel, tint) {
  const tr = tint & 255;
  const tg = (tint >>> 8) & 255;
  const tb = (tint >>> 16) & 255;

  const r = texel & 255;
  const g = (texel >>> 8) & 255;
  const b = (texel >>> 16) & 255;
  const a = (texel >>> 24) & 255;

  return (
    (a << 24) |
    ((((b * tb) / 255) | 0) << 16) |
    ((((g * tg) / 255) | 0) << 8) |
    (((r * tr) / 255) | 0)
  ) >>> 0;
}

export function clearTextureCache() {
  _textureCache.clear();
}
