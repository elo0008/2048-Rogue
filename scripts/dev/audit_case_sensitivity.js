import { findChrome } from '../find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const distDir = path.join(rootDir, 'dist');
const outFile = path.join(rootDir, 'scripts', 'out', 'case_sensitivity.txt');

const CHROME_PATH = findChrome();
const CDP_PORT = 9266;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 1. Collect all files in dist/ recursively using fs.readdirSync (strictly preserve case)
function getExactCaseDistFiles(dir, prefix = '') {
  let fileList = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      fileList = fileList.concat(getExactCaseDistFiles(full, rel));
    } else {
      fileList.push(rel);
    }
  }
  return fileList;
}

const exactDistFiles = getExactCaseDistFiles(distDir);
const exactDistSet = new Set(exactDistFiles);

const logLines = [];
function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

log(`=== P2 & P4: CASE SENSITIVITY AND NETWORK AUDIT ===\n`);
log(`Dist files discovered by fs.readdirSync (${exactDistFiles.length} files):`);
for (const f of exactDistFiles) {
  log(`  - ${f}`);
}
log('');

// 2. Static source audit: imports in game/*.js, src/href in index.html, url() in style.css
log(`Static Source Reference Check:`);
const staticAuditRows = [];

// game/*.js imports
const gameJsFiles = fs.readdirSync(path.join(rootDir, 'game')).filter(f => f.endsWith('.js'));
for (const f of gameJsFiles) {
  const code = fs.readFileSync(path.join(rootDir, 'game', f), 'utf-8');
  const importMatches = code.matchAll(/(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])/g);
  for (const m of importMatches) {
    const spec = m[1] || m[2];
    if (spec.startsWith('.')) {
      const clean = spec.replace(/^\.\//, '');
      const cleanDist = clean.replace(/^\.\.\/sim\//, '');
      const match = exactDistSet.has(cleanDist) || exactDistFiles.some(d => d.toLowerCase() === cleanDist.toLowerCase());
      const exactMatch = exactDistSet.has(cleanDist);
      staticAuditRows.push({
        source: `game/${f}`,
        reference: spec,
        resolvedInDist: cleanDist,
        exactMatch: exactMatch ? 'EXACT' : (match ? 'CASE_MISMATCH' : 'NOT_FOUND'),
      });
    }
  }
}

// game/index.html src and href
const htmlContent = fs.readFileSync(path.join(rootDir, 'game', 'index.html'), 'utf-8');
const htmlRefMatches = htmlContent.matchAll(/(?:src|href)=['"]([^'"]+)['"]/g);
for (const m of htmlRefMatches) {
  const ref = m[1];
  if (!ref.startsWith('http') && !ref.startsWith('#') && !ref.startsWith('data:')) {
    const clean = ref.replace(/^\.\//, '');
    const exactMatch = exactDistSet.has(clean);
    staticAuditRows.push({
      source: 'game/index.html',
      reference: ref,
      resolvedInDist: clean,
      exactMatch: exactMatch ? 'EXACT' : 'NOT_FOUND',
    });
  }
}

// game/style.css url()
const cssContent = fs.readFileSync(path.join(rootDir, 'game', 'style.css'), 'utf-8');
const cssUrlMatches = cssContent.matchAll(/url\(['"]?([^'")]+)['"]?\)/g);
for (const m of cssUrlMatches) {
  const ref = m[1];
  if (!ref.startsWith('data:')) {
    const clean = ref.replace(/^\.\//, '');
    const exactMatch = exactDistSet.has(clean);
    staticAuditRows.push({
      source: 'game/style.css',
      reference: ref,
      resolvedInDist: clean,
      exactMatch: exactMatch ? 'EXACT' : 'NOT_FOUND',
    });
  }
}

log(`\nStatic Reference Table:`);
log(`Source File          | Reference Specifier     | Resolved in dist         | Match Status`);
log(`---------------------+-------------------------+--------------------------+-------------`);
for (const row of staticAuditRows) {
  log(
    `${row.source.padEnd(20)} | ` +
    `${row.reference.padEnd(23)} | ` +
    `${row.resolvedInDist.padEnd(24)} | ` +
    `${row.exactMatch}`
  );
}

// 3. Start minimal static server for dist
function startStaticServer() {
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let p = u.pathname;
      if (p === '/') p = '/index.html';
      const cleanPath = p.replace(/^\//, '');
      const filePath = path.join(distDir, cleanPath);

      // Verify exact case by scanning directory
      const parts = cleanPath.split('/');
      let curr = distDir;
      let exactExists = true;
      for (const part of parts) {
        if (!fs.existsSync(curr)) { exactExists = false; break; }
        const children = fs.readdirSync(curr);
        if (!children.includes(part)) {
          exactExists = false;
          break;
        }
        curr = path.join(curr, part);
      }

      if (!exactExists || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${cleanPath}`);
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const server = await startStaticServer();
const port = server.address().port;
log(`\nLocal exact-case server running on port ${port}`);

// 4. Launch headless Chrome & CDP
const chromeProcess = spawn(CHROME_PATH, [
  `--remote-debugging-port=${CDP_PORT}`,
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  'about:blank',
]);

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
    this.networkRequests = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Network.requestWillBeSent') {
        this.networkRequests.push(data.params.request);
      }
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
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

try {
  const wsUrl = await getWsUrl();
  const cdp = new CdpClient(wsUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  log(`Navigating to smoke run with ?debug=1&start=diagonal_charge ...`);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug=1&start=diagonal_charge` });
  await sleep(500);

  // 1. Click START
  await cdp.eval(`document.getElementById('btn-play-start').click()`);
  await sleep(200);

  // 2. Swipes
  for (let i = 0; i < 4; i++) {
    const DIRS = ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'];
    const d = DIRS[i % 4];
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${d}', key: '${d}' }))`);
    await sleep(100);
  }

  // 3. Trigger debug uncaught error (P6 test)
  log(`Triggering ?debug=1 uncaught error hook...`);
  await cdp.eval(`window.__throwDebugError('P6 test uncaught error')`);
  await sleep(200);

  // 4. Use an ability (open diagonal ability targeting and cancel or use)
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-ability-1');
      if (btn) btn.click();
    })()
  `);
  await sleep(200);
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))`);
  await sleep(100);

  // 5. Open Pause Sheet and close it
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-pause-menu');
      if (btn) btn.click();
    })()
  `);
  await sleep(200);
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-resume');
      if (btn) btn.click();
    })()
  `);
  await sleep(200);

  // 6. Trigger a draft modal
  await cdp.eval(`
    (() => {
      const decision = {
        type: 'draft',
        offers: ['eraser', 'mason', 'siphon']
      };
      window.showDraftModal(decision);
    })()
  `);
  await sleep(300);

  // Select a draft card
  await cdp.eval(`
    (() => {
      const cards = document.querySelectorAll('.draft-card');
      if (cards.length > 0) cards[0].click();
    })()
  `);
  await sleep(300);

  // 7. Trigger Game Over
  await cdp.eval(`window.handleGameOver()`);
  await sleep(400);

  // 8. Assert P6 uncaught error appears in Copy Run Log payload!
  const copyPayload = await cdp.eval(`window.getCopyPayload()`);
  assert.ok(copyPayload, 'Copy payload must be returned');
  assert.ok(Array.isArray(copyPayload.errors), 'Copy payload must include errors array');
  const capturedTestError = copyPayload.errors.find(e => e.message.includes('P6 test uncaught error'));
  assert.ok(capturedTestError, 'P6 uncaught error must appear in getCopyPayload().errors');
  assert.ok(copyPayload.currentRun.errors.some(e => e.message.includes('P6 test uncaught error')), 'P6 uncaught error must appear in currentRun.errors');
  log(`✔ P6 Hook Verification Passed: Captured error "${capturedTestError.message}" (file: ${capturedTestError.file}, line: ${capturedTestError.line}) in Copy Run Log payload!`);

  // 9. Click Play Again
  await cdp.eval(`
    (() => {
      const btn = document.getElementById('btn-play-again');
      if (btn) btn.click();
    })()
  `);
  await sleep(300);

  // 10. Audit Network requests:
  log(`\nNetwork Requests Audit (${cdp.networkRequests.length} requests captured):`);
  log(`Request URL                                      | Scheme | Exact Dist Path        | Exact Case Match`);
  log(`-------------------------------------------------+--------+------------------------+-----------------`);

  const reqTable = [];
  let allExact = true;
  let allSameOriginOrData = true;

  for (const req of cdp.networkRequests) {
    const rawUrl = req.url;
    if (rawUrl.startsWith('data:')) {
      reqTable.push({
        url: 'data:image/svg+xml;base64,...',
        scheme: 'data:',
        distPath: 'N/A (data URI)',
        status: 'OK (data:)',
      });
      continue;
    }

    const u = new URL(rawUrl);
    if (u.origin !== `http://127.0.0.1:${port}`) {
      allSameOriginOrData = false;
    }

    let relPath = u.pathname.replace(/^\//, '');
    if (relPath === '') relPath = 'index.html';

    const exactMatch = exactDistSet.has(relPath);
    if (!exactMatch) allExact = false;

    reqTable.push({
      url: u.pathname,
      scheme: u.protocol,
      distPath: relPath,
      status: exactMatch ? 'EXACT_MATCH' : 'MISMATCH_OR_MISSING',
    });
  }

  for (const r of reqTable) {
    log(
      `${r.url.padEnd(48)} | ` +
      `${r.scheme.padEnd(6)} | ` +
      `${r.distPath.padEnd(22)} | ` +
      `${r.status}`
    );
  }

  log(`\nAudit Summary:`);
  log(`- All requested URLs match exact case in dist: ${allExact ? 'YES' : 'NO'}`);
  log(`- All requests are same-origin or data: (P4 zero external requests): ${allSameOriginOrData ? 'YES' : 'NO'}`);
  log(`- P6 Diagnostics and uncaught error capture verified: YES`);

  cdp.close();
} finally {
  chromeProcess.kill();
  server.close();
}

fs.writeFileSync(outFile, logLines.join('\n'), 'utf-8');
log(`\nReport written to ${outFile}`);
