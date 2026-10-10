import test from 'node:test';
import assert from 'node:assert';
import {
  createGame,
  step,
  stepInteractive,
  getValidMoves,
  buildHazardSchedule,
  mulberry32,
  getLegalTargets,
  hasLegalAbility,
  useAbility,
  getAbilityState,
  ABILITY_RELIC_IDS,
} from '../engine.js';

const DEFAULT_6_RELICS = [
  'diagonal_merge',
  'fault_line',
  'mason',
  'siphon',
  'shatter',
  'last_stand',
];

const RELIC_PAIRS = [
  ['diagonal_merge', 'fault_line'],
  ['diagonal_merge', 'mason'],
  ['diagonal_merge', 'siphon'],
  ['diagonal_merge', 'shatter'],
  ['diagonal_merge', 'last_stand'],
  ['fault_line', 'mason'],
  ['fault_line', 'siphon'],
  ['mason', 'shatter'],
  ['siphon', 'last_stand'],
  ['shatter', 'last_stand'],
];

const TEST_CONFIGS = [
  // 1. no relics
  {
    name: 'no_relics',
    config: {
      hazardSchedule: buildHazardSchedule(3),
      enableDraft: false,
      forcedRelics: [],
      forceAtMove: 0,
      moveCap: 500,
    },
  },
  // 2-7. each of the 6 default-pool relics forced at move 30
  ...DEFAULT_6_RELICS.map(r => ({
    name: `forced_${r}_at_30`,
    config: {
      hazardSchedule: buildHazardSchedule(3),
      enableDraft: false,
      forcedRelics: [r],
      forceAtMove: 30,
      moveCap: 500,
    },
  })),
  // 8. all 6 at once
  {
    name: 'all_6_at_once',
    config: {
      hazardSchedule: buildHazardSchedule(3),
      enableDraft: false,
      forcedRelics: [...DEFAULT_6_RELICS],
      forceAtMove: 0,
      moveCap: 500,
    },
  },
  // 9. draftEveryMoves=3 with stones multiplier 0.1 and mason owned (draft and mason on same move)
  {
    name: 'draft3_stones0.1_mason',
    config: {
      hazardSchedule: buildHazardSchedule(0.1),
      enableDraft: true,
      draftEveryMoves: 3,
      draftThresholds: [],
      draftPool: [...DEFAULT_6_RELICS],
      forcedRelics: ['mason'],
      forceAtMove: 0,
      moveCap: 200,
    },
  },
  // 10. draftFirstAt=30 with draftEveryMoves=60
  {
    name: 'draftFirst30_every60',
    config: {
      hazardSchedule: buildHazardSchedule(3),
      enableDraft: true,
      draftFirstAt: 30,
      draftEveryMoves: 60,
      draftThresholds: [],
      draftPool: [...DEFAULT_6_RELICS],
      forcedRelics: [],
      forceAtMove: 0,
      moveCap: 500,
    },
  },
  // 11-20. 10 random relic pairs
  ...RELIC_PAIRS.map((pair, idx) => ({
    name: `relic_pair_${idx + 1}_${pair.join('_')}`,
    config: {
      hazardSchedule: buildHazardSchedule(3),
      enableDraft: false,
      forcedRelics: [...pair],
      forceAtMove: 0,
      moveCap: 500,
    },
  })),
];

