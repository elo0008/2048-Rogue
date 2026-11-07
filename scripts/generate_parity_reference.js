#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findChrome } from './find_chrome.js';

const rootDir = process.cwd();
const designDir = path.join(rootDir, 'design', 'v2');
const baselineFile = path.join(rootDir, 'scripts', 'baselines', 'parity_reference.json');

function startStaticServer(serveDir) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
  const s = http.createServer((req, res) => {
    let p = req.url.split('?')[0].replace(/^\/+/, '');
    let f = path.join(serveDir, p === '' ? 'index.html' : p);
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port })));
}

async function getWs(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json');
      if (res.ok) {
        const l = await res.json();
        const p = l.find(t => t.type === 'page');
        if (p) return p.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.cb = new Map();
    this.ready = new Promise(r => this.ws.onopen = r);
    this.ws.onmessage = (e) => {
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
    return r.result?.value;
  }
}

async function setVp(cdp, w, h) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await cdp.send('Emulation.setVisibleSize', { width: w, height: h }).catch(() => {});
}

async function main() {
  const dS = await startStaticServer(designDir);
  const chromePath = findChrome();
  const cdpPort = 9645;
  const userData = path.join(rootDir, '.temp_chrome_gen_ref');
  const proc = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + userData,
    'about:blank'
  ]);
  const wsUrl = await getWs(cdpPort);
  const cdp = new CDP(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 1. Measure Card Reference at 390x742
  await setVp(cdp, 390, 742);
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + dS.port + '/rogue_2048_game_over_card.html' });
  await new Promise(r => setTimeout(r, 400));
  await cdp.eval('document.fonts.ready');
  const cardBoxes = await cdp.eval(`(() => {
    const proto = document.querySelector('.proto-controls');
    if (proto) proto.style.display = 'none';
    if (typeof switchRankingState === 'function') switchRankingState('RANKED');
    function getBox(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    }
    return {
      card: getBox('.gameover-card'),
      score: getBox('.score-display'),
      miniBoard: getBox('.mini-board-wrapper'),
      statsGrid: getBox('.stats-grid'),
      rankingCard: getBox('.global-ranking-panel'),
      buttons: getBox('.btn-play-again'),
      secondaryRow: getBox('.secondary-action-row'),
    };
  })()`);

  // 2. Measure Leaderboard References across 4 viewports
  const viewports = [
    { key: '320x568', w: 320, h: 568 },
    { key: '360x640', w: 360, h: 640 },
    { key: '390x742', w: 390, h: 742 },
    { key: '433x846', w: 433, h: 846 },
  ];

  const lbBoxes = {};
  for (const vp of viewports) {
    await setVp(cdp, vp.w, vp.h);
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + dS.port + '/rogue_2048_global_leaderboard.html' });
    await setVp(cdp, vp.w, vp.h);
    await new Promise(r => setTimeout(r, 400));
    await cdp.eval(`
      const bd = document.querySelector('.leaderboard-backdrop');
      if (bd) bd.classList.add('active');
      if (typeof updateLeaderboard === 'function') updateLeaderboard('today');
    `);
    await cdp.eval('document.fonts.ready');
    await new Promise(r => setTimeout(r, 400));
    const boxes = await cdp.eval(`(() => {
      function getBox(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      }
      return {
        modal: getBox('.leaderboard-modal'),
        header: getBox('.modal-header'),
        tabs: getBox('.category-tabs'),
        podium: getBox('.podium-section'),
        firstRow: getBox('.ranking-row'),
        pinned: getBox('.current-user-pinned')
      };
    })()`);
    lbBoxes[vp.key] = boxes;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source: 'design/v2',
    card: cardBoxes,
    leaderboard: lbBoxes
  };

  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`✔ Parity reference snapshotted to ${baselineFile}`);
  console.log(JSON.stringify(output, null, 2));

  proc.kill();
  dS.server.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}

main().catch(console.error);

