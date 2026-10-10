# 2048-Rogue Prototype Implementation Notes

This document records the architectural approach, technical decisions, risks, and mitigations implemented for the playable single-page HTML5 prototype of 2048-Rogue.

---

## 1. Engine Support for Human Player (Stage 1)

### 1.1 Approach: Continuation-Based Interactive Stepping
The simulator engine's `step(state, direction, bot)` function is synchronous and invokes bot callbacks (`chooseStoneCell` for Mason, `chooseDraftRelic` for drafts) in the middle of a step. RNG streams in `mulberry32` are stateful closures, and past state-cloning attempts had bugs, meaning cloning RNG state is unsafe.

To allow human players to make decisions asynchronously in a UI without altering the deterministic bot path:
1. **Opt-in Only Separation**: We implemented `stepInteractive(state, direction, options = { interactive: true })`, invoked when `options.interactive === true` in `step()`.
2. **Continuation Object**: When a human decision is needed (either a relic draft or Mason stone placement), the engine halts the step and returns a `pendingDecision` object:
   - `type`: `'draft'` | `'mason'`
   - `offers`: Array of 3 offered relic IDs (for draft)
   - `candidates`: Array of 2 candidate cell indices (for Mason)
   - `resolve(choice)`: A continuation closure capturing the exact mid-step execution state. Calling `resolve(choice)` resumes the turn at the exact line of execution.
3. **Draft Queueing**: If multiple draft events occur in a single move (e.g. crossing a threshold and matching `draftEveryMoves`), `pendingDraftInfos` queues the events in FIFO order. Each `resolve` call advances to the next draft in the queue until all drafts are resolved, then seamlessly flows into tile and stone spawns.
4. **Exposed UI Introspection**: Added non-invasive helpers without modifying game rules:
   - `getNextStoneInfo(state)`: returns `{ interval, movesUntilNextStone, movesSinceLastStone, isDue }`
   - `getRelicsInfo(state)`: returns `{ owned, activations }`
   - `getForesightPreview(state)`: previews the next 2 tile spawns and destination cells, and indicates if a stone is due on the next move.
   - `buildHazardSchedule(multiplier)`: builds standard scaled hazard schedules (default 3x).
   - Step results include `boardBefore` and `boardAfter` for visual diffing.

### 1.2 Risks & Mitigations
- **Risk: Closure / RNG Desynchronization**: Drawing extra numbers or changing draw order would break determinism.
  - *Mitigation*: For drafts, the 3 offers are drawn from `state.rngs.draft()` immediately when the draft event is detected, exactly as in the bot path. The human player's choice does not advance the RNG. In the automated controller parity test, greedy bot resolves random drafts by querying `state.rngs.draft()`, matching the sim's draw order with 100% bit-level parity across all 450 test runs.
- **Risk: Multi-phase Turn Interruptions**: If both a draft and a Mason stone placement occur on the same move.
  - *Mitigation*: The step continuation functions are chained: `processNextDraft()` -> `runSpawnsAndFinish()` -> Mason check -> `finalizeTurn()`. Each phase returns a pending decision if player input is needed, and resumes the sequence when resolved.
- **Risk: Bot Path Regressions**: Changes to engine files could alter bot benchmark behavior.
  - *Mitigation*: STAGE 0 golden test records SHA-256 hashes of all 630 runs across 50 seeds and 9 configurations. All hashes remain 100% identical.

---

## 2. Controller Architecture (Stage 2)

`game/controller.js` is a pure ES module wrapper around the engine with zero DOM dependencies:
- `newRun(seed, configOverrides)`: Initializes a fresh game state, tracks unique `runId`, `seed`, `startTimestamp`, move history, and draft metrics.
- `submitMove(direction)`: Executes `step(state, direction, null, { interactive: true })`. If valid and a decision is pending, exposes `pendingDecision`.
- `hasPendingDecision()` / `getPendingDecision()`: Clean accessors for UI / test runner.
- `resolveDecision(choice)`: Resolves draft picks or Mason cell selections, recording decision time (`decisionMs`).
- `getRunLog()`: Compiles the full run record specified in STAGE 4.

---

## 3. Decisions Not Explicitly Specified

