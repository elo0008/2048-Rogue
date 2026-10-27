/**
 * verify/verify_run.js
 *
 * Pure function verifyRun(runLog, options) that replays a run
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
import {
  CANONICAL_CONFIG,
  dailySeed,
  normalizeConfig,
  checkCanonicalConfig,
} from './profile.js';

export {
  CANONICAL_CONFIG,
  dailySeed,
  normalizeConfig,
  checkCanonicalConfig,
};

const MAX_EVENTS_LIMIT = 20000;
const MAX_EVENT_STRING_LENGTH = 128;

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
    capped: Boolean(runLog.capped),
    endedByPlayer: 'endedByPlayer' in runLog ? Boolean(runLog.endedByPlayer) : false,
    ascensions: Array.isArray(runLog.ascensions) ? runLog.ascensions.map(a => ({
      move: a.move,
      value: a.value,
      payout: a.payout,
    })) : [],
  };
}

/**
 * Extracts current replayed state from the controller.
 */
function extractReplay(ctrl) {
  if (!ctrl || !ctrl.state) {
    return {
      seed: 0,
      points: 0,
      moves: 0,
      maxTile: 0,
      relicsOwned: [],
      gameOver: false,
      capped: false,
      endedByPlayer: false,
      ascensions: [],
    };
  }
  return {
    seed: ctrl.seed,
    points: ctrl.state.points ?? ctrl.state.score ?? 0,
    moves: ctrl.state.moveCount ?? 0,
    maxTile: ctrl.state.highestTile ?? 0,
    relicsOwned: Array.from(ctrl.state.relics || []),
    gameOver: Boolean(ctrl.state.gameOver),
    capped: Boolean(ctrl.state.capped),
    endedByPlayer: Boolean(ctrl.state.endedByPlayer),
    ascensions: Array.isArray(ctrl.state.ascensions) ? ctrl.state.ascensions.map(a => ({
      move: a.move,
      value: a.value,
      payout: a.payout,
    })) : [],
  };
}

/**
 * Verifies a single run log by full re-simulation.
 *
 * @param {object} runLog - Deserialized JSON run log
 * @param {object|string|null} options - Verification options or expectedRulesVersion string:
 *   - expectedRulesVersion {string|null}
 *   - expectedReplayVersion {string|null}
 *   - mode {'daily'|'challenge'|'any'} Default: 'daily'
 *   - dayUTC {string|null} 'YYYY-MM-DD'
 * @returns {object} { ok, status, reason, flags, replay, claimed, ms }
 */
