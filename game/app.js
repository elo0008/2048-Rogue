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
import { computeSlide } from './slide.js';
import {
  initAudio,
  playSwipe,
  playMerge,
  playSpawn,
  playStone,
  playDiagonal,
  playEraser,
  playRewind,
  playDraftPick,
  playLastStand,
  playLastStandThud,
  playShatterCrack,
  playStuckThud,
  playGameOver,
  playClick,
  playCleanSlate,
  playCleanSlateThud,
  playCleanSlateShimmer,
  isSoundEnabled,
  toggleSound,
  getAudioState,
} from './audio.js';
import {
  dailySeed,
  utcDateString,
  msUntilNextUtcMidnight,
  formatCountdown,
  formatNextResetLocalTime,
} from './daily.js';
import {
  getDeviceId,
  shouldSubmitRun,
  getStoredDailyBest,
  enqueueSubmission,
  flushQueue,
  getMyDailyRank,
  fetchBoard,
  fetchMyRank,
  setDisplayName,
  rankSummary,
  avatarInitials,
  formatPoints,
  getMondayUtc,
  createChallenge,
} from './leaderboard.js';

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
const STORAGE_KEY_TOP_RUNS = '2048_rogue_top_runs';
const STORAGE_KEY_PLAYER = '2048_rogue_player_id';
const STORAGE_KEY_BEST = '2048_rogue_best_points';
const STORAGE_KEY_ERRORS = '2048_rogue_errors';
const BUILD_ID = '__BUILD_ID__';

let persistenceEnabled = true;

let sessionTopRuns = null;

function getTopRuns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TOP_RUNS);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.sort((a, b) => (b.points || 0) - (a.points || 0));
        return parsed.slice(0, 10);
      }
    }
  } catch (err) {
    if (sessionTopRuns !== null) return sessionTopRuns;
  }

  // Seed once from 2048_rogue_run_history if key missing
  const seeded = [];
  try {
    const history = getStoredHistory();
    for (const h of history) {
      const runId = h.runId || (h.timestamp ? `run_${h.timestamp}` : null);
      if (!runId || seeded.some(r => r.runId === runId)) continue;
      seeded.push({
        runId,
        points: h.points || 0,
        moves: h.totalMoves ?? h.moves ?? 0,
        maxTile: h.maxTile || 2,
        relics: Array.isArray(h.relicsOwned) ? [...h.relicsOwned] : (Array.isArray(h.relics) ? [...h.relics] : []),
        endedAt: h.timestamp || h.endedAt || new Date().toISOString(),
        activeMs: h.activeMs ?? null,
      });
    }
    seeded.sort((a, b) => (b.points || 0) - (a.points || 0));
    const top10 = seeded.slice(0, 10);
    try {
      if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_TOP_RUNS, JSON.stringify(top10));
    } catch { }
    sessionTopRuns = top10;
    return top10;
  } catch {
    sessionTopRuns = [];
    return [];
  }
}

function saveTopRun(entry) {
  if (!entry || !entry.runId) return;
  const sanitizedEntry = {
    ...entry,
    activeMs: entry.activeMs ?? null,
    eventsCount: entry.eventsCount ?? (Array.isArray(entry.events) ? entry.events.length : 0),
  };
  delete sanitizedEntry.events;
  try {
    let list = getTopRuns();
    if (list.some(r => r.runId === sanitizedEntry.runId)) return;
    list = [...list, sanitizedEntry];
    // Stable sort by points desc (ties: earlier run stays ahead)
    list.sort((a, b) => (b.points || 0) - (a.points || 0));
    const top10 = list.slice(0, 10);
    try {
      if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_TOP_RUNS, JSON.stringify(top10));
    } catch { }
    sessionTopRuns = top10;
  } catch {
    if (!sessionTopRuns) sessionTopRuns = [];
    if (!sessionTopRuns.some(r => r.runId === sanitizedEntry.runId)) {
      sessionTopRuns.push(sanitizedEntry);
      sessionTopRuns.sort((a, b) => (b.points || 0) - (a.points || 0));
      sessionTopRuns = sessionTopRuns.slice(0, 10);
    }
  }
}

function getStoredErrors() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ERRORS);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveErrorRecord(errObj) {
  try {
    const list = getStoredErrors();
    list.push(errObj);
    const trimmed = list.slice(-10);
    if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_ERRORS, JSON.stringify(trimmed));
  } catch (err) {
    console.warn('LocalStorage error save failed:', err);
  }
}

function getBasename(urlOrFile) {
  if (!urlOrFile) return '';
  try {
    const u = new URL(urlOrFile, window.location.href);
    const parts = u.pathname.split('/');
    return parts[parts.length - 1] || u.pathname;
  } catch {
    const parts = String(urlOrFile).split(/[\/\\]/);
    return parts[parts.length - 1] || String(urlOrFile);
  }
}

function recordCapturedError(message, source, line, col, error) {
  const currentMoves = typeof controller !== 'undefined' && controller?.state?.moveCount != null
    ? controller.state.moveCount
    : 0;
  const msgStr = typeof message === 'string' ? message : (error?.message || String(message || ''));
  const stackStr = typeof error?.stack === 'string' ? error.stack.slice(0, 300) : (typeof error === 'string' ? error.slice(0, 300) : '');
  const record = {
    message: msgStr.slice(0, 200),
    file: getBasename(source || error?.fileName || ''),
    line: line || error?.lineNumber || 0,
    col: col || error?.columnNumber || 0,
    ts: Date.now(),
    moveCountAtError: currentMoves,
    stack: stackStr,
  };
  saveErrorRecord(record);
  if (typeof controller !== 'undefined' && controller?.recordRunError) {
    controller.recordRunError(record);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    recordCapturedError(event.message, event.filename, event.lineno, event.colno, event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = typeof reason === 'object' && reason !== null ? (reason.message || String(reason)) : String(reason);
    const source = reason?.fileName || (typeof reason?.stack === 'string' ? (reason.stack.split('\n')[1] || '') : '');
    recordCapturedError(msg, source, reason?.lineNumber || 0, reason?.columnNumber || 0, reason);
  });

  // Test hook: exposed in ?debug=1 only to throw an uncaught error
  const searchParams = new URLSearchParams(window.location.search || '');
  if (searchParams.get('debug') === '1') {
    window.__throwDebugError = (msg = 'Uncaught test error from debug hook') => {
      setTimeout(() => {
        throw new Error(msg);
      }, 0);
    };
  }
}

function getDiagnosticMetadata() {
  let referrerOrigin = '';
  try {
    if (document.referrer) {
      referrerOrigin = new URL(document.referrer).origin;
    }
  } catch { }

  let audioState = 'none';
  try {
    audioState = getAudioState();
  } catch { }

  return {
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    queryString: window.location.search || '',
    userAgent: navigator.userAgent || '',
    buildId: BUILD_ID,
    bestScoreAtRunStart: (typeof controller !== 'undefined' ? controller?.bestScoreAtRunStart : 0) || 0,
    host: window.location.hostname || '',
    embedded: window.self !== window.top,
    referrerOrigin,
    touchPoints: navigator.maxTouchPoints || 0,
    reducedMotion: Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches),
    lang: navigator.language || '',
    soundEnabled: isSoundEnabled(),
    audioState,
    errors: getStoredErrors(),
  };
}

/* -------------------------------------------------------------
 * Dynamic Relic One-Liners (built from real config definitions)
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
    stoneGroupCap: 2,
    forcedRelics: [],
    forceAtMove: 0,
    rewindEvery: 10,
    ascensionAt: 2048,
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
  if (params.has('thresholds')) {
    const raw = params.get('thresholds').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    config.draftThresholds = raw;
  }
  if (params.has('hazard')) {
    const raw = params.get('hazard').split(',').map(s => {
      const v = s.trim();
      if (v === 'Infinity' || v === 'inf') return Infinity;
      const n = parseInt(v, 10);
      return isNaN(n) ? Infinity : n;
    });
    if (raw.length > 0) {
      config.hazardSchedule = raw.map((val, idx) => ({
        upToMove: idx === raw.length - 1 ? Infinity : (idx + 1) * 100,
        interval: val,
      }));
    }
  }
  if (params.has('stones')) {
    const p = parseFloat(params.get('stones'));
    if (!isNaN(p)) {
      if (p <= 0) config.hazardSchedule = [{ upToMove: Infinity, interval: Infinity }];
      else {
        const interval = Math.max(1, Math.round(1 / p));
        config.hazardSchedule = [{ upToMove: Infinity, interval }];
      }
    }
  }
  if (params.has('decay')) {
    const l = parseInt(params.get('decay'), 10);
    if (!isNaN(l) && l > 0) config.stoneLifetime = l;
  }
  if (params.has('nodraft') || params.get('enableDraft') === 'false') {
    config.enableDraft = false;
  }
  if (params.has('relic')) {
    for (const r of params.get('relic').split(',').map(s => s.trim())) {
      if (RELIC_IDS.includes(r)) config.forcedRelics.push(r);
    }
  }
  if (params.has('start')) {
    for (const r of params.get('start').split(',').map(s => s.trim())) {
      if (RELIC_IDS.includes(r)) config.forcedRelics.push(r);
    }
  }
  if (params.has('at')) {
    const m = parseInt(params.get('at'), 10);
    if (!isNaN(m) && m >= 0) config.forceAtMove = m;
  }
  if (params.has('cap')) {
    const c = params.get('cap');
    if (c === 'null' || c === 'none' || c === 'off') config.stoneGroupCap = null;
    else {
      const n = parseInt(c, 10);
      if (!isNaN(n) && n >= 0) config.stoneGroupCap = n;
    }
  }
  if (params.has('rewind')) {
    const rw = parseInt(params.get('rewind'), 10);
    if (!isNaN(rw) && rw > 0) config.rewindEvery = rw;
  }
  if (params.has('siphon')) {
    const s = parseInt(params.get('siphon'), 10);
    if (!isNaN(s) && s > 0) config.siphonMin = s;
  }
  if (params.has('shatter')) {
    const sh = parseInt(params.get('shatter'), 10);
    if (!isNaN(sh) && sh > 0) config.shatterMin = sh;
  }
  if (params.has('ascension')) {
    const raw = (params.get('ascension') || '').trim();
    if (raw === '0' || raw === 'null' || raw === 'off' || raw === 'false') {
      config.ascensionAt = null;
    } else {
      const asc = parseInt(raw, 10);
      if (!isNaN(asc) && asc > 0) config.ascensionAt = asc;
      else config.ascensionAt = null;
    }
  }
  if (params.has('debug')) {
    debug = params.get('debug') === '1' || params.get('debug') === 'true';
  }

  const isRampV2 = params.get('ramp') === 'v2';
  const hintsParam = params.get('hints');

  return { seed, config, debug, isRampV2, hintsParam };
}

/* -------------------------------------------------------------
 * Safe LocalStorage Logging Helpers
 * ------------------------------------------------------------- */
function getPlayerId() {
  try {
    let pid = localStorage.getItem(STORAGE_KEY_PLAYER);
    if (!pid) {
      pid = 'anon_' + Math.random().toString(36).slice(2, 10);
      if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_PLAYER, pid);
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
    if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(trimmed));
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
    if (persistenceEnabled) localStorage.setItem(STORAGE_KEY_BEST, String(score));
  } catch (err) {
    console.warn('LocalStorage best score save failed (storage may be blocked):', err);
  }
}

/* -------------------------------------------------------------
 * Icon Mapping & Popover Tooltips
 * Icons stay as files in game/icons/ (object-fit: contain)
 * ------------------------------------------------------------- */
const ICON_MAP = {
  diagonal_charge: 'icons/diagonal_merge.svg',
  diagonal_merge: 'icons/diagonal_merge.svg',
  diagonal: 'icons/diagonal_merge.svg',
  eraser: 'icons/eraser.svg',
  erase: 'icons/eraser.svg',
  rewind: 'icons/rewind.svg',
  undo: 'icons/rewind.svg',
  fault_line: 'icons/fault_line.svg',
  fault: 'icons/fault_line.svg',
  mason: 'icons/mason.svg',
  siphon: 'icons/siphon.svg',
  shatter: 'icons/shatter.svg',
  last_stand: 'icons/last_stand.svg',
  last: 'icons/last_stand.svg',
};
const warnedMissingIcons = new Set();

function getRelicIconElement(relicId, size = 30) {
  const src = ICON_MAP[relicId];
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.className = 'relic-svg relic-icon-img';
    img.alt = RELIC_NAMES[relicId] || relicId;
    img.setAttribute('data-relic', relicId);
    img.style.objectFit = 'contain';
    img.style.pointerEvents = 'none';
    img.draggable = false;
    return img;
  }
  if (!warnedMissingIcons.has(relicId)) {
    console.warn(`[2048-Rogue] No icon for "${relicId}" -> rendering fallback monogram "[${relicId.slice(0, 2).toUpperCase()}]"`);
    warnedMissingIcons.add(relicId);
  }
  const mono = (relicId.slice(0, 2)).toUpperCase();
  const div = document.createElement('div');
  div.className = 'relic-monogram';
  div.textContent = mono;
  div.style.pointerEvents = 'none';
  return div;
}

let popoverTimeout = null;

function showRelicPopover(relicId, targetEl) {
  if (!relicPopover || !targetEl) return;
  if (popoverTimeout) clearTimeout(popoverTimeout);
  relicPopover.removeAttribute('data-for');

  popoverTitle.textContent = RELIC_NAMES[relicId] || relicId;
  const cfg = (controller && controller.config) ? controller.config : (activeConfig || {});
  popoverDesc.textContent = getRelicOneLiner(relicId, cfg);
  relicPopover.classList.remove('hidden');
  relicPopover.setAttribute('aria-hidden', 'false');

  const rect = targetEl.getBoundingClientRect();
  const popoverWidth = relicPopover.offsetWidth || 240;
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

window.showRelicPopover = showRelicPopover;
window.hideRelicPopover = hideRelicPopover;

function hideRelicPopover() {
  if (!relicPopover) return;
  if (popoverTimeout) clearTimeout(popoverTimeout);
  relicPopover.classList.add('hidden');
  relicPopover.setAttribute('aria-hidden', 'true');
  relicPopover.removeAttribute('data-for');
}

window.addEventListener('click', (e) => {
  if (!relicPopover || relicPopover.classList.contains('hidden')) return;
  if (!e.target.closest('.relic-mini') && !e.target.closest('.relic-passive-item') && !e.target.closest('.ability-btn') && !e.target.closest('#hazard-telegraph') && !e.target.closest('#relic-popover')) {
    hideRelicPopover();
  }
});

/* -------------------------------------------------------------
 * App State & DOM Elements
 * ------------------------------------------------------------- */
const { seed: initialSeed, config: activeConfig, debug: isDebugMode, isRampV2, hintsParam } = parseUrlOptions();
if (isRampV2) {
  document.documentElement.classList.add('ramp-v2');
  if (document.body) document.body.classList.add('ramp-v2');
}
const playerId = getPlayerId();

let controller = null;
let isAnimating = false;
let masonCandidates = null;
let currentRunLog = null;
let activeTargeting = null; // null | { relicId, step: 1|2, selectedCell: number|null }
let slideMismatchCount = 0;
let activeAnimations = [];
let slideAnimTimer = null;
let wasStuck = false;
let uiMoveLog = [];

// DOM elements
const boardEl = document.getElementById('game-board');
const tilesLayer = document.getElementById('tiles-layer');
const ghostLayer = document.getElementById('ghost-layer');
const statScoreEl = document.getElementById('stat-score');
const statMovesEl = document.getElementById('stat-moves');
const statMaxTileEl = document.getElementById('stat-max-tile');
const stoneCountdownEl = document.getElementById('stone-countdown');
const hazardUnitEl = document.getElementById('hazard-unit');
const hazardTelegraphEl = document.getElementById('hazard-telegraph');
const hazardStatusEl = document.getElementById('hazard-status');
const hazardFillEl = document.getElementById('hazard-fill');
const passiveRelicsContainer = document.getElementById('passive-relics-container');
const btnPauseMenu = document.getElementById('btn-pause-menu');
const statusHintBar = document.getElementById('status-hint-bar');
const statusHintText = document.getElementById('status-hint-text');

const abilityBar = document.getElementById('ability-bar');
const targetingBar = document.getElementById('targeting-bar');
const targetingInstruction = document.getElementById('targeting-instruction');
const btnCancelTargeting = document.getElementById('btn-cancel-targeting');
const stuckBanner = document.getElementById('stuck-banner');

const toastContainer = document.getElementById('toast-container');
const lastStandBanner = document.getElementById('last-stand-banner');
const cleanSlateBanner = document.getElementById('clean-slate-banner');
const relicPopover = document.getElementById('relic-popover');
const popoverTitle = document.getElementById('popover-title');
const popoverDesc = document.getElementById('popover-desc');

const startOverlay = document.getElementById('start-overlay');
const startBestScoreEl = document.getElementById('start-best-score');
const btnPlayStart = document.getElementById('btn-play-start');
const btnSoundStart = document.getElementById('btn-sound-start');
const btnStartHow = document.getElementById('btn-start-how');

const draftOverlay = document.getElementById('draft-overlay');
const draftTitleEl = document.getElementById('draft-title');
const draftEyebrowEl = document.getElementById('draft-eyebrow');
const draftOffersRow = document.getElementById('draft-offers-row');
const draftOwnedChips = document.getElementById('draft-owned-chips');
const draftOwnedCount = document.getElementById('draft-owned-count');

const pauseOverlay = document.getElementById('pause-overlay');
const pauseActionsView = document.getElementById('pause-actions-view');
const pauseConfirmView = document.getElementById('pause-confirm-view');
const pauseConfirmEyebrow = document.getElementById('pause-confirm-eyebrow');
const pauseConfirmTitle = document.getElementById('pause-confirm-title');
const pauseConfirmDesc = document.getElementById('pause-confirm-desc');
const btnPauseConfirmExecute = document.getElementById('btn-pause-confirm-execute');
const btnPauseConfirmCancel = document.getElementById('btn-pause-confirm-cancel');
const btnPauseResume = document.getElementById('btn-pause-resume');
const btnPauseRestart = document.getElementById('btn-pause-restart');
const btnPauseEndRun = document.getElementById('btn-pause-end-run');
const btnPauseSound = document.getElementById('btn-pause-sound');
const btnPauseHow = document.getElementById('btn-pause-how');

const endOverlay = document.getElementById('end-overlay');
const endScoreEl = document.getElementById('end-score');
const endNewBestBadge = document.getElementById('end-new-best-badge');
const endMiniBoard = document.getElementById('end-mini-board');
const endMovesEl = document.getElementById('end-moves');
const endMaxTileEl = document.getElementById('end-max-tile');
const endDraftsEl = document.getElementById('end-drafts');
const endSeedEl = document.getElementById('end-seed');
const endTimeEl = document.getElementById('end-time');
const endRelicsList = document.getElementById('end-relics-list');
const btnPlayAgain = document.getElementById('btn-play-again');
const btnCopyLog = document.getElementById('btn-copy-log');
const endCleanSlateChip = document.getElementById('end-clean-slate-chip');

const pauseTimeVal = document.getElementById('pause-time-val');
const bestRunsOverlay = document.getElementById('best-runs-overlay');

const btnPlayDaily = document.getElementById('btn-play-daily');
const dailyDisclosureContainer = document.getElementById('daily-disclosure-container');
const dailyCountdownLine = document.getElementById('daily-countdown-line');
const endLeaderboardStatus = document.getElementById('end-leaderboard-status');
const btnPlayDailyAgain = document.getElementById('btn-play-daily-again');

let dailyRunActive = false;
let dailyRunStartDay = null;
let displayedRunId = null;
let countdownIntervalId = null;

const FORBIDDEN_DAILY_PARAMS = [
  'seed', 'stones', 'start', 'ascension', 'shatter', 'siphon',
  'diag', 'eraser', 'rewind', 'maxcharges', 'cap', 'laststand',
  'pool', 'draft', 'first', 'debug', 'nodraft', 'lab',
  'ramp', 'hints',
];

function canShowDailyButton() {
  if (!window.__LB || !window.__LB.url || !window.__LB.anonKey) return false;
  const sp = new URLSearchParams(window.location.search || '');
  for (const p of FORBIDDEN_DAILY_PARAMS) {
    if (sp.has(p)) return false;
  }
  return true;
}

function getDailyCanonicalConfig() {
  return {
    hazardSchedule: buildHazardSchedule(3),
    draftEveryMoves: 60,
    draftThresholds: [],
    draftPool: [...DEFAULT_POOL],
    enableDraft: true,
    stoneLifetime: null,
    stoneGroupCap: 2,
    forcedRelics: [],
    forceAtMove: 0,
    rewindEvery: 10,
    ascensionAt: 2048,
  };
}

function updateDailyCountdown() {
  if (!dailyCountdownLine) return;
  const now = new Date();
  const ms = msUntilNextUtcMidnight(now);
  dailyCountdownLine.textContent = `New daily in ${formatCountdown(ms)} (resets ${formatNextResetLocalTime(now)})`;
}

function startDailyCountdown() {
  if (countdownIntervalId !== null) return;
  if (!canShowDailyButton()) return;
  updateDailyCountdown();
  countdownIntervalId = setInterval(updateDailyCountdown, 1000);
}

function stopDailyCountdown() {
  if (countdownIntervalId !== null) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }
}

if (typeof window !== 'undefined') {
  window.__testCountdownActive = () => countdownIntervalId !== null;
  window.__testFlushLeaderboardQueue = flushLeaderboardQueue;
}

function flushLeaderboardQueue(targetStatusEl = null, force = false, targetRunId = null) {
  if (!window.__LB || !window.__LB.url || !window.__LB.anonKey) return;
  if (!persistenceEnabled) return;

  const url = window.__LB.url;
  const anonKey = window.__LB.anonKey;
  const devId = getDeviceId(localStorage, persistenceEnabled);
  const activeRunId = targetRunId || displayedRunId;

  flushQueue({
    url,
    anonKey,
    deviceId: devId,
    storage: localStorage,
    persistenceEnabled,
    fetchFn: window.fetch.bind(window),
    clockFn: Date.now,
    force,
    onItemProcessed: async ({ item, res, status }) => {
      // F3: Status bound strictly to the run shown
      if (!item || !activeRunId || item.runId !== activeRunId) {
        return;
      }
      const statusEl = targetStatusEl || document.getElementById('end-leaderboard-status');
      if (!statusEl) return;

      if (status === 'ACCEPTED') {
        try {
          try { localStorage.setItem('rogue2048_has_accepted_run', '1'); } catch { }
          const rankInfo = await getMyDailyRank({
            url,
            anonKey,
            day: item.day,
            deviceId: devId,
            fetchFn: window.fetch.bind(window),
          });
          // F2: No fake rank fallback
          if (rankInfo && typeof rankInfo.rank === 'number' && typeof rankInfo.total_players === 'number') {
            statusEl.textContent = `Submitted · Daily rank #${rankInfo.rank} of ${rankInfo.total_players}`;
            renderGameOverRankingCard(2, {
              rank: rankInfo.rank,
              total: rankInfo.total_players,
              points: item.runLog ? item.runLog.points : 0,
              day: item.day,
            });
          } else {
            statusEl.textContent = 'Submitted';
            renderGameOverRankingCard(3, { day: item.day });
          }
        } catch {
          statusEl.textContent = 'Submitted';
          renderGameOverRankingCard(3, { day: item.day });
        }
      } else if (status === 'VERSION_MISMATCH') {
        statusEl.textContent = 'Saved · leaderboard updating';
        renderGameOverRankingCard(6, { day: item.day });
      } else if (status === 'RETRY') {
        statusEl.textContent = 'Saved · will retry';
        renderGameOverRankingCard(5, { day: item.day });
      } else if (status === 'REJECTED') {
        statusEl.textContent = 'Not accepted';
        renderGameOverRankingCard(7, { day: item.day });
      }
    },
  }).catch(() => { });
}

/* -------------------------------------------------------------
 * Play Time Tracker (Active run time, accumulated from performance.now)
 * ------------------------------------------------------------- */
let activePlayMs = 0;
let lastPerfTime = null;
let isRunActive = false;
let lastDisplayedSecond = -1;
let playTimerInterval = null;

function isTimerAccumulating() {
  if (!isRunActive) return false;
  if (controller && controller.isGameOver()) return false;
  if (startOverlay && !startOverlay.classList.contains('hidden')) return false;
  if (pauseOverlay && !pauseOverlay.classList.contains('hidden')) return false;
  if (bestRunsOverlay && !bestRunsOverlay.classList.contains('hidden')) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  return true;
}

function formatPlayTime(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const secStr = String(secs).padStart(2, '0');
  if (hours > 0) {
    const minStr = String(mins).padStart(2, '0');
    return `${hours}:${minStr}:${secStr}`;
  }
  return `${mins}:${secStr}`;
}

function tickPlayTimer() {
  const now = performance.now();
  if (lastPerfTime !== null && isTimerAccumulating()) {
    const delta = now - lastPerfTime;
    if (delta > 0) {
      activePlayMs += delta;
    }
  }
  lastPerfTime = now;

  const totalSec = Math.floor(activePlayMs / 1000);
  if (totalSec !== lastDisplayedSecond) {
    lastDisplayedSecond = totalSec;
    const formatted = formatPlayTime(activePlayMs);
    if (endTimeEl) endTimeEl.textContent = formatted;
    if (pauseTimeVal) pauseTimeVal.textContent = formatted;
  }
}

function startPlayTimer() {
  if (playTimerInterval) clearInterval(playTimerInterval);
  playTimerInterval = setInterval(tickPlayTimer, 200);
}

const debugPanel = document.getElementById('debug-panel');
const dbgSeedEl = document.getElementById('dbg-seed');
const dbgMoveEl = document.getElementById('dbg-move');
const dbgTileRngEl = document.getElementById('dbg-tile-rng');
const dbgStoneRngEl = document.getElementById('dbg-stone-rng');
const dbgDraftRngEl = document.getElementById('dbg-draft-rng');
const dbgActivationsEl = document.getElementById('dbg-activations');
const dbgSlideSkipsEl = document.getElementById('dbg-slide-skips');

if (isDebugMode) {
  debugPanel.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * Hazard Popover
 * ------------------------------------------------------------- */
function showHazardPopover() {
  if (!relicPopover || !hazardTelegraphEl) return;
  if (popoverTimeout) clearTimeout(popoverTimeout);

  popoverTitle.textContent = 'HAZARD';
  popoverDesc.textContent = 'A permanent stone appears when this reaches 0.';
  relicPopover.classList.remove('hidden');
  relicPopover.setAttribute('aria-hidden', 'false');
  relicPopover.setAttribute('data-for', 'hazard');

  const rect = hazardTelegraphEl.getBoundingClientRect();
  const popoverWidth = relicPopover.offsetWidth || 240;
  let left = rect.left + rect.width / 2 - popoverWidth / 2;
  const viewportWidth = window.innerWidth;
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

if (hazardTelegraphEl) {
  hazardTelegraphEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (relicPopover && !relicPopover.classList.contains('hidden') && relicPopover.getAttribute('data-for') === 'hazard') {
      hideRelicPopover();
    } else {
      showHazardPopover();
    }
  });
}

/* -------------------------------------------------------------
 * First-Time Non-Blocking Hints System
 * ------------------------------------------------------------- */
const HINTS_STORAGE_KEY = '2048_rogue_hints_seen';
let sessionHintsSeen = new Set();
let activeHint = null;
let activeHintTimer = null;

function getSeenHints() {
  try {
    const raw = localStorage.getItem(HINTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch { }
  return sessionHintsSeen;
}

function markHintSeen(hintId) {
  sessionHintsSeen.add(hintId);
  try {
    const seen = getSeenHints();
    seen.add(hintId);
    if (persistenceEnabled) localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify(Array.from(seen)));
  } catch { }
}

function showFirstTimeHint(hintId, text) {
  if (hintsParam === '0') return false;
  if (hintsParam !== '1') {
    const seen = getSeenHints();
    if (seen.has(hintId)) return false;
  } else {
    if (sessionHintsSeen.has(hintId)) return false;
  }
  if (activeTargeting || (statusHintBar && statusHintBar.classList.contains('stuck-warning')) || (controller && controller.state && controller.state.stuckNeedsAbility)) {
    return false;
  }
  markHintSeen(hintId);
  activeHint = { hintId, text };
  if (statusHintText) {
    statusHintText.textContent = text;
  }
  if (activeHintTimer) clearTimeout(activeHintTimer);
  activeHintTimer = setTimeout(() => {
    dismissHint(hintId);
  }, 4000);
  return true;
}

function dismissHint(hintId = null) {
  if (!activeHint) return;
  if (!hintId || activeHint.hintId === hintId) {
    activeHint = null;
    if (activeHintTimer) {
      clearTimeout(activeHintTimer);
      activeHintTimer = null;
    }
    if (!activeTargeting && statusHintBar && !statusHintBar.classList.contains('stuck-warning')) {
      if (statusHintText && !masonCandidates) {
        statusHintText.textContent = 'Swipe to move';
      }
    }
  }
}


/* -------------------------------------------------------------
 * UI Feedback: Toasts & Flashes
 * ------------------------------------------------------------- */
let toastTimer = null;

function showToast(message) {
  let toastEl = document.getElementById('toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    toastContainer.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  toastEl.style.opacity = '1';

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transition = 'opacity 0.2s ease';
  }, 1600);
}

function showLastStandMoment() {
  if (!lastStandBanner) return;
  lastStandBanner.classList.remove('hidden');
  uiMoveLog = []; // clear rewind stack on Last Stand

  const board = boardEl || document.getElementById('game-board');
  const wrapper = lastStandBanner.querySelector('.stand-center-wrapper');
  if (board && wrapper) {
    const bRect = board.getBoundingClientRect();
    const bannerRect = lastStandBanner.getBoundingClientRect();
    wrapper.style.left = `${bRect.left - bannerRect.left}px`;
    wrapper.style.top = `${bRect.top - bannerRect.top}px`;
    wrapper.style.width = `${bRect.width}px`;
    wrapper.style.height = `${bRect.height}px`;
  }

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Impact hits at ~150 ms
  setTimeout(() => {
    playLastStandThud();
    if (!prefersReduced) {
      const boardwrap = document.querySelector('.boardwrap');
      if (boardwrap) {
        boardwrap.classList.add('board-shake');
        setTimeout(() => boardwrap.classList.remove('board-shake'), 140);
      }
      if (wrapper) {
        const ring = document.createElement('div');
        ring.className = 'stand-dust-ring';
        wrapper.appendChild(ring);
        setTimeout(() => ring.remove(), 350);
      }
    }
  }, 150);

  // Total visible duration = IN (240ms) + HOLD (1230ms) + OUT (380ms) = 1850ms
  setTimeout(() => {
    lastStandBanner.classList.add('hidden');
    // Fade out Last Stand passive icon if present in passive strip
    if (passiveRelicsContainer) {
      const lsBtn = passiveRelicsContainer.querySelector('[data-relic="last_stand"]');
      if (lsBtn) {
        lsBtn.style.opacity = '0';
        lsBtn.style.transition = 'opacity 0.4s ease';
        setTimeout(() => {
          if (lsBtn.parentNode) lsBtn.remove();
        }, 400);
      }
    }
  }, 1850);
}

let cleanSlateSequenceState = null;

