# Beat-Em-Up Engine — Architecture

## File Map

| File | Role |
|---|---|
| `index.html` | Shell: canvas, HUD DOM, scanline overlay |
| `main.js` | Fixed-timestep loop (60Hz), `Game` lifecycle |
| `game.js` | **Thin orchestrator** — top-level phase FSM, camera, render interpolation, overlays, HUD, pause hook |
| `encounterManager.js` | **Encounter Director** — scroll-lock state, trigger edge-detection, enemy/food spawn, wave-clear FSM |
| `levelFactory.js` | **Pure data** — `buildLevel(levelIdx)` + `makePrng(seed)`, no runtime state |
| `entities.js` | `Player`, `Enemy`, `Boss`, `FoodItem`, `HitEffect`, `InputHandler`, LUT trig |
| `renderer.js` | Pseudo-3D canvas renderer (sky, ground, wall blit, entity draw) |
| `pause.js` | `PauseMenu` (canvas overlay) + `Bindings` (localStorage key config) |
| `gamepad.js` | `GamepadManager` — maps controller buttons/sticks to virtual key codes |
| `deathMenu.js` | `DeathMenu` — end-game modal (LEADERBOARD / MAIN MENU / NEW RUN), session score board |
| `menu.js` | `MainMenu` class — canvas-rendered title screen (START / CONFIGURE CONTROLS); `launchMainMenu()` compat stub for deathMenu.js |

## Dependency Graph

```
main.js
  └─ game.js
       ├─ levelFactory.js       (pure, no deps)
       ├─ encounterManager.js   ──▶ entities.js
       ├─ entities.js           ──▶ gamepad.js
       ├─ renderer.js           (standalone)
       ├─ pause.js              (standalone)
       ├─ deathMenu.js          ──▶ menu.js (launchMainMenu compat)
       └─ menu.js               (MainMenu class)
```

## Key State Shapes

### `EncounterManager.status` FSM
```
searching ──(trigger crossed)──▶ active | bossIntro
bossIntro ──(countdown done)──▶ active
active    ──(all enemies dead)─▶ goPrompt | encCleared(boss)
goPrompt  ──(90 frames)────────▶ completed
completed ──(Game.acknowledge)─▶ searching
encCleared──(Game.acknowledgeEncCleared)▶ searching
```

### `Game.phase`
```
menu    ──(START GAME)────────────────▶ playing (level 0)
menu    ──(CONFIGURE CONTROLS)────────▶ PauseMenu controls screen (returns to menu)
playing ──(boss cleared, levelIdx<2)──▶ levelEnd
playing ──(boss cleared, levelIdx>=2)─▶ victory
playing ──(player dead, lives=0)──────▶ gameOver ──(phaseTimer=0)──▶ DeathMenu.open()
playing ──(pause → QUIT TO TITLE)─────▶ menu
levelEnd ──(confirm)──────────────────▶ playing (next level)
victory  ──(confirm)──────────────────▶ menu
DeathMenu [NEW RUN]   ──▶ playing (level 0)
DeathMenu [MAIN MENU] ──▶ menu
DeathMenu [LEADERBOARD] ──▶ toggles session board sub-panel
```

### Encounter data (from `levelFactory.buildLevel`)
```js
{
  encounters: [{ triggerX, isBoss, enemies: [{variant, offsetX, offsetZ}], food: [...] }],
  totalLength: number
}
```

## Key Contracts

- **`_prevPlayerX` lives only in `EncounterManager`** — single source of truth, updated once per `update()` call after all state transitions.
- **Score gains** are reported back to `Game` via the result object from `em.update()` rather than touching `player.score` directly inside EncounterManager (food pickups are the exception — EM touches `player.score += 50` directly for pickups since it owns food state).
- **Spawn queue safety**: enemies are always replaced atomically (`this.activeEnemies = []` then push), never mutated during iteration; `Player.update()` receives a `.slice()` snapshot.
- **No Math.random()** anywhere. All randomness goes through `makePrng(seed)` LCG from `levelFactory.js`.
