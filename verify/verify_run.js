/**
 * verify/verify_run.js
 *
 * Pure function verifyRun(runLog, expectedRulesVersion) that replays a run
 * from its seed, config, and `events` array to decide whether the claimed
 * result is reproducible and authentic.
 *
 * Environment: Pure ES module without Node-specific APIs (no fs, path, crypto, process).
 *
 * EVENT SEMANTICS:
 * Events are compact strings recorded in exact chronological submission order:
 *   - `s:<L|R|U|D>`: Swipes submitted. A swipe that produces no board change (blocked)
 *     replays as a valid no-op with no state change. Swipes later undone by Rewind are
 *     replayed normally when encountered, and then undone when the subsequent rewind event
 *     is replayed.
 *   - `a:<relicId>:<target>`: Player ability activation with serialized target payload
 *     (or `-` for Rewind).
 *   - `d:<relicId>`: Relic draft pick resolving a pending draft decision.
 *   - `m:<cell>`: Mason stone replacement candidate pick resolving a pending Mason decision.
 * Replay order is strictly the array order; move numbers are never used for ordering.
 */

import { GameController } from '../game/controller.js';

const MAX_EVENTS_LIMIT = 20000;
const MAX_EVENT_STRING_LENGTH = 128;

/**
 * Recursively deserializes config objects, restoring "Infinity" and "-Infinity"
 * strings to their numeric Infinity values as produced by serializeSafe in the UI.
 */
function deserializeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  try {
    return JSON.parse(JSON.stringify(cfg), (k, v) => {
      if (v === 'Infinity') return Infinity;
      if (v === '-Infinity') return -Infinity;
      return v;
    });
  } catch {
    return { ...cfg };
  }
}

/**
 * Extracts normalized claimed values from the run log.
 */
function extractClaimed(runLog) {
  if (!runLog || typeof runLog !== 'object') return null;
  return {
    points: runLog.points ?? runLog.score ?? 0,
    moves: runLog.moveNumberAtDeath ?? runLog.totalMoves ?? 0,
    maxTile: runLog.maxTile ?? 0,
    relicsOwned: Array.isArray(runLog.relicsOwned) ? [...runLog.relicsOwned] : [],
    gameOver: true,
  };
}

/**
 * Extracts current replayed state from the controller.
 */
function extractReplay(ctrl) {
  if (!ctrl || !ctrl.state) {
    return {
      points: 0,
      moves: 0,
      maxTile: 0,
      relicsOwned: [],
      gameOver: false,
    };
  }
  return {
    points: ctrl.state.points ?? ctrl.state.score ?? 0,
    moves: ctrl.state.moveCount ?? 0,
    maxTile: ctrl.state.highestTile ?? 0,
    relicsOwned: Array.from(ctrl.state.relics || []),
    gameOver: Boolean(ctrl.state.gameOver),
  };
}

/**
 * Verifies a single run log by full re-simulation.
 *
 * @param {object} runLog - Deserialized JSON run log
 * @param {string|null} expectedRulesVersion - Expected SHA-256 hash of sim/engine.js
 * @returns {object} { ok, status, reason, replay, claimed, ms }
 */