function spawnShardBurst(centerX, centerY, count = 7, anims = null, timers = null) {
  if (!tilesLayer || count <= 0) return [];
  const shards = [];
  for (let s = 0; s < count; s++) {
    const shard = document.createElement('div');
    shard.className = 'shatter-shard';
    shard.style.left = (centerX - 7) + 'px';
    shard.style.top = (centerY - 7) + 'px';
    tilesLayer.appendChild(shard);
    shards.push(shard);

    const angle = (s / count) * 2 * Math.PI + (Math.random() * 0.4 - 0.2);
    const dist = 20 + Math.random() * 20;
    const rot = Math.random() * 240 - 120;
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist;

    const anim = shard.animate([
      { transform: 'translate(0px, 0px) rotate(0deg)', opacity: 1 },
      { transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg)`, opacity: 0 }
    ], {
      duration: 320,
      easing: 'cubic-bezier(.15, .85, .3, 1)',
      fill: 'forwards'
    });
    if (anims) anims.push(anim);

    const t = setTimeout(() => { if (shard.parentNode) shard.remove(); }, 350);
    if (timers) timers.push(t);
  }
  return shards;
}

function triggerStoneShatterEffect(stoneCell, mergeDest = null, shardCount = 7, anims = null, timers = null) {
  if (!tilesLayer) return;
  const metrics = getGridMetrics();
  const stonePos = getCellCenter(stoneCell, metrics);
  const destPos = mergeDest !== null && mergeDest !== undefined ? getCellCenter(mergeDest, metrics) : stonePos;
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Flash overlay at destroyed stone's cell centre
  const flashEl = document.createElement('div');
  flashEl.className = 'shatter-flash';
  flashEl.style.left = (stonePos.cx - stonePos.width / 2) + 'px';
  flashEl.style.top = (stonePos.cy - stonePos.height / 2) + 'px';
  flashEl.style.width = stonePos.width + 'px';
  flashEl.style.height = stonePos.height + 'px';
  tilesLayer.appendChild(flashEl);
  const tFlash = setTimeout(() => { if (flashEl.parentNode) flashEl.remove(); }, 120);
  if (timers) timers.push(tFlash);

  let stoneEl = tilesLayer.querySelector(`.stone[data-index="${stoneCell}"], .tile.stone[data-index="${stoneCell}"]`);
  if (stoneEl) {
    stoneEl.classList.add('shattering-stone');
  }

  // Short ring pulse at merged tile destination centre if provided
  if (!prefersReduced && mergeDest !== null && mergeDest !== undefined) {
    const pulse = document.createElement('div');
    pulse.className = 'shatter-pulse';
    pulse.style.left = (destPos.cx - destPos.width / 2) + 'px';
    pulse.style.top = (destPos.cy - destPos.height / 2) + 'px';
    pulse.style.width = destPos.width + 'px';
    pulse.style.height = destPos.height + 'px';
    tilesLayer.appendChild(pulse);
    const tPulse = setTimeout(() => { if (pulse.parentNode) pulse.remove(); }, 300);
    if (timers) timers.push(tPulse);
  }

  const centerX = stonePos.cx;
  const centerY = stonePos.cy;

  const tStone = setTimeout(() => {
    if (stoneEl && stoneEl.parentNode) stoneEl.remove();
    if (!prefersReduced && shardCount > 0) {
      spawnShardBurst(centerX, centerY, shardCount, anims, timers);
    }
  }, 60);
  if (timers) timers.push(tStone);
}

let breakSoundCount = 0;
let lastBreakSoundTime = -9999;
function playThrottledBreakSound(isStone) {
  if (breakSoundCount >= 6) return;
  const now = performance.now();
  if (now - lastBreakSoundTime < 60) return;
  lastBreakSoundTime = now;
  breakSoundCount++;
  if (isStone) {
    playShatterCrack();
  } else {
    playEraser();
  }
}

function finishCleanSlateImmediately() {
  if (!cleanSlateSequenceState) return;
  const state = cleanSlateSequenceState;
  cleanSlateSequenceState = null;

  if (state.timers) {
    for (const t of state.timers) clearTimeout(t);
  }
  if (state.anims) {
    for (const a of state.anims) {
      try { a.cancel(); } catch { }
    }
  }
  if (state.ringEl && state.ringEl.parentNode) {
    state.ringEl.remove();
  }
  if (state.dustEls) {
    for (const d of state.dustEls) {
      if (d.parentNode) d.remove();
    }
  }
  if (state.popupEl && state.popupEl.parentNode) {
    state.popupEl.remove();
  }
  if (cleanSlateBanner) {
    cleanSlateBanner.classList.add('hidden');
    const boardwrap = document.querySelector('.boardwrap');
    if (boardwrap) boardwrap.classList.remove('board-shake');
    const wrapper = cleanSlateBanner.querySelector('.stand-center-wrapper');
    if (wrapper) {
      const dustRing = wrapper.querySelector('.stand-dust-ring');
      if (dustRing) dustRing.remove();
    }
  }
  if (tilesLayer) {
    for (const el of tilesLayer.querySelectorAll('.tile-clean-slate-survivor, .tile-clean-slate-charge')) {
      el.classList.remove('tile-clean-slate-survivor', 'tile-clean-slate-charge');
    }
    for (const child of Array.from(tilesLayer.children)) {
      if (child.classList.contains('clean-slate-ring') || child.classList.contains('clean-slate-dust') || child.classList.contains('clean-slate-popup') || child.classList.contains('shatter-shard') || child.classList.contains('shatter-flash') || child.classList.contains('stand-dust-ring')) {
        child.remove();
      }
    }
    const b = controller ? controller.getBoard() : [];
    alignDomToBoard(b, getGridMetrics());
  }

  isAnimating = false;
  currentAnimationState = null;

  syncBoard(controller.getBoard(), state.triggerSite || 'slideFinish');
  updateHeader();
  renderAbilityBar();

  if (typeof state.onComplete === 'function') {
    state.onComplete();
  } else if (controller.isGameOver()) {
    handleGameOver();
  }
}

function triggerCleanSlateSequence({ survivorIndices = [], triggerValue = 2048, payout = 0, triggerSite = 'slideFinish', onComplete = null } = {}) {
  const metrics = getGridMetrics();
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  isAnimating = true;
  breakSoundCount = 0;
  lastBreakSoundTime = -9999;

  const timers = [];
  const anims = [];
  const dustEls = [];

  const stateBeforePayoutScore = controller ? Math.max(0, (controller.getState().points !== undefined ? controller.getState().points : controller.getState().score) - payout) : null;

  const state = {
    timers,
    anims,
    dustEls,
    ringEl: null,
    popupEl: null,
    triggerSite,
    onComplete,
    startTime: performance.now(),
    phase: 'B',
    inputLocked: true,
    prePayoutScore: stateBeforePayoutScore,
    ignoredSwipeCount: 0,
    ignoredAbilityCount: 0,
  };
  cleanSlateSequenceState = state;
  currentAnimationState = {
    commitSlideCompletion: finishCleanSlateImmediately,
    cancelAnimation: finishCleanSlateImmediately,
  };

  // Immediate header sync to show pre-payout score while other HUD values update
  updateHeader();

  const survivorIdx = survivorIndices.length > 0 ? survivorIndices[0] : 0;
  const survivorPos = getCellCenter(survivorIdx, metrics);

  const boardElOrWrap = boardEl || document.getElementById('game-board');
  const bW = boardElOrWrap ? boardElOrWrap.offsetWidth : (metrics.stepX * 3 + metrics.cellW);
  const bH = boardElOrWrap ? boardElOrWrap.offsetHeight : (metrics.stepY * 3 + metrics.cellH);
  const maxCornerDist = Math.max(
    Math.hypot(survivorPos.cx, survivorPos.cy),
    Math.hypot(bW - survivorPos.cx, survivorPos.cy),
    Math.hypot(survivorPos.cx, bH - survivorPos.cy),
    Math.hypot(bW - survivorPos.cx, bH - survivorPos.cy)
  );

  // Identify elements to destroy
  const ascThreshold = controller?.config?.ascensionAt || 2048;
  const elementsToDestroy = [];
  if (tilesLayer) {
    for (const child of Array.from(tilesLayer.children)) {
      if (child.classList.contains('clean-slate-ring') || child.classList.contains('clean-slate-popup') || child.classList.contains('shatter-shard') || child.classList.contains('shatter-flash') || child.classList.contains('stand-dust-ring')) continue;
      const idxAttr = child.getAttribute('data-index');
      if (idxAttr === null) continue;
      const idx = parseInt(idxAttr, 10);
      if (isNaN(idx)) continue;

      const isStone = child.classList.contains('stone');
      const val = isStone ? STONE : parseInt(child.getAttribute('data-val'), 10);
      const isSurvivor = survivorIndices.includes(idx) || (typeof val === 'number' && val >= ascThreshold);
      if (!isSurvivor) {
        const cellCenter = getCellCenter(idx, metrics);
        const dist = Math.hypot(cellCenter.cx - survivorPos.cx, cellCenter.cy - survivorPos.cy);
        elementsToDestroy.push({
          el: child,
          index: idx,
          isStone,
          val,
          dist,
          cx: cellCenter.cx,
          cy: cellCenter.cy,
        });
      }
    }
  }

  // Sort by distance from survivor
  elementsToDestroy.sort((a, b) => a.dist - b.dist);

  // Shared particle cap: total concurrent DOM particles <= 80
  const shardsPerElement = Math.max(2, Math.min(7, Math.floor(80 / Math.max(1, elementsToDestroy.length))));

  // =========================================================================
  // REDUCED MOTION CEREMONY (S3)
  // =========================================================================
  if (prefersReduced) {
    if (cleanSlateBanner) {
      const bannerTitle = document.getElementById('clean-slate-title');
      if (bannerTitle) bannerTitle.textContent = String(triggerValue);
      const subtitleEl = cleanSlateBanner.querySelector('.stand-subtitle') || document.getElementById('clean-slate-subtitle');
      let tagline = 'Clean Slate';
      if (triggerValue === 2048) tagline = 'We Won';
      else if (triggerValue >= 4096) tagline = 'Touch Grass';
      if (subtitleEl) subtitleEl.textContent = tagline;

      cleanSlateBanner.classList.remove('hidden');
      const wrapper = cleanSlateBanner.querySelector('.stand-center-wrapper');
      const board = boardEl || document.getElementById('game-board');
      if (board && wrapper) {
        const bRect = board.getBoundingClientRect();
        const bannerRect = cleanSlateBanner.getBoundingClientRect();
        wrapper.style.left = `${bRect.left - bannerRect.left}px`;
        wrapper.style.top = `${bRect.top - bannerRect.top}px`;
        wrapper.style.width = `${bRect.width}px`;
        wrapper.style.height = `${bRect.height}px`;
      }

      // Static banner for ~1.4 s
      timers.push(setTimeout(() => {
        cleanSlateBanner.classList.add('hidden');

        // Fade elements out simultaneously in <= 150 ms (120 ms)
        for (const item of elementsToDestroy) {
          const fadeAnim = item.el.animate([
            { opacity: 1 },
            { opacity: 0 }
          ], { duration: 120, fill: 'forwards' });
          anims.push(fadeAnim);
          timers.push(setTimeout(() => {
            if (item.el.parentNode) item.el.remove();
          }, 120));
        }

        // Payout popup and HUD update right after elements fade
        timers.push(setTimeout(() => {
          state.phase = 'F';
          state.inputLocked = false;
          state.prePayoutScore = null;
          updateHeader();

          if (payout > 0 && tilesLayer) {
            const popup = document.createElement('div');
            popup.className = 'clean-slate-popup';
            popup.textContent = `+${payout.toLocaleString('en-US')}`;
            popup.style.left = survivorPos.cx + 'px';
            popup.style.top = (survivorPos.cy - metrics.cellH * 0.35) + 'px';
            tilesLayer.appendChild(popup);
            state.popupEl = popup;
            timers.push(setTimeout(() => {
              if (popup.parentNode) popup.remove();
              if (state.popupEl === popup) state.popupEl = null;
            }, 800));
          }
        }, 130));

        // Finish ceremony naturally in <= 1.8 s total
        timers.push(setTimeout(() => {
          finishCleanSlateNaturally();
        }, 160));

      }, 1350));
    }
    return;
  }

  // =========================================================================
  // NORMAL CEREMONY (S1 Phases B, C, D, E, F)
  // =========================================================================

  // --- Phase B: BANNER STAMP (T = 0 to 1850 ms) ---
  state.phase = 'B';
  if (cleanSlateBanner) {
    const bannerTitle = document.getElementById('clean-slate-title');
    if (bannerTitle) bannerTitle.textContent = String(triggerValue);
    const subtitleEl = cleanSlateBanner.querySelector('.stand-subtitle') || document.getElementById('clean-slate-subtitle');
    let tagline = 'Clean Slate';
    if (triggerValue === 2048) tagline = 'We Won';
    else if (triggerValue >= 4096) tagline = 'Touch Grass';
    if (subtitleEl) subtitleEl.textContent = tagline;

    cleanSlateBanner.classList.remove('hidden');
    const wrapper = cleanSlateBanner.querySelector('.stand-center-wrapper');
    const board = boardEl || document.getElementById('game-board');
    if (board && wrapper) {
      const bRect = board.getBoundingClientRect();
      const bannerRect = cleanSlateBanner.getBoundingClientRect();
      wrapper.style.left = `${bRect.left - bannerRect.left}px`;
      wrapper.style.top = `${bRect.top - bannerRect.top}px`;
      wrapper.style.width = `${bRect.width}px`;
      wrapper.style.height = `${bRect.height}px`;
    }
    /*DEV_LAB_BEGIN*/
    if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
      const bTitle = document.getElementById('clean-slate-title');
      if (bTitle) {
        const bAnim = bTitle.animate([{ opacity: 1 }, { opacity: 1 }], { duration: 1850 });
        anims.push(bAnim);
      }
      window.__ROGUE_LAB_API__.onPhase('banner', { state, triggerValue });
    }
    /*DEV_LAB_END*/

    // Impact hits at ~150 ms (same as Last Stand stamp)
    timers.push(setTimeout(() => {
      playLastStandThud();
      const boardwrap = document.querySelector('.boardwrap');
      if (boardwrap) {
        boardwrap.classList.add('board-shake');
        timers.push(setTimeout(() => boardwrap.classList.remove('board-shake'), 140));
      }
      if (wrapper) {
        const dustRing = document.createElement('div');
        dustRing.className = 'stand-dust-ring';
        wrapper.appendChild(dustRing);
        timers.push(setTimeout(() => { if (dustRing.parentNode) dustRing.remove(); }, 350));
      }
    }, 150));

    // Exit at 1850 ms (IN 240 + HOLD 1230 + OUT 380)
    timers.push(setTimeout(() => {
      cleanSlateBanner.classList.add('hidden');
    }, 1850));
  }

  // --- Phase C: CHARGE-UP (~450 ms, starts ~150 ms after banner has fully exited: T = 2000 to 2450 ms) ---
  timers.push(setTimeout(() => {
    state.phase = 'C';
    for (const sIdx of survivorIndices) {
      const el = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${sIdx}"]`) : null;
      if (el) el.classList.add('tile-clean-slate-charge');
    }
    /*DEV_LAB_BEGIN*/
    if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
      for (const sIdx of survivorIndices) {
        const el = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${sIdx}"]`) : null;
        if (el) {
          const cAnim = el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 450 });
          anims.push(cAnim);
        }
      }
      window.__ROGUE_LAB_API__.onPhase('charge', { state });
    }
    /*DEV_LAB_END*/
    playCleanSlateShimmer();
  }, 2000));

  // --- Phase D & E: SHOCKWAVE RING & RING-DRIVEN BREAKS (starts at T = 2450 ms) ---
  timers.push(setTimeout(() => {
    state.phase = 'D';

    // Glow ends the moment ring starts
    if (tilesLayer) {
      for (const el of tilesLayer.querySelectorAll('.tile-clean-slate-charge')) {
        el.classList.remove('tile-clean-slate-charge');
      }
    }

    playCleanSlateThud();

    // D) Shockwave Ring: ~700 ms ease-out, gold, peak opacity >= 0.7, border >= 3px
    if (tilesLayer) {
      const ring = document.createElement('div');
      ring.className = 'clean-slate-ring';
      ring.id = 'clean-slate-ring';
      ring.style.left = survivorPos.cx + 'px';
      ring.style.top = survivorPos.cy + 'px';
      ring.style.width = (maxCornerDist * 2) + 'px';
      ring.style.height = (maxCornerDist * 2) + 'px';
      ring.style.marginLeft = (-maxCornerDist) + 'px';
      ring.style.marginTop = (-maxCornerDist) + 'px';
      tilesLayer.appendChild(ring);
      state.ringEl = ring;

      const ringKeyframes = [];
      for (let k = 0; k <= 35; k++) {
        const u = k / 35;
        const scale = 1 - Math.pow(1 - u, 2);
        const opacity = u < 0.65 ? (0.88 - u * 0.15) : Math.max(0, (1 - u) * 2.0);
        ringKeyframes.push({ transform: `scale(${scale})`, opacity, offset: u });
      }
      const ringAnim = ring.animate(ringKeyframes, {
        duration: 700,
        fill: 'forwards',
      });
      anims.push(ringAnim);
      /*DEV_LAB_BEGIN*/
      if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
        window.__ROGUE_LAB_API__.onPhase('ring', { state, ringAnim });
      }
      /*DEV_LAB_END*/

      timers.push(setTimeout(() => {
        if (ring.parentNode) ring.remove();
        if (state.ringEl === ring) state.ringEl = null;
      }, 710));
    }
  }, 2450));

  // E) Ring-Driven Breaks: every element breaks when ring front reaches its centre
  // Easing inversion: u = 1 - sqrt(1 - r / Rmax), t_break = 2450 + 700 * u
  let lastBreakStartTime = 2450;

  for (const item of elementsToDestroy) {
    const normDist = Math.min(1, Math.max(0, item.dist / maxCornerDist));
    const u = 1 - Math.sqrt(1 - normDist);
    const delayFromRing = Math.round(700 * u);
    const breakTime = 2450 + delayFromRing;
    if (breakTime > lastBreakStartTime) {
      lastBreakStartTime = breakTime;
    }

    timers.push(setTimeout(() => {
      state.phase = 'E';
      /*DEV_LAB_BEGIN*/
      if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
        window.__ROGUE_LAB_API__.onPhase('breaks', { state, item });
      }
      /*DEV_LAB_END*/
      playThrottledBreakSound(item.isStone);

      if (item.isStone) {
        triggerStoneShatterEffect(item.index, null, shardsPerElement, anims, timers);
      } else {
        flashCellVanish(item.index);
        const fadeAnim = item.el.animate([
          { opacity: 1, transform: `${item.el.style.transform} scale(1)` },
          { opacity: 0, transform: `${item.el.style.transform} scale(0.6)` }
        ], {
          duration: 180,
          easing: 'ease-out',
          fill: 'forwards'
        });
        anims.push(fadeAnim);
        spawnShardBurst(item.cx, item.cy, shardsPerElement, anims, timers);
        timers.push(setTimeout(() => {
          if (item.el.parentNode) item.el.remove();
        }, 180));
      }
    }, breakTime));
  }

  // --- Phase F: PAYOUT (+N popup and HUD score update right after last break starts) ---
  const payoutTime = Math.max(2450, lastBreakStartTime + 10);
  timers.push(setTimeout(() => {
    state.phase = 'F';
    /*DEV_LAB_BEGIN*/
    if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
      window.__ROGUE_LAB_API__.onPhase('payout', { state, payout });
    }
    /*DEV_LAB_END*/
    state.prePayoutScore = null;
    updateHeader();

    if (payout > 0 && tilesLayer) {
      const popup = document.createElement('div');
      popup.className = 'clean-slate-popup';
      popup.textContent = `+${payout.toLocaleString('en-US')}`;
      popup.style.left = survivorPos.cx + 'px';
      popup.style.top = (survivorPos.cy - metrics.cellH * 0.35) + 'px';
      tilesLayer.appendChild(popup);
      state.popupEl = popup;
      timers.push(setTimeout(() => {
        if (popup.parentNode) popup.remove();
        if (state.popupEl === popup) state.popupEl = null;
      }, 1000));
    }
  }, payoutTime));

  // Release input lock after last break finishes
  const lastBreakFinishTime = Math.max(2450, lastBreakStartTime + 180);
  timers.push(setTimeout(() => {
    state.inputLocked = false;
  }, lastBreakFinishTime));

  // Complete ceremony naturally: total ceremony duration <= ~3.6s
  const totalCeremonyDuration = Math.max(3200, Math.min(3550, lastBreakFinishTime + 80));
  timers.push(setTimeout(() => {
    finishCleanSlateNaturally();
  }, totalCeremonyDuration));

  function finishCleanSlateNaturally() {
    if (!cleanSlateSequenceState) return;
    cleanSlateSequenceState = null;
    currentAnimationState = null;
    isAnimating = false;
    /*DEV_LAB_BEGIN*/
    if (typeof window !== 'undefined' && window.__ROGUE_LAB_API__) {
      window.__ROGUE_LAB_API__.onPhase('end', { state });
    }
    /*DEV_LAB_END*/

    if (cleanSlateBanner) cleanSlateBanner.classList.add('hidden');
    if (tilesLayer) {
      for (const el of tilesLayer.querySelectorAll('.tile-clean-slate-survivor, .tile-clean-slate-charge')) {
        el.classList.remove('tile-clean-slate-survivor', 'tile-clean-slate-charge');
      }
      for (const child of Array.from(tilesLayer.children)) {
        if (child.classList.contains('clean-slate-ring') || child.classList.contains('clean-slate-dust') || child.classList.contains('clean-slate-popup') || child.classList.contains('shatter-shard') || child.classList.contains('shatter-flash') || child.classList.contains('stand-dust-ring')) {
          child.remove();
        }
      }
      const b = controller ? controller.getBoard() : [];
      alignDomToBoard(b, getGridMetrics());
    }

    syncBoard(controller.getBoard(), triggerSite);
    updateHeader();
    renderAbilityBar();

    if (typeof onComplete === 'function') {
      onComplete();
    } else if (controller.isGameOver()) {
      handleGameOver();
    }
  }
}

function triggerStuckWave() {
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced && boardEl) {
    const wave = document.createElement('div');
    wave.className = 'stuck-impact-wave';
    boardEl.appendChild(wave);
    setTimeout(() => wave.remove(), 500);
  }
}


function performBlockedNudge(direction) {
  if (!tilesLayer) return;
  const dx = direction === 'L' ? -4 : (direction === 'R' ? 4 : 0);
  const dy = direction === 'U' ? -4 : (direction === 'D' ? 4 : 0);

  const elements = Array.from(tilesLayer.querySelectorAll('.tile, .stone'));
  const metrics = getGridMetrics();

  for (const el of elements) {
    const idx = parseInt(el.getAttribute('data-index'), 10);
    const trans = getTileTranslate(idx, metrics);
    const baseX = trans.x;
    const baseY = trans.y;

    el.animate([
      { transform: `translate3d(${baseX}px, ${baseY}px, 0)`, easing: 'ease-out', offset: 0 },
      { transform: `translate3d(${baseX + dx}px, ${baseY + dy}px, 0)`, easing: 'ease-out', offset: 0.45 },
      { transform: `translate3d(${baseX}px, ${baseY}px, 0)`, offset: 1 }
    ], {
      duration: 200,
      fill: 'none'
    });
  }
}

function animateStoneSpawn(cellIndex) {
  if (!tilesLayer) return;
  const metrics = getGridMetrics();
  const stoneEl = tilesLayer.querySelector(`.stone[data-index="${cellIndex}"], .tile.stone[data-index="${cellIndex}"]`);
  if (!stoneEl) return;
  const face = stoneEl.querySelector('.tile-face') || stoneEl;

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    playStone();
    return;
  }

  // Drop animation: scale 1.45 -> 1.0, opacity 0 -> 1 over ~180ms ease-in
  face.animate([
    { transform: 'scale(1.45)', opacity: 0 },
    { transform: 'scale(1.0)', opacity: 1 }
  ], {
    duration: 180,
    easing: 'ease-in',
    fill: 'forwards'
  });

  // Impact hits at 180ms
  setTimeout(() => {
    playStone();

    const cellPos = getCellCenter(cellIndex, metrics);

    // Ring pulse in dark colour (~280 ms)
    const ring = document.createElement('div');
    ring.className = 'stone-impact-ring';
    ring.style.left = (cellPos.cx - cellPos.width / 2) + 'px';
    ring.style.top = (cellPos.cy - cellPos.height / 2) + 'px';
    ring.style.width = cellPos.width + 'px';
    ring.style.height = cellPos.height + 'px';
    tilesLayer.appendChild(ring);
    setTimeout(() => { if (ring.parentNode) ring.remove(); }, 290);

    // 6 dust specks (3-5 px) drifting 10-22 px outward and fading
    for (let i = 0; i < 6; i++) {
      const speck = document.createElement('div');
      speck.className = 'stone-dust-speck';
      const size = 3 + Math.random() * 2;
      speck.style.width = size + 'px';
      speck.style.height = size + 'px';
      speck.style.left = (cellPos.cx - size / 2) + 'px';
      speck.style.top = (cellPos.cy - size / 2) + 'px';
      tilesLayer.appendChild(speck);

      const angle = (i / 6) * 2 * Math.PI + (Math.random() * 0.4 - 0.2);
      const dist = 10 + Math.random() * 12;
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist;

      speck.animate([
        { transform: 'translate(0, 0)', opacity: 0.9 },
        { transform: `translate(${tx}px, ${ty}px)`, opacity: 0 }
      ], {
        duration: 280,
        easing: 'ease-out',
        fill: 'forwards'
      });
      setTimeout(() => { if (speck.parentNode) speck.remove(); }, 300);
    }

    // 3 px nudge of board wrapper (~120 ms)
    const boardwrap = document.querySelector('.boardwrap');
    if (boardwrap) {
      boardwrap.animate([
        { transform: 'translate(0, 0)' },
        { transform: 'translate(0, 3px)' },
        { transform: 'translate(0, 0)' }
      ], {
        duration: 120,
        easing: 'ease-out'
      });
    }
  }, 180);
}

function triggerShatterAnimation(mergeDestinations, boardBefore, boardAfter) {
  if (!tilesLayer) return;
  const destroyedCells = [];
  for (let i = 0; i < 16; i++) {
    if (boardBefore[i] === STONE && boardAfter[i] !== STONE) {
      const r = Math.floor(i / 4);
      const c = i % 4;
      const neighbors = [];
      if (r > 0) neighbors.push((r - 1) * 4 + c);
      if (r < 3) neighbors.push((r + 1) * 4 + c);
      if (c > 0) neighbors.push(r * 4 + (c - 1));
      if (c < 3) neighbors.push(r * 4 + (c + 1));

      const shatterThreshold = controller?.state?.config?.shatterMin ?? controller?.config?.shatterMin ?? activeConfig?.shatterMin ?? 64;
      const touchingDest = (mergeDestinations || []).find(d => neighbors.includes(d)) ??
        neighbors.find(n => typeof boardAfter[n] === 'number' && boardAfter[n] >= shatterThreshold) ??
        neighbors[0];
      if (!destroyedCells.some(d => d.stoneCell === i)) {
        destroyedCells.push({ stoneCell: i, mergeDest: touchingDest });
      }
    }
  }

  if (destroyedCells.length === 0) return;

  playShatterCrack();

  for (const { stoneCell, mergeDest } of destroyedCells) {
    triggerStoneShatterEffect(stoneCell, mergeDest, 7);
  }
}

function flashCellVanish(cellIndex) {
  const tileEl = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${cellIndex}"]`) : null;
  if (!tileEl) return;
  tileEl.classList.add('erasing');
  setTimeout(() => tileEl.classList.remove('erasing'), 270);
}

function flashCellMergePop(cellIndex) {
  const tileEl = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${cellIndex}"]`) : null;
  if (tileEl) {
    const face = tileEl.querySelector('.tile-face');
    if (face) {
      face.animate([
        { transform: 'scale(1)', offset: 0 },
        { transform: 'scale(1.16)', offset: 0.45, easing: 'ease-out' },
        { transform: 'scale(1)', offset: 1, easing: 'ease-out' }
      ], { duration: 140, easing: 'ease-out' });
    }
  }
}

/* -------------------------------------------------------------
 * Board Rendering (Persistent DOM Tile Elements)
 * ------------------------------------------------------------- */
window.__syncBoardCorrections = 0;
window.__correctionsByCallSite = {
  slideFinish: 0,
  interrupt: 0,
  rewind: 0,
  'rewind-swap': 0,
  'rewind-cell-swap': 0,
  ability: 0,
  'decision-resolve': 0,
  'draft-resolve': 0,
  setup: 0,
  resync: 0,
  initialRender: 0,
  other: 0,
};
let nextTileId = 1;

function getGridMetrics() {
  if (!boardEl || !tilesLayer) return { stepX: 0, stepY: 0, cellW: 0, cellH: 0, originX: 0, originY: 0 };
  const cells = boardEl.querySelectorAll('.cell');
  if (!cells || cells.length !== 16) return { stepX: 0, stepY: 0, cellW: 0, cellH: 0, originX: 0, originY: 0 };
  const c0 = cells[0].getBoundingClientRect();
  const c1 = cells[1].getBoundingClientRect();
  const c4 = cells[4].getBoundingClientRect();
  const layerRect = tilesLayer.getBoundingClientRect();
  const stepX = c1.left - c0.left;
  const stepY = c4.top - c0.top;
  const cellW = c0.width;
  const cellH = c0.height;
  const originX = c0.left - layerRect.left;
  const originY = c0.top - layerRect.top;
  return { stepX, stepY, cellW, cellH, originX, originY };
}

function getTileTranslate(index, metrics = getGridMetrics()) {
  const col = index % 4;
  const row = Math.floor(index / 4);
  const x = Math.round((metrics.originX + col * metrics.stepX) * 100) / 100;
  const y = Math.round((metrics.originY + row * metrics.stepY) * 100) / 100;
  return { x, y, transform: `translate3d(${x}px, ${y}px, 0)` };
}

function getCellCenter(index, metrics = getGridMetrics()) {
  const trans = getTileTranslate(index, metrics);
  const cx = Math.round((trans.x + metrics.cellW / 2) * 100) / 100;
  const cy = Math.round((trans.y + metrics.cellH / 2) * 100) / 100;
  return { cx, cy, x: trans.x, y: trans.y, width: metrics.cellW, height: metrics.cellH };
}

function getTileClasses(val) {
  if (val === STONE) return 'stone tile-stone';
  const cls = val <= 8192 ? `tile-${val}` : 'tile-8192';
  const vCls = `v${val >= 4096 ? 4096 : val}`;
  const compactCls = val >= 1024 ? 'compact' : '';
  return `${cls} ${vCls} ${compactCls}`.trim();
}

function createTileElement(index, val, isSpawn = false, metrics = getGridMetrics()) {
  const el = document.createElement('div');
  const id = nextTileId++;
  el.id = `tile-${id}`;
  el.setAttribute('data-tile-id', String(id));
  el.setAttribute('data-tid', String(id));
  el.setAttribute('data-index', String(index));

  const trans = getTileTranslate(index, metrics);
  el.style.width = metrics.cellW + 'px';
  el.style.height = metrics.cellH + 'px';
  el.style.transform = trans.transform;
  el.style.opacity = '1';

  const face = document.createElement('div');

  if (val === STONE) {
    el.className = 'tile stone tile-stone';
    el.setAttribute('data-val', 'S');
    el.setAttribute('aria-label', 'Permanent stone');
    face.className = 'tile-face stone-face';
  } else {
    el.className = `tile ${getTileClasses(val)}`;
    el.setAttribute('data-val', String(val));
    el.setAttribute('aria-label', `Tile ${val}`);
    face.className = `tile-face ${getTileClasses(val)}`;
    face.textContent = val;
    if (isSpawn) {
      face.classList.add('tile-spawn');
    }
  }

  el.appendChild(face);
  return el;
}

