/**
 * 2048 Rogue - Main Application Orchestration
 * Pure ES Modules, zero external dependencies, zero network requests.
 */

import {
  GameController,
  buildHazardSchedule,
  STONE,
  RELIC_IDS,
  RELICS,
} from './controller.js';

const DEFAULT_POOL = [
  'diagonal_charge',
  'eraser',
  'rewind',
  'fault_line',
  'mason',
  'siphon',
  'shatter',
  'last_stand',
];

const ALL_POOL = [
  'diagonal_charge',
  'eraser',
  'rewind',
  'diagonal_merge',
  'fault_line',
  'mason',
  'foresight',
  'siphon',
  'shatter',
  'last_stand',
];

const RELIC_NAMES = {
  diagonal_charge: 'Diagonal Merge',
  eraser: 'Eraser',
  rewind: 'Rewind',
  diagonal_merge: 'Diagonal Merge (Auto)',
  fault_line: 'Fault Line',
  mason: 'Mason',
  foresight: 'Foresight',
  siphon: 'Siphon',
  shatter: 'Shatter',
  last_stand: 'Last Stand',
};

const STORAGE_KEY_HISTORY = '2048_rogue_run_history';
const STORAGE_KEY_PLAYER = '2048_rogue_player_id';
const STORAGE_KEY_BEST = '2048_rogue_best_score';
const BUILD_ID = '__BUILD_ID__';

/* -------------------------------------------------------------
 * Dynamic Relic One-Liners
 * ------------------------------------------------------------- */
function getRelicOneLiner(relicId, config) {
  const cd = config.diagonalMergeCooldown ?? 3;
  let cdStr = `Every ${cd}th move`;
  if (cd % 10 === 1 && cd % 100 !== 11) cdStr = `Every ${cd}st move`;
  else if (cd % 10 === 2 && cd % 100 !== 12) cdStr = `Every ${cd}nd move`;
  else if (cd % 10 === 3 && cd % 100 !== 13) cdStr = `Every ${cd}rd move`;

  const max = config.maxCharges ?? 3;
  const diagN = config.diagonalChargeEvery ?? 10;
  const eraserN = config.eraserEvery ?? 20;
  const rewindN = config.rewindEvery ?? 10;

  const siphonMin = config.siphonMin ?? 16;
  const shatterMin = config.shatterMin ?? 64;
  const lastStandMax = config.lastStandMax ?? 16;

  switch (relicId) {
    case 'diagonal_charge':
      return `Charge: merge two equal tiles touching diagonally (you pick). Holds up to ${max}; +1 every ${diagN} moves. Costs no move.`;
    case 'eraser':
      return `Charge: remove any one tile. Holds up to ${max}; +1 every ${eraserN} moves. Costs no move.`;
    case 'rewind':
      return `Charge: undo your last swipe. Holds up to ${max}; +1 every ${rewindN} moves. Costs no move.`;
    case 'diagonal_merge':
      return `${cdStr}, one pair of equal tiles touching diagonally merges.`;
    case 'fault_line':
      return 'When you slide, a stone with a tile behind it and an empty cell ahead shifts one cell.';
    case 'mason':
      return 'You choose where each new stone lands, from 2 options.';
    case 'foresight':
      return 'See the values of the next 2 tile spawns and when a stone is due.';
    case 'siphon':
      return `A merge that creates a ${siphonMin}+ tile skips this move's tile spawn.`;
    case 'shatter':
      return `A merge that creates a ${shatterMin}+ tile destroys every stone touching it.`;
    case 'last_stand':
      return `Once per run, when you'd lose, all tiles of ${lastStandMax} or less vanish and you play on.`;
    default:
      return RELICS[relicId]?.description || '';
  }
}

/* -------------------------------------------------------------
 * URL Parameters
 * ------------------------------------------------------------- */