test('Decision-replay parity test: 100 seeds across 20 configurations', () => {
  assert.strictEqual(TEST_CONFIGS.length, 20, 'Must have exactly 20 configurations');

  for (const tc of TEST_CONFIGS) {
    for (let seed = 1; seed <= 100; seed++) {
      const choiceRng = mulberry32((seed * 1000003 + 7777) >>> 0);

      // 1. Run interactive path
      const stateInteractive = createGame(seed, tc.config);
      const recordedMoves = [];
      const recordedDraftPicks = [];
      const recordedMasonChoices = [];

      while (!stateInteractive.gameOver && !stateInteractive.capped) {
        const valid = getValidMoves(stateInteractive);
        if (valid.length === 0) break;
        const move = valid[Math.floor(choiceRng() * valid.length)];
        recordedMoves.push(move);

        let res = stepInteractive(stateInteractive, move);
        while (res.pendingDecision) {
          if (res.pendingDecision.type === 'draft') {
            const offers = res.pendingDecision.offers;
            const pick = offers[Math.floor(choiceRng() * offers.length)];
            recordedDraftPicks.push(pick);
            res = res.pendingDecision.resolve(pick);
          } else if (res.pendingDecision.type === 'mason') {
            const candidates = res.pendingDecision.candidates;
            const chosen = candidates[Math.floor(choiceRng() * candidates.length)];
            recordedMasonChoices.push(chosen);
            res = res.pendingDecision.resolve(chosen);
          } else {
            throw new Error(`Unknown pendingDecision type: ${res.pendingDecision.type}`);
          }
        }
      }

      // 2. Replay through bot path
      const stateBot = createGame(seed, tc.config);
      let mIdx = 0;
      let dIdx = 0;
      let sIdx = 0;

      const replayBot = {
        name: 'replay_bot',
        chooseMove() {
          return recordedMoves[mIdx++];
        },
        chooseDraftRelic(state, offers) {
          return recordedDraftPicks[dIdx++];
        },
        chooseStoneCell(state, candidates) {
          return recordedMasonChoices[sIdx++];
        },
      };

      while (!stateBot.gameOver && !stateBot.capped) {
        if (mIdx >= recordedMoves.length) break;
        const move = replayBot.chooseMove(stateBot);
        if (!move) break;
        step(stateBot, move, replayBot);
      }

      // 3. Compare final board, moveCount, relic set, and draftHistory
      try {
        assert.strictEqual(
          stateBot.moveCount,
          stateInteractive.moveCount,
          `moveCount mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.board,
          stateInteractive.board,
          `board mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          Array.from(stateBot.relics).sort(),
          Array.from(stateInteractive.relics).sort(),
          `relics mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.draftHistory,
          stateInteractive.draftHistory,
          `draftHistory mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.relicActivations,
          stateInteractive.relicActivations,
          `relicActivations mismatch in config ${tc.name} seed ${seed}`
        );
      } catch (err) {
        console.error(`Mismatch detected in config: ${tc.name}, seed: ${seed}`);
        console.error('Interactive moves played:', recordedMoves.length, 'Replayed:', mIdx);
        console.error('Drafts seen:', recordedDraftPicks.length, 'Replayed:', dIdx);
        console.error('Mason choices:', recordedMasonChoices.length, 'Replayed:', sIdx);
        throw err;
      }
    }
  }
});

