# Checkpoint — Main Menu Integration

## Completed This Session

### Main Menu (`menu.js`)
- Replaced stub with full `MainMenu` class
- Canvas-rendered: animated "GOON" title with red pulse glow, subtitle "STREETS OF CHAOS"
- Two buttons: `START GAME` (green) and `CONFIGURE CONTROLS` (cyan)
- Keyboard (↑↓ Enter/J/Z), gamepad (InputHandler.actionPressed), mouse/touch support
- Own event listeners on open()/close() — no leaks
- `_roundRect` utility included
- `launchMainMenu()` compat export preserved for deathMenu.js import

### Game Orchestrator (`game.js`)
- Initial phase set to `'menu'` — no simulation until Start
- Added `_startGame()` — closes menu, resets player + level, sets phase=playing
- Added `_goToMenu()` — tears down deathMenu/pause, nulls player, clears HUD, re-opens menu
- Hook wiring:
  - `mainMenu.onStart` → `_startGame()`
  - `mainMenu.onOptions` → PauseMenu controls screen (with `_pauseFromMenu` flag, ESC returns to menu not gameplay)
  - `deathMenu.onNewRun` → `_startGame()`
  - `deathMenu.onMainMenu` → `_goToMenu()`
  - Pause "QUIT TO TITLE" → `_goToMenu()`
  - Victory confirm → `_goToMenu()` (not direct restart)
- Render guard: menu phase draws menu + optional controls overlay; skips gameplay render when player===null
- Added `_clearHUD()` to wipe DOM on menu return
- Removed old `import('./menu.js').then(...)` dynamic import

### index.html
- Removed `#controls-hint` div entirely
- Removed its CSS block (`#controls-hint { ... }`)

### ARCHITECTURE.md
- Updated file map entry for menu.js
- Updated Game.phase FSM diagram with menu state + all transitions

## What Remains / Recommended Next Steps

1. **Sound / music** — Menu has no audio yet. A title BGM loop and menu-navigation SFX would polish the experience significantly.

2. **Menu background art** — Currently a plain dark gradient. Could add a parallax city background or static pixel art splash behind the title.

3. **High score persistence** — DeathMenu session leaderboard resets on page reload. Wire to localStorage or a backend.

4. **Mobile touch controls** — No on-screen D-pad/buttons for mobile play. Touch events are handled for menu navigation but in-game movement has no touch HUD.

5. **Level select** — Currently always starts at level 0. A level select could be added as a third main menu item.

6. **Credits / "How to Play" screen** — A brief controls reference accessible from the main menu (since the bottom hint was removed).

## File State Summary

All files clean, no syntax errors detected. Imports verified:
- game.js imports MainMenu from menu.js ✓
- deathMenu.js imports launchMainMenu from menu.js ✓ (compat stub, never fires in practice)
- menu.js exports both MainMenu (class) and launchMainMenu (stub) ✓