function parseUrlOptions() {
  const params = new URLSearchParams(window.location.search);
  const config = {
    hazardSchedule: buildHazardSchedule(3),
    draftEveryMoves: 60,
    draftThresholds: [],
    draftPool: [...DEFAULT_POOL],
    enableDraft: true,
    stoneLifetime: null,
    stoneGroupCap: 2, // Prototype default cap = 2
    forcedRelics: [],
    forceAtMove: 0,
    rewindEvery: 10,
  };

  let seed = null;
  let debug = false;

  if (params.has('seed')) {
    const s = parseInt(params.get('seed'), 10);
    if (!isNaN(s)) seed = s;
  }
  if (params.has('pool')) {
    const rawPool = params.get('pool').split(',').map(s => s.trim()).filter(Boolean);
    const validPool = [];
    for (const rid of rawPool) {
      if (RELIC_IDS.includes(rid)) {
        if (!validPool.includes(rid)) {
          validPool.push(rid);
        }
      } else {
        console.warn(`[2048-Rogue] Unknown relic id in ?pool= ignored: "${rid}"`);
      }
    }
    if (validPool.length > 0) {
      config.draftPool = validPool;
    } else {
      console.warn('[2048-Rogue] No valid relic ids found in ?pool=. Using default pool.');
      config.draftPool = [...DEFAULT_POOL];
    }
  }
  if (params.has('draft')) {
    const d = parseInt(params.get('draft'), 10);
    if (!isNaN(d) && d > 0) config.draftEveryMoves = d;
  }
  if (params.has('first')) {
    const f = parseInt(params.get('first'), 10);
    if (!isNaN(f) && f > 0) config.draftFirstAt = f;
  }
  if (params.has('stones')) {
    const mult = parseFloat(params.get('stones'));
    if (!isNaN(mult) && mult > 0) config.hazardSchedule = buildHazardSchedule(mult);
  }
  if (params.has('start')) {
    const rawStarts = params.get('start').split(',').map(s => s.trim()).filter(Boolean);
    const validStarts = rawStarts.filter(st => ALL_POOL.includes(st) || RELIC_IDS.includes(st));
    if (validStarts.length > 0) {
      config.forcedRelics = validStarts;
      config.forceAtMove = 0;
    }
  }
  if (params.has('shatter')) {
    const sh = parseInt(params.get('shatter'), 10);
    if (!isNaN(sh)) config.shatterMin = sh;
  }
  if (params.has('siphon')) {
    const si = parseInt(params.get('siphon'), 10);
    if (!isNaN(si)) config.siphonMin = si;
  }
  if (params.has('diag')) {
    const dg = parseInt(params.get('diag'), 10);
    if (!isNaN(dg) && dg > 0) {
      config.diagonalChargeEvery = dg;
      config.diagonalMergeCooldown = dg;
    }
  }
  if (params.has('eraser')) {
    const er = parseInt(params.get('eraser'), 10);
    if (!isNaN(er) && er > 0) config.eraserEvery = er;
  }
  if (params.has('rewind')) {
    const rw = parseInt(params.get('rewind'), 10);
    if (!isNaN(rw) && rw > 0) config.rewindEvery = rw;
  }
  if (params.has('maxcharges')) {
    const mc = parseInt(params.get('maxcharges'), 10);
    if (!isNaN(mc) && mc > 0) config.maxCharges = mc;
  }
  if (params.has('cap')) {
    const c = parseInt(params.get('cap'), 10);
    config.stoneGroupCap = (isNaN(c) || c === 0) ? null : c;
  }
  if (params.has('laststand')) {
    const ls = parseInt(params.get('laststand'), 10);
    if (!isNaN(ls)) config.lastStandMax = ls;
  }
  if (params.has('debug')) {
    debug = params.get('debug') === '1' || params.get('debug') === 'true';
  }

  return { seed, config, debug };
}

/* -------------------------------------------------------------
 * Safe LocalStorage Logging Helpers
 * ------------------------------------------------------------- */
function getPlayerId() {
  try {
    let pid = localStorage.getItem(STORAGE_KEY_PLAYER);
    if (!pid) {
      pid = 'anon_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_KEY_PLAYER, pid);
    }
    return pid;
  } catch {
    return 'anon_guest';
  }
}

function getStoredHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRunToHistory(runRecord) {
  try {
    const history = getStoredHistory();
    history.push(runRecord);
    const trimmed = history.slice(-20);
    localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('LocalStorage save failed:', err);
  }
}

