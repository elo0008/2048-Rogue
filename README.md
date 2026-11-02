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
  - Achieving a 2048 tile (or configured threshold via `?ascension=N`) triggers the strictly sequential Clean Slate ceremony (total duration <= ~3.6 s; <= ~1.8 s in reduced motion):
    - **Phase A (Triggering Slide):** The triggering swipe's slide and merge complete normally; the pre-wipe board (all tiles and stones) remains visible throughout Phases B and C.
    - **Phase B (Banner Stamp, T=0 to ~1850 ms):** Reuses the Last Stand stamp component (IN 240 ms, HOLD 1230 ms, OUT 380 ms, board shake, centered impact wave, thud sound). Displays triggering tile value (e.g. "2048", "4096", "64") with dynamic uppercase tagline: `2048` -> `"We Won"`, `4096+` -> `"Touch Grass"`, any other threshold -> `"Clean Slate"`.
    - **Phase C (Survivor Charge-Up, ~450 ms):** Starts ~150 ms after banner fully exits; surviving max tile glows with moderate gold halo (`box-shadow` alpha <= 0.6, blur <= 18px, zero scale or layout change) accompanied by a rising shimmer sound.
    - **Phase D (Shockwave Ring, ~700 ms):** An expanding gold ring emanates from the survivor cell center with ease-out expansion reaching the farthest board corner (border >= 3px, peak opacity >= 0.7, soft glow, low thud sound).
    - **Phase E (Ring-Driven Breaks):** Each destroyed element breaks exactly when the ring front crosses its center (computed via inverted easing: $u = 1 - \sqrt{1 - r/R_{\max}}$). Tiles break with eraser vanish and shard burst; stones break with stone-shatter effect. Concurrent DOM particle elements are strictly capped at <= 80 across all active breaks. Break audio is throttled to at most 1 sound per 60 ms and <= 6 in total.
    - **Phase F (Payout):** The `+N` payout popup appears near the survivor right after the final break; the HUD SCORE holds the pre-payout score until this moment and reveals full score then.
    - **Input Policy:** Swipes and ability-button taps during Phases B through E are strictly ignored (no buffering, no sound, no error, not recorded in `events` or `inputMethodCounts`). Pause, Play Again, or `visibilitychange` instantly resolves the ceremony to final state. Any pending draft decision is held until the ceremony completes.
    - **Reduced Motion:** If `prefers-reduced-motion` is active, the banner remains static for ~1.4 s (same dynamic text), elements fade simultaneously in <= 150 ms, no ring or charge-up is spawned, and total ceremony completes in <= 1.8 s under the same input lock.

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

---

## Diagonal Press Wave Rewind & Ability Micro-Interactions

The Rewind ability features a physical "diagonal press wave" animation driven by the Web Animations API (WAAPI) and orchestrated by `WaveDirector`, paired with tactile micro-interactions on the bottom ability cards.

### 1. Spatial Geometry & Press Wave Formulation
The board cells press straight down into the screen from top-left to bottom-right along diagonal wavefronts:
- **Diagonal Wavefront Coordinate**:
  $$m(\text{cell}) = \text{row} + \text{col} \in [0..6]$$
  Cell start delay is strictly deterministic with no randomness:
  $$\text{cellDelay} = m \cdot \text{stepMs} = m \cdot 80\text{ ms}$$
  Total group duration across all 16 cells and empty sockets:
  $$T_{\text{wave}} = 6 \cdot \text{stepMs} + \text{sinkMs} + \text{riseMs} = 6(80) + 150 + 200 = 830\text{ ms}$$
- **Stage Switch (`tile` vs `board`)**:
  - `stage: 'tile'` (default): Pure press with vanishing point at each element's own centre (no `preserve-3d` needed). Sinks straight down into the screen with zero lateral drift ($< 0.001\text{ px}$):
    $$\text{rest} = \text{perspective(900px) translateZ(0px) scale(1)}$$
    $$\text{nadir} = \text{perspective(900px) translateZ(-240px) scale(0.9)}$$
    In this stage, `translateZ(-240px)` produces a uniform scale-down $(900/(900+240) = 0.789)$ which combined with `scale(0.9)` yields a resting-to-nadir width ratio of $0.789 \times 0.9 \approx 0.710$.
  - `stage: 'board'`: Shared vanishing point at board centre with `transform-style: preserve-3d` on `#tiles-layer`. Corner tiles exhibit realistic lateral perspective convergence.
