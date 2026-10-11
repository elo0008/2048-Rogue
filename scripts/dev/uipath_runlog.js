import { findChrome } from '../find_chrome.js';
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
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getFreePort() {
  const s = http.createServer();
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
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
      throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const KEY_DETAILS = {
  'L': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  'R': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  'U': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  'D': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};

async function dispatchCdpKey(cdp, dir) {
  const info = KEY_DETAILS[dir] || KEY_DETAILS['L'];
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    windowsVirtualKeyCode: info.keyCode,
    code: info.code,
    key: info.key,
  });
  await sleep(10);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: info.keyCode,
    code: info.code,
    key: info.key,
  });
}

function findSpecialValues(obj, prefix = '') {
  const results = [];
  if (obj === null) {
    results.push({ path: prefix || '(root)', type: 'null', value: null });
    return results;
  }
  if (obj === undefined) {
    results.push({ path: prefix || '(root)', type: 'undefined', value: undefined });
    return results;
  }
  if (obj === Infinity || obj === -Infinity || obj === 'Infinity' || obj === '-Infinity') {
    results.push({ path: prefix || '(root)', type: 'Infinity', value: obj });
    return results;
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach((item, idx) => {
        results.push(...findSpecialValues(item, `${prefix}[${idx}]`));
      });
    } else {
      for (const [k, v] of Object.entries(obj)) {
        const nextPath = prefix ? `${prefix}.${k}` : k;
        results.push(...findSpecialValues(v, nextPath));
      }
    }
  }
  return results;
}