function alignDomToBoard(board, metrics = getGridMetrics()) {
  if (!boardEl || !tilesLayer) return;
  const existingTiles = Array.from(tilesLayer.children).filter(el =>
    (el.classList.contains('tile') || el.classList.contains('stone')) &&
    !el.classList.contains('shattering-stone')
  );

  const byIndex = new Map();
  for (let i = 0; i < 16; i++) byIndex.set(i, []);
  for (const el of existingTiles) {
    el.classList.remove('duplicate');
    const idx = parseInt(el.getAttribute('data-index'), 10);
    if (!isNaN(idx) && idx >= 0 && idx < 16) {
      byIndex.get(idx).push(el);
    } else {
      el.remove();
    }
  }

  for (let i = 0; i < 16; i++) {
    const expectedVal = board[i];
    const elementsAtI = byIndex.get(i);
    const expectedTrans = getTileTranslate(i, metrics);

    if (expectedVal === 0) {
      for (const el of elementsAtI) el.remove();
    } else if (expectedVal === STONE) {
      for (const el of elementsAtI.filter(el => !el.classList.contains('stone'))) el.remove();
      const stones = elementsAtI.filter(el => el.classList.contains('stone'));
      if (stones.length === 0) {
        const newStone = createTileElement(i, STONE, false, metrics);
        tilesLayer.appendChild(newStone);
      } else {
        for (let sIdx = 1; sIdx < stones.length; sIdx++) stones[sIdx].remove();
        const stone = stones[0];
        stone.setAttribute('data-val', 'S');
        stone.setAttribute('data-index', String(i));
        stone.style.width = metrics.cellW + 'px';
        stone.style.height = metrics.cellH + 'px';
        stone.style.transform = expectedTrans.transform;
        stone.style.opacity = '1';
        if (typeof stone.getAnimations === 'function') {
          for (const a of stone.getAnimations()) try { a.cancel(); } catch { }
        }
      }
    } else if (typeof expectedVal === 'number' && expectedVal > 0) {
      for (const el of elementsAtI.filter(el => el.classList.contains('stone'))) el.remove();
      const tiles = elementsAtI.filter(el => !el.classList.contains('stone'));
      if (tiles.length === 0) {
        const newTile = createTileElement(i, expectedVal, false, metrics);
        tilesLayer.appendChild(newTile);
      } else {
        for (let tIdx = 1; tIdx < tiles.length; tIdx++) tiles[tIdx].remove();
        const tile = tiles[0];
        tile.setAttribute('data-val', String(expectedVal));
        tile.setAttribute('data-index', String(i));
        tile.className = `tile ${getTileClasses(expectedVal)}`;
        let face = tile.querySelector('.tile-face');
        if (!face) {
          face = document.createElement('div');
          tile.appendChild(face);
        }
        face.className = `tile-face ${getTileClasses(expectedVal)}`;
        face.textContent = expectedVal;
        tile.style.width = metrics.cellW + 'px';
        tile.style.height = metrics.cellH + 'px';
        tile.style.transform = expectedTrans.transform;
        tile.style.opacity = '1';
        if (typeof tile.getAnimations === 'function') {
          for (const a of tile.getAnimations()) try { a.cancel(); } catch { }
        }
        if (typeof face.getAnimations === 'function') {
          for (const a of face.getAnimations()) try { a.cancel(); } catch { }
        }
      }
    }
  }
}

function syncBoard(board = (controller ? controller.getBoard() : []), callSite = 'other') {
  if (callSite === 'rewind-cell-swap') return;
  if (!boardEl || !tilesLayer) return;
  const cells = boardEl.querySelectorAll('.cell');
  if (!cells || cells.length !== 16) return;

  let corrections = 0;
  const metrics = getGridMetrics();

  // (1) Invariant: no .cell contains any tile or stone element
  for (let i = 0; i < 16; i++) {
    const cell = cells[i];
    cell.classList.remove('sliding');
    if (!activeTargeting) {
      cell.classList.remove('selected', 'valid', 'candidate', 'dim', 'erasable', 'mason', 'diag-persist', 'erasing');
    }
    const children = Array.from(cell.children);
    if (children.length > 0) {
      corrections += children.length;
      for (const ch of children) ch.remove();
    }
  }

  // (2) Stray elements directly inside boardEl (outside tilesLayer)
  const strays = boardEl.querySelectorAll(':scope > .tile, :scope > .stone, :scope > .tile-stone');
  for (const s of strays) {
    s.remove();
    corrections++;
  }

  // (3) Reconcile tiles in #tiles-layer
  const existingTiles = Array.from(tilesLayer.children).filter(el =>
    (el.classList.contains('tile') || el.classList.contains('stone')) &&
    !el.classList.contains('shattering-stone')
  );

  const byIndex = new Map();
  for (let i = 0; i < 16; i++) byIndex.set(i, []);
  for (const el of existingTiles) {
    const idx = parseInt(el.getAttribute('data-index'), 10);
    if (!isNaN(idx) && idx >= 0 && idx < 16) {
      byIndex.get(idx).push(el);
    } else {
      el.remove();
      corrections++;
    }
  }

  for (let i = 0; i < 16; i++) {
    const expectedVal = board[i];
    const elementsAtI = byIndex.get(i);
    const expectedTrans = getTileTranslate(i, metrics);

    if (expectedVal === 0) {
      if (elementsAtI.length > 0) {
        corrections += elementsAtI.length;
        for (const el of elementsAtI) el.remove();
      }
      cells[i].setAttribute('aria-label', `Empty cell ${i + 1}`);
    } else if (expectedVal === STONE) {
      cells[i].setAttribute('aria-label', 'Permanent stone');
      const stones = elementsAtI.filter(el => el.classList.contains('stone'));
      const nonStones = elementsAtI.filter(el => !el.classList.contains('stone'));
      if (nonStones.length > 0) {
        corrections += nonStones.length;
        for (const el of nonStones) el.remove();
      }
      if (stones.length === 0) {
        corrections++;
        const newStone = createTileElement(i, STONE, false, metrics);
        tilesLayer.appendChild(newStone);
      } else {
        if (stones.length > 1) {
          corrections += (stones.length - 1);
          for (let sIdx = 1; sIdx < stones.length; sIdx++) stones[sIdx].remove();
        }
        const stone = stones[0];
        stone.setAttribute('data-val', 'S');
        stone.setAttribute('data-index', String(i));
        stone.style.width = metrics.cellW + 'px';
        stone.style.height = metrics.cellH + 'px';
        stone.style.transform = expectedTrans.transform;
        stone.style.opacity = '1';
        if (typeof stone.getAnimations === 'function') {
          for (const a of stone.getAnimations()) a.cancel();
        }
      }
    } else if (typeof expectedVal === 'number' && expectedVal > 0) {
      cells[i].setAttribute('aria-label', `Tile ${expectedVal}`);
      const tiles = elementsAtI.filter(el => !el.classList.contains('stone'));
      const stones = elementsAtI.filter(el => el.classList.contains('stone'));
      if (stones.length > 0) {
        corrections += stones.length;
        for (const el of stones) el.remove();
      }
      if (tiles.length === 0) {
        corrections++;
        const newTile = createTileElement(i, expectedVal, false, metrics);
        tilesLayer.appendChild(newTile);
      } else {
        if (tiles.length > 1) {
          corrections += (tiles.length - 1);
          for (let tIdx = 1; tIdx < tiles.length; tIdx++) tiles[tIdx].remove();
        }
        const tile = tiles[0];
        const curVal = tile.getAttribute('data-val');
        let face = tile.querySelector('.tile-face');
        if (!face) {
          face = document.createElement('div');
          tile.appendChild(face);
        }
        const curText = face.textContent.trim();
        if (curVal !== String(expectedVal) || curText !== String(expectedVal)) {
          corrections++;
          tile.setAttribute('data-val', String(expectedVal));
          face.textContent = expectedVal;
        }
        tile.className = `tile ${getTileClasses(expectedVal)}`;
        face.className = `tile-face ${getTileClasses(expectedVal)}`;
        tile.setAttribute('data-index', String(i));
        tile.style.width = metrics.cellW + 'px';
        tile.style.height = metrics.cellH + 'px';
        tile.style.transform = expectedTrans.transform;
        tile.style.opacity = '1';
        if (typeof tile.getAnimations === 'function') {
          for (const a of tile.getAnimations()) a.cancel();
        }
        if (typeof face.getAnimations === 'function') {
          for (const a of face.getAnimations()) a.cancel();
        }
      }
    }
  }

  if (corrections > 0) {
    if (callSite === 'initialRender') {
      window.__correctionsByCallSite.initialRender = (window.__correctionsByCallSite.initialRender || 0) + corrections;
    } else {
      window.__syncBoardCorrections = (window.__syncBoardCorrections || 0) + corrections;
      if (callSite in window.__correctionsByCallSite) {
        window.__correctionsByCallSite[callSite] += corrections;
      } else {
        window.__correctionsByCallSite[callSite] = (window.__correctionsByCallSite[callSite] || 0) + corrections;
      }
    }
  }

  if (activeTargeting) {
    highlightTargetingBoard();
  }
}

