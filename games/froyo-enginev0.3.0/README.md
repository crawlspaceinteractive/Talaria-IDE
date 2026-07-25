# froyo-engine

A browser-focused game engine / game project.

## Run locally

1. Open the project root in a terminal.
2. Start a simple static server from the repo root:

```bash
python3 -m http.server 8000
```

3. Open the game in your browser:

```text
http://127.0.0.1:8000/index.html
```

4. If any `models/*.glb` files are missing or fail to load, the game should still run with fallback geometry.- Missing or unavailable local models are logged in the browser console.
## Notes

- `index.html` has been adjusted for local development by removing the hosted-platform `base` URL.
- A standalone editor prototype has been added at `scene-editor.html` for building and exporting render scenes.
- There is no `package.json` in this repo, so the simplest local workflow is a static HTTP server.
- The game loads local GLB models from a root-level `models/` directory.
- A helper module for exporting generated world data into editor-friendly scene JSON is available at `mapgen-export.js`.
- Example usage:

```js
import { generateWorld } from './world.js';
import { worldToSceneData } from './mapgen-export.js';

const world = generateWorld(1337);
const scene = worldToSceneData(world, { seed: 1337 });
console.log(JSON.stringify(scene, null, 2));
```

- Expected model filenames for the current local setup:
  - `models/froyo_body_model.glb`
  - `models/sun_enemy_model.glb`
  - `models/skydome_model.glb`
  - `models/skyring_model.glb`
  - `models/bridge_model.glb`
  - `models/canyon_model.glb` (portal island)
  - `models/island_A_model.glb`
  - `models/island_B_model.glb`
  - `models/island_C_model.glb`
  - `models/island_D_model.glb`
  - `models/island_E_model.glb`
  - `models/star+geometry+3d+model.glb` (island G)
- Optional/unmapped files in `models/` that are not currently loaded by the engine:
  - `models/froyo_face_model.glb`
  - `models/star_logo_panel.glb`
  - `models/.gitkeep`
- `models/cherry.glb` is still optional; if absent the game falls back to the default cube pip.