### 3.1 Board Sizing & Responsiveness
- The specification required `min(viewport width - 32px, viewport height - 260px)`. We implemented this via CSS `var(--board-size): min(calc(100vw - 32px), calc(100vh - 260px), 480px)`.
- Capped at 480px on desktop to maintain balanced visual density while leaving ample room for header stats and relic chips.
- Applied `touch-action: none` to `#game-board` to prevent iOS/Android browser scroll gestures during swipe play.

### 3.2 Mason UI Interaction
- When Mason stone spawn triggers, candidate grid cells receive class `.mason-candidate`, which renders a pulsing dashed crimson border and a centered "TAP HERE" label.
- The status bar displays a hint: *"Mason: Choose where the stone lands (tap a highlighted cell)"*. Tapping either candidate places the stone, clears the highlights, and advances the game.

### 3.3 Honest Foresight UI Preview
- Previously, the ghost-tile preview attempted to calculate destination cells using the pre-move board, which produced inaccurate positions because the engine places tiles on empty cells of the post-slide board.
- Replaced with an honest preview: exposes only the numeric VALUES of the next 2 tile spawns and a prominent indicator when a stone is due on the next move (`stoneDue: true`). No cell positions are shown.
- Updated one-liner description to: *"See the values of the next 2 tile spawns and when a stone is due."*
- Rendered in a dedicated `#foresight-bar` above the board.

### 3.4 Draft Pool & ?pool= URL Parameter
- Default draft pool updated to the 6 core relics: `diagonal_merge`, `fault_line`, `mason`, `siphon`, `shatter`, `last_stand`.
- `foresight` is excluded from the default draft pool, but remains fully playable and selectable via URL parameters:
  - `?pool=diagonal_merge,mason,foresight`: Custom draft pool.
  - `?start=foresight`: Direct injection at game start.

### 3.5 resolve() Validation
- Both engine `stepInteractive` and `GameController.resolveDecision` now strictly validate player selections:
  - Draft resolution throws an `Error` if `pick` is not in `offers`.
  - Mason stone placement throws an `Error` if `chosenCell` is not in `candidates`.

### 3.6 draftFirstAt Semantics
- When `draftFirstAt` is set: first draft triggers at `draftFirstAt`, and subsequent drafts trigger every `draftEveryMoves` after it:
  `moveCount === firstAt || (moveCount > firstAt && (moveCount - firstAt) % draftEveryMoves === 0)`.
  Example: `draftFirstAt=30, draftEveryMoves=60` triggers drafts at moves 30, 90, 150.
- When `draftFirstAt` is unset / null: behavior remains strictly unchanged, triggering on multiples of `draftEveryMoves` (`moveCount % draftEveryMoves === 0`, e.g. 60, 120, 180). This guarantees golden fixtures remain 100% bit-identical.

### 3.7 Sim Hygiene & cloneState Missing Fields
- Investigated `cloneState(state)` across 200 random mid-game states. Fixed missing fields in `cloneState`:
  - `tripleMerges`
  - `relicsInjected`
  - `seed`
- Verified deep-equality across all keys except `rngs` references.

### 3.8 Noisy Bot Seeding
- `createNoisyBot(base, eps)` derives its PRNG stream directly from the game seed: `mulberry32((state.seed + 0x77777777) >>> 0)`.
- The stream resets each run (detected when `state.seed` changes, `state.moveCount === 0`, or `state.moveCount <= lastMove`), guaranteeing identical noisy decisions when running the same seed twice with the same bot instance.

### 3.9 Rollout Bot & Common Random Numbers (CRN)
- Common Random Numbers (CRN) are adopted in `createRolloutBot` in `sim/bots.js`:
  `rolloutSeed = (state.moveCount * 10007 + p * 67 + 99991) >>> 0`.
- By removing `oIdx * 257` from `rolloutSeed`, all candidate offers at a given draft decision now face identical playout seeds for each playout index `p`, eliminating variance between offer evaluations and adhering to CRN principles while keeping determinism intact.

### 3.10 Relic Feedback & Visual Diffing
- Relic activation feedback compares `state.relicActivations` before and after each step:
  - Displays a toast with the relic name (e.g. "Diagonal Merge!", "Shatter!", "Siphon!").
  - Cells where stones vanished (e.g. from Shatter or Last Stand) flash red via `.cell-vanish-flash`.
  - Merged tiles trigger a `.tile-merge` pop animation (~150ms).
  - Last Stand triggers a full-screen vignette flash and a prominent banner: *"LAST STAND: Critical Threshold Triggered - Low value tiles disintegrated &bull; Play on!"* for 1.3 seconds.