- **Unified Visual Unit inside `.tile-face`**:
  - The outer `.tile` container is rendered with `background: transparent !important`, border none, and box-shadow none.
  - All visual surfaces (tile backgrounds, colors, gradients, inner borders, bevels) and number text reside entirely within `.tile-face`.
  - Ensures a single, indivisible visual unit per cell: the number text and tile background cannot desynchronize, fade separately, or become blank colored squares during animations.
- **Untouched Cells Invariant**:
  - Unreached cells ($t < m \cdot \text{stepMs}$) remain strictly in their resting state with computed `transform: none` and full opacity until the wavefront arrives at their diagonal.
  - Keyframe 0 uses `{ transform: 'none' }` with `fill: 'forwards'`.
  - No premature inline `willChange` writes or pre-promotions at $t=0$.
- **Separate Transform and Opacity Animations**:
  - Sink transform: rest $\to$ nadir over $150\text{ ms}$ with `cubic-bezier(0.4, 0, 1, 1)`.
  - Sink opacity: $1.0$ until $60\%$ progress, then fades to $0.0$ at $100\%$ (separate Animation object on `.tile-face`).
  - Rise transform: nadir $\to$ rest over $200\text{ ms}$ with `cubic-bezier(0.34, 1.56, 0.64, 1)` (elastic settle).
  - Rise opacity: $0.0 \to 1.0$ over first $45\%$ duration with ease-out (separate Animation object on `.tile-face`).
- **Empty Socket Ripples**:
  - Cells without tiles or stones undergo an empty socket ripple: `.cell` element scales $1.0 \to 0.94 \to 1.0$ (offsets $0, 0.45, 1$) over $350\text{ ms}$. Cells with tiles/stones do not ripple.
- **Per-Cell Nadir Swap**:
  - As each cell's sink reaches progress $1.0$ (nadir, opacity $\le 0.02$), the old element is cleanly removed and a fresh element is created at inline `opacity: 0` and nadir pose before rise.
  - Bookkeeping label: `syncBoard(..., 'rewind-cell-swap')`.
  - HUD values (score, moves, countdowns) update at the exact moment the first cell with $m = 3$ swaps.
- **Coalescing Delta Waves**:
  - If a player rushes rewind taps during a wave, subsequent taps update the authoritative engine board.
  - Cells that have not yet swapped naturally reveal the newest engine state.
  - Upon wave group completion, `displayed[]` is compared against engine board. If any discrepancies exist, a focused **delta wave** runs covering only the divergent cells, offset by $(m - m_{\min}) \cdot \text{stepMs}$.

### 2. REWIND_FX Configuration Object
```javascript
export const REWIND_FX = {
  mode: 'wave', // 'wave' (diagonal press wave) or 'vortex' (3D sink & resurface)
  stage: 'tile', // 'tile' (pure press, zero drift) or 'board' (shared vanishing point)
  perspective: 900,
  zDepth: 240,
  sinkScale: 0.9,
  stepMs: 80,
  sinkMs: 150,
  riseMs: 200,
  sinkEasing: 'cubic-bezier(0.4, 0, 1, 1)',
  riseEasing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  socketPress: 0.94,
  shimmerOnUse: true,
  rampMs: 140,
  catchUpMs: 220,
  maxRate: 6,
  reverseRate: 1.5,
  queueMax: 4
};
```

### 3. Tactile Ability Card Micro-Interactions & Glass Shine
- **H1: Icon Tilt**:
  - On Diagonal Merge, Eraser, and Rewind buttons, the glyph icon rotates $-11^\circ$ on hover for fine pointers (`@media (hover: hover) and (pointer: fine)`).
  - Touch/coarse pointers apply the same tilt on `:active` (preventing sticky hovers in mobile browsers).
  - Transition: `transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)` with `transform-origin: 50% 55%`.
  - Disabled cards never tilt. Reduced motion disables tilt.