function renderBoard(board = (controller ? controller.getBoard() : [])) {
  syncBoard(board, 'renderBoard');
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

function getMovesToNextDraft() {
  if (!controller || !controller.state) return null;
  const state = controller.state;
  if (state.config.enableDraft === false) return null;

  // Check if draft pool is exhausted
  const pool = state.config.draftPool || RELIC_IDS;
  const owned = state.relics || new Set();
  let availableCount = 0;
  for (const r of pool) {
    if (!owned.has(r)) availableCount++;
  }
  if (availableCount === 0) return null;

  const move = state.moveCount || 0;
  const firstAt = state.config.draftFirstAt;
  const every = state.config.draftEveryMoves;

  if (firstAt != null && firstAt > 0) {
    if (move < firstAt) {
      return firstAt - move;
    } else if (every && every > 0) {
      const offset = (move - firstAt) % every;
      return offset === 0 ? every : (every - offset);
    }
    return null;
  } else if (every && every > 0) {
    const offset = move % every;
    return offset === 0 ? every : (every - offset);
  }

  return null;
}

/* -------------------------------------------------------------
 * Header & UI State Updates
 * ------------------------------------------------------------- */
function updateHeader() {
  const state = controller.getState();
  // Score headline = state.points (with fallback to score), MOVES = moves, MAX TILE
  let scoreVal = state.points !== undefined ? state.points : state.score;
  if (cleanSlateSequenceState && cleanSlateSequenceState.prePayoutScore !== null && cleanSlateSequenceState.prePayoutScore !== undefined) {
    scoreVal = cleanSlateSequenceState.prePayoutScore;
  }
  if (statScoreEl) statScoreEl.textContent = scoreVal.toLocaleString('en-US');
  if (statMovesEl) statMovesEl.textContent = String(state.moveCount).padStart(3, '0');
  if (statMaxTileEl) statMaxTileEl.textContent = (state.highestTile || 0).toLocaleString('en-US');

  const stoneInfo = controller.getNextStoneInfo();
  const movesLeft = stoneInfo.movesUntilNextStone;

  const telegraphRelicEl = document.getElementById('telegraph-relic');
  const relicCountdownEl = document.getElementById('relic-countdown');
  const relicStatusEl = document.getElementById('relic-status');
  const relicMovesLeft = getMovesToNextDraft();

  if (stoneCountdownEl) stoneCountdownEl.textContent = movesLeft;
  if (hazardUnitEl) {
    hazardUnitEl.textContent = movesLeft === 1 ? 'move' : 'moves';
  }

  // Telegraph text for stone and relic
  if (relicMovesLeft !== null && telegraphRelicEl) {
    telegraphRelicEl.classList.remove('hidden');
    if (relicStatusEl) {
      relicStatusEl.innerHTML = `Relic in <strong id="relic-countdown">${relicMovesLeft}</strong>`;
    } else if (relicCountdownEl) {
      relicCountdownEl.textContent = relicMovesLeft;
    }
    if (hazardStatusEl) {
      hazardStatusEl.innerHTML = `Stone in <strong id="stone-countdown">${movesLeft}</strong>`;
    }
  } else {
    if (telegraphRelicEl) telegraphRelicEl.classList.add('hidden');
    if (hazardStatusEl) {
      if (movesLeft === 1) {
        hazardStatusEl.innerHTML = 'Stone arrives after this move!';
      } else {
        hazardStatusEl.innerHTML = `Next stone in <strong id="stone-countdown">${movesLeft}</strong> <span id="hazard-unit">${movesLeft === 1 ? 'move' : 'moves'}</span>`;
      }
    }
  }

  // Telegraph warning at <= 5 countdown
  if (hazardTelegraphEl) {
    if (movesLeft <= 5) {
      hazardTelegraphEl.classList.add('warning');
    } else {
      hazardTelegraphEl.classList.remove('warning');
    }
    if (movesLeft <= 1) {
      hazardTelegraphEl.classList.add('imminent');
    } else {
      hazardTelegraphEl.classList.remove('imminent');
    }
  }

  // Fill bar percentage
  if (hazardFillEl) {
    const pct = Math.max(4, Math.min(100, Math.round((1 - (movesLeft - 1) / 15) * 100)));
    hazardFillEl.style.width = `${pct}%`;
  }

  // First-time hints (2) and (3)
  if (movesLeft <= 5 && movesLeft > 0) {
    showFirstTimeHint('hint2', 'Stones are permanent. They fill the board.');
  }
  if (controller.getBoard().includes(STONE)) {
    showFirstTimeHint('hint3', 'That stone is permanent. Keep space free.');
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
        continue;
      }

      let item = existingMap.get(rid);
      if (item) {
        passiveRelicsContainer.appendChild(item);
        continue;
      }

      item = document.createElement('button');
      item.type = 'button';
      item.className = 'relic-mini relic-passive-item';
      item.setAttribute('data-relic', rid);
      item.setAttribute('aria-label', `${RELIC_NAMES[rid] || rid}: ${getRelicOneLiner(rid, controller.config)}`);
      item.title = RELIC_NAMES[rid] || rid;
      item.tabIndex = 0;

      const iconEl = getRelicIconElement(rid, 26);
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

    if (dbgSlideSkipsEl) {
      dbgSlideSkipsEl.textContent = slideMismatchCount;
    }

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

  // Stuck state border & status line hint
  if (boardEl) {
    if (isStuck) {
      boardEl.classList.add('is-stuck');
      if (activeTargeting) {
        boardEl.classList.add('targeting-dim');
      } else {
        boardEl.classList.remove('targeting-dim');
      }
      if (!wasStuck) {
        boardEl.classList.add('brighten');
        setTimeout(() => boardEl.classList.remove('brighten'), 150);
        triggerStuckWave();
        playStuckThud(false);
      }
    } else {
      boardEl.classList.remove('is-stuck', 'brighten', 'targeting-dim');
    }
  }
  wasStuck = isStuck;

  if (statusHintBar) {
    if (activeTargeting) {
      statusHintBar.classList.remove('stuck-warning');
      if (activeTargeting.relicId === 'eraser') {
        if (statusHintText) statusHintText.textContent = 'Tap a number tile to erase it.';
      } else if (activeTargeting.relicId === 'diagonal_charge') {
        if (statusHintText) statusHintText.textContent = 'Tap a tile to move, then an equal diagonal tile.';
      }
    } else if (isStuck) {
      statusHintBar.classList.add('stuck-warning');
      if (statusHintText) statusHintText.textContent = 'No moves left — use an ability!';
    } else {
      statusHintBar.classList.remove('stuck-warning');
      if (statusHintText && !masonCandidates) {
        if (activeHint) {
          statusHintText.textContent = activeHint.text;
        } else {
          statusHintText.textContent = 'Swipe to move';
        }
      }
    }
  }
  if (stuckBanner) {
    stuckBanner.classList.add('hidden');
  }

  if (abilityStates.length === 0) {
    abilityBar.classList.add('hidden');
    return;
  }
  abilityBar.classList.remove('hidden');

  // First-time hints (4) and (5)
  showFirstTimeHint('hint4', 'Abilities are free. They do not cost a move.');
  if (allAbilities.rewind && (allAbilities.rewind.charges || 0) >= 1) {
    showFirstTimeHint('hint5', 'Rewind undoes your last swipe.');
  }

  for (const ab of abilityStates) {
    const rid = ab.relic;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ability ability-btn';
    btn.setAttribute('data-relic', rid);
    btn.setAttribute('data-ability', rid);
    btn.setAttribute('aria-label', `${RELIC_NAMES[rid] || rid} ability`);

    if (activeTargeting && activeTargeting.relicId === rid) {
      btn.classList.add('active-targeting', 'targeting');
    }

    const hasLegal = ab.legalTargets && ab.legalTargets.length > 0;
    const hasCharges = ab.charges > 0;
    const undoLevels = rid === 'rewind'
      ? (controller.getRewindUndoLevels ? controller.getRewindUndoLevels() : (ab.undoLevels ?? (hasCharges && hasLegal ? 1 : 0)))
      : null;
    const canUse = !decisionPending && !controller.isGameOver() && (rid === 'rewind' ? undoLevels > 0 : (hasCharges && hasLegal));

    if (!canUse) {
      btn.disabled = true;
      btn.classList.add('dim');
    } else if (isStuck) {
      btn.classList.add('highlight-stuck', 'rescue');
    }

    // Cooldown text or disabled reason (single text line)
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

    // Icon (~36px)
    const iconWrap = document.createElement('div');
    iconWrap.className = 'icon ability-btn-icon-wrap';
    iconWrap.appendChild(getRelicIconElement(rid, 30));

    // Name label
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = (RELIC_NAMES[rid] || rid).toUpperCase();

    // 3 Charge Pips
    const pipsEl = document.createElement('div');
    pipsEl.className = 'pips ability-pips';
    for (let p = 0; p < ab.maxCharges; p++) {
      const pip = document.createElement('span');
      pip.className = `pip charge-pip ${p < ab.charges ? 'on filled' : ''}`;
      pipsEl.appendChild(pip);
    }

    // Refill cooldown text line
    const cdEl = document.createElement('span');
    cdEl.className = 'refill ability-btn-cooldown';
    cdEl.textContent = cdText;

    btn.appendChild(iconWrap);
    btn.appendChild(nameEl);
    btn.appendChild(pipsEl);
    btn.appendChild(cdEl);

    const shineEl = document.createElement('span');
    shineEl.className = 'card-shine';
    shineEl.setAttribute('aria-hidden', 'true');
    btn.appendChild(shineEl);

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
      if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
        cleanSlateSequenceState.ignoredAbilityCount = (cleanSlateSequenceState.ignoredAbilityCount || 0) + 1;
        e.preventDefault();
        return;
      }
      hideRelicPopover();
      controller.recordInput('tap');

      if (rid === 'rewind') {
        // Rewind is single-tap with no targeting
        const canUseNow = controller.getRewindUndoLevels ? controller.getRewindUndoLevels() > 0 : canUse;
        if (canUseNow && !controller.isGameOver() && !controller.hasPendingDecision()) {
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

function triggerCardShimmer(relicId) {
  if (REWIND_FX && REWIND_FX.shimmerOnUse === false) return;
  const btn = document.querySelector(`.ability-btn[data-relic="${relicId}"], .ability[data-relic="${relicId}"]`);
  if (!btn) return;
  btn.classList.add('shimmer');
  const onEnd = () => {
    btn.classList.remove('shimmer');
    btn.removeEventListener('animationend', onEnd);
  };
  btn.addEventListener('animationend', onEnd, { once: true });
  setTimeout(() => {
    btn.classList.remove('shimmer');
    btn.removeEventListener('animationend', onEnd);
  }, 750);
}
if (typeof window !== 'undefined') {
  window.triggerCardShimmer = triggerCardShimmer;
}

function startTargeting(relicId) {
  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) return;
  if (controller.isGameOver() || controller.hasPendingDecision()) return;
  const legalTargets = controller.getLegalTargets(relicId);
  const abilityState = controller.getAbilityState()[relicId];
  if (!abilityState || abilityState.charges <= 0 || legalTargets.length === 0) return;

  activeTargeting = {
    relicId,
    step: 1,
    selectedCell: null,
  };

  if (btnCancelTargeting) btnCancelTargeting.classList.remove('hidden');
  if (targetingBar) targetingBar.classList.remove('hidden');
  dismissHint();

  if (relicId === 'diagonal_charge') {
    if (targetingInstruction) targetingInstruction.textContent = 'Tap the tile to move, then the equal tile diagonal to it';
    if (statusHintText) statusHintText.textContent = 'Tap a tile to move, then an equal diagonal tile.';
  } else if (relicId === 'eraser') {
    if (targetingInstruction) targetingInstruction.textContent = 'Eraser: tap a number tile to remove';
    if (statusHintText) statusHintText.textContent = 'Tap a number tile to erase it.';
  }

  highlightTargetingBoard();
  renderAbilityBar();
}

function cleanupAbilityFocus(isKeyboard = false) {
  if (!isKeyboard) {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }
  if (window.getSelection) {
    try {
      window.getSelection().removeAllRanges();
    } catch { }
  }
}

function cancelTargeting(isKeyboard = false) {
  if (!activeTargeting) return;
  activeTargeting = null;
  if (btnCancelTargeting) btnCancelTargeting.classList.add('hidden');
  if (targetingBar) targetingBar.classList.add('hidden');
  if (statusHintText) statusHintText.textContent = activeHint ? activeHint.text : 'Swipe to move';
  clearTargetingHighlights();
  renderAbilityBar();
  cleanupAbilityFocus(isKeyboard);
}

function highlightTargetingBoard() {
  clearTargetingHighlights();
  if (!activeTargeting) return;

  const { relicId, step, selectedCell } = activeTargeting;
  const legalTargets = controller.getLegalTargets(relicId);
  const allTiles = Array.from(tilesLayer.querySelectorAll('.tile'));

  if (relicId === 'diagonal_charge') {
    if (step === 1) {
      const candidateCells = new Set();
      for (const t of legalTargets) {
        candidateCells.add(t.from);
      }
      allTiles.forEach(tile => {
        const idx = parseInt(tile.getAttribute('data-index'), 10);
        if (tile.classList.contains('stone')) return;
        if (candidateCells.has(idx)) {
          tile.classList.add('target-candidate', 'candidate');
        } else {
          tile.classList.add('dim');
        }
      });
    } else if (step === 2 && selectedCell !== null) {
      const partnerCells = new Set();
      for (const t of legalTargets) {
        if (t.from === selectedCell) partnerCells.add(t.to);
      }
      allTiles.forEach(tile => {
        const idx = parseInt(tile.getAttribute('data-index'), 10);
        if (tile.classList.contains('stone')) return;
        if (idx === selectedCell) {
          tile.classList.add('target-selected', 'selected');
        } else if (partnerCells.has(idx)) {
          tile.classList.add('target-partner', 'valid');
        } else {
          tile.classList.add('dim');
        }
      });
    }
  } else if (relicId === 'eraser') {
    // T3: Eraser mode just outlines erasable number tiles
    const legalCells = new Set(legalTargets.map(t => t.cell));
    allTiles.forEach(tile => {
      const idx = parseInt(tile.getAttribute('data-index'), 10);
      const isStone = tile.classList.contains('stone');
      if (!isStone && legalCells.has(idx)) {
        tile.classList.add('erasable');
      } else {
        tile.classList.add('dim');
      }
    });
  }
}

function clearTargetingHighlights() {
  const cells = boardEl ? boardEl.querySelectorAll('.cell') : [];
  cells.forEach(cell => {
    cell.classList.remove('candidate', 'selected', 'valid', 'erasable', 'laser-target', 'dim', 'diag-persist');
  });
  if (tilesLayer) {
    const tiles = tilesLayer.querySelectorAll('.tile');
    tiles.forEach(tile => {
      tile.classList.remove('target-candidate', 'candidate', 'target-selected', 'selected', 'target-partner', 'valid', 'eraser-confirm', 'erasable', 'laser-target', 'dim');
    });
  }
}



/* -------------------------------------------------------------
 * 3D Rewind FX & Input Director
 * ------------------------------------------------------------- */
export const REWIND_FX = {
  mode: 'wave',
  stage: 'tile',
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
  queueMax: 4,
  // Vortex mode parameters preserved intact:
  alpha: 0.35,
  zMin: 300,
  zMax: 600,
  tiltMin: 10,
  tiltMax: 25,
  sinkDelayMax: 200,
  sinkDurationMin: 320,
  sinkDurationMax: 350,
  riseDelayMax: 180,
  riseDurationMin: 400,
  riseDurationMax: 420,
  vortexPerspective: 1100,
  vortexSinkScale: 0.85,
  riseTransformEasing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};
if (typeof window !== 'undefined') {
  window.REWIND_FX = REWIND_FX;
}

function createRewindRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getRewindSeed(ctrl) {
  const state = ctrl ? ctrl.getState() : {};
  const runId = String(state.runId || 'run');
  const moveCount = Number(state.moveCount || 0);
  let str = `${runId}:${moveCount}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

function computeTilePose(index, metrics, seed, phase) {
  const p = metrics.stepX || 76;
  const col = index % 4;
  const row = Math.floor(index / 4);

  const u = (col - 1.5) / 1.5;
  const w = (row - 1.5) / 1.5;

  const vx = (1.5 - col) * p;
  const vy = (1.5 - row) * p;

  const d = Math.sqrt(vx * vx + vy * vy);
  const dMax = p * Math.sqrt(1.5 * 1.5 + 1.5 * 1.5);
  const r = d / dMax;
  const rMin = 1 / 3;
  const rho = Math.max(0, Math.min(1, (r - rMin) / (1 - rMin)));

  const rng = createRewindRng((seed ^ (index * 2654435761) ^ (phase === 'rise' ? 0x9e3779b9 : 0)) >>> 0);
  const xi = rng();
  const xi2 = rng();

  const Z = 300 + 300 * (0.4 * r + 0.6 * xi);
  const theta = 10 + 15 * r;

  const baseTrans = getTileTranslate(index, metrics);

  const sinkScale = REWIND_FX.vortexSinkScale || 0.85;
  const nadirTransform = `${baseTrans.transform} translate3d(${REWIND_FX.alpha * vx}px, ${REWIND_FX.alpha * vy}px, -${Z}px) rotateX(${w * theta}deg) rotateY(${-u * theta}deg) scale(${sinkScale})`;
  const baseTransform = `${baseTrans.transform} translate3d(0px, 0px, 0px) rotateX(0deg) rotateY(0deg) scale(1)`;

  const sinkDelay = 140 * (1 - rho) + 60 * xi2;
  const sinkDuration = 320 + 30 * xi;

  const riseDelay = 110 * rho + 70 * xi2;
  const riseDuration = 400 + 20 * xi;

  return {
    index, col, row, u, w, vx, vy, r, rho, xi, xi2, Z, theta,
    baseTransform, nadirTransform,
    sinkDelay, sinkDuration,
    riseDelay, riseDuration
  };
}

class RewindDirector {
  constructor() {
    this.state = 'IDLE';
    this.queue = [];
    this.ignoredCount = 0;
    this.currentGroup = [];
    this.riseAnimations = [];
    this.epoch = 0;
    this.currentRate = 1.0;
    this.targetRate = 1.0;
    this.rateRaf = null;
    this.isPaused = false;
    this.stateHistory = [];
    this.rateHistory = [];
    this.swapCount = 0;
    this.sinkEndTime = 0;
    this.swapTime = 0;
    this.riseEndTime = 0;
    this.displayed = new Array(16).fill(0);
    this.waveCount = 0;
    this.deltaWaveCount = 0;
    this.waveStartTime = 0;
    this.cellSwapTimes = {};
    this.firstM3SwapTime = null;
    this.totalDurationMeasured = 0;
    this.pendingSwapCount = 0;
    this.completedSwapCount = 0;
  }

  getState() {
    return this.state;
  }

  isActive() {
    return this.state !== 'IDLE';
  }

  getQueue() {
    return [...this.queue];
  }

  getIgnoredCount() {
    return this.ignoredCount;
  }

  setState(newState) {
    const ts = performance.now();
    this.state = newState;
    this.stateHistory.push({
      state: newState,
      time: ts,
      queue: this.queue.map(q => q.type),
      rate: this.currentRate
    });
  }

  enqueueInput(type, payload) {
    if (this.queue.length >= REWIND_FX.queueMax) {
      this.ignoredCount++;
      return false;
    }
    this.queue.push({ type, payload });
    if (this.state === 'WAVE' || this.state === 'SINK' || this.state === 'RISE' || this.state === 'SWAP') {
      this.triggerCatchUp();
    }
    return true;
  }

  triggerCatchUp() {
    if (this.currentGroup.length === 0) return;
    let maxRemaining = 0;
    for (const a of this.currentGroup) {
      const timing = a.effect ? a.effect.getComputedTiming() : null;
      if (timing && typeof timing.endTime === 'number') {
        const cur = typeof a.currentTime === 'number' ? a.currentTime : 0;
        const rem = Math.max(0, timing.endTime - cur);
        if (rem > maxRemaining) maxRemaining = rem;
      }
    }
    const K = Math.max(1, Math.min(REWIND_FX.maxRate, maxRemaining / REWIND_FX.catchUpMs));
    const targetK = Math.max(K, this.targetRate);
    if (targetK > this.currentRate) {
      this.startRateRamp(targetK);
    }
  }

  startRateRamp(targetK) {
    this.targetRate = targetK;
    const startRate = this.currentRate;
    const startTime = performance.now();
    const rampDuration = REWIND_FX.rampMs;
    const epoch = this.epoch;

    if (this.rateRaf) cancelAnimationFrame(this.rateRaf);

    const tickRamp = (now) => {
      if (this.epoch !== epoch || !this.isActive()) return;
      const elapsed = now - startTime;
      const progress = Math.max(0, Math.min(1, elapsed / rampDuration));
      const s = progress * progress * (3 - 2 * progress);
      const k = startRate + (targetK - startRate) * s;
      this.currentRate = k;

      for (const a of this.currentGroup) {
        try { a.updatePlaybackRate(k); } catch { }
      }

      this.rateHistory.push({ time: now, rate: k });

      if (progress < 1) {
        this.rateRaf = requestAnimationFrame(tickRamp);
      }
    };

    this.rateRaf = requestAnimationFrame(tickRamp);
  }

  syncDisplayedFromDom() {
    const b = controller ? controller.getBoard() : [];
    for (let i = 0; i < 16; i++) {
      this.displayed[i] = b[i] ?? 0;
    }
  }

  processRewindAction() {
    const canUseNow = controller.getRewindUndoLevels ? controller.getRewindUndoLevels() > 0 : true;
    const abilityState = controller.getAbilityState()?.rewind;
    const hasCharges = abilityState && abilityState.charges > 0;

    if (!canUseNow || !hasCharges) {
      showToast('Nothing to undo');
      return false;
    }

    const res = controller.useAbility('rewind', {});
    if (!res.success) {
      showToast(res.error || 'Nothing to undo');
      return false;
    }

    if (uiMoveLog.length > 0) {
      uiMoveLog.pop();
    }

    playRewind();
    renderAbilityBar();
    triggerCardShimmer('rewind');

    return true;
  }

  handleRewindTap() {
    if (controller.isGameOver()) return;
    if (controller.hasPendingDecision()) return;

    if (this.state === 'IDLE') {
      if (isAnimating) {
        this.setState('WAIT_SLIDE');
        this.enqueueInput('rewind', {});
        return;
      }
      this.syncDisplayedFromDom();
      const processed = this.processRewindAction();
      if (processed) {
        if (REWIND_FX.mode === 'vortex') {
          this.startSink();
        } else {
          this.startWave();
        }
      }
      return;
    }

    if (this.state === 'WAIT_SLIDE') {
      this.enqueueInput('rewind', {});
      return;
    }

    if (this.state === 'WAVE' || this.state === 'SINK' || this.state === 'RISE' || this.state === 'SWAP') {
      if (REWIND_FX.mode === 'wave') {
        if (this.queue.length === 0) {
          this.processRewindAction();
          this.triggerCatchUp();
        } else {
          this.enqueueInput('rewind', {});
        }
      } else {
        if (this.state === 'SINK' || this.state === 'SWAP') {
          if (this.queue.length === 0) {
            this.processRewindAction();
          } else {
            this.enqueueInput('rewind', {});
          }
        } else if (this.state === 'RISE') {
          if (this.queue.length === 0) {
            const processed = this.processRewindAction();
            if (processed) this.startRiseReverse();
          } else {
            this.enqueueInput('rewind', {});
          }
        } else if (this.state === 'RISE_REVERSE') {
          if (this.queue.length === 0) {
            this.processRewindAction();
          } else {
            this.enqueueInput('rewind', {});
          }
        }
      }
      return;
    }
  }

  onSlideAnimationComplete() {
    if (this.state === 'WAIT_SLIDE' || this.state === 'IDLE') {
      this.setState('IDLE');
      this.processQueue();
    }
  }

  startWave(deltaCells = null) {
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      this.startReducedMotionSequence();
      return;
    }

    this.setState('WAVE');
    isAnimating = true;
    const epoch = ++this.epoch;
    if (this.rateRaf) cancelAnimationFrame(this.rateRaf);
    this.currentRate = 1.0;
    this.targetRate = 1.0;

    const now = performance.now();
    if (!deltaCells) {
      this.waveCount = 1;
      this.deltaWaveCount = 0;
      this.waveStartTime = now;
      this.cellSwapTimes = {};
      this.firstM3SwapTime = null;
    } else {
      this.waveCount++;
      this.deltaWaveCount++;
    }

    const metrics = getGridMetrics();
    const cellsToAnimate = deltaCells
      ? new Set(deltaCells)
      : new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    const mMin = deltaCells
      ? Math.min(...deltaCells.map(idx => Math.floor(idx / 4) + (idx % 4)))
      : 0;

    this.pendingSwapCount = cellsToAnimate.size;
    this.completedSwapCount = 0;
    this.currentGroup = [];
    this.riseAnimations = [];
    this.activeWaveAnimations = [];
    this.activeWavePromises = [];

    if (this.waveWatchdogTimer) {
      clearTimeout(this.waveWatchdogTimer);
      this.waveWatchdogTimer = null;
    }
    const maxM = deltaCells
      ? Math.max(...deltaCells.map(idx => Math.floor(idx / 4) + (idx % 4)))
      : 6;
    const computedWaveDuration = (maxM - mMin) * REWIND_FX.stepMs + REWIND_FX.sinkMs + REWIND_FX.riseMs;
    this.waveWatchdogTimer = setTimeout(() => {
      if (this.epoch === epoch && this.state === 'WAVE') {
        console.error('watchdog_wave_timeout: wave did not complete in time');
        if (typeof window !== 'undefined') {
          window.watchdogWaveTimeoutFired = (window.watchdogWaveTimeoutFired || 0) + 1;
        }
        this.executeCleanup();
      }
    }, computedWaveDuration + 4000);

    for (let i = 0; i < 16; i++) {
      if (!cellsToAnimate.has(i)) continue;

      const row = Math.floor(i / 4);
      const col = i % 4;
      const m = row + col;
      const cellDelay = (m - mMin) * REWIND_FX.stepMs;

      const oldEl = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${i}"], .stone[data-index="${i}"]`) : null;

      if (oldEl) {
        const animTarget = REWIND_FX.stage === 'tile'
          ? (oldEl.querySelector('.tile-face') || oldEl)
          : oldEl;

        const baseTrans = getTileTranslate(i, metrics);
        const restPose = REWIND_FX.stage === 'tile'
          ? 'none'
          : `${baseTrans.transform} translateZ(0px) scale(1)`;
        const nadirPose = REWIND_FX.stage === 'tile'
          ? `perspective(${REWIND_FX.perspective}px) translateZ(-${REWIND_FX.zDepth}px) scale(${REWIND_FX.sinkScale})`
          : `${baseTrans.transform} translateZ(-${REWIND_FX.zDepth}px) scale(${REWIND_FX.sinkScale})`;

        const tAnim = animTarget.animate([
          { transform: restPose, offset: 0 },
          { transform: nadirPose, offset: 1 }
        ], {
          duration: REWIND_FX.sinkMs,
          delay: cellDelay,
          easing: REWIND_FX.sinkEasing,
          fill: 'forwards'
        });

        const oAnim = animTarget.animate([
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.6 },
          { opacity: 0, offset: 1 }
        ], {
          duration: REWIND_FX.sinkMs,
          delay: cellDelay,
          easing: 'linear',
          fill: 'forwards'
        });

        this.currentGroup.push(tAnim, oAnim);

        Promise.all([tAnim.finished.catch(() => { }), oAnim.finished.catch(() => { })]).then(() => {
          if (this.epoch !== epoch || this.state !== 'WAVE') return;
          this.executeCellSwap(i, m, oldEl, [tAnim, oAnim], epoch);
        });
      } else {
        const cellEl = boardEl ? boardEl.querySelector(`.cell[data-index="${i}"], .grid-cell[data-index="${i}"]`) : null;
        if (cellEl) {
          const ripAnim = cellEl.animate([
            { transform: 'scale(1)', offset: 0 },
            { transform: `scale(${REWIND_FX.socketPress})`, offset: 0.45 },
            { transform: 'scale(1)', offset: 1 }
          ], {
            delay: cellDelay,
            duration: REWIND_FX.sinkMs + REWIND_FX.riseMs,
            easing: 'ease-in-out',
            fill: 'none'
          });
          this.currentGroup.push(ripAnim);
          this.activeWaveAnimations.push(ripAnim);
          this.activeWavePromises.push(ripAnim.finished.catch(() => { }));
        }

        const sentinel = document.createElement('div');
        sentinel.style.position = 'absolute';
        sentinel.style.opacity = '0';
        sentinel.style.pointerEvents = 'none';
        sentinel.setAttribute('data-sentinel', String(i));
        if (boardEl) boardEl.appendChild(sentinel);

        const barrierAnim = sentinel.animate([
          { opacity: 0 },
          { opacity: 0 }
        ], {
          delay: cellDelay,
          duration: REWIND_FX.sinkMs
        });
        this.currentGroup.push(barrierAnim);

        barrierAnim.finished.catch(() => { }).then(() => {
          if (sentinel.parentNode) sentinel.parentNode.removeChild(sentinel);
          if (this.epoch !== epoch || this.state !== 'WAVE') return;
          this.executeCellSwap(i, m, null, [barrierAnim], epoch);
        });
      }
    }

    if (this.queue.length > 0) {
      this.triggerCatchUp();
    }
  }

  executeCellSwap(cellIdx, m, oldEl, finishedAnims, epoch) {
    if (this.epoch !== epoch || this.state !== 'WAVE') return;

    for (const a of finishedAnims) {
      try {
        if (a.playState === 'finished' || (a.currentTime >= (a.effect?.getComputedTiming()?.endTime ?? 0))) {
          a.cancel();
        }
      } catch { }
    }
    this.currentGroup = this.currentGroup.filter(a => !finishedAnims.includes(a));

    if (oldEl && oldEl.parentNode) {
      oldEl.parentNode.removeChild(oldEl);
    }

    const targetVal = controller.getBoard()[cellIdx] ?? 0;
    const metrics = getGridMetrics();

    if (targetVal !== 0) {
      const newEl = createTileElement(cellIdx, targetVal, false, metrics);
      const animTarget = REWIND_FX.stage === 'tile'
        ? (newEl.querySelector('.tile-face') || newEl)
        : newEl;

      const baseTrans = getTileTranslate(cellIdx, metrics);
      const restPose = REWIND_FX.stage === 'tile'
        ? 'none'
        : `${baseTrans.transform} translateZ(0px) scale(1)`;
      const nadirPose = REWIND_FX.stage === 'tile'
        ? `perspective(${REWIND_FX.perspective}px) translateZ(-${REWIND_FX.zDepth}px) scale(${REWIND_FX.sinkScale})`
        : `${baseTrans.transform} translateZ(-${REWIND_FX.zDepth}px) scale(${REWIND_FX.sinkScale})`;

      if (REWIND_FX.stage === 'tile') {
        animTarget.style.transform = nadirPose;
        animTarget.style.opacity = '0';
      } else {
        newEl.style.transform = nadirPose;
        newEl.style.opacity = '0';
      }

      tilesLayer.appendChild(newEl);

      const tRiseAnim = animTarget.animate([
        { transform: nadirPose, offset: 0 },
        { transform: restPose, offset: 1 }
      ], {
        duration: REWIND_FX.riseMs,
        easing: REWIND_FX.riseEasing,
        fill: 'forwards'
      });

      const oRiseAnim = animTarget.animate([
        { opacity: 0, offset: 0 },
        { opacity: 1, offset: 0.45 },
        { opacity: 1, offset: 1 }
      ], {
        duration: REWIND_FX.riseMs,
        easing: 'linear',
        fill: 'forwards'
      });

      if (this.currentRate !== 1.0) {
        try {
          tRiseAnim.updatePlaybackRate(this.currentRate);
          oRiseAnim.updatePlaybackRate(this.currentRate);
        } catch { }
      }
      if (this.isPaused) {
        try {
          tRiseAnim.pause();
          oRiseAnim.pause();
        } catch { }
      }

      Promise.all([tRiseAnim.finished.catch(() => { }), oRiseAnim.finished.catch(() => { })]).then(() => {
        if (REWIND_FX.stage === 'tile') {
          animTarget.style.transform = '';
          animTarget.style.opacity = '';
        } else {
          newEl.style.transform = baseTrans.transform;
          newEl.style.opacity = '';
        }
      });

      this.currentGroup.push(tRiseAnim, oRiseAnim);
      this.riseAnimations.push(tRiseAnim, oRiseAnim);
      this.activeWaveAnimations.push(tRiseAnim, oRiseAnim);
      this.activeWavePromises.push(tRiseAnim.finished.catch(() => { }), oRiseAnim.finished.catch(() => { }));
    }

    this.displayed[cellIdx] = targetVal;
    this.swapCount++;
    syncBoard(controller.getBoard(), 'rewind-cell-swap');

    const swapTs = performance.now();
    this.cellSwapTimes[cellIdx] = swapTs - this.waveStartTime;

    if (m === 3 && this.firstM3SwapTime === null) {
      this.firstM3SwapTime = swapTs - this.waveStartTime;
      updateHeader();
      renderAbilityBar();
      if (typeof updateCountdownBadge === 'function') updateCountdownBadge();
    }

    this.completedSwapCount++;
    if (this.completedSwapCount === this.pendingSwapCount) {
      const waitGroup = this.activeWavePromises && this.activeWavePromises.length > 0
        ? this.activeWavePromises
        : this.riseAnimations.map(a => a.finished.catch(() => { }));
      if (waitGroup.length > 0) {
        Promise.all(waitGroup).then(() => {
          if (this.epoch !== epoch || this.state !== 'WAVE') return;
          this.onWaveGroupFinished(epoch);
        });
      } else {
        this.onWaveGroupFinished(epoch);
      }
    }
  }

  onWaveGroupFinished(epoch) {
    if (this.epoch !== epoch || this.state !== 'WAVE') return;

    this.totalDurationMeasured = performance.now() - this.waveStartTime;

    const engineBoard = controller.getBoard();
    const changedCells = [];
    for (let i = 0; i < 16; i++) {
      if (this.displayed[i] !== (engineBoard[i] ?? 0)) {
        changedCells.push(i);
      }
    }

    if (changedCells.length > 0) {
      this.startWave(changedCells);
    } else {
      this.executeCleanup();
    }
  }

  // Legacy vortex sink
  startSink() {
    const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      this.startReducedMotionSequence();
      return;
    }

    this.setState('SINK');
    isAnimating = true;
    this.currentRate = 1.0;
    this.targetRate = 1.0;
    const epoch = ++this.epoch;

    const metrics = getGridMetrics();
    const seed = getRewindSeed(controller);
    const tiles = Array.from(tilesLayer.children).filter(el =>
      el.classList.contains('tile') || el.classList.contains('stone')
    );

    const sinkAnims = [];

    for (const el of tiles) {
      const idx = parseInt(el.getAttribute('data-index'), 10);
      const pose = computeTilePose(idx, metrics, seed, 'sink');

      el.style.willChange = 'transform, opacity';

      const tAnim = el.animate([
        { transform: pose.baseTransform },
        { transform: pose.nadirTransform }
      ], {
        duration: pose.sinkDuration,
        delay: pose.sinkDelay,
        easing: REWIND_FX.sinkEasing,
        fill: 'forwards'
      });

      const oAnim = el.animate([
        { opacity: 1, offset: 0 },
        { opacity: 0.9, offset: 0.55 },
        { opacity: 0, offset: 1 }
      ], {
        duration: pose.sinkDuration,
        delay: pose.sinkDelay,
        easing: 'linear',
        fill: 'forwards'
      });

      sinkAnims.push(tAnim, oAnim);
    }

    this.currentGroup = sinkAnims;

    if (this.queue.length > 0) {
      this.triggerCatchUp();
    }

    Promise.all(sinkAnims.map(a => a.finished.catch(() => { }))).then(() => {
      if (this.epoch !== epoch || this.state !== 'SINK') return;
      this.sinkEndTime = performance.now();
      this.executeSwap();
    });
  }

  startRiseReverse() {
    this.setState('RISE_REVERSE');
    const targetK = -REWIND_FX.reverseRate;
    const startRate = this.currentRate;
    const startTime = performance.now();
    const rampDuration = REWIND_FX.rampMs;
    const epoch = this.epoch;

    if (this.rateRaf) cancelAnimationFrame(this.rateRaf);

    const tickReverseRamp = (now) => {
      if (this.epoch !== epoch || this.state !== 'RISE_REVERSE') return;

      const elapsed = now - startTime;
      const progress = Math.max(0, Math.min(1, elapsed / rampDuration));
      const s = progress * progress * (3 - 2 * progress);
      const k = startRate + (targetK - startRate) * s;
      this.currentRate = k;

      for (const a of this.currentGroup) {
        try { a.updatePlaybackRate(k); } catch { }
      }

      let allAtNadir = true;
      for (const a of this.currentGroup) {
        const cur = typeof a.currentTime === 'number' ? a.currentTime : 0;
        if (cur > 0.5 && a.playState !== 'finished') {
          allAtNadir = false;
          break;
        }
      }

      if (allAtNadir && progress >= 0.5) {
        this.executeSwap();
        return;
      }

      this.rateRaf = requestAnimationFrame(tickReverseRamp);
    };

    this.rateRaf = requestAnimationFrame(tickReverseRamp);
  }

  executeSwap() {
    this.setState('SWAP');
    this.swapCount++;
    this.swapTime = performance.now();
    const epoch = this.epoch;

    let riseAnims = [];
    if (this.epoch !== epoch) return;

    for (const a of this.currentGroup) {
      try { a.cancel(); } catch { }
    }
    this.currentGroup = [];

    if (tilesLayer) {
      tilesLayer.innerHTML = '';
    }

    syncBoard(controller.getBoard(), 'rewind-swap');

    const metrics = getGridMetrics();
    const newTiles = Array.from(tilesLayer.children).filter(el =>
      el.classList.contains('tile') || el.classList.contains('stone')
    );

    const seed = getRewindSeed(controller);

    for (const el of newTiles) {
      const idx = parseInt(el.getAttribute('data-index'), 10);
      const pose = computeTilePose(idx, metrics, seed, 'rise');

      el.style.opacity = '0';
      el.style.transform = pose.nadirTransform;
      el.style.willChange = 'transform, opacity';

      const tAnim = el.animate([
        { transform: pose.nadirTransform },
        { transform: pose.baseTransform }
      ], {
        duration: pose.riseDuration,
        delay: pose.riseDelay,
        easing: REWIND_FX.riseTransformEasing || REWIND_FX.riseEasing,
        fill: 'both'
      });

      const oAnim = el.animate([
        { opacity: 0 },
        { opacity: 1 }
      ], {
        duration: pose.riseDuration,
        delay: pose.riseDelay,
        easing: 'linear',
        fill: 'both'
      });

      riseAnims.push(tAnim, oAnim);
    }

    this.currentGroup = riseAnims;

    updateHeader();
    renderAbilityBar();
    if (typeof updateCountdownBadge === 'function') updateCountdownBadge();

    this.setState('RISE');
    this.currentRate = 1.0;
    this.targetRate = 1.0;

    if (this.queue.length > 0) {
      this.triggerCatchUp();
    }

    Promise.all(riseAnims.map(a => a.finished.catch(() => { }))).then(() => {
      if (this.epoch !== epoch || this.state !== 'RISE') return;
      this.riseEndTime = performance.now();
      this.executeCleanup();
    });
  }

  executeCleanup() {
    const epoch = this.epoch;
    if (this.epoch !== epoch) return;

    if (this.waveWatchdogTimer) {
      clearTimeout(this.waveWatchdogTimer);
      this.waveWatchdogTimer = null;
    }

    if (this.rateRaf) cancelAnimationFrame(this.rateRaf);
    for (const a of this.currentGroup) {
      try {
        if (a.playState === 'finished' || (a.currentTime >= (a.effect?.getComputedTiming()?.endTime ?? 0))) {
          a.cancel();
        }
      } catch { }
    }
    this.currentGroup = [];
    this.riseAnimations = [];
    this.activeWaveAnimations = [];
    this.activeWavePromises = [];

    const metrics = getGridMetrics();
    const currentBoard = controller.getBoard();
    const tiles = Array.from(tilesLayer.children).filter(el =>
      el.classList.contains('tile') || el.classList.contains('stone')
    );

    for (const el of tiles) {
      const idx = parseInt(el.getAttribute('data-index'), 10);
      const trans = getTileTranslate(idx, metrics);
      el.style.transform = trans.transform;
      el.style.opacity = '1';
      el.style.willChange = '';
      const face = el.querySelector('.tile-face, .stone-face');
      if (face) {
        face.style.transform = '';
        face.style.opacity = '';
        face.style.willChange = '';
      }
    }

    syncBoard(currentBoard, 'rewind');

    this.setState('IDLE');
    isAnimating = false;
    currentAnimationState = null;
    this.currentRate = 1.0;
    this.targetRate = 1.0;

    this.processQueue();
  }

  processQueue() {
    if (this.state !== 'IDLE' || this.queue.length === 0) return;

    const item = this.queue.shift();
    if (item.type === 'rewind') {
      this.syncDisplayedFromDom();
      let rewindsProcessed = 0;
      if (this.processRewindAction()) {
        rewindsProcessed++;
      }
      while (this.queue.length > 0 && this.queue[0].type === 'rewind') {
        this.queue.shift();
        if (this.processRewindAction()) {
          rewindsProcessed++;
        }
      }
      if (rewindsProcessed > 0) {
        if (REWIND_FX.mode === 'vortex') {
          this.startSink();
        } else {
          this.startWave();
        }
      } else {
        this.processQueue();
      }
    } else if (item.type === 'move') {
      handleMove(item.payload.direction, item.payload.inputType);
      if (isAnimating) {
        if (this.queue.length > 0) {
          this.setState('WAIT_SLIDE');
        }
      } else {
        this.processQueue();
      }
    } else if (item.type === 'ability') {
      executeAbility(item.payload.relicId, item.payload.target);
      if (isAnimating) {
        if (this.queue.length > 0) {
          this.setState('WAIT_SLIDE');
        }
      } else {
        this.processQueue();
      }
    }
  }

  startReducedMotionSequence() {
    this.setState('SINK');
    isAnimating = true;
    this.currentRate = 1.0;
    this.targetRate = 1.0;
    const epoch = ++this.epoch;

    const tiles = Array.from(tilesLayer.children).filter(el =>
      el.classList.contains('tile') || el.classList.contains('stone')
    );

    const fadeOutAnims = [];
    for (const el of tiles) {
      el.style.willChange = 'opacity';
      const a = el.animate([
        { opacity: 1 },
        { opacity: 0 }
      ], {
        duration: 75,
        easing: 'linear',
        fill: 'forwards'
      });
      fadeOutAnims.push(a);
    }

    this.currentGroup = fadeOutAnims;
    if (this.queue.length > 0) this.triggerCatchUp();

    Promise.all(fadeOutAnims.map(a => a.finished.catch(() => { }))).then(() => {
      if (this.epoch !== epoch || this.state !== 'SINK') return;
      this.sinkEndTime = performance.now();
      this.executeReducedMotionSwap();
    });
  }

  executeReducedMotionSwap() {
    this.setState('SWAP');
    this.swapCount++;
    this.swapTime = performance.now();
    const epoch = this.epoch;

    let fadeInAnims = [];
    if (this.epoch !== epoch) return;

    for (const a of this.currentGroup) {
      try { a.cancel(); } catch { }
    }
    this.currentGroup = [];

    if (tilesLayer) {
      tilesLayer.innerHTML = '';
    }

    syncBoard(controller.getBoard(), 'rewind-swap');

    const newTiles = Array.from(tilesLayer.children).filter(el =>
      el.classList.contains('tile') || el.classList.contains('stone')
    );

    for (const el of newTiles) {
      el.style.opacity = '0';
      el.style.willChange = 'opacity';
      const a = el.animate([
        { opacity: 0 },
        { opacity: 1 }
      ], {
        duration: 75,
        easing: 'linear',
        fill: 'both'
      });
      fadeInAnims.push(a);
    }

    this.currentGroup = fadeInAnims;

    updateHeader();
    renderAbilityBar();
    if (typeof updateCountdownBadge === 'function') updateCountdownBadge();

    this.setState('RISE');
    if (this.queue.length > 0) this.triggerCatchUp();

    Promise.all(fadeInAnims.map(a => a.finished.catch(() => { }))).then(() => {
      if (this.epoch !== epoch || this.state !== 'RISE') return;
      this.riseEndTime = performance.now();
      this.executeCleanup();
    });
  }

  pause() {
    this.isPaused = true;
    for (const a of this.currentGroup) {
      try { a.pause(); } catch { }
    }
  }

  resume() {
    this.isPaused = false;
    for (const a of this.currentGroup) {
      try { a.play(); } catch { }
    }
  }

  hardReset() {
    this.epoch++;
    if (this.waveWatchdogTimer) {
      clearTimeout(this.waveWatchdogTimer);
      this.waveWatchdogTimer = null;
    }
    if (this.rateRaf) cancelAnimationFrame(this.rateRaf);
    for (const a of this.currentGroup) {
      try { a.cancel(); } catch { }
    }
    this.currentGroup = [];
    this.riseAnimations = [];
    this.activeWaveAnimations = [];
    this.activeWavePromises = [];
    this.queue = [];
    this.state = 'IDLE';
    this.currentRate = 1.0;
    this.targetRate = 1.0;
    this.isPaused = false;
    if (currentAnimationState && typeof currentAnimationState.cancelAnimation === 'function') {
      try { currentAnimationState.cancelAnimation(); } catch { }
    }
    isAnimating = false;
    currentAnimationState = null;
  }
}

export const rewindDirector = new RewindDirector();
if (typeof window !== 'undefined') {
  window.rewindDirector = rewindDirector;
}

function executeRewind() {
  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
    cleanSlateSequenceState.ignoredAbilityCount = (cleanSlateSequenceState.ignoredAbilityCount || 0) + 1;
    return;
  }
  cancelTargeting();
  rewindDirector.handleRewindTap();
}

function executeAbility(relicId, target) {
  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
    cleanSlateSequenceState.ignoredAbilityCount = (cleanSlateSequenceState.ignoredAbilityCount || 0) + 1;
    return;
  }

  if (relicId === 'rewind') {
    executeRewind();
    return;
  }

  if (rewindDirector && rewindDirector.isActive()) {
    rewindDirector.enqueueInput('ability', { relicId, target });
    return;
  }

  if (isAnimating) {
    finishCurrentAnimationImmediately();
  }

  if (relicId === 'diagonal_charge' || relicId === 'eraser') {
    uiMoveLog = []; // clear rewind stack on active abilities
  }

  const actsBefore = { ...(controller.getState().relicActivations || {}) };
  const boardBefore = controller.getBoard();
  const ascensionsLenBefore = (controller.getState().ascensions || []).length;

  const res = controller.useAbility(relicId, target);
  cancelTargeting();

  if (!res.success) {
    showToast(`Error: ${res.error || 'Failed to use ability'}`);
    return;
  }

  triggerCardShimmer(relicId);

  // Animation and audio feedback
  if (relicId === 'diagonal_charge') {
    flashCellMergePop(target.to);
    playDiagonal();
  } else if (relicId === 'eraser') {
    flashCellVanish(target.cell);
    playEraser();
  }

  // Shatter feedback if triggered (cell flashes, no toast)
  const actsAfter = controller.getState().relicActivations || {};
  if ((actsAfter.shatter || 0) > (actsBefore.shatter || 0)) {
    if (relicId === 'diagonal_charge' && target && target.to !== undefined) {
      triggerShatterAnimation([target.to], boardBefore, controller.getBoard());
    }
  }

  if (res.state.lastStandUsed && res.res?.lastStandFired) {
    showLastStandMoment();
  }

  const ascensionsAfter = controller.getState().ascensions || [];
  if (ascensionsAfter.length > ascensionsLenBefore) {
    uiMoveLog = []; // clear rewind stack on Clean Slate trigger
    cancelTargeting();
    const lastAsc = ascensionsAfter[ascensionsAfter.length - 1];
    const survivorIndices = (relicId === 'diagonal_charge' && target && target.to !== undefined) ? [target.to] : [];
    if (survivorIndices.length === 0) {
      const bAfter = controller.getBoard();
      for (let i = 0; i < 16; i++) {
        if (typeof bAfter[i] === 'number' && bAfter[i] >= (controller.config?.ascensionAt || 2048)) {
          survivorIndices.push(i);
        }
      }
    }
    triggerCleanSlateSequence({
      survivorIndices,
      triggerValue: lastAsc ? lastAsc.value : 2048,
      payout: lastAsc ? lastAsc.payout : 0,
      triggerSite: 'ability',
      onComplete: () => {
        if (controller.isGameOver()) {
          handleGameOver();
        }
      }
    });
    return;
  }

  syncBoard(controller.getBoard(), 'ability');
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

  const owned = Array.from(controller.getState().relics);
  if (draftOwnedCount) draftOwnedCount.textContent = owned.length;
  if (draftEyebrowEl) draftEyebrowEl.textContent = `Move ${controller.getState().moveCount} · RELIC DRAFT`;

  const draftSubtitle = document.getElementById('draft-subtitle');
  if (draftSubtitle) {
    if (owned.length === 0) {
      draftSubtitle.textContent = 'Pick one. It stays for the whole run.';
      draftSubtitle.classList.remove('hidden');
    } else {
      draftSubtitle.textContent = 'One choice changes the rules of your run.';
    }
  }

  if (owned.length === 0) {
    draftOwnedChips.innerHTML = '<span class="no-relics-msg" style="font-size:11px; color:var(--muted);">None</span>';
  } else {
    for (const rid of owned) {
      const chip = document.createElement('div');
      chip.className = 'relic-mini art relic-chip';
      chip.setAttribute('data-relic', rid);
      chip.setAttribute('title', RELIC_NAMES[rid] || rid);
      chip.appendChild(getRelicIconElement(rid, 22));
      draftOwnedChips.appendChild(chip);
    }
  }

  // 3 Offer Cards
  for (const rid of decision.offers) {
    const card = document.createElement('div');
    card.className = 'draftcard draft-card draft-offer-card';
    card.tabIndex = 0;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'art draft-offer-icon-wrap';
    iconWrap.appendChild(getRelicIconElement(rid, 38));

    const details = document.createElement('div');
    details.className = 'draft-offer-details';
    details.innerHTML = `
      <div class="dname draft-offer-name">${RELIC_NAMES[rid] || rid}</div>
      <div class="ddesc draft-offer-desc">${getRelicOneLiner(rid, controller.config)}</div>
    `;

    const tag = document.createElement('span');
    tag.className = 'tag';
    const isAbility = rid === 'diagonal_charge' || rid === 'eraser' || rid === 'rewind';
    tag.textContent = isAbility ? 'Ability' : 'Passive';

    card.appendChild(iconWrap);
    card.appendChild(details);
    card.appendChild(tag);

    const selectRelic = () => {
      draftOverlay.classList.add('hidden');
      initAudio();
      playDraftPick();
      uiMoveLog = []; // clear rewind stack on draft pick
      const res = controller.resolveDecision(rid);
      showToast(`Relic acquired: ${RELIC_NAMES[rid] || rid}`);
      syncBoard(controller.getBoard(), 'draft-resolve');
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
  uiMoveLog = []; // clear rewind stack on Mason decision
  if (statusHintBar) statusHintBar.classList.add('mason-active');
  if (statusHintText) statusHintText.textContent = 'Mason: Choose where the stone lands (tap a glowing empty cell)';

  boardEl.classList.add('draftdim');
  for (const c of candidates) {
    const cellEl = boardEl.querySelector(`.cell[data-index="${c}"], .grid-cell[data-index="${c}"]`);
    if (cellEl) {
      cellEl.classList.add('mason-candidate', 'mason');
    }
  }
}

function clearMasonMode() {
  boardEl.classList.remove('draftdim');
  if (masonCandidates) {
    for (const c of masonCandidates) {
      const cellEl = boardEl.querySelector(`.cell[data-index="${c}"], .grid-cell[data-index="${c}"]`);
      if (cellEl) cellEl.classList.remove('mason-candidate', 'mason');
    }
    masonCandidates = null;
  }
  if (statusHintBar) statusHintBar.classList.remove('mason-active');
  if (statusHintText) statusHintText.textContent = activeHint ? activeHint.text : 'Swipe to move';
}

/* -------------------------------------------------------------
 * Move Handling & Step Execution
 * ------------------------------------------------------------- */
let currentAnimationState = null;

function finishCurrentAnimationImmediately() {
  if (cleanSlateSequenceState) {
    finishCleanSlateImmediately();
    return;
  }
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    return;
  }
  if (!isAnimating || !currentAnimationState) return;
  if (slideAnimTimer) {
    clearTimeout(slideAnimTimer);
    slideAnimTimer = null;
  }
  currentAnimationState.commitSlideCompletion();
}

function cancelCleanSlateSequence() {
  if (!cleanSlateSequenceState) return;
  const state = cleanSlateSequenceState;
  cleanSlateSequenceState = null;

  if (state.timers) {
    for (const t of state.timers) clearTimeout(t);
  }
  if (state.anims) {
    for (const a of state.anims) {
      try { a.cancel(); } catch { }
    }
  }
  if (state.ringEl && state.ringEl.parentNode) {
    state.ringEl.remove();
  }
  if (state.dustEls) {
    for (const d of state.dustEls) {
      if (d.parentNode) d.remove();
    }
  }
  if (state.popupEl && state.popupEl.parentNode) {
    state.popupEl.remove();
  }
  if (cleanSlateBanner) {
    cleanSlateBanner.classList.add('hidden');
  }
  if (tilesLayer) {
    for (const el of tilesLayer.querySelectorAll('.tile-clean-slate-survivor')) {
      el.classList.remove('tile-clean-slate-survivor');
    }
  }
  isAnimating = false;
  currentAnimationState = null;
}

