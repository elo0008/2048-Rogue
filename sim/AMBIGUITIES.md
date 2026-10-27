# Ambiguities and Interpretations

This document details every rule interpretation made during the development of the 2048-Rogue simulator in accordance with the specification.

---

### 1. Initial Game Board Setup (Spawns at Move 0)
- **Ambiguity**: The Turn Order specification defines turn steps starting at Step 1 (slide) and spawning tiles at Step 5. Standard 2048 starts with 2 number tiles, but the initial state was not explicitly specified.
- **Interpretation**: A new game initializes at `moveCount = 0` with 2 number tiles (value 2 with probability 0.9, else 4), placed in uniformly random empty cells drawn from the pre-drawn tile spawn queue using the standard `(value, r)` spawn logic. For deterministic unit testing of specific boards, the configuration accepts `initialTiles: 0` so arbitrary boards can be set up without random starting tiles.

---

### 2. PRNG Seed Derivation for Independent Streams
- **Ambiguity**: The specification requires `mulberry32` with separate streams for (a) tile spawns, (b) stone spawns, and (c) draft offers, all derived from a single master seed `S`.
- **Interpretation**: To ensure decorrelated and strictly reproducible streams from `S`, seeds are derived as:
  - Tile spawn stream: `mulberry32(seed >>> 0)`
  - Stone spawn stream: `mulberry32((seed + 0x9E3779B9) >>> 0)` (golden ratio constant offset)
  - Draft offer stream: `mulberry32((seed + 0x3C6EF372) >>> 0)`
  - Bot decision stream (for random bot / random draft policy fallback): `mulberry32((seed + 0x7F4A7C15) >>> 0)`
  This guarantees 100% deterministic, byte-identical runs across seeds and configurations.

---

### 3. Pre-drawn Tile Spawn Queue and Foresight
- **Ambiguity**: "Tile-spawn draws are pre-drawn as (value, r) pairs, with position = floor(r * emptyCount) over the empty cells in row-major order at spawn time. This makes Foresight peekable."
- **Interpretation**: Each tile spawn tuple consumes exactly two draws from the tile stream: the first draw determines value (`rng() < 0.9 ? 2 : 4`), and the second draw determines `r`. The engine maintains a FIFO queue of pre-drawn tuples. Calling `peekSpawns(2)` inspects the next 2 tuples without mutating the PRNG state or popping from the queue. Tuples are only popped when `spawnOneTile` executes.

---

### 4. Diagonal Merge Cooldown and Turn Order Timing
- **Ambiguity**: Turn Order defines:
  1. Apply slide (with owned relic modifications).
  2. Apply post-slide relic effects (Diagonal Merge).
  3. `moveCount += 1`.
  However, the relic description states: "usable on every 3rd move (moveCount % 3 == 0). Must also be testable with cooldown 1." If evaluated literally before Step 3's increment when `moveCount === 0`, `0 % 3 === 0` is true, which would trigger diagonal merge on moves 1, 4, 7 instead of "every 3rd move" (moves 3, 6, 9).
- **Interpretation**: "Every 3rd move" is interpreted as triggering on moves 3, 6, 9. Since Step 2 is executed immediately before Step 3 increments `moveCount`, the move currently executing is move number `m = state.moveCount + 1`. The cooldown check is implemented as `(state.moveCount + 1) % cooldown === 0`. With default cooldown 3, it activates on moves 3, 6, 9; with cooldown 1, it activates on every move.

---

### 5. Diagonal Merge Tie-Breaking with Identical First Cells
- **Ambiguity**: The spec specifies: "highest value first, ties broken by row-major order of the first cell. The merged tile (2x) takes the earlier cell in row-major order; the other cell empties." If two candidate diagonal pairs share the same first cell `c1` and same value (for example `(c1, c2a)` and `(c1, c2b)`), tie-breaking between the second cell was unspecified.
- **Interpretation**: Ties where both value and first cell `c1` are equal are broken by `c2` in ascending row-major order (`a.c2 - b.c2`).

---