export function verifyRun(runLog, options = {}) {
  const startTime = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const getElapsed = () => {
    const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    return Math.round((end - startTime) * 100) / 100;
  };

  let expectedRulesVersion = null;
  let expectedReplayVersion = null;
  let mode = 'daily';
  let dayUTC = null;

  if (typeof options === 'string') {
    expectedRulesVersion = options;
    mode = 'any';
  } else if (options && typeof options === 'object') {
    expectedRulesVersion = options.expectedRulesVersion ?? null;
    expectedReplayVersion = options.expectedReplayVersion ?? null;
    mode = options.mode ?? 'daily';
    dayUTC = options.dayUTC ?? null;
  }

  const claimed = extractClaimed(runLog);

  // Z5: Plausibility flags (no rejection)
  const flags = [];
  if (runLog && typeof runLog === 'object') {
    if (runLog.activeMs === undefined || runLog.activeMs === null) {
      flags.push('ACTIVE_MS_MISSING');
    } else if (typeof runLog.activeMs === 'number' && Array.isArray(runLog.events)) {
      const swipeEvents = runLog.events.filter(e => typeof e === 'string' && e.startsWith('s:')).length;
      if (swipeEvents > 0) {
        const msPerSwipe = runLog.activeMs / swipeEvents;
        if (msPerSwipe < 150) {
          flags.push('FAST_INPUT');
        } else if (msPerSwipe > 30000) {
          flags.push('SLOW_RUN');
        }
      }
    }
  }

  // Check 6: Event count limit and per-event length limit, checked first.
  if (!runLog || typeof runLog !== 'object') {
    return {
      ok: false,
      status: 'REJECT',
      reason: 'Invalid runLog: expected a non-null object',
      flags,
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
      flags,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  // Z4: Legacy logs without replayVersion return status UNVERIFIABLE_LEGACY, never ok.
  if (!('replayVersion' in runLog) || !runLog.replayVersion) {
    return {
      ok: false,
      status: 'UNVERIFIABLE_LEGACY',
      reason: 'Legacy log missing replayVersion',
      flags,
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
      flags,
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
        flags,
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
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Check 1: rulesVersion equals expected SHA256
  if (expectedRulesVersion !== null && expectedRulesVersion !== undefined) {
    if (String(runLog.rulesVersion).toUpperCase() !== String(expectedRulesVersion).toUpperCase()) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Rules version mismatch: claimed "${runLog.rulesVersion}", expected "${expectedRulesVersion}"`,
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Z4: replayVersion check
  if (expectedReplayVersion !== null && expectedReplayVersion !== undefined) {
    if (String(runLog.replayVersion).toUpperCase() !== String(expectedReplayVersion).toUpperCase()) {
      return {
        ok: false,
        status: 'REJECT',
        reason: 'REPLAY_VERSION_MISMATCH',
        flags,
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
      flags,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  const normalizedLogConfig = normalizeConfig(runLog.config);

  // Z1: Modes 'daily', 'challenge', 'any'
  if (mode === 'daily') {
    let resolvedDayUTC = dayUTC;
    if (!resolvedDayUTC) {
      if (typeof runLog.startTimestamp === 'number') {
        resolvedDayUTC = new Date(runLog.startTimestamp).toISOString().slice(0, 10);
      }
    }
    if (!resolvedDayUTC) {
      return {
        ok: false,
        status: 'REJECT',
        reason: 'DAY_UTC_MISSING: daily mode requires dayUTC option or runLog.startTimestamp',
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }

    const expectedDailySeed = dailySeed(resolvedDayUTC);
    if (runLog.seed !== expectedDailySeed) {
      return {
        ok: false,
        status: 'REJECT',
        reason: 'SEED_NOT_DAILY',
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }

    const configVerdict = checkCanonicalConfig(normalizedLogConfig);
    if (!configVerdict.ok) {
      return {
        ok: false,
        status: 'REJECT',
        reason: configVerdict.reason,
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  } else if (mode === 'challenge') {
    const configVerdict = checkCanonicalConfig(normalizedLogConfig);
    if (!configVerdict.ok) {
      return {
        ok: false,
        status: 'REJECT',
        reason: configVerdict.reason,
        flags,
        replay: null,
        claimed,
        ms: getElapsed(),
      };
    }
  } else if (mode === 'any') {
    // Arbitrary config and seed accepted
  } else {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Unknown verification mode: "${mode}"`,
      flags,
      replay: null,
      claimed,
      ms: getElapsed(),
    };
  }

  let ctrl;
  try {
    ctrl = new GameController(runLog.seed, normalizedLogConfig);
  } catch (err) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Engine error during game initialization: ${err.message}`,
      flags,
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
        flags,
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
          flags,
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
          flags,
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
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      // Check if gameOver reached
      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else if (ev.startsWith('a:')) {
      const parts = ev.split(':');
      if (parts.length < 3) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Malformed ability event '${ev}' at index ${i}`,
          flags,
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
          flags,
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
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      let target = null;
      if (relicId === 'rewind') {
        if (targetPayload !== '-') {
          return {
            ok: false,
            status: 'REJECT',
            reason: `Rewind ability event at index ${i} target must be '-' but got '${targetPayload}'`,
            flags,
            replay: extractReplay(ctrl),
            claimed,
            ms: getElapsed(),
          };
        }
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
              flags,
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
          flags,
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
          flags,
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
      const pickRelicId = ev.slice(2);
      if (!ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft pick event 'd:${pickRelicId}' at index ${i} with no pending decision`,
          flags,
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
          reason: `Draft pick event at index ${i} but pending decision is of type '${dec.type}'`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      if (!Array.isArray(dec.offers) || !dec.offers.includes(pickRelicId)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Draft pick '${pickRelicId}' at index ${i} is not among offered relics: [${(dec.offers || []).join(', ')}]`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      try {
        const res = ctrl.resolveDecision(pickRelicId);
        if (!res.success) {
          return {
            ok: false,
            status: 'REJECT',
            reason: `Failed resolving draft decision with '${pickRelicId}' at index ${i}`,
            flags,
            replay: extractReplay(ctrl),
            claimed,
            ms: getElapsed(),
          };
        }
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw resolving draft with '${pickRelicId}' at event index ${i}: ${err.message}`,
          flags,
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
      const cell = Number(ev.slice(2));
      if (!ctrl.hasPendingDecision()) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Mason pick event 'm:${cell}' at index ${i} with no pending decision`,
          flags,
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
          reason: `Mason pick event at index ${i} but pending decision is of type '${dec.type}'`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      if (!Array.isArray(dec.candidates) || !dec.candidates.includes(cell)) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Mason pick cell ${cell} at index ${i} is not among candidates: [${(dec.candidates || []).join(', ')}]`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      try {
        const res = ctrl.resolveDecision(cell);
        if (!res.success) {
          return {
            ok: false,
            status: 'REJECT',
            reason: `Failed resolving Mason decision with cell ${cell} at index ${i}`,
            flags,
            replay: extractReplay(ctrl),
            claimed,
            ms: getElapsed(),
          };
        }
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw resolving Mason with cell ${cell} at index ${i}: ${err.message}`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }

      if (ctrl.isGameOver()) {
        gameOverEncountered = true;
        gameOverIndex = i;
      }
    } else if (ev === 'x:end') {
      try {
        ctrl.endRun();
      } catch (err) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Engine throw resolving endRun ('x:end') at index ${i}: ${err.message}`,
          flags,
          replay: extractReplay(ctrl),
          claimed,
          ms: getElapsed(),
        };
      }
      gameOverEncountered = true;
      gameOverIndex = i;
    } else {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Unknown event prefix in '${ev}' at event index ${i}`,
        flags,
        replay: extractReplay(ctrl),
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // Check 4: The run must END in gameOver (status INCOMPLETE otherwise)
  const replay = extractReplay(ctrl);
  if (!replay.gameOver) {
    return {
      ok: false,
      status: 'INCOMPLETE',
      reason: `Run did not end in gameOver (moves replayed: ${replay.moves}, gameOver: false)`,
      flags,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Check 5: Replayed final board, points, moveNumberAtDeath, maxTile, relicsOwned, drafts, lastStandFired
  if (Array.isArray(runLog.finalBoard)) {
    if (runLog.finalBoard.length !== 16) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Claimed finalBoard length is ${runLog.finalBoard.length}, expected 16`,
        flags,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
    for (let c = 0; c < 16; c++) {
      if (ctrl.state.board[c] !== runLog.finalBoard[c]) {
        return {
          ok: false,
          status: 'REJECT',
          reason: `Final board mismatch at cell ${c}: replayed ${ctrl.state.board[c]}, claimed ${runLog.finalBoard[c]}`,
          flags,
          replay,
          claimed,
          ms: getElapsed(),
        };
      }
    }
  }

  const claimedPoints = runLog.points ?? runLog.score ?? 0;
  if (replay.points !== claimedPoints) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Points mismatch: replayed ${replay.points}, claimed ${claimedPoints}`,
      flags,
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
      reason: `Move count at death mismatch: replayed ${replay.moves}, claimed ${claimedMoves}`,
      flags,
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
      flags,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Relics owned set equality check
  const replayedRelicsSet = new Set(replay.relicsOwned);
  const claimedRelicsSet = new Set(claimed.relicsOwned || []);
  if (replayedRelicsSet.size !== claimedRelicsSet.size) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Relics owned count mismatch: replayed [${Array.from(replayedRelicsSet).join(', ')}], claimed [${Array.from(claimedRelicsSet).join(', ')}]`,
      flags,
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
        flags,
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
        flags,
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
          flags,
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
        flags,
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
      flags,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Capped status check
  if ('capped' in runLog) {
    const replayedCapped = Boolean(ctrl.state.capped);
    const claimedCapped = Boolean(runLog.capped);
    if (replayedCapped !== claimedCapped) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Capped status mismatch: replayed ${replayedCapped}, claimed ${claimedCapped}`,
        flags,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  // endedByPlayer check
  const replayedEndedByPlayer = Boolean(replay.endedByPlayer);
  const claimedEndedByPlayer = 'endedByPlayer' in runLog ? Boolean(runLog.endedByPlayer) : false;
  if (replayedEndedByPlayer !== claimedEndedByPlayer) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `endedByPlayer mismatch: replayed ${replayedEndedByPlayer}, claimed ${claimedEndedByPlayer}`,
      flags,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }

  // Ascensions check (count and each entry's move/value/payout)
  const replayedAscensions = replay.ascensions || [];
  const claimedAscensions = Array.isArray(runLog.ascensions) ? runLog.ascensions : [];
  if (replayedAscensions.length !== claimedAscensions.length) {
    return {
      ok: false,
      status: 'REJECT',
      reason: `Ascensions count mismatch: replayed ${replayedAscensions.length}, claimed ${claimedAscensions.length}`,
      flags,
      replay,
      claimed,
      ms: getElapsed(),
    };
  }
  for (let a = 0; a < replayedAscensions.length; a++) {
    const rA = replayedAscensions[a];
    const cA = claimedAscensions[a];
    if (!cA || rA.move !== cA.move || rA.value !== cA.value || rA.payout !== cA.payout) {
      return {
        ok: false,
        status: 'REJECT',
        reason: `Ascension entry ${a} mismatch: replayed {move:${rA.move}, value:${rA.value}, payout:${rA.payout}}, claimed ${cA ? `{move:${cA.move}, value:${cA.value}, payout:${cA.payout}}` : 'undefined'}`,
        flags,
        replay,
        claimed,
        ms: getElapsed(),
      };
    }
  }

  return {
    ok: true,
    status: 'OK',
    reason: null,
    flags,
    replay,
    claimed,
    ms: getElapsed(),
  };
}

/**
 * Server-trust contract (Z3):
 * Returns { seed, points, moves, maxTile, relicsOwned, replayVersion, eventsHash }
 * computed ONLY from the replay (never from claimed fields), or null if verdict.ok is false.
 *
 * @param {object} runLog - Raw deserialized run log
 * @param {object} verdict - Output of verifyRun
 * @returns {Promise<object|null>}
 */
export async function extractSubmission(runLog, verdict) {
  if (!verdict || !verdict.ok || !verdict.replay || !runLog || !Array.isArray(runLog.events)) {
    return null;
  }

  const enc = new TextEncoder();
  const data = enc.encode(runLog.events.join('\n'));
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(digestBuffer));
  const eventsHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    seed: verdict.replay.seed ?? runLog.seed,
    points: verdict.replay.points,
    moves: verdict.replay.moves,
    maxTile: verdict.replay.maxTile,
    relicsOwned: Array.isArray(verdict.replay.relicsOwned) ? [...verdict.replay.relicsOwned] : [],
    replayVersion: runLog.replayVersion,
    eventsHash,
  };
}
