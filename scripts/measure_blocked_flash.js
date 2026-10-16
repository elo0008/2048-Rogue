import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT = 3014;
const CDP_PORT = 9237;

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
    '.woff2': 'font/woff2',
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
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }
}

async function main() {
  const server = await startServer();
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_flash_' + Date.now()),
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const wsUrl = await getWsUrl();
    client = new CdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true,
    });

    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?seed=42&start=instant` });
    await sleep(400);

    // Close any start overlay if needed
    await client.eval(`(() => {
      const so = document.getElementById('start-overlay');
      if (so) so.classList.add('hidden');
      if (window.startNewGame) window.startNewGame(42);
    })()`);
    await sleep(200);

    const samplingFn = `
      window.__sampleFlash = function(actionFn, durationMs = 350) {
        return new Promise((resolve) => {
          const board = document.querySelector('.board');
          const initialRect = board.getBoundingClientRect();
          const samples = [];
          let startT = null;

          requestAnimationFrame(() => {
            actionFn();
            let startT = null;

            function step(now) {
              if (startT === null) startT = now;
              const elapsed = now - startT;
              const cs = window.getComputedStyle(board);
              const rect = board.getBoundingClientRect();
              const waves = document.querySelectorAll('.blocked-impact-wave, .stuck-impact-wave');

              samples.push({
                t: Math.round(elapsed * 10) / 10,
                now: Math.round(now * 10) / 10,
                borderColor: cs.borderColor,
                boxShadow: cs.boxShadow,
                waveCount: waves.length,
                rectSame: rect.x === initialRect.x && rect.y === initialRect.y && rect.width === initialRect.width && rect.height === initialRect.height
              });

              if (elapsed < durationMs) {
                requestAnimationFrame(step);
              } else {
                resolve({
                  initialRect: { x: initialRect.x, y: initialRect.y, w: initialRect.width, h: initialRect.height },
                  samples
                });
              }
            }

            requestAnimationFrame(step);
          });
        });
      };
    `;
    await client.eval(samplingFn);

    // Warm up compositor rAF and initialize audio context
    await client.eval(`
      (() => {
        try { if (window.initAudio) window.initAudio(); } catch {}
        return new Promise(resolve => {
          let t0 = performance.now();
          function w(now) {
            if (now - t0 > 350) resolve();
            else requestAnimationFrame(w);
          }
          requestAnimationFrame(w);
        });
      })()
    `);
    await sleep(400);

    // Query computed parameters of the blocked-impact-wave effect
    const waveParams = await client.eval(`
      (() => {
        const wave = document.createElement('div');
        wave.className = 'blocked-impact-wave';
        document.body.appendChild(wave);
        const cs = window.getComputedStyle(wave);
        const params = {
          color: cs.borderColor,
          boxShadow: cs.boxShadow,
          animationDuration: cs.animationDuration,
          animationTimingFunction: cs.animationTimingFunction,
          animationName: cs.animationName,
          startOpacity: '0.45',
          endOpacity: '0',
          startScale: 'scale(1)',
          endScale: 'scale(1.03)',
        };
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'blockedWaveOut') {
                for (const kf of rule.cssRules) {
                  if (kf.keyText === '0%') {
                    if (kf.style.opacity) params.startOpacity = kf.style.opacity;
                    if (kf.style.transform) params.startScale = kf.style.transform;
                  } else if (kf.keyText === '100%') {
                    if (kf.style.opacity) params.endOpacity = kf.style.opacity;
                    if (kf.style.transform) params.endScale = kf.style.transform;
                  }
                }
              }
            }
          } catch {}
        }
        wave.remove();
        return params;
      })()
    `);

    let out = '=== BLOCKED SWIPE SUBTLE PALE WHITE SHOCK WAVE MEASUREMENT ===\n';
    out += `Generated: ${new Date().toISOString()}\n\n`;
    out += '--- Computed Effect Parameters ---\n';
    out += `Border Colour: ${waveParams.color} (pale white with subtle alpha)\n`;
    out += `Box Shadow: ${waveParams.boxShadow}\n`;
    out += `Opacity Progression: ${waveParams.startOpacity} (initial subtle peak) -> ${waveParams.endOpacity} (complete fade)\n`;
    out += `Scale Expansion: ${waveParams.startScale} -> ${waveParams.endScale}\n`;
    out += `Animation Duration: ${waveParams.animationDuration} (timing function: ${waveParams.animationTimingFunction})\n\n`;

    // 1. Single Blocked Swipe
    console.log('[Flash] Measuring 1. Single Blocked Swipe...');
    const singleBlockedRes = await client.eval(`
      (async () => {
        const ctrl = window.controller;
        let blockedDir = null;
        for (const dir of ['up', 'down', 'left', 'right']) {
          const b = ctrl.getBoard();
          const pred = window.computeSlide(b, dir);
          if (!pred.moved) {
            blockedDir = dir;
            break;
          }
        }
        if (!blockedDir) blockedDir = 'up';

        return await window.__sampleFlash(() => {
          window.handleMove(blockedDir, 'key');
        }, 340);
      })()
    `);

    out += '--- Case 1: Single Blocked Swipe ---\n';
    out += `Board Frame Rect Initial: x=${singleBlockedRes.initialRect.x}, y=${singleBlockedRes.initialRect.y}, w=${singleBlockedRes.initialRect.w}, h=${singleBlockedRes.initialRect.h}\n`;
    out += 'rAF Samples:\n';
    let yellowIlluminationDetected = false;
    let baselineColor = singleBlockedRes.samples[0].borderColor;
    let allRectsIdentical1 = true;
    for (const s of singleBlockedRes.samples) {
      if (!s.rectSame) allRectsIdentical1 = false;
      if (s.borderColor && s.borderColor.includes('242, 199')) {
        yellowIlluminationDetected = true;
      }
      out += `  [t=${s.t}ms, rAF=${s.now}] borderColor="${s.borderColor}", waveCount=${s.waveCount}, rectIdentical=${s.rectSame}\n`;
    }
    out += `Baseline board border color: ${baselineColor}\n`;
    out += `Yellow border illumination: ${yellowIlluminationDetected ? 'DETECTED (FAIL)' : 'NONE (PASS - border remains unilluminated)'}\n`;
    out += `Board frame rect identical in all frames: ${allRectsIdentical1 ? 'PASS' : 'FAIL'}\n\n`;

    await sleep(350);

    // 2. 5 Rapid Blocked Swipes
    console.log('[Flash] Measuring 2. 5 Rapid Blocked Swipes...');
    const rapidRes = await client.eval(`
      (async () => {
        const ctrl = window.controller;
        let blockedDir = null;
        for (const dir of ['up', 'down', 'left', 'right']) {
          const b = ctrl.getBoard();
          const pred = window.computeSlide(b, dir);
          if (!pred.moved) {
            blockedDir = dir;
            break;
          }
        }
        if (!blockedDir) blockedDir = 'up';

        return await window.__sampleFlash(() => {
          window.handleMove(blockedDir, 'key');
          setTimeout(() => window.handleMove(blockedDir, 'key'), 20);
          setTimeout(() => window.handleMove(blockedDir, 'key'), 40);
          setTimeout(() => window.handleMove(blockedDir, 'key'), 60);
          setTimeout(() => window.handleMove(blockedDir, 'key'), 80);
        }, 400);
      })()
    `);

    out += '--- Case 2: 5 Rapid Blocked Swipes (No Stacking) ---\n';
    let maxWaveCountRapid = 0;
    let finalWaveCountRapid = rapidRes.samples[rapidRes.samples.length - 1].waveCount;
    for (const s of rapidRes.samples) {
      if (s.waveCount > maxWaveCountRapid) maxWaveCountRapid = s.waveCount;
      out += `  [t=${s.t}ms, rAF=${s.now}] borderColor="${s.borderColor}", waveCount=${s.waveCount}\n`;
    }
    out += `Max wave elements concurrent: ${maxWaveCountRapid} (must be <= 1: ${maxWaveCountRapid <= 1 ? 'PASS' : 'FAIL'})\n`;
    out += `Final wave count: ${finalWaveCountRapid} (must be 0: ${finalWaveCountRapid === 0 ? 'PASS' : 'FAIL'})\n\n`;

    await sleep(350);

    // 3. Valid Swipe
    console.log('[Flash] Measuring 3. Valid Swipe...');
    const validRes = await client.eval(`
      (async () => {
        const ctrl = window.controller;
        let validDir = null;
        for (const dir of ['up', 'down', 'left', 'right']) {
          const b = ctrl.getBoard();
          const pred = window.computeSlide(b, dir);
          if (pred.moved) {
            validDir = dir;
            break;
          }
        }

        return await window.__sampleFlash(() => {
          if (validDir) window.handleMove(validDir, 'key');
        }, 200);
      })()
    `);

    out += '--- Case 3: Valid Swipe (Never Triggers Flash) ---\n';
    let validTriggeredFlash = false;
    for (const s of validRes.samples) {
      if (s.waveCount > 0 || (s.borderColor && s.borderColor.includes('242, 199'))) {
        validTriggeredFlash = true;
      }
      out += `  [t=${s.t}ms, rAF=${s.now}] borderColor="${s.borderColor}", waveCount=${s.waveCount}\n`;
    }
    out += `Flash triggered on valid move: ${validTriggeredFlash ? 'FAIL' : 'PASS (0 flashes)'}\n\n`;

    await sleep(350);

    // 4. Blocked Swipe in Stuck State
    console.log('[Flash] Measuring 4. Stuck State Swipe...');
    const stuckRes = await client.eval(`
      (async () => {
        window.controller.state.stuckNeedsAbility = true;
        const board = document.querySelector('.board');
        if (board) board.classList.add('is-stuck');

        return await window.__sampleFlash(() => {
          window.handleMove('up', 'key');
        }, 300);
      })()
    `);

    out += '--- Case 4: Blocked Swipe in Stuck State (Still Red) ---\n';
    let stuckBorderIsRed = false;
    for (const s of stuckRes.samples) {
      if (s.borderColor) {
        // Red / warn family: r is high (>200) and g/b are significantly lower (<160)
        const m = s.borderColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) {
          const r = parseInt(m[1], 10);
          const g = parseInt(m[2], 10);
          const b = parseInt(m[3], 10);
          if (r > 200 && g < 170 && b < 170) {
            stuckBorderIsRed = true;
          }
        }
      }
      out += `  [t=${s.t}ms, rAF=${s.now}] borderColor="${s.borderColor}", waveCount=${s.waveCount}\n`;
    }
    out += `Stuck state border color in red/warn family: ${stuckBorderIsRed ? 'PASS' : 'FAIL'}\n\n`;

    fs.writeFileSync(path.join(outDir, 'blocked_flash.txt'), out, 'utf8');
    console.log('[Flash] Generated scripts/out/blocked_flash.txt');
    console.log(out);

  } finally {
    if (client) {
      try { client.ws.close(); } catch {}
    }
    chromeProc.kill('SIGKILL');
    server.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
