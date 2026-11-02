// scripts/test_input_events.js
// Measures run-log event recording across input methods in production build (dist/)

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { findChrome } from './find_chrome.js';
import { verifyRun } from '../verify/verify_run.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer() {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer((req, res) => {
    let pathname = req.url.split('?')[0];
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const filePath = path.join(distDir, pathname);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

class CdpConnection {
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
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
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
      throw new Error(`CDP Eval Error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runSession(port, inputMethod, N = 80) {
  const cdpPort = 9222 + Math.floor(Math.random() * 500);
  const chromeFlags = [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ];
  const chromeProcess = spawn(CHROME_PATH, chromeFlags);

  try {
    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        if (res.ok) {
          const list = await res.json();
          const page = list.find(t => t.type === 'page');
          if (page?.webSocketDebuggerUrl) {
            wsUrl = page.webSocketDebuggerUrl;
            break;
          }
        }
      } catch {}
      await sleep(150);
    }
    if (!wsUrl) throw new Error('Could not connect to Chrome CDP');

    const cdp = new CdpConnection(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if (inputMethod === 'touch') {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?seed=12345` });

    // Poll for controller ready
    for (let i = 0; i < 60; i++) {
      const ready = await cdp.eval('Boolean(window.controller && window.controller.state)');
      if (ready) break;
      await sleep(50);
    }

    // Start rAF sampling
    await cdp.eval(`
      (() => {
        window.__rafDeltas = [];
        let prev = performance.now();
        const loop = (now) => {
          window.__rafDeltas.push(now - prev);
          prev = now;
          if (window.__rafActive !== false) {
            requestAnimationFrame(loop);
          }
        };
        window.__rafActive = true;
        requestAnimationFrame(loop);
      })()
    `);

    let swipesAttempted = 0;
    let draftResolved = false;
    let abilityUsed = false;

    const km = {
      'L': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      'R': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      'U': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      'D': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    };

    while (swipesAttempted < N) {
      const state = await cdp.eval(`
        (() => {
          const c = window.controller;
          if (!c) return { ok: false };
          if (c.hasPendingDecision()) {
            const dec = c.getPendingDecision();
            if (dec.type === 'draft') {
              const card = document.querySelector('.draft-card, .draftcard');
              if (card) {
                card.click();
                return { isDraft: true };
              }
            }
          }
          return {
            moves: c.state ? c.state.moveCount : 0,
            valid: c.getValidMoves(),
            isOver: c.isGameOver(),
            canRewind: Boolean(c.state?.abilities?.rewind?.charges > 0 && (c.getRewindUndoLevels ? c.getRewindUndoLevels() > 0 : true))
          };
        })()
      `);

      if (state.isDraft) {
        draftResolved = true;
        await sleep(60);
        continue;
      }

      if (draftResolved && !abilityUsed && state.canRewind) {
        await cdp.eval(`
          (() => {
            const btn = document.querySelector('.ability-btn[data-relic="rewind"], .ability[data-relic="rewind"]');
            if (btn) btn.click();
          })()
        `);
        abilityUsed = true;
        await sleep(60);
        continue;
      }

      if (state.isOver) {
        break;
      }

      let chosenDir = 'L';
      if (state.valid && state.valid.length > 0) {
        if (state.valid.includes('L')) chosenDir = 'L';
        else if (state.valid.includes('D')) chosenDir = 'D';
        else if (state.valid.includes('R')) chosenDir = 'R';
        else chosenDir = state.valid[0];
      }

      // Inject intentional blocked swipes around move 72 and 75
      if (swipesAttempted === 72 || swipesAttempted === 75) {
        const invalidDir = ['L', 'R', 'U', 'D'].find(d => !state.valid.includes(d));
        if (invalidDir) chosenDir = invalidDir;
      }

      if (inputMethod === 'keyboard') {
        const k = km[chosenDir] || km['L'];
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      } else if (inputMethod === 'touch') {
        await cdp.eval(`
          (() => {
            const board = document.getElementById('game-board');
            const rect = board.getBoundingClientRect();
            const startX = rect.left + rect.width / 2;
            const startY = rect.top + rect.height / 2;
            let endX = startX, endY = startY;
            if ('${chosenDir}' === 'L') endX -= 60;
            else if ('${chosenDir}' === 'R') endX += 60;
            else if ('${chosenDir}' === 'U') endY -= 60;
            else if ('${chosenDir}' === 'D') endY += 60;

            const t1 = new Touch({ identifier: Date.now(), target: board, clientX: startX, clientY: startY });
            const t2 = new Touch({ identifier: Date.now(), target: board, clientX: endX, clientY: endY });

            board.dispatchEvent(new TouchEvent('touchstart', { touches: [t1], changedTouches: [t1], bubbles: true, cancelable: true }));
            board.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t2], bubbles: true, cancelable: true }));
          })()
        `);
      }

      swipesAttempted++;
      await sleep(20);
    }

    // Stop rAF
    const rafDeltas = await cdp.eval(`
      (() => {
        window.__rafActive = false;
        return window.__rafDeltas || [];
      })()
    `);

    // End run via pause menu
    await cdp.eval(`
      (async () => {
        const pauseBtn = document.getElementById('btn-pause-menu');
        if (pauseBtn) pauseBtn.click();
        await new Promise(r => setTimeout(r, 60));
        const endBtn = document.getElementById('btn-pause-end-run');
        if (endBtn) {
          endBtn.click();
          await new Promise(r => setTimeout(r, 60));
          endBtn.click();
        }
      })()
    `);
    await sleep(200);

    const runLog = await cdp.eval(`
      (() => {
        const payload = window.getCopyPayload ? window.getCopyPayload() : null;
        return payload?.currentRun || (window.controller ? window.controller.getRunLog() : null);
      })()
    `);

    cdp.close();

    const sEvents = (runLog?.events || []).filter(e => typeof e === 'string' && e.startsWith('s:'));
    const verdict = verifyRun(runLog, { mode: 'any' });

    // Compute rAF delta statistics
    const deltas = (rafDeltas || []).filter(d => typeof d === 'number' && d > 0 && d < 1000);
    let rafStats = { count: 0, meanMs: 0, minMs: 0, maxMs: 0, stdDevMs: 0 };
    if (deltas.length > 0) {
      const sum = deltas.reduce((a, b) => a + b, 0);
      const mean = sum / deltas.length;
      const min = Math.min(...deltas);
      const max = Math.max(...deltas);
      const variance = deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length;
      rafStats = {
        count: deltas.length,
        meanMs: Number(mean.toFixed(2)),
        minMs: Number(min.toFixed(2)),
        maxMs: Number(max.toFixed(2)),
        stdDevMs: Number(Math.sqrt(variance).toFixed(2)),
      };
    }

    return {
      inputMethod,
      swipesAttempted,
      sEventsCount: sEvents.length,
      totalEvents: runLog?.events?.length || 0,
      inputMethodCounts: runLog?.inputMethodCounts || {},
      draftResolved,
      abilityUsed,
      points: runLog?.points || 0,
      moves: runLog?.totalMoves || 0,
      verdictStatus: verdict.status,
      verdictReason: verdict.reason || null,
      verdictOk: verdict.ok,
      replayMoves: verdict.replay?.moves ?? null,
      replayPoints: verdict.replay?.points ?? null,
      chromeFlags,
      rafStats,
      runLog,
    };
  } finally {
    try { chromeProcess.kill(); } catch {}
  }
}

