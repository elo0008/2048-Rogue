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
      localStorage.setItem(STORAGE_KEY_TOP_RUNS, JSON.stringify(top10));
    } catch {}
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
      localStorage.setItem(STORAGE_KEY_TOP_RUNS, JSON.stringify(top10));
    } catch {}
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
    localStorage.setItem(STORAGE_KEY_ERRORS, JSON.stringify(trimmed));
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
  } catch {}

  let audioState = 'none';
  try {
    audioState = getAudioState();
  } catch {}

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
const startHowList = document.getElementById('start-how-list');

const draftOverlay = document.getElementById('draft-overlay');
const draftTitleEl = document.getElementById('draft-title');
const draftEyebrowEl = document.getElementById('draft-eyebrow');
const draftOffersRow = document.getElementById('draft-offers-row');
const draftOwnedChips = document.getElementById('draft-owned-chips');
const draftOwnedCount = document.getElementById('draft-owned-count');

const pauseOverlay = document.getElementById('pause-overlay');
const btnPauseResume = document.getElementById('btn-pause-resume');
const btnPauseRestart = document.getElementById('btn-pause-restart');
const btnPauseEndRun = document.getElementById('btn-pause-end-run');
const btnPauseSound = document.getElementById('btn-pause-sound');
const btnPauseHow = document.getElementById('btn-pause-how');
const pauseHowList = document.getElementById('pause-how-list');

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
  } catch {}
  return sessionHintsSeen;
}

function markHintSeen(hintId) {
  sessionHintsSeen.add(hintId);
  try {
    const seen = getSeenHints();
    seen.add(hintId);
    localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify(Array.from(seen)));
  } catch {}
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
      try { a.cancel(); } catch {}
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
      cleanSlateBanner.classList.remove('hidden');

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
    cleanSlateBanner.classList.remove('hidden');

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
          for (const a of stone.getAnimations()) try { a.cancel(); } catch {}
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
          for (const a of tile.getAnimations()) try { a.cancel(); } catch {}
        }
        if (typeof face.getAnimations === 'function') {
          for (const a of face.getAnimations()) try { a.cancel(); } catch {}
        }
      }
    }
  }
}

function syncBoard(board = (controller ? controller.getBoard() : []), callSite = 'other') {
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
    } catch {}
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

