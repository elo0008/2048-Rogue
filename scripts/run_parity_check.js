import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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
    let filePath;
    if (pathname.startsWith('/design/')) {
      filePath = path.join(rootDir, pathname);
    } else {
      filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
    }

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

const TARGET_SELECTORS = [
  { name: 'header', sel: 'header' },
  { name: '.brand', sel: '.brand' },
  { name: '.relic-mini', sel: '.relic-mini' },
  { name: '.telegraph', sel: '.telegraph' },
  { name: '.stat', sel: '.stat' },
  { name: '.score .value', sel: '.score .value' },
  { name: '.board', sel: '.board' },
  { name: '.cell', sel: '.cell' },
  { name: '.tile.v2', sel: '.tile.v2' },
  { name: '.tile.v16', sel: '.tile.v16' },
  { name: '.tile.v128', sel: '.tile.v128' },
  { name: '.tile.v512', sel: '.tile.v512' },
  { name: '.stone', sel: '.stone' },
  { name: '.status', sel: '.status' },
  { name: '.ability', sel: '.ability' },
  { name: '.ability .icon', sel: '.ability .icon' },
  { name: '.pip.on', sel: '.pip.on' },
  { name: '.pip', sel: '.pip' },
  { name: '.primary', sel: '.primary' },
  { name: '.toast', sel: '.toast' },
];

const PROPERTIES = [
  'backgroundColor',
  'color',
  'borderColor',
  'borderRadius',
  'fontSize',
  'fontWeight',
  'width',
  'height'
];

async function getElementStyles(cdp, sel) {
  return await cdp.eval(`
    (() => {
      let el = document.querySelector('${sel}');
      // Fallback for special mock/real tile mock generation if missing in current state
      if (!el && '${sel}'.startsWith('.tile.v')) {
        const val = '${sel}'.replace('.tile.v', '');
        const temp = document.createElement('div');
        temp.className = 'tile v' + val + (parseInt(val, 10) >= 1024 ? ' compact' : '');
        temp.textContent = val;
        temp.style.visibility = 'hidden';
        const cell = document.querySelector('.cell') || document.body;
        cell.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }
      if (!el && '${sel}' === '.stone') {
        const temp = document.createElement('div');
        temp.className = 'stone';
        temp.textContent = '◆';
        temp.style.visibility = 'hidden';
        const cell = document.querySelector('.cell') || document.body;
        cell.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }
      if (!el && '${sel}' === '.pip.on') {
        const temp = document.createElement('div');
        temp.className = 'pip on';
        temp.style.visibility = 'hidden';
        const pips = document.querySelector('.pips') || document.body;
        pips.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }
      if (!el && '${sel}' === '.pip') {
        const temp = document.createElement('div');
        temp.className = 'pip';
        temp.style.visibility = 'hidden';
        const pips = document.querySelector('.pips') || document.body;
        pips.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }
      if (!el && '${sel}' === '.toast') {
        const temp = document.createElement('div');
        temp.className = 'toast';
        temp.textContent = 'Test';
        temp.style.visibility = 'hidden';
        document.body.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }
      if (!el && '${sel}' === '.primary') {
        const temp = document.createElement('button');
        temp.className = 'primary';
        temp.textContent = 'START';
        temp.style.visibility = 'hidden';
        document.body.appendChild(temp);
        const cs = window.getComputedStyle(temp);
        const rect = temp.getBoundingClientRect();
        const res = {
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          borderColor: cs.borderColor,
          borderRadius: cs.borderRadius,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          width: Math.round(rect.width * 100) / 100 + 'px',
          height: Math.round(rect.height * 100) / 100 + 'px',
        };
        temp.remove();
        return res;
      }

      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderColor,
        borderRadius: cs.borderRadius,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        width: Math.round(rect.width * 100) / 100 + 'px',
        height: Math.round(rect.height * 100) / 100 + 'px',
      };
    })()
  `);
}

async function run() {
  const server = await startServer();
  const serverPort = server.address().port;

  const cdpPort = 9227;
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

    // 1. Load mock
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/design/index_updated.html` });
    await sleep(500);
    // Click "Game - loaded" state button
    await cdp.eval(`
      (() => {
        const btn = document.querySelector('button[data-state="game-loaded"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(200);

    const mockStyles = {};
    for (const t of TARGET_SELECTORS) {
      mockStyles[t.name] = await getElementStyles(cdp, t.sel);
    }

    // 2. Load real app in matching loaded state
    await cdp.send('Page.navigate', {
      url: `http://127.0.0.1:${serverPort}/?seed=1`
    });
    await sleep(500);
    // Click START and set state to match mock loaded state
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
        if (window.controller) {
          window.controller.state.relics = new Set([
            'fault_line', 'mason', 'siphon', 'shatter',
            'diagonal_charge', 'eraser', 'rewind'
          ]);
          window.controller.state.board = [2, 0, 4, 0, 0, 8, 0, 2, 4, 0, 16, 0, 0, 0, 2, 0];
          window.renderBoard(window.controller.getBoard());
          window.renderAbilityBar();
          window.updateHeader();
        }
      })()
    `);
    await sleep(200);

    const realStyles = {};
    for (const t of TARGET_SELECTORS) {
      realStyles[t.name] = await getElementStyles(cdp, t.sel);
    }

    console.log('====================================================================================================');
    console.log('F4. COMPUTED STYLES PARITY AUDIT: MOCK vs REAL (at 390x844)');
    console.log('====================================================================================================');
    console.log('Element             | Property        | Mock Value            | Real Value            | Match?');
    console.log('----------------------------------------------------------------------------------------------------');

    let totalChecks = 0;
    let mismatches = 0;

    for (const t of TARGET_SELECTORS) {
      const m = mockStyles[t.name] || {};
      const r = realStyles[t.name] || {};
      for (const prop of PROPERTIES) {
        totalChecks++;
        const mv = m[prop] ?? 'N/A';
        const rv = r[prop] ?? 'N/A';
        const isMatch = mv === rv;
        if (!isMatch) mismatches++;
        const matchStr = isMatch ? 'PASS' : 'MISMATCH';
        console.log(
          `${t.name.padEnd(19)} | ${prop.padEnd(15)} | ${String(mv).padEnd(21)} | ${String(rv).padEnd(21)} | ${matchStr}`
        );
      }
      console.log('----------------------------------------------------------------------------------------------------');
    }

    console.log(`Total checks: ${totalChecks}, Mismatches: ${mismatches}`);
    console.log('====================================================================================================');

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

run().catch(console.error);
