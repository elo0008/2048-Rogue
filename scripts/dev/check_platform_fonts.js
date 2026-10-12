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
const outDir = path.join(rootDir, 'scripts', 'out');

const CHROME_PATH = findChrome();
const PORT = 3018;
const CDP_PORT = 9238;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startServer(blockWoff2 = false) {
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

    if (blockWoff2 && pathname.endsWith('.woff2')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Blocked font');
      return;
    }

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

async function checkFonts(blockWoff2 = false) {
  const server = await startServer(blockWoff2);
  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--user-data-dir=' + path.join(rootDir, '.temp_chrome_font_' + (blockWoff2 ? 'fallback' : 'norm')),
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('Runtime.enable');

    const consoleErrors = [];
    const externalRequests = [];

    await cdp.send('Network.enable');
    cdp.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === 'Network.requestWillBeSent') {
        const url = msg.params.request.url;
        if (!url.startsWith(`http://localhost:${PORT}`) && !url.startsWith(`http://127.0.0.1:${PORT}`) && !url.startsWith('data:') && !url.startsWith('blob:')) {
          externalRequests.push(url);
        }
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        if (msg.params.type === 'error') {
          consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
        }
      }
    });

    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=1212&start=eraser,diagonal_charge&debug=1` });
    await sleep(600);

    // Call handleGameOver so end-screen overlay and its buttons/score are rendered
    await cdp.eval(`
      document.fonts.ready;
      window.handleGameOver();
    `);
    await sleep(300);

    const doc = await cdp.send('DOM.getDocument', { depth: -1 });

    const selectors = [
      { name: 'title', selector: '.brand, .game-title' },
      { name: 'tile number', selector: '.tile-face' },
      { name: 'stat value', selector: '#stat-score, .stat-value' },
      { name: 'status line', selector: '#hazard-status, .hazard-status' },
      { name: 'ability label', selector: '.ability-btn .name, .ability-name, .ability-btn' },
      { name: 'button', selector: '#btn-copy-log' },
      { name: 'end-screen score', selector: '#end-score, .end-score' },
    ];

    const results = [];

    for (const item of selectors) {
      const nodeRes = await cdp.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: item.selector
      });
      if (!nodeRes.nodeId) {
        results.push({ name: item.name, selector: item.selector, error: 'Node not found' });
        continue;
      }

      const fontsRes = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeRes.nodeId });
      const fonts = fontsRes.fonts || [];
      results.push({
        name: item.name,
        selector: item.selector,
        fonts: fonts.map(f => ({ familyName: f.familyName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount }))
      });
    }

    const docFontsCheck = await cdp.eval(`
      (() => {
        return {
          w400: document.fonts.check('400 16px Outfit'),
          w600: document.fonts.check('600 16px Outfit'),
          w700: document.fonts.check('700 16px Outfit'),
          w800: document.fonts.check('800 16px Outfit'),
          w900: document.fonts.check('900 16px Outfit'),
        };
      })()
    `);

    cdp.close();

    return {
      blockWoff2,
      results,
      docFontsCheck,
      consoleErrors,
      externalRequests
    };
  } finally {
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(path.join(rootDir, '.temp_chrome_font_' + (blockWoff2 ? 'fallback' : 'norm')), { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  console.log('Testing Platform Fonts under standard load...');
  const normal = await checkFonts(false);

  console.log('\nTesting Fallback Font under blocked woff2...');
  const fallback = await checkFonts(true);

  const lines = [];
  lines.push('# PLATFORM FONTS VERIFICATION TABLE (CDP CSS.getPlatformFontsForNode)');
  lines.push('# Standard load: outfit-latin-variable.woff2 served locally');
  lines.push('');
  lines.push('Element              | Selector                          | Platform Font Family | isCustomFont | Glyphs | Status');
  lines.push('---------------------+-----------------------------------+----------------------+--------------+--------+-------');

  let allCustom = true;
  for (const r of normal.results) {
    const f = (r.fonts && r.fonts[0]) ? r.fonts[0] : { familyName: 'Unknown', isCustomFont: false, glyphCount: 0 };
    const pass = f.isCustomFont === true;
    if (!pass) allCustom = false;
    lines.push(
      `${r.name.padEnd(20)} | ` +
      `${r.selector.padEnd(33)} | ` +
      `${f.familyName.padEnd(20)} | ` +
      `${String(f.isCustomFont).padEnd(12)} | ` +
      `${String(f.glyphCount).padStart(6)} | ` +
      `${pass ? 'PASS' : 'FAIL'}`
    );
  }

  lines.push('---------------------+-----------------------------------+----------------------+--------------+--------+-------');
  lines.push(`All platform fonts custom: ${allCustom ? 'YES (PASS)' : 'NO (FAIL)'}`);
  lines.push(`document.fonts.check: ${JSON.stringify(normal.docFontsCheck)}`);
  lines.push(`Console errors: ${normal.consoleErrors.length}`);
  lines.push(`External network requests: ${normal.externalRequests.length}`);
  lines.push('');
  lines.push('# FALLBACK RENDER TEST (woff2 blocked):');
  for (const r of fallback.results) {
    const f = (r.fonts && r.fonts[0]) ? r.fonts[0] : { familyName: 'Unknown', isCustomFont: false, glyphCount: 0 };
    lines.push(`- ${r.name.padEnd(20)}: renders in platform fallback "${f.familyName}" (isCustomFont: ${f.isCustomFont})`);
  }

  const outFile = path.join(outDir, 'font_platform_check.txt');
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log('\nWrote ' + outFile + ' successfully:\n');
  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