export function verifyRun(runLog, expectedRulesVersion = null) {
  const startTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const getElapsed = () => {
    const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return Math.round((end - startTime) * 100) / 100;
  };

  const claimed = extractClaimed(runLog);

  // Check 6: Event count limit and per-event length limit, checked first.
  if (!runLog || typeof runLog !== 'object') {
    return {
      ok: false,
      status: 'REJECT',
      reason: 'Invalid runLog: expected a non-null object',
      replay: null,
      claimed: null,
      ms: getElapsed(),
    };
  }

  // Legacy logs without events return status UNVERIFIABLE_LEGACY, never ok.
  if (!('events' in runLog) || !Array.isArray(runLog.events)) {
    return {
      ok: false,
      status: 'UNVERIFIABLE_LEGACY',
      reason: 'Legacy log missing events array',
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  if (runLog.events.length > MAX_EVENTS_LIMIT) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Event count (${runLog.events.length}) exceeds maximum limit of ${MAX_EVENTS_LIMIT}`,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  for (let i = 0; i < runLog.events.length; i++) {
    const ev = runLog.events[i];
    if (typeof ev !== 'string') {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Event at index ${i} is not a string`,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
    if (ev.length > MAX_EVENT_STRING_LENGTH) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Event at index ${i} exceeds maximum length limit of ${MAX_EVENT_STRING_LENGTH}`,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Check 1: rulesVersion equals expected SHA256
  if (expectedRulesVersion !== null && expectedRulesVersion !== undefined) {
    if (runLog.rulesVersion !== expectedRulesVersion) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Rules version mismatch: claimed "${runLog.rulesVersion}", expected "${expectedRulesVersion}"`,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Check 2: Seed and config deserialized exactly as UI did
  if (runLog.seed === null || runLog.seed === undefined || typeof runLog.seed !== 'number' || !isFinite(runLog.seed)) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Invalid or missing seed: ${runLog.seed}`,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  const config = deserializeConfig(runLog.config);
  let ctrl;
  try {
    ctrl = new GameController(runLog.seed, config);
  } catch (err) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Engine error during game initialization: ${err.message}`,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  // Check 3 & 4: Replay all events in array order
  let gameOverEncountered = false;
  let gameOverIndex = -1;

  for (let i = 0; i < runLog.events.length; i++) {
    const ev = runLog.events[i];

    // Check 4: No events may follow gameOver (REJECT)
    if (gameOverEncountered) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Event at index ${i} ('${ev}') occurred after gameOver was reached at event index ${gameOverIndex}`,
        replay: extractReplay(ctrl),
        claimed,
        ms: getElapsed(),
      };
    }

    if (ev.startsWith('s:')) {
      const dir = ev.slice(2);
      if (!['L', 'R', 'U', 'D'].includes(dir)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Illegal swipe direction '${dir}' at event index ${i}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      if (ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Swipe event at index ${i} submitted while decision '${ctrl.getPendingDecision().type}' is pending`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      let res;
      try {
        res = ctrl.submitMove(dir);
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw on swipe '${dir}' at event index ${i}: ${err.message}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      // Blocked swipe (no-op) is legal per Y1 and leaves state unchanged
      if (!res.success && res.reason !== 'invalid_move') {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Swipe rejected by controller (${res.reason}) at event index ${i}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else if (ev.startsWith('a:')) {
      // a:<relicId>:<target>
      const parts = ev.split(':');
      if (parts.length < 3) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Malformed ability event '${ev}' at index ${i}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      let relicId = parts[1];
      const targetPayload = parts.slice(2).join(':');

      if (relicId === 'diagonal') relicId = 'diagonal_charge';

      if (!['diagonal_charge', 'eraser', 'rewind'].includes(relicId)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Unknown ability relic '${relicId}' at event index ${i}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Ability event at index ${i} used while decision '${ctrl.getPendingDecision().type}' is pending`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      let target = null;
      if (relicId === 'rewind') {
        target = null;
      } else {
        try {
          const parsed = JSON.parse(targetPayload);
          if (relicId === 'eraser') {
            target = typeof parsed === 'number' ? { cell: parsed } : (parsed.cell !== undefined ? parsed : { cell: parsed });
          } else if (relicId === 'diagonal_charge') {
            if (Array.isArray(parsed) && parsed.length === 2) {
              target = { from: parsed[0], to: parsed[1] };
            } else {
              target = parsed;
            }
          }
        } catch {
          if (relicId === 'eraser' && !isNaN(Number(targetPayload))) {
            target = { cell: Number(targetPayload) };
          } else {
            return {
              ok: false,
              status: 'REJECT',
              reason: `Failed to parse target payload '${targetPayload}' for ability '${relicId}' at event index ${i}`,
              replay: extractReplay(ctrl),
              claimed,
              ms: getElapsed(),
            };
          }
        }
      }

      let res;
      try {
        res = ctrl.useAbility(relicId, target);
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw on ability '${relicId}' at event index ${i}: ${err.message}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (!res.success) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Illegal ability activation '${relicId}' (${res.error || res.reason}) at event index ${i}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else if (ev.startsWith('d:')) {
      const pick = ev.slice(2);
      if (!ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft decision event '${ev}' at index ${i} with no pending decision`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      const dec = ctrl.getPendingDecision();
      if (dec.type !== 'draft') {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft event at index ${i} when pending decision is of type '${dec.type}'`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      if (!dec.offers || !dec.offers.includes(pick)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft pick '${pick}' at event index ${i} not among offered relics [${(dec.offers || []).join(', ')}]`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      let res;
      try {
        res = ctrl.resolveDecision(pick);
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw resolving draft decision at event index ${i}: ${err.message}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (!res.success) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Failed to resolve draft decision at event index ${i}: ${res.reason}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else if (ev.startsWith('m:')) {
      const cell = parseInt(ev.slice(2), 10);
      if (!ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Mason decision event '${ev}' at index ${i} with no pending decision`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      const dec = ctrl.getPendingDecision();
      if (dec.type !== 'mason') {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Mason event at index ${i} when pending decision is of type '${dec.type}'`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      if (!dec.candidates || !dec.candidates.includes(cell)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Mason choice cell ${cell} at event index ${i} not among candidate cells [${(dec.candidates || []).join(', ')}]`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      let res;
      try {
        res = ctrl.resolveDecision(cell);
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw resolving Mason decision at event index ${i}: ${err.message}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (!res.success) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Failed to resolve Mason decision at event index ${i}: ${res.reason}`,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Unrecognized event prefix '${ev}' at event index ${i}`,
        replay: extractReplay(ctrl),
        claimed,
        ms: getElapsed(),
      };
    }
  }

  const replay = extractReplay(ctrl);

  // Check 4: The run must END in gameOver (status INCOMPLETE otherwise)
  if (!replay.gameOver) {
    return {
      ok: false,
      status: 'INCOMPLETE',
      reason: 'Run did not reach game over state',
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  if (ctrl.hasPendingDecision()) {
    return {
      ok: false,
      status: 'INCOMPLETE',
      reason: `Run finished with unresolved pending decision '${ctrl.getPendingDecision().type}'`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Check 5: Replayed final board, points, moveNumberAtDeath, maxTile,
  // relicsOwned (as a set), drafts picks, lastStandFired must equal claimed values.
  const claimedPoints = runLog.points ?? runLog.score ?? 0;
  if (replay.points !== claimedPoints) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Points mismatch: replayed ${replay.points}, claimed ${claimedPoints}`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  const claimedMoves = runLog.moveNumberAtDeath ?? runLog.totalMoves ?? 0;
  if (replay.moves !== claimedMoves) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Moves mismatch: replayed ${replay.moves}, claimed ${claimedMoves}`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  const claimedMaxTile = runLog.maxTile ?? 0;
  if (replay.maxTile !== claimedMaxTile) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Max tile mismatch: replayed ${replay.maxTile}, claimed ${claimedMaxTile}`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Board check
  if (Array.isArray(runLog.finalBoard)) {
    const replayedBoard = ctrl.getBoard();
    if (replayedBoard.length !== runLog.finalBoard.length) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Final board length mismatch: replayed ${replayedBoard.length}, claimed ${runLog.finalBoard.length}`,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
    for (let c = 0; c < replayedBoard.length; c++) {
      if (replayedBoard[c] !== runLog.finalBoard[c]) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Final board mismatch at cell ${c}: replayed ${replayedBoard[c]}, claimed ${runLog.finalBoard[c]}`,
          replay,
          claimed,
          ms: getElapsed(),
        };
      }
    }
  }

  // Relics owned check (as a set)
  const replayedRelicsSet = new Set(replay.relicsOwned);
  const claimedRelicsSet = new Set(runLog.relicsOwned || []);
  if (replayedRelicsSet.size !== claimedRelicsSet.size) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Relics owned count mismatch: replayed [${Array.from(replayedRelicsSet).join(', ')}], claimed [${Array.from(claimedRelicsSet).join(', ')}]`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }
  for (const r of claimedRelicsSet) {
    if (!replayedRelicsSet.has(r)) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Relics owned mismatch: claimed relic '${r}' missing from replayed set`,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Drafts picks check
  if (Array.isArray(runLog.drafts)) {
    const claimedPicks = runLog.drafts.map(d => d.pick);
    const replayedPicks = ctrl.draftRecords.map(d => d.pick);
    if (replayedPicks.length !== claimedPicks.length) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Drafts count mismatch: replayed ${replayedPicks.length}, claimed ${claimedPicks.length}`,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
    for (let d = 0; d < replayedPicks.length; d++) {
      if (replayedPicks[d] !== claimedPicks[d]) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft pick mismatch at draft #${d + 1}: replayed '${replayedPicks[d]}', claimed '${claimedPicks[d]}'`,
          replay,
          claimed,
          ms: getElapsed(),
        };
      }
    }
  }

  // Ability uses check
  if (Array.isArray(runLog.abilityUses)) {
    if (ctrl.abilityUses.length !== runLog.abilityUses.length) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Ability uses count mismatch: replayed ${ctrl.abilityUses.length}, claimed ${runLog.abilityUses.length}`,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Last stand fired check
  const replayedLastStand = Boolean(ctrl.lastStandFired || ctrl.state.lastStandUsed);
  const claimedLastStand = Boolean(runLog.lastStandFired);
  if (replayedLastStand !== claimedLastStand) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Last stand fired mismatch: replayed ${replayedLastStand}, claimed ${claimedLastStand}`,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  return {
    ok: true,
    status: 'OK',
    reason: null,
    replay,
    claimed,
    ms: getElapsed(),
  };
}