function playReverseSlideAnimation(entry, restoredBoard, res) {
  isAnimating = true;
  const metrics = getGridMetrics();

  // (1) Newly spawned tiles/stones shrink/fade out
  const spawnedIndices = [];
  for (let i = 0; i < 16; i++) {
    if (entry.boardAfter[i] !== 0 && entry.boardAfterSlide[i] === 0) {
      spawnedIndices.push(i);
    }
  }

  const spawnedEls = [];
  for (const idx of spawnedIndices) {
    const el = tilesLayer.querySelector(`.tile[data-index="${idx}"], .stone[data-index="${idx}"]`);
    if (el) {
      spawnedEls.push(el);
      const isStone = el.classList.contains('stone');
      const face = el.querySelector('.tile-face') || el;
      if (isStone) {
        face.animate([
          { transform: 'scale(1.0)', opacity: 1 },
          { transform: 'scale(1.45)', opacity: 0 }
        ], { duration: 80, easing: 'ease-in', fill: 'forwards' });
      } else {
        face.animate([
          { transform: 'scale(1.0)', opacity: 1 },
          { transform: 'scale(0.2)', opacity: 0 }
        ], { duration: 60, easing: 'ease-in', fill: 'forwards' });
      }
      setTimeout(() => {
        if (el.parentNode) el.remove();
      }, 85);
    }
  }

  // (2) Merged survivor splits and unmerged tiles slide back following reversed overshoot
  const moves = entry.moves || [];
  const swipeDir = entry.dir;
  const overshootDx = swipeDir === 'L' ? -4 : (swipeDir === 'R' ? 4 : 0);
  const overshootDy = swipeDir === 'U' ? -4 : (swipeDir === 'D' ? 4 : 0);

  const byDest = new Map();
  for (const m of moves) {
    if (!byDest.has(m.toIndex)) byDest.set(m.toIndex, []);
    byDest.get(m.toIndex).push(m);
  }

  const animPromises = [];

  for (const [dest, destMoves] of byDest.entries()) {
    const destTrans = getTileTranslate(dest, metrics);

    if (destMoves.length === 2 && destMoves[0].isMerge) {
      const m1 = destMoves[0];
      const m2 = destMoves[1];
      const val = m1.value;

      let survivor = tilesLayer.querySelector(`.tile[data-index="${dest}"]:not(.duplicate)`);
      if (!survivor) {
        survivor = createTileElement(dest, m1.resultValue, false, metrics);
        tilesLayer.appendChild(survivor);
      }
      survivor.className = `tile ${getTileClasses(val)}`;
      survivor.setAttribute('data-val', String(val));
      const sFace = survivor.querySelector('.tile-face');
      if (sFace) {
        sFace.className = `tile-face ${getTileClasses(val)}`;
        sFace.textContent = val;
        sFace.animate([
          { transform: 'scale(1.15)', offset: 0 },
          { transform: 'scale(1.0)', offset: 1 }
        ], { duration: 90, easing: 'ease-out' });
      }

      const duplicate = createTileElement(dest, val, false, metrics);
      duplicate.classList.add('duplicate');
      tilesLayer.appendChild(duplicate);

      const delay = (3 - m1.lineIndex) * 15;
      const t1 = getTileTranslate(m1.fromIndex, metrics);
      const t2 = getTileTranslate(m2.fromIndex, metrics);

      survivor.setAttribute('data-index', String(m1.fromIndex));
      duplicate.setAttribute('data-index', String(m2.fromIndex));

      const a1 = survivor.animate([
        { transform: `translate3d(${destTrans.x}px, ${destTrans.y}px, 0)` },
        { transform: `translate3d(${t1.x}px, ${t1.y}px, 0)` }
      ], {
        duration: 140,
        delay,
        easing: 'cubic-bezier(.15, .85, .3, 1)',
        fill: 'forwards'
      });
      animPromises.push(a1.finished);

      const a2 = duplicate.animate([
        { transform: `translate3d(${destTrans.x}px, ${destTrans.y}px, 0)` },
        { transform: `translate3d(${t2.x}px, ${t2.y}px, 0)` }
      ], {
        duration: 140,
        delay,
        easing: 'cubic-bezier(.15, .85, .3, 1)',
        fill: 'forwards'
      });
      animPromises.push(a2.finished);

    } else if (destMoves.length === 1) {
      const m = destMoves[0];
      const el = tilesLayer.querySelector(`.tile[data-index="${dest}"]`);
      if (el) {
        const fromTrans = getTileTranslate(m.fromIndex, metrics);
        el.setAttribute('data-index', String(m.fromIndex));
        const delay = (3 - m.lineIndex) * 15;

        const startX = destTrans.x + overshootDx;
        const startY = destTrans.y + overshootDy;

        const a = el.animate([
          { transform: `translate3d(${startX}px, ${startY}px, 0)`, offset: 0 },
          { transform: `translate3d(${fromTrans.x}px, ${fromTrans.y}px, 0)`, offset: 1 }
        ], {
          duration: 140,
          delay,
          easing: 'cubic-bezier(.15, .85, .3, 1)',
          fill: 'forwards'
        });
        animPromises.push(a.finished);
      }
    }
  }

  let finished = false;
  function finishReverseAnimation() {
    if (finished) return;
    finished = true;
    for (const el of spawnedEls) {
      if (el && el.parentNode) el.remove();
    }
    alignDomToBoard(restoredBoard, metrics);
    syncBoard(restoredBoard, 'rewind');
    isAnimating = false;
    currentAnimationState = null;
    updateHeader();
    renderGhostTiles();
    renderAbilityBar();
    if (controller.isGameOver()) handleGameOver();
  }

  currentAnimationState = {
    commitSlideCompletion: finishReverseAnimation,
    cancelAnimation: finishReverseAnimation,
  };

  Promise.all(animPromises).then(() => {
    setTimeout(finishReverseAnimation, 20);
  }).catch(() => finishReverseAnimation());
}