### 6. Triple Threat Merge Counting & Scoring
- **Ambiguity**: In `triple_threat`, 3 equal adjacent tiles merge into one tile of value `4v`. Pressure Cooker states "Each merge adds +2 to bonusScore." Does a triple merge count as 1 merge event or 2 pair merges?
- **Interpretation**: A triple merge is counted as 1 merge event (producing 1 merged tile of `4v`), which awards +2 to `bonusScore` under Pressure Cooker.

---

### 7. Fault Line Processing Direction
- **Ambiguity**: "for each line in the slide direction, process stones from the leading end backward: a stone shifts one cell in the slide direction iff the cell beyond it is empty AND the cell immediately behind it holds a number tile. Then perform the normal slide with stones as blockers."
- **Interpretation**: For each line in the slide direction, line indices are ordered `0` (leading) to `3` (trailing). We iterate `k` from 0 to 3. If cell `k` holds a stone, cell `k-1` is empty (`=== 0`), and cell `k+1` holds a number tile (`> 0`), the stone moves to `k-1` and cell `k` is set to 0. The number tile at `k+1` does not move during this phase; it slides during the subsequent normal slide.

---

### 8. Anchor Row Perpendicular Slide Mechanics
- **Ambiguity**: "Sliding PERPENDICULAR: an anchored cell acts as a barrier; an arriving tile merges into the anchored tile if equal (anchored tile doubles, stays in place, once per move), otherwise stops adjacent; an arriving tile entering an EMPTY anchored cell occupies it and becomes fixed."
- **Interpretation**:
  - The anchored cell is fixed at index `ancIdx` along the line and never moves forward toward the leading edge.
  - Cells ahead of `ancIdx` (`0` to `ancIdx - 1`) slide toward the leading edge independently.
  - Cells behind `ancIdx` (`ancIdx + 1` to `3`): the first arriving tile interacts with the anchored cell:
    - If the anchored cell is empty (0), the arriving tile moves into the anchored cell and becomes fixed.
    - If the anchored cell holds an equal number tile, it merges into the anchored cell (doubling it); the anchored cell can only merge once per turn.
    - Otherwise (stone or different number tile), the arriving tile stops at `ancIdx + 1`.
  - Remaining trailing tiles compact and merge among themselves behind `ancIdx` according to standard segment rules.

---

### 9. Draft Triggering on Skipped Thresholds
- **Ambiguity**: "When a tile of value equal to the next unreached threshold is first created, offer 3 distinct unowned relics...". Under `triple_threat`, merging three 16s creates 64, which jumps over threshold 32.
- **Interpretation**: The engine checks `while (nextThresholdIndex < thresholds.length && highestTile >= thresholds[nextThresholdIndex])`, triggering each passed threshold in sequence so no draft offers are missed when a threshold is skipped.

---

### 10. Sampling Without Replacement (Draft Offers & Mason)
- **Ambiguity**: The exact PRNG sampling mechanism for picking distinct items.
- **Interpretation**:
  - **Draft Offers**: From `pool = [...unowned]`, draw `idx = floor(draftRng() * pool.length)`, push `pool[idx]` to offers, and remove it from `pool` with `splice`. This guarantees up to 3 distinct relics with uniform distribution.
  - **Mason Stone Cells**: From `emptyCells`, draw `i1 = floor(stoneRng() * emptyCells.length)`. From `remaining = emptyCells.filter(c => c !== c1)`, draw `i2 = floor(stoneRng() * remaining.length)`. This guarantees 2 distinct candidates in exactly 2 stone PRNG calls.

---

### 11. Greedy Bot Evaluation: Stones Adjacent to Number Tiles
- **Ambiguity**: Greedy evaluation includes `- 3 * (number of stones adjacent to a number tile)`.
- **Interpretation**: Evaluated as the count of stone tiles on the board that have at least one orthogonal neighbor (up, down, left, or right) containing a number tile (`> 0`).

---

### 12. Greedy Bot Corner Bonus on Multiple Max Tiles
- **Ambiguity**: Greedy evaluation includes `+ 5 * (1 if max tile is in a corner)`. If multiple tiles share the maximum value on the board and at least one is in a corner.
- **Interpretation**: Awarded +5 if *any* tile matching the maximum tile value on the board is located at one of the four corner indices (0, 3, 12, 15).

---