function getStoredBestScore() {
  try {
    return parseInt(localStorage.getItem(STORAGE_KEY_BEST) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveStoredBestScore(score) {
  try {
    localStorage.setItem(STORAGE_KEY_BEST, String(score));
  } catch (err) {
    console.warn('LocalStorage best score save failed (storage may be blocked):', err);
  }
}

/* -------------------------------------------------------------
 * Icon Mapping & Popover Tooltips
 * ------------------------------------------------------------- */
const ICON_MAP = {
  diagonal_charge: 'icons/diagonal_merge.svg',
  rewind: 'icons/rewind.svg',
  fault_line: 'icons/fault_line.svg',
  mason: 'icons/mason.svg',
  siphon: 'icons/siphon.svg',
  shatter: 'icons/shatter.svg',
  last_stand: 'icons/last_stand.svg',
  diagonal_merge: 'icons/diagonal_merge.svg',
};
const warnedMissingIcons = new Set();

function getRelicIconElement(relicId, size = 30) {
  const src = ICON_MAP[relicId];
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.className = 'relic-icon-img';
    img.alt = RELIC_NAMES[relicId] || relicId;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.style.objectFit = 'contain';
    img.style.pointerEvents = 'none';
    img.style.display = 'block';
    return img;
  }
  if (!warnedMissingIcons.has(relicId)) {
    console.warn(`[2048-Rogue] No icon for "${relicId}" -> rendering fallback monogram "[${relicId.slice(0, 2).toUpperCase()}]" in rounded square`);
    warnedMissingIcons.add(relicId);
  }
  const mono = (relicId.slice(0, 2)).toUpperCase();
  const div = document.createElement('div');
  div.className = 'relic-monogram';
  div.textContent = mono;
  div.style.width = `${size}px`;
  div.style.height = `${size}px`;
  div.style.pointerEvents = 'none';
  return div;
}

let popoverTimeout = null;

function showRelicPopover(relicId, targetEl) {
  if (!relicPopover || !targetEl) return;
  if (popoverTimeout) clearTimeout(popoverTimeout);

  popoverTitle.textContent = RELIC_NAMES[relicId] || relicId;
  popoverDesc.textContent = getRelicOneLiner(relicId, controller.config);
  relicPopover.classList.remove('hidden');
  relicPopover.setAttribute('aria-hidden', 'false');

  const rect = targetEl.getBoundingClientRect();
  const popoverWidth = 260;
  let left = rect.left + rect.width / 2 - popoverWidth / 2;
  const viewportWidth = window.innerWidth;
  // Keep clamped inside viewport at 320px
  if (left < 8) left = 8;
  if (left + popoverWidth > viewportWidth - 8) {
    left = Math.max(8, viewportWidth - 8 - popoverWidth);
  }

  let top = rect.bottom + 6;
  if (top + 100 > window.innerHeight) {
    top = Math.max(8, rect.top - 80);
  }

  relicPopover.style.left = `${Math.round(left)}px`;
  relicPopover.style.top = `${Math.round(top)}px`;

  popoverTimeout = setTimeout(() => {
    hideRelicPopover();
  }, 5000);
}

function hideRelicPopover() {
  if (!relicPopover) return;
  if (popoverTimeout) clearTimeout(popoverTimeout);
  relicPopover.classList.add('hidden');
  relicPopover.setAttribute('aria-hidden', 'true');
}

window.addEventListener('click', (e) => {
  if (!relicPopover || relicPopover.classList.contains('hidden')) return;
  if (!e.target.closest('.relic-passive-item') && !e.target.closest('.ability-btn') && !e.target.closest('#relic-popover')) {
    hideRelicPopover();
  }
});

/* -------------------------------------------------------------
 * App State & DOM Elements
 * ------------------------------------------------------------- */
const { seed: initialSeed, config: activeConfig, debug: isDebugMode } = parseUrlOptions();
const playerId = getPlayerId();

let controller = null;
let isAnimating = false;
let masonCandidates = null;
let currentRunLog = null;
let activeTargeting = null; // null | { relicId, step: 1|2, selectedCell: number|null }

// DOM
const boardEl = document.getElementById('game-board');
const tilesLayer = document.getElementById('tiles-layer');
const ghostLayer = document.getElementById('ghost-layer');
const statScoreEl = document.getElementById('stat-score');
const statMovesEl = document.getElementById('stat-moves');
const statMaxTileEl = document.getElementById('stat-max-tile');
const stoneCountdownEl = document.getElementById('stone-countdown');
const hazardUnitEl = document.getElementById('hazard-unit');
const hazardTelegraphEl = document.getElementById('hazard-telegraph');
const passiveRelicsContainer = document.getElementById('passive-relics-container');
const statusHintBar = document.getElementById('status-hint-bar');
const statusHintText = document.getElementById('status-hint-text');

const abilityBar = document.getElementById('ability-bar');
const targetingBar = document.getElementById('targeting-bar');
const targetingInstruction = document.getElementById('targeting-instruction');
const btnCancelTargeting = document.getElementById('btn-cancel-targeting');
const stuckBanner = document.getElementById('stuck-banner');

const toastContainer = document.getElementById('toast-container');
const lastStandBanner = document.getElementById('last-stand-banner');
const relicPopover = document.getElementById('relic-popover');
const popoverTitle = document.getElementById('popover-title');
const popoverDesc = document.getElementById('popover-desc');

const startOverlay = document.getElementById('start-overlay');
const startBestScoreEl = document.getElementById('start-best-score');
const btnPlayStart = document.getElementById('btn-play-start');

const draftOverlay = document.getElementById('draft-overlay');
const draftOffersRow = document.getElementById('draft-offers-row');
const draftOwnedChips = document.getElementById('draft-owned-chips');

const endOverlay = document.getElementById('end-overlay');
const endScoreEl = document.getElementById('end-score');
const endNewBestBadge = document.getElementById('end-new-best-badge');
const endMovesEl = document.getElementById('end-moves');
const endMaxTileEl = document.getElementById('end-max-tile');
const endDraftsEl = document.getElementById('end-drafts');
const endSeedEl = document.getElementById('end-seed');
const endRelicsList = document.getElementById('end-relics-list');
const btnPlayAgain = document.getElementById('btn-play-again');
const btnCopyLog = document.getElementById('btn-copy-log');

const debugPanel = document.getElementById('debug-panel');
const dbgSeedEl = document.getElementById('dbg-seed');
const dbgMoveEl = document.getElementById('dbg-move');
const dbgTileRngEl = document.getElementById('dbg-tile-rng');
const dbgStoneRngEl = document.getElementById('dbg-stone-rng');
const dbgDraftRngEl = document.getElementById('dbg-draft-rng');
const dbgActivationsEl = document.getElementById('dbg-activations');

if (isDebugMode) {
  debugPanel.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * UI Feedback: Toasts & Flashes
 * ------------------------------------------------------------- */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 1600);
}

function showLastStandMoment() {
  lastStandBanner.classList.remove('hidden');
  setTimeout(() => {
    lastStandBanner.classList.add('hidden');
  }, 1300);
}

function flashCellVanish(cellIndex) {
  const cellEl = boardEl.querySelector(`.grid-cell[data-index="${cellIndex}"]`);
  if (!cellEl) return;
  const flash = document.createElement('div');
  flash.className = 'cell-vanish-flash';
  cellEl.appendChild(flash);
  setTimeout(() => flash.remove(), 380);
}

function flashCellMergePop(cellIndex) {
  const tileEl = tilesLayer.querySelector(`.tile[data-index="${cellIndex}"]`);
  if (tileEl) {
    tileEl.classList.add('merge-pop');
    setTimeout(() => tileEl.classList.remove('merge-pop'), 350);
  }
}

/* -------------------------------------------------------------
 * Board Rendering
 * ------------------------------------------------------------- */
function getCellCoordinates(index) {
  const r = Math.floor(index / 4);
  const c = index % 4;
  return {
    top: `calc(${r} * ((100% - 3 * var(--cell-gap)) / 4 + var(--cell-gap)))`,
    left: `calc(${c} * ((100% - 3 * var(--cell-gap)) / 4 + var(--cell-gap)))`,
  };
}

function renderBoard(board = (controller ? controller.getBoard() : []), prevBoard = null, animateMerges = true) {
  tilesLayer.innerHTML = '';

  for (let i = 0; i < 16; i++) {
    const val = board[i];
    if (val === 0) continue;

    const tile = document.createElement('div');
    tile.setAttribute('data-index', i);
    const { top, left } = getCellCoordinates(i);
    tile.style.top = top;
    tile.style.left = left;

    if (val === STONE) {
      tile.className = 'tile tile-stone';
      tile.innerHTML = `
        <div class="stone-inner">
          <span class="stone-glyph">&#x2715;</span>
          <span class="stone-label">STONE</span>
        </div>
      `;
      if (prevBoard && prevBoard[i] !== STONE) {
        tile.classList.add('tile-spawn');
      }
    } else {
      const cls = val <= 8192 ? `tile-${val}` : 'tile-8192';
      tile.className = `tile ${cls}`;
      tile.textContent = val;

      if (prevBoard) {
        if (prevBoard[i] === 0) {
          tile.classList.add('tile-spawn');
        } else if (animateMerges && prevBoard[i] !== val) {
          tile.classList.add('tile-merge');
        }
      }
    }

    tilesLayer.appendChild(tile);
  }

  if (activeTargeting) {
    highlightTargetingBoard();
  }
}

function renderGhostTiles() {
  ghostLayer.innerHTML = '';
  renderForesightPreview();
}

function renderForesightPreview() {
  const foresightBar = document.getElementById('foresight-bar');
  if (!foresightBar) return;
  const preview = controller.getForesightPreview();
  if (!preview) {
    foresightBar.classList.add('hidden');
    return;
  }

  foresightBar.classList.remove('hidden');
  const t1 = document.getElementById('foresight-tile-1');
  const t2 = document.getElementById('foresight-tile-2');
  const stoneBadge = document.getElementById('foresight-stone-due');

  if (t1) t1.textContent = (preview.values && preview.values[0] != null) ? preview.values[0] : '-';
  if (t2) t2.textContent = (preview.values && preview.values[1] != null) ? preview.values[1] : '-';
  if (stoneBadge) {
    if (preview.stoneDue) {
      stoneBadge.classList.remove('hidden');
    } else {
      stoneBadge.classList.add('hidden');
    }
  }
}

/* -------------------------------------------------------------
 * Header & UI State Updates
 * ------------------------------------------------------------- */
function updateHeader() {
  const state = controller.getState();
  if (statScoreEl) statScoreEl.textContent = state.score;
  statMovesEl.textContent = state.moveCount;
  statMaxTileEl.textContent = state.highestTile;

  const stoneInfo = controller.getNextStoneInfo();
  stoneCountdownEl.textContent = stoneInfo.movesUntilNextStone;
  if (hazardUnitEl) {
    hazardUnitEl.textContent = stoneInfo.movesUntilNextStone === 1 ? 'move' : 'moves';
  }

  if (stoneInfo.movesUntilNextStone <= 1) {
    hazardTelegraphEl.classList.add('imminent');
  } else {
    hazardTelegraphEl.classList.remove('imminent');
  }

  // Passive relics = every owned relic except diagonal_charge, eraser, rewind
  if (passiveRelicsContainer) {
    const owned = Array.from(state.relics);
    const passives = owned.filter(rid => rid !== 'diagonal_charge' && rid !== 'eraser' && rid !== 'rewind');

    // Retain existing items to preserve fade-out animation if Last Stand just fired
    const currentItems = Array.from(passiveRelicsContainer.children);
    const existingMap = new Map();
    for (const el of currentItems) {
      const rid = el.getAttribute('data-relic');
      if (rid) existingMap.set(rid, el);
    }

    passiveRelicsContainer.innerHTML = '';

    for (const rid of passives) {
      if (rid === 'last_stand' && state.lastStandUsed) {
        // Last Stand already fired: do not render
        continue;
      }

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'relic-passive-item';
      item.setAttribute('data-relic', rid);
      item.setAttribute('aria-label', RELIC_NAMES[rid] || rid);
      item.tabIndex = 0;

      const iconEl = getRelicIconElement(rid, 30);
      item.appendChild(iconEl);

      // Popover handlers
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        showRelicPopover(rid, item);
      });
      item.addEventListener('mouseenter', () => {
        showRelicPopover(rid, item);
      });
      item.addEventListener('mouseleave', () => {
        hideRelicPopover();
      });
      item.addEventListener('focus', () => {
        showRelicPopover(rid, item);
      });
      item.addEventListener('blur', () => {
        hideRelicPopover();
      });

      passiveRelicsContainer.appendChild(item);
    }
  }

  // Debug inspector
  if (isDebugMode) {
    dbgSeedEl.textContent = controller.seed;
    dbgMoveEl.textContent = state.moveCount;
    dbgTileRngEl.textContent = state.rngs?.tile?.drawCount ?? 0;
    dbgStoneRngEl.textContent = state.rngs?.stone?.drawCount ?? 0;
    dbgDraftRngEl.textContent = state.rngs?.draft?.drawCount ?? 0;

    dbgActivationsEl.innerHTML = '';
    const acts = state.relicActivations || {};
    for (const [rid, cnt] of Object.entries(acts)) {
      const badge = document.createElement('div');
      badge.className = 'debug-badge';
      badge.textContent = `${rid}: ${cnt}`;
      dbgActivationsEl.appendChild(badge);
    }
  }
}