- **H2: Card Glass Shine Architecture**:
  - Each ability card button (`.ability-btn`) contains a dedicated child wrapper:
    ```html
    <span class="card-shine" aria-hidden="true"></span>
    ```
  - The `.ability-btn` preserves `overflow: visible` so badges, counters, pips, and tooltips are never clipped.
  - `.card-shine` handles edge containment cleanly via `overflow: hidden; border-radius: inherit; pointer-events: none;`.
  - The light-sweep is rendered via `.card-shine::before`:
    - Resting state: `opacity: 0; transform: translateX(-130%); animation: none;`. Zero pale block or edge residue.
    - Animation: `@keyframes card-shine-sweep` travels from `translateX(-130%)` to `translateX(240%)` over $700\text{ ms}$ `cubic-bezier(0.2, 0.8, 0.2, 1)`.
    - Midpoint opacity peaks at $1.0$ at $50\%$, tapering cleanly to $0.0$ at both $0\%$ and $100\%$ with `animation-fill-mode: none`.
  - Triggered on all three ability cards (Diagonal Merge, Eraser, Rewind):
    - Hover on fine pointers (`.ability-btn:not(:disabled):hover .card-shine::before`).
    - Programmatic trigger on ability activation via `.ability-btn.shimmer .card-shine::before` (invoked by `triggerCardShimmer(relicId)` and cleaned up on animation end).
    - Fully disabled under `@media (prefers-reduced-motion: reduce)`.
- **Smoothness Rule**: Once any rewind animation has started, in-flight elements are never prematurely cancelled or snapped; rushed input is handled strictly by smooth `playbackRate` time-scaling (`rampMs = 140`, `catchUpMs = 220`, `maxRate = 6`) and FIFO queueing.

---

## Developer Lab (Animation & Preset Staging)

A dedicated, isolated developer testing tool is available to trigger the Clean Slate ceremony phases and Rewind wave animations instantly on physical mobile devices or desktop browsers without needing to play to 2048.

The lab is completely stripped from production releases (`npm run build`), leaving zero traces, zero tokens, and zero DOM nodes in `dist/`.

### 1. Running Locally
Build and launch the dev distribution:
```bash
npm run serve:dev
```
This automatically compiles the dev target to `dist-dev/`, starts the server listening on all network interfaces (`0.0.0.0`), and prints the available localhost and LAN URLs:
```
Local:   http://localhost:3000/?lab=1
Network: http://<lan-ipv4>:3000/?lab=1
```
Open the printed URL with `?lab=1`. A collapsed **LAB** handle appears at the bottom-left of the viewport (touch target $\ge 36\text{px}$, non-overlapping with the board or ability bar). Tapping the handle opens the bottom sheet.

### 2. Testing from a Mobile Device over LAN
1. Ensure your mobile phone and development machine are connected to the same local Wi-Fi network.
2. Ensure incoming traffic on port 3000 is allowed through your development machine's firewall / private network settings (allow when prompted by OS).
3. On your mobile phone browser, navigate to:
   ```
   http://<your-dev-machine-lan-ipv4>:3000/?lab=1
   ```
4. Tap the collapsed **LAB** handle at the bottom-left to stage presets (1–9), test Hold-at-Phase boundaries, verify reduced motion, or run loop repetitions.

### 3. Deploying to Vercel (Preview Deployments)
To test the Animation Lab on real mobile devices via Vercel preview URLs, perform the following manual configuration steps in the Vercel dashboard:
1. **Set Environment Variable:**  
   In **Project Settings** $\to$ **Environment Variables**, create an environment variable:
   - **Key:** `BUILD_TARGET`
   - **Value:** `dev`
   - **Scope:** Select **Preview** ONLY (ensure **Production** and **Development** are unselected).
2. **Confirm Deployment Protection:**  
   In **Project Settings** $\to$ **Deployment Protection**, ensure **Vercel Authentication** or **Password Protection** is enabled for Preview deployments.  
   > **Security Note:** State plainly that nothing hides the dev build from someone who has its URL if preview protection is off. Anyone with access to the preview URL can view the dev build and open `?lab=1`.
3. **Open Preview URL:**  
   Push any feature branch (non-`main`). While authenticated on your mobile phone, open the resulting preview deployment URL with `?lab=1`:
   ```
   https://<project-preview-domain>.vercel.app/?lab=1
   ```
4. **Production Stays Clean:**  
   The build pipeline strictly enforces production protection: `scripts/build.js` contains a build guard that immediately terminates with an error if `BUILD_TARGET=dev` is attempted when `VERCEL_ENV === 'production'` or when building the `main` branch. Merges into `main` and production deployments will always compile as `BUILD_TARGET=prod`, completely excluding `game/dev/` and stripping all marked lab code.



