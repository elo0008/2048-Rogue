# 2048-Rogue Headless Simulator

Headless, deterministic simulator for a roguelike variant of 2048 designed for bot balancing and rule evaluation prior to UI development.

- **Stack**: Node.js 18+, plain JavaScript (ES modules), zero npm dependencies.
- **Testing**: Built-in `node:test` runner.
- **Architecture**: Pure, UI-free engine suitable for headless simulation and future HTML5 reuse.

---

## File Structure

```text
/sim
├── engine.js            # Pure game logic, slide mechanics, RNG, and turn order
├── relics.js            # Relic metadata and definitions (8 relics)
├── bots.js              # Bot strategies (random, greedy, corner, Mason selection)
├── run.js               # Experiment CLI (E1, E2, E3, E4) with statistical aggregation
├── AMBIGUITIES.md       # Exact rule interpretations made
├── README.md            # Execution and usage instructions
├── out/                 # CSV outputs from experiments
└── tests/
    └── engine.test.js   # Unit and integration test suite
```

---

## Running Tests

Execute the test suite via Node's native test runner:

```bash
node --test sim/tests/engine.test.js
```

Or from project root:

```bash
npm test
```

### Test Coverage Highlights
- **Golden Cases**: Base 2048 slide rules, stone blockers, and invalid move rejections.
- **Relic Tests**: Minimum 2 hand-built boards with commented step derivations for each of the 8 relics.
- **Determinism**: Identical runs and state transitions under identical master seeds.
- **Standard Baseline**: Verification that the engine matches classic 2048 without relics.

---

## Running Experiments

Use `sim/run.js` to execute balancing experiments.

### CLI Usage

```bash
node sim/run.js [options]
```

### CLI Arguments

| Option | Flag | Description | Default |
|---|---|---|---|
| `--experiment` | `-e` | Experiment to run: `E1`, `E2`, `E3`, `E4`, or `all` | `E1` |
| `--runs` | `-n` | Number of simulation runs per configuration | `2000` (E4: `5000`) |
| `--bot` | `-b` | Bot strategy: `random`, `greedy`, `corner`, or `all` | `all` |
| `--seed` | `-s` | Master PRNG seed | `42` |
| `--cap` | `-c` | Maximum move cap before ending a run | `5000` |

### Experiment Types

1. **E1 Baseline**: No relics, evaluates baseline performance across all bots.
   ```bash
   node sim/run.js --experiment E1 --runs 2000
   ```

2. **E2 Solo**: Each of the 8 relics forced owned from move 0, evaluated across bots.
   ```bash
   node sim/run.js --experiment E2 --runs 2000
   ```

3. **E3 Pairs**: All 28 relic pair combinations forced owned from move 0, evaluated with `greedy` bot.
   ```bash
   node sim/run.js --experiment E3 --runs 2000
   ```

4. **E4 Random Draft**: Full game flow with milestone draft offers at thresholds `[32, 64, 128, 256, 512, 1024, 2048, 4096]` using the random draft policy. Reports relic pick rates (`picks / offers`).
   ```bash
   node sim/run.js --experiment E4 --runs 5000
   ```

### Outputs
- **Markdown Tables**: Printed to standard output with metrics: `n`, `median moves`, `p10`, `p90`, `mean score`, `mean max tile`, `% endless`, and flagging for endless rate > 1% or median > 2x E1 baseline.
- **CSV Files**: Exported directly into `sim/out/` (`e1.csv`, `e2.csv`, `e3.csv`, `e4.csv`).