### 3.11 Dynamic Relic Descriptions
- Relic descriptions dynamically interpolate active configuration values:
  - `diagonal_merge`: Generates proper English ordinals (e.g., `Every 3rd move`, `Every 2nd move`, `Every 4th move`).
  - `siphon`: Interpolates `siphonMin` (default `16+`).
  - `shatter`: Interpolates `shatterMin` (default `64+`).
  - `last_stand`: Interpolates `lastStandMax` (default `16`).

### 3.12 LocalStorage & Logging Resilience
- All localStorage access is wrapped in `try { ... } catch { ... }` blocks to allow full gameplay in private/incognito browsing modes or environments where storage is blocked.
- "Copy run log" attempts `navigator.clipboard.writeText(json)`. If rejected or unsupported, it falls back to creating an in-memory `Blob` and triggering a browser download (`2048-rogue-history-<timestamp>.json`).

### 3.13 URL Configuration Dial Defaults
- Matches specified game defaults:
  - Stones: 3x hazard schedule (`buildHazardSchedule(3)`)
  - `draftEveryMoves`: 60
  - `draftFirstAt`: unset
  - `draftThresholds`: empty (tile thresholds disabled)
  - `draftPool`: 6 default relics (`diagonal_merge, fault_line, mason, siphon, shatter, last_stand`)
  - Starting relic: none
- Supported URL parameters:
  - `?seed=N`: Replay a specific seed
  - `?pool=a,b,c`: Custom draft pool (unknown IDs are ignored with `console.warn`; falls back to default pool if no valid IDs remain)
  - `?draft=N`: Set `draftEveryMoves`
  - `?first=N`: Set `draftFirstAt`
  - `?stones=N`: Scale hazard schedule by multiplier N
  - `?start=<id>`: Inject starting relic at move 0
  - `?shatter=N`: Set `shatterMin`
  - `?siphon=N`: Set `siphonMin`
  - `?diag=N`: Set `diagonalMergeCooldown`
  - `?laststand=N`: Set `lastStandMax`
  - `?debug=1`: Open debug panel with RNG draw counts, move counter, and relic activations.

### 3.14 Layout Stability & Accessibility Fixes (Iteration D)
- **Header Fixed Height & Zero Board Shift**: `.game-header` is given a fixed height of `142px` with `overflow: hidden` and `white-space: nowrap` across the title row, hazard box, and relic chips. The board top position remains constant across all hazard countdown states, eliminating vertical board shift when countdown transitions between 1-digit and 2-digit values.
- **Title Clearance**: At 390px viewport width, the gap between the game title and the hazard box is maintained well above 8px.
- **Hazard Grammar**: Pluralization dynamically changes between `"1 move"` and `"N moves"`.
- **Foresight Formatting**: Space added after `"FORESIGHT:"`.
- **WCAG AA Compliance**: Status hint bar and Mason prompts exceed the 4.5:1 WCAG AA contrast standard.

---

## 4. Player-Triggered Abilities & Stone-Group Cap (Iteration E)

### 4.1 New Ability Relics (`diagonal_charge` & `eraser`)
Two new player-activated ability relics are added:
- `diagonal_charge` (Display: **"Diagonal Merge"**, id `diagonal_charge`):
  - *Target*: `{ a, b }`: two equal-value number tiles diagonally adjacent.
  - *Effect*: Merges into one tile of 2x value placed at the earlier cell in row-major order (`min(a, b)`). The other cell empties.
  - *Synergies*: If Shatter is owned and the created tile value $\ge$ `shatterMin`, Shatter triggers (destroying adjacent stones and incrementing shatter activations). Never triggers Siphon (which only checks slide-phase merges).
  - *One-liner*: *"Charge: merge two equal tiles touching diagonally (you pick). Holds up to {max}; +1 every {N} moves. Costs no move."*
- `eraser` (Display: **"Eraser"**, id `eraser`):
  - *Target*: `{ cell }`: any single cell currently holding a number tile (any value).
  - *Effect*: Removes the tile completely. Stones and empty cells are illegal targets.
  - *One-liner*: *"Charge: remove any one tile. Holds up to {max}; +1 every {N} moves. Costs no move."*