/* -------------------------------------------------------------
 * Ability Bar & Targeting Mode
 * ------------------------------------------------------------- */
function renderAbilityBar() {
  if (!abilityBar) return;
  abilityBar.innerHTML = '';

  const state = controller.getState();
  const allAbilities = controller.getAbilityState();
  const abilityStates = Object.values(allAbilities).filter(ab => ab && typeof ab === 'object' && ab.relic);
  const isStuck = Boolean(state.stuckNeedsAbility);
  const decisionPending = controller.hasPendingDecision();

  // Stuck state banner
  if (stuckBanner) {
    if (isStuck) {
      stuckBanner.classList.remove('hidden');
    } else {
      stuckBanner.classList.add('hidden');
    }
  }

  if (abilityStates.length === 0) {
    abilityBar.classList.add('hidden');
    return;
  }
  abilityBar.classList.remove('hidden');

  for (const ab of abilityStates) {
    const rid = ab.relic;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ability-btn';
    btn.setAttribute('data-relic', rid);
    btn.setAttribute('aria-label', `${RELIC_NAMES[rid] || rid} ability`);

    if (activeTargeting && activeTargeting.relicId === rid) {
      btn.classList.add('active-targeting');
    }

    const hasLegal = ab.legalTargets && ab.legalTargets.length > 0;
    const hasCharges = ab.charges > 0;
    const canUse = !decisionPending && hasCharges && hasLegal && !controller.isGameOver();

    if (!canUse) {
      btn.disabled = true;
    } else if (isStuck) {
      btn.classList.add('highlight-stuck');
    }

    // Cooldown text or disabled reason
    let cdText = '';
    if (decisionPending) {
      cdText = 'Wait decision';
    } else if (!hasCharges) {
      const rem = ab.swipesUntilNext ?? 0;
      cdText = `+1 in ${rem}`;
    } else if (!hasLegal) {
      cdText = rid === 'rewind' ? 'Nothing to undo' : 'No targets';
    } else if (ab.charges >= ab.maxCharges) {
      cdText = 'MAX';
    } else {
      const rem = ab.swipesUntilNext ?? 0;
      cdText = `+1 in ${rem}`;
    }

    // Icon (~40px)
    const iconWrap = document.createElement('div');
    iconWrap.className = 'ability-btn-icon-wrap';
    iconWrap.appendChild(getRelicIconElement(rid, 36));

    // 3 Pips
    const pipsEl = document.createElement('div');
    pipsEl.className = 'ability-pips';
    for (let p = 0; p < ab.maxCharges; p++) {
      const pip = document.createElement('span');
      pip.className = `charge-pip ${p < ab.charges ? 'filled' : ''}`;
      pipsEl.appendChild(pip);
    }

    // Text line
    const cdEl = document.createElement('div');
    cdEl.className = 'ability-btn-cooldown';
    cdEl.textContent = cdText;

    btn.appendChild(iconWrap);
    btn.appendChild(pipsEl);
    btn.appendChild(cdEl);

    // Press-and-hold (500ms) shows description popover without triggering ability
    let holdTimer = null;
    let didHold = false;

    const startHold = () => {
      didHold = false;
      holdTimer = setTimeout(() => {
        didHold = true;
        showRelicPopover(rid, btn);
      }, 500);
    };

    const cancelHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
    };

    btn.addEventListener('pointerdown', startHold);
    btn.addEventListener('pointerup', cancelHold);
    btn.addEventListener('pointercancel', cancelHold);
    btn.addEventListener('pointerleave', cancelHold);

    btn.addEventListener('click', (e) => {
      if (didHold) {
        e.preventDefault();
        didHold = false;
        return;
      }
      hideRelicPopover();
      controller.recordInput('tap');

      if (rid === 'rewind') {
        // Rewind is single-tap with no targeting
        if (canUse) {
          executeAbility('rewind', {});
        }
      } else {
        if (activeTargeting && activeTargeting.relicId === rid) {
          cancelTargeting();
        } else if (canUse) {
          startTargeting(rid);
        }
      }
    });

    abilityBar.appendChild(btn);
  }
}