function cancelOngoingAnimation() {
  if (cleanSlateSequenceState) {
    cancelCleanSlateSequence();
    return;
  }
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    return;
  }
  if (currentAnimationState && typeof currentAnimationState.cancelAnimation === 'function') {
    currentAnimationState.cancelAnimation();
  } else {
    if (slideAnimTimer) {
      clearTimeout(slideAnimTimer);
      slideAnimTimer = null;
    }
    for (const a of activeAnimations) {
      try { a.cancel(); } catch { }
    }
    activeAnimations = [];
    isAnimating = false;
    currentAnimationState = null;
  }
}

function handleMove(direction, inputType = 'key') {
  const dirMap = {
    'ArrowLeft': 'L', 'KeyA': 'L', 'left': 'L', 'L': 'L',
    'ArrowRight': 'R', 'KeyD': 'R', 'right': 'R', 'R': 'R',
    'ArrowUp': 'U', 'KeyW': 'U', 'up': 'U', 'U': 'U',
    'ArrowDown': 'D', 'KeyS': 'D', 'down': 'D', 'D': 'D',
  };
  direction = dirMap[direction] || direction;
  if (controller.isGameOver()) return;
  if (controller.hasPendingDecision()) return;

  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
    cleanSlateSequenceState.ignoredSwipeCount = (cleanSlateSequenceState.ignoredSwipeCount || 0) + 1;
    return;
  }

  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    rewindDirector.enqueueInput('move', { direction, inputType });
    return;
  }

  if (isAnimating) {
    finishCurrentAnimationImmediately();
  }

  cancelTargeting();
  dismissHint();
  controller.recordInput(inputType, direction);
  if (inputType !== 'swipe') {
    controller.events.push(`s:${direction}`);
  }
  initAudio();

  const boardBefore = controller.getBoard();
  const stateBefore = controller.getState();
  const actsBefore = { ...(stateBefore.relicActivations || {}) };
  const ascensionsLenBefore = (stateBefore.ascensions || []).length;

  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const relics = stateBefore.relics || new Set();
  const prediction = computeSlide(boardBefore, direction, {
    hasFaultLine: relics.has('fault_line'),
    hasSiphon: relics.has('siphon'),
    siphonMin: controller.config?.siphonMin ?? 16,
  });

  const moveRes = controller.submitMove(direction);
  if (!moveRes.success) {
    const isStuck = Boolean(controller.getState().stuckNeedsAbility);
    if (isStuck) {
      triggerStuckWave();
      playStuckThud(true);
      if (!prefersReducedMotion) {
        performBlockedNudge(direction);
      }
    }
    return;
  }

  const ascensionsAfter = controller.getState().ascensions || [];
  const cleanSlateTriggered = ascensionsAfter.length > ascensionsLenBefore;

  // Push to UI move log for Rewind playback
  if (cleanSlateTriggered) {
    uiMoveLog = []; // clear rewind stack on Clean Slate trigger
  } else {
    const logEntry = {
      dir: direction,
      boardBefore: [...boardBefore],
      boardAfterSlide: [...prediction.predictedBoard],
      boardAfter: [...controller.getBoard()],
      moves: prediction.moves,
    };
    uiMoveLog.push(logEntry);
    const maxDepth = controller.getRewindMaxDepth ? controller.getRewindMaxDepth() : 10;
    if (uiMoveLog.length > maxDepth) {
      uiMoveLog.splice(0, uiMoveLog.length - maxDepth);
    }
  }

  renderAbilityBar();

  const boardAfter = controller.getBoard();
  playSwipe(direction);

  // Score +N popup
  const earned = (controller.getState().points || 0) - (stateBefore.points || 0);
  if (earned > 0) {
    const merges = moveRes.stepResult?.merges || 1;
    showToast(`+${earned.toLocaleString('en-US')}${merges > 1 ? ' · CHAIN x' + Math.min(4, merges) : ''}`);
  }

  // Detect Fault Line shifted stones
  const shiftedStones = prediction.shiftedStones || [];
  const shiftedFromSet = new Set(shiftedStones.map(s => s.from));
  const shiftedToSet = new Set(shiftedStones.map(s => s.to));

  // Detect Shattered stones
  const actsAfter = controller.getState().relicActivations || {};
  const shatteredStoneSet = new Set();
  if ((actsAfter.shatter || 0) > (actsBefore.shatter || 0)) {
    for (let i = 0; i < 16; i++) {
      if (boardBefore[i] === STONE && boardAfter[i] !== STONE) {
        shatteredStoneSet.add(i);
      }
    }
  }

  // Diff cells for vanished stones (shatter / last_stand)
  if (!cleanSlateTriggered) {
    for (let i = 0; i < 16; i++) {
      if (boardBefore[i] === STONE && boardAfter[i] !== STONE) {
        if (!shatteredStoneSet.has(i)) {
          flashCellVanish(i);
        }
      }
    }
  }

  if (moveRes.stepResult?.lastStandFired) {
    showLastStandMoment();
    playLastStand();
  }

  // Check disagreement between prediction and actual board (ignoring shifted stones, shattered stones, last stand, and clean slate cleared tiles)
  let mismatch = false;
  const lastStandFired = Boolean(moveRes.stepResult?.lastStandFired);
  const lastStandMax = controller.config?.lastStandMax ?? 16;
  const ascThreshold = controller.config?.ascensionAt || 2048;
  for (let i = 0; i < 16; i++) {
    if (shiftedFromSet.has(i) || shiftedToSet.has(i) || shatteredStoneSet.has(i)) continue;
    if (lastStandFired && typeof prediction.predictedBoard[i] === 'number' && prediction.predictedBoard[i] <= lastStandMax && boardAfter[i] === 0) {
      continue;
    }
    if (cleanSlateTriggered && (prediction.predictedBoard[i] === STONE || (typeof prediction.predictedBoard[i] === 'number' && prediction.predictedBoard[i] < ascThreshold))) {
      continue;
    }
    if (prediction.predictedBoard[i] !== 0) {
      if (boardAfter[i] !== prediction.predictedBoard[i]) {
        mismatch = true;
        break;
      }
    } else if (prediction.skippedSpawn) {
      if (boardAfter[i] !== 0) {
        mismatch = true;
        break;
      }
    }
  }

  const siphonFired = (controller.getState().relicActivations?.siphon || 0) > (actsBefore.siphon || 0);
  if (siphonFired && passiveRelicsContainer) {
    const sIcon = passiveRelicsContainer.querySelector('[data-relic="siphon"]');
    if (sIcon) {
      sIcon.classList.remove('siphon-glow');
      void sIcon.offsetWidth;
      sIcon.classList.add('siphon-glow');
      setTimeout(() => sIcon?.classList.remove('siphon-glow'), 750);
    }
  }

  if ((mismatch && !cleanSlateTriggered) || (prefersReducedMotion && !cleanSlateTriggered) || !prediction.changed || prediction.moves.length === 0) {
    let reason = 'unknown';
    if (mismatch) reason = 'mismatch';
    else if (prefersReducedMotion) reason = 'prefers-reduced-motion';
    else if (!prediction.changed) reason = 'prediction-not-changed';
    else if (prediction.moves.length === 0) reason = 'no-moves';

    const isDebug = Boolean(window.__debug || new URLSearchParams(window.location.search || '').get('debug') === '1');
    if (isDebug) {
      window.__slideFallbackCount = (window.__slideFallbackCount || 0) + 1;
      window.__slideFallbackReason = reason;
      if (siphonFired) {
        window.__siphonDiag = {
          predictedBoard: [...prediction.predictedBoard],
          actualBoard: [...boardAfter],
          boardBefore: [...boardBefore],
          reason,
          siphonFired: true,
        };
      }
    }

    if (mismatch) {
      slideMismatchCount++;
      if (dbgSlideSkipsEl) dbgSlideSkipsEl.textContent = slideMismatchCount;
    }
    if (shatteredStoneSet.size > 0) {
      const mergeDests = [];
      const shatterThreshold = controller?.state?.config?.shatterMin ?? controller?.config?.shatterMin ?? activeConfig?.shatterMin ?? 64;
      for (let i = 0; i < 16; i++) {
        if (typeof boardAfter[i] === 'number' && boardAfter[i] >= shatterThreshold) {
          mergeDests.push(i);
        }
      }
      triggerShatterAnimation(mergeDests, boardBefore, boardAfter);
    }
    renderBoard(controller.getBoard());
    if (moveRes.stepResult?.merges) {
      playMerge(moveRes.stepResult?.highestMergedTile || 4, moveRes.stepResult?.merges);
    }
    const hasNewStone = boardBefore.filter(x => x === STONE).length < boardAfter.filter(x => x === STONE).length;
    if (hasNewStone) playStone();
    else playSpawn();
    postMoveResolution(moveRes);
    return;
  }

  isAnimating = true;
  let maxDelay = 0;
  const metrics = getGridMetrics();
  activeAnimations = [];
  const mergeTimers = [];

  // Group prediction moves by destination
  const destMap = new Map();
  for (const move of prediction.moves) {
    if (!destMap.has(move.toIndex)) destMap.set(move.toIndex, []);
    destMap.get(move.toIndex).push(move);
  }

  const movesToAnimate = [];
  const absorbedList = [];
  const survivorList = [];
  const normalMoveList = [];

  for (const [toIdx, movesForDest] of destMap.entries()) {
    if (movesForDest.length === 2) {
      // Merge
      const survivorMove = movesForDest[0];
      const absorbedMove = movesForDest[1];
      const survivorTile = tilesLayer.querySelector(`.tile[data-index="${survivorMove.fromIndex}"]:not(.absorbed)`);
      const absorbedTile = tilesLayer.querySelector(`.tile[data-index="${absorbedMove.fromIndex}"]:not(.absorbed)`);

      if (absorbedTile) {
        absorbedTile.classList.add('absorbed');
        absorbedTile.style.zIndex = '11';
        absorbedList.push({ tile: absorbedTile, fromIndex: absorbedMove.fromIndex });
        if (absorbedMove.fromIndex !== toIdx) {
          movesToAnimate.push({ tile: absorbedTile, move: absorbedMove, isAbsorbed: true });
        }
      }
      if (survivorTile) {
        survivorTile.style.zIndex = '12';
        if (survivorMove.fromIndex !== toIdx) {
          movesToAnimate.push({ tile: survivorTile, move: survivorMove, isSurvivor: true });
        }
      }
      survivorList.push({
        tile: survivorTile,
        absorbedTile: absorbedTile,
        toIndex: toIdx,
        resultValue: survivorMove.resultValue,
        lineIndex: Math.max(survivorMove.lineIndex, absorbedMove.lineIndex),
        merged: false
      });
    } else {
      const move = movesForDest[0];
      const tile = tilesLayer.querySelector(`.tile[data-index="${move.fromIndex}"]:not(.absorbed)`);
      if (tile) {
        tile.style.zIndex = '10';
        if (move.fromIndex !== toIdx) {
          movesToAnimate.push({ tile, move, isNormal: true });
          normalMoveList.push({ tile, fromIndex: move.fromIndex, toIndex: toIdx });
        }
      }
    }
  }

  // Animate moved tiles
  for (const { tile, move } of movesToAnimate) {
    if (!tile) continue;

    const fromCol = move.fromIndex % 4;
    const fromRow = Math.floor(move.fromIndex / 4);
    const toCol = move.toIndex % 4;
    const toRow = Math.floor(move.toIndex / 4);

    const deltaX = (toCol - fromCol) * metrics.stepX;
    const deltaY = (toRow - fromRow) * metrics.stepY;

    const overshootX = deltaX + (direction === 'L' ? -4 : direction === 'R' ? 4 : 0);
    const overshootY = deltaY + (direction === 'U' ? -4 : direction === 'D' ? 4 : 0);

    const delay = move.lineIndex * 35;
    if (delay > maxDelay) maxDelay = delay;

    const fromPos = getTileTranslate(move.fromIndex, metrics);
    const startX = fromPos.x;
    const startY = fromPos.y;
    const midX = fromPos.x + overshootX;
    const midY = fromPos.y + overshootY;
    const endX = fromPos.x + deltaX;
    const endY = fromPos.y + deltaY;

    const anim = tile.animate([
      { transform: `translate3d(${startX}px, ${startY}px, 0)`, offset: 0, easing: 'cubic-bezier(.2, .85, .3, 1)' },
      { transform: `translate3d(${midX}px, ${midY}px, 0)`, offset: 125 / 195, easing: 'cubic-bezier(.25, 1, .5, 1)' },
      { transform: `translate3d(${endX}px, ${endY}px, 0)`, offset: 1 }
    ], {
      duration: 195,
      delay: delay,
      fill: 'forwards'
    });
    activeAnimations.push(anim);
  }

  // Animate Fault Line shifted stones as one-cell slide (same easing, no pop)
  for (const { from, to } of shiftedStones) {
    const stoneEl = tilesLayer.querySelector(`.stone[data-index="${from}"]`);
    if (stoneEl) {
      stoneEl.style.zIndex = '10';
      stoneEl.setAttribute('data-index', String(to));
      const fromPos = getTileTranslate(from, metrics);
      const toPos = getTileTranslate(to, metrics);
      const deltaX = toPos.x - fromPos.x;
      const deltaY = toPos.y - fromPos.y;
      const overshootX = deltaX + (direction === 'L' ? -4 : direction === 'R' ? 4 : 0);
      const overshootY = deltaY + (direction === 'U' ? -4 : direction === 'D' ? 4 : 0);
      const startX = fromPos.x;
      const startY = fromPos.y;
      const midX = fromPos.x + overshootX;
      const midY = fromPos.y + overshootY;
      const endX = toPos.x;
      const endY = toPos.y;

      const anim = stoneEl.animate([
        { transform: `translate3d(${startX}px, ${startY}px, 0)`, offset: 0, easing: 'cubic-bezier(.2, .85, .3, 1)' },
        { transform: `translate3d(${midX}px, ${midY}px, 0)`, offset: 125 / 195, easing: 'cubic-bezier(.25, 1, .5, 1)' },
        { transform: `translate3d(${endX}px, ${endY}px, 0)`, offset: 1 }
      ], {
        duration: 195,
        fill: 'forwards'
      });
      activeAnimations.push(anim);
    }
  }

  // T2: Merge Pop at meeting frame (~125 ms + line stagger)
  for (const s of survivorList) {
    const meetingDelay = s.lineIndex * 35 + 125;
    const timer = setTimeout(() => {
      s.merged = true;
      // In the SAME frame:
      // (1) remove absorbed tile
      if (s.absorbedTile && s.absorbedTile.parentNode) {
        s.absorbedTile.remove();
      }
      // (2) set survivor's value/class to merged one
      if (s.tile) {
        s.tile.className = `tile ${getTileClasses(s.resultValue)}`;
        s.tile.setAttribute('data-val', String(s.resultValue));
        const face = s.tile.querySelector('.tile-face');
        if (face) {
          face.className = `tile-face ${getTileClasses(s.resultValue)}`;
          face.textContent = s.resultValue;
          // (3) play pop on .tile-face: scale 1 -> 1.16 -> 1 over ~140 ms (ease-out, no oscillation)
          const popAnim = face.animate([
            { transform: 'scale(1)', offset: 0 },
            { transform: 'scale(1.16)', offset: 0.45, easing: 'ease-out' },
            { transform: 'scale(1)', offset: 1, easing: 'ease-out' }
          ], {
            duration: 140,
            easing: 'ease-out'
          });
          activeAnimations.push(popAnim);
        }
      }
    }, meetingDelay);
    mergeTimers.push(timer);
  }

  let committed = false;
  function cancelAnimation() {
    if (committed) return;
    committed = true;
    if (slideAnimTimer) {
      clearTimeout(slideAnimTimer);
      slideAnimTimer = null;
    }
    for (const t of mergeTimers) {
      clearTimeout(t);
    }
    for (const a of activeAnimations) {
      try { a.cancel(); } catch { }
    }
    activeAnimations = [];
    isAnimating = false;
    currentAnimationState = null;
  }
  function commitSlideCompletion() {
    if (committed) return;
    committed = true;
    if (slideAnimTimer) {
      clearTimeout(slideAnimTimer);
      slideAnimTimer = null;
    }
    for (const t of mergeTimers) {
      clearTimeout(t);
    }

    for (const a of activeAnimations) {
      try { a.cancel(); } catch { }
    }
    activeAnimations = [];

    // Remove any remaining absorbed tiles immediately
    for (const item of absorbedList) {
      if (item.tile && item.tile.parentNode) {
        item.tile.remove();
      }
    }

    // Update normal moved tiles
    for (const { tile, toIndex } of normalMoveList) {
      if (tile) {
        const trans = getTileTranslate(toIndex, metrics);
        tile.style.transform = trans.transform;
        tile.style.zIndex = '';
        tile.setAttribute('data-index', String(toIndex));
      }
    }

    // Update survivor tiles in place
    for (const s of survivorList) {
      if (s.tile) {
        const trans = getTileTranslate(s.toIndex, metrics);
        s.tile.style.transform = trans.transform;
        s.tile.style.zIndex = '';
        s.tile.className = `tile ${getTileClasses(s.resultValue)}`;
        s.tile.setAttribute('data-val', String(s.resultValue));
        s.tile.setAttribute('data-index', String(s.toIndex));
        s.tile.setAttribute('aria-label', `Tile ${s.resultValue}`);
        const face = s.tile.querySelector('.tile-face');
        if (face) {
          face.className = `tile-face ${getTileClasses(s.resultValue)}`;
          face.textContent = s.resultValue;
        }
      }
    }

    // Clean up vanished low tiles if Last Stand fired
    if (lastStandFired) {
      for (let i = 0; i < 16; i++) {
        if (boardAfter[i] === 0) {
          const el = tilesLayer.querySelector(`.tile[data-index="${i}"]:not(.stone)`);
          if (el) el.remove();
        }
      }
    }

    // Spawn new tiles/stones into #tiles-layer
    let spawnedStone = false;
    let spawnedTile = false;
    if (!cleanSlateTriggered) {
      for (let i = 0; i < 16; i++) {
        const v = boardAfter[i];
        const hasTileAtI = Array.from(tilesLayer.children).some(el => {
          if (el.getAttribute('data-index') !== String(i)) return false;
          if (el.classList.contains('shattering-stone') || el.classList.contains('duplicate')) return false;
          const isElStone = el.classList.contains('stone');
          const isExpectedStone = (v === STONE);
          return isElStone === isExpectedStone;
        });
        if (v !== 0 && !hasTileAtI) {
          const isStone = (v === STONE);
          if (isStone) spawnedStone = true;
          else spawnedTile = true;
          const newEl = createTileElement(i, v, true, metrics);
          tilesLayer.appendChild(newEl);
        }
      }
    }

    // Update shifted stones in place
    for (const { to } of shiftedStones) {
      const stoneEl = tilesLayer.querySelector(`.stone[data-index="${to}"]`);
      if (stoneEl) {
        if (typeof stoneEl.getAnimations === 'function') {
          for (const a of stoneEl.getAnimations()) a.cancel();
        }
        const trans = getTileTranslate(to, metrics);
        stoneEl.style.transform = trans.transform;
        stoneEl.style.zIndex = '';
      }
    }

    // Play sounds
    if (survivorList.length > 0) {
      const maxVal = Math.max(...survivorList.map(s => s.resultValue));
      playMerge(maxVal, survivorList.length);
    }
    // Animate newly appeared stone (skipping shifted stones)
    for (let i = 0; i < 16; i++) {
      if (boardBefore[i] !== STONE && boardAfter[i] === STONE && !shiftedToSet.has(i)) {
        animateStoneSpawn(i);
      }
    }
    if (!spawnedStone && spawnedTile) {
      playSpawn();
    }

    // Trigger Shatter break animation if triggered
    const actsAfter = controller.getState().relicActivations || {};
    if ((actsAfter.shatter || 0) > (actsBefore.shatter || 0)) {
      const mergeDests = survivorList.map(s => s.toIndex);
      triggerShatterAnimation(mergeDests, boardBefore, boardAfter);
    }

    if (cleanSlateTriggered) {
      uiMoveLog = []; // clear rewind stack on Clean Slate
      const ascensions = controller.getState().ascensions || [];
      const lastAsc = ascensions[ascensions.length - 1];
      const survivorDests = survivorList.filter(s => s.resultValue >= (controller.config?.ascensionAt || 2048)).map(s => s.toIndex);
      if (survivorDests.length === 0) {
        for (let i = 0; i < 16; i++) {
          if (typeof boardAfter[i] === 'number' && boardAfter[i] >= (controller.config?.ascensionAt || 2048)) {
            survivorDests.push(i);
          }
        }
      }
      triggerCleanSlateSequence({
        survivorIndices: survivorDests,
        triggerValue: lastAsc ? lastAsc.value : 2048,
        payout: lastAsc ? lastAsc.payout : 0,
        onComplete: () => {
          postMoveResolution(moveRes);
        }
      });
      return;
    }

    // Authoritative DOM reconcile
    syncBoard(boardAfter, 'slideFinish');

    isAnimating = false;
    currentAnimationState = null;
    postMoveResolution(moveRes);

    if (typeof rewindDirector !== 'undefined' && (rewindDirector.getState() === 'WAIT_SLIDE' || rewindDirector.queue.length > 0)) {
      rewindDirector.onSlideAnimationComplete();
    }
  }

  currentAnimationState = { commitSlideCompletion, cancelAnimation };

  if (activeAnimations.length === 0) {
    commitSlideCompletion();
  } else {
    Promise.all(activeAnimations.map(anim => {
      if (typeof anim.finished?.then === 'function') {
        return anim.finished.catch(() => { });
      }
      return Promise.resolve();
    })).then(() => {
      commitSlideCompletion();
    });

    slideAnimTimer = setTimeout(() => {
      commitSlideCompletion();
    }, maxDelay + 265);
  }
}

function postMoveResolution(res) {
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
  tickPlayTimer();
  isRunActive = false;
  if (playTimerInterval) {
    clearInterval(playTimerInterval);
    playTimerInterval = null;
  }
  const metadata = getDiagnosticMetadata();
  currentRunLog = controller.getRunLog(metadata);
  currentRunLog.activeMs = Math.round(activePlayMs);
  saveRunToHistory(currentRunLog);
  saveTopRun({
    runId: currentRunLog.runId || (currentRunLog.timestamp ? `run_${currentRunLog.timestamp}` : `run_${Date.now()}`),
    points: currentRunLog.points || 0,
    moves: currentRunLog.totalMoves ?? currentRunLog.moves ?? 0,
    maxTile: currentRunLog.maxTile || 2,
    relics: Array.isArray(currentRunLog.relicsOwned) ? [...currentRunLog.relicsOwned] : [],
    endedAt: currentRunLog.timestamp || new Date().toISOString(),
    activeMs: currentRunLog.activeMs,
    eventsCount: Array.isArray(currentRunLog.events) ? currentRunLog.events.length : 0,
  });

  // Score headline & local storage best score check
  const storedBest = getStoredBestScore();
  const currentPoints = currentRunLog.points || 0;
  const isNewBest = persistenceEnabled && currentPoints > storedBest;
  if (isNewBest) {
    saveStoredBestScore(currentPoints);
    if (endNewBestBadge) endNewBestBadge.classList.remove('hidden');
  } else {
    if (endNewBestBadge) endNewBestBadge.classList.add('hidden');
  }
  if (endScoreEl) endScoreEl.textContent = currentPoints.toLocaleString('en-US');

  const ascensions = controller.getState().ascensions || [];
  if (endCleanSlateChip) {
    if (ascensions.length >= 1) {
      endCleanSlateChip.textContent = `CLEAN SLATE x ${ascensions.length}`;
      endCleanSlateChip.classList.remove('hidden');
    } else {
      endCleanSlateChip.classList.add('hidden');
    }
  }

  // Mini board preview: remove glyphs, keep texture
  if (endMiniBoard) {
    endMiniBoard.innerHTML = '';
    const finalBoard = controller.getBoard();
    for (let i = 0; i < 16; i++) {
      const v = finalBoard[i];
      const sp = document.createElement('span');
      if (v === STONE) {
        sp.className = 'ms stone mini-stone';
        sp.setAttribute('aria-label', 'Permanent stone');
      } else if (typeof v === 'number' && v > 0) {
        sp.textContent = v;
      }
      endMiniBoard.appendChild(sp);
    }
  }

  playGameOver();

  if (endMovesEl) endMovesEl.textContent = currentRunLog.totalMoves;
  if (endMaxTileEl) endMaxTileEl.textContent = currentRunLog.maxTile;
  if (endDraftsEl) endDraftsEl.textContent = currentRunLog.draftsSeen;
  if (endSeedEl) endSeedEl.textContent = currentRunLog.seed;
  if (endTimeEl) endTimeEl.textContent = formatPlayTime(activePlayMs);

  if (endRelicsList) {
    endRelicsList.innerHTML = '';
    if (currentRunLog.relicsOwned.length === 0) {
      endRelicsList.innerHTML = '<span class="no-relics-msg" style="font-size:11px; color:var(--muted);">No relics drafted</span>';
    } else {
      for (const rid of currentRunLog.relicsOwned) {
        const chip = document.createElement('div');
        chip.className = 'relic-mini art relic-chip';
        chip.setAttribute('data-relic', rid);
        chip.setAttribute('title', RELIC_NAMES[rid] || rid);
        chip.appendChild(getRelicIconElement(rid, 22));
        endRelicsList.appendChild(chip);
      }
    }
  }

  if (dailyRunActive) {
    if (btnPlayDailyAgain) btnPlayDailyAgain.classList.remove('hidden');
    if (btnPlayAgain) btnPlayAgain.classList.add('hidden');
  } else {
    if (btnPlayDailyAgain) btnPlayDailyAgain.classList.add('hidden');
    if (btnPlayAgain) btnPlayAgain.classList.remove('hidden');
  }

  const rkPanel = document.getElementById('global-ranking-panel');
  const endSeedLabel = document.getElementById('end-seed-label');

  if (!window.__LB || !window.__LB.url || !window.__LB.anonKey) {
    if (rkPanel) rkPanel.classList.add('hidden');
    if (endLeaderboardStatus) {
      endLeaderboardStatus.classList.add('hidden');
      endLeaderboardStatus.textContent = '';
    }
    if (endSeedLabel) endSeedLabel.textContent = 'RUN SEED';
    if (endSeedEl) endSeedEl.textContent = currentRunLog.seed;
  } else {
    if (rkPanel) rkPanel.classList.remove('hidden');

    if (!dailyRunActive) {
      if (endSeedLabel) endSeedLabel.textContent = 'RUN SEED';
      if (endSeedEl) endSeedEl.textContent = currentRunLog.seed;
      renderGameOverRankingCard(8, {
        isForbidden: !canShowDailyButton(),
        moves: currentRunLog?.totalMoves ?? currentRunLog?.moves ?? 0,
        runLog: currentRunLog,
      });
      if (endLeaderboardStatus) {
        endLeaderboardStatus.classList.add('hidden');
        endLeaderboardStatus.textContent = '';
      }
    } else {
      if (endSeedLabel) endSeedLabel.textContent = 'RUN';
      if (endSeedEl) endSeedEl.textContent = `DAILY · ${formatDayShort(dailyRunStartDay)} UTC`;

      if (persistenceEnabled && canShowDailyButton()) {
        const reallyEnded = controller && (controller.isGameOver() || (controller.state && controller.state.endedByPlayer));
        if (reallyEnded && dailyRunStartDay) {
          const now = Date.now();
          const today = new Date(now);
          const yesterday = new Date(now - 86400000);
          const validDays = new Set([utcDateString(today), utcDateString(yesterday)]);

          // If run was started before midnight but submitted after two midnights, drop as stale
          if (!validDays.has(dailyRunStartDay)) {
            if (endLeaderboardStatus) {
              endLeaderboardStatus.classList.remove('hidden');
              endLeaderboardStatus.textContent = 'Not accepted';
            }
            renderGameOverRankingCard(7, { day: dailyRunStartDay });
          } else {
            const day = dailyRunStartDay;
            const points = currentRunLog.points || 0;
            const moves = currentRunLog.totalMoves ?? currentRunLog.moves ?? 0;
            displayedRunId = currentRunLog.runId || null;

            if (shouldSubmitRun(day, points, moves, localStorage)) {
              if (endLeaderboardStatus) {
                endLeaderboardStatus.classList.remove('hidden');
                endLeaderboardStatus.textContent = 'Sending…';
              }
              renderGameOverRankingCard(1, { day });
              enqueueSubmission({
                runId: currentRunLog.runId || `run_${Date.now()}`,
                day,
                runLog: currentRunLog,
              }, localStorage, persistenceEnabled);

              flushLeaderboardQueue(endLeaderboardStatus, false, displayedRunId);
            } else {
              // F4: NOT-BETTER STATE
              const best = getStoredDailyBest(day, localStorage);
              const bestPoints = best ? best.points : points;
              if (endLeaderboardStatus) {
                endLeaderboardStatus.classList.remove('hidden');
                endLeaderboardStatus.textContent = `Not sent · your best today is ${bestPoints}`;
              }
              renderGameOverRankingCard(4, { bestPoints, bestRank: null, day });

              // Look up rank of stored best to populate rank number
              const url = window.__LB.url;
              const anonKey = window.__LB.anonKey;
              const devId = getDeviceId(localStorage, persistenceEnabled);
              fetchMyRank({
                url,
                anonKey,
                tab: 'today',
                deviceId: devId,
                day,
                fetchFn: window.fetch.bind(window),
              }).then(rankRes => {
                if (rankRes.ok && rankRes.row) {
                  renderGameOverRankingCard(4, { bestPoints, bestRank: rankRes.row.rank, day });
                }
              }).catch(() => { });
            }
          }
        }
      } else {
        renderGameOverRankingCard(8, {
        isForbidden: !canShowDailyButton(),
        moves: currentRunLog?.totalMoves ?? currentRunLog?.moves ?? 0,
        runLog: currentRunLog,
      });
      }
    }
  }

  endOverlay.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * Run Initialization
 * ------------------------------------------------------------- */
function startNewGame(seed = null, isDaily = false) {
  dailyRunActive = Boolean(isDaily);
  stopDailyCountdown();

  if (isDaily) {
    dailyRunStartDay = utcDateString(new Date());
  } else {
    dailyRunStartDay = null;
  }

  if (typeof rewindDirector !== 'undefined') {
    rewindDirector.hardReset();
  }
  cancelOngoingAnimation();
  tickPlayTimer();
  activePlayMs = 0;
  lastPerfTime = performance.now();
  isRunActive = true;
  lastDisplayedSecond = -1;
  if (endTimeEl) endTimeEl.textContent = '0:00';
  if (pauseTimeVal) pauseTimeVal.textContent = '0:00';
  startPlayTimer();

  const configToUse = isDaily ? getDailyCanonicalConfig() : activeConfig;
  const chosenSeed = seed !== null
    ? seed
    : (isDaily
      ? dailySeed(dailyRunStartDay)
      : (initialSeed !== null ? initialSeed : Math.floor(Math.random() * 2147483647) + 1));
  const bestScore = getStoredBestScore();
  controller = new GameController(chosenSeed, configToUse, playerId);
  controller.bestScoreAtRunStart = bestScore;
  window.controller = controller;

  if (startBestScoreEl) startBestScoreEl.textContent = bestScore.toLocaleString('en-US');

  if (startOverlay) startOverlay.classList.add('hidden');
  if (endOverlay) endOverlay.classList.add('hidden');
  if (draftOverlay) draftOverlay.classList.add('hidden');
  if (pauseOverlay) pauseOverlay.classList.add('hidden');
  if (cleanSlateBanner) cleanSlateBanner.classList.add('hidden');
  if (endCleanSlateChip) endCleanSlateChip.classList.add('hidden');
  clearMasonMode();
  cancelTargeting();

  cancelOngoingAnimation();
  uiMoveLog = []; // clear rewind stack on new game
  isAnimating = false;
  currentAnimationState = null;
  if (tilesLayer) {
    tilesLayer.innerHTML = '';
  }
  if (boardEl) {
    for (const cell of boardEl.querySelectorAll('.cell')) {
      cell.innerHTML = '';
      cell.className = 'cell grid-cell';
    }
  }

  window.controller = controller;
  window.renderBoard = renderBoard;
  window.syncBoard = syncBoard;
  window.updateHeader = updateHeader;
  window.renderAbilityBar = renderAbilityBar;
  window.showRelicPopover = showRelicPopover;
  window.startTargeting = startTargeting;
  window.cancelTargeting = cancelTargeting;
  window.showDraftModal = showDraftModal;
  window.handleGameOver = handleGameOver;
  window.startNewGame = startNewGame;
  window.handleMove = handleMove;
  window.triggerShatterAnimation = triggerShatterAnimation;
  window.showLastStandMoment = showLastStandMoment;
  window.triggerCleanSlateSequence = triggerCleanSlateSequence;
  window.finishCleanSlateImmediately = finishCleanSlateImmediately;
  window.activateMasonMode = activateMasonMode;
  window.clearMasonMode = clearMasonMode;
  window.performBlockedNudge = performBlockedNudge;
  window.executeRewind = executeRewind;
  window.executeAbility = executeAbility;
  window.getCellCenter = getCellCenter;
  window.getGridMetrics = getGridMetrics;
  window.getTileTranslate = getTileTranslate;
  window.executeEraserAbility = executeEraserAbility;
  window.animateStoneSpawn = animateStoneSpawn;
  window.handleMove = handleMove;
  window.computeSlide = computeSlide;
  window.cleanupAbilityFocus = cleanupAbilityFocus;
  window.showFirstTimeHint = showFirstTimeHint;
  window.showHazardPopover = showHazardPopover;
  window.getActivePlayMs = () => activePlayMs;
  window.formatPlayTime = formatPlayTime;
  window.getCurrentRunLog = () => currentRunLog;
  window.getDiagnosticMetadata = getDiagnosticMetadata;
  window.getUiMoveLogLength = () => uiMoveLog.length;
  Object.defineProperty(window, 'activeTargeting', {
    get: () => activeTargeting,
    set: (v) => { activeTargeting = v; },
    configurable: true
  });
  Object.defineProperty(window, 'isAnimating', {
    get: () => isAnimating,
    set: (v) => { isAnimating = v; },
    configurable: true
  });
  Object.defineProperty(window, 'cleanSlateSequenceState', {
    get: () => cleanSlateSequenceState,
    set: (v) => { cleanSlateSequenceState = v; },
    configurable: true
  });

  syncBoard(controller.getBoard(), 'initialRender');
  updateHeader();
  renderGhostTiles();
  renderAbilityBar();

  if (controller.state.moveCount === 0) {
    showFirstTimeHint('hint1', 'Swipe to slide tiles. Equal tiles merge.');
  }
}

/* -------------------------------------------------------------
 * Input Listeners
 * ------------------------------------------------------------- */
// Keyboard Controls
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (relicPopover && !relicPopover.classList.contains('hidden')) {
      e.preventDefault();
      hideRelicPopover();
      return;
    }
    if (activeTargeting) {
      e.preventDefault();
      cancelTargeting(true);
      return;
    }
    if (pauseOverlay && !pauseOverlay.classList.contains('hidden')) {
      const bro = document.getElementById('best-runs-overlay');
      if (bro && !bro.classList.contains('hidden')) return;
      e.preventDefault();
      if (pendingPauseAction !== null) {
        closePauseConfirm(true);
      } else {
        closePauseOverlay();
      }
      return;
    }
  }

  if (
    e.key === 'Tab' &&
    pauseOverlay &&
    !pauseOverlay.classList.contains('hidden') &&
    !(bestRunsOverlay && !bestRunsOverlay.classList.contains('hidden'))
  ) {
    trapPauseFocus(e);
    return;
  }

  if (
    (startOverlay && !startOverlay.classList.contains('hidden')) ||
    (endOverlay && !endOverlay.classList.contains('hidden')) ||
    (draftOverlay && !draftOverlay.classList.contains('hidden')) ||
    (pauseOverlay && !pauseOverlay.classList.contains('hidden'))
  ) {
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
  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) return;
  // Mason placement
  if (masonCandidates && controller.hasPendingDecision()) {
    const cellEl = e.target.closest('.grid-cell') || e.target.closest('.cell');
    if (!cellEl) return;
    const idx = parseInt(cellEl.getAttribute('data-index'), 10);
    if (!isNaN(idx) && masonCandidates.includes(idx)) {
      controller.recordInput('tap');
      clearMasonMode();
      uiMoveLog = [];
      const res = controller.resolveDecision(idx);
      syncBoard(controller.getBoard(), 'decision-resolve');
      animateStoneSpawn(idx);
      postMoveResolution(res);
    }
    return;
  }

  // Ability targeting mode
  if (activeTargeting) {
    controller.recordInput('tap');
    const targetEl = e.target.closest('.tile') || e.target.closest('.grid-cell') || e.target.closest('.cell');
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
          if (targetingInstruction) targetingInstruction.textContent = 'Tap the equal tile diagonal to it';
          if (statusHintText) statusHintText.textContent = 'Now tap one of the glowing equal diagonal partners.';
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
              const metrics = getGridMetrics();
              const fromPos = getTileTranslate(fromCell, metrics);
              const toPos = getTileTranslate(toCell, metrics);
              const deltaX = toPos.x - fromPos.x;
              const deltaY = toPos.y - fromPos.y;
              fromTile.animate([
                { transform: `translate3d(${fromPos.x}px, ${fromPos.y}px, 0)` },
                { transform: `translate3d(${fromPos.x + deltaX}px, ${fromPos.y + deltaY}px, 0)` }
              ], { duration: 110, easing: 'ease', fill: 'forwards' });
            }
            setTimeout(() => {
              executeAbility('diagonal_charge', { from: fromCell, to: toCell });
            }, 110);
          } else {
            const isOtherCandidate = legalTargets.some(t => t.from === cellIdx);
            if (isOtherCandidate) {
              activeTargeting.selectedCell = cellIdx;
              if (targetingInstruction) targetingInstruction.textContent = 'Tap the equal tile diagonal to it';
              if (statusHintText) statusHintText.textContent = 'Now tap one of the glowing equal diagonal partners.';
              highlightTargetingBoard();
            } else {
              cancelTargeting();
            }
          }
        }
      }
    } else if (relicId === 'eraser') {
      // T3: ONE tap on a tile erases it immediately
      const isLegal = legalTargets.some(t => t.cell === cellIdx);
      if (isLegal) {
        executeEraserAbility(cellIdx);
      } else {
        cancelTargeting();
      }
    }
  }
});

