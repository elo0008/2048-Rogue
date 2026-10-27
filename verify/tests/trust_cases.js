/**
 * verify/tests/trust_cases.js
 *
 * Shared generator for trust tamper cases (Z2).
 * Each case is a run that replays legally if its config/seed were trusted,
 * but is rejected in daily mode (except the untouched default run which passes).
 */

import { GameController } from '../../game/controller.js';
import { createBot, chooseStoneCell } from '../../sim/bots.js';
import { RELIC_IDS } from '../../sim/relics.js';
import { dailySeed, DEFAULT_UI_CONFIG_OVERRIDES } from '../profile.js';
import { computeReplayVersion } from '../version.js';

export const TRUST_DAY_UTC = '2026-10-19';
export const YESTERDAY_DAY_UTC = '2026-10-18';
export const TRUST_DAILY_SEED = dailySeed(TRUST_DAY_UTC);
export const YESTERDAY_DAILY_SEED = dailySeed(YESTERDAY_DAY_UTC);

function playRunToOver(seed, configOverrides, replayVersion) {
  const ctrl = new GameController(seed, configOverrides);
  const bot = createBot('corner');
  let loop = 0;
  while (!ctrl.isGameOver() && loop < 3000) {
    loop++;
    if (ctrl.hasPendingDecision()) {
      const dec = ctrl.getPendingDecision();
      if (dec.type === 'draft') ctrl.resolveDecision(dec.offers[0]);
      else if (dec.type === 'mason') ctrl.resolveDecision(chooseStoneCell(ctrl.state, dec.candidates));
      continue;
    }
    const valid = ctrl.getValidMoves();
    if (valid.length === 0) {
      const diag = ctrl.getLegalTargets('diagonal_charge');
      if (diag.length > 0 && (ctrl.state.abilities?.diagonal_charge?.charges || 0) > 0) {
        ctrl.useAbility('diagonal_charge', diag[0]);
        continue;
      }
      const erase = ctrl.getLegalTargets('eraser');
      if (erase.length > 0 && (ctrl.state.abilities?.eraser?.charges || 0) > 0) {
        ctrl.useAbility('eraser', erase[0]);
        continue;
      }
      if (ctrl.getRewindUndoLevels() > 0) {
        ctrl.useAbility('rewind', null);
        continue;
      }
      break;
    }
    const dir = bot.chooseMove(ctrl.state) || valid[0];
    ctrl.recordInput('swipe', dir);
    ctrl.submitMove(dir);
  }
  return ctrl.getRunLog({ replayVersion });
}

export function generateTrustCases(rootDir = process.cwd()) {
  const replayVer = computeReplayVersion(rootDir);

  return [
    {
      id: 'hazard_schedule_infinity',
      name: 'hazard interval Infinity',
      expectedStatus: 'REJECT',
      expectedKey: 'hazardSchedule',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "hazardSchedule"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, hazardSchedule: [{ upToMove: Infinity, interval: Infinity }] }, replayVer),
    },
    {
      id: 'forced_relics_all',
      name: 'forcedRelics: all',
      expectedStatus: 'REJECT',
      expectedKey: 'forcedRelics',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "forcedRelics"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, forcedRelics: [...RELIC_IDS] }, replayVer),
    },
    {
      id: 'max_charges_99',
      name: 'maxCharges 99',
      expectedStatus: 'REJECT',
      expectedKey: 'maxCharges',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "maxCharges"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, maxCharges: 99 }, replayVer),
    },
    {
      id: 'enable_draft_false',
      name: 'enableDraft false',
      expectedStatus: 'REJECT',
      expectedKey: 'enableDraft',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "enableDraft"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, enableDraft: false }, replayVer),
    },
    {
      id: 'move_cap_5',
      name: 'moveCap 5',
      expectedStatus: 'REJECT',
      expectedKey: 'moveCap',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "moveCap"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, moveCap: 5 }, replayVer),
    },
    {
      id: 'draft_pool_one_relic',
      name: 'draftPool with one relic',
      expectedStatus: 'REJECT',
      expectedKey: 'draftPool',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "draftPool"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, draftPool: ['rewind'] }, replayVer),
    },
    {
      id: 'stone_group_cap_null',
      name: 'stoneGroupCap null',
      expectedStatus: 'REJECT',
      expectedKey: 'stoneGroupCap',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "stoneGroupCap"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, stoneGroupCap: null }, replayVer),
    },
    {
      id: 'extra_unknown_key',
      name: 'an extra unknown config key',
      expectedStatus: 'REJECT',
      expectedKey: 'hackedCustomKey',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: unexpected key "hackedCustomKey"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, hackedCustomKey: true }, replayVer),
    },
    {
      id: 'seed_not_daily',
      name: 'seed that is not daily seed',
      expectedStatus: 'REJECT',
      expectedKey: 'seed',
      expectedReasonPrefix: 'SEED_NOT_DAILY',
      run: playRunToOver(99999, DEFAULT_UI_CONFIG_OVERRIDES, replayVer),
    },
    {
      id: 'yesterday_seed_as_today',
      name: 'yesterday seed submitted as today',
      expectedStatus: 'REJECT',
      expectedKey: 'seed',
      expectedReasonPrefix: 'SEED_NOT_DAILY',
      run: playRunToOver(YESTERDAY_DAILY_SEED, DEFAULT_UI_CONFIG_OVERRIDES, replayVer),
    },
    {
      id: 'ascension_at_64',
      name: 'ascensionAt 64 in daily mode',
      expectedStatus: 'REJECT',
      expectedKey: 'ascensionAt',
      expectedReasonPrefix: 'CONFIG_NOT_CANONICAL: key "ascensionAt"',
      run: playRunToOver(TRUST_DAILY_SEED, { ...DEFAULT_UI_CONFIG_OVERRIDES, ascensionAt: 64 }, replayVer),
    },
    {
      id: 'untouched_default',
      name: 'untouched default-config run',
      expectedStatus: 'OK',
      expectedKey: null,
      expectedReasonPrefix: null,
      run: playRunToOver(TRUST_DAILY_SEED, DEFAULT_UI_CONFIG_OVERRIDES, replayVer),
    },
  ];
}
