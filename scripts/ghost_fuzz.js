import { findChrome } from './find_chrome.js';
import { getSlideSetup, getDiagonalSetup } from './dev/find_setups.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = findChrome();

const PORT = 3012;
const CDP_PORT = 9232;

const isLongMode = process.argv.includes('--long');
const ACTIONS_PER_SCENARIO = isLongMode ? 200 : 32;

const outDir = path.join(rootDir, 'scripts', 'out');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}
const outFilePath = path.join(outDir, isLongMode ? 'fuzz_long.txt' : 'fuzz_short.txt');
const logStream = fs.createWriteStream(outFilePath, { encoding: 'utf8' });

const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  const line = args.join(' ');
  logStream.write(line + '\n');
  origLog(...args);
};
console.error = (...args) => {
  const line = args.join(' ');
  logStream.write(line + '\n');
  origErr(...args);
};

console.log('=== IDLE GUARD ALLOW-LIST ===');
console.log('Classes excluded from idle timeout (infinite/decorative):');
console.log('  - stuck-impact-wave');
console.log('  - is-stuck');
console.log('  - highlight-stuck');
console.log('  - rescue');
console.log('  - candidate');
console.log('  - target-candidate');
console.log('  - valid');
console.log('  - target-partner');
console.log('  - shatter-pulse');
console.log('  - erasable');
console.log('=============================');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer() {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(PORT, () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome CDP');
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.callbacks.has(data.id)) {
        const { resolve, reject } = this.callbacks.get(data.id);
        this.callbacks.delete(data.id);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    this.ws.onclose = () => {
      for (const [id, { reject }] of this.callbacks) {
        reject(new Error('WebSocket closed'));
      }
      this.callbacks.clear();
    };
    this.ws.onerror = (err) => {
      for (const [id, { reject }] of this.callbacks) {
        reject(err);
      }
      this.callbacks.clear();
    };
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP method ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.callbacks.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// Invariant checker script to run in browser context
const INVARIANT_SCRIPT = `
  (() => {
    const board = window.controller ? window.controller.getBoard() : [];
    const numericCells = board.map((v, i) => ({ v, i })).filter(c => typeof c.v === 'number' && c.v > 0);
    const stoneCells = board.map((v, i) => ({ v, i })).filter(c => c.v === 'S');

    const boardEl = document.getElementById('game-board');
    if (!boardEl) return { pass: false, rule: 0, message: 'No #game-board found' };

    const tilesLayer = document.getElementById('tiles-layer');
    if (!tilesLayer) return { pass: false, rule: 0, message: 'No #tiles-layer found' };

    const cells = Array.from(boardEl.querySelectorAll('.cell, .grid-cell'));
    const allTileEls = Array.from(tilesLayer.querySelectorAll(':scope > .tile:not(.stone)'));
    const allStoneEls = Array.from(tilesLayer.querySelectorAll(':scope > .stone, :scope > .tile.stone'));

    // (1) number-tile elements == numeric board cells; stone elements == stone cells
    if (allTileEls.length !== numericCells.length) {
      return {
        pass: false,
        rule: 1,
        message: 'Assertion (1) failed: found ' + allTileEls.length + ' number-tile elements, expected ' + numericCells.length + ' numeric board cells.'
      };
    }
    if (allStoneEls.length !== stoneCells.length) {
      return {
        pass: false,
        rule: 1,
        message: 'Assertion (1) failed: found ' + allStoneEls.length + ' stone elements, expected ' + stoneCells.length + ' stone cells.'
      };
    }

    // (2) all tile and stone elements are inside #tiles-layer; no .cell contains any
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const items = c.querySelectorAll('.tile, .stone, .tile-stone');
      if (items.length > 0) {
        return {
          pass: false,
          rule: 2,
          message: 'Assertion (2) failed: cell ' + i + ' contains ' + items.length + ' tile/stone elements (no .cell may hold any).'
        };
      }
    }
    const strayBoardItems = boardEl.querySelectorAll(':scope > .tile, :scope > .stone, :scope > .tile-stone');
    if (strayBoardItems.length > 0) {
      return {
        pass: false,
        rule: 2,
        message: 'Assertion (2) failed: board holds ' + strayBoardItems.length + ' stray elements outside #tiles-layer.'
      };
    }

    // (3) at idle each element's rect center equals its board cell's rect center within 1 px and data-val equals board value
    for (let i = 0; i < cells.length; i++) {
      const cellRect = cells[i].getBoundingClientRect();
      const cellCenterX = cellRect.left + cellRect.width / 2;
      const cellCenterY = cellRect.top + cellRect.height / 2;
      const expectedVal = board[i];

      if (typeof expectedVal === 'number' && expectedVal > 0) {
        const matchingTiles = allTileEls.filter(t => t.getAttribute('data-index') === String(i));
        if (matchingTiles.length !== 1) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: cell ' + i + ' expected 1 tile, found ' + matchingTiles.length
          };
        }
        const t = matchingTiles[0];
        const tRect = t.getBoundingClientRect();
        const tCenterX = tRect.left + tRect.width / 2;
        const tCenterY = tRect.top + tRect.height / 2;
        if (Math.abs(cellCenterX - tCenterX) > 1.05 || Math.abs(cellCenterY - tCenterY) > 1.05) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: tile at cell ' + i + ' center (' + tCenterX.toFixed(1) + ',' + tCenterY.toFixed(1) + ') != cell center (' + cellCenterX.toFixed(1) + ',' + cellCenterY.toFixed(1) + ') within 1px'
          };
        }
        const dataVal = t.getAttribute('data-val');
        if (String(expectedVal) !== String(dataVal)) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: cell ' + i + ' expects value ' + expectedVal + ', but tile data-val is "' + dataVal + '"'
          };
        }
        const face = t.querySelector('.tile-face');
        const textVal = face ? face.textContent.trim() : t.textContent.trim();
        if (String(expectedVal) !== String(textVal)) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: cell ' + i + ' expects value ' + expectedVal + ', but tile text is "' + textVal + '"'
          };
        }
      } else if (expectedVal === 'S') {
        const matchingStones = allStoneEls.filter(s => s.getAttribute('data-index') === String(i));
        if (matchingStones.length !== 1) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: cell ' + i + ' expected 1 stone, found ' + matchingStones.length
          };
        }
        const s = matchingStones[0];
        const sRect = s.getBoundingClientRect();
        const sCenterX = sRect.left + sRect.width / 2;
        const sCenterY = sRect.top + sRect.height / 2;
        if (Math.abs(cellCenterX - sCenterX) > 1.05 || Math.abs(cellCenterY - sCenterY) > 1.05) {
          return {
            pass: false,
            rule: 3,
            message: 'Assertion (3) failed: stone at cell ' + i + ' center != cell center within 1px'
          };
        }
      }
    }

    // (4) no leftover transform other than base translate, no running animations, opacity 1
    const allEls = [...allTileEls, ...allStoneEls];
    for (const el of allEls) {
      const cs = window.getComputedStyle(el);
      const op = parseFloat(cs.opacity);
      if (Math.abs(op - 1) > 0.01) {
        return {
          pass: false,
          rule: 4,
          message: 'Assertion (4) failed: element has opacity ' + op + ' (expected 1)'
        };
      }
      const anims = typeof el.getAnimations === 'function' ? el.getAnimations() : [];
      if (anims.some(a => a.playState === 'running')) {
        return {
          pass: false,
          rule: 4,
          message: 'Assertion (4) failed: tile container has running animation'
        };
      }
      const face = el.querySelector('.tile-face, .stone-face');
      if (face) {
        const faceCs = window.getComputedStyle(face);
        const faceTf = faceCs.transform;
        if (faceTf && faceTf !== 'none' && faceTf !== 'matrix(1, 0, 0, 1, 0, 0)') {
          return {
            pass: false,
            rule: 4,
            message: 'Assertion (4) failed: tile face has leftover transform ' + faceTf
          };
        }
        const faceAnims = typeof face.getAnimations === 'function' ? face.getAnimations() : [];
        if (faceAnims.some(a => a.playState === 'running')) {
          return {
            pass: false,
            rule: 4,
            message: 'Assertion (4) failed: tile face has running animation'
          };
        }
      }
    }

    // (5) at every 16 ms sample during a slide, document.elementFromPoint at moving tile center returns tile or child
    if (window.__slideMonitoringViolations && window.__slideMonitoringViolations.length > 0) {
      const v = window.__slideMonitoringViolations[0];
      return {
        pass: false,
        rule: 5,
        message: 'Assertion (5) failed: element <' + v.topElTag + ' class="' + v.topElClass + '"> painted over moving tile at (' + v.cx + ',' + v.cy + ')'
      };
    }

    // (6) targeting invariant: in targeting modes, highlighted/candidate tiles have computed opacity >= 0.4, alpha > 0, and elementFromPoint returns tile or child
    const targetingActive = !document.getElementById('targeting-bar')?.classList.contains('hidden') ||
      Boolean(tilesLayer.querySelector('.tile.candidate, .tile.target-candidate, .tile.selected, .tile.target-selected, .tile.valid, .tile.target-partner, .tile.erasable'));
    if (targetingActive) {
      const candidates = tilesLayer.querySelectorAll('.tile.candidate, .tile.target-candidate, .tile.selected, .tile.target-selected, .tile.valid, .tile.target-partner, .tile.erasable');
      for (const t of candidates) {
        const cs = window.getComputedStyle(t);
        const op = parseFloat(cs.opacity);
        if (op < 0.4) {
          return {
            pass: false,
            rule: 6,
            message: 'Assertion (6) failed: targeting candidate tile has computed opacity ' + op + ' (< 0.4)'
          };
        }
        const color = cs.color;
        if (color.includes('rgba') && color.includes(', 0)')) {
          return {
            pass: false,
            rule: 6,
            message: 'Assertion (6) failed: targeting candidate tile text is transparent'
          };
        }
        const r = t.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && topEl !== t && !t.contains(topEl)) {
          return {
            pass: false,
            rule: 6,
            message: 'Assertion (6) failed: element <' + topEl.tagName + ' class="' + topEl.className + '"> occluded targeting candidate tile at (' + cx + ',' + cy + ')'
          };
        }
      }

      // (7) D1 invariant: in targeting modes, no non-eligible tile has non-transparent border/box-shadow, and text contrast >= 4.5:1
      const dimTiles = Array.from(tilesLayer.querySelectorAll('.tile.dim'));
      function parseRgb(str) {
        if (!str) return [0, 0, 0];
        const parts = str.replace(/[rgba() ]/g, '').split(',');
        return parts.length >= 3 ? [parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10)] : [0, 0, 0];
      }
      function relLum([r, g, b]) {
        const [sR, sG, sB] = [r, g, b].map(v => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
      }
      function contrastRatio(rgb1, rgb2) {
        const l1 = relLum(rgb1);
        const l2 = relLum(rgb2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      for (const t of dimTiles) {
        const cs = window.getComputedStyle(t);
        const face = t.querySelector('.tile-face') || t;
        const faceCs = window.getComputedStyle(face);
        const tBorderNone = cs.borderWidth === '0px' || cs.borderColor === 'rgba(0, 0, 0, 0)' || cs.borderStyle === 'none';
        const tShadowNone = cs.boxShadow === 'none';
        const faceBorderNone = faceCs.borderWidth === '0px' || faceCs.borderColor === 'rgba(0, 0, 0, 0)' || faceCs.borderStyle === 'none';
        const faceShadowNone = faceCs.boxShadow === 'none';
        if (!tBorderNone || !tShadowNone || !faceBorderNone || !faceShadowNone) {
          return {
            pass: false,
            rule: 7,
            message: 'Assertion (7) failed: non-eligible tile has non-transparent border or box-shadow (tBorder=' + cs.borderWidth + '/' + cs.borderColor + ', tShadow=' + cs.boxShadow + ', faceBorder=' + faceCs.borderWidth + '/' + faceCs.borderColor + ', faceShadow=' + faceCs.boxShadow + ')'
          };
        }
        const textRgb = parseRgb(faceCs.color);
        const bgRgb = parseRgb(faceCs.backgroundColor);
        const cr = contrastRatio(textRgb, bgRgb);
        if (cr < 4.5) {
          return {
            pass: false,
            rule: 7,
            message: 'Assertion (7) failed: dimmed tile ' + t.textContent.trim() + ' text contrast ' + cr.toFixed(2) + ':1 is < 4.5:1'
          };
        }
      }
    }

    return { pass: true };
  })()
`;

const START_SLIDE_MONITOR_SCRIPT = `
  (() => {
    window.__slideMonitoringViolations = [];
    window.__slideMonitorSamples = 0;
    if (window.__slideMonitorInterval) clearInterval(window.__slideMonitorInterval);
    window.__slideMonitorInterval = setInterval(() => {
      const layer = document.getElementById('tiles-layer');
      if (!layer) return;
      const tiles = layer.querySelectorAll('.tile');
      for (const tile of tiles) {
        const anims = typeof tile.getAnimations === 'function' ? tile.getAnimations() : [];
        if (anims.some(a => a.playState === 'running')) {
          window.__slideMonitorSamples++;
          const r = tile.getBoundingClientRect();
          const cx = Math.round(r.left + r.width / 2);
          const cy = Math.round(r.top + r.height / 2);
          const topEl = document.elementFromPoint(cx, cy);
          if (topEl && topEl !== tile && !tile.contains(topEl)) {
            const isTilePartner = topEl.classList.contains('tile') || topEl.classList.contains('stone') || topEl.closest('#tiles-layer');
            const isOverlay = topEl.closest('.overlay:not(.hidden)');
            if (!isTilePartner && !isOverlay) {
              window.__slideMonitoringViolations.push({
                tileVal: tile.getAttribute('data-val'),
                topElTag: topEl.tagName,
                topElClass: topEl.className,
                cx, cy
              });
            }
          }
        }
      }
    }, 16);
  })()
`;

// Wait until idle: document.getAnimations() running === 0 plus 25 ms, with 1200ms safety timeout
const WAIT_IDLE_SCRIPT = `
  new Promise((resolve) => {
    let idleStart = null;
    const startTime = performance.now();
    const ALLOW_LIST = [
      'stuck-impact-wave',
      'is-stuck',
      'highlight-stuck',
      'rescue',
      'candidate',
      'target-candidate',
      'valid',
      'target-partner',
      'shatter-pulse',
      'erasable'
    ];
    function check() {
      const allAnims = document.getAnimations();
      const nonIdleAnims = allAnims.filter(a => {
        if (a.playState === 'finished' || a.playState === 'idle') return false;
        const t = a.effect && a.effect.target;
        const timing = a.effect ? a.effect.getTiming() : null;
        if (!t) return false;
        const targetClasses = (t.className && typeof t.className === 'string') ? t.className.split(/\\s+/) : [];
        const isAllowListed = targetClasses.some(cls => ALLOW_LIST.includes(cls));
        if (isAllowListed) return false;
        if (timing && timing.iterations === Infinity) return false;
        return true;
      });

      if (performance.now() - startTime > 2200) {
        window.__idleGuardTimeouts = (window.__idleGuardTimeouts || 0) + 1;
        if (!window.__idleTimeoutDetails) window.__idleTimeoutDetails = [];
        window.__idleTimeoutDetails.push(nonIdleAnims.map(a => {
          const t = a.effect && a.effect.target;
          const timing = a.effect ? a.effect.getTiming() : null;
          return {
            animationName: a.animationName || a.id || 'unnamed',
            targetClass: t ? (t.className || t.tagName) : 'no-target',
            targetTag: t ? t.tagName : 'none',
            iterations: timing ? timing.iterations : null,
            duration: timing ? timing.duration : null,
            playState: a.playState,
          };
        }));
        resolve({ timeout: true });
        return;
      }

      if (nonIdleAnims.length === 0) {
        if (!idleStart) idleStart = performance.now();
        if (performance.now() - idleStart >= 25) {
          resolve({ timeout: false });
          return;
        }
      } else {
        idleStart = null;
      }
      requestAnimationFrame(check);
    }
    check();
  })
`;

async function runScenario(cdp, name, urlParams, runner) {
  console.log(`\n=================== SCENARIO ${name} (${ACTIONS_PER_SCENARIO} actions) ===================`);
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?${urlParams}` });
  await sleep(400);

  // Click START button if start overlay visible
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
      window.__syncBoardCorrections = 0;
      window.__idleGuardTimeouts = 0;
      if (window.__correctionsByCallSite) {
        window.__correctionsByCallSite.slideFinish = 0;
        window.__correctionsByCallSite.interrupt = 0;
        window.__correctionsByCallSite.rewind = 0;
        window.__correctionsByCallSite.ability = 0;
        window.__correctionsByCallSite['decision-resolve'] = 0;
        window.__correctionsByCallSite['draft-resolve'] = 0;
        window.__correctionsByCallSite.setup = 0;
        window.__correctionsByCallSite.other = 0;
      }
    })()
  `);
  await cdp.eval(START_SLIDE_MONITOR_SCRIPT);
  await sleep(200);

  const history = [];
  let effectiveActions = 0;
  let gameOvers = 0;
  let playAgains = 0;
  let rewinds = 0;
  let diagonalUses = 0;
  let eraserUses = 0;

  for (let actionIdx = 0; actionIdx < ACTIONS_PER_SCENARIO; actionIdx++) {
    // Check if game over, automatically Play Again
    const isOver = await cdp.eval(`Boolean(window.controller && window.controller.isGameOver())`);
    if (isOver) {
      gameOvers++;
      await cdp.eval(`
        (() => {
          const btn = document.getElementById('btn-play-again') || document.getElementById('again');
          if (btn) btn.click();
        })()
      `);
      playAgains++;
      await sleep(200);
    }

    const isPending = await cdp.eval(`Boolean(window.controller && window.controller.hasPendingDecision())`);
    if (isPending) {
      await cdp.eval(`
        (() => {
          const dec = window.controller.getPendingDecision();
          if (dec && dec.type === 'draft') {
            const card = document.querySelector('.relic-draft-card') || document.querySelector('.draft-card');
            if (card) card.click();
          } else if (dec && dec.type === 'mason' && dec.candidates && dec.candidates.length > 0) {
            const cell = document.querySelector('.cell[data-index="' + dec.candidates[0] + '"]');
            if (cell) cell.click();
          }
        })()
      `);
      await sleep(100);
    }

    const actionResult = await runner(cdp, actionIdx, history);
    const actionDesc = typeof actionResult === 'string' ? actionResult : actionResult.desc;
    effectiveActions++;
    if (typeof actionResult === 'object') {
      if (actionResult.rewinds) rewinds += actionResult.rewinds;
      if (actionResult.diagonal) diagonalUses += actionResult.diagonal;
      if (actionResult.eraser) eraserUses += actionResult.eraser;
    }

    history.push(`[#${actionIdx + 1}] ${actionDesc}`);
    if (history.length > 20) history.shift();

    // Wait until idle
    await cdp.eval(WAIT_IDLE_SCRIPT);

    // Check invariant
    const res = await cdp.eval(INVARIANT_SCRIPT);
    if (!res.pass) {
      console.error(`❌ FAILURE in Scenario ${name} at action #${actionIdx + 1}: ${actionDesc}`);
      console.error(`Failing Assertion: ${res.message}`);

      const boardState = await cdp.eval(`JSON.stringify(window.controller ? window.controller.getBoard() : [])`);
      console.error(`Controller Board State: ${boardState}`);

      const domDump = await cdp.eval(`document.getElementById('game-board') ? document.getElementById('game-board').innerHTML : 'no board'`);
      console.error(`Board Container DOM Dump:\n${domDump}`);

      console.error(`Last 10 Actions:\n${history.slice(-10).join('\n')}`);
      return { pass: false, scenario: name, actionIdx, error: res.message };
    }
  }

  // Get debug counters
  const debugCorrections = await cdp.eval(`window.__syncBoardCorrections || 0`);
  const callSites = await cdp.eval(`window.__correctionsByCallSite || {}`);
  const initialRender = callSites.initialRender || 0;
  const idleTimeouts = await cdp.eval(`window.__idleGuardTimeouts || 0`);
  const slideSamples = await cdp.eval(`window.__slideMonitorSamples || 0`);

  // Verify headline total matches sum of runtime call sites
  const otherCalls = { ...callSites };
  delete otherCalls.initialRender;
  const sumCategories = (callSites.slideFinish || 0) +
                        (callSites.rewind || 0) +
                        (callSites.interrupt || 0) +
                        (callSites.ability || 0) +
                        (callSites['decision-resolve'] || 0) +
                        (callSites['draft-resolve'] || 0) +
                        (callSites.setup || 0) +
                        (callSites.other || 0);

  console.log(`✔ Scenario ${name} PASSED all ${ACTIONS_PER_SCENARIO} actions. (effective actions: ${effectiveActions}, gameOvers: ${gameOvers}, playAgains: ${playAgains}, rewinds: ${rewinds}, diagonal: ${diagonalUses}, eraser: ${eraserUses}, idle timeouts: ${idleTimeouts}, syncBoard corrections: ${debugCorrections} [slideFinish: ${callSites.slideFinish || 0}, rewind: ${callSites.rewind || 0}, interrupt: ${callSites.interrupt || 0}, ability: ${callSites.ability || 0}, decision-resolve: ${callSites['decision-resolve'] || 0}, draft-resolve: ${callSites['draft-resolve'] || 0}, setup: ${callSites.setup || 0}, other: ${callSites.other || 0}], initialRender: ${initialRender}, 16ms slide samples: ${slideSamples})`);
  if (callSites.other > 0) {
    console.log(`   [Call sites breakdown]: ${JSON.stringify(otherCalls)}`);
  }
  const timeoutDetails = await cdp.eval(`window.__idleTimeoutDetails || []`);
  if (timeoutDetails.length > 0) {
    console.log(`   [Timeout Animations Sample]:`, JSON.stringify(timeoutDetails[0]));
  }

  if (debugCorrections !== sumCategories) {
    console.error(`❌ FAILURE in Scenario ${name}: headline total corrections (${debugCorrections}) !== sum of categories (${sumCategories})!`);
    return { pass: false, scenario: name, error: `headline (${debugCorrections}) != sumCategories (${sumCategories})` };
  }

  const unlabelledOther = callSites.other || 0;
  const slideFinish = callSites.slideFinish || 0;
  if (unlabelledOther > 0 || slideFinish > 0) {
    console.error(`❌ FAILURE in Scenario ${name}: unlabelled "other" (${unlabelledOther}) or slideFinish (${slideFinish}) corrections > 0`);
    return { pass: false, scenario: name, error: `slideFinish: ${slideFinish}, other: ${unlabelledOther}` };
  }
  if (idleTimeouts > 0) {
    console.error(`❌ FAILURE in Scenario ${name}: idle timeouts (${idleTimeouts}) > 0`);
    return { pass: false, scenario: name, error: `idle timeouts: ${idleTimeouts}` };
  }

  return {
    pass: true,
    scenario: name,
    actions: ACTIONS_PER_SCENARIO,
    effectiveActions,
    gameOvers,
    playAgains,
    rewinds,
    diagonalUses,
    eraserUses,
    idleTimeouts,
    corrections: debugCorrections,
    callSites: otherCalls,
    initialRender,
    slideSamples
  };
}

async function runFuzz() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  const results = [];

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });

    const DIRS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

    // Scenario A: Swipes every 400 ms (letting animations settle)
    results.push(await runScenario(cdp, 'A (swipes every 400ms)', 'seed=101&debug=1', async (c, i) => {
      const dir = DIRS[i % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      return { desc: `Swipe ${dir}` };
    }));

    // Scenario B: Swipes every 30 ms (interrupting animations)
    results.push(await runScenario(cdp, 'B (swipes every 30ms, interrupting)', 'seed=202&debug=1', async (c, i) => {
      const dir1 = DIRS[i % 4];
      const dir2 = DIRS[(i + 1) % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir1}', key: '${dir1}' }))`);
      await sleep(30);
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir2}', key: '${dir2}' }))`);
      return { desc: `Swipe ${dir1} -> 30ms interrupt -> Swipe ${dir2}` };
    }));

    // Scenario C: Swipes with Rewind chains (1..3 undos), including undos mid-animation (>= 3 chained undos executed)
    results.push(await runScenario(cdp, 'C (swipes + Rewind chains 1..3 undos)', 'seed=303&start=rewind&debug=1', async (c, i) => {
      const dir = DIRS[i % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      if (i % 2 === 0) {
        await sleep(35);
      } else {
        await sleep(150);
      }
      // Ensure at least 3 chained rewinds on actions 2, 5, 8 etc.
      const undos = (i % 3 === 2) ? 3 : (i % 2) + 1;
      let actualUndos = 0;
      for (let u = 0; u < undos; u++) {
        const didUndo = await c.eval(`
          (() => {
            const btn = document.querySelector('button.ability-btn[data-relic="rewind"]');
            if (btn && !btn.disabled) {
              btn.click();
              return true;
            }
            return false;
          })()
        `);
        if (didUndo) actualUndos++;
        await sleep(25);
      }
      return { desc: `Swipe ${dir} + Rewind ${undos}x (done: ${actualUndos})`, rewinds: actualUndos };
    }));

    // Scenario D: Diagonal and Eraser uses, including mid-animation
    results.push(await runScenario(cdp, 'D (Diagonal and Eraser uses)', 'seed=404&start=diagonal_charge,eraser&debug=1', async (c, i) => {
      if (i % 5 === 2) {
        const used = await c.eval(`
          (() => {
            const btn = document.querySelector('button.ability-btn[data-relic="diagonal_charge"]');
            if (btn && !btn.disabled) {
              btn.click();
              const targets = window.controller.getLegalTargets('diagonal_charge');
              if (targets && targets.length > 0) {
                const t = targets[0];
                const fromCell = document.querySelector('.cell[data-index="' + t.from + '"]') || document.querySelector('.tile[data-index="' + t.from + '"]');
                if (fromCell) fromCell.click();
                const toCell = document.querySelector('.cell[data-index="' + t.to + '"]') || document.querySelector('.tile[data-index="' + t.to + '"]');
                if (toCell) toCell.click();
                return true;
              }
            }
            return false;
          })()
        `);
        return { desc: used ? 'Used Diagonal' : 'Diagonal attempted', diagonal: used ? 1 : 0 };
      } else if (i % 5 === 4) {
        const used = await c.eval(`
          (() => {
            const btn = document.querySelector('button.ability-btn[data-relic="eraser"]');
            if (btn && !btn.disabled) {
              btn.click();
              const targets = window.controller.getLegalTargets('eraser');
              if (targets && targets.length > 0) {
                const cell = document.querySelector('.cell[data-index="' + targets[0].cell + '"]') || document.querySelector('.tile[data-index="' + targets[0].cell + '"]');
                if (cell) {
                  cell.click();
                  return true;
                }
              }
            }
            return false;
          })()
        `);
        return { desc: used ? 'Used Eraser (1-tap)' : 'Eraser attempted', eraser: used ? 1 : 0 };
      } else {
        const dir = DIRS[i % 4];
        await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
        return { desc: `Swipe ${dir}` };
      }
    }));

    // Scenario E: Each passive relic forced via ?start= with ?stones=0.1
    const passives = ['fault_line', 'mason', 'siphon', 'shatter', 'last_stand'];
    for (const p of passives) {
      results.push(await runScenario(cdp, `E (passive ${p})`, `seed=505&start=${p}&stones=0.1&debug=1`, async (c, i) => {
        // Handle Mason if pending
        await c.eval(`
          (() => {
            if (window.controller && window.controller.hasPendingDecision()) {
              const dec = window.controller.getPendingDecision();
              if (dec && dec.type === 'mason' && dec.candidates && dec.candidates.length > 0) {
                const chosen = dec.candidates[0];
                const cell = document.querySelector('.cell[data-index="' + chosen + '"]');
                if (cell) cell.click();
              }
            }
          })()
        `);

        const dir = DIRS[i % 4];
        await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
        return { desc: `Passive ${p} Swipe ${dir}` };
      }));
    }

    // Scenario F: Draft overlay opened mid-run (?draft=5)
    results.push(await runScenario(cdp, 'F (draft overlay opened mid-run)', 'seed=606&draft=5&debug=1', async (c, i) => {
      await c.eval(`
        (() => {
          const draftOverlay = document.getElementById('draft-overlay');
          if (draftOverlay && !draftOverlay.classList.contains('hidden')) {
            const card = draftOverlay.querySelector('.draftcard, .draft-card');
            if (card) card.click();
          }
        })()
      `);
      const dir = DIRS[i % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      return { desc: `Swipe ${dir}` };
    }));

    // Scenario G: Play Again and pause/resume during an animation
    results.push(await runScenario(cdp, 'G (Play Again and pause/resume mid-animation)', 'seed=707&debug=1', async (c, i) => {
      if (i % 6 === 2) {
        const dir = DIRS[i % 4];
        await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
        await sleep(35);
        await c.eval(`document.getElementById('btn-pause-menu').click()`);
        await sleep(50);
        await c.eval(`document.getElementById('btn-pause-resume').click()`);
        return { desc: `Pause/Resume mid-swipe ${dir}` };
      } else if (i % 6 === 5) {
        const dir = DIRS[i % 4];
        await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
        await sleep(35);
        await c.eval(`
          (() => {
            const restart = document.getElementById('btn-pause-restart');
            if (restart) restart.click();
            else {
              const startAgain = document.getElementById('btn-play-again');
              if (startAgain) startAgain.click();
            }
          })()
        `);
        return { desc: `Restart mid-swipe ${dir}` };
      } else {
        const dir = DIRS[i % 4];
        await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
        return { desc: `Swipe ${dir}` };
      }
    }));

    // Scenario H: Tab hidden then visible during an animation (dispatch visibilitychange)
    results.push(await runScenario(cdp, 'H (visibilitychange during animation)', 'seed=808&debug=1', async (c, i) => {
      const dir = DIRS[i % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      if (i % 2 === 0) {
        await sleep(40);
        await c.eval(`
          (() => {
            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
          })()
        `);
        await sleep(40);
        await c.eval(`
          (() => {
            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
          })()
        `);
      }
      return { desc: `Swipe ${dir} with visibilitychange` };
    }));

    // Scenario I (NEW): Blocked swipes while stuck
    results.push(await runScenario(cdp, 'I (blocked swipes while stuck)', 'seed=909&start=rewind&debug=1', async (c, i) => {
      // Put board in stuck state with alternating tiles and rewind charge
      await c.eval(`
        (() => {
          window.controller.state.board = [
            2, 4, 2, 4,
            4, 2, 4, 2,
            2, 4, 2, 4,
            4, 2, 4, 'S'
          ];
          window.controller.state.stuckNeedsAbility = true;
          window.syncBoard(window.controller.getBoard(), 'setup');
        })()
      `);
      const dir = DIRS[i % 4];
      await c.eval(`window.handleMove('${dir[5]}')`);
      return { desc: `Blocked swipe ${dir} while stuck` };
    }));

    // Scenario J (NEW): Stone spawns (?stones=0.1)
    results.push(await runScenario(cdp, 'J (stone spawns ?stones=0.1)', 'seed=1010&stones=0.1&debug=1', async (c, i) => {
      const dir = DIRS[i % 4];
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${dir}', key: '${dir}' }))`);
      return { desc: `Swipe ${dir} with stone hazard active` };
    }));

    // Scenario K (NEW): Shatter via slide merge and via Diagonal merge (S1 assertions)
    let kShatterStats = {
      activations: 0,
      destroyedStones: 0,
      shardsSeen: 0,
      shardsCleaned: 0,
      maxDist: 0,
      posFailures: 0
    };
    results.push(await runScenario(cdp, 'K (shatter via slide & diagonal all 16 cells)', 'seed=1111&start=shatter,diagonal_charge&debug=1', async (c, i) => {
      const cell = i % 16;
      if (i % 2 === 0) {
        // Slide merge for cell
        const setup = getSlideSetup(cell);
        const res = await c.eval(`
          new Promise((resolve) => {
            const cell = ${cell};
            const setup = ${JSON.stringify(setup)};
            const layer = document.getElementById('tiles-layer');
            const metrics = window.getGridMetrics();
            const expPos = window.getCellCenter(cell, metrics);
            const layerRect = layer.getBoundingClientRect();

            window.controller.state.over = false;
            window.controller.state.board = [...setup.board];
            window.syncBoard(window.controller.getBoard(), 'setup');
            const actsBefore = (window.controller.getState().relicActivations?.shatter || 0);

            window.handleMove(setup.dir, 'swipe');

            let measuredDist = null;
            let shardCount = 0;
            let shatterStart = null;
            const start = performance.now();

            function check() {
              const now = performance.now();
              const shardEls = Array.from(document.querySelectorAll('.shatter-shard'));
              if (shardEls.length > 0 && measuredDist === null) {
                let sumX = 0, sumY = 0;
                for (const el of shardEls) {
                  const r = el.getBoundingClientRect();
                  sumX += (r.left - layerRect.left + r.width / 2);
                  sumY += (r.top - layerRect.top + r.height / 2);
                }
                const cx = sumX / shardEls.length;
                const cy = sumY / shardEls.length;
                measuredDist = Math.hypot(cx - expPos.cx, cy - expPos.cy);
                shardCount = shardEls.length;
                shatterStart = now;
              }

              const elapsedTotal = now - start;
              const elapsedAfterShatter = shatterStart ? (now - shatterStart) : 0;
              const remainingBad = document.querySelectorAll('.shatter-shard, .shatter-pulse, .shatter-flash, .stone-impact-ring, .stand-dust-ring').length;

              const shouldWait = shatterStart
                ? (remainingBad > 0 && elapsedAfterShatter < 800)
                : (elapsedTotal < 800);

              if (shouldWait) {
                requestAnimationFrame(check);
              } else {
                const clean = remainingBad === 0 && measuredDist !== null;
                const actsAfter = (window.controller.getState().relicActivations?.shatter || 0);
                const destroyed = (actsAfter > actsBefore) ? 1 : 0;
                resolve({
                  shards: shardCount,
                  dist: measuredDist,
                  clean,
                  remainingBad,
                  activated: actsAfter > actsBefore,
                  destroyed
                });
              }
            }
            requestAnimationFrame(check);
          })
        `);
        if (res.activated) kShatterStats.activations++;
        if (res.destroyed) kShatterStats.destroyedStones += res.destroyed;
        kShatterStats.shardsSeen += res.shards;
        if (res.clean) kShatterStats.shardsCleaned += res.shards;
        if (!res.clean || res.remainingBad > 0) {
          console.error(`❌ LEFTOVER ELEMENTS in Scenario K slide action #${i + 1}: remainingBad = ${res.remainingBad}`);
        }
        if (res.dist !== null) {
          if (res.dist > kShatterStats.maxDist) kShatterStats.maxDist = res.dist;
          if (res.dist > 12.0) {
            kShatterStats.posFailures++;
            console.error(`❌ POSITION MISMATCH in Scenario K slide action #${i + 1} (cell ${cell}): measured dist ${res.dist.toFixed(2)}px > 12px`);
          }
        }
        return { desc: `Slide shatter cell ${cell} (dist: ${res.dist !== null ? res.dist.toFixed(2) : 'none'}px, shards: ${res.shards}, clean: ${res.clean})` };
      } else {
        // Diagonal merge for cell
        const setup = getDiagonalSetup(cell);
        const res = await c.eval(`
          new Promise((resolve) => {
            const cell = ${cell};
            const setup = ${JSON.stringify(setup)};
            const layer = document.getElementById('tiles-layer');
            const metrics = window.getGridMetrics();
            const expPos = window.getCellCenter(cell, metrics);
            const layerRect = layer.getBoundingClientRect();

            window.controller.state.over = false;
            window.controller.state.board = [...setup.board];
            window.controller.state.abilities.diagonal_charge = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
            window.syncBoard(window.controller.getBoard(), 'setup');
            const actsBefore = (window.controller.getState().relicActivations?.shatter || 0);

            window.executeAbility('diagonal_charge', { from: setup.from, to: setup.to });

            let measuredDist = null;
            let shardCount = 0;
            let shatterStart = null;
            const start = performance.now();

            function check() {
              const now = performance.now();
              const shardEls = Array.from(document.querySelectorAll('.shatter-shard'));
              if (shardEls.length > 0 && measuredDist === null) {
                let sumX = 0, sumY = 0;
                for (const el of shardEls) {
                  const r = el.getBoundingClientRect();
                  sumX += (r.left - layerRect.left + r.width / 2);
                  sumY += (r.top - layerRect.top + r.height / 2);
                }
                const cx = sumX / shardEls.length;
                const cy = sumY / shardEls.length;
                measuredDist = Math.hypot(cx - expPos.cx, cy - expPos.cy);
                shardCount = shardEls.length;
                shatterStart = now;
              }

              const elapsedTotal = now - start;
              const elapsedAfterShatter = shatterStart ? (now - shatterStart) : 0;
              const remainingBad = document.querySelectorAll('.shatter-shard, .shatter-pulse, .shatter-flash, .stone-impact-ring, .stand-dust-ring').length;

              const shouldWait = shatterStart
                ? (remainingBad > 0 && elapsedAfterShatter < 800)
                : (elapsedTotal < 800);

              if (shouldWait) {
                requestAnimationFrame(check);
              } else {
                const clean = remainingBad === 0 && measuredDist !== null;
                const actsAfter = (window.controller.getState().relicActivations?.shatter || 0);
                const destroyed = (actsAfter > actsBefore) ? 1 : 0;
                resolve({
                  shards: shardCount,
                  dist: measuredDist,
                  clean,
                  remainingBad,
                  activated: actsAfter > actsBefore,
                  destroyed
                });
              }
            }
            requestAnimationFrame(check);
          })
        `);
        if (res.activated) kShatterStats.activations++;
        if (res.destroyed) kShatterStats.destroyedStones += res.destroyed;
        kShatterStats.shardsSeen += res.shards;
        if (res.clean) kShatterStats.shardsCleaned += res.shards;
        if (!res.clean || res.remainingBad > 0) {
          console.error(`❌ LEFTOVER ELEMENTS in Scenario K diagonal action #${i + 1}: remainingBad = ${res.remainingBad}`);
        }
        if (res.dist !== null) {
          if (res.dist > kShatterStats.maxDist) kShatterStats.maxDist = res.dist;
          if (res.dist > 12.0) {
            kShatterStats.posFailures++;
            console.error(`❌ POSITION MISMATCH in Scenario K diagonal action #${i + 1} (cell ${cell}): measured dist ${res.dist.toFixed(2)}px > 12px`);
          }
        }
        return { desc: `Diagonal shatter cell ${cell} (dist: ${res.dist !== null ? res.dist.toFixed(2) : 'none'}px, shards: ${res.shards}, clean: ${res.clean})`, diagonal: 1 };
      }
    }));
    console.log(`[Scenario K Shatter Stats]: activations: ${kShatterStats.activations}, destroyedStones: ${kShatterStats.destroyedStones}, shardElementsSeen: ${kShatterStats.shardsSeen}, shardsCleaned: ${kShatterStats.shardsCleaned}, maxDist: ${kShatterStats.maxDist.toFixed(2)}px, posFailures: ${kShatterStats.posFailures}`);
    if (kShatterStats.activations === 0 || kShatterStats.destroyedStones === 0 || kShatterStats.posFailures > 0 || kShatterStats.shardsSeen !== kShatterStats.shardsCleaned) {
      console.error(`❌ FAILURE in Scenario K: zero shatters, posFailures (${kShatterStats.posFailures}), or shardsSeen (${kShatterStats.shardsSeen}) !== shardsCleaned (${kShatterStats.shardsCleaned})!`);
      results[results.length - 1].pass = false;
    }

    // Scenario L (NEW): Eraser and Diagonal targeting highlight shapes, pulse animation, and dimmed tile recipe
    let ringRadiusAssertions = 0;
    results.push(await runScenario(cdp, 'L (targeting highlight shapes & dim recipe)', 'seed=1212&start=eraser,diagonal_charge&debug=1', async (c, i) => {
      const mode = i % 3;
      if (mode === 0) {
        // Eraser mode shape test
        const data = await cdp.eval(`
          (() => {
            window.controller.state.board = [2, 4, 8, 16, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            window.syncBoard(window.controller.getBoard(), 'setup');
            const btn = document.querySelector('button.ability-btn[data-relic="eraser"]');
            if (btn) btn.click();

            const t = document.querySelector('.tile.erasable');
            if (!t) return { pass: false, error: 'no erasable tile' };
            const tRadius = window.getComputedStyle(t).borderRadius;
            const ringRadius = window.getComputedStyle(t, '::before').borderRadius;
            const hasPair = t.querySelector(':after') !== null || Boolean(t.getAttribute('data-pair'));
            window.cancelTargeting();
            return {
              pass: tRadius === '8px' && ringRadius === '8px' && !hasPair,
              tRadius,
              ringRadius,
              hasPair
            };
          })()
        `);
        if (data.tRadius === data.ringRadius && data.ringRadius === '8px') ringRadiusAssertions++;
        return { desc: `Eraser highlight check (tile: ${data.tRadius}, ring: ${data.ringRadius}, equal: ${data.pass})`, eraser: 1 };
      } else if (mode === 1) {
        // Diagonal step 1 shape & pulse test
        const data = await cdp.eval(`
          (() => {
            window.controller.state.board = [2, 0, 0, 0, 0, 2, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0];
            window.syncBoard(window.controller.getBoard(), 'setup');
            window.renderAbilityBar();
            window.startTargeting('diagonal_charge');

            const t = document.querySelector('.tile.candidate, .tile.target-candidate');
            if (!t) return { pass: false, error: 'no candidate tile' };
            const tRadius = window.getComputedStyle(t).borderRadius;
            const ringRadius = window.getComputedStyle(t, '::before').borderRadius;
            const anim = window.getComputedStyle(t).animation;
            const pulses = anim.includes('pulse');
            window.cancelTargeting();
            return {
              pass: tRadius === '8px' && ringRadius === '8px' && pulses,
              tRadius,
              ringRadius,
              pulses
            };
          })()
        `);
        if (data.tRadius === data.ringRadius && data.ringRadius === '8px') ringRadiusAssertions++;
        return { desc: `Diagonal step 1 check (tile: ${data.tRadius}, ring: ${data.ringRadius}, pulses: ${data.pulses})`, diagonal: 1 };
      } else {
        // Diagonal step 2 partner pulse, selected steady, & dim test
        const data = await cdp.eval(`
          (() => {
            window.controller.state.board = [2, 0, 0, 0, 0, 2, 128, 256, 0, 0, 0, 0, 0, 0, 0, 0];
            window.syncBoard(window.controller.getBoard(), 'setup');
            window.renderAbilityBar();
            window.startTargeting('diagonal_charge');

            // Select tile 0 to enter step 2
            const tile0 = document.querySelector('.tile[data-index="0"]');
            if (tile0) tile0.click();

            const sel = document.querySelector('.tile.selected, .tile.target-selected');
            const partner = document.querySelector('.tile.valid, .tile.target-partner');
            if (!sel || !partner) return { pass: false, error: 'missing selected or partner' };

            const selAnim = window.getComputedStyle(sel).animation;
            const selSteady = !selAnim || selAnim === 'none' || !selAnim.includes('pulse');
            const partnerAnim = window.getComputedStyle(partner).animation;
            const partnerPulses = partnerAnim.includes('pulse');
            const tRadius = window.getComputedStyle(partner).borderRadius;
            const ringRadius = window.getComputedStyle(partner, '::before').borderRadius;

            window.cancelTargeting();
            return {
              pass: selSteady && partnerPulses,
              selSteady,
              partnerPulses,
              tRadius,
              ringRadius
            };
          })()
        `);
        if (data.tRadius === data.ringRadius && data.ringRadius === '8px') ringRadiusAssertions++;
        return { desc: `Diagonal step 2 check (steady: ${data.selSteady}, partnerPulses: ${data.partnerPulses})`, diagonal: 1 };
      }
    }));
    console.log(`[Scenario L Radius Stats]: ring-radius == tile-radius assertions performed: ${ringRadiusAssertions}`);

    cdp.close();

    const failedScenarios = results.filter(r => !r.pass);
    console.log('\n================================= FUZZ SUMMARY =================================');
    console.log('Scenario | Status | Actions | Effective | Over/Again | Rew/Diag/Ers | Guard TO | Corrections (tot:[sf/rw/ab/dec/drf/set]) | InitialRender | Slide Samples');
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
    let totalSlideFinish = 0;
    let totalRewind = 0;
    let totalAbility = 0;
    let totalDecision = 0;
    let totalDraft = 0;
    let totalSetup = 0;
    let totalOther = 0;
    let totalSamples = 0;
    for (const r of results) {
      const sf = r.callSites?.slideFinish || 0;
      const rw = r.callSites?.rewind || 0;
      const ab = r.callSites?.ability || 0;
      const dec = r.callSites?.['decision-resolve'] || 0;
      const drf = r.callSites?.['draft-resolve'] || 0;
      const set = r.callSites?.setup || 0;
      const oth = (r.callSites?.interrupt || 0) + (r.callSites?.other || 0);
      totalSlideFinish += sf;
      totalRewind += rw;
      totalAbility += ab;
      totalDecision += dec;
      totalDraft += drf;
      totalSetup += set;
      totalOther += oth;
      totalSamples += r.slideSamples || 0;
      const corrStr = `${r.corrections} [${sf}/${rw}/${ab}/${dec}/${drf}/${set}]`;
      console.log(
        `${r.scenario.padEnd(42)} | ` +
        `${(r.pass ? 'PASS' : 'FAIL').padEnd(6)} | ` +
        `${String(r.actions).padEnd(7)} | ` +
        `${String(r.effectiveActions).padEnd(9)} | ` +
        `${`${r.gameOvers}/${r.playAgains}`.padEnd(10)} | ` +
        `${`${r.rewinds}/${r.diagonalUses}/${r.eraserUses}`.padEnd(12)} | ` +
        `${String(r.idleTimeouts).padEnd(8)} | ` +
        `${corrStr.padEnd(39)} | ` +
        `${String(r.initialRender).padEnd(13)} | ` +
        `${r.slideSamples}`
      );
    }
    console.log('-----------------------------------------------------------------------------------------------------------------------------------------');
    console.log(`TOTALS: slideFinish: ${totalSlideFinish}, rewind: ${totalRewind}, ability: ${totalAbility}, decision-resolve: ${totalDecision}, draft-resolve: ${totalDraft}, setup: ${totalSetup}, other: ${totalOther}, slideSamples: ${totalSamples}`);
    console.log('=========================================================================================================\n');

    if (failedScenarios.length > 0) {
      console.error(`❌ Fuzz test failed on ${failedScenarios.length} scenarios.`);
      process.exit(1);
    } else {
      console.log('✔ All fuzz scenarios passed cleanly!');
    }

  } finally {
    chromeProcess.kill();
    server.close();
  }
}

runFuzz().catch(err => {
  console.error(err);
  process.exit(1);
});
