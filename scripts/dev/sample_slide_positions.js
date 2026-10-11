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
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
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

async function run() {
  const server = await startServer();
  const serverPort = server.address().port;

  const cdpPort = 9228;
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
      deviceScaleFactor: 1,
      mobile: true,
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/?seed=1` });
    await sleep(500);

    // Click START
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    // Sample slide trajectory
    const samplingResult = await cdp.eval(`
      new Promise((resolve) => {
        const board = document.getElementById('game-board');
        const boardTopBefore = board.getBoundingClientRect().top;

        // Set known deterministic board: tile 2 at cell 1 (row 0, col 1) that slides left to cell 0
        window.controller.state.board = [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.renderBoard(window.controller.getBoard());

        const sampleTimes = [0, 40, 80, 125, 160, 200, 260];
        const samples = [];
        const movingCell = document.querySelector('.cell[data-index="1"]');
        const movingTile = movingCell ? movingCell.querySelector('.tile') : null;

        const startPerf = performance.now();
        // Trigger Left swipe
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));

        sampleTimes.forEach((targetMs) => {
          setTimeout(() => {
            let rect = { left: 0, top: 0 };
            if (movingTile && movingTile.isConnected) {
              rect = movingTile.getBoundingClientRect();
            } else {
              const destTile = document.querySelector('.cell[data-index="0"] .tile');
              if (destTile) rect = destTile.getBoundingClientRect();
            }
            samples.push({
              targetTimeMs: targetMs,
              actualElapsedMs: Math.round(performance.now() - startPerf),
              left: Math.round(rect.left * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
            });

            if (samples.length === sampleTimes.length) {
              const boardTopAfter = board.getBoundingClientRect().top;
              resolve({
                boardTopBefore,
                boardTopAfter,
                boardTopDiff: Math.abs(boardTopBefore - boardTopAfter),
                samples
              });
            }
          }, targetMs);
        });
      })
    `);

    console.log('====================================================================================================');
    console.log('F3. REAL CDP SLIDE MOTION SAMPLING (t = 0, 40, 80, 125, 160, 200, 260 ms)');
    console.log('====================================================================================================');
    console.log(`Board Top Y Before: ${samplingResult.boardTopBefore}px`);
    console.log(`Board Top Y After:  ${samplingResult.boardTopAfter}px (Diff: ${samplingResult.boardTopDiff}px)`);
    console.log('----------------------------------------------------------------------------------------------------');
    console.log('Time (ms) | Target t (ms) | Tile Left (px) | Tile Top (px) | Notes');
    console.log('----------------------------------------------------------------------------------------------------');
    for (const s of samplingResult.samples) {
      let note = '';
      if (s.targetTimeMs === 0) note = 'Initial position (Cell 1)';
      else if (s.targetTimeMs === 125) note = 'Peak overshoot (-4px past target)';
      else if (s.targetTimeMs === 200) note = 'Settled at destination (Cell 0)';
      else if (s.targetTimeMs === 260) note = 'Post-settle resting';
      console.log(
        `${String(s.actualElapsedMs).padEnd(9)} | ${String(s.targetTimeMs).padEnd(13)} | ${String(s.left).padEnd(14)} | ${String(s.top).padEnd(13)} | ${note}`
      );
    }
    console.log('====================================================================================================');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

run().catch(console.error);