function executeEraserAbility(cellIdx) {
  if (isAnimating) {
    finishCurrentAnimationImmediately();
  }
  playEraser();

  const tileEl = tilesLayer ? tilesLayer.querySelector(`.tile[data-index="${cellIdx}"]`) : null;
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Immediate state update
  const res = controller.useAbility('eraser', { cell: cellIdx });
  cancelTargeting();

  if (!res.success) {
    showToast(`Error: ${res.error || 'Failed to erase'}`);
    return;
  }

  if (tileEl) {
    if (prefersReduced) {
      tileEl.remove();
    } else {
      const face = tileEl.querySelector('.tile-face');
      if (face) {
        face.animate([
          { transform: 'scale(1)', opacity: 1 },
          { transform: 'scale(0.6)', opacity: 0 }
        ], { duration: 240, easing: 'ease-out', fill: 'forwards' });
      }

      const metrics = getGridMetrics();
      const cellPos = getCellCenter(cellIdx, metrics);
      const cx = cellPos.cx;
      const cy = cellPos.cy;
      const faceStyle = face ? window.getComputedStyle(face) : null;
      const tileBg = (faceStyle && faceStyle.backgroundColor && faceStyle.backgroundColor !== 'rgba(0, 0, 0, 0)')
        ? faceStyle.backgroundColor
        : '#f2c77e';

      for (let d = 0; d < 8; d++) {
        const dust = document.createElement('div');
        dust.className = 'eraser-dust';
        const size = Math.floor(4 + Math.random() * 3); // 4-6 px
        dust.style.width = size + 'px';
        dust.style.height = size + 'px';
        dust.style.background = tileBg;
        dust.style.borderRadius = '1px';
        dust.style.left = (cx - size / 2) + 'px';
        dust.style.top = (cy - size / 2) + 'px';
        tilesLayer.appendChild(dust);

        const angle = (d / 8) * 2 * Math.PI + (Math.random() * 0.4 - 0.2);
        const dist = 18 + Math.random() * 16; // 18-34 px outward
        const tx = Math.cos(angle) * dist;
        const ty = Math.sin(angle) * dist;

        dust.animate([
          { transform: 'translate(0px, 0px)', opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px)`, opacity: 0 }
        ], { duration: 240, easing: 'ease-out', fill: 'forwards' });

        setTimeout(() => dust.remove(), 260);
      }

      setTimeout(() => {
        if (tileEl.parentNode) tileEl.remove();
      }, 240);
    }
  }

  updateHeader();
  renderGhostTiles();
  renderAbilityBar();
  syncBoard(controller.getBoard(), 'initialRender');
}

// Cancel targeting button
if (btnCancelTargeting) {
  btnCancelTargeting.addEventListener('click', () => {
    controller.recordInput('tap');
    cancelTargeting();
  });
}

// Pause Menu controls
let pendingPauseAction = null; // 'restart' | 'end' | null
let lastFocusBeforeConfirm = null;
let lastFocusBeforePause = null;

function setPauseBackgroundInert(isInert) {
  const card = pauseOverlay ? pauseOverlay.querySelector('.pause-card') : null;
  if (!card) return;
  Array.from(card.children).forEach((child) => {
    if (child !== pauseConfirmView) {
      child.inert = Boolean(isInert);
      if (isInert) child.setAttribute('aria-hidden', 'true');
      else child.removeAttribute('aria-hidden');
    }
  });
}

function getPauseConfirmCopy(action, isDaily) {
  if (action === 'restart') {
    return {
      eyebrow: 'CONFIRM RESTART',
      title: 'RESTART RUN?',
      desc: isDaily
        ? 'Discards this Daily run with no submission or record, and starts a fresh Daily run for the current UTC date.'
        : 'Discards this run with no record saved and starts a fresh Free run.',
      confirmLabel: 'RESTART RUN',
    };
  }
  return {
    eyebrow: 'CONFIRM END RUN',
    title: 'END RUN?',
    desc: isDaily
      ? 'Ends this Daily run now, saves it to Best Runs, and counts toward today\'s Daily ranking if it beats your best.'
      : 'Ends this Free run now and saves it to Best Runs. Free runs are not ranked.',
    confirmLabel: 'END RUN',
  };
}

function openPauseConfirm(action, triggerBtn = null) {
  pendingPauseAction = action;
  lastFocusBeforeConfirm = triggerBtn || document.activeElement;
  const copy = getPauseConfirmCopy(action, dailyRunActive);
  if (pauseConfirmEyebrow) pauseConfirmEyebrow.textContent = copy.eyebrow;
  if (pauseConfirmTitle) pauseConfirmTitle.textContent = copy.title;
  if (pauseConfirmDesc) pauseConfirmDesc.textContent = copy.desc;
  if (btnPauseConfirmExecute) btnPauseConfirmExecute.textContent = copy.confirmLabel;

  setPauseBackgroundInert(true);
  if (pauseConfirmView) {
    pauseConfirmView.classList.remove('hidden');
    pauseConfirmView.setAttribute('aria-hidden', 'false');
    void pauseConfirmView.offsetWidth;
  }
  if (btnPauseConfirmCancel) {
    btnPauseConfirmCancel.focus();
  }
}

function closePauseConfirm(restoreFocus = true) {
  pendingPauseAction = null;
  if (pauseConfirmView) {
    pauseConfirmView.classList.add('hidden');
    pauseConfirmView.setAttribute('aria-hidden', 'true');
  }
  setPauseBackgroundInert(false);
  if (restoreFocus && lastFocusBeforeConfirm && typeof lastFocusBeforeConfirm.focus === 'function') {
    void pauseOverlay?.offsetWidth;
    lastFocusBeforeConfirm.focus();
  }
  lastFocusBeforeConfirm = null;
}

function getPauseFocusables() {
  if (!pauseOverlay || pauseOverlay.classList.contains('hidden')) return [];
  const scope = (pendingPauseAction !== null && pauseConfirmView) ? pauseConfirmView : pauseOverlay;
  return Array.from(scope.querySelectorAll('button:not([disabled]):not([aria-disabled="true"])')).filter((el) => {
    if (pendingPauseAction === null && pauseConfirmView && pauseConfirmView.contains(el)) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
}

function trapPauseFocus(e) {
  const focusables = getPauseFocusables();
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!focusables.includes(active)) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (e.shiftKey) {
    if (active === first) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last) {
    e.preventDefault();
    first.focus();
  }
}

function closePauseOverlay(restoreFocus = true) {
  closePauseConfirm(false);
  if (pauseOverlay) pauseOverlay.classList.add('hidden');
  lastPerfTime = performance.now();
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    rewindDirector.resume();
  } else {
    if (isAnimating || cleanSlateSequenceState) {
      finishCurrentAnimationImmediately();
    }
    if (controller) {
      syncBoard(controller.getBoard(), 'pauseResume');
    }
  }
  if (restoreFocus && lastFocusBeforePause && typeof lastFocusBeforePause.focus === 'function') {
    lastFocusBeforePause.focus();
  }
  lastFocusBeforePause = null;
}

if (btnPauseMenu && pauseOverlay) {
  btnPauseMenu.addEventListener('click', () => {
    controller.recordInput('tap');
    if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
      rewindDirector.pause();
    } else if (isAnimating || cleanSlateSequenceState) {
      finishCurrentAnimationImmediately();
    }
    tickPlayTimer();
    lastFocusBeforePause = btnPauseMenu;
    closePauseConfirm(false);
    if (pauseTimeVal) pauseTimeVal.textContent = formatPlayTime(activePlayMs);
    pauseOverlay.classList.remove('hidden');
    void pauseOverlay.offsetWidth;
    if (btnPauseResume) btnPauseResume.focus();
  });
}

if (btnPauseResume && pauseOverlay) {
  btnPauseResume.addEventListener('click', () => {
    closePauseOverlay(true);
  });
}

// Reconcile board DOM on visibilitychange
document.addEventListener('visibilitychange', () => {
  tickPlayTimer();
  if (document.visibilityState === 'visible') {
    lastPerfTime = performance.now();
  }
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    // Rule C8: Page hidden: do nothing special; on return the sequence continues normally
    return;
  }
  if (isAnimating || cleanSlateSequenceState) {
    finishCurrentAnimationImmediately();
  }
  if (controller) {
    syncBoard(controller.getBoard(), 'visibilityChange');
  }
});

if (btnPauseRestart && pauseOverlay) {
  btnPauseRestart.addEventListener('click', () => {
    controller.recordInput('tap');
    openPauseConfirm('restart', btnPauseRestart);
  });
}

if (btnPauseEndRun && pauseOverlay) {
  btnPauseEndRun.addEventListener('click', () => {
    controller.recordInput('tap');
    openPauseConfirm('end', btnPauseEndRun);
  });
}

if (btnPauseConfirmCancel) {
  btnPauseConfirmCancel.addEventListener('click', () => {
    closePauseConfirm(true);
  });
}

if (btnPauseConfirmExecute) {
  btnPauseConfirmExecute.addEventListener('click', () => {
    const action = pendingPauseAction;
    if (!action) return;
    closePauseConfirm(false);
    lastFocusBeforePause = null;
    if (pauseOverlay) pauseOverlay.classList.add('hidden');
    if (action === 'restart') {
      if (dailyRunActive) {
        startNewGame(null, true);
      } else {
        startNewGame();
      }
      showToast('New run started');
    } else if (action === 'end') {
      if (controller && !controller.isGameOver()) {
        controller.endRun();
        handleGameOver();
      }
    }
  });
}

if (btnPauseHow) {
  btnPauseHow.addEventListener('click', () => {
    initAudio();
    playClick();
    if (window.TutorialController) {
      window.TutorialController.open('pause');
    }
  });
}

// How to play on Start screen
if (btnStartHow) {
  btnStartHow.addEventListener('click', () => {
    initAudio();
    playClick();
    if (window.TutorialController) {
      window.TutorialController.open('start');
    }
  });
}

// Daily button
if (btnPlayDaily) {
  btnPlayDaily.addEventListener('click', (e) => {
    e.preventDefault();
    initAudio();
    playClick();
    if (startOverlay && startOverlay.classList.contains('hidden')) return;
    startNewGame(null, true);
  });
}

// Start button (idempotent: cannot run twice)
if (btnPlayStart) {
  btnPlayStart.addEventListener('click', (e) => {
    e.preventDefault();
    initAudio();
    playClick();
    if (startOverlay && startOverlay.classList.contains('hidden')) return;
    startNewGame(null, false);
  });
}

const speakerOnSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align: middle; display: inline-block; margin-left: 6px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
const speakerMutedSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align: middle; display: inline-block; margin-left: 6px;"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';

// Sound toggle controls
function updateSoundButtons(enabled = isSoundEnabled()) {
  if (btnSoundStart) {
    btnSoundStart.innerHTML = `SOUND: ${enabled ? 'ON' : 'OFF'} ${enabled ? speakerOnSvg : speakerMutedSvg}`;
    btnSoundStart.setAttribute('aria-label', enabled ? 'Sound enabled' : 'Sound muted');
  }
  if (btnPauseSound) {
    const soundIconEl = document.getElementById('sound-icon');
    const soundLabelEl = document.getElementById('sound-label');
    if (soundIconEl && soundLabelEl) {
      soundIconEl.innerHTML = enabled ? speakerOnSvg : speakerMutedSvg;
      soundLabelEl.textContent = `Sound: ${enabled ? 'On' : 'Off'}`;
    } else {
      btnPauseSound.innerHTML = `Sound: ${enabled ? 'On' : 'Off'} <span style="float:right">${enabled ? speakerOnSvg : speakerMutedSvg}</span>`;
    }
    btnPauseSound.classList.toggle('active-toggle', enabled);
    btnPauseSound.setAttribute('aria-label', enabled ? 'Sound enabled' : 'Sound muted');
  }
}

if (btnSoundStart) {
  btnSoundStart.addEventListener('click', (e) => {
    e.stopPropagation();
    initAudio();
    const next = toggleSound();
    updateSoundButtons(next);
    if (next) playClick();
  });
}

if (btnPauseSound) {
  btnPauseSound.addEventListener('click', (e) => {
    e.stopPropagation();
    initAudio();
    const next = toggleSound();
    updateSoundButtons(next);
    if (next) playClick();
  });
}

// Allow Enter or Space on start overlay to start game (idempotent: only if startOverlay is visible)
if (startOverlay) {
  startOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (startOverlay.classList.contains('hidden')) return;
      e.preventDefault();
      initAudio();
      playClick();
      startNewGame();
    }
  });
}

// Play again buttons
if (btnPlayDailyAgain) {
  btnPlayDailyAgain.addEventListener('click', () => {
    initAudio();
    playClick();
    startNewGame(null, true);
  });
}

if (btnPlayAgain) {
  btnPlayAgain.addEventListener('click', () => {
    initAudio();
    playClick();
    startNewGame(null, false);
  });
}

// Start overlay daily controls setup
if (canShowDailyButton()) {
  if (btnPlayDaily) btnPlayDaily.classList.remove('hidden');
  if (dailyDisclosureContainer) dailyDisclosureContainer.classList.remove('hidden');
  if (startOverlay && !startOverlay.classList.contains('hidden')) {
    startDailyCountdown();
  }
}

// Background queue flush triggers
try {
  flushLeaderboardQueue();
  window.addEventListener('online', () => {
    try { flushLeaderboardQueue(null, true); } catch { }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      try { flushLeaderboardQueue(); } catch { }
    }
  });
} catch { }

// Copy run log button (copies { currentRun: <record>, history: [<last 20 records>] }, fallback download)
if (btnCopyLog) {
  btnCopyLog.addEventListener('click', async () => {
    if (!persistenceEnabled) {
      showToast('Run log disabled in sandbox');
      return;
    }
    initAudio();
    playClick();
    const metadata = getDiagnosticMetadata();
    const currentRun = currentRunLog || controller.getRunLog(metadata);
    if (currentRun && (currentRun.activeMs === undefined || currentRun.activeMs === null)) {
      currentRun.activeMs = Math.round(activePlayMs);
    }
    const history = getStoredHistory();
    const errors = getStoredErrors();
    const payload = { currentRun, history, errors };
    const jsonStr = JSON.stringify(payload, null, 2);

    let copied = false;
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(jsonStr);
        copied = true;
        showToast('Copied!');
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
        showToast('Copied!');
      } catch (err) {
        console.error('Copy/download fallback failed:', err);
      }
    }
  });
}

/* -------------------------------------------------------------
 * Best Runs Overlay
 * ------------------------------------------------------------- */
let previousOverlayBeforeBestRuns = null;

function renderBestRunsList() {
  const listEl = document.getElementById('best-runs-list');
  const countEl = document.getElementById('best-runs-count');
  if (!listEl) return;
  listEl.innerHTML = '';
  const runs = getTopRuns();
  const count = runs ? runs.length : 0;
  if (countEl) {
    countEl.textContent = count === 1 ? '1 entry recorded' : `${count} entries recorded`;
  }
  if (!runs || runs.length === 0) {
    listEl.innerHTML = '<div class="best-runs-empty">No runs yet.</div>';
    return;
  }

  runs.forEach((entry, idx) => {
    const rank = idx + 1;
    const card = document.createElement('div');
    card.className = `record-card ${rank === 1 ? 'rank-top1' : ''}`;

    // Left block: Rank + Details
    const left = document.createElement('div');
    left.className = 'record-left';

    const rankEl = document.createElement('div');
    rankEl.className = `record-rank ${rank <= 3 ? 'top-rank' : 'muted-rank'}`;
    rankEl.textContent = `#${rank}`;

    const info = document.createElement('div');
    info.className = 'record-info';

    const scoreRow = document.createElement('div');
    scoreRow.className = 'record-score-row';
    const scoreVal = document.createElement('span');
    scoreVal.className = 'record-score';
    scoreVal.textContent = (entry.points || 0).toLocaleString('en-US');
    const pts = document.createElement('span');
    pts.className = 'record-pts';
    pts.textContent = 'pts';
    scoreRow.appendChild(scoreVal);
    scoreRow.appendChild(pts);

    const subRow = document.createElement('div');
    subRow.className = 'record-sub-row';
    const movesSpan = document.createElement('span');
    movesSpan.textContent = `${entry.moves || 0} moves`;
    const dotSep = document.createElement('span');
    dotSep.className = 'record-dot-sep';
    dotSep.textContent = '•';
    const tileSpan = document.createElement('span');
    tileSpan.className = 'record-tile-label';
    tileSpan.textContent = `Tile ${entry.maxTile || 2}`;
    subRow.appendChild(movesSpan);
    subRow.appendChild(dotSep);
    subRow.appendChild(tileSpan);

    info.appendChild(scoreRow);
    info.appendChild(subRow);
    left.appendChild(rankEl);
    left.appendChild(info);

    // Right block: Date + Relics
    const right = document.createElement('div');
    right.className = 'record-right';

    const dateEl = document.createElement('span');
    dateEl.className = 'record-date';
    let dateStr = '';
    if (entry.endedAt) {
      try {
        const d = new Date(entry.endedAt);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
      } catch { }
    }
    dateEl.textContent = dateStr;
    right.appendChild(dateEl);

    const CANONICAL_RELIC_ORDER = [
      'diagonal_charge', 'eraser', 'rewind', 'fault_line',
      'mason', 'siphon', 'shatter', 'last_stand'
    ];
    const ownedSet = new Set(Array.isArray(entry.relics) ? entry.relics : []);
    const relicsWrap = document.createElement('div');
    relicsWrap.className = 'record-relics-grid';
    for (const rid of CANONICAL_RELIC_ORDER) {
      const isOwned = ownedSet.has(rid) || (rid === 'diagonal_charge' && ownedSet.has('diagonal_merge'));
      const chip = document.createElement('span');
      chip.className = `record-relic-chip ${isOwned ? 'is-owned' : 'is-unowned'}`;
      chip.setAttribute('title', `${RELIC_NAMES[rid] || rid}${isOwned ? '' : ' (not owned)'}`);
      chip.setAttribute('data-relic', rid);
      const iconEl = getRelicIconElement(rid, 14);
      chip.appendChild(iconEl);
      relicsWrap.appendChild(chip);
    }
    right.appendChild(relicsWrap);

    card.appendChild(left);
    card.appendChild(right);
    listEl.appendChild(card);
  });
}

function showBestRunsOverlay(source) {
  tickPlayTimer();
  if (source === startOverlay) {
    stopDailyCountdown();
  }
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    rewindDirector.pause();
  }
  previousOverlayBeforeBestRuns = source || (startOverlay && !startOverlay.classList.contains('hidden') ? startOverlay : pauseOverlay);
  renderBestRunsList();
  if (source && source.classList) {
    source.classList.add('hidden');
  }
  const bestRunsOverlay = document.getElementById('best-runs-overlay');
  if (bestRunsOverlay) {
    bestRunsOverlay.classList.remove('hidden');
    const closeBtn = document.getElementById('btn-best-runs-close');
    if (closeBtn) closeBtn.focus();
  }
}

function hideBestRunsOverlay() {
  const bestRunsOverlay = document.getElementById('best-runs-overlay');
  if (bestRunsOverlay) {
    bestRunsOverlay.classList.add('hidden');
  }
  if (previousOverlayBeforeBestRuns && previousOverlayBeforeBestRuns.classList) {
    previousOverlayBeforeBestRuns.classList.remove('hidden');
    if (previousOverlayBeforeBestRuns === startOverlay) {
      startDailyCountdown();
    }
  }
  previousOverlayBeforeBestRuns = null;
  lastPerfTime = performance.now();
  if (typeof rewindDirector !== 'undefined' && rewindDirector.isActive()) {
    rewindDirector.resume();
  }
}

const btnStartTrophy = document.getElementById('btn-start-trophy');
if (btnStartTrophy) {
  btnStartTrophy.addEventListener('click', (e) => {
    e.stopPropagation();
    showBestRunsOverlay(startOverlay);
  });
}

const btnPauseTrophy = document.getElementById('btn-pause-trophy');
if (btnPauseTrophy) {
  btnPauseTrophy.addEventListener('click', (e) => {
    e.stopPropagation();
    showBestRunsOverlay(pauseOverlay);
  });
}

const btnBestRunsClose = document.getElementById('btn-best-runs-close');
if (btnBestRunsClose) {
  btnBestRunsClose.addEventListener('click', (e) => {
    e.preventDefault();
    hideBestRunsOverlay();
  });
}

const bestRunsOverlayEl = document.getElementById('best-runs-overlay');
if (bestRunsOverlayEl) {
  bestRunsOverlayEl.addEventListener('click', (e) => {
    if (e.target === bestRunsOverlayEl) {
      hideBestRunsOverlay();
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const sso = document.getElementById('share-sheet');
    if (sso && !sso.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeShareSheet();
      return;
    }
    const nso = document.getElementById('name-sheet-overlay');
    if (nso && !nso.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeNameSheet();
      return;
    }
    const lbo = document.getElementById('leaderboard-overlay');
    if (lbo && !lbo.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeLeaderboardOverlay();
      return;
    }
    const bro = document.getElementById('best-runs-overlay');
    if (bro && !bro.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      hideBestRunsOverlay();
      return;
    }
  }
});

/* =============================================================================
 * Global Leaderboard (B2), Name Sheet (B3), and Ranking Card (B1) Orchestration
 * ============================================================================= */

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDayShort(dayStr) {
  if (!dayStr || typeof dayStr !== 'string') return '';
  const parts = dayStr.split('-');
  if (parts.length < 3) return dayStr;
  const day = parseInt(parts[2], 10);
  const mIndex = parseInt(parts[1], 10) - 1;
  const month = MONTH_NAMES_SHORT[mIndex] || parts[1];
  return `${day} ${month}`;
}

const AVATAR_PALETTES = [
  { bg: '#3e2e28', border: '#785542', text: '#f4c77f' },
  { bg: '#2f353b', border: '#53616f', text: '#cbd5e1' },
  { bg: '#3b2f35', border: '#735160', text: '#f4b8c7' },
  { bg: '#2b3934', border: '#4f7263', text: '#a7f3d0' },
  { bg: '#3d3224', border: '#79633e', text: '#fde047' },
  { bg: '#352e3e', border: '#68547d', text: '#d8b4fe' },
  { bg: '#3e352b', border: '#7a664e', text: '#fdba74' },
  { bg: '#2e393b', border: '#536d72', text: '#67e8f9' },
];

function getAvatarColors(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

function handleReturnToStartWithDaily() {
  if (endOverlay) endOverlay.classList.add('hidden');
  if (startOverlay) {
    startOverlay.classList.remove('hidden');
    if (canShowDailyButton()) {
      if (btnPlayDaily) btnPlayDaily.classList.remove('hidden');
      if (dailyDisclosureContainer) dailyDisclosureContainer.classList.remove('hidden');
      startDailyCountdown();
    }
    updateStartOverlayLeaderboardControls();
  }
}

function renderGameOverRankingCard(outcome, data = {}) {
  const panel = document.getElementById('global-ranking-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  const headerTitleEl = document.getElementById('ranking-header-title-text');
  const actionEl = document.getElementById('ranking-header-action');
  const bodyEl = document.getElementById('ranking-content-body');
  const footerEl = document.getElementById('ranking-footer-status');
  const statusCompatibilityEl = document.getElementById('end-leaderboard-status');

  const dayStr = data.day || dailyRunStartDay || utcDateString(new Date());
  if (headerTitleEl) {
    if (outcome === 8) {
      headerTitleEl.textContent = 'FREE RUN';
    } else {
      headerTitleEl.textContent = `DAILY RANKING · ${formatDayShort(dayStr)}`;
    }
  }

  if (actionEl) actionEl.replaceChildren();
  if (bodyEl) bodyEl.replaceChildren();
  if (footerEl) {
    footerEl.replaceChildren();
    footerEl.className = 'ranking-footer-status';
  }

  panel.classList.remove('shimmer-active');

  // Outcome 1: SENDING (calculating layout)
  if (outcome === 1) {
    const pill = document.createElement('span');
    pill.className = 'ranking-meta-pill';
    pill.textContent = 'SYNCING';
    actionEl.appendChild(pill);

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.style.letterSpacing = '0.1em';
    rankNum.style.color = 'var(--muted)';
    rankNum.style.fontSize = '26px';
    rankNum.textContent = '---';
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'CALCULATING RANK';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    const rankRight = document.createElement('div');
    rankRight.className = 'rank-right';
    const pct = document.createElement('div');
    pct.className = 'percentile-badge';
    pct.style.background = 'rgba(255,255,255,0.06)';
    pct.style.borderColor = 'rgba(255,255,255,0.1)';
    pct.style.color = 'var(--muted)';
    pct.textContent = 'CALCULATING...';
    const helper = document.createElement('span');
    helper.className = 'total-players-text';
    helper.textContent = 'Sending your run for verification';
    rankRight.appendChild(pct);
    rankRight.appendChild(helper);

    bodyEl.appendChild(rankLeft);
    bodyEl.appendChild(rankRight);

    footerEl.classList.add('status-pending');
    const spinner = document.createElement('span');
    spinner.className = 'pending-loader';
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'SUBMITTING RUN TO LEADERBOARD…';
    footerEl.appendChild(spinner);
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = 'Sending…';
    }
  }

  // Outcome 2: ACCEPTED with rank
  else if (outcome === 2) {
    panel.classList.add('shimmer-active');

    const shareBtn = document.createElement('button');
    shareBtn.className = 'ranking-share-btn';
    shareBtn.id = 'btn-ranking-share';
    shareBtn.type = 'button';
    shareBtn.setAttribute('aria-label', 'Share Rank');
    shareBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg><span>SHARE</span>';
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openShareSheet('daily', data);
    });
    actionEl.appendChild(shareBtn);

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.textContent = `#${data.rank}`;
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'DAILY RANK';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    const rankRight = document.createElement('div');
    rankRight.className = 'rank-right';
    const summary = rankSummary(data.rank, data.total);
    if (summary.topLabel) {
      const pct = document.createElement('div');
      pct.className = 'percentile-badge';
      pct.textContent = summary.topLabel;
      rankRight.appendChild(pct);
      const helper = document.createElement('span');
      helper.className = 'total-players-text';
      helper.textContent = `Among ${formatPoints(data.total)} players today`;
      rankRight.appendChild(helper);
    } else {
      const helper = document.createElement('span');
      helper.className = 'total-players-text';
      helper.textContent = `of ${formatPoints(data.total)} players`;
      rankRight.appendChild(helper);
    }

    bodyEl.appendChild(rankLeft);
    bodyEl.appendChild(rankRight);

    footerEl.classList.add('status-ranked');
    footerEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'RUN SUBMITTED TO LEADERBOARD';
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = `Submitted · Daily rank #${data.rank} of ${data.total}`;
    }
  }

  // Outcome 3: ACCEPTED but rank unavailable
  else if (outcome === 3) {
    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.textContent = '—';
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'RANK UNAVAILABLE';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    bodyEl.appendChild(rankLeft);

    footerEl.classList.add('status-ranked');
    footerEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'RUN SUBMITTED';
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = 'Submitted';
    }
  }

  // Outcome 4: NOT BETTER
  else if (outcome === 4) {
    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.textContent = data.bestRank ? `#${data.bestRank}` : '#—';
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'DAILY RANK';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    bodyEl.appendChild(rankLeft);

    const footerTxt = document.createElement('span');
    footerTxt.style.color = 'var(--muted)';
    footerTxt.textContent = `NOT SENT · YOUR BEST TODAY IS ${data.bestPoints}`;
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = `Not sent · your best today is ${data.bestPoints}`;
    }
  }

  // Outcome 5: QUEUED
  else if (outcome === 5) {
    const pill = document.createElement('span');
    pill.className = 'ranking-meta-pill';
    pill.textContent = 'QUEUED';
    actionEl.appendChild(pill);

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.style.letterSpacing = '0.1em';
    rankNum.style.color = 'var(--muted)';
    rankNum.style.fontSize = '26px';
    rankNum.textContent = '---';
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'CALCULATING RANK';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    const rankRight = document.createElement('div');
    rankRight.className = 'rank-right';
    const pct = document.createElement('div');
    pct.className = 'percentile-badge';
    pct.style.background = 'rgba(255,255,255,0.06)';
    pct.style.borderColor = 'rgba(255,255,255,0.1)';
    pct.style.color = 'var(--muted)';
    pct.textContent = 'WAITING';
    const helper = document.createElement('span');
    helper.className = 'total-players-text';
    helper.textContent = 'Saved on this device. Will retry automatically.';
    rankRight.appendChild(pct);
    rankRight.appendChild(helper);

    bodyEl.appendChild(rankLeft);
    bodyEl.appendChild(rankRight);

    footerEl.classList.add('status-pending');
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'SAVED · WILL RETRY';
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = 'Saved · will retry';
    }
  }

  // Outcome 6: UPDATING
  else if (outcome === 6) {
    const pill = document.createElement('span');
    pill.className = 'ranking-meta-pill';
    pill.textContent = 'UPDATING';
    actionEl.appendChild(pill);

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.style.letterSpacing = '0.1em';
    rankNum.style.color = 'var(--muted)';
    rankNum.style.fontSize = '26px';
    rankNum.textContent = '---';
    const rankLbl = document.createElement('span');
    rankLbl.className = 'rank-label';
    rankLbl.textContent = 'CALCULATING RANK';
    rankLeft.appendChild(rankNum);
    rankLeft.appendChild(rankLbl);

    const rankRight = document.createElement('div');
    rankRight.className = 'rank-right';
    const pct = document.createElement('div');
    pct.className = 'percentile-badge';
    pct.style.background = 'rgba(255,255,255,0.06)';
    pct.style.borderColor = 'rgba(255,255,255,0.1)';
    pct.style.color = 'var(--muted)';
    pct.textContent = 'PAUSED';
    const helper = document.createElement('span');
    helper.className = 'total-players-text';
    helper.textContent = 'The leaderboard is updating. Your run is saved.';
    rankRight.appendChild(pct);
    rankRight.appendChild(helper);

    bodyEl.appendChild(rankLeft);
    bodyEl.appendChild(rankRight);

    footerEl.classList.add('status-pending');
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'SAVED · LEADERBOARD UPDATING';
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = 'Saved · leaderboard updating';
    }
  }

  // Outcome 7: REJECTED
  else if (outcome === 7) {
    const pill = document.createElement('span');
    pill.className = 'ranking-meta-pill';
    pill.textContent = 'REJECTED';
    actionEl.appendChild(pill);

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    const rankNum = document.createElement('span');
    rankNum.className = 'rank-number';
    rankNum.style.fontSize = '24px';
    rankNum.style.color = 'var(--muted)';
    rankNum.textContent = 'NOT ACCEPTED';
    rankLeft.appendChild(rankNum);

    const rankRight = document.createElement('div');
    rankRight.className = 'rank-right';
    const helper = document.createElement('span');
    helper.className = 'total-players-text';
    helper.textContent = 'The server could not verify this run.';
    rankRight.appendChild(helper);

    bodyEl.appendChild(rankLeft);
    bodyEl.appendChild(rankRight);

    footerEl.classList.add('status-unranked');
    footerEl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    const footerTxt = document.createElement('span');
    footerTxt.textContent = 'RUN NOT ACCEPTED';
    footerEl.appendChild(footerTxt);

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = 'Not accepted';
    }
  }

  // Outcome 8: FREE RUN
  else if (outcome === 8) {
    if (headerTitleEl) {
      headerTitleEl.textContent = 'FREE RUN';
    }

    const canShare = canShowDailyButton();
    const moves = typeof data.moves === 'number'
      ? data.moves
      : (data.runLog ? (data.runLog.totalMoves ?? data.runLog.moves ?? 0) : (currentRunLog ? (currentRunLog.totalMoves ?? currentRunLog.moves ?? 0) : 0));

    const rankLeft = document.createElement('div');
    rankLeft.className = 'rank-left';
    rankLeft.style.maxWidth = '220px';

    const mutedSpan = document.createElement('span');
    mutedSpan.className = 'free-run-muted-text total-players-text';
    if (!canShare) {
      mutedSpan.textContent = data.isForbidden ? 'Custom seed or debug mode enabled' : "Free runs aren't ranked.";
    } else if (moves < 10) {
      mutedSpan.textContent = 'Play a few more moves to challenge a friend.';
    } else {
      mutedSpan.textContent = "Free runs aren't ranked. Send this one as a challenge.";
    }
    rankLeft.appendChild(mutedSpan);
    bodyEl.appendChild(rankLeft);

    if (canShare) {
      const rankRight = document.createElement('div');
      rankRight.className = 'rank-right';
      const shareBtn = document.createElement('button');
      shareBtn.className = 'ranking-share-btn-gold';
      shareBtn.id = 'btn-ranking-share';
      shareBtn.type = 'button';
      shareBtn.setAttribute('aria-label', 'Challenge a friend');
      shareBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg><span>SHARE</span>';
      if (moves < 10) {
        shareBtn.disabled = true;
      } else {
        shareBtn.disabled = false;
        shareBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openShareSheet('free', data);
        });
      }
      rankRight.appendChild(shareBtn);
      bodyEl.appendChild(rankRight);
    }

    footerEl.classList.add('status-unranked');
    footerEl.style.display = 'flex';
    footerEl.style.justifyContent = 'space-between';
    footerEl.style.alignItems = 'center';

    const footerLeft = document.createElement('span');
    footerLeft.className = 'footer-left-unranked';
    footerLeft.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" width="11" height="11" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><span>FREE RUN · NOT RANKED</span>';
    footerEl.appendChild(footerLeft);

    if (canShare) {
      const playDailyBtn = document.createElement('button');
      playDailyBtn.className = 'play-daily-link';
      playDailyBtn.id = 'btn-play-daily-pill';
      playDailyBtn.type = 'button';
      playDailyBtn.textContent = 'PLAY DAILY';
      playDailyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleReturnToStartWithDaily();
      });
      footerEl.appendChild(playDailyBtn);
    }

    if (statusCompatibilityEl) {
      statusCompatibilityEl.textContent = '';
    }
  }
}

