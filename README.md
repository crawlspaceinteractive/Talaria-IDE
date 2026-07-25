# Talaria IDE — Workstation v1.95

> A browser-based retro multimedia workstation and game development environment.

```
TALARIA ENGINE COMPILER MANAGER // SYSTEM_WORKSPACE_MAIN
```
Live Demo:
https://crawlspaceinteractive.github.io/Talaria-IDE/
---

## ⚠️ STATUS: INCOMPLETE / USE AS-IS

**This software is under active development and is NOT finished.** There are known bugs, incomplete features, stub implementations, and placeholder code throughout the project. Use everything in this repository **as-is** until development is complete.

See the **[Known Issues & Incomplete Features](#known-issues--incomplete-features)** section below for a full accounting of what is broken or unfinished.

---

## What Is This?

Talaria IDE is a single-page HTML application that serves as a unified shell for a collection of game development tools, game projects, a security tool suite, project management dashboards, and a built-in audio player / web browser — all styled after Windows 95 and NeXTSTEP aesthetics.

It is **not** a traditional code editor like VS Code. It is a **multimedia game development workstation** that hosts self-contained sub-applications (tools, games, utilities) in iframes, with a Miller column file browser, a VFD-style scrolling marquee, and a cross-app data bus for inter-application communication.

---

## Quick Start

Talaria IDE is a **static HTML/JS/CSS project** — no build system, no package manager, no bundler. Serve it from any static HTTP server:

```bash
# From the project root:
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

Alternatively, using `http-server`:

```bash
npx http-server . -p 8000
```

The boot sequence will play automatically. Click items in the Miller column file browser to launch tools and games in the workspace.

---

## Project Structure

```
Talaria IDE/
├── index.html                      Main entry point — workstation shell (v1.95)
├── apps/                           15 development tool applets
│   ├── BUILD2UDMF/                 Doom Build map → UDMF converter
│   ├── CRTBROWSE/                  CRT-effect arcade game browser overlay
│   ├── DIGITALWALKMAN/             DATAMAN 5000 — audio player (Win95 theme)
│   ├── DJUKEBOX/                   Doom Multimedia Suite — audio tracker/mixer
│   ├── DOOMARCMAN/                 WAD/PK3 archive manager
│   ├── MAPEDITOR/                  SLADE-style Doom/Heretic/Hexen map editor
│   ├── MODELCRUNCH/                3D model vertex merge tool (gamepad support)
│   ├── PALETTEJACK/                Doom palette editor
│   ├── PDFVIEWER/                  PDF viewer with OCR
│   ├── PISKEL/                     Pixel art editor (bundled third-party)
│   ├── SCENEREND/                  Three.js 3D scene renderer + animation timeline
│   ├── SPRITESCISSORS/             Sprite sheet splitter + DECORATE code gen
│   ├── TEXTEDITOR/                 Win95-styled code/text editor
│   ├── TRACKERREMIXER/             Audio tracker + DOOM FM tracker
│   └── project_dashboards/         17 project roadmap trackers + dashboard
│       ├── dashboard.html          Overview of all trackers
│       ├── *-tracker/              Individual project roadmap apps
│       └── deepsmoke-tracker/      Contains full "Deepsmoke" game prototype
├── games/                          9 game projects at various stages
│   ├── froyo-enginev0.3.0/         PS1-style 3D platformer (latest)
│   ├── crawlspaceENGINE_FROYOgameSTABLE/   Stable Froyo release
│   ├── INPROGRESScrawlspace_apex/  Active development
│   ├── ONHOLDcrawlspace_froyo/     On hold
│   ├── SHELVEDcrawlspace_cryptic/  Shelved / archived
│   ├── URGENTcrawlspaceENGINE/     Urgent/active
│   ├── STABLEraycrawler_GOON/      Goblin Dungeon raycaster FPS (stable)
│   ├── BLEEDINGraycrawler_GOON2/   GOON2 bleeding-edge (25 files)
│   └── RELSEASEDalleycrawler_BMUP/ Beat-em-up engine
├── modules/                        Design philosophy documents
│   ├── README.md                   "use it, remix it, break it, fix it..."
│   ├── COMPUTERROR.md              Artistic genome codex
│   └── MAINTENANCE.md              Moral debug architecture maintainer's guide
├── NodeNet/                        DataMan Battle Node System — security tools
│   ├── ArtkeyNode/                 SHA-256 visual key generator
│   ├── DefenseNode/                Threat scanner (Viri-Scanner)
│   ├── PassNode/                   AES-GCM encrypt/decrypt
│   ├── VoidNode/                   Secure file shredder
│   ├── NaviNode/                   Patch checker / vulnerability scanner
│   └── SirenNode/                  Phishing URL analyzer
└── output/                         VFS output directory
    ├── graphics/                   Sprite/texture PNGs
    ├── maps/                       (empty)
    ├── sound/                      (empty)
    └── text/                       (empty)
```

---

## Features

### Main Shell (`index.html`)
- Animated boot sequence with progress bar and terminal log
- VFD-style scrolling marquee display (amber LED aesthetic)
- Built-in audio player with Web Audio API (CD mount, play/pause, volume)
- Fullscreen toggle
- Miller column file browser with 3-level navigation
- Dynamic modal system for images, markdown, and text files
- Built-in web browser (NetNavigator) via CORS proxy
- Cross-app data bus (`window.TALARIA_BUS`) with `postMessage` routing
- VFS output directory browser (live HTTP directory listing)

### Development Tools (Apps)
| Tool | Description |
|------|-------------|
| **BUILD2UDMF** | Doom Build-to-UDMF map converter with texture remapping and dedup |
| **MAPEDITOR** | SLADE-style map editor with 3D preview, Doom/Heretic/Hexen/Strife thing registry |
| **TEXTEDITOR** | Win95-styled code editor with syntax highlighting, file open/save, line numbers |
| **DJUKEBOX** | Doom Multimedia Suite audio tracker/mixer |
| **TRACKERREMIXER** | Audio tracker engine + DOOM FM Tracker |
| **DIGITALWALKMAN** | DATAMAN 5000 audio player with VU meters |
| **DOOMARCMAN** | WAD/PK3 archive manager with offset tool |
| **SPRITESCISSORS** | Sprite sheet splitter + DECORATE code generator |
| **PALETTEJACK** | Doom palette editor ("Computerror Elemental Master Palette v2") |
| **MODELCRUNCH** | 3D model vertex merge tool with gamepad controls |
| **SCENEREND** | Three.js 3D scene renderer with animation timeline |
| **PDFVIEWER** | PDF viewer with OCR panel (jsPDF + Tesseract.js) |
| **CRTBROWSE** | CRT-effect overlay for arcade game browsing |
| **PISKEL** | Full pixel art editor (bundled third-party) |

### Games
| Game | Style | Status |
|------|-------|--------|
| **Froyo Engine** | PS1-style 3D platformer with CPU software rasterizer | Latest (v0.3.0) |
| **Goblin Dungeon (GOON)** | DDA raycaster FPS with procedural dungeons | Stable / Bleeding-edge v2 |
| **Dalleycrawler (BMUP)** | Beat-em-up with encounter director | Released |
| **Deepsmoke** | Voxel co-op drilling game | Prototype (in dashboard) |

### Security Suite (NodeNet)
| Node | Function |
|------|----------|
| **ArtkeyNode** | SHA-256 visual key generator from images |
| **DefenseNode** | Browser threat scanner with CVE database |
| **PassNode** | AES-GCM encryption/decryption (64-char hex keys) |
| **VoidNode** | Secure file shredder (multi-pass random overwrite) |
| **NaviNode** | Environmental inspection + volatile data audit |
| **SirenNode** | URL phishing analyzer with Levenshtein distance detection |

### Project Management
- 17 project roadmap tracker apps with phase-based task tracking
- Dashboard overview page
- Export/import to JSON
- Python tools for Obsidian Markdown conversion

---

## Technical Notes

- **No build system.** Static HTML/JS/CSS only — no `package.json`, no bundler, no TypeScript, no CSS preprocessor.
- **No license declared.** See [License](#license) below.
- **CDN dependencies** are loaded at runtime: Three.js, jsPDF, Tesseract.js, JSZip, midi-player-js, Tailwind CSS, Google Fonts.
- **Python utilities** in `project_dashboards/` use only stdlib (`json`, `os`, `sys`, `pathlib`).
- **Game versioning** uses directory prefixes: `BLEEDING` (cutting-edge), `INPROGRESS`, `URGENT`, `STABLE`, `ONHOLD`, `SHELVED`, `RELEASE`.
- **Froyo Engine** uses a full CPU software rasterizer (no WebGL for rendering) with 15-bit color quantization, fog, and dithering. Three.js is loaded only for GLB model parsing.
- **GOON raycaster** uses DDA raycasting with inner face culling, LOS-gated AI, and step-trace projectile physics.
- Games use deterministic seeded PRNG — no `Math.random()`.
- The `.vite/deps/` directory is an empty remnant from a briefly-tried Vite setup; it is unused.

---

## Known Issues & Incomplete Features

> **The following is a non-exhaustive list of known incomplete implementations, bugs, and placeholder code. This section should be referenced before assuming any feature works as intended.**

### Critical

| Issue | Location | Description |
|-------|----------|-------------|
| **Payments are a complete stub** | `star-sdk/v1/payments.js` (3 copies) | `createPayments()` always returns `Promise.resolve(false)`. No payment is ever processed. |
| **Hitscan ray is a no-op** | `BLEEDINGraycrawler_GOON2/raycaster.js:357-361` | `shootRay()` returns `null` — enemy hit detection uses sprite distance comparison instead, but this function does nothing. |
| **VFS download uses wrong property** | `index.html:786-789` | The fallback download sets `a.url` instead of `a.href`, so downloads will fail. |

### Medium

| Issue | Location | Description |
|-------|----------|-------------|
| **CRT shader disabled** | 6 engine `main.js` files | The entire CRT post-processing shader system is commented out across all Froyo engine copies. The visual effect is unavailable. |
| **Main menu is a no-op stub** | `RELSEASEDalleycrawler_BMUP/menu.js:323-328` | `launchMainMenu()` just calls `onNew()` immediately — no actual menu UI is rendered through this export path. |
| **Minimize not implemented** | `apps/PALETTEJACK/PaletteJack.html:814-816` | `minimizeWindow()` only shows a notification saying it's a demo. |
| **Empty output directories** | `output/maps/`, `output/sound/`, `output/text/` | These directories are completely empty. Only `output/graphics/` has content. |

### Low

| Issue | Location | Description |
|-------|----------|-------------|
| **AI-generated artifact comments** | `NodeNet/DefenseNode/app.js` (5 functions) | Comments like `"omitted for brevity, see previous response"` are left over from AI code generation. The code works but the comments are misleading. |
| **Legacy shim kept** | `STABLEraycrawler_GOON/renderer.js:1377-1385` | `_drawWallSlice()` is a no-op shim that redirects to `_drawWallColumn()`. Dead code retained for backward compatibility. |
| **Save migration placeholder** | `deepsmoke-tracker/persist.js:56` | `migrate()` has a commented-out skeleton for future version upgrades. Currently passes data through unchanged. |
| **Open-ended pattern lists** | `NodeNet/NaviNode/app.js:18` | Comment says "Add more patterns here as threat intelligence evolves!" — pattern coverage may be incomplete. |
| **Open-ended CVE list** | `NodeNet/DefenseNode/app.js:21` | Comment says "Add more CVEs here!" — threat database is manually maintained and may be outdated. |
| **Scene editor dirty tracking comments** | 7 scene editor files | Comments say "stubs — full impl in auto-save section" but the code is actually implemented. Misleading documentation. |
| **Blood actor stubs** | `apps/BUILD2UDMF/build2udmf.html:777-784` | Intentionally generates empty DECORATE actor stubs for Blood maps. Users must fill in real definitions. |
| **Piskel TODOs/FIXMEs** | `apps/PISKEL/piskel.html` (~60 instances) | Third-party bundled code with its own incomplete items — not part of this project's codebase. |

### Structural Concerns

- **No version control.** The project directory is not a git repository. There is no `.gitignore`, no commit history, no branching strategy. Version management is done via directory naming prefixes (`BLEEDING`, `STABLE`, etc.).
- **No license.** No `LICENSE` file exists anywhere. The project is implicitly all-rights-reserved.
- **No automated testing.** No test framework, no test files, no CI/CD.
- **5+ copies of the Froyo engine** exist at various stages, creating maintenance burden and divergence risk.
- **Third-party code (Piskel)** is bundled without license attribution in the project.
- **CDN dependencies** have no pinned versions — runtime behavior could change if CDN content updates.

---

## AI Agent Integration

Several game projects include `AGENTS.md` files with instructions for AI coding agents. The most extensive is in `ONHOLDcrawlspace_froyo/AGENTS.md`, which defines rules like:

- **Source First Rule** — Always read source before making changes
- **No Ghost Analysis Rule** — Don't speculate without evidence
- **Human Authority Rule** — Human decisions override AI preferences
- **Evidence Rule** — Cite specific file paths and line numbers
- **Refactoring Rule** — Minimal changes, preserve existing behavior

---

## Architecture Philosophy

From the project's own documentation (`modules/COMPUTERROR.md`, `modules/MAINTENANCE.md`):

- Practical solutions beat fashionable solutions
- No package manager or build system is required; this is a static web project
- Archive, don't delete
- Plain language first
- "use it, remix it, break it, fix it, document it, share it, thats all you gotta do"

---

## License

**No license is declared for this project.** No `LICENSE`, `LICENSE.md`, or license header exists in any file. The only license reference in the codebase is `"AI Ethics of Maintenance (c) 2025"` in `modules/MAINTENANCE.md`, which applies to that document only.

All rights are implicitly reserved by the author(s). The bundled Piskel editor is a separate third-party project with its own license.

Until a license is explicitly declared, do not assume this software is open source or freely redistributable.

---

## Running Individual Tools

Each app can be opened directly in a browser if served via HTTP:

| Tool | URL Path |
|------|----------|
| Main workstation | `/index.html` |
| MAPEDITOR | `/apps/MAPEDITOR/mapeditor.html` |
| TEXTEDITOR | `/apps/TEXTEDITOR/texteditor.html` |
| PALETTEJACK | `/apps/PALETTEJACK/PaletteJack.html` |
| DOOMARCMAN | `/apps/DOOMARCMAN/doomarcman.html` |
| SPRITESCISSORS | `/apps/SPRITESCISSORS/spritescissors.html` |
| MODELCRUNCH | `/apps/MODELCRUNCH/modelcrunch.html` |
| SCENEREND | `/apps/SCENEREND/sceneREND.html` |
| PDFVIEWER | `/apps/PDFVIEWER/pdfviewer.html` |
| DJUKEBOX | `/apps/DJUKEBOX/djukebox.html` |
| TRACKERREMIXER | `/apps/TRACKERREMIXER/trackerRemixer.html` |
| DIGITALWALKMAN | `/apps/DIGITALWALKMAN/digitalwalkman.html` |
| BUILD2UDMF | `/apps/BUILD2UDMF/build2udmf.html` |
| CRTBROWSE | `/apps/CRTBROWSE/crtbrowse.html` |
| PISKEL | `/apps/PISKEL/piskel.html` |
| NodeNet (all) | `/NodeNet/` |
| Dashboard | `/apps/project_dashboards/dashboard.html` |

---

*This is development software. Expect bugs. Expect incomplete features. Use as-is.*