### 4.2 Ability Charges, Cooldown, and Free-Action Rules
- **Cap**: Maximum 3 charges each (`maxCharges: 3` default).
- **Acquisition**: Gaining the relic (via draft, `forcedRelics`, or `?start=`) initializes with `charges = 1`, `counter = 0`, and `swipesAtMax = 0`.
- **Cooldown**: Cooldown ticks at the end of each valid swipe, but *only* for ability relics owned at the *start* of that swipe, and *only* while `charges < maxCharges`.
  - At max charges, cooldown does not tick; instead, swipes are counted in `swipesAtMax`.
  - When the counter reaches N (`diagonalChargeEvery: 10`, `eraserEvery: 20` default), `charges += 1` and `counter = 0`.
  - Cooldown ticks *before* evaluating the stuck check.
- **Free Action Invariants**: Using an ability is a pure free action:
  - Does NOT increment `moveCount`.
  - Does NOT spawn number tiles.
  - Does NOT tick hazard schedule countdown / stones.
  - Does NOT draw from `spawnQueue`.
  - Does NOT trigger drafts.
  - Does NOT tick ability cooldown counters.

### 4.3 Stuck Rule & Last Stand Sequencing
- When no valid swipe exists on the board:
  - If any ability relic has `charges > 0` AND a legal target, the run is NOT over. State sets `stuckNeedsAbility = true`.
  - Last Stand does NOT trigger while an ability option remains.
  - If no swipe exists and NO legal ability action remains: Last Stand triggers (if owned and unused), clearing low tiles and granting continuation. If Last Stand is unavailable or already used, game over.
  - Applied consistently across both bot path (`step`) and human interactive path (`stepInteractive`).

### 4.4 Note on Draft Thresholds
- **Important**: Highest-tile threshold drafts (`draftThresholds`) are unsupported alongside abilities. Free-action ability merges do not trigger slide-threshold drafts. In all configurations using abilities, `draftThresholds` remains `[]` (periodic `draftEveryMoves` is used instead).

### 4.5 Stone-Group Cap
- Option `stoneGroup` (default `['fault_line', 'mason', 'shatter']`) and `stoneGroupCap` (simulator default `null` = off, prototype default `2`).
- When owned group relics $\ge$ cap, remaining group relics are filtered out from draft offers in both bot and human draft paths.
- `forcedRelics` bypass the cap.

### 4.6 Default Relic Pool
- The default pool for the prototype is updated to:
  `['diagonal_charge', 'eraser', 'fault_line', 'mason', 'siphon', 'shatter', 'last_stand']`.
- The legacy auto relic `diagonal_merge` remains fully functional in code for backwards compatibility and tests, but is removed from the default pool.

### 4.7 Prototype UI & Responsive Enhancements
- **Ability Bar**: Positioned directly below the board, rendering each owned ability with its label, 3 charge pips (filled / empty), and cooldown status (`+1 in N moves` or `MAX` or disabled reason).
- **Targeting Mode**:
  - Cancelable via dedicated "Cancel (Esc)" button, pressing Escape, or tapping the active ability button again.
  - Diagonal Merge: Step 1 highlights all candidate tiles; step 2 highlights valid matching diagonal partners.
  - Eraser: Step 1 highlights number tiles; tapping a tile displays red outline with prominent "ERASE?" badge; tapping the same tile confirms deletion.
  - Disabled while drafts or Mason placements are pending.
- **Stuck Banner**: When `stuckNeedsAbility` is active, displays a red banner *"No swipes left, use an ability"* and pulses the ability buttons.
- **Last Stand Indicator**: Relic chip dynamically appends `(used)` and lowers opacity once Last Stand triggers.
- **Header Overflow Prevention**: Relic chips now reside in a single horizontally-scrolling strip (`overflow-x: auto`), maintaining a strict 142px header height with zero clipping.
- **320px Responsiveness**: Title row and hazard indicators scale seamlessly without wrapping or causing horizontal document scrolling across 320px, 360px, 390px, and 430px widths.
- **Run Log Additions**: Structured telemetry in `getRunLog()` captures `abilityUses`, `swipesAtMax`, `chargesAtDeath`, `inputMethodCounts` (`{ swipe, key, tap }`), `viewport`, `queryString`, `userAgent`, `buildId`, and serializes `Infinity` safely as string `"Infinity"`.



