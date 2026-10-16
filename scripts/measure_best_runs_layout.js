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
const PORT = 3012;
const CDP_PORT = 9235;

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
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_layout_' + Date.now()),
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  try {
    const wsUrl = await getWsUrl();
    client = new CdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    const tenRuns = [
      {
        runId: 'run_1_7relics',
        points: 15420,
        moves: 312,
        maxTile: 2048,
        // 7 relics: 3 abilities (eraser, rewind, mason) + 4 passives (siphon, shatter, fault_line, last_stand)
        relics: ['siphon', 'shatter', 'fault_line', 'last_stand', 'eraser', 'rewind', 'mason'],
        endedAt: '2026-10-15T15:20:00.000Z'
      },
      {
        runId: 'run_2',
        points: 9840,
        moves: 245,
        maxTile: 1024,
        relics: ['siphon', 'shatter', 'fault_line', 'diagonal_charge'],
        endedAt: '2026-10-15T14:10:00.000Z'
      },
      {
        runId: 'run_3',
        points: 7620,
        moves: 198,
        maxTile: 1024,
        relics: ['siphon', 'rewind', 'eraser'],
        endedAt: '2026-10-15T12:00:00.000Z'
      },
      {
        runId: 'run_4',
        points: 5430,
        moves: 165,
        maxTile: 512,
        relics: ['mason', 'fault_line'],
        endedAt: '2026-10-14T22:30:00.000Z'
      },
      {
        runId: 'run_5',
        points: 4890,
        moves: 140,
        maxTile: 512,
        relics: ['siphon', 'last_stand', 'shatter'],
        endedAt: '2026-10-14T19:45:00.000Z'
      },
      {
        runId: 'run_6',
        points: 4120,
        moves: 122,
        maxTile: 256,
        relics: ['shatter', 'eraser'],
        endedAt: '2026-10-14T17:15:00.000Z'
      },
      {
        runId: 'run_7',
        points: 3650,
        moves: 108,
        maxTile: 256,
        relics: ['fault_line'],
        endedAt: '2026-10-13T20:00:00.000Z'
      },
      {
        runId: 'run_8',
        points: 2980,
        moves: 92,
        maxTile: 128,
        relics: ['siphon', 'diagonal_charge'],
        endedAt: '2026-10-12T16:20:00.000Z'
      },
      {
        runId: 'run_9',
        points: 2140,
        moves: 74,
        maxTile: 128,
        relics: ['eraser'],
        endedAt: '2026-10-11T11:00:00.000Z'
      },
      {
        runId: 'run_10',
        points: 1420,
        moves: 50,
        maxTile: 64,
        relics: [],
        endedAt: '2026-10-10T09:30:00.000Z'
      }
    ];

    const viewports = [
      { width: 390, height: 742, name: '390x742', mobile: true },
      { width: 320, height: 568, name: '320x568', mobile: true },
      { width: 1280, height: 742, name: '1280x742', mobile: false },
    ];

    let report = '=== BEST RUNS LAYOUT VERIFICATION ===\n';
    report += `Date: ${new Date().toISOString()}\n`;
    report += 'Data injection: 10 sample runs injected into localStorage (2048_rogue_top_runs) during test session only.\n';
    report += 'Entry #1 contains 7 relics (3 abilities + 4 passives: siphon, shatter, fault_line, last_stand, eraser, rewind, mason).\n\n';

    for (const vp of viewports) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 2,
        mobile: vp.mobile,
      });

      await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      await sleep(300);

      // Inject data
      await client.eval(`localStorage.setItem('2048_rogue_top_runs', JSON.stringify(${JSON.stringify(tenRuns)}));`);

      // Check Start Card trophy button position & overlap
      const trophyStartMetrics = await client.eval(`(() => {
        const btn = document.getElementById('btn-start-trophy');
        const logo = document.querySelector('.start-card .logo');
        const title = document.querySelector('.start-card .title');
        const card = document.querySelector('.start-card');
        if (!btn || !card) return null;
        const bRect = btn.getBoundingClientRect();
        const cRect = card.getBoundingClientRect();
        const lRect = logo ? logo.getBoundingClientRect() : null;
        const tRect = title ? title.getBoundingClientRect() : null;

        const overlapsLogo = lRect ? !(bRect.right < lRect.left || bRect.left > lRect.right || bRect.bottom < lRect.top || bRect.top > lRect.bottom) : false;
        const overlapsTitle = tRect ? !(bRect.right < tRect.left || bRect.left > tRect.right || bRect.bottom < tRect.top || bRect.top > tRect.bottom) : false;

        return {
          btnRect: { x: bRect.x, y: bRect.y, w: bRect.width, h: bRect.height },
          cardRect: { x: cRect.x, y: cRect.y, w: cRect.width, h: cRect.height },
          hitAreaW: bRect.width,
          hitAreaH: bRect.height,
          overlapsLogo,
          overlapsTitle,
          ariaLabel: btn.getAttribute('aria-label')
        };
      })()`);

      // Capture start card screenshot at 390x742
      if (vp.name === '390x742') {
        const shotStart = await client.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, 'start_card_390x742.png'), Buffer.from(shotStart.data, 'base64'));
      }

      // Open Best Runs Overlay
      await client.eval(`(() => {
        const btn = document.getElementById('btn-start-trophy');
        if (btn) btn.click();
      })()`);
      await sleep(250);

      // Measure layout
      const layoutMetrics = await client.eval(`(() => {
        const modal = document.querySelector('#best-runs-overlay .best-runs-card');
        const list = document.getElementById('best-runs-list');
        const rows = Array.from(document.querySelectorAll('#best-runs-list .record-card'));
        const chips = Array.from(document.querySelectorAll('#best-runs-list .record-relic-chip'));
        const allOverlayEls = Array.from(document.querySelectorAll('#best-runs-overlay *'));

        const mRect = modal ? modal.getBoundingClientRect() : null;
        const lRect = list ? list.getBoundingClientRect() : null;

        const rowOverflows = rows.map((r, i) => {
          const hasOverflowX = r.scrollWidth > r.clientWidth;
          return { index: i + 1, scrollWidth: r.scrollWidth, clientWidth: r.clientWidth, overflowX: hasOverflowX };
        });

        let clippedChips = 0;
        for (const chip of chips) {
          const cRect = chip.getBoundingClientRect();
          const pCard = chip.closest('.record-card');
          const pRect = pCard.getBoundingClientRect();
          if (cRect.right > pRect.right + 0.5 || cRect.left < pRect.left - 0.5 || cRect.bottom > pRect.bottom + 0.5 || cRect.top < pRect.top - 0.5) {
            clippedChips++;
          }
        }

        let minFontSize = 999;
        for (const el of allOverlayEls) {
          const fsStr = window.getComputedStyle(el).fontSize;
          if (fsStr) {
            const val = parseFloat(fsStr);
            if (!isNaN(val) && val > 0 && el.textContent.trim().length > 0) {
              if (val < minFontSize) minFontSize = val;
            }
          }
        }

        const slotMetrics = chips.map(chip => {
          const icon = chip.querySelector('svg, img, canvas') || chip;
          const iRect = icon.getBoundingClientRect();
          const cRect = chip.getBoundingClientRect();
          return {
            relic: chip.getAttribute('data-relic'),
            slotW: Math.round(cRect.width * 10) / 10,
            slotH: Math.round(cRect.height * 10) / 10,
            iconW: Math.round(iRect.width * 10) / 10,
            iconH: Math.round(iRect.height * 10) / 10,
          };
        });

        const minIconW = slotMetrics.length > 0 ? Math.min(...slotMetrics.map(s => s.iconW)) : 0;
        const minIconH = slotMetrics.length > 0 ? Math.min(...slotMetrics.map(s => s.iconH)) : 0;

        return {
          modalRect: mRect ? { x: mRect.x, y: mRect.y, w: mRect.width, h: mRect.height } : null,
          listRect: lRect ? { x: lRect.x, y: lRect.y, w: lRect.width, h: lRect.height } : null,
          rowCount: rows.length,
          rowOverflows,
          clippedChips,
          minFontSize: minFontSize === 999 ? 0 : minFontSize,
          slotMetricsSample: slotMetrics.slice(0, 8),
          minIconW,
          minIconH,
        };
      })()`);

      // Capture screenshot of best runs
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      const shotFilename = `best_runs_${vp.name}.png`;
      fs.writeFileSync(path.join(outDir, shotFilename), Buffer.from(shot.data, 'base64'));

      report += `[Viewport: ${vp.name} (${vp.width}x${vp.height})]\n`;
      report += `  Modal Width: ${layoutMetrics.modalRect.w.toFixed(1)}px (Rect: { x: ${layoutMetrics.modalRect.x.toFixed(1)}, y: ${layoutMetrics.modalRect.y.toFixed(1)}, w: ${layoutMetrics.modalRect.w.toFixed(1)}, h: ${layoutMetrics.modalRect.h.toFixed(1)} }, max-width <= 440px: ${layoutMetrics.modalRect.w <= 440})\n`;
      report += `  Screenshot: ${shotFilename} (measured modal width: ${layoutMetrics.modalRect.w.toFixed(1)}px)\n`;
      report += `  Relic Slot Rendered Icon Sizes (2x4 grid, sample row 1):\n`;
      for (const sm of layoutMetrics.slotMetricsSample) {
        report += `    Slot [${sm.relic}]: slot=${sm.slotW}x${sm.slotH}px, rendered icon=${sm.iconW}x${sm.iconH}px (>= 14px: ${sm.iconW >= 14 && sm.iconH >= 14 ? 'PASS' : 'FAIL'})\n`;
      }
      report += `  Min Rendered Icon Size Across All Slots: ${layoutMetrics.minIconW}x${layoutMetrics.minIconH}px (must be >= 14px: ${layoutMetrics.minIconW >= 14 && layoutMetrics.minIconH >= 14 ? 'PASS' : 'FAIL'})\n`;
      report += `  Start Trophy Button: Rect: { x: ${trophyStartMetrics.btnRect.x.toFixed(1)}, y: ${trophyStartMetrics.btnRect.y.toFixed(1)}, w: ${trophyStartMetrics.btnRect.w.toFixed(1)}, h: ${trophyStartMetrics.btnRect.h.toFixed(1)} }, hit area >= 36px: ${trophyStartMetrics.hitAreaW >= 36 && trophyStartMetrics.hitAreaH >= 36}, aria-label: "${trophyStartMetrics.ariaLabel}", overlapsLogo: ${trophyStartMetrics.overlapsLogo}, overlapsTitle: ${trophyStartMetrics.overlapsTitle}\n`;
      report += `  List Rect: { x: ${layoutMetrics.listRect.x.toFixed(1)}, y: ${layoutMetrics.listRect.y.toFixed(1)}, w: ${layoutMetrics.listRect.w.toFixed(1)}, h: ${layoutMetrics.listRect.h.toFixed(1)} }\n`;
      report += `  Row Count: ${layoutMetrics.rowCount}\n`;
      const anyRowOverflow = layoutMetrics.rowOverflows.some(r => r.overflowX);
      report += `  Overflow-X of every row: ${anyRowOverflow ? 'FAIL (overflow detected)' : 'none (all rows pass)'}\n`;
      report += `  Clipped Chip Count: ${layoutMetrics.clippedChips} (must be 0: ${layoutMetrics.clippedChips === 0 ? 'PASS' : 'FAIL'})\n`;
      report += `  Min Font Size in overlay: ${layoutMetrics.minFontSize}px (must be >= 11px: ${layoutMetrics.minFontSize >= 11 ? 'PASS' : 'FAIL'})\n\n`;
    }

    fs.writeFileSync(path.join(outDir, 'best_runs_layout.txt'), report, 'utf8');
    console.log('[Layout] Generated scripts/out/best_runs_layout.txt');
    console.log(report);

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
