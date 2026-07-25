/**
 * persistence.js — .froyo JSON save/load (Spec Section XIII)
 *
 * Persisted via localStorage under "froyo.save". Default file schema:
 *   { sprinkles, lives, unlocked_worlds, input_map }
 */
const KEY = "froyo.save";

export const DEFAULT_SAVE = {
  sprinkles: 0,
  lives: 5,
  unlocked_worlds: ["sundae_isles"],
  input_map: null, // null = use defaults
  fxVolume:  0.8,  // FX master gain (0–1)
  bgmVolume: 0.55, // BGM master gain (0–1)
};

export function loadSave() {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SAVE };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SAVE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SAVE, ...parsed };
  } catch (_) {
    return { ...DEFAULT_SAVE };
  }
}

export function writeSave(data) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (_) { /* quota / disabled — silent */ }
}

export function exportFroyoBlob(data) {
  const json = JSON.stringify(data, null, 2);
  return new Blob([json], { type: "application/json" });
}

/**
 * Trigger a download of the current save as a .froyo file.
 */
export function downloadFroyoFile(data, filename = "save.froyo") {
  if (typeof document === "undefined") return;
  const blob = exportFroyoBlob(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