function executeRewind() {
  if (isAnimating && currentAnimationState) {
    finishCurrentAnimationImmediately();
  }

  const logEntry = uiMoveLog.length > 0 ? uiMoveLog.pop() : null;
  const res = controller.useAbility('rewind', {});
  cancelTargeting();

  if (!res.success) {
    showToast(`Error: ${res.error || 'Failed to rewind'}`);
    return;
  }

  playRewind();

  const restoredBoard = controller.getBoard();
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let canReverse = !prefersReduced && logEntry !== null;
  if (canReverse) {
    for (let i = 0; i < 16; i++) {
      if (restoredBoard[i] !== logEntry.boardBefore[i]) {
        canReverse = false;
        break;
      }
    }
  }

  if (!canReverse) {
    boardEl.classList.add('rewind-fade', 'rewinding');
    setTimeout(() => boardEl.classList.remove('rewind-fade', 'rewinding'), 150);
    alignDomToBoard(restoredBoard, getGridMetrics());
    syncBoard(restoredBoard, 'rewind');
    updateHeader();
    renderGhostTiles();
    renderAbilityBar();
    if (controller.isGameOver()) handleGameOver();
    return;
  }

  playReverseSlideAnimation(logEntry, restoredBoard, res);
}

function executeAbility(relicId, target) {
  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
    cleanSlateSequenceState.ignoredAbilityCount = (cleanSlateSequenceState.ignoredAbilityCount || 0) + 1;
    return;
  }

  if (isAnimating) {
    finishCurrentAnimationImmediately();
  }

  if (relicId === 'rewind') {
    executeRewind();
    return;
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
      try { a.cancel(); } catch {}
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
  if (currentAnimationState && typeof currentAnimationState.cancelAnimation === 'function') {
    currentAnimationState.cancelAnimation();
  } else {
    if (slideAnimTimer) {
      clearTimeout(slideAnimTimer);
      slideAnimTimer = null;
    }
    for (const a of activeAnimations) {
      try { a.cancel(); } catch {}
    }
    activeAnimations = [];
    isAnimating = false;
    currentAnimationState = null;
  }
}

