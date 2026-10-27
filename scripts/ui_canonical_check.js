/**
 * scripts/ui_canonical_check.js
 *
 * P1b DRIFT GUARD.
 * Loads the default URL in headless Chrome, reads the resolved config of the live controller (controller.config),
 * normalises it exactly as verify/profile.js normalizeConfig does, and asserts deep-equality with CANONICAL_CONFIG.
 * Also tests:
 *  - ?seed=5 (must match CANONICAL_CONFIG)
 *  - ?stones=0.1 (must differ in hazardSchedule, proving the check can fail)
 *
 * Outputs to scripts/out/ui_canonical_check.txt.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { findChrome } from './find_chrome.js';
import { CANONICAL_CONFIG, normalizeConfig, checkCanonicalConfig } from '../verify/profile.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');
const outFile = path.join(outDir, 'ui_canonical_check.txt');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function startStaticServer() {
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
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(distDir, relPath === '' ? 'index.html' : relPath);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function getWsUrl(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = list.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`Failed to obtain WebSocket URL from Chrome on port ${port}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = err => reject(err);
      this.ws.onmessage = msg => {
        try {
          const res = JSON.parse(msg.data);
          if (res.method === 'Runtime.exceptionThrown') {
            console.error('[Page Uncaught Exception]', res.params.exceptionDetails?.exception?.description || res.params.exceptionDetails?.text);
          } else if (res.method === 'Runtime.consoleAPICalled' && res.params.type === 'error') {
            console.error('[Page Console Error]', res.params.args?.map(a => a.value || a.description).join(' '));
          }
          if (res.id && this.callbacks.has(res.id)) {
            const cb = this.callbacks.get(res.id);
            this.callbacks.delete(res.id);
            if (res.error) cb.reject(new Error(res.error.message || JSON.stringify(res.error)));
            else cb.resolve(res.result);
          }
        } catch (e) {
          console.error('CDP onmessage parse error:', e);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
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
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`CDP eval exception: ${desc} (${expression})`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForController(cdp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const ready = await cdp.eval('Boolean(window.controller && window.controller.config)');
      if (ready) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('Timed out waiting for window.controller');
}

async function readLiveConfig(cdp) {
  await waitForController(cdp);
  const expr = `
    (() => {
      return JSON.parse(JSON.stringify(window.controller.config, (k, v) => {
        if (v === Infinity) return 'Infinity';
        if (v === -Infinity) return '-Infinity';
        return v;
      }));
    })()
  `;
  return await cdp.eval(expr);
}

export async function runUiCanonicalCheck() {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome binary not found');

  const server = await startStaticServer();
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}/`;

  const cdpPort = await getFreePort();
  const chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    'about:blank',
  ]);

  const outputLines = [];
  outputLines.push('=== UI CANONICAL CONFIG DRIFT GUARD CHECK ===');
  outputLines.push(`Timestamp: ${new Date().toISOString()}`);
  outputLines.push(`CANONICAL_CONFIG key count: ${Object.keys(CANONICAL_CONFIG).length}`);
  outputLines.push('');

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 1. Default URL (no parameters)
    console.log('[Drift Guard] 1. Checking default URL (no params)...');
    await cdp.send('Page.navigate', { url: baseUrl });
    const defaultRawConfig = await readLiveConfig(cdp);
    const defaultNormalized = normalizeConfig(defaultRawConfig);
    const defaultCheck = checkCanonicalConfig(defaultNormalized);

    const defaultKeyCount = Object.keys(defaultNormalized).length;
    const defaultCanonicalKeyCount = Object.keys(CANONICAL_CONFIG).length;

    outputLines.push('1. Default URL (no parameters):');
    outputLines.push(`   URL: ${baseUrl}`);
    outputLines.push(`   Live controller config keys: ${defaultKeyCount}`);
    outputLines.push(`   CANONICAL_CONFIG keys: ${defaultCanonicalKeyCount}`);
    outputLines.push(`   Deep equality: ${defaultCheck.ok ? 'MATCH (deep-equal)' : 'MISMATCH'}`);
    if (!defaultCheck.ok) {
      outputLines.push(`   Differing key: ${defaultCheck.key}`);
      outputLines.push(`   Reason: ${defaultCheck.reason}`);
    } else {
      outputLines.push(`   Differing key: (none)`);
    }
    outputLines.push('');

    assert.equal(defaultCheck.ok, true, `Default URL config must match CANONICAL_CONFIG: ${defaultCheck.reason}`);
    assert.equal(defaultKeyCount, defaultCanonicalKeyCount, 'Default config key count must match CANONICAL_CONFIG key count');

    // 2. ?seed=5 (still canonical config)
    console.log('[Drift Guard] 2. Checking ?seed=5 URL...');
    const seedUrl = `${baseUrl}?seed=5`;
    await cdp.send('Page.navigate', { url: seedUrl });
    const seedRawConfig = await readLiveConfig(cdp);
    const seedNormalized = normalizeConfig(seedRawConfig);
    const seedCheck = checkCanonicalConfig(seedNormalized);
    const seedKeyCount = Object.keys(seedNormalized).length;

    outputLines.push('2. ?seed=5 URL (seed parameter only, config remains canonical):');
    outputLines.push(`   URL: ${seedUrl}`);
    outputLines.push(`   Live controller config keys: ${seedKeyCount}`);
    outputLines.push(`   CANONICAL_CONFIG keys: ${defaultCanonicalKeyCount}`);
    outputLines.push(`   Deep equality: ${seedCheck.ok ? 'MATCH (deep-equal)' : 'MISMATCH'}`);
    if (!seedCheck.ok) {
      outputLines.push(`   Differing key: ${seedCheck.key}`);
      outputLines.push(`   Reason: ${seedCheck.reason}`);
    } else {
      outputLines.push(`   Differing key: (none)`);
    }
    outputLines.push('');

    assert.equal(seedCheck.ok, true, `?seed=5 config must match CANONICAL_CONFIG: ${seedCheck.reason}`);

    // 3. ?stones=0.1 (must differ in hazardSchedule to prove the check can fail)
    console.log('[Drift Guard] 3. Checking ?stones=0.1 URL (must report hazardSchedule difference)...');
    const stonesUrl = `${baseUrl}?stones=0.1`;
    await cdp.send('Page.navigate', { url: stonesUrl });
    const stonesRawConfig = await readLiveConfig(cdp);
    const stonesNormalized = normalizeConfig(stonesRawConfig);
    const stonesCheck = checkCanonicalConfig(stonesNormalized);
    const stonesKeyCount = Object.keys(stonesNormalized).length;

    outputLines.push('3. ?stones=0.1 URL (testing failure detection):');
    outputLines.push(`   URL: ${stonesUrl}`);
    outputLines.push(`   Live controller config keys: ${stonesKeyCount}`);
    outputLines.push(`   Deep equality: ${stonesCheck.ok ? 'MATCH (unexpected)' : 'MISMATCH (expected)'}`);
    outputLines.push(`   Reported differing key: ${stonesCheck.key}`);
    outputLines.push(`   Reported reason: ${stonesCheck.reason}`);
    outputLines.push('');

    assert.equal(stonesCheck.ok, false, '?stones=0.1 MUST fail canonical check');
    assert.equal(stonesCheck.key, 'hazardSchedule', `?stones=0.1 must differ in hazardSchedule, got: ${stonesCheck.key}`);

    outputLines.push('SUMMARY: Drift guard passed. Default and ?seed=5 match CANONICAL_CONFIG exactly. ?stones=0.1 correctly detected differing hazardSchedule.');

    const resultText = outputLines.join('\n') + '\n';
    fs.writeFileSync(outFile, resultText, 'utf-8');
    console.log(resultText);
    console.log(`Saved drift guard check to ${outFile}`);

    cdp.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runUiCanonicalCheck().catch(err => {
    console.error('❌ Drift guard check failed:', err);
    process.exit(1);
  });
}
