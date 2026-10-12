import { findChrome } from '../find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = findChrome();
const PORT = 3014;
const CDP_PORT = 9234;

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
    server.listen(PORT, () => resolve(server));
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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
    this.ws.onclose = () => {
      for (const [id, { reject }] of this.callbacks) reject(new Error('WebSocket closed'));
      this.callbacks.clear();
    };
    this.ws.onerror = (err) => {
      for (const [id, { reject }] of this.callbacks) reject(err);
      this.callbacks.clear();
    };
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP method ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.callbacks.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
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

async function touchTap(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 0 }]
  });
  await sleep(40);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
}

async function mouseClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x, y,
    button: 'left',
    clickCount: 1
  });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x, y,
    button: 'left',
    clickCount: 1
  });
}

async function inspectElement(cdp, label) {
  const info = await cdp.eval(`
    (() => {
      const el = document.activeElement;
      if (!el) return { label: '${label}', noActive: true };
      const comp = window.getComputedStyle(el);
      const sel = window.getSelection();
      let matchesFocusVisible = false;
      try {
        matchesFocusVisible = el.matches(':focus-visible');
      } catch {}

      // Also check board element
      const board = document.getElementById('game-board');
      const boardComp = board ? window.getComputedStyle(board) : null;
      let boardFocusVisible = false;
      try {
        boardFocusVisible = board ? board.matches(':focus-visible') : false;
      } catch {}

      return {
        label: '${label}',
        tag: el.tagName,
        id: el.id,
        className: el.className,
        tabIndex: el.tabIndex,
        matchesFocusVisible,
        outline: comp.outline,
        outlineColor: comp.outlineColor,
        outlineWidth: comp.outlineWidth,
        outlineStyle: comp.outlineStyle,
        outlineOffset: comp.outlineOffset,
        boxShadow: comp.boxShadow,
        borderColor: comp.borderColor,
        selectionText: sel ? sel.toString() : '',
        selectionRangeCount: sel ? sel.rangeCount : 0,
        board: {
          tabIndex: board ? board.tabIndex : null,
          outline: boardComp ? boardComp.outline : null,
          outlineColor: boardComp ? boardComp.outlineColor : null,
          outlineStyle: boardComp ? boardComp.outlineStyle : null,
          outlineWidth: boardComp ? boardComp.outlineWidth : null,
          matchesFocusVisible: boardFocusVisible
        }
      };
    })()
  `);
  return info;
}

async function main() {
  const server = await startServer();
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_z3'),
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');

    // Emulate Mobile Device (390x844)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5
    });

    console.log('=== Z3 REPRODUCTION SUITE (Device 390x844 Mobile) ===\n');

    // Test 1: Touch tap Eraser ability then Touch tap tile
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=1212&start=eraser,diagonal_charge&debug=1` });
    await sleep(500);

    // Setup board with known tile at cell 0
    await cdp.eval(`
      window.controller.state.board = [
        4, 2, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.controller.state.abilities.eraser.charges = 2;
      window.syncBoard(window.controller.getBoard(), 'resync');
      window.renderAbilityBar();
    `);
    await sleep(100);

    // Get position of Eraser ability button
    const eraserBtnRect = await cdp.eval(`
      (() => {
        const btn = document.querySelector('[data-relic="eraser"], #ability-eraser, .ability-btn');
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);

    // Get position of tile at cell 0
    const tile0Rect = await cdp.eval(`
      (() => {
        const t = document.querySelector('.tile[data-index="0"]');
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);

    // Touch tap Eraser button
    await touchTap(cdp, eraserBtnRect.x, eraserBtnRect.y);
    await sleep(150);
    const afterEraserTouchTapBtn = await inspectElement(cdp, 'After Touch Tap Eraser Button');

    // Touch tap cell 0 to erase
    await touchTap(cdp, tile0Rect.x, tile0Rect.y);
    await sleep(300);
    const afterEraserTouchUse = await inspectElement(cdp, 'After Touch Tap Tile (Eraser Use)');

    // Capture screenshot
    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(rootDir, 'scripts', 'out', 'z3_eraser_touch.png'), Buffer.from(shot1.data, 'base64'));

    // Test 2: Mouse click Eraser ability then Mouse click tile
    await cdp.eval(`
      window.controller.state.board = [
        8, 2, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.controller.state.abilities.eraser.charges = 2;
      window.syncBoard(window.controller.getBoard(), 'resync');
      window.renderAbilityBar();
    `);
    await sleep(100);

    await mouseClick(cdp, eraserBtnRect.x, eraserBtnRect.y);
    await sleep(150);
    const afterEraserMouseClickBtn = await inspectElement(cdp, 'After Mouse Click Eraser Button');

    await mouseClick(cdp, tile0Rect.x, tile0Rect.y);
    await sleep(300);
    const afterEraserMouseUse = await inspectElement(cdp, 'After Mouse Click Tile (Eraser Use)');

    // Test 3: Touch tap Diagonal ability then two taps
    await cdp.eval(`
      window.controller.state.board = [
        16, 0, 0, 0,
        0, 16, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.controller.state.abilities.diagonal_charge.charges = 2;
      window.syncBoard(window.controller.getBoard(), 'resync');
      window.renderAbilityBar();
    `);
    await sleep(100);

    const diagBtnRect = await cdp.eval(`
      (() => {
        const btn = document.querySelector('[data-relic="diagonal_charge"], #ability-diagonal, .ability-btn:nth-child(2)');
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);

    const cell5Rect = await cdp.eval(`
      (() => {
        const t = document.querySelector('.tile[data-index="5"]');
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `);

    await touchTap(cdp, diagBtnRect.x, diagBtnRect.y);
    await sleep(150);
    const afterDiagTouchBtn = await inspectElement(cdp, 'After Touch Tap Diagonal Button');

    await touchTap(cdp, tile0Rect.x, tile0Rect.y);
    await sleep(150);
    const afterDiagTouchTap1 = await inspectElement(cdp, 'After Touch Tap Diagonal From (Tile 0)');

    await touchTap(cdp, cell5Rect.x, cell5Rect.y);
    await sleep(300);
    const afterDiagTouchUse = await inspectElement(cdp, 'After Touch Tap Diagonal To (Tile 5)');

    // Test 4: Mouse click Diagonal ability then two clicks
    await cdp.eval(`
      window.controller.state.board = [
        32, 0, 0, 0,
        0, 32, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0
      ];
      window.controller.state.abilities.diagonal_charge.charges = 2;
      window.syncBoard(window.controller.getBoard(), 'resync');
      window.renderAbilityBar();
    `);
    await sleep(100);

    await mouseClick(cdp, diagBtnRect.x, diagBtnRect.y);
    await sleep(150);
    const afterDiagMouseBtn = await inspectElement(cdp, 'After Mouse Click Diagonal Button');

    await mouseClick(cdp, tile0Rect.x, tile0Rect.y);
    await sleep(150);

    await mouseClick(cdp, cell5Rect.x, cell5Rect.y);
    await sleep(300);
    const afterDiagMouseUse = await inspectElement(cdp, 'After Mouse Click Diagonal Use');

    const results = [
      afterEraserTouchTapBtn,
      afterEraserTouchUse,
      afterEraserMouseClickBtn,
      afterEraserMouseUse,
      afterDiagTouchBtn,
      afterDiagTouchTap1,
      afterDiagTouchUse,
      afterDiagMouseBtn,
      afterDiagMouseUse
    ];

    console.log(JSON.stringify(results, null, 2));

    cdp.close();
  } finally {
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(path.join(rootDir, '.temp_chrome_z3'), { recursive: true, force: true });
    } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