function startTargeting(relicId) {
  if (controller.isGameOver() || controller.hasPendingDecision()) return;
  const legalTargets = controller.getLegalTargets(relicId);
  const abilityState = controller.getAbilityState()[relicId];
  if (!abilityState || abilityState.charges <= 0 || legalTargets.length === 0) return;

  activeTargeting = {
    relicId,
    step: 1,
    selectedCell: null,
  };

  targetingBar.classList.remove('hidden');
  if (relicId === 'diagonal_charge') {
    targetingInstruction.textContent = 'Tap the tile to move, then the equal tile diagonal to it';
  } else if (relicId === 'eraser') {
    targetingInstruction.textContent = 'Eraser: tap a number tile to remove';
  }

  highlightTargetingBoard();
  renderAbilityBar();
}

function cancelTargeting() {
  activeTargeting = null;
  if (targetingBar) targetingBar.classList.add('hidden');
  clearTargetingHighlights();
  renderAbilityBar();
}

function highlightTargetingBoard() {
  clearTargetingHighlights();
  if (!activeTargeting) return;

  const { relicId, step, selectedCell } = activeTargeting;
  const legalTargets = controller.getLegalTargets(relicId);

  if (relicId === 'diagonal_charge') {
    if (step === 1) {
      const candidateCells = new Set();
      for (const t of legalTargets) {
        candidateCells.add(t.from);
      }
      for (const idx of candidateCells) {
        const tile = tilesLayer.querySelector(`.tile[data-index="${idx}"]`);
        if (tile) tile.classList.add('target-candidate');
      }
    } else if (step === 2 && selectedCell !== null) {
      const selectedTile = tilesLayer.querySelector(`.tile[data-index="${selectedCell}"]`);
      if (selectedTile) selectedTile.classList.add('target-selected');

      const partnerCells = new Set();
      for (const t of legalTargets) {
        if (t.from === selectedCell) partnerCells.add(t.to);
      }
      for (const idx of partnerCells) {
        const tile = tilesLayer.querySelector(`.tile[data-index="${idx}"]`);
        if (tile) tile.classList.add('target-partner');
      }
    }
  } else if (relicId === 'eraser') {
    if (step === 1) {
      for (const t of legalTargets) {
        const tile = tilesLayer.querySelector(`.tile[data-index="${t.cell}"]`);
        if (tile) tile.classList.add('target-candidate');
      }
    } else if (step === 2 && selectedCell !== null) {
      const selectedTile = tilesLayer.querySelector(`.tile[data-index="${selectedCell}"]`);
      if (selectedTile) {
        selectedTile.classList.add('eraser-confirm');
      }
    }
  }
}

