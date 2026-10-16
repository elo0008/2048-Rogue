# 2048 Rogue - Playable Prototype

A tactical, single-page HTML5 prototype of **2048-Rogue**: a roguelike 2048 featuring permanent stone hazards, draftable relics, and deterministic tactical play. Built with pure ES Modules, vanilla HTML/CSS/JS, zero dependencies, and zero external network requests.

---

## Quick Start (Playing Locally)

### 1. Prerequisites
- Node.js (v18+)

### 2. Run Tests
Run the complete test suite (includes 24 engine regression tests, 630 golden fixture runs, and 450 controller parity tests):
```bash
npm test
```

### 3. Start Local Server
Launch the zero-dependency local static server:
```bash
npm run serve
```
Open your browser to:
- **Game Root:** [http://localhost:3000/](http://localhost:3000/) or [http://localhost:3000/game/](http://localhost:3000/game/)

### 4. Build Production Bundle
Generate a self-contained static release under `dist/` (total size ~105 KB, well under the 1 MB limit):
```bash
npm run build
```

---

## Deploying `dist/`

The `dist/` directory produced by `npm run build` is completely self-contained with `index.html` at its root. All asset references are relative (`./`), allowing it to be served from any subdirectory or root.

### Deploying to Vercel
1. In the Vercel Dashboard, select **Add New Project** and import the GitHub repository (`2048-Rogue`).
2. Framework Preset: **Other** (configured via `vercel.json` with `"framework": null`).
3. Build Command: `npm run build` (automatically uses `vercel.json`).
4. Output Directory: `dist` (automatically uses `vercel.json`).
5. **No environment variables needed**.
6. Click **Deploy**.

> **Note for Public Launch:**
> - TODO remove noindex before public launch: `game/index.html` currently includes `<meta name="robots" content="noindex, nofollow">` for the testing phase.

### Deploying to GitHub Pages
1. Build the distribution:
   ```bash
   npm run build
   ```
2. Copy or commit the contents of `dist/` to your `gh-pages` branch or configure GitHub Pages in repository settings to serve from the `dist/` or `docs/` folder.
3. The game will run with zero external assets or font requirements.

### Deploying to itch.io (HTML5 Game)
1. Build the distribution:
   ```bash
   npm run build
   ```
2. Create a ZIP archive containing all files inside `dist/` (`index.html` must be in the ZIP root).
3. On itch.io, create a new project:
   - **Kind of project:** HTML
   - Upload the ZIP file and check **This file will be played in the browser**.
   - **Viewport dimensions:** 480 x 740 (or responsive / auto-detect).

---

## Controls

- **Desktop Keyboard:**
  - Arrow Keys (`Up`, `Down`, `Left`, `Right`)
  - WASD (`W`, `A`, `S`, `D`)
  - `Escape`: Cancel ability targeting mode
- **Mobile / Touch Screen:**
  - Swipe gestures in any direction (24px swipe threshold).
  - Tap highlighted candidate cells when the **Mason** relic is triggered.
  - Tap ability buttons and target tiles for **Diagonal Merge** and **Eraser**.
- **Player Abilities (Below Board):**
  - **Diagonal Merge** (`diagonal_charge`): Tap button to enter targeting, select first tile, select matching diagonal partner to merge. Free action.
  - **Eraser** (`eraser`): Tap button to enter targeting, tap number tile to highlight (`ERASE?`), tap same tile again to confirm removal. Free action.
  - Cancel targeting anytime via Cancel button, Escape, or tapping the ability button again.
- **Relic Drafts:**
  - When a draft occurs, choose from 3 cards by clicking or pressing Enter/Space.

---

## URL Parameters (Dials & Debugging)

Customize rules, test specific relic interactions, or replay seeds using query parameters:

| Parameter | Type / Example | Description |
|---|---|---|
| `?seed=N` | `?seed=42` | Replay an exact deterministic run seed. |
| `?pool=a,b,c` | `?pool=diagonal_charge,eraser,mason` | Custom draft relic pool (default: `diagonal_charge, eraser, fault_line, mason, siphon, shatter, last_stand`). |
| `?draft=N` | `?draft=30` | Trigger drafts every N moves (default: 60). |
| `?first=N` | `?first=30` | First draft at move N, then every `draftEveryMoves` after it (default first draft: move 60; e.g. `first=30&draft=60` drafts at 30, 90, 150). |
| `?thresholds=a,b,c` | `?thresholds=15,30,60` | Specific fixed move counts where drafts trigger. |
| `?nodraft=1` | `?nodraft=1` or `?enableDraft=false` | Disables relic drafting entirely, hiding the relic countdown without header layout shift. |
| `?stones=N` | `?stones=1` or `?stones=3` | Hazard schedule stone interval multiplier (default: 3x). |
| `?hazard=a,b,c` | `?hazard=75,60,45,30` | Custom hazard interval schedule per 100-move tier. |
| `?decay=N` | `?decay=30` | Stone lifetime in moves before natural decay. |
| `?start=<id>` | `?start=diagonal_charge` or `?start=eraser,mason` | Start the run with specified relic(s) from move 0. |
| `?relic=<id>` | `?relic=siphon` | Alias for `?start`. |
| `?diag=N` | `?diag=10` | Moves between cooldown charges for Diagonal Merge (default: 10). |
| `?eraser=N` | `?eraser=20` | Moves between cooldown charges for Eraser (default: 20). |
| `?rewind=N` | `?rewind=10` | Moves between cooldown charges for Rewind (default: 10). |
| `?maxcharges=N` | `?maxcharges=3` | Maximum charge capacity for abilities (default: 3). |
| `?cap=N` | `?cap=2` | Stone-group relic draft cap (`0` or `off` = off, prototype default: 2). |
| `?shatter=N` | `?shatter=64` | Minimum merge tile value required for Shatter to destroy adjacent stones (default: 64). |
| `?siphon=N` | `?siphon=16` | Minimum merge tile value required for Siphon to skip tile spawn (default: 16). |
| `?laststand=N` | `?laststand=16` | Maximum tile value destroyed by Last Stand on game over (default: 16). |
| `?nudgeOnInvalid=false` | `?nudgeOnInvalid=false` | Disables the 4px blocked swipe nudge animation (default: true). |
| `?flashOnInvalid=false` | `?flashOnInvalid=false` | Disables the blocked swipe subtle pale-white shock wave (default: true). |
| `?ramp=v2` | `?ramp=v2` | Uses ramp v2 hazard intervals. |
| `?hints=0` | `?hints=0` | Disables the status bar tutorial hints. |
| `?debug=1` | `?debug=1` | Shows the on-screen debug inspector (seed, move number, RNG draw counts, relic activations). |

**Examples:**
- Start with Diagonal Merge and Eraser:  
  `http://localhost:3000/?start=diagonal_charge,eraser`
- Test fast recharge abilities with 5 max charges:  
  `http://localhost:3000/?start=eraser&eraser=5&maxcharges=5`
- Replay run with seed 12345:  
  `http://localhost:3000/?seed=12345`
- Disable stone-group cap:  
  `http://localhost:3000/?cap=0`

---

## Logging & Export

- Each finished run generates a structured JSON log containing:
  - Anonymous Player ID & Run ID
  - Seed & active configuration
  - Total moves survived & move at death
  - Final board state (stone count & tile values)
  - Drafts seen, offered relics, selected relics, and decision time in ms
  - Per-relic activation counters and Last Stand trigger flag
- The last 20 runs are stored locally in `localStorage`.
- Click **Copy Run Log** on the Game Over screen to copy the full history as JSON (with an automatic file download fallback).
