/*
 * export-progress.js
 * ─────────────────
 * Run this in the browser console on ANY tracker page (or the main index.html).
 * It exports all tracker progress from localStorage as a JSON file download.
 *
 * Usage:
 *   1. Open your project_dashboards/index.html in a browser
 *   2. Open DevTools → Console (F12)
 *   3. Paste this entire script and press Enter
 *   4. A file "tracker-progress.json" will download
 *
 * If progress is missing for some trackers, open those specific tracker
 * pages individually and run this script again — it merges automatically.
 */

(() => {
  const TRACKERS = [
    { key: "deepsmoke_roadmap",   name: "Deepsmoke" },
    { key: "froyo_roadmap",       name: "Froyo" },
    { key: "gztl_roadmap",        name: "Gztl" },
    { key: "goon_roadmap",        name: "Goon" },
    { key: "bmup_roadmap",        name: "Bmup" },
    { key: "pixelrealm_roadmap",  name: "Pixelrealm" },
    { key: "sixpac_roadmap",      name: "Sixpac" },
    { key: "wh_tekwar_roadmap",   name: "Wh Tekwar" },
    { key: "locnar_roadmap",      name: "Locnar" },
    { key: "computerror_roadmap", name: "Computerror" },
    { key: "brawl_roadmap",       name: "Brawl" },
    { key: "apex_roadmap",        name: "Apex" },
    { key: "cryptic_roadmap",     name: "Cryptic" },
    { key: "unreality_roadmap",   name: "Unreality" },
    { key: "luminescence_roadmap",name: "Luminescence" },
    { key: "gameofdeath_roadmap", name: "Gameofdeath" },
    { key: "blockbench_roadmap",  name: "Blockbench" },
  ];

  const progress = {};
  let found = 0;

  for (const t of TRACKERS) {
    const raw = localStorage.getItem(t.key);
    if (raw) {
      try {
        const state = JSON.parse(raw);
        const tasks = {};
        for (const [k, v] of Object.entries(state)) {
          if (k === "images" || k === "openPhases") continue;
          if (v === true) tasks[k] = true;
        }
        if (Object.keys(tasks).length > 0) {
          progress[t.key] = { name: t.name, tasks };
          found++;
        }
      } catch (e) {
        console.warn(`Failed to parse ${t.key}:`, e);
      }
    }
  }

  if (found === 0) {
    console.log("No tracker progress found in this page's localStorage.");
    console.log("Try opening a specific tracker page (e.g. deepsmoke-tracker/index.html) and running this script there.");
    return;
  }

  const blob = new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tracker-progress.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log(`Exported progress for ${found} tracker(s):`);
  for (const [k, v] of Object.entries(progress)) {
    console.log(`  ${v.name}: ${Object.keys(v.tasks).length} completed tasks`);
  }
})();