function clearTargetingHighlights() {
  const tiles = tilesLayer.querySelectorAll('.tile');
  tiles.forEach(tile => {
    tile.classList.remove('target-candidate', 'target-selected', 'target-partner', 'eraser-confirm');
  });
}

function executeAbility(relicId, target) {
  const actsBefore = { ...(controller.getState().relicActivations || {}) };
  const boardBefore = controller.getBoard();

  const res = controller.useAbility(relicId, target);
  cancelTargeting();

  if (!res.success) {
    showToast(`Error: ${res.error || 'Failed to use ability'}`);
    return;
  }

  // Animation feedback
  if (relicId === 'diagonal_charge') {
    flashCellMergePop(target.to);
    showToast('Diagonal Merge!');
  } else if (relicId === 'eraser') {
    flashCellVanish(target.cell);
    showToast('Eraser!');
  } else if (relicId === 'rewind') {
    boardEl.classList.add('rewind-fade');
    setTimeout(() => boardEl.classList.remove('rewind-fade'), 120);
    showToast('Rewind!');
  }

  // Shatter feedback if triggered
  const actsAfter = controller.getState().relicActivations || {};
  if ((actsAfter.shatter || 0) > (actsBefore.shatter || 0)) {
    showToast('Shatter!');
    const boardAfter = controller.getBoard();
    for (let i = 0; i < 16; i++) {
      if (boardBefore[i] === STONE && boardAfter[i] !== STONE) {
        flashCellVanish(i);
      }
    }
  }

  if (res.state.lastStandUsed && res.res?.lastStandFired) {
    showLastStandMoment();
  }

  renderBoard(controller.getBoard());
  updateHeader();
  renderGhostTiles();
  renderAbilityBar();

  if (controller.isGameOver()) {
    handleGameOver();
  }
}

/* -------------------------------------------------------------
 * Draft Modal
 * ------------------------------------------------------------- */
function showDraftModal(decision) {
  draftOffersRow.innerHTML = '';
  draftOwnedChips.innerHTML = '';

  // Currently owned relics
  const owned = Array.from(controller.getState().relics);
  if (owned.length === 0) {
    draftOwnedChips.innerHTML = '<span class="no-relics-msg">None</span>';
  } else {
    for (const rid of owned) {
      const chip = document.createElement('div');
      chip.className = 'relic-chip';
      let name = RELIC_NAMES[rid] || rid;
      if (rid === 'last_stand' && (controller.lastStandFired || controller.getState().lastStandUsed)) {
        name += ' (used)';
        chip.classList.add('used');
      }
      chip.textContent = name;
      draftOwnedChips.appendChild(chip);
    }
  }

  // 3 Offer Cards
  for (const rid of decision.offers) {
    const card = document.createElement('div');
    card.className = 'draft-offer-card';
    card.tabIndex = 0;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'draft-offer-icon-wrap';
    iconWrap.appendChild(getRelicIconElement(rid, 56));

    const details = document.createElement('div');
    details.className = 'draft-offer-details';
    details.innerHTML = `
      <div class="draft-offer-name">${RELIC_NAMES[rid] || rid}</div>
      <div class="draft-offer-desc">${getRelicOneLiner(rid, controller.config)}</div>
    `;

    card.appendChild(iconWrap);
    card.appendChild(details);

    const selectRelic = () => {
      draftOverlay.classList.add('hidden');
      const res = controller.resolveDecision(rid);
      showToast(`Drafted: ${RELIC_NAMES[rid] || rid}`);
      postMoveResolution(res);
    };

    card.addEventListener('click', selectRelic);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectRelic();
      }
    });

    draftOffersRow.appendChild(card);
  }

  draftOverlay.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * Mason Placement
 * ------------------------------------------------------------- */
function activateMasonMode(candidates) {
  masonCandidates = candidates;
  statusHintBar.classList.add('mason-active');
  statusHintText.textContent = 'Mason: Choose where the stone lands (tap a highlighted cell)';

  for (const c of candidates) {
    const cellEl = boardEl.querySelector(`.grid-cell[data-index="${c}"]`);
    if (cellEl) {
      cellEl.classList.add('mason-candidate');
    }
  }
}

function clearMasonMode() {
  if (masonCandidates) {
    for (const c of masonCandidates) {
      const cellEl = boardEl.querySelector(`.grid-cell[data-index="${c}"]`);
      if (cellEl) cellEl.classList.remove('mason-candidate');
    }
    masonCandidates = null;
  }
  statusHintBar.classList.remove('mason-active');
  statusHintText.textContent = 'Use Arrow Keys, WASD, or Swipe to slide';
}

/* -------------------------------------------------------------
 * Move Handling & Step Execution
 * ------------------------------------------------------------- */