test('Decision-replay parity test with ability actions: random-seeded swipe/ability choices replayed through bot path', () => {
  const ABILITY_CONFIGS = [
    // 1. diagonal_charge forced at 30
    {
      name: 'diagonal_charge_forced_30',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['diagonal_charge'],
        forceAtMove: 30,
        moveCap: 250,
      },
    },
    // 2. eraser forced at 30
    {
      name: 'eraser_forced_30',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['eraser'],
        forceAtMove: 30,
        moveCap: 250,
      },
    },
    // 3. both together
    {
      name: 'both_abilities_together',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['diagonal_charge', 'eraser'],
        forceAtMove: 0,
        moveCap: 250,
      },
    },
    // 4. diagonal_charge with shatter
    {
      name: 'diagonal_charge_with_shatter',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['diagonal_charge', 'shatter'],
        forceAtMove: 0,
        moveCap: 250,
      },
    },
    // 5. eraser with shatter
    {
      name: 'eraser_with_shatter',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['eraser', 'shatter'],
        forceAtMove: 0,
        moveCap: 250,
      },
    },
    // 6. with last_stand on a stones=0.1 config that reaches the stuck rule
    {
      name: 'abilities_last_stand_stones0.1',
      config: {
        hazardSchedule: buildHazardSchedule(0.1),
        enableDraft: false,
        forcedRelics: ['diagonal_charge', 'last_stand'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
    // 7. and the cap config
    {
      name: 'stone_group_cap_config',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: true,
        draftEveryMoves: 10,
        draftThresholds: [],
        draftPool: ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'shatter', 'siphon', 'last_stand'],
        stoneGroup: ['fault_line', 'mason', 'shatter'],
        stoneGroupCap: 2,
        forcedRelics: ['fault_line', 'mason'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
    // 8. rewind solo
    {
      name: 'rewind_solo',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['rewind'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
    // 9. rewind with eraser
    {
      name: 'rewind_with_eraser',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['rewind', 'eraser'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
    // 10. rewind with diagonal_charge
    {
      name: 'rewind_with_diagonal_charge',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: false,
        forcedRelics: ['rewind', 'diagonal_charge'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
    // 11. cap config with default draftThresholds
    {
      name: 'stone_group_cap_default_thresholds',
      config: {
        hazardSchedule: buildHazardSchedule(3),
        enableDraft: true,
        draftEveryMoves: 10,
        draftPool: ['diagonal_charge', 'eraser', 'rewind', 'fault_line', 'mason', 'shatter', 'siphon', 'last_stand'],
        stoneGroup: ['fault_line', 'mason', 'shatter'],
        stoneGroupCap: 2,
        forcedRelics: ['fault_line', 'mason'],
        forceAtMove: 0,
        moveCap: 150,
      },
    },
  ];

  for (const tc of ABILITY_CONFIGS) {
    for (let seed = 1; seed <= 20; seed++) {
      const choiceRng = mulberry32((seed * 1000003 + 8888) >>> 0);

      // 1. Run interactive path with random-seeded choice between swipes and abilities
      const stateInteractive = createGame(seed, tc.config);
      const recordedActions = [];
      const recordedDraftPicks = [];
      const recordedMasonChoices = [];

      while (!stateInteractive.gameOver && !stateInteractive.capped) {
        // Stuck rule check
        if (stateInteractive.stuckNeedsAbility) {
          const abCandidates = [];
          for (const rid of ABILITY_RELIC_IDS) {
            if (stateInteractive.relics.has(rid)) {
              const info = stateInteractive.abilities?.[rid];
              if (info && info.charges > 0) {
                const tgts = getLegalTargets(stateInteractive, rid);
                if (tgts.length > 0) {
                  abCandidates.push({ relic: rid, targets: tgts });
                }
              }
            }
          }
          if (abCandidates.length > 0) {
            const cand = abCandidates[Math.floor(choiceRng() * abCandidates.length)];
            const target = cand.targets[Math.floor(choiceRng() * cand.targets.length)];
            recordedActions.push({ type: 'ability', relic: cand.relic, target });
            useAbility(stateInteractive, cand.relic, target);
            continue;
          } else {
            // Cannot use ability, game stuck
            break;
          }
        }

        const validMoves = getValidMoves(stateInteractive);
        if (validMoves.length === 0) {
          break;
        }

        // Check if an ability could be used
        let usedAbility = false;
        if (hasLegalAbility(stateInteractive) && choiceRng() < 0.4) {
          const abCandidates = [];
          for (const rid of ABILITY_RELIC_IDS) {
            if (stateInteractive.relics.has(rid)) {
              const info = stateInteractive.abilities?.[rid];
              if (info && info.charges > 0) {
                const tgts = getLegalTargets(stateInteractive, rid);
                if (tgts.length > 0) {
                  abCandidates.push({ relic: rid, targets: tgts });
                }
              }
            }
          }
          if (abCandidates.length > 0) {
            const cand = abCandidates[Math.floor(choiceRng() * abCandidates.length)];
            const target = cand.targets[Math.floor(choiceRng() * cand.targets.length)];
            recordedActions.push({ type: 'ability', relic: cand.relic, target });
            useAbility(stateInteractive, cand.relic, target);
            usedAbility = true;
          }
        }

        if (usedAbility) continue;

        // Perform valid swipe
        const move = validMoves[Math.floor(choiceRng() * validMoves.length)];
        recordedActions.push({ type: 'swipe', dir: move });

        let res = stepInteractive(stateInteractive, move);
        while (res.pendingDecision) {
          if (res.pendingDecision.type === 'draft') {
            const offers = res.pendingDecision.offers;
            const pick = offers[Math.floor(choiceRng() * offers.length)];
            recordedDraftPicks.push(pick);
            res = res.pendingDecision.resolve(pick);
          } else if (res.pendingDecision.type === 'mason') {
            const candidates = res.pendingDecision.candidates;
            const chosen = candidates[Math.floor(choiceRng() * candidates.length)];
            recordedMasonChoices.push(chosen);
            res = res.pendingDecision.resolve(chosen);
          } else {
            throw new Error(`Unknown pendingDecision type: ${res.pendingDecision.type}`);
          }
        }
      }

      // 2. Replay through bot/action path
      const stateBot = createGame(seed, tc.config);
      let dIdx = 0;
      let sIdx = 0;

      const replayBot = {
        name: 'replay_action_bot',
        chooseDraftRelic(state, offers) {
          return recordedDraftPicks[dIdx++];
        },
        chooseStoneCell(state, candidates) {
          return recordedMasonChoices[sIdx++];
        },
      };

      for (const action of recordedActions) {
        if (stateBot.gameOver || stateBot.capped) break;
        if (action.type === 'ability') {
          useAbility(stateBot, action.relic, action.target);
        } else if (action.type === 'swipe') {
          const res = step(stateBot, action.dir, replayBot);
          if (!res.valid) break;
        }
      }

      // 3. Compare final board, moveCount, relics, draftHistory, relicActivations, charges, counters
      try {
        assert.strictEqual(
          stateBot.moveCount,
          stateInteractive.moveCount,
          `moveCount mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.board,
          stateInteractive.board,
          `board mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          Array.from(stateBot.relics).sort(),
          Array.from(stateInteractive.relics).sort(),
          `relics mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.draftHistory,
          stateInteractive.draftHistory,
          `draftHistory mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.relicActivations,
          stateInteractive.relicActivations,
          `relicActivations mismatch in config ${tc.name} seed ${seed}`
        );
        assert.strictEqual(
          stateBot.points,
          stateInteractive.points,
          `points mismatch in config ${tc.name} seed ${seed}`
        );
        assert.deepStrictEqual(
          stateBot.abilities,
          stateInteractive.abilities,
          `abilities (charges, counters) mismatch in config ${tc.name} seed ${seed}`
        );
      } catch (err) {
        console.error(`Ability mismatch detected in config: ${tc.name}, seed: ${seed}`);
        console.error('Actions played:', recordedActions.length);
        throw err;
      }
    }
  }
});