// Bind Ranking Card Click to open Leaderboard Overlay
const rkPanelCard = document.getElementById('global-ranking-panel');
if (rkPanelCard) {
  rkPanelCard.addEventListener('click', (e) => {
    if (e.target.closest('#btn-ranking-share') || e.target.closest('#btn-play-daily-pill')) {
      return;
    }
    openLeaderboardOverlay('end');
  });
}

function updateStartOverlayLeaderboardControls() {
  const btnStartLb = document.getElementById('btn-start-leaderboard');
  const hasLb = Boolean(window.__LB && window.__LB.url && window.__LB.anonKey);
  if (btnStartLb) {
    if (hasLb) {
      btnStartLb.classList.remove('hidden');
    } else {
      btnStartLb.classList.add('hidden');
    }
  }
}

// Bind Home Button
const btnEndHome = document.getElementById('btn-end-home');
if (btnEndHome) {
  btnEndHome.addEventListener('click', () => {
    initAudio();
    playClick();
    if (endOverlay) endOverlay.classList.add('hidden');
    if (startOverlay) {
      startOverlay.classList.remove('hidden');
      if (canShowDailyButton()) {
        if (btnPlayDaily) btnPlayDaily.classList.remove('hidden');
        if (dailyDisclosureContainer) dailyDisclosureContainer.classList.remove('hidden');
        startDailyCountdown();
      }
      updateStartOverlayLeaderboardControls();
    }
  });
}

// B4 Globe button setup on Start Overlay
const btnStartLeaderboard = document.getElementById('btn-start-leaderboard');
if (btnStartLeaderboard) {
  updateStartOverlayLeaderboardControls();
  btnStartLeaderboard.addEventListener('click', (e) => {
    e.stopPropagation();
    initAudio();
    playClick();
    openLeaderboardOverlay('start');
  });
}

/* -------------------------------------------------------------
 * B2 Leaderboard Overlay Management
 * ------------------------------------------------------------- */
let activeLeaderboardTab = 'today';
let leaderboardOriginOverlay = 'start';
let leaderboardAbortController = null;
let tabCache = { today: null, week: null, alltime: null };
let lastBoardFetchTime = { today: 0, week: 0, alltime: 0 };

function openLeaderboardOverlay(origin = 'start') {
  leaderboardOriginOverlay = origin;
  if (origin === 'start') {
    stopDailyCountdown();
  }
  const overlay = document.getElementById('leaderboard-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');

  switchLeaderboardTab('today');
}

function closeLeaderboardOverlay() {
  const overlay = document.getElementById('leaderboard-overlay');
  if (overlay) overlay.classList.add('hidden');

  if (leaderboardAbortController) {
    leaderboardAbortController.abort();
    leaderboardAbortController = null;
  }

  if (leaderboardOriginOverlay === 'end') {
    if (endOverlay) endOverlay.classList.remove('hidden');
  } else {
    if (startOverlay) {
      startOverlay.classList.remove('hidden');
      if (canShowDailyButton()) {
        startDailyCountdown();
      }
      updateStartOverlayLeaderboardControls();
    }
  }
}

function switchLeaderboardTab(tabKey, force = false) {
  activeLeaderboardTab = tabKey;

  const tabToday = document.getElementById('tab-today');
  const tabWeek = document.getElementById('tab-week');
  const tabAlltime = document.getElementById('tab-alltime');
  const subtitleEl = document.getElementById('lb-subtitle');

  if (tabToday) {
    tabToday.classList.toggle('active', tabKey === 'today');
    tabToday.setAttribute('aria-selected', String(tabKey === 'today'));
  }
  if (tabWeek) {
    tabWeek.classList.toggle('active', tabKey === 'week');
    tabWeek.setAttribute('aria-selected', String(tabKey === 'week'));
  }
  if (tabAlltime) {
    tabAlltime.classList.toggle('active', tabKey === 'alltime');
    tabAlltime.setAttribute('aria-selected', String(tabKey === 'alltime'));
  }

  if (subtitleEl) {
    if (tabKey === 'today') {
      subtitleEl.textContent = 'Same daily seed for everyone';
    } else if (tabKey === 'week') {
      subtitleEl.textContent = "Sum of each player's daily bests (Mon-Sun UTC)";
    } else if (tabKey === 'alltime') {
      subtitleEl.textContent = 'Best single run per player';
    }
  }

  renderLeaderboardTab(tabKey, force);
}

async function renderLeaderboardTab(tabKey, force = false) {
  const listEl = document.getElementById('lb-scroll-list');
  const podiumEl = document.getElementById('lb-podium');

  if (!window.__LB || !window.__LB.url || !window.__LB.anonKey) {
    if (podiumEl) podiumEl.replaceChildren();
    if (listEl) {
      listEl.innerHTML = '<div class="lb-state-msg"><span>Leaderboard not configured.</span></div>';
    }
    return;
  }

  const url = window.__LB.url;
  const anonKey = window.__LB.anonKey;
  const devId = getDeviceId(localStorage, persistenceEnabled);
  const now = Date.now();

  // 30s cache check
  if (!force && tabCache[tabKey] && (now - lastBoardFetchTime[tabKey] < 30000)) {
    renderTabContent(tabKey, tabCache[tabKey]);
    updateSyncText(lastBoardFetchTime[tabKey]);
    return;
  }

  if (leaderboardAbortController) {
    leaderboardAbortController.abort();
  }
  leaderboardAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = leaderboardAbortController?.signal;

  if (listEl) {
    listEl.innerHTML = '<div class="lb-state-msg"><span class="pending-loader"></span><span>Loading rankings…</span></div>';
  }

  const apiTab = tabKey === 'alltime' ? 'all' : tabKey;

  try {
    const [boardRes, myRankRes] = await Promise.all([
      fetchBoard({
        url,
        anonKey,
        tab: apiTab,
        limit: 100,
        fetchFn: (input, init) => window.fetch(input, { ...init, signal }),
      }),
      fetchMyRank({
        url,
        anonKey,
        tab: apiTab,
        deviceId: devId,
        fetchFn: (input, init) => window.fetch(input, { ...init, signal }),
      }),
    ]);

    if (signal?.aborted) return;

    if (!boardRes.ok) {
      if (podiumEl) podiumEl.replaceChildren();
      if (listEl) {
        listEl.innerHTML = '<div class="lb-state-msg"><span>Failed to load rankings.</span><button class="lb-retry-btn" id="btn-lb-retry" type="button">Retry</button></div>';
        const retryBtn = document.getElementById('btn-lb-retry');
        if (retryBtn) retryBtn.addEventListener('click', () => renderLeaderboardTab(tabKey, true));
      }
      return;
    }

    const cachedData = {
      rows: boardRes.rows,
      myRank: myRankRes.ok ? myRankRes.row : null,
      totalPlayers: myRankRes.ok ? myRankRes.totalPlayers : null,
    };
    tabCache[tabKey] = cachedData;
    lastBoardFetchTime[tabKey] = Date.now();

    renderTabContent(tabKey, cachedData);
    updateSyncText(lastBoardFetchTime[tabKey]);
  } catch (err) {
    if (signal?.aborted) return;
    if (podiumEl) podiumEl.replaceChildren();
    if (listEl) {
      listEl.innerHTML = '<div class="lb-state-msg"><span>Failed to load rankings.</span><button class="lb-retry-btn" id="btn-lb-retry" type="button">Retry</button></div>';
      const retryBtn = document.getElementById('btn-lb-retry');
      if (retryBtn) retryBtn.addEventListener('click', () => renderLeaderboardTab(tabKey, true));
    }
  }
}

function renderTabContent(tabKey, { rows, myRank }) {
  const podiumEl = document.getElementById('lb-podium');
  const listEl = document.getElementById('lb-scroll-list');
  const pinnedCardEl = document.getElementById('lb-pinned-card');

  if (podiumEl) podiumEl.replaceChildren();
  if (listEl) listEl.replaceChildren();
  if (pinnedCardEl) pinnedCardEl.replaceChildren();

  if (!rows || rows.length === 0) {
    if (listEl) {
      listEl.innerHTML = '<div class="lb-state-msg"><span>No runs yet. Be the first.</span></div>';
    }
  } else {
    // 1. Render Podium (ranks 1-3)
    const p1 = rows[0] || null;
    const p2 = rows[1] || null;
    const p3 = rows[2] || null;

    if (podiumEl) {
      // Slot 2 (Left)
      const card2 = document.createElement('div');
      card2.className = 'podium-card rank-2';
      card2.innerHTML = '<div class="podium-shimmer" aria-hidden="true"></div>';

      const avWrap2 = document.createElement('div');
      avWrap2.className = 'avatar-wrapper';
      const av2 = document.createElement('div');
      av2.className = 'podium-avatar';
      if (p2) {
        const col2 = getAvatarColors(p2.name);
        av2.style.backgroundColor = col2.bg;
        av2.style.borderColor = col2.border;
        av2.style.color = col2.text;
        av2.textContent = avatarInitials(p2.name);
      } else {
        av2.textContent = '—';
      }
      avWrap2.appendChild(av2);
      card2.appendChild(avWrap2);

      const name2 = document.createElement('div');
      name2.className = 'podium-name';
      name2.textContent = p2 ? p2.name : '—';
      card2.appendChild(name2);

      const score2 = document.createElement('div');
      score2.className = 'podium-score';
      score2.textContent = p2 ? formatPoints(p2.points) : '—';
      card2.appendChild(score2);

      const pill2 = document.createElement('span');
      pill2.className = 'podium-tile-pill';
      pill2.textContent = p2 ? `Tile ${p2.maxTile}` : '—';
      card2.appendChild(pill2);

      const tag2 = document.createElement('div');
      tag2.className = 'podium-rank-tag';
      tag2.textContent = '#2 SILVER';
      card2.appendChild(tag2);

      podiumEl.appendChild(card2);

      // Slot 1 (Center)
      const slot1 = document.createElement('div');
      slot1.className = 'podium-slot-1';

      const trophy = document.createElement('div');
      trophy.className = 'trophy-badge';
      trophy.setAttribute('title', 'Champion Crown');
      trophy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5M19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"/></svg>';
      slot1.appendChild(trophy);

      const card1 = document.createElement('div');
      card1.className = 'podium-card rank-1';
      card1.innerHTML = '<div class="podium-shimmer" aria-hidden="true"></div>';

      const avWrap1 = document.createElement('div');
      avWrap1.className = 'avatar-wrapper';
      const av1 = document.createElement('div');
      av1.className = 'podium-avatar';
      if (p1) {
        const col1 = getAvatarColors(p1.name);
        av1.style.backgroundColor = col1.bg;
        av1.style.borderColor = col1.border;
        av1.style.color = col1.text;
        av1.textContent = avatarInitials(p1.name);
      } else {
        av1.textContent = '—';
      }
      avWrap1.appendChild(av1);
      card1.appendChild(avWrap1);

      const name1 = document.createElement('div');
      name1.className = 'podium-name';
      name1.textContent = p1 ? p1.name : '—';
      card1.appendChild(name1);

      const score1 = document.createElement('div');
      score1.className = 'podium-score';
      score1.textContent = p1 ? formatPoints(p1.points) : '—';
      card1.appendChild(score1);

      const pill1 = document.createElement('span');
      pill1.className = 'podium-tile-pill';
      pill1.textContent = p1 ? `Tile ${p1.maxTile}` : '—';
      card1.appendChild(pill1);

      const tag1 = document.createElement('div');
      tag1.className = 'podium-rank-tag';
      tag1.textContent = '#1 CHAMPION';
      card1.appendChild(tag1);

      slot1.appendChild(card1);
      podiumEl.appendChild(slot1);

      // Slot 3 (Right)
      const card3 = document.createElement('div');
      card3.className = 'podium-card rank-3';
      card3.innerHTML = '<div class="podium-shimmer" aria-hidden="true"></div>';

      const avWrap3 = document.createElement('div');
      avWrap3.className = 'avatar-wrapper';
      const av3 = document.createElement('div');
      av3.className = 'podium-avatar';
      if (p3) {
        const col3 = getAvatarColors(p3.name);
        av3.style.backgroundColor = col3.bg;
        av3.style.borderColor = col3.border;
        av3.style.color = col3.text;
        av3.textContent = avatarInitials(p3.name);
      } else {
        av3.textContent = '—';
      }
      avWrap3.appendChild(av3);
      card3.appendChild(avWrap3);

      const name3 = document.createElement('div');
      name3.className = 'podium-name';
      name3.textContent = p3 ? p3.name : '—';
      card3.appendChild(name3);

      const score3 = document.createElement('div');
      score3.className = 'podium-score';
      score3.textContent = p3 ? formatPoints(p3.points) : '—';
      card3.appendChild(score3);

      const pill3 = document.createElement('span');
      pill3.className = 'podium-tile-pill';
      pill3.textContent = p3 ? `Tile ${p3.maxTile}` : '—';
      card3.appendChild(pill3);

      const tag3 = document.createElement('div');
      tag3.className = 'podium-rank-tag';
      tag3.textContent = '#3 BRONZE';
      card3.appendChild(tag3);

      podiumEl.appendChild(card3);
    }

    // 2. Render List Rows (ranks 4-100)
    if (listEl) {
      const remaining = rows.slice(3);
      for (const p of remaining) {
        const isMe = myRank && p.rank === myRank.rank;
        const row = document.createElement('div');
        row.className = `ranking-row ${isMe ? 'is-current-user' : ''}`;

        const rankNum = document.createElement('div');
        rankNum.className = 'rank-number';
        rankNum.textContent = `#${p.rank}`;
        row.appendChild(rankNum);

        const avBox = document.createElement('div');
        avBox.className = 'row-avatar-box';
        const av = document.createElement('div');
        av.className = 'row-avatar';
        const col = getAvatarColors(p.name);
        av.style.backgroundColor = col.bg;
        av.style.borderColor = col.border;
        av.style.color = col.text;
        av.textContent = avatarInitials(p.name);
        avBox.appendChild(av);
        row.appendChild(avBox);

        const meta = document.createElement('div');
        meta.className = 'player-meta';
        const unameWrap = document.createElement('div');
        unameWrap.className = 'player-username';
        const uname = document.createElement('span');
        uname.className = 'row-name';
        uname.textContent = p.name;
        unameWrap.appendChild(uname);
        if (isMe) {
          const youPill = document.createElement('span');
          youPill.className = 'you-pill';
          youPill.textContent = 'YOU';
          unameWrap.appendChild(youPill);
        }
        meta.appendChild(unameWrap);

        const sub = document.createElement('div');
        sub.className = 'player-subdetails';
        const movesSpan = document.createElement('span');
        movesSpan.textContent = `${p.moves} moves`;
        const dot = document.createElement('span');
        dot.className = 'sub-dot';
        const maxTileSpan = document.createElement('span');
        maxTileSpan.textContent = `Max ${p.maxTile}`;
        sub.appendChild(movesSpan);
        sub.appendChild(dot);
        sub.appendChild(maxTileSpan);
        meta.appendChild(sub);
        row.appendChild(meta);

        const scoreBlock = document.createElement('div');
        scoreBlock.className = 'player-score-block';
        const scoreVal = document.createElement('span');
        scoreVal.className = 'player-score-val';
        scoreVal.textContent = formatPoints(p.points);
        const tileTag = document.createElement('span');
        tileTag.className = 'player-tile-tag';
        tileTag.textContent = String(p.maxTile);
        scoreBlock.appendChild(scoreVal);
        scoreBlock.appendChild(tileTag);
        row.appendChild(scoreBlock);

        listEl.appendChild(row);
      }
    }
  }

  // 3. Render Pinned Current User Card
  if (pinnedCardEl) {
    if (myRank) {
      const rankBadge = document.createElement('div');
      rankBadge.className = 'pinned-rank-badge current-rank-badge';
      rankBadge.textContent = `#${myRank.rank}`;
      pinnedCardEl.appendChild(rankBadge);

      const avBox = document.createElement('div');
      avBox.className = 'row-avatar-box';
      const av = document.createElement('div');
      av.className = 'row-avatar';
      const col = getAvatarColors(myRank.name);
      av.style.backgroundColor = col.bg;
      av.style.borderColor = col.border;
      av.style.color = col.text;
      av.textContent = avatarInitials(myRank.name);
      avBox.appendChild(av);
      pinnedCardEl.appendChild(avBox);

      const meta = document.createElement('div');
      meta.className = 'player-meta';
      const unameWrap = document.createElement('div');
      unameWrap.className = 'player-username';
      const uname = document.createElement('span');
      uname.className = 'row-name';
      uname.textContent = myRank.name;
      unameWrap.appendChild(uname);

      const youPill = document.createElement('span');
      youPill.className = 'you-pill';
      youPill.textContent = 'YOU';
      unameWrap.appendChild(youPill);

      // Pencil edit button
      const pencil = document.createElement('button');
      pencil.className = 'btn-name-edit';
      pencil.id = 'btn-name-edit';
      pencil.type = 'button';
      pencil.setAttribute('aria-label', 'Edit display name');
      pencil.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>';

      let hasAcceptedRun = false;
      try {
        hasAcceptedRun = localStorage.getItem('rogue2048_has_accepted_run') === '1' ||
          Boolean(getStoredDailyBest(utcDateString(new Date()), localStorage));
      } catch { }

      if (!hasAcceptedRun) {
        pencil.disabled = true;
        pencil.setAttribute('title', 'Finish a Daily run first to set a name.');
      } else {
        pencil.disabled = false;
        pencil.setAttribute('title', 'Edit display name');
        pencil.addEventListener('click', (e) => {
          e.stopPropagation();
          openNameSheet(myRank.name);
        });
      }
      unameWrap.appendChild(pencil);
      meta.appendChild(unameWrap);

      const sub = document.createElement('div');
      sub.className = 'player-subdetails';
      const movesSpan = document.createElement('span');
      movesSpan.textContent = `${myRank.moves} moves`;
      const dot = document.createElement('span');
      dot.className = 'sub-dot';
      const maxTileSpan = document.createElement('span');
      maxTileSpan.textContent = `Max Tile ${myRank.maxTile}`;
      sub.appendChild(movesSpan);
      sub.appendChild(dot);
      sub.appendChild(maxTileSpan);
      meta.appendChild(sub);
      pinnedCardEl.appendChild(meta);

      const scoreBlock = document.createElement('div');
      scoreBlock.className = 'player-score-block';
      const scoreVal = document.createElement('span');
      scoreVal.className = 'player-score-val';
      scoreVal.textContent = formatPoints(myRank.points);
      const tileTag = document.createElement('span');
      tileTag.className = 'player-tile-tag';
      tileTag.textContent = String(myRank.maxTile);
      scoreBlock.appendChild(scoreVal);
      scoreBlock.appendChild(tileTag);
      pinnedCardEl.appendChild(scoreBlock);
    } else {
      const msg = document.createElement('div');
      msg.style.cssText = 'grid-column: span 4; text-align: center; color: var(--muted); font-size: 11px; padding: 4px 0;';
      if (tabKey === 'today') {
        msg.textContent = "Play today's Daily to get ranked";
      } else if (tabKey === 'week') {
        msg.textContent = 'Play Daily runs this week to get ranked';
      } else {
        msg.textContent = 'Play a Daily run to get ranked';
      }
      pinnedCardEl.appendChild(msg);
    }
  }
}

function updateSyncText(timestamp) {
  const syncTextEl = document.getElementById('lb-sync-text');
  if (!syncTextEl) return;
  if (!timestamp) {
    syncTextEl.textContent = 'Updated just now';
    return;
  }
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 5) {
    syncTextEl.textContent = 'Updated just now';
  } else if (diffSec < 60) {
    syncTextEl.textContent = `Updated ${diffSec}s ago`;
  } else {
    const mins = Math.floor(diffSec / 60);
    syncTextEl.textContent = `Updated ${mins}m ago`;
  }
}

// Bind Leaderboard overlay close & refresh buttons
const btnLeaderboardClose = document.getElementById('btn-leaderboard-close');
if (btnLeaderboardClose) {
  btnLeaderboardClose.addEventListener('click', () => {
    closeLeaderboardOverlay();
  });
}

const lbOverlay = document.getElementById('leaderboard-overlay');
if (lbOverlay) {
  lbOverlay.addEventListener('click', (e) => {
    if (e.target === lbOverlay) {
      closeLeaderboardOverlay();
    }
  });
}

const btnLbRefresh = document.getElementById('btn-lb-refresh');
if (btnLbRefresh) {
  btnLbRefresh.addEventListener('click', () => {
    renderLeaderboardTab(activeLeaderboardTab, true);
  });
}

const tabBtnToday = document.getElementById('tab-today');
if (tabBtnToday) {
  tabBtnToday.addEventListener('click', () => switchLeaderboardTab('today'));
}

const tabBtnWeek = document.getElementById('tab-week');
if (tabBtnWeek) {
  tabBtnWeek.addEventListener('click', () => switchLeaderboardTab('week'));
}

const tabBtnAlltime = document.getElementById('tab-alltime');
if (tabBtnAlltime) {
  tabBtnAlltime.addEventListener('click', () => switchLeaderboardTab('alltime'));
}

/* -------------------------------------------------------------
 * B3 Name Sheet Management
 * ------------------------------------------------------------- */
function openNameSheet(currentName = '') {
  const sheetOverlay = document.getElementById('name-sheet-overlay');
  const inputEl = document.getElementById('ns-name-input') || document.getElementById('ns-input');
  const errorEl = document.getElementById('ns-error-box') || document.getElementById('ns-error');
  if (!sheetOverlay || !inputEl) return;

  sheetOverlay.classList.remove('hidden');
  inputEl.value = currentName || localStorage.getItem('rogue2048_display_name') || '';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.classList.add('hidden');
  }
  inputEl.focus();
}

function closeNameSheet() {
  const sheetOverlay = document.getElementById('name-sheet-overlay');
  if (sheetOverlay) sheetOverlay.classList.add('hidden');
}