function handleMove(direction, inputType = 'key') {
  if (isAnimating) return;
  if (controller.isGameOver()) return;
  if (controller.hasPendingDecision()) return;

  cancelTargeting();
  controller.recordInput(inputType);

  const boardBefore = controller.getBoard();
  const actsBefore = { ...(controller.getState().relicActivations || {}) };

  const moveRes = controller.submitMove(direction);
  if (!moveRes.success) {
    return;
  }

  isAnimating = true;

  // Render move slide
  const boardAfter = controller.getBoard();

  // Check relic activations to trigger toasts and flashes
  const actsAfter = controller.getState().relicActivations || {};
  for (const rid of RELIC_IDS) {
    const diff = (actsAfter[rid] || 0) - (actsBefore[rid] || 0);
    if (diff > 0 && rid !== 'foresight') {
      showToast(`${RELIC_NAMES[rid] || rid}!`);
    }
  }

  // Diff cells for vanished stones (shatter / last_stand)
  for (let i = 0; i < 16; i++) {
    if (boardBefore[i] === STONE && boardAfter[i] !== STONE) {
      flashCellVanish(i);
    }
  }

  if (moveRes.stepResult?.lastStandFired) {
    showLastStandMoment();
  }

  setTimeout(() => {
    isAnimating = false;
    postMoveResolution(moveRes);
  }, 110);
}

function postMoveResolution(res) {
  renderBoard(controller.getBoard(), res.stepResult?.boardBefore);
  updateHeader();
  renderGhostTiles();
  renderAbilityBar();

  if (controller.hasPendingDecision()) {
    const dec = controller.getPendingDecision();
    if (dec.type === 'draft') {
      showDraftModal(dec);
    } else if (dec.type === 'mason') {
      activateMasonMode(dec.candidates);
    }
    return;
  }

  clearMasonMode();

  if (controller.isGameOver()) {
    handleGameOver();
  }
}

/* -------------------------------------------------------------
 * Game Over & End Screen
 * ------------------------------------------------------------- */
function handleGameOver() {
  const metadata = {
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    queryString: window.location.search || '',
    userAgent: navigator.userAgent || '',
    buildId: BUILD_ID,
    bestScoreAtRunStart: controller.bestScoreAtRunStart || 0,
  };
  currentRunLog = controller.getRunLog(metadata);
  saveRunToHistory(currentRunLog);

  // Score headline & local storage best score check
  const storedBest = getStoredBestScore();
  const isNewBest = currentRunLog.score > storedBest;
  if (isNewBest) {
    saveStoredBestScore(currentRunLog.score);
    if (endNewBestBadge) endNewBestBadge.classList.remove('hidden');
  } else {
    if (endNewBestBadge) endNewBestBadge.classList.add('hidden');
  }
  if (endScoreEl) endScoreEl.textContent = currentRunLog.score;

  endMovesEl.textContent = currentRunLog.totalMoves;
  endMaxTileEl.textContent = currentRunLog.maxTile;
  endDraftsEl.textContent = currentRunLog.draftsSeen;
  endSeedEl.textContent = currentRunLog.seed;

  endRelicsList.innerHTML = '';
  if (currentRunLog.relicsOwned.length === 0) {
    endRelicsList.innerHTML = '<span class="no-relics-msg">No relics drafted</span>';
  } else {
    for (const rid of currentRunLog.relicsOwned) {
      const chip = document.createElement('div');
      chip.className = 'relic-chip';
      chip.textContent = RELIC_NAMES[rid] || rid;
      endRelicsList.appendChild(chip);
    }
  }

  endOverlay.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * Run Initialization
 * ------------------------------------------------------------- */
function startNewGame(seed = null) {
  const chosenSeed = seed !== null ? seed : (initialSeed !== null ? initialSeed : Math.floor(Math.random() * 2147483647) + 1);
  const bestScore = getStoredBestScore();
  controller = new GameController(chosenSeed, activeConfig, playerId);
  controller.bestScoreAtRunStart = bestScore;

  if (startBestScoreEl) startBestScoreEl.textContent = bestScore;

  startOverlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  draftOverlay.classList.add('hidden');
  clearMasonMode();
  cancelTargeting();

  window.controller = controller;
  window.renderBoard = renderBoard;
  window.updateHeader = updateHeader;
  window.renderAbilityBar = renderAbilityBar;

  renderBoard(controller.getBoard());
  updateHeader();
  renderGhostTiles();
  renderAbilityBar();
}

/* -------------------------------------------------------------
 * Input Listeners
 * ------------------------------------------------------------- */
// Keyboard Controls
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (activeTargeting) {
      e.preventDefault();
      cancelTargeting();
      return;
    }
  }

  if (!startOverlay.classList.contains('hidden') || !endOverlay.classList.contains('hidden') || !draftOverlay.classList.contains('hidden')) {
    return;
  }

  let dir = null;
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA':
      dir = 'L'; break;
    case 'ArrowRight':
    case 'KeyD':
      dir = 'R'; break;
    case 'ArrowUp':
    case 'KeyW':
      dir = 'U'; break;
    case 'ArrowDown':
    case 'KeyS':
      dir = 'D'; break;
  }

  if (dir) {
    e.preventDefault();
    handleMove(dir, 'key');
  }
});

// Touch Swipe Controls (24px threshold, touch-action: none)
let touchStartX = 0;
let touchStartY = 0;

boardEl.addEventListener('touchstart', (e) => {
  if (e.touches.length > 0) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }
}, { passive: true });

boardEl.addEventListener('touchend', (e) => {
  if (e.changedTouches.length === 0) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);

  if (Math.max(absX, absY) >= 24) {
    let dir;
    if (absX > absY) {
      dir = dx > 0 ? 'R' : 'L';
    } else {
      dir = dy > 0 ? 'D' : 'U';
    }
    handleMove(dir, 'swipe');
  }
}, { passive: true });