function handleMove(direction, inputType = 'key') {
  if (controller.isGameOver()) return;
  if (controller.hasPendingDecision()) return;

  if (cleanSlateSequenceState && cleanSlateSequenceState.inputLocked) {
    cleanSlateSequenceState.ignoredSwipeCount = (cleanSlateSequenceState.ignoredSwipeCount || 0) + 1;
    return;
  }

  if (isAnimating) {
    finishCurrentAnimationImmediately();
  }

  cancelTargeting();
  dismissHint();
  controller.recordInput(inputType, direction);
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
      try { a.cancel(); } catch {}
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
      try { a.cancel(); } catch {}
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
  }

  currentAnimationState = { commitSlideCompletion, cancelAnimation };

  if (activeAnimations.length === 0) {
    commitSlideCompletion();
  } else {
    Promise.all(activeAnimations.map(anim => {
      if (typeof anim.finished?.then === 'function') {
        return anim.finished.catch(() => {});
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
  const isNewBest = currentPoints > storedBest;
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

  endOverlay.classList.remove('hidden');
}

/* -------------------------------------------------------------
 * Run Initialization
 * ------------------------------------------------------------- */
function startNewGame(seed = null) {
  cancelOngoingAnimation();
  tickPlayTimer();
  activePlayMs = 0;
  lastPerfTime = performance.now();
  isRunActive = true;
  lastDisplayedSecond = -1;
  if (endTimeEl) endTimeEl.textContent = '0:00';
  if (pauseTimeVal) pauseTimeVal.textContent = '0:00';
  startPlayTimer();

  const chosenSeed = seed !== null ? seed : (initialSeed !== null ? initialSeed : Math.floor(Math.random() * 2147483647) + 1);
  const bestScore = getStoredBestScore();
  controller = new GameController(chosenSeed, activeConfig, playerId);
  controller.bestScoreAtRunStart = bestScore;

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
      e.preventDefault();
      pauseOverlay.classList.add('hidden');
      return;
    }
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
let endRunConfirmTimer = null;
function resetEndRunButton() {
  if (endRunConfirmTimer !== null) {
    clearTimeout(endRunConfirmTimer);
    endRunConfirmTimer = null;
  }
  if (btnPauseEndRun) {
    btnPauseEndRun.textContent = 'End run';
  }
}

if (btnPauseMenu && pauseOverlay) {
  btnPauseMenu.addEventListener('click', () => {
    controller.recordInput('tap');
    if (isAnimating || cleanSlateSequenceState) {
      finishCurrentAnimationImmediately();
    }
    tickPlayTimer();
    resetEndRunButton();
    if (pauseTimeVal) pauseTimeVal.textContent = formatPlayTime(activePlayMs);
    pauseOverlay.classList.remove('hidden');
  });
}

if (btnPauseResume && pauseOverlay) {
  btnPauseResume.addEventListener('click', () => {
    resetEndRunButton();
    pauseOverlay.classList.add('hidden');
    lastPerfTime = performance.now();
    if (isAnimating || cleanSlateSequenceState) {
      finishCurrentAnimationImmediately();
    }
    if (controller) {
      syncBoard(controller.getBoard(), 'pauseResume');
    }
  });
}

// Reconcile board DOM on visibilitychange
document.addEventListener('visibilitychange', () => {
  tickPlayTimer();
  if (document.visibilityState === 'visible') {
    lastPerfTime = performance.now();
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
    resetEndRunButton();
    pauseOverlay.classList.add('hidden');
    startNewGame();
    showToast('New run started');
  });
}

if (btnPauseEndRun && pauseOverlay) {
  btnPauseEndRun.addEventListener('click', () => {
    controller.recordInput('tap');
    if (endRunConfirmTimer !== null) {
      // Second tap within 3 seconds
      resetEndRunButton();
      pauseOverlay.classList.add('hidden');
      if (controller && !controller.isGameOver()) {
        controller.endRun();
        handleGameOver();
      }
    } else {
      // First tap
      btnPauseEndRun.textContent = 'Tap again to end';
      endRunConfirmTimer = setTimeout(() => {
        resetEndRunButton();
      }, 3000);
    }
  });
}

if (btnPauseHow && pauseHowList) {
  btnPauseHow.addEventListener('click', () => {
    pauseHowList.classList.toggle('hidden');
  });
}

// How to play on Start screen
if (btnStartHow && startHowList) {
  btnStartHow.addEventListener('click', () => {
    const isHidden = startHowList.classList.toggle('hidden');
    btnStartHow.setAttribute('aria-expanded', String(!isHidden));
  });
}

// Start button (idempotent: cannot run twice)
if (btnPlayStart) {
  btnPlayStart.addEventListener('click', (e) => {
    e.preventDefault();
    initAudio();
    playClick();
    if (startOverlay && startOverlay.classList.contains('hidden')) return;
    startNewGame();
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
    btnPauseSound.innerHTML = `Sound: ${enabled ? 'On' : 'Off'} <span style="float:right">${enabled ? speakerOnSvg : speakerMutedSvg}</span>`;
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

// Play again button
if (btnPlayAgain) {
  btnPlayAgain.addEventListener('click', () => {
    initAudio();
    playClick();
    startNewGame();
  });
}

// Copy run log button (copies { currentRun: <record>, history: [<last 20 records>] }, fallback download)
if (btnCopyLog) {
  btnCopyLog.addEventListener('click', async () => {
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
      } catch {}
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
  }
  previousOverlayBeforeBestRuns = null;
  lastPerfTime = performance.now();
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
    const bro = document.getElementById('best-runs-overlay');
    if (bro && !bro.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      hideBestRunsOverlay();
    }
  }
});

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
  if (startOverlay) startOverlay.classList.remove('hidden');
}