async function handleNameSubmit(customName) {
  const url = window.__LB?.url;
  const anonKey = window.__LB?.anonKey;
  const devId = getDeviceId(localStorage, persistenceEnabled);
  const errorEl = document.getElementById('ns-error-box') || document.getElementById('ns-error');
  const saveBtn = document.getElementById('btn-ns-save');
  const genBtn = document.getElementById('btn-ns-generated');

  if (!url || !anonKey) return;
  if (saveBtn) saveBtn.disabled = true;
  if (genBtn) genBtn.disabled = true;

  try {
    const res = await setDisplayName({
      url,
      anonKey,
      deviceId: devId,
      name: customName,
      fetchFn: window.fetch.bind(window),
    });

    if (res.ok) {
      try {
        localStorage.setItem('rogue2048_has_accepted_run', '1');
        if (res.displayName) {
          localStorage.setItem('rogue2048_display_name', res.displayName);
        }
      } catch { }

      tabCache = { today: null, week: null, alltime: null };
      closeNameSheet();
      showToast('Name updated!');
      renderLeaderboardTab(activeLeaderboardTab, true);
    } else {
      let msg = "Couldn't reach the server. Try again.";
      if (res.code === 'NAME_NOT_ALLOWED') {
        msg = "That name isn't allowed. Try another.";
      } else if (res.code === 'NAME_TAKEN') {
        msg = 'That name is taken.';
      } else if (res.code === 'RATE_LIMITED') {
        msg = 'Too many changes today. Try again tomorrow.';
      } else if (res.code === 'DEVICE_NOT_FOUND') {
        msg = 'Finish a Daily run first to set a name.';
      }
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
      }
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (genBtn) genBtn.disabled = false;
  }
}

const btnNsSave = document.getElementById('btn-ns-save');
if (btnNsSave) {
  btnNsSave.addEventListener('click', () => {
    const inputEl = document.getElementById('ns-name-input') || document.getElementById('ns-input');
    const val = inputEl ? inputEl.value.trim() : '';
    handleNameSubmit(val);
  });
}

const btnNsGenerated = document.getElementById('btn-ns-generated');
if (btnNsGenerated) {
  btnNsGenerated.addEventListener('click', () => {
    handleNameSubmit(null);
  });
}

const btnNsCancel = document.getElementById('btn-ns-cancel');
if (btnNsCancel) {
  btnNsCancel.addEventListener('click', () => {
    closeNameSheet();
  });
}

const nsOverlay = document.getElementById('name-sheet-overlay');
if (nsOverlay) {
  nsOverlay.addEventListener('click', (e) => {
    if (e.target === nsOverlay) {
      closeNameSheet();
    }
  });
}

const nsInput = document.getElementById('ns-name-input') || document.getElementById('ns-input');
if (nsInput) {
  nsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = nsInput.value.trim();
      handleNameSubmit(val);
    }
  });
}

/* -------------------------------------------------------------
 * B4 Share Sheet (Challenge a Friend) Management
 * ------------------------------------------------------------- */
let activeShareSheetRunKey = null;
let cachedChallengeResult = null;
let shareExpiryInterval = null;
let lastShareTriggerBtn = null;
let isShareChallengeInFlight = false;

function openShareSheet(mode = 'daily', runData = {}) {
  const backdrop = document.getElementById('share-sheet-backdrop');
  const sheet = document.getElementById('share-sheet');
  const chipEl = document.getElementById('share-mode-chip');
  const closeBtn = document.getElementById('btn-share-sheet-close');
  const gameoverCard = document.querySelector('.gameover-card');

  if (!sheet) return;

  lastShareTriggerBtn = document.activeElement;

  if (chipEl) {
    chipEl.textContent = mode === 'daily' ? 'DAILY' : 'FREE RUN';
  }

  if (gameoverCard) {
    gameoverCard.setAttribute('inert', '');
  }

  if (backdrop) backdrop.classList.remove('hidden');
  sheet.classList.remove('hidden');

  closeBtn?.focus();

  const day = runData.day || dailyRunStartDay || utcDateString(new Date());
  const points = typeof runData.points === 'number'
    ? runData.points
    : (currentRunLog ? (currentRunLog.points ?? 0) : 0);
  const moves = typeof runData.moves === 'number'
    ? runData.moves
    : (currentRunLog ? (currentRunLog.totalMoves ?? currentRunLog.moves ?? 0) : 0);

  const runKey = runData.runKey || (mode === 'daily'
    ? `daily_${day}_${points}`
    : (currentRunLog?.runId || `free_${currentRunLog?.seed ?? '0'}_${points}_${moves}`));

  if (activeShareSheetRunKey === runKey && cachedChallengeResult) {
    renderShareSheetReady(cachedChallengeResult);
  } else {
    activeShareSheetRunKey = runKey;
    cachedChallengeResult = null;
    renderShareSheetCreating(mode);
    requestCreateChallenge(mode, { ...runData, day, points, moves, runKey });
  }
}

function closeShareSheet() {
  if (shareExpiryInterval) {
    clearInterval(shareExpiryInterval);
    shareExpiryInterval = null;
  }
  const backdrop = document.getElementById('share-sheet-backdrop');
  const sheet = document.getElementById('share-sheet');
  const gameoverCard = document.querySelector('.gameover-card');

  if (gameoverCard) {
    gameoverCard.removeAttribute('inert');
  }

  if (backdrop) backdrop.classList.add('hidden');
  if (sheet) sheet.classList.add('hidden');

  if (lastShareTriggerBtn && typeof lastShareTriggerBtn.focus === 'function') {
    try { lastShareTriggerBtn.focus(); } catch {}
  }
}

async function requestCreateChallenge(mode, payload = {}) {
  isShareChallengeInFlight = true;
  const shareBtn = document.getElementById('btn-ranking-share');
  if (shareBtn && shareBtn.classList.contains('ranking-share-btn-gold')) {
    shareBtn.innerHTML = '<span class="spinner-sm" aria-hidden="true"></span><span>SHARE</span>';
  }

  try {
    const runLogToUse = mode === 'free'
      ? (payload.runLog || currentRunLog || {
          seed: 1,
          rulesVersion: '1',
          replayVersion: '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98',
          events: [],
          points: payload.points || 0,
          totalMoves: payload.moves || 0,
        })
      : null;

    const res = await createChallenge({
      mode,
      runLog: runLogToUse,
      dayUtc: mode === 'daily' ? payload.day : null,
      fetchFn: window.fetch.bind(window),
    });

    if (activeShareSheetRunKey !== payload.runKey) {
      return;
    }

    if (res.ok) {
      cachedChallengeResult = {
        code: res.code,
        mode: res.mode || mode,
        expiresAt: res.expiresAt,
        url: res.url,
        points: payload.points,
        day: payload.day,
      };
      renderShareSheetReady(cachedChallengeResult);
    } else {
      renderShareSheetError(res.error, res.retryAfter, () => {
        renderShareSheetCreating(mode);
        requestCreateChallenge(mode, payload);
      });
    }
  } catch (_e) {
    if (activeShareSheetRunKey !== payload.runKey) {
      return;
    }
    renderShareSheetError('network', 0, () => {
      renderShareSheetCreating(mode);
      requestCreateChallenge(mode, payload);
    });
  } finally {
    isShareChallengeInFlight = false;
    if (shareBtn && shareBtn.classList.contains('ranking-share-btn-gold')) {
      shareBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg><span>SHARE</span>';
    }
  }
}

function renderShareSheetCreating(mode) {
  const bodyEl = document.getElementById('share-sheet-body');
  if (!bodyEl) return;
  bodyEl.replaceChildren();

  const statusBox = document.createElement('div');
  statusBox.className = 'status-box';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const textSpan = document.createElement('span');
  textSpan.textContent = mode === 'daily'
    ? 'Creating your link…'
    : 'Uploading and verifying your run…';
  statusBox.appendChild(spinner);
  statusBox.appendChild(textSpan);
  bodyEl.appendChild(statusBox);

  // Disabled actions placeholder while waiting
  const actionsCol = document.createElement('div');
  actionsCol.className = 'actions-col';
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const sendBtn = document.createElement('button');
    sendBtn.id = 'btn-sheet-send';
    sendBtn.type = 'button';
    sendBtn.className = 'btn-sheet btn-sheet-primary';
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg><span>SEND LINK</span>';
    actionsCol.appendChild(sendBtn);
  }
  const row = document.createElement('div');
  row.className = 'actions-row';
  const waBtn = document.createElement('button');
  waBtn.id = 'btn-sheet-wa';
  waBtn.type = 'button';
  waBtn.className = 'btn-sheet btn-sheet-secondary';
  waBtn.disabled = true;
  waBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.93 11.93 0 0 0 12.06 0C5.5 0 .15 5.35.15 11.91c0 2.1.55 4.14 1.59 5.95L0 24l6.32-1.66a11.87 11.87 0 0 0 5.74 1.47h.01c6.56 0 11.91-5.35 11.91-11.91 0-3.18-1.24-6.17-3.46-8.42zM12.07 21.8c-1.78 0-3.53-.48-5.06-1.39l-.36-.21-3.76.99 1-3.66-.23-.38a9.88 9.88 0 0 1-1.52-5.24c0-5.46 4.45-9.91 9.92-9.91 2.65 0 5.14 1.03 7.01 2.9 1.87 1.88 2.9 4.36 2.9 7.01 0 5.46-4.45 9.89-9.9 9.89zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/></svg><span>WHATSAPP</span>';
  const copyBtn = document.createElement('button');
  copyBtn.id = 'btn-sheet-copy';
  copyBtn.type = 'button';
  copyBtn.className = 'btn-sheet btn-sheet-secondary';
  copyBtn.disabled = true;
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>COPY LINK</span>';
  row.appendChild(waBtn);
  row.appendChild(copyBtn);
  actionsCol.appendChild(row);
  bodyEl.appendChild(actionsCol);
}

function renderShareSheetReady(data) {
  if (shareExpiryInterval) {
    clearInterval(shareExpiryInterval);
    shareExpiryInterval = null;
  }
  const bodyEl = document.getElementById('share-sheet-body');
  if (!bodyEl) return;
  bodyEl.replaceChildren();

  const mode = data.mode || 'daily';
  const origin = (typeof window !== 'undefined' && window.location.origin) || 'https://rogue2048.com';
  const fullUrl = `${origin.replace(/\/+$/, '')}/c/${data.code}`;
  const rawName = (typeof localStorage !== 'undefined' ? localStorage.getItem('rogue2048_display_name') : null)?.trim();
  const name = rawName || 'I';
  const points = data.points || 0;

  // 1. Preview Bubble
  const bubble = document.createElement('div');
  bubble.className = 'preview-bubble';

  const previewMsg = document.createElement('div');
  previewMsg.className = 'preview-msg';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = name;
  const restSpan = document.createElement('span');
  restSpan.textContent = mode === 'daily'
    ? ` scored ${formatPoints(points)} in today's Rogue 2048 Daily. Beat it?`
    : ` scored ${formatPoints(points)} in Rogue 2048. Beat it?`;
  previewMsg.appendChild(nameSpan);
  previewMsg.appendChild(restSpan);
  bubble.appendChild(previewMsg);

  const linkBox = document.createElement('div');
  linkBox.className = 'preview-link-box';
  linkBox.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
  const linkText = document.createElement('span');
  linkText.className = 'preview-link-text';
  linkText.textContent = fullUrl;
  linkBox.appendChild(linkText);
  bubble.appendChild(linkBox);
  bodyEl.appendChild(bubble);

  // 2. Meta Stack
  const metaStack = document.createElement('div');
  metaStack.className = 'meta-stack';

  if (mode === 'daily') {
    const expiryLine = document.createElement('div');
    expiryLine.className = 'expiry-line';
    expiryLine.id = 'share-expiry-line';
    const clockSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clockSvg.setAttribute('class', 'clock-icon');
    clockSvg.setAttribute('viewBox', '0 0 24 24');
    clockSvg.setAttribute('width', '13');
    clockSvg.setAttribute('height', '13');
    clockSvg.setAttribute('fill', 'none');
    clockSvg.setAttribute('stroke', 'currentColor');
    clockSvg.setAttribute('stroke-width', '2');
    clockSvg.setAttribute('aria-hidden', 'true');
    clockSvg.innerHTML = '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>';
    const expiryText = document.createElement('span');
    expiryText.id = 'share-expiry-text';
    expiryLine.appendChild(clockSvg);
    expiryLine.appendChild(expiryText);
    metaStack.appendChild(expiryLine);

    function updateDailyExpiry() {
      const now = new Date();
      let expiresMs = data.expiresAt ? new Date(data.expiresAt).getTime() : 0;
      if (!expiresMs || isNaN(expiresMs)) {
        expiresMs = now.getTime() + msUntilNextUtcMidnight(now);
      }
      const msRemaining = Math.max(0, expiresMs - now.getTime());
      const isSoon = msRemaining > 0 && msRemaining <= 2 * 3600 * 1000;
      if (isSoon) {
        expiryLine.classList.add('soon');
      } else {
        expiryLine.classList.remove('soon');
      }
      const resetTime = formatNextResetLocalTime(now);
      const countdown = formatCountdown(msRemaining);
      expiryText.textContent = `Ends ${resetTime} · in ${countdown}`;
    }

    updateDailyExpiry();
    shareExpiryInterval = setInterval(updateDailyExpiry, 60000);
  } else {
    const expiryLine = document.createElement('div');
    expiryLine.className = 'expiry-line';
    expiryLine.innerHTML = '<svg class="clock-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>Valid for 32 hours</span>';
    const freeNote = document.createElement('div');
    freeNote.className = 'free-note';
    freeNote.textContent = 'Your run was uploaded and checked.';
    metaStack.appendChild(expiryLine);
    metaStack.appendChild(freeNote);
  }
  bodyEl.appendChild(metaStack);

  // 3. Actions
  const shareSentence = mode === 'daily'
    ? `${name} scored ${formatPoints(points)} in today's Rogue 2048 Daily. Beat it?`
    : `${name} scored ${formatPoints(points)} in Rogue 2048. Beat it?`;

  const actionsCol = document.createElement('div');
  actionsCol.className = 'actions-col';

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'btn-sheet btn-sheet-primary';
    sendBtn.id = 'btn-sheet-send';
    sendBtn.setAttribute('aria-label', 'Send Link');
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg><span>SEND LINK</span>';
    sendBtn.addEventListener('click', () => {
      try {
        navigator.share({
          title: mode === 'daily' ? 'Rogue 2048 Daily' : 'Rogue 2048',
          text: shareSentence,
          url: fullUrl,
        }).catch(() => { /* user cancel ignored */ });
      } catch {}
    });
    actionsCol.appendChild(sendBtn);
  }

  const row = document.createElement('div');
  row.className = 'actions-row';

  const waBtn = document.createElement('button');
  waBtn.type = 'button';
  waBtn.className = 'btn-sheet btn-sheet-secondary';
  waBtn.id = 'btn-sheet-wa';
  waBtn.setAttribute('aria-label', 'Share on WhatsApp');
  waBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.93 11.93 0 0 0 12.06 0C5.5 0 .15 5.35.15 11.91c0 2.1.55 4.14 1.59 5.95L0 24l6.32-1.66a11.87 11.87 0 0 0 5.74 1.47h.01c6.56 0 11.91-5.35 11.91-11.91 0-3.18-1.24-6.17-3.46-8.42zM12.07 21.8c-1.78 0-3.53-.48-5.06-1.39l-.36-.21-3.76.99 1-3.66-.23-.38a9.88 9.88 0 0 1-1.52-5.24c0-5.46 4.45-9.91 9.92-9.91 2.65 0 5.14 1.03 7.01 2.9 1.87 1.88 2.9 4.36 2.9 7.01 0 5.46-4.45 9.89-9.9 9.89zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/></svg><span>WHATSAPP</span>';
  waBtn.addEventListener('click', () => {
    const waText = `${shareSentence} ${fullUrl}`;
    const waUrl = `https://wa.me/?text=${encodeURIComponent(waText)}`;
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  });
  row.appendChild(waBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-sheet btn-sheet-secondary';
  copyBtn.id = 'btn-sheet-copy';
  copyBtn.setAttribute('aria-label', 'Copy Link');
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>COPY LINK</span>';

  let copyRevertTimer = null;
  copyBtn.addEventListener('click', async () => {
    let ok = false;
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(fullUrl);
        ok = true;
      } catch {}
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = fullUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {}
    }
    showToast('Copied!');
    copyBtn.classList.add('btn-copied');
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg><span>COPIED</span>';
    if (copyRevertTimer) clearTimeout(copyRevertTimer);
    copyRevertTimer = setTimeout(() => {
      copyBtn.classList.remove('btn-copied');
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>COPY LINK</span>';
    }, 2000);
  });
  row.appendChild(copyBtn);

  actionsCol.appendChild(row);
  bodyEl.appendChild(actionsCol);
}

function renderShareSheetError(error, retryAfter = 0, retryCb = null) {
  if (shareExpiryInterval) {
    clearInterval(shareExpiryInterval);
    shareExpiryInterval = null;
  }
  const bodyEl = document.getElementById('share-sheet-body');
  if (!bodyEl) return;
  bodyEl.replaceChildren();

  let msg = "Couldn't create the link. Your run is saved.";
  let canRetry = false;

  if (error === 'not_found') {
    msg = 'No run to share yet.';
  } else if (error === 'too_short') {
    msg = 'Play a few more moves to challenge a friend.';
  } else if (error === 'rate_limited') {
    msg = (retryAfter > 0)
      ? `Too many challenges. Try again in ${formatCountdown(retryAfter * 1000)}.`
      : 'Too many challenges today. Try again tomorrow.';
  } else if (error === 'rejected' || error === 'version') {
    msg = "This run can't be shared.";
  } else if (error === 'network' || error === 'server') {
    msg = "Couldn't create the link. Your run is saved.";
    canRetry = true;
  }

  const statusBox = document.createElement('div');
  statusBox.className = 'status-box error';
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  statusBox.appendChild(textSpan);

  if (canRetry && typeof retryCb === 'function') {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn-retry';
    retryBtn.id = 'btn-sheet-retry';
    retryBtn.textContent = 'RETRY';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      retryCb();
    });
    statusBox.appendChild(retryBtn);
  }

  bodyEl.appendChild(statusBox);

  // Disabled actions in every error state
  const actionsCol = document.createElement('div');
  actionsCol.className = 'actions-col';
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const sendBtn = document.createElement('button');
    sendBtn.id = 'btn-sheet-send';
    sendBtn.type = 'button';
    sendBtn.className = 'btn-sheet btn-sheet-primary';
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg><span>SEND LINK</span>';
    actionsCol.appendChild(sendBtn);
  }
  const row = document.createElement('div');
  row.className = 'actions-row';
  const waBtn = document.createElement('button');
  waBtn.id = 'btn-sheet-wa';
  waBtn.type = 'button';
  waBtn.className = 'btn-sheet btn-sheet-secondary';
  waBtn.disabled = true;
  waBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20.52 3.48A11.93 11.93 0 0 0 12.06 0C5.5 0 .15 5.35.15 11.91c0 2.1.55 4.14 1.59 5.95L0 24l6.32-1.66a11.87 11.87 0 0 0 5.74 1.47h.01c6.56 0 11.91-5.35 11.91-11.91 0-3.18-1.24-6.17-3.46-8.42zM12.07 21.8c-1.78 0-3.53-.48-5.06-1.39l-.36-.21-3.76.99 1-3.66-.23-.38a9.88 9.88 0 0 1-1.52-5.24c0-5.46 4.45-9.91 9.92-9.91 2.65 0 5.14 1.03 7.01 2.9 1.87 1.88 2.9 4.36 2.9 7.01 0 5.46-4.45 9.89-9.9 9.89zm5.43-7.41c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/></svg><span>WHATSAPP</span>';
  const copyBtn = document.createElement('button');
  copyBtn.id = 'btn-sheet-copy';
  copyBtn.type = 'button';
  copyBtn.className = 'btn-sheet btn-sheet-secondary';
  copyBtn.disabled = true;
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>COPY LINK</span>';
  row.appendChild(waBtn);
  row.appendChild(copyBtn);
  actionsCol.appendChild(row);
  bodyEl.appendChild(actionsCol);
}

const shareCloseBtn = document.getElementById('btn-share-sheet-close');
if (shareCloseBtn) {
  shareCloseBtn.addEventListener('click', () => {
    closeShareSheet();
  });
}

const shareBackdrop = document.getElementById('share-sheet-backdrop');
if (shareBackdrop) {
  shareBackdrop.addEventListener('click', () => {
    closeShareSheet();
  });
}

document.addEventListener('keydown', (e) => {
  const sheet = document.getElementById('share-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeShareSheet();
    return;
  }

  if (e.key === 'Tab') {
    const focusable = sheet.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// Window test hooks for automated verification
if (typeof window !== 'undefined') {
  window.__testRenderRankingCard = renderGameOverRankingCard;
  window.__testOpenLeaderboard = openLeaderboardOverlay;
  window.__testCloseLeaderboard = closeLeaderboardOverlay;
  window.__testRenderLeaderboardTab = renderLeaderboardTab;
  window.__testRenderTabContent = renderTabContent;
  window.__testOpenNameSheet = openNameSheet;
  window.__testCloseNameSheet = closeNameSheet;
  window.__testHandleNameSubmit = handleNameSubmit;
  window.__testOpenShareSheet = openShareSheet;
  window.__testCloseShareSheet = closeShareSheet;
  window.__testRequestCreateChallenge = requestCreateChallenge;
  window.__testActiveShareSheetRunKey = () => activeShareSheetRunKey;
  window.__testCachedChallengeResult = () => cachedChallengeResult;
  window.__testSetCachedChallengeResult = (v, key = null) => {
    cachedChallengeResult = v;
    if (key !== null) activeShareSheetRunKey = key;
  };
  window.__testTabCache = () => tabCache;
  window.__testSetTabCache = (key, data, time = Date.now()) => {
    tabCache[key] = data;
    lastBoardFetchTime[key] = time;
  };
  window.__testActiveTab = () => activeLeaderboardTab;
  window.__testUpdateStartLeaderboard = updateStartOverlayLeaderboardControls;
  window.__testConfigureGameOverCard = ({
    score = 0,
    isNewBest = false,
    cleanSlateCount = 0,
    relics = [],
    moves = 0,
    timeMs = 0,
    maxTile = 2,
    drafts = 0,
    seed = 0
  } = {}) => {
    if (endScoreEl) endScoreEl.textContent = Number(score).toLocaleString('en-US');
    if (endNewBestBadge) {
      if (isNewBest) endNewBestBadge.classList.remove('hidden');
      else endNewBestBadge.classList.add('hidden');
    }
    if (endCleanSlateChip) {
      if (cleanSlateCount >= 1) {
        endCleanSlateChip.textContent = `CLEAN SLATE x ${cleanSlateCount}`;
        endCleanSlateChip.classList.remove('hidden');
      } else {
        endCleanSlateChip.classList.add('hidden');
      }
    }
    if (endMovesEl) endMovesEl.textContent = Number(moves).toLocaleString('en-US');
    if (endTimeEl) endTimeEl.textContent = formatPlayTime(timeMs);
    if (endMaxTileEl) endMaxTileEl.textContent = maxTile;
    if (endDraftsEl) endDraftsEl.textContent = drafts;
    if (endSeedEl) endSeedEl.textContent = seed;

    if (endRelicsList) {
      endRelicsList.innerHTML = '';
      if (!relics || relics.length === 0) {
        endRelicsList.innerHTML = '<span class="no-relics-msg" style="font-size:11px; color:var(--muted);">No relics drafted</span>';
      } else {
        for (const rid of relics) {
          const chip = document.createElement('div');
          chip.className = 'relic-mini art relic-chip';
          chip.setAttribute('data-relic', rid);
          chip.setAttribute('title', RELIC_NAMES[rid] || rid);
          chip.appendChild(getRelicIconElement(rid, 22));
          endRelicsList.appendChild(chip);
        }
      }
    }
  };
}

window.getTopRuns = getTopRuns;
window.saveTopRun = saveTopRun;
window.showBestRunsOverlay = showBestRunsOverlay;
window.hideBestRunsOverlay = hideBestRunsOverlay;
window.getMovesToNextDraft = getMovesToNextDraft;
window.getActivePlayMs = () => Math.round(activePlayMs);
window.formatPlayTime = formatPlayTime;

window.getCopyPayload = () => {
  const metadata = getDiagnosticMetadata();
  const currentRun = currentRunLog || controller.getRunLog(metadata);
  if (currentRun && (currentRun.activeMs === undefined || currentRun.activeMs === null)) {
    currentRun.activeMs = Math.round(activePlayMs);
  }
  const history = getStoredHistory();
  const errors = getStoredErrors();
  return { currentRun, history, errors };
};

// Initialize game on load
const buildIdEl = document.getElementById('start-build-id');
if (buildIdEl) {
  buildIdEl.textContent = `BUILD: ${BUILD_ID}`;
}

updateSoundButtons(isSoundEnabled());

window.addEventListener('resize', () => {
  if (controller) {
    syncBoard(controller.getBoard(), 'windowResize');
  }
});

if (typeof ResizeObserver !== 'undefined' && boardEl) {
  const ro = new ResizeObserver(() => {
    if (controller && !isAnimating) {
      syncBoard(controller.getBoard(), 'resizeObserver');
    }
  });
  ro.observe(boardEl);
}

const hasLaunchParams = window.location.search && window.location.search.length > 1;
if (hasLaunchParams) {
  startNewGame(initialSeed);
} else {
  startNewGame(null);
  if (startOverlay) {
    startOverlay.classList.remove('hidden');
    startDailyCountdown();
  }
}

// R13 Start Screen Setup: Ensure all initial content is set synchronously before revealing
updateStartOverlayLeaderboardControls();
if (canShowDailyButton()) {
  if (btnPlayDaily) btnPlayDaily.classList.remove('hidden');
  if (dailyDisclosureContainer) dailyDisclosureContainer.classList.remove('hidden');
  startDailyCountdown();
}
if (startBestScoreEl) {
  startBestScoreEl.textContent = getStoredBestScore().toLocaleString('en-US');
}
if (buildIdEl) {
  buildIdEl.textContent = `BUILD: ${BUILD_ID}`;
}
updateSoundButtons(isSoundEnabled());

if (window.TutorialController) {
  window.TutorialController.setRelicProvider({
    RELIC_NAMES,
    getRelicOneLiner: (id) => getRelicOneLiner(id, (controller && controller.config) ? controller.config : (activeConfig || {})),
    ICON_MAP,
    isAbility: (id) => id === 'diagonal_charge' || id === 'eraser' || id === 'rewind'
  });
}

// Reveal start screen at its final layout with zero flash or layout jump
document.documentElement.classList.add('app-ready');

/*DEV_LAB_BEGIN*/
(function initDevLabModule() {
  if (typeof window === 'undefined') return;

  const labApi = {
    setPersistence(val) {
      persistenceEnabled = !!val;
      if (!persistenceEnabled && btnCopyLog) {
        btnCopyLog.disabled = true;
        btnCopyLog.title = 'Run log disabled in sandbox';
        let note = document.getElementById('sandbox-copy-note');
        if (!note && btnCopyLog.parentNode) {
          note = document.createElement('span');
          note.id = 'sandbox-copy-note';
          note.className = 'sandbox-note';
          note.style.cssText = 'display:block; font-size:11px; color:#c89b3c; margin-top:2px;';
          note.textContent = 'Run log disabled in sandbox';
          btnCopyLog.parentNode.insertBefore(note, btnCopyLog.nextSibling);
        }
      }
    },
    stage(spec) {
      if (!controller) return;
      if (Array.isArray(spec.board)) {
        const mapped = spec.board.map(c => (c === null || c === undefined) ? 0 : ((c && typeof c === 'object') ? { ...c } : c));
        if (controller.state) controller.state.board = mapped;
        controller.board = mapped;
      }
      if (Array.isArray(spec.relics)) {
        const relicSet = new Set(spec.relics);
        if (controller.state) controller.state.relics = relicSet;
        controller.relics = relicSet;
      }
      if (spec.charges && typeof spec.charges === 'object') {
        if (!controller.state.abilities) controller.state.abilities = {};
        for (const [k, v] of Object.entries(spec.charges)) {
          const rid = (k === 'diagonal-merge' || k === 'diagonal') ? 'diagonal_charge' : k;
          if (!controller.state.abilities[rid]) controller.state.abilities[rid] = {};
          controller.state.abilities[rid].charges = v;
        }
      }
      if (typeof spec.moveCount === 'number') {
        if (controller.state) controller.state.moveCount = spec.moveCount;
        controller.moveCount = spec.moveCount;
      }
      if (typeof spec.movesSinceLastStone === 'number') {
        if (controller.state) controller.state.movesSinceLastStone = spec.movesSinceLastStone;
        controller.movesSinceLastStone = spec.movesSinceLastStone;
      }
      if (typeof spec.draftDue === 'boolean') {
        if (controller.state) controller.state.draftDueOnNextMove = spec.draftDue;
        controller.draftDueOnNextMove = spec.draftDue;
      }
      if (controller.state) {
        if (!controller.state.config) controller.state.config = {};
        controller.state.config.ascensionAt = spec.ascensionAt || 2048;
        controller.state.ascensionLevel = 0;
        controller.state.over = false;
        controller.state.pendingDecision = null;
      }
      controller.pendingDecision = null;
      if (draftOverlay) draftOverlay.classList.add('hidden');
      if (controller.config) {
        controller.config.ascensionAt = spec.ascensionAt || 2048;
      }
      uiMoveLog = [];
      controller.moveLog = [];
      syncBoard(controller.getBoard(), 'lab-stage');
      renderAbilityBar();
      updateHeader();
    },
    triggerSwipe(direction) {
      const dirMap = { left: 'L', right: 'R', up: 'U', down: 'D', L: 'L', R: 'R', U: 'U', D: 'D' };
      handleMove(dirMap[direction] || direction, 'swipe');
    },
    triggerAbility(type, target) {
      const rid = (type === 'diagonal-merge' || type === 'diagonal') ? 'diagonal_charge' : type;
      executeAbility(rid, target);
    },
    triggerRewind() {
      executeAbility('rewind', {});
    },
    getCleanSlateState() {
      return cleanSlateSequenceState;
    },
    onPhase(phaseName, data) {
      if (window.__ROGUE_LAB__ && typeof window.__ROGUE_LAB__.handlePhase === 'function') {
        window.__ROGUE_LAB__.handlePhase(phaseName, data);
      }
    },
    getAscensions() {
      return controller ? (controller.getState().ascensions || []) : [];
    },
    getBoard() {
      return controller ? controller.getBoard() : [];
    },
    getController() {
      return controller;
    },
    restartSandbox() {
      startNewGame();
    }
  };

  window.__ROGUE_LAB_API__ = labApi;

  const urlParams = new URLSearchParams(window.location.search);
  const hasLabParam = urlParams.get('lab') === '1';
  let isLabStored = false;
  try {
    isLabStored = window.sessionStorage?.getItem('2048_rogue_lab') === '1';
  } catch { }

  if (hasLabParam || isLabStored) {
    try {
      window.sessionStorage.setItem('2048_rogue_lab', '1');
    } catch { }
    labApi.setPersistence(false);
    import('./dev/lab.js').then(mod => {
      if (mod && mod.initLab) {
        mod.initLab(labApi);
      }
    }).catch(err => console.error('Failed to load lab:', err));
  }
})();
/*DEV_LAB_END*/