// Board clicks: Mason & Targeting
boardEl.addEventListener('click', (e) => {
  // Mason placement
  if (masonCandidates && controller.hasPendingDecision()) {
    const cellEl = e.target.closest('.grid-cell');
    if (!cellEl) return;
    const idx = parseInt(cellEl.getAttribute('data-index'), 10);
    if (!isNaN(idx) && masonCandidates.includes(idx)) {
      controller.recordInput('tap');
      clearMasonMode();
      const res = controller.resolveDecision(idx);
      showToast('Stone placed by Mason');
      postMoveResolution(res);
    }
    return;
  }

  // Ability targeting mode
  if (activeTargeting) {
    controller.recordInput('tap');
    const targetEl = e.target.closest('.tile') || e.target.closest('.grid-cell');
    if (!targetEl) {
      cancelTargeting();
      return;
    }
    const cellIdx = parseInt(targetEl.getAttribute('data-index'), 10);
    if (isNaN(cellIdx) || cellIdx < 0 || cellIdx > 15) {
      cancelTargeting();
      return;
    }

    const { relicId, step, selectedCell } = activeTargeting;
    const legalTargets = controller.getLegalTargets(relicId);

    if (relicId === 'diagonal_charge') {
      if (step === 1) {
        const isCandidate = legalTargets.some(t => t.from === cellIdx);
        if (isCandidate) {
          activeTargeting.step = 2;
          activeTargeting.selectedCell = cellIdx;
          targetingInstruction.textContent = 'Tap the equal tile diagonal to it';
          highlightTargetingBoard();
        } else {
          cancelTargeting();
        }
      } else if (step === 2) {
        if (cellIdx === selectedCell) {
          cancelTargeting();
        } else {
          const isPartner = legalTargets.some(t => t.from === selectedCell && t.to === cellIdx);
          if (isPartner) {
            const fromCell = selectedCell;
            const toCell = cellIdx;
            const fromTile = tilesLayer.querySelector(`.tile[data-index="${fromCell}"]`);
            if (fromTile) {
              const toCoords = getCellCoordinates(toCell);
              fromTile.style.transition = 'top 110ms ease, left 110ms ease';
              fromTile.style.top = toCoords.top;
              fromTile.style.left = toCoords.left;
              fromTile.style.zIndex = '10';
            }
            setTimeout(() => {
              executeAbility('diagonal_charge', { from: fromCell, to: toCell });
            }, 110);
          } else {
            // Check if user tapped a different candidate tile to switch
            const isOtherCandidate = legalTargets.some(t => t.from === cellIdx);
            if (isOtherCandidate) {
              activeTargeting.selectedCell = cellIdx;
              targetingInstruction.textContent = 'Tap the equal tile diagonal to it';
              highlightTargetingBoard();
            } else {
              cancelTargeting();
            }
          }
        }
      }
    } else if (relicId === 'eraser') {
      if (step === 1) {
        const isLegal = legalTargets.some(t => t.cell === cellIdx);
        if (isLegal) {
          activeTargeting.step = 2;
          activeTargeting.selectedCell = cellIdx;
          targetingInstruction.textContent = 'Tap the same tile again to confirm ERASE, or elsewhere to cancel';
          highlightTargetingBoard();
        } else {
          cancelTargeting();
        }
      } else if (step === 2) {
        if (cellIdx === selectedCell) {
          executeAbility('eraser', { cell: selectedCell });
        } else {
          cancelTargeting();
        }
      }
    }
  }
});

// Cancel targeting button
btnCancelTargeting.addEventListener('click', () => {
  controller.recordInput('tap');
  cancelTargeting();
});

// Start button (idempotent: cannot run twice)
if (btnPlayStart) {
  btnPlayStart.addEventListener('click', (e) => {
    e.preventDefault();
    if (startOverlay && startOverlay.classList.contains('hidden')) return;
    startNewGame();
  });
}

// Allow Enter or Space on start overlay to start game (idempotent: only if startOverlay is visible)
if (startOverlay) {
  startOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (startOverlay.classList.contains('hidden')) return;
      e.preventDefault();
      startNewGame();
    }
  });
}

// Play again button
btnPlayAgain.addEventListener('click', () => {
  startNewGame();
});

// Copy run log button (copies { currentRun: <record>, history: [<last 20 records>] }, fallback download)
btnCopyLog.addEventListener('click', async () => {
  const currentRun = currentRunLog || controller.getRunLog({
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    queryString: window.location.search || '',
    userAgent: navigator.userAgent || '',
    buildId: BUILD_ID,
    bestScoreAtRunStart: controller.bestScoreAtRunStart || 0,
  });
  const history = getStoredHistory();
  const payload = { currentRun, history };
  const jsonStr = JSON.stringify(payload, null, 2);

  let copied = false;
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(jsonStr);
      copied = true;
      showToast('Run log copied to clipboard!');
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `2048-rogue-runlog-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Run log downloaded!');
    } catch (err) {
      console.error('Copy/download fallback failed:', err);
    }
  }
});

window.getCopyPayload = () => {
  const currentRun = currentRunLog || controller.getRunLog({
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    queryString: window.location.search || '',
    userAgent: navigator.userAgent || '',
    buildId: BUILD_ID,
    bestScoreAtRunStart: controller.bestScoreAtRunStart || 0,
  });
  const history = getStoredHistory();
  return { currentRun, history };
};

// Initialize game on load
const buildIdEl = document.getElementById('start-build-id');
if (buildIdEl) {
  buildIdEl.textContent = `BUILD: ${BUILD_ID}`;
}

const hasLaunchParams = window.location.search && window.location.search.length > 1;
if (hasLaunchParams) {
  startNewGame(initialSeed);
} else {
  startNewGame(null);
  if (startOverlay) startOverlay.classList.remove('hidden');
}
