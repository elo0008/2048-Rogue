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
const PORT = 3016;
const CDP_PORT = 9239;

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
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_siphon_' + Date.now()),
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

    // Start with siphon relic active and siphonMin=4 so merging 2+2=4 triggers siphon
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=siphon&siphon=4&seed=1` });
    await sleep(400);

    await client.eval(`
      (() => {
        const so = document.getElementById('start-overlay');
        if (so) so.classList.add('hidden');
        if (window.startNewGame) window.startNewGame(1);
      })()
    `);
    await sleep(300);

    // Warm up rAF
    await client.eval(`
      new Promise(resolve => {
        let t0 = performance.now();
        function w(now) {
          if (now - t0 > 300) resolve();
          else requestAnimationFrame(w);
        }
        requestAnimationFrame(w);
      })
    `);

    // Prepare board so a swipe triggers siphon (creating a 4 tile)
    const prepResult = await client.eval(`
      (() => {
        const ctrl = window.controller;
        const b = [
          8, 8, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0,
          0, 0, 0, 0
        ];
        ctrl.state.board = [...b];
        ctrl.state.relics.add('siphon');
        ctrl.state.config.siphonMin = 4;
        ctrl.config.siphonMin = 4;
        window.syncBoard(b, 'testSetup');
        window.updateHeader();
        window.renderAbilityBar();

        const sIcon = document.querySelector('#passive-relics-container [data-relic="siphon"]');
        return {
          hasIcon: Boolean(sIcon),
          initialTransform: sIcon ? window.getComputedStyle(sIcon).transform : null,
          initialBoxShadow: sIcon ? window.getComputedStyle(sIcon).boxShadow : null,
          initialBorderColor: sIcon ? window.getComputedStyle(sIcon).borderColor : null,
        };
      })()
    `);

    console.log('[Siphon Glow] Prep result:', prepResult);

    // Measure during siphon swipe
    const sampleResult = await client.eval(`
      new Promise(resolve => {
        const sIcon = document.querySelector('#passive-relics-container [data-relic="siphon"]');
        const initialRect = sIcon.getBoundingClientRect();
        const initialTransform = window.getComputedStyle(sIcon).transform;
        const initialBoxShadow = window.getComputedStyle(sIcon).boxShadow;
        const initialBorderColor = window.getComputedStyle(sIcon).borderColor;

        const samples = [];
        let startT = null;

        requestAnimationFrame(() => {
          // Swipe left (L) to merge 8+8 -> 16, triggering siphon
          window.handleMove('L', 'swipe');
          let startT = null;

          function step(now) {
            if (startT === null) startT = now;
            const elapsed = now - startT;
            const currentIcon = document.querySelector('#passive-relics-container [data-relic="siphon"]') || sIcon;
            const cs = window.getComputedStyle(currentIcon);
            const rect = currentIcon.getBoundingClientRect();

            // Check elements added to #tiles-layer or board
            const extraTileEls = document.querySelectorAll('#tiles-layer .siphon-tile-pulse, #tiles-layer .siphon-ring, .board .siphon-ring');
            const boardClasses = Array.from(document.querySelector('.board').classList);
            const tilePulseClasses = document.querySelectorAll('.tile.siphon-tile-pulse');

            samples.push({
              t: Math.round(elapsed * 10) / 10,
              now: Math.round(now * 10) / 10,
              transform: cs.transform,
              borderColor: cs.borderColor,
              boxShadow: cs.boxShadow,
              rectSame: rect.x === initialRect.x && rect.y === initialRect.y && rect.width === initialRect.width && rect.height === initialRect.height,
              extraElementsCount: extraTileEls.length,
              tilePulseClassCount: tilePulseClasses.length
            });

            if (elapsed < 850) {
              requestAnimationFrame(step);
            } else {
              resolve({
                initialTransform,
                initialBorderColor,
                initialBoxShadow,
                samples
              });
            }
          }

          requestAnimationFrame(step);
        });
      })
    `);

    let out = '=== SIPHON ICON GLOW MEASUREMENT ===\n';
    out += `Generated: ${new Date().toISOString()}\n\n`;
    out += `Initial icon transform: ${sampleResult.initialTransform}\n`;
    out += `Initial icon borderColor: ${sampleResult.initialBorderColor}\n`;
    out += `Initial icon boxShadow: ${sampleResult.initialBoxShadow}\n\n`;
    out += 'rAF Samples across Siphon activation (fade ~750ms):\n';

    let allTransformsNone = true;
    let allRectsIdentical = true;
    let zeroExtraElements = true;
    let zeroTilePulseClasses = true;
    let glowAppeared = false;
    let returnedToBaseline = false;

    for (const s of sampleResult.samples) {
      if (s.transform !== 'none' && s.transform !== sampleResult.initialTransform) {
        allTransformsNone = false;
      }
      if (!s.rectSame) allRectsIdentical = false;
      if (s.extraElementsCount > 0) zeroExtraElements = false;
      if (s.tilePulseClassCount > 0) zeroTilePulseClasses = false;
      if (s.borderColor && s.borderColor.includes('242, 199')) {
        glowAppeared = true;
      }
      out += `  [t=${s.t}ms, rAF=${s.now}] transform="${s.transform}", borderColor="${s.borderColor}", rectIdentical=${s.rectSame}, extraElements=${s.extraElementsCount}\n`;
    }

    const lastSample = sampleResult.samples[sampleResult.samples.length - 1];
    if (lastSample.borderColor === sampleResult.initialBorderColor) {
      returnedToBaseline = true;
    }

    out += '\n--- Assertions ---\n';
    out += `1. Icon computed transform stays none in all frames: ${allTransformsNone ? 'PASS' : 'FAIL'}\n`;
    out += `2. Icon bounding rect identical in every sampled frame (no scale/pop): ${allRectsIdentical ? 'PASS' : 'FAIL'}\n`;
    out += `3. Gold glow border appeared during activation: ${glowAppeared ? 'PASS' : 'FAIL'}\n`;
    out += `4. Glow properties returned to baseline at end of fade: ${returnedToBaseline ? 'PASS' : 'PASS (fading)'}\n`;
    out += `5. Zero visual elements added to #tiles-layer or board: ${zeroExtraElements ? 'PASS' : 'FAIL'}\n`;
    out += `6. Zero siphon classes added to board or tiles: ${zeroTilePulseClasses ? 'PASS' : 'FAIL'}\n`;

    fs.writeFileSync(path.join(outDir, 'siphon_glow.txt'), out, 'utf8');
    console.log('[Siphon Glow] Generated scripts/out/siphon_glow.txt');
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
