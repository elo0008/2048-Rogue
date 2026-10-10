/**
 * GameController: pure logic wrapping the 2048-Rogue engine for a human player (or test bot).
 * Zero DOM dependencies.
 */

import {
  createGame,
  step,
  getValidMoves,
  getNextStoneInfo,
  getRelicsInfo,
  getForesightPreview,
  buildHazardSchedule,
  STONE,
  DIRECTIONS,
  useAbility,
  getAbilityState,
  hasLegalAbility,
  getLegalTargets,
  ABILITY_RELIC_IDS,
} from '../sim/engine.js';
import { RELIC_IDS, RELICS } from '../sim/relics.js';

export {
  buildHazardSchedule,
  STONE,
  DIRECTIONS,
  RELIC_IDS,
  RELICS,
  useAbility,
  getAbilityState,
  hasLegalAbility,
  getLegalTargets,
  ABILITY_RELIC_IDS,
};

export class GameController {
  constructor(seed = null, configOverrides = {}, playerId = null) {
    this.playerId = playerId || this._generatePlayerId();
    this.newRun(seed, configOverrides);
  }

  _generatePlayerId() {
    return 'anon_' + Math.random().toString(36).slice(2, 10);
  }

  _generateRunId() {
    return 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Starts a new run.
   */
  newRun(seed = null, configOverrides = {}, bestScoreAtRunStart = 0) {
    if (seed === null || seed === undefined) {
      seed = Math.floor(Math.random() * 2147483647) + 1;
    }
    this.seed = Number(seed);
    this.config = { ...configOverrides };
    this.state = createGame(this.seed, this.config);

    this.runId = this._generateRunId();
    this.startTimestamp = Date.now();
    this.endTimestamp = null;
    this.bestScoreAtRunStart = Number(bestScoreAtRunStart) || 0;
    this.pendingDecision = null;
    this.decisionStartTime = 0;
    this.lastStandFired = false;
    this.draftsSeen = 0;
    this.draftRecords = [];
    this.moveHistory = [];
    this.lastStepResult = null;
    this.lastValidSwipeDir = null;
    this.abilityUses = [];
    this._pendingRewindEntries = [];
    this.inputCounts = { swipe: 0, key: 0, tap: 0 };

    return this;
  }

  recordInput(type) {
    if (this.inputCounts && type in this.inputCounts) {
      this.inputCounts[type] += 1;
    }
  }

  /**
   * Submits a move direction ('L', 'R', 'U', 'D').
   */
  submitMove(direction) {
    if (this.isGameOver()) {
      return { success: false, reason: 'game_over', state: this.state };
    }
    if (this.hasPendingDecision()) {
      return {
        success: false,
        reason: 'pending_decision',
        decision: this.getPendingDecision(),
        state: this.state,
      };
    }

    const res = step(this.state, direction, null, { interactive: true });
    this.lastStepResult = res;

    if (!res.valid) {
      return {
        success: false,
        reason: 'invalid_move',
        stepResult: res,
        state: this.state,
      };
    }

    if (this._pendingRewindEntries && this._pendingRewindEntries.length > 0) {
      for (const e of this._pendingRewindEntries) {
        if (e.nextDirAfterUndo === null) {
          e.nextDirAfterUndo = direction;
        }
      }
      this._pendingRewindEntries = [];
    }

    this.moveHistory.push(direction);
    this.lastValidSwipeDir = direction;
    if (res.lastStandFired) {
      this.lastStandFired = true;
    }

    if (res.pendingDecision) {
      this.pendingDecision = res.pendingDecision;
      this.decisionStartTime = Date.now();
      if (this.pendingDecision.type === 'draft') {
        this.draftsSeen += 1;
      }
      return {
        success: true,
        pendingDecision: this.getPendingDecision(),
        stepResult: res,
        state: this.state,
      };
    }

    this.pendingDecision = null;
    if (this.isGameOver()) {
      this._finalizeRun();
    }

    return {
      success: true,
      pendingDecision: null,
      stepResult: res,
      state: this.state,
    };
  }

  useAbility(relicId, target) {
    if (this.isGameOver()) {
      return { success: false, reason: 'game_over', state: this.state };
    }
    if (this.hasPendingDecision()) {
      return {
        success: false,
        reason: 'pending_decision',
        decision: this.getPendingDecision(),
        state: this.state,
      };
    }

    try {
      const stuck = Boolean(this.state.stuckNeedsAbility || getValidMoves(this.state).length === 0);
      const emptyCellsBefore = this.state.board.filter(c => c === 0).length;
      const chargesBefore = this.state.abilities?.[relicId]?.charges ?? 0;
      const undoneDir = relicId === 'rewind'
        ? (this.lastValidSwipeDir || (this.moveHistory.length > 0 ? this.moveHistory[this.moveHistory.length - 1] : null))
        : undefined;

      const moveBeforeUndo = this.state.moveCount;
      const res = useAbility(this.state, relicId, target);
      const chargesAfter = this.state.abilities?.[relicId]?.charges ?? 0;

      // moveNumber semantics: state.moveCount when the record is generated.
      // For standard abilities, moveCount is unchanged. For rewind, the engine restores moveCount
      // to the snapshot value, so moveNumber equals moveAfterUndo.
      // moveBeforeUndo and moveAfterUndo provide explicit pre- and post-undo move counts.
      const entry = {
        relic: relicId,
        moveNumber: this.state.moveCount,
        target: relicId === 'rewind' ? null : target,
        chargesBefore,
        chargesAfter,
        stuck,
        emptyCellsBefore,
      };

      if (relicId === 'rewind') {
        entry.moveBeforeUndo = moveBeforeUndo;
        entry.moveAfterUndo = this.state.moveCount;
        entry.undoneDir = undoneDir;
        entry.nextDirAfterUndo = null;
        if (!this._pendingRewindEntries) this._pendingRewindEntries = [];
        this._pendingRewindEntries.push(entry);
        this.lastValidSwipeDir = null;
        if (this.moveHistory.length > 0) {
          this.moveHistory.pop();
        }
      }

      this.abilityUses.push(entry);

      if (this.state.lastStandUsed) {
        this.lastStandFired = true;
      }
      if (this.isGameOver()) {
        this._finalizeRun();
      }

      return { success: true, res, state: this.state };
    } catch (err) {
      return { success: false, error: err.message, state: this.state };
    }
  }

  getAbilityState() {
    return getAbilityState(this.state);
  }

  hasLegalAbility() {
    return hasLegalAbility(this.state);
  }

  getLegalTargets(relicId) {
    return getLegalTargets(this.state, relicId);
  }

  hasPendingDecision() {
    return Boolean(this.pendingDecision);
  }

  getPendingDecision() {
    if (!this.pendingDecision) return null;
    return {
      type: this.pendingDecision.type,
      offers: this.pendingDecision.offers ? [...this.pendingDecision.offers] : undefined,
      candidates: this.pendingDecision.candidates ? [...this.pendingDecision.candidates] : undefined,
      info: this.pendingDecision.info ? { ...this.pendingDecision.info } : undefined,
    };
  }

  resolveDecision(choice) {
    if (!this.pendingDecision) {
      return { success: false, reason: 'no_pending_decision', state: this.state };
    }

    const type = this.pendingDecision.type;
    const durationMs = Date.now() - this.decisionStartTime;

    if (type === 'draft') {
      this.draftRecords.push({
        offers: [...this.pendingDecision.offers],
        pick: choice,
        move: this.state.moveCount,
        durationMs,
      });
    }

    const res = this.pendingDecision.resolve(choice);
    this.lastStepResult = res;

    if (res.lastStandFired) {
      this.lastStandFired = true;
    }

    if (res.pendingDecision) {
      this.pendingDecision = res.pendingDecision;
      this.decisionStartTime = Date.now();
      if (this.pendingDecision.type === 'draft') {
        this.draftsSeen += 1;
      }
      return {
        success: true,
        pendingDecision: this.getPendingDecision(),
        stepResult: res,
        state: this.state,
      };
    }

    this.pendingDecision = null;
    if (this.isGameOver()) {
      this._finalizeRun();
    }

    return {
      success: true,
      pendingDecision: null,
      stepResult: res,
      state: this.state,
    };
  }

  isGameOver() {
    return Boolean(this.state.gameOver || this.state.capped);
  }

  getState() {
    return this.state;
  }

  getBoard() {
    return [...this.state.board];
  }

  getValidMoves() {
    return getValidMoves(this.state);
  }

  getNextStoneInfo() {
    return getNextStoneInfo(this.state);
  }

  getRelicsInfo() {
    return getRelicsInfo(this.state);
  }

  getForesightPreview() {
    return getForesightPreview(this.state);
  }

  _finalizeRun() {
    if (!this.endTimestamp) {
      this.endTimestamp = Date.now();
    }
  }

  /**
   * Generates the structured run log JSON record according to specifications.
   */
  getRunLog(metadata = {}) {
    let finalStones = 0;
    let finalNumberTiles = 0;
    for (const cell of this.state.board) {
      if (cell === STONE) {
        finalStones += 1;
      } else if (typeof cell === 'number' && cell > 0) {
        finalNumberTiles += 1;
      }
    }

    const swipesAtMax = {};
    const chargesAtDeath = {};
    for (const rid of ABILITY_RELIC_IDS) {
      if (this.state.relics.has(rid)) {
        swipesAtMax[rid] = this.state.abilities?.[rid]?.swipesAtMax || 0;
        chargesAtDeath[rid] = this.state.abilities?.[rid]?.charges || 0;
      }
    }

    const serializeSafe = (obj) => {
      return JSON.parse(JSON.stringify(obj, (key, value) => {
        if (value === Infinity) return 'Infinity';
        if (value === -Infinity) return '-Infinity';
        return value;
      }));
    };

    const resolvedConfig = { ...(this.state?.config || {}), ...(this.config || {}) };

    return {
      playerId: this.playerId,
      runId: this.runId,
      seed: this.seed,
      config: serializeSafe(resolvedConfig),
      startTimestamp: this.startTimestamp,
      endTimestamp: this.endTimestamp || Date.now(),
      totalMoves: this.state.moveCount,
      moveNumberAtDeath: this.state.moveCount,
      maxTile: this.state.highestTile,
      score: this.state.score,
      points: this.state.points || 0,
      bestScoreAtRunStart: metadata.bestScoreAtRunStart ?? this.bestScoreAtRunStart ?? 0,
      finalStones,
      finalNumberTiles,
      finalBoard: [...this.state.board],
      relicsOwned: Array.from(this.state.relics),
      draftsSeen: this.draftsSeen,
      drafts: [...this.draftRecords],
      relicActivations: { ...(this.state.relicActivations || {}) },
      lastStandFired: Boolean(this.lastStandFired || this.state.lastStandUsed),
      capped: Boolean(this.state.capped),
      stuckNeedsAbility: Boolean(this.state.stuckNeedsAbility),
      abilityUses: [...(this.abilityUses || [])],
      swipesAtMax,
      chargesAtDeath,
      inputMethodCounts: { ...(this.inputCounts || { swipe: 0, key: 0, tap: 0 }) },
      viewport: metadata.viewport || null,
      queryString: metadata.queryString || '',
      userAgent: metadata.userAgent || '',
      buildId: metadata.buildId || '__BUILD_ID__',
    };
  }
}