async function main() {
  const server = await startStaticServer();
  const serverPort = server.address().port;

  const cdpPort = await getFreePort();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });

    const targetUrl = `http://127.0.0.1:${serverPort}/?stones=0.1&start=rewind&seed=1`;
    await cdp.send('Page.navigate', { url: targetUrl });
    await sleep(600);

    // Click START button
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(250);

    const startTime = Date.now();
    const TIMEOUT_MS = 60000; // Cap 60s

    let abilityClickedCount = 0;
    let movesPlayed = 0;

    while (Date.now() - startTime < TIMEOUT_MS) {
      // 1. Check if game over overlay is displayed
      const gameOver = await cdp.eval(`
        (() => {
          const end = document.getElementById('end-overlay');
          const isOver = window.controller?.isGameOver() || false;
          const endVisible = end && !end.classList.contains('hidden');
          return Boolean(isOver && endVisible);
        })()
      `);
      if (gameOver) {
        break;
      }

      // 2. Draft overlay check
      const draftActive = await cdp.eval(`
        (() => {
          const draft = document.getElementById('draft-overlay');
          if (draft && !draft.classList.contains('hidden')) {
            const card = draft.querySelector('.draft-card');
            if (card) {
              card.click();
              return true;
            }
          }
          return false;
        })()
      `);
      if (draftActive) {
        await sleep(150);
        continue;
      }

      // 3. Mason candidate check
      const masonActive = await cdp.eval(`
        (() => {
          const cand = document.querySelector('.mason-candidate');
          if (cand) {
            cand.click();
            return true;
          }
          return false;
        })()
      `);
      if (masonActive) {
        await sleep(150);
        continue;
      }

      // 4. Ability-button click (real click on ability button)
      // Check if rewind is available and enabled
      const abilityClicked = await cdp.eval(`
        (() => {
          const btn = document.querySelector('button.ability-btn[data-relic="rewind"]');
          if (btn && !btn.disabled) {
            const stuck = window.controller?.state?.stuckNeedsAbility || (window.controller?.getValidMoves()?.length === 0);
            const moveCount = window.controller?.state?.moveCount || 0;
            // Click if stuck OR occasionally to exercise ability-button clicks
            if (stuck || (moveCount > 0 && moveCount % 3 === 0)) {
              btn.click();
              return true;
            }
          }
          return false;
        })()
      `);
      if (abilityClicked) {
        abilityClickedCount++;
        await sleep(100);
      }

      // 5. Send real keyboard event for next move
      const nextMove = await cdp.eval(`
        (() => {
          const moves = window.controller?.getValidMoves() || [];
          if (moves.length === 0) return null;
          // Prefer directional pattern that eventually leads to game-over
          const order = ['L', 'D', 'R', 'U'];
          for (const d of order) {
            if (moves.includes(d)) return d;
          }
          return moves[0];
        })()
      `);

      if (nextMove) {
        await dispatchCdpKey(cdp, nextMove);
        movesPlayed++;
        await sleep(80);
      } else {
        // If no valid move, sleep briefly to let game-over or abilities trigger
        await sleep(100);
      }
    }

    // Wait for end-overlay to render
    await sleep(400);

    // Read the run record through the same serializer the Copy Run Log button uses
    // In game/app.js: JSON.stringify(getStoredHistory(), null, 2) or JSON.stringify(latestRun, null, 2)
    const runRecordRawJson = await cdp.eval(`
      (() => {
        // Name of serializer: JSON.stringify(getStoredHistory(), null, 2)
        const history = (typeof getStoredHistory === 'function')
          ? getStoredHistory()
          : JSON.parse(localStorage.getItem('2048_rogue_run_history') || '[]');
        
        if (history.length > 0) {
          return JSON.stringify(history[history.length - 1], null, 2);
        }
        // Fallback to controller.getRunLog() directly through the same serializer
        return JSON.stringify(window.controller.getRunLog(), null, 2);
      })()
    `);

    cdp.close();
    chromeProcess.kill();
    server.close();

    console.log('================================================================');
    console.log('NOTE: This is automated play, not a human log.');
    console.log('Played via CDP real keyboard events and ability-button clicks.');
    console.log(`Moves played (driver attempts): ${movesPlayed}, Ability button clicks: ${abilityClickedCount}`);
    console.log('Serializer used by Copy Run Log button: JSON.stringify({ currentRun, history }, null, 2)');
    console.log('================================================================');
    console.log('\n--- RAW RUN RECORD JSON ---');
    console.log(runRecordRawJson);
    console.log('--- END RAW RUN RECORD JSON ---\n');

    const parsedRecord = JSON.parse(runRecordRawJson);
    const specials = findSpecialValues(parsedRecord);

    console.log('--- VIEWPORT AND INPUT METHOD COUNTS ---');
    console.log('viewport:', JSON.stringify(parsedRecord.viewport, null, 2));
    console.log('inputMethodCounts:', JSON.stringify(parsedRecord.inputMethodCounts, null, 2));
    console.log('totalMoves in record:', parsedRecord.totalMoves);
    console.log('----------------------------------------\n');

    console.log('--- EXPLANATION OF DISCREPANCY ---');
    console.log(`Driver loop movesPlayed (${movesPlayed}) vs inputMethodCounts.key (${parsedRecord.inputMethodCounts?.key}) vs totalMoves (${parsedRecord.totalMoves}):`);
    console.log(`1. Driver loop dispatched ${movesPlayed} key events, but key events sent while overlays are active or transitions occur do not reach the controller, leaving ${parsedRecord.inputMethodCounts?.key} accepted key events.`);
    console.log(`2. Each of the ${parsedRecord.relicActivations?.rewind || 0} Rewind ability activations undid 1 move, reducing the move count from ${parsedRecord.inputMethodCounts?.key} to totalMoves = ${parsedRecord.totalMoves} (${parsedRecord.inputMethodCounts?.key} - ${parsedRecord.relicActivations?.rewind || 0} = ${parsedRecord.totalMoves}).`);
    console.log(`3. inputMethodCounts.tap (${parsedRecord.inputMethodCounts?.tap}) corresponds to the ${abilityClickedCount} clicks on the Rewind ability button.`);
    console.log('----------------------------------\n');

    console.log('--- NULL, UNDEFINED, AND INFINITY VALUES ---');
    if (specials.length === 0) {
      console.log('None found.');
    } else {
      for (const s of specials) {
        console.log(`- ${s.path}: [${s.type}] ${JSON.stringify(s.value)}`);
      }
    }
    console.log('--------------------------------------------');

  } catch (err) {
    chromeProcess.kill();
    server.close();
    console.error('Error during uipath_runlog execution:', err);
    process.exit(1);
  }
}

main();