### 13. Draft Flow Across Experiments (E1 Baseline vs. E2/E3 vs. E4)
- **Ambiguity**: The spec describes E1 as "baseline: no relics", E2 as "solo: for each relic, forced owned from move 0", E3 as "pairs: for each of the 28 relic pairs, both forced from move 0", and E4 as "random draft: normal draft flow with the random policy". Initially, the engine evaluated draft triggers unconditionally whenever thresholds [32, 64, ...] were reached, which caused E1 runs reaching 32+ to draft relics (such as `pressure_cooker`, leading to `score > moveCount`).
- **Interpretation**: E1 is strictly "no relics", E2 is strictly "solo" (isolating that single relic), and E3 is strictly "pairs" (isolating that pair). Therefore, drafting is explicitly disabled (`enableDraft: false`) for E1, E2, and E3 so no extraneous relics are acquired during runs. Only E4 activates the milestone draft system (`enableDraft: true`).

---

### 14. Ascension (`ascensionAt`)
- **Opt-in Rule & Trigger**: Configured via `config.ascensionAt` (default `null` = off; any positive integer power of two enables it). State tracks `ascensionLevel` (starts at 0) and `ascensions = []` (records `{ move, value, payout, destroyedTiles, destroyedStones }`).
- **Trigger Condition**: During a valid swipe's slide phase or in a Diagonal ability merge, a merge CREATES a tile with value `v >= ascensionAt` AND `v > state.ascensionLevel`. Pre-existing tiles never trigger ascension; Eraser removals never trigger ascension. Creating the same threshold value again does not retrigger; only strictly higher created thresholds retrigger (`v > state.ascensionLevel`).
- **Survivor Rule**:
  1. Destroys every stone (`STONE` / `'S'`) on the board.
  2. Destroys every number tile with value `< ascensionAt`.
  3. Tiles with value `>= ascensionAt` survive in place (for example, a lone newly formed 2048 or previously formed higher tiles stay exactly where they were).
- **Points & Accounting**:
  - `points += sum of face values of destroyed number tiles` (raw face values, unmultiplied; destroyed stones award 0).
  - Payout does NOT alter `moveCount` or `score`.
- **Stone Clock**:
  - `movesSinceLastStone = 0`. The hazard interval counter is reset, meaning a new stone will spawn exactly `interval` moves later.
- **Rewind Stack**:
  - `state.rewindStack = []`. The entire rewind stack is wiped, making it impossible to undo across an ascension event.
- **Turn Order**:
  - Swipe: Slide with relic modifications -> Post-slide effects (including Shatter, Fault Line) -> Scoring -> **ASCENSION** -> `moveCount += 1` -> Draft checks -> Tile spawn -> Stone spawn -> Game-over check.
  - Ability (Diagonal): Ascension applies immediately after the diagonal merge; free action semantics remain unchanged.
- **RNG Determinism & SpawnQueue**:
  - Ascension performs zero PRNG draws and does NOT mutate or advance `spawnQueue`. PRNG states across all streams (`tileRng`, `stoneRng`, `draftRng`) remain bit-identical before and after the wipe.
- **State Flags**:
  - Recomputes `stuckNeedsAbility` and `gameOver`. An ascension out of a stuck state clears `stuckNeedsAbility = false` and `gameOver = false` when valid moves now exist on the cleared board.

---

### 15. End Run (`endRun`)
- **Action**: Engine function `endRun(state)`. Sets `state.gameOver = true`, `state.endedByPlayer = true`, `state.moveNumberAtDeath = state.moveCount`, and clears `stuckNeedsAbility = false` and `pendingDecision = null`.
- **Preconditions**: Throws `Error('Cannot end run: game is already over')` if `state.gameOver` is already true.
- **Post-Game Over Behavior**: Exactly mirrors standard game over:
  - `step(state, dir)` and `stepInteractive(state, dir)` return `{ valid: false, ... }` (no-op).
  - `useAbility(state, relicId, target)` throws `Error('Cannot use ability: game is over')`.
  - `resolve(choice)` on pending decisions throws `Error('Cannot resolve decision: game is over')`.
- **Controller & Events**:
  - `GameController.endRun()` invokes engine `endRun(state)`, records `x:end` in `this.events`, and finalizes the run.
  - Verifier treats `x:end` as a valid terminal run event; any events appearing after `x:end` cause `REJECT`.

