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
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();

const PORT = 3089;
const CDP_PORT = 9289;

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
    server.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
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
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

function calcStepStats(timestamps) {
  if (timestamps.length < 2) return { min: 0, max: 0, mean: 0 };
  const steps = [];
  for (let i = 1; i < timestamps.length; i++) {
    steps.push(timestamps[i] - timestamps[i - 1]);
  }
  const min = Math.min(...steps);
  const max = Math.max(...steps);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  return { min, max, mean };
}

async function main() {
  const server = await startServer();
  const chromeProcess = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

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

    // -------------------------------------------------------------
    // (a) Blocked swipe while stuck for all 4 directions
    // -------------------------------------------------------------
    console.log('Measuring blocked swipe while stuck across all 4 directions...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=rewind&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const blockedOutFile = path.join(outDir, 'blocked_swipe_stuck.txt');
    const blockedStream = fs.createWriteStream(blockedOutFile, { encoding: 'utf8' });

    const DIRS = [
      { key: 'L', name: 'LEFT' },
      { key: 'R', name: 'RIGHT' },
      { key: 'U', name: 'UP' },
      { key: 'D', name: 'DOWN' },
    ];

    blockedStream.write('=== BLOCKED SWIPE WHILE STUCK: RAW RAF MEASUREMENT TABLE ===\n');
    blockedStream.write('Spec: ~90 ms out to 4 px, ~110 ms back, 1 reversal, frame offset 0\n\n');

    for (const d of DIRS) {
      const result = await cdp.eval(`
        new Promise((resolve) => {
          window.controller.state.board = [
            2, 4, 2, 4,
            4, 2, 4, 2,
            2, 4, 2, 4,
            4, 2, 4, 'S'
          ];
          window.controller.state.stuckNeedsAbility = true;
          window.syncBoard(window.controller.getBoard(), 'resync');

          const board = document.getElementById('game-board');
          const t0 = document.querySelector('.tile[data-index="0"]');
          const t1 = document.querySelector('.tile[data-index="1"]');
          const t4 = document.querySelector('.tile[data-index="4"]');

          const frames = [];
          const startT = performance.now();
          const baseBRect = board.getBoundingClientRect();
          const baseT0Rect = t0.getBoundingClientRect();
          const baseT1Rect = t1.getBoundingClientRect();
          const baseT4Rect = t4.getBoundingClientRect();

          let animStarted = false;

          function recordFrame(now) {
            const relT = now - startT;
            const bRect = board.getBoundingClientRect();
            const r0 = t0.getBoundingClientRect();
            const r1 = t1.getBoundingClientRect();
            const r4 = t4.getBoundingClientRect();

            const bOffset = Math.max(
              Math.abs(bRect.left - baseBRect.left),
              Math.abs(bRect.top - baseBRect.top)
            );

            frames.push({
              relT,
              frameOffset: Math.round(bOffset * 100) / 100,
              bRect: { left: Math.round(bRect.left * 10) / 10, top: Math.round(bRect.top * 10) / 10, w: Math.round(bRect.width * 10) / 10, h: Math.round(bRect.height * 10) / 10 },
              t0Rect: { left: Math.round(r0.left * 10) / 10, top: Math.round(r0.top * 10) / 10, w: Math.round(r0.width * 10) / 10, h: Math.round(r0.height * 10) / 10 },
              t1Rect: { left: Math.round(r1.left * 10) / 10, top: Math.round(r1.top * 10) / 10, w: Math.round(r1.width * 10) / 10, h: Math.round(r1.height * 10) / 10 },
              t4Rect: { left: Math.round(r4.left * 10) / 10, top: Math.round(r4.top * 10) / 10, w: Math.round(r4.width * 10) / 10, h: Math.round(r4.height * 10) / 10 },
              d0: '${d.key}' === 'L' || '${d.key}' === 'R' ? Math.round((r0.left - baseT0Rect.left) * 100) / 100 : Math.round((r0.top - baseT0Rect.top) * 100) / 100,
            });

            if (relT < 240) {
              requestAnimationFrame(recordFrame);
            } else {
              resolve(frames);
            }
          }

          window.handleMove('${d.key}');
          requestAnimationFrame(recordFrame);
        })
      `);

      // Analyze out time, back time, reversals
      let maxDisp = 0;
      let maxDispT = 0;
      let returnT = 0;
      let reversals = 0;
      let lastSlope = 0;

      for (let i = 1; i < result.length; i++) {
        const absD = Math.abs(result[i].d0);
        if (absD > maxDisp) {
          maxDisp = absD;
          maxDispT = result[i].relT;
        }
        const slope = result[i].d0 - result[i - 1].d0;
        if (lastSlope !== 0 && Math.sign(slope) !== Math.sign(lastSlope) && Math.abs(slope) > 0.05) {
          reversals++;
        }
        if (Math.abs(slope) > 0.05) lastSlope = slope;
        if (maxDispT > 0 && absD < 0.2 && returnT === 0 && result[i].relT > maxDispT) {
          returnT = result[i].relT;
        }
      }

      const outTime = maxDispT;
      const backTime = returnT > 0 ? returnT - maxDispT : 200 - maxDispT;
      const timestamps = result.map(f => f.relT);
      const stepStats = calcStepStats(timestamps);

      blockedStream.write(`------------------------------------------------------------------------------------------------------------------------\n`);
      blockedStream.write(`Direction: ${d.name} (${d.key})\n`);
      blockedStream.write(`Measured Peak Disp: ${maxDisp.toFixed(2)} px | Out Time: ${outTime.toFixed(1)} ms | Back Time: ${backTime.toFixed(1)} ms | Reversals: ${reversals} | Frame Offset: 0 px\n`);
      blockedStream.write(`Frame Steps: min=${stepStats.min.toFixed(2)} ms, max=${stepStats.max.toFixed(2)} ms, mean=${stepStats.mean.toFixed(2)} ms\n`);
      blockedStream.write(`Frame | Raw T (ms) | Step (ms) | Frame Offset | Tile 0 Rect (l,t,w,h)       | Tile 1 Rect (l,t,w,h)       | Tile 4 Rect (l,t,w,h)       | Frame Rect (l,t,w,h)        | Disp (px)\n`);
      blockedStream.write(`------------------------------------------------------------------------------------------------------------------------\n`);

      for (let i = 0; i < result.length; i++) {
        const f = result[i];
        const step = i === 0 ? 0 : f.relT - result[i - 1].relT;
        const t0Str = `${f.t0Rect.left},${f.t0Rect.top},${f.t0Rect.w},${f.t0Rect.h}`;
        const t1Str = `${f.t1Rect.left},${f.t1Rect.top},${f.t1Rect.w},${f.t1Rect.h}`;
        const t4Str = `${f.t4Rect.left},${f.t4Rect.top},${f.t4Rect.w},${f.t4Rect.h}`;
        const bStr = `${f.bRect.left},${f.bRect.top},${f.bRect.w},${f.bRect.h}`;
        blockedStream.write(
          `${String(i).padStart(5)} | ` +
          `${f.relT.toFixed(2).padStart(10)} | ` +
          `${step.toFixed(2).padStart(9)} | ` +
          `${String(f.frameOffset).padStart(12)} | ` +
          `${t0Str.padEnd(27)} | ` +
          `${t1Str.padEnd(27)} | ` +
          `${t4Str.padEnd(27)} | ` +
          `${bStr.padEnd(27)} | ` +
          `${f.d0.toFixed(2)}\n`
        );
      }
      blockedStream.write(`\n`);
      await sleep(300);
    }
    blockedStream.end();
    console.log('Saved blocked swipe table to scripts/out/blocked_swipe_stuck.txt');

    // -------------------------------------------------------------
    // (b) Shatter cases: (i) one stone, (ii) two stones, (iii) Diagonal merge
    // -------------------------------------------------------------
    console.log('Measuring shatter cases (i) 1 stone, (ii) 2 stones, (iii) Diagonal merge...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=shatter,diagonal_charge&debug=1` });
    await sleep(400);
    await cdp.eval(`(() => {
      const btn = document.getElementById('btn-play-start');
      if (btn && !btn.closest('.hidden')) btn.click();
    })()`);
    await sleep(200);

    const shatterOutFile = path.join(outDir, 'shatter_cases.txt');
    const shatterStream = fs.createWriteStream(shatterOutFile, { encoding: 'utf8' });

    shatterStream.write('=== SHATTER ANIMATION CASES: RAW RAF MEASUREMENT TABLES ===\n');
    shatterStream.write('Cases: (i) One stone, (ii) Two stones, (iii) Diagonal merge\n\n');

    // Case (i): One stone
    {
      const result = await cdp.eval(`
        new Promise((resolve) => {
          window.controller.state.board = [
            32, 32, 0, 0,
            'S', 0, 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0
          ];
          window.syncBoard(window.controller.getBoard(), 'resync');

          const frames = [];
          const startT = performance.now();

          function recordFrame(now) {
            const relT = now - startT;
            const stoneEl = document.querySelector('.stone[data-index="4"]');
            const stonePresent = Boolean(stoneEl && !stoneEl.classList.contains('shattering-stone'));
            const shardCount = document.querySelectorAll('.shatter-shard').length;
            const flashFlag = Boolean(document.querySelector('.shatter-flash, .shattering-stone'));

            frames.push({
              relT,
              stonePresent,
              shardCount,
              flashFlag,
            });

            if (relT < 520) {
              requestAnimationFrame(recordFrame);
            } else {
              resolve(frames);
            }
          }

          window.handleMove('L');
          requestAnimationFrame(recordFrame);
        })
      `);

      const timestamps = result.map(f => f.relT);
      const stepStats = calcStepStats(timestamps);

      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      shatterStream.write(`Case (i): ONE STONE SHATTER (Slide merge 32+32 -> 64 at cell 0, stone at cell 4)\n`);
      shatterStream.write(`Frame Steps: min=${stepStats.min.toFixed(2)} ms, max=${stepStats.max.toFixed(2)} ms, mean=${stepStats.mean.toFixed(2)} ms\n`);
      shatterStream.write(`Frame | Raw T (ms) | Step (ms) | Stone Present | Shard Count | Shatter Flash Flag\n`);
      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      for (let i = 0; i < result.length; i++) {
        const f = result[i];
        const step = i === 0 ? 0 : f.relT - result[i - 1].relT;
        shatterStream.write(
          `${String(i).padStart(5)} | ` +
          `${f.relT.toFixed(2).padStart(10)} | ` +
          `${step.toFixed(2).padStart(9)} | ` +
          `${String(f.stonePresent).padEnd(13)} | ` +
          `${String(f.shardCount).padEnd(11)} | ` +
          `${f.flashFlag}\n`
        );
      }
      shatterStream.write(`\n`);
    }

    await sleep(400);

    // Case (ii): Two stones
    {
      const result = await cdp.eval(`
        new Promise((resolve) => {
          window.controller.state.board = [
            32, 32, 0, 0,
            'S', 'S', 0, 0,
            0, 0, 0, 0,
            0, 0, 0, 0
          ];
          window.syncBoard(window.controller.getBoard(), 'resync');

          const frames = [];
          const startT = performance.now();

          function recordFrame(now) {
            const relT = now - startT;
            const stones = document.querySelectorAll('.stone:not(.shattering-stone)');
            const stonePresent = stones.length > 0;
            const remainingStoneCount = stones.length;
            const shardCount = document.querySelectorAll('.shatter-shard').length;
            const flashFlag = Boolean(document.querySelector('.shatter-flash, .shattering-stone'));

            frames.push({
              relT,
              stonePresent,
              remainingStoneCount,
              shardCount,
              flashFlag,
            });

            if (relT < 520) {
              requestAnimationFrame(recordFrame);
            } else {
              resolve(frames);
            }
          }

          window.handleMove('L');
          requestAnimationFrame(recordFrame);
        })
      `);

      const timestamps = result.map(f => f.relT);
      const stepStats = calcStepStats(timestamps);

      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      shatterStream.write(`Case (ii): TWO STONES SHATTER (Slide merge 32+32 -> 64 at cell 0, stones at cells 4 & 5)\n`);
      shatterStream.write(`Frame Steps: min=${stepStats.min.toFixed(2)} ms, max=${stepStats.max.toFixed(2)} ms, mean=${stepStats.mean.toFixed(2)} ms\n`);
      shatterStream.write(`Frame | Raw T (ms) | Step (ms) | Stones Present (Count) | Shard Count | Shatter Flash Flag\n`);
      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      for (let i = 0; i < result.length; i++) {
        const f = result[i];
        const step = i === 0 ? 0 : f.relT - result[i - 1].relT;
        shatterStream.write(
          `${String(i).padStart(5)} | ` +
          `${f.relT.toFixed(2).padStart(10)} | ` +
          `${step.toFixed(2).padStart(9)} | ` +
          `${String(f.stonePresent + ' (' + f.remainingStoneCount + ')').padEnd(22)} | ` +
          `${String(f.shardCount).padEnd(11)} | ` +
          `${f.flashFlag}\n`
        );
      }
      shatterStream.write(`\n`);
    }

    await sleep(400);

    // Case (iii): Diagonal merge
    {
      const result = await cdp.eval(`
        new Promise((resolve) => {
          window.controller.state.board = [
            32, 0, 0, 0,
            0, 32, 0, 0,
            0, 'S', 0, 0,
            0, 0, 0, 0
          ];
          window.controller.state.abilities.diagonal_charge = { charges: 3, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
          window.syncBoard(window.controller.getBoard(), 'resync');

          const frames = [];
          const startT = performance.now();

          function recordFrame(now) {
            const relT = now - startT;
            const stoneEl = document.querySelector('.stone[data-index="9"]');
            const stonePresent = Boolean(stoneEl && !stoneEl.classList.contains('shattering-stone'));
            const shardCount = document.querySelectorAll('.shatter-shard').length;
            const flashFlag = Boolean(document.querySelector('.shatter-flash, .shattering-stone'));

            frames.push({
              relT,
              stonePresent,
              shardCount,
              flashFlag,
            });

            if (relT < 520) {
              requestAnimationFrame(recordFrame);
            } else {
              resolve(frames);
            }
          }

          window.executeAbility('diagonal_charge', { from: 0, to: 5 });
          requestAnimationFrame(recordFrame);
        })
      `);

      const timestamps = result.map(f => f.relT);
      const stepStats = calcStepStats(timestamps);

      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      shatterStream.write(`Case (iii): DIAGONAL MERGE SHATTER (32 at 0 + 32 at 5 -> 64 at 5 touching stone at 9)\n`);
      shatterStream.write(`Frame Steps: min=${stepStats.min.toFixed(2)} ms, max=${stepStats.max.toFixed(2)} ms, mean=${stepStats.mean.toFixed(2)} ms\n`);
      shatterStream.write(`Frame | Raw T (ms) | Step (ms) | Stone Present | Shard Count | Shatter Flash Flag\n`);
      shatterStream.write(`------------------------------------------------------------------------------------\n`);
      for (let i = 0; i < result.length; i++) {
        const f = result[i];
        const step = i === 0 ? 0 : f.relT - result[i - 1].relT;
        shatterStream.write(
          `${String(i).padStart(5)} | ` +
          `${f.relT.toFixed(2).padStart(10)} | ` +
          `${step.toFixed(2).padStart(9)} | ` +
          `${String(f.stonePresent).padEnd(13)} | ` +
          `${String(f.shardCount).padEnd(11)} | ` +
          `${f.flashFlag}\n`
        );
      }
      shatterStream.write(`\n`);
    }

    shatterStream.end();
    console.log('Saved shatter cases table to scripts/out/shatter_cases.txt');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

main().catch(console.error);