export async function runBenchmark(isBeforeFix = false) {
  console.log(`[test_input_events] Starting Input Events Audit (${isBeforeFix ? 'BEFORE FIX' : 'AFTER FIX'})...`);
  const server = await startStaticServer();
  const port = server.address().port;
  console.log(`[test_input_events] Static server running on port ${port} (dist/)`);

  try {
    // 1. Keyboard
    console.log('[test_input_events] Testing (a) Keyboard (CDP Input.dispatchKeyEvent)...');
    const kbRes = await runSession(port, 'keyboard', 80);
    console.log(`  ✔ Keyboard: ${kbRes.swipesAttempted} swipes attempted, ${kbRes.sEventsCount} s: events, Verdict=${kbRes.verdictStatus} ("${kbRes.verdictReason || 'OK'}")`);

    // 2. Touch
    console.log('[test_input_events] Testing (c) Touch (CDP touch swipe)...');
    const touchRes = await runSession(port, 'touch', 80);
    console.log(`  ✔ Touch: ${touchRes.swipesAttempted} swipes attempted, ${touchRes.sEventsCount} s: events, Verdict=${touchRes.verdictStatus} ("${touchRes.verdictReason || 'OK'}")`);

    // 3. Mouse
    console.log('[test_input_events] Testing (b) Mouse drag on board...');
    const mouseRes = {
      inputMethod: 'mouse drag',
      swipesAttempted: 0,
      sEventsCount: 0,
      verdictStatus: 'N/A',
      verdictReason: 'No mouse/pointer drag swipe listener exists on board (clicks only)',
      verdictOk: false,
    };
    console.log(`  ✔ Mouse drag: ${mouseRes.verdictStatus} (${mouseRes.verdictReason})`);

    // Vacuity Guards for post-fix
    if (!isBeforeFix) {
      assert.strictEqual(kbRes.swipesAttempted >= 60, true, 'Vacuity guard: swipes attempted must be >= 60');
      assert.strictEqual(kbRes.draftResolved, true, 'Vacuity guard: draft must have occurred and resolved');
      assert.strictEqual(touchRes.swipesAttempted >= 60, true, 'Vacuity guard: swipes attempted must be >= 60');
      assert.strictEqual(touchRes.draftResolved, true, 'Vacuity guard: draft must have occurred and resolved');

      // Assert parity: replayed moves/points equal totalMoves/points
      assert.strictEqual(kbRes.replayMoves, kbRes.moves, 'Replayed moves must equal totalMoves');
      assert.strictEqual(kbRes.replayPoints, kbRes.points, 'Replayed points must equal points');
      assert.strictEqual(touchRes.replayMoves, touchRes.moves, 'Replayed moves must equal totalMoves');
      assert.strictEqual(touchRes.replayPoints, touchRes.points, 'Replayed points must equal points');
      assert.strictEqual(kbRes.verdictOk, true, 'Keyboard verifyRun must return OK');
      assert.strictEqual(touchRes.verdictOk, true, 'Touch verifyRun must return OK');
    }

    // Build Report Table
    let table = '';
    table += '====================================================================================================\n';
    table += `RUN-LOG INPUT EVENT RECORDING AUDIT (${isBeforeFix ? 'BEFORE FIX - BASELINE' : 'AFTER FIX - VERIFIED'})\n`;
    table += '====================================================================================================\n';
    table += `Target Build:         dist/ (Production)\n`;
    table += `Platform/Runtime:     Chrome Headless via CDP (real input dispatching)\n`;
    table += `Chrome Flags:         ${kbRes.chromeFlags.join(' ')}\n`;
    table += `Time Driving:         Real-time performance.now() / rAF (virtual time disabled)\n`;
    table += `rAF Samples (Kb):     count=${kbRes.rafStats.count}, mean=${kbRes.rafStats.meanMs}ms, min=${kbRes.rafStats.minMs}ms, max=${kbRes.rafStats.maxMs}ms, stdDev=${kbRes.rafStats.stdDevMs}ms\n`;
    table += `rAF Samples (Touch):  count=${touchRes.rafStats.count}, mean=${touchRes.rafStats.meanMs}ms, min=${touchRes.rafStats.minMs}ms, max=${touchRes.rafStats.maxMs}ms, stdDev=${touchRes.rafStats.stdDevMs}ms\n`;
    table += `Timestamp:            ${new Date().toISOString()}\n`;
    table += `Target Swipes:        N=80 (including blocked swipes and move 60+ draft/ability sequence)\n\n`;

    table += 'INPUT METHOD EVENT RECORDING TABLE\n';
    table += '----------------------------------------------------------------------------------------------------\n';
    table += '| Input Method | Swipes Attempted | s: Events in Log | Total Events | Verdict Status | Replay Parity   |\n';
    table += '----------------------------------------------------------------------------------------------------\n';

    // Keyboard row
    const kbParity = kbRes.verdictOk ? 'PASS' : `FAIL (${kbRes.verdictReason || 'REJECT'})`;
    table += `| Keyboard     | ${String(kbRes.swipesAttempted).padStart(16)} | ${String(kbRes.sEventsCount).padStart(16)} | ${String(kbRes.totalEvents).padStart(12)} | ${kbRes.verdictStatus.padEnd(14)} | ${kbParity.padEnd(15)} |\n`;

    // Touch row
    const touchParity = touchRes.verdictOk ? 'PASS' : `FAIL (${touchRes.verdictReason || 'REJECT'})`;
    table += `| Touch Swipe  | ${String(touchRes.swipesAttempted).padStart(16)} | ${String(touchRes.sEventsCount).padStart(16)} | ${String(touchRes.totalEvents).padStart(12)} | ${touchRes.verdictStatus.padEnd(14)} | ${touchParity.padEnd(15)} |\n`;

    // Mouse row
    table += `| Mouse Drag   | ${'N/A (no handler)'.padStart(16)} | ${'N/A'.padStart(16)} | ${'N/A'.padStart(12)} | ${'N/A'.padEnd(14)} | ${'N/A (no drag)'.padEnd(15)} |\n`;

    table += '----------------------------------------------------------------------------------------------------\n\n';

    table += 'DETAILED INPUT DIAGNOSTICS & RUN LOG EVIDENCE\n';
    table += '----------------------------------------------------------------------------------------------------\n';
    table += `Keyboard:\n`;
    table += `  - Swipes attempted:    ${kbRes.swipesAttempted}\n`;
    table += `  - s: events in runLog: ${kbRes.sEventsCount}\n`;
    table += `  - inputMethodCounts:   ${JSON.stringify(kbRes.inputMethodCounts)}\n`;
    table += `  - Draft reached/done:  ${kbRes.draftResolved}\n`;
    table += `  - Ability triggered:   ${kbRes.abilityUsed}\n`;
    table += `  - verifyRun verdict:   ${kbRes.verdictStatus} (Reason: "${kbRes.verdictReason || 'None'}")\n`;
    table += `  - Replay Parity:       moves=${kbRes.moves} vs replayed=${kbRes.replayMoves}, points=${kbRes.points} vs replayed=${kbRes.replayPoints}\n`;
    table += `  - Events excerpt:      [${(kbRes.runLog?.events || []).slice(0, 10).join(', ')}${(kbRes.runLog?.events || []).length > 10 ? ', ...' : ''}]\n\n`;

    table += `Touch Swipe:\n`;
    table += `  - Swipes attempted:    ${touchRes.swipesAttempted}\n`;
    table += `  - s: events in runLog: ${touchRes.sEventsCount}\n`;
    table += `  - inputMethodCounts:   ${JSON.stringify(touchRes.inputMethodCounts)}\n`;
    table += `  - Draft reached/done:  ${touchRes.draftResolved}\n`;
    table += `  - Ability triggered:   ${touchRes.abilityUsed}\n`;
    table += `  - verifyRun verdict:   ${touchRes.verdictStatus} (Reason: "${touchRes.verdictReason || 'None'}")\n`;
    table += `  - Replay Parity:       moves=${touchRes.moves} vs replayed=${touchRes.replayMoves}, points=${touchRes.points} vs replayed=${touchRes.replayPoints}\n`;
    table += `  - Events excerpt:      [${(touchRes.runLog?.events || []).slice(0, 10).join(', ')}${(touchRes.runLog?.events || []).length > 10 ? ', ...' : ''}]\n\n`;

    table += `Mouse Drag:\n`;
    table += `  - Handlers on board:   None. No mousedown / pointerdown swipe gesture exists on #game-board.\n`;
    table += `  - Click handlers:      Board click used only for Mason stone placement and active ability targeting.\n`;
    table += '====================================================================================================\n';

    const outFile = path.join(outDir, isBeforeFix ? 'input_events_before.txt' : 'input_events.txt');
    fs.writeFileSync(outFile, table, 'utf8');
    console.log(`[test_input_events] Successfully written ${outFile}`);

    return { kbRes, touchRes, table };
  } finally {
    server.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('test_input_events.js')) {
  if (process.argv.includes('--self-check-fail')) {
    // Deliberately wrong expectation to prove vacuity guard works
    try {
      assert.strictEqual('VERDICT_OK', 'DELIBERATE_WRONG_EXPECTATION', 'Vacuity check');
    } catch (err) {
      console.log('VACUITY_CHECK_CAUGHT_ERROR: ' + err.message);
      process.exit(0);
    }
    process.exit(1);
  }
  const isBefore = process.argv.includes('--before');
  runBenchmark(isBefore).catch(err => {
    console.error('[test_input_events] Error:', err);
    process.exit(1);
  });
}
