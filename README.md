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
  - Swipe gestures in any direction (24px swipe threshold). Blocked swipes that change nothing on a non-stuck board are pure no-ops with zero animation or DOM mutations.
  - Tap glowing candidate cells when the **Mason** relic is triggered. Both candidate cells pulse in sync with a slow 3-second breathing gold glow.
  - Tap ability buttons and target tiles for **Diagonal Merge** and **Eraser**.
- **Player Abilities (Below Board):**
  - **Diagonal Merge** (`diagonal_charge`): Tap button to enter targeting. Eligible tiles display an outer dashed gold border; selecting one transitions it into a pressed tile; available diagonal partner tiles glow for selection. Free action.
  - **Eraser** (`eraser`): Tap button to enter targeting, tap number tile to highlight (`ERASE?`), tap same tile again to confirm removal. Free action.
  - Cancel targeting anytime via Cancel button, Escape, or tapping the ability button again.
- **Relic Drafts:**
  - When a draft occurs, choose from 3 cards by clicking or pressing Enter/Space.
- **Active Play Time:**
  - Measures elapsed gameplay time in `mm:ss` (or `h:mm:ss`) via `performance.now()` deltas.
  - Excludes pause overlay, Best Runs overlay, pre-start screen, and inactive/hidden tabs.
  - Displayed on the Pause overlay ("Time played") and Game Over summary grid ("TIME"), and stored in run logs.
- **End Run (Pause Overlay):**
  - Voluntary run termination via the "End run" button in the Pause menu.
  - Features two-step confirmation: first tap changes the label to "Tap again to end" (reverting after 3 seconds); second tap immediately ends the run with `endedByPlayer: true`, records terminal event `x:end`, and displays the Game Over screen.
- **Clean Slate (Ascension at 2048 by default):**
  - Achieving a 2048 tile triggers the Clean Slate milestone sequence (or configured threshold via `?ascension=N`):
    - Synthesized Web Audio fanfare: 3-chord harmonic crescendo ending in a crisp crystal shatter.
    - Expanding circular shockwave ring centered on the surviving ascended tile.
    - Concentric disintegration of outer tiles and hazard stones into particle dust.
    - Milestone payout points awarded with a floating score popup (`+PAYOUT`).
    - Centered milestone banner: `"2048 CLEAN SLATE"`.
    - Zero layout shift: board dimensions, header height, and survivor tile position remain strictly locked throughout the 1500ms sequence (1200ms when `prefers-reduced-motion` is active).
    - Queued input handling: Swipes during the sequence buffer cleanly; Pause or Play Again cancels or interrupts safely without state desynchronization.

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
| `?ascension=N` | `?ascension=2048` or `?ascension=64` | Sets Clean Slate (Ascension) threshold to N (UI default is 2048). `?ascension=0` or `?ascension=off` disables Clean Slate. |
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
  - `rulesVersion`: Frozen SHA-256 hash of the simulation engine rules (`sim/engine.js`): `7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B`
  - `replayVersion`: SHA-256 over LF-normalized source of replay files
  - Seed & active configuration (including `ascensionAt`)
  - Total moves survived & move at death
  - Active play duration in milliseconds (`activeMs`)
  - Final board state (stone count & tile values)
  - `ascensionLevel`: Highest ascension threshold achieved
  - `ascensions`: Array of ascension records (`{ move, value, payout, destroyedTiles, destroyedStones }`)
  - `endedByPlayer`: Boolean indicating voluntary exit via End run
  - Drafts seen, offered relics, selected relics, and decision time in ms
  - Per-relic activation counters and Last Stand trigger flag
  - `events`: Ordered array of compact input event strings across the entire run:
    - `s:<L|R|U|D>`: Swipes submitted (including any moves later rewound)
    - `a:<relicId>:<target>`: Ability activations with target payload (or `-` for Rewind)
    - `d:<relicId>`: Relic draft picks
    - `m:<cell>`: Mason stone replacement candidate picks
    - `x:end`: Voluntary run termination by player
  - `errorCount`: Total uncapped error counter for the run session
  - `errors`: Run-scoped errors strictly within `[startTimestamp, endTimestamp]` (each with first 300 characters of stack trace); device-wide error history preserved under `diagnostics.recentErrors`
- The last 20 runs are stored locally in `localStorage`.
- Top 10 high scores are recorded in `2048_rogue_top_runs` including `activeMs` and `eventsCount` (storing the event count rather than the raw array to optimize storage).
- Click **Copy Run Log** on the Game Over screen to copy the full history as JSON (with an automatic file download fallback).

---

## Verifying a Run

Run authenticity and reproducibility can be independently verified by replaying the run from its seed, config, and `events` stream using the deterministic rules engine:

```bash
# Verify a single exported run log (defaults to --mode daily):
node verify/cli.js path/to/run_log.json

# Verify with custom mode and date:
node verify/cli.js path/to/run_log.json --mode daily --day 2026-10-19
node verify/cli.js path/to/run_log.json --mode any

# Verify a directory corpus of run logs:
node verify/cli.js --corpus scripts/out/corpus --out scripts/out/verify_corpus.txt
```

Accepts both bare run log files and the Copy Run Log JSON wrapper `{ currentRun, history, errors }` (verifying each run entry).

### Verification Modes
- `daily` (default): Verifies that the run was executed under the canonical configuration (`CANONICAL_CONFIG`) and that the seed matches the deterministic daily seed (`dailySeed(dayUTC)`).
- `challenge`: Requires exact canonical configuration but allows custom link seeds.
- `any`: Replays arbitrary seeds and configs (development / regression testing only).

### Event Semantics
The `events` array records input actions in exact chronological submission order:
- `s:<L|R|U|D>`: Directional swipe submitted. A swipe producing no board change (blocked) replays as a legal no-op with no state change. Swipes later undone by Rewind are replayed when encountered and restored when the subsequent rewind event is executed.
- `a:<relicId>:<target>`: Player ability activation with serialized target payload (or `-` for Rewind).
- `d:<relicId>`: Relic draft selection resolving an offered draft decision.
- `m:<cell>`: Mason stone candidate placement resolving a Mason decision.
- `x:end`: Terminal run termination action via End Run. No events are permitted after `x:end`.

Replay ordering is strictly the array order (move numbers are never used for ordering). The pure verifier function `verifyRun(runLog, options)` re-simulates the game and asserts that `rulesVersion`, `replayVersion`, final board state, total moves at death, points score, max tile, relics owned, draft picks, `ascensions`, `endedByPlayer`, and Last Stand activations match the claimed values.


