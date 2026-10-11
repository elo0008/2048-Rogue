import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const PORT = 3199;
const CDP_PORT = 9399;
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
    if (pathname.startsWith('/')) pathname = pathname.slice(1);
    let filePath = path.join(distDir, pathname === '' ? 'index.html' : pathname);

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
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');

    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=101` });
    await sleep(400);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);

    const inspectModeScript = (modeName) => `
      (() => {
        const tilesLayer = document.getElementById('tiles-layer');
        const tiles = Array.from(tilesLayer.querySelectorAll('.tile'));
        const cells = Array.from(document.querySelectorAll('.cell'));

        const results = [];
        for (const t of tiles) {
          const idx = parseInt(t.getAttribute('data-index'), 10);
          const face = t.querySelector('.tile-face');
          const tCs = window.getComputedStyle(t);
          const fCs = face ? window.getComputedStyle(face) : null;

          const rect = t.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const topEl = document.elementFromPoint(cx, cy);

          results.push({
            mode: '${modeName}',
            index: idx,
            tileClasses: t.className,
            faceClasses: face ? face.className : null,
            tileText: face ? face.textContent.trim() : t.textContent.trim(),
            tileOpacity: tCs.opacity,
            tileVisibility: tCs.visibility,
            tileColor: tCs.color,
            tileBg: tCs.backgroundColor,
            tileZIndex: tCs.zIndex,
            faceOpacity: fCs ? fCs.opacity : null,
            faceVisibility: fCs ? fCs.visibility : null,
            faceColor: fCs ? fCs.color : null,
            faceBg: fCs ? fCs.backgroundColor : null,
            faceZIndex: fCs ? fCs.zIndex : null,
            topElement: topEl ? {
              tag: topEl.tagName,
              id: topEl.id,
              className: topEl.className
            } : null
          });
        }

        // Collect all CSS rules matching targeting classes
        const matchingRules = [];
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              if (rule.selectorText && /(selected|valid|candidate|erasable|dim|mason)/.test(rule.selectorText)) {
                matchingRules.push({
                  selector: rule.selectorText,
                  cssText: rule.cssText
                });
              }
            }
          } catch {}
        }

        return { tiles: results, rules: matchingRules };
      })()
    `;

    // 1. Diagonal step 1
    console.log('--- INSPECTING DIAGONAL STEP 1 ---');
    await cdp.eval(`
      (() => {
        window.controller.state.board = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.controller.state.relics.add('diagonal_charge');
        window.controller.state.abilities.diagonal_charge = { charges: 1, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 };
        window.syncBoard(window.controller.getBoard());
        window.renderAbilityBar();
        const btn = document.querySelector('button.ability-btn[data-relic="diagonal_charge"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(150);
    const diagStep1Data = await cdp.eval(inspectModeScript('Diagonal Step 1'));
    console.log(JSON.stringify(diagStep1Data, null, 2));

    // 2. Diagonal step 2
    console.log('\n--- INSPECTING DIAGONAL STEP 2 ---');
    await cdp.eval(`
      (() => {
        const fromTile = document.querySelector('.tile[data-index="0"]');
        if (fromTile) fromTile.click();
      })()
    `);
    await sleep(150);
    const diagStep2Data = await cdp.eval(inspectModeScript('Diagonal Step 2'));
    console.log(JSON.stringify(diagStep2Data, null, 2));

    // 3. Eraser
    console.log('\n--- INSPECTING ERASER ---');
    await cdp.eval(`
      (() => {
        const cancel = document.querySelector('.btn-cancel-targeting');
        if (cancel) cancel.click();
        window.controller.state.board = [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.controller.state.relics.add('eraser');
        window.controller.state.abilities.eraser = { charges: 1, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 20 };
        window.syncBoard(window.controller.getBoard());
        window.renderAbilityBar();
        const btn = document.querySelector('button.ability-btn[data-relic="eraser"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(150);
    const eraserData = await cdp.eval(inspectModeScript('Eraser'));
    console.log(JSON.stringify(eraserData, null, 2));

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

run().catch(console.error);
