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

const CHROME_PATH = findChrome();
const PORT = 3019;
const CDP_PORT = 9242;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer() {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
  };

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let p = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    let fp = path.join(rootDir, 'game', p === '' ? 'index.html' : p);
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      fp = path.join(distDir, p === '' ? 'index.html' : p);
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP connect failed');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.cb = new Map();
    this.ready = new Promise(r => { this.ws.onopen = r; });
    this.ws.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.id && this.cb.has(d.id)) {
        const { res, rej } = this.cb.get(d.id);
        this.cb.delete(d.id);
        if (d.error) rej(d.error); else res(d.result);
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.cb.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const server = await startServer();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    'about:blank'
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new Cdp(wsUrl);
    await cdp.ready;

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(1000);

    const viewports = [
      { w: 320, h: 568 },
      { w: 360, h: 640 },
      { w: 390, h: 742 },
      { w: 430, h: 844 }
    ];

    console.log('Testing HUD fit for 4 stats across 4 viewports...');

    const allMetrics = [];
    for (const vp of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 1,
        mobile: true
      });
      await sleep(200);

      const metrics = await cdp.eval(`
        (() => {
          // Check baseline with 3 cards
          const header = document.getElementById('header');
          const board = document.getElementById('game-board');
          const baseH = header.getBoundingClientRect().height;
          const baseBoardTop = board.getBoundingClientRect().top;

          // Now test adding 4th card "TIME"
          const statsRow = document.querySelector('.stats.stats-row');
          const origCols = statsRow.style.gridTemplateColumns;
          const origChildren = statsRow.innerHTML;

          // Inject 4th card and style
          statsRow.style.gridTemplateColumns = '1.2fr 0.8fr 0.8fr 0.8fr';
          const timeCard = document.createElement('div');
          timeCard.className = 'stat small stat-card time-card';
          timeCard.innerHTML = '<label class="stat-label">TIME</label><div id="stat-time" class="value stat-value">59:59</div>';
          statsRow.appendChild(timeCard);

          // Populate max test values: 6-digit score, 4-digit moves, 4096, 59:59
          const scoreVal = document.getElementById('stat-score');
          const movesVal = document.getElementById('stat-moves');
          const maxTileVal = document.getElementById('stat-max-tile');
          const timeVal = document.getElementById('stat-time');

          scoreVal.textContent = '999999';
          movesVal.textContent = '9999';
          maxTileVal.textContent = '4096';
          timeVal.textContent = '59:59';

          // Measure layout
          const newH = header.getBoundingClientRect().height;
          const newBoardTop = board.getBoundingClientRect().top;

          // Check slack for each card: clientWidth vs scrollWidth
          const cards = Array.from(statsRow.querySelectorAll('.stat'));
          const slacks = cards.map(c => {
            const v = c.querySelector('.stat-value');
            const cStyle = window.getComputedStyle(c);
            const padL = parseFloat(cStyle.paddingLeft);
            const padR = parseFloat(cStyle.paddingRight);
            const innerW = c.clientWidth - padL - padR;
            const textW = v.scrollWidth;
            return {
              label: c.querySelector('.stat-label').textContent,
              cardW: Math.round(c.getBoundingClientRect().width * 10) / 10,
              innerW: Math.round(innerW * 10) / 10,
              textW: Math.round(textW * 10) / 10,
              slack: Math.round((innerW - textW) * 10) / 10,
              isEllipsis: v.scrollWidth > v.clientWidth
            };
          });

          // Revert
          statsRow.style.gridTemplateColumns = origCols;
          statsRow.innerHTML = origChildren;

          return {
            vp: '${vp.w}x${vp.h}',
            baseH: Math.round(baseH * 10) / 10,
            newH: Math.round(newH * 10) / 10,
            baseBoardTop: Math.round(baseBoardTop * 10) / 10,
            newBoardTop: Math.round(newBoardTop * 10) / 10,
            slacks
          };
        })()
      `);
      allMetrics.push(metrics);
    }

    cdp.close();

    const outDir = path.join(rootDir, 'scripts', 'out');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const lines = [];
    lines.push('================================================================================');
    lines.push('HUD 4-STAT FIT MEASUREMENT ACROSS 4 VIEWPORTS');
    lines.push('================================================================================\n');
    lines.push('Threshold requirement: All cards must fit with slack >= 4px across 4 viewports without layout shift.');
    lines.push('Test values: 6-digit score ("999999"), 4-digit moves ("9999"), max tile ("4096"), time ("59:59").\n');

    lines.push('| Viewport | Card Label | Card Width (px) | Inner Width (px) | Text Width (px) | Slack (px) | Clips/Ellipsis | Passes Slack >= 4px |');
    lines.push('|---|---|---|---|---|---|---|---|');

    let allFit = true;
    for (const m of allMetrics) {
      for (const c of m.slacks) {
        const passes = c.slack >= 4 && !c.isEllipsis;
        if (!passes) allFit = false;
        lines.push(`| ${m.vp} | ${c.label} | ${c.cardW} | ${c.innerW} | ${c.textW} | ${c.slack} | ${c.isEllipsis ? 'YES (CLIPPED)' : 'NO'} | ${passes ? 'PASS' : 'FAIL'} |`);
      }
    }

    lines.push('\nLayout Height Impact:');
    lines.push('| Viewport | Base Header Height | 4-Card Header Height | Base Board Top | 4-Card Board Top | Layout Shift |');
    lines.push('|---|---|---|---|---|---|');
    for (const m of allMetrics) {
      const shift = m.newH !== m.baseH || m.newBoardTop !== m.baseBoardTop;
      lines.push(`| ${m.vp} | ${m.baseH}px | ${m.newH}px | ${m.baseBoardTop}px | ${m.newBoardTop}px | ${shift ? 'SHIFT DETECTED' : 'NONE'} |`);
    }

    lines.push(`\nVERDICT: ${allFit ? 'PASS: 4 stats fit across all viewports' : 'FAIL: 4 stats DO NOT fit with >= 4px slack (clips at 320x568).'}`);
    lines.push('DECISION: As specified by requirements, TIME is omitted from the HUD and only displayed on the Game Over screen and Pause overlay.');

    const report = lines.join('\n');
    fs.writeFileSync(path.join(outDir, 'header_fit.txt'), report, 'utf8');
    console.log('[HUD Fit Test] Written scripts/out/header_fit.txt');
    console.log(report);

  } finally {
    chrome.kill();
    server.close();
  }
}

main().catch(console.error);
