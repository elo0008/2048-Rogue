import { findChrome } from './find_chrome.js';
import { spawn, execSync } from 'node:child_process';
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
const PORT = 3003;
const CDP_PORT = 9225;

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

async function runDiagnosticForVersion(versionName) {
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

    // 390x742 viewport + touch emulation
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      configuration: 'mobile',
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?start=siphon&siphon=4&debug=1` });
    await sleep(400);

    // Click START
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    let siphonActivations = 0;
    let fallbackCount = 0;
    const fallbackReasons = {};
    const recordedSwipes = [];

    const dirs = ['L', 'U', 'R', 'D'];

    for (let swipeIdx = 0; swipeIdx < 50; swipeIdx++) {
      const d = dirs[swipeIdx % 4];

      // Run move and sample moving tile via rAF
      const res = await cdp.eval(`
        new Promise((resolve) => {
          const actsBefore = { ...(window.controller.getState().relicActivations || {}) };
          const fbBefore = window.__slideFallbackCount || 0;

          // Track samples of any moving tile
          const samples = [];
          let recording = true;
          const startT = performance.now();

          function sampleFrame() {
            if (!recording) return;
            const now = performance.now();
            const layer = document.getElementById('tiles-layer');
            const tiles = layer ? Array.from(layer.querySelectorAll('.tile:not(.stone)')) : [];
            let sampledTile = null;

            for (const t of tiles) {
              const anims = typeof t.getAnimations === 'function' ? t.getAnimations() : [];
              if (anims.some(a => a.playState === 'running')) {
                sampledTile = t;
                break;
              }
            }

            if (sampledTile) {
              const tr = window.getComputedStyle(sampledTile).transform;
              samples.push({
                t: Math.round((now - startT) * 100) / 100,
                val: sampledTile.getAttribute('data-val'),
                transform: tr
              });
            }

            if (now - startT < 210) {
              requestAnimationFrame(sampleFrame);
            }
          }
          requestAnimationFrame(sampleFrame);

          window.handleMove('${d}', 'swipe');

          setTimeout(() => {
            recording = false;
            const actsAfter = { ...(window.controller.getState().relicActivations || {}) };
            const fbAfter = window.__slideFallbackCount || 0;
            const siphonFired = (actsAfter.siphon || 0) > (actsBefore.siphon || 0);
            const fbDiff = fbAfter - fbBefore;
            const reason = window.__slideFallbackReason || null;

            resolve({
              siphonFired,
              fbDiff,
              reason,
              samples
            });
          }, 240);
        })
      `);

      if (res.siphonFired) {
        siphonActivations++;
        if (recordedSwipes.length < 3 && res.samples && res.samples.length >= 4) {
          recordedSwipes.push({
            swipeNum: swipeIdx + 1,
            dir: d,
            samples: res.samples
          });
        }
      }

      if (res.fbDiff > 0) {
        fallbackCount += res.fbDiff;
        const rName = res.reason || 'unknown';
        fallbackReasons[rName] = (fallbackReasons[rName] || 0) + res.fbDiff;
      }

      await sleep(40);
    }

    return {
      versionName,
      siphonActivations,
      fallbackCount,
      fallbackReasons,
      recordedSwipes
    };

  } finally {
    chromeProcess.kill();
    server.close();
  }
}

async function main() {
  const slidePath = path.join(rootDir, 'game', 'slide.js');
  const slideHeadPath = path.join(outDir, 'slide_head.js');
  const slideWorkCopyPath = path.join(outDir, 'slide_working_copy.js');

  // Ensure committed HEAD slide is available in scripts/out/slide_head.js
  if (!fs.existsSync(slideHeadPath)) {
    execSync('git show HEAD:game/slide.js > scripts/out/slide_head.js', { cwd: rootDir });
  }

  // Backup current working copy of slide.js
  fs.copyFileSync(slidePath, slideWorkCopyPath);

  try {
    console.log('>>> [1/2] Running Siphon diagnostic against HEAD (committed)...');
    fs.copyFileSync(slideHeadPath, slidePath);
    execSync('node scripts/build.js', { cwd: rootDir });
    const headResults = await runDiagnosticForVersion('HEAD (committed)');

    console.log('>>> [2/2] Running Siphon diagnostic against WORKING COPY (fixed)...');
    fs.copyFileSync(slideWorkCopyPath, slidePath);
    execSync('node scripts/build.js', { cwd: rootDir });
    const workResults = await runDiagnosticForVersion('Working Copy (fixed)');

    // Format output
    const lines = [];
    lines.push('============================ SIPHON BEFORE / AFTER DIAGNOSTIC ============================');
    lines.push('Configuration: 390x742, touch emulation enabled, ?start=siphon&siphon=4, 50 swipes');
    lines.push('');

    for (const res of [headResults, workResults]) {
      lines.push(`--- Version: ${res.versionName} ---`);
      lines.push(`Siphon activations: ${res.siphonActivations}`);
      lines.push(`Fallback count:     ${res.fallbackCount}`);
      const rKeys = Object.keys(res.fallbackReasons);
      if (rKeys.length === 0) {
        lines.push('Fallback reasons:   none (0 fallbacks, 100% full slide animations)');
      } else {
        lines.push(`Fallback reasons:   ${rKeys.map(k => `${k}: ${res.fallbackReasons[k]}`).join(', ')}`);
      }
      lines.push('');
      lines.push(`Per-frame transform samples for 3 Siphon swipes (irregular rAF timestamps):`);
      for (let i = 0; i < res.recordedSwipes.length; i++) {
        const sw = res.recordedSwipes[i];
        lines.push(`  Siphon Swipe #${i + 1} (move ${sw.swipeNum}, dir: ${sw.dir}):`);
        for (const s of sw.samples) {
          lines.push(`    t=${s.t}ms: tile ${s.val} -> ${s.transform}`);
        }
      }
      lines.push('');
    }

    lines.push('Conclusion:');
    if (headResults.fallbackCount > 0 && workResults.fallbackCount === 0) {
      lines.push('HEAD suffered from prediction mismatch when Siphon suppressed tile spawns, causing fallback snaps.');
      lines.push('Working copy accounts for Siphon skippedSpawn in computeSlide, resolving 100% of fallbacks.');
    } else if (headResults.fallbackCount === 0 && workResults.fallbackCount === 0) {
      lines.push('Both versions showed 0 slide fallbacks. Siphon animation smoothly tracks tile positions.');
    } else {
      lines.push(`HEAD fallbacks: ${headResults.fallbackCount}, Working copy fallbacks: ${workResults.fallbackCount}.`);
    }
    lines.push('==========================================================================================');

    const outText = lines.join('\n');
    console.log(outText);
    fs.writeFileSync(path.join(outDir, 'siphon_before_after.txt'), outText, 'utf8');
    fs.writeFileSync(path.join(outDir, 'siphon_diag.txt'), outText, 'utf8');
    console.log('Saved to scripts/out/siphon_before_after.txt');

  } finally {
    // Restore working copy of slide.js
    if (fs.existsSync(slideWorkCopyPath)) {
      fs.copyFileSync(slideWorkCopyPath, slidePath);
      execSync('node scripts/build.js', { cwd: rootDir });
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
