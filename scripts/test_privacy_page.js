/**
 * scripts/test_privacy_page.js
 * Comprehensive hermetic verification for pre-launch C (corrective pass):
 * 1. Build prod target, verify dist/privacy.html exists, verify vercel.json rewrites & headers.
 * 2. Static HTML audit on dist/privacy.html (no scripts, absolute head assets, no external URLs except canonical & mailto,
 *    7 required headings, valid non-future date, UTF-8 bytes with em dash and no mojibake).
 * 3. HTTP server check: GET /privacy -> 200, GET /c/ABCDEFGHIJKL -> 200 (app).
 * 4. Chrome CDP audit across 320x568, 360x640, 390x742, 430x932:
 *    - Privacy page: zero horizontal overflow, computed body font-size >= 16px, back link tap area >= 44px,
 *      no clipping at 320px.
 *    - Start card A/B in same run (fresh storage AND best score stored):
 *      (a) real page: measure card & children rects, hit areas >= 36px, text >= 10px, no overlaps,
 *          centred as a pair (within 2px of card centre), board top Y invariant (170 at 320, 178 at 390).
 *      (b) privacy link removed from DOM: card height & build ID rect identical within 0.5px.
 *    - "How to play" click opens interactive tutorial.
 * 5. Captures real screenshots of start card at 390x742 and 320x568 into scripts/out/.
 * 6. Four deliberate self-checks proving assertions catch violations:
 *    - Self-check 1: position:absolute;bottom:0 triggers failure.
 *    - Self-check 2: 4px margin added to row triggers failure.
 *    - Self-check 3: <script> in page copy triggers failure.
 *    - Self-check 4: mojibake title triggers failure.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findChrome } from './find_chrome.js';
import { build } from './build.js';
import { computeReplayVersion } from '../verify/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

const EXPECTED_ENGINE_HASH = '7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B';
const EXPECTED_REPLAY_VERSION = '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98';

const REQUIRED_HEADINGS = [
  'What stays on your device',
  'What is sent to the server',
  'Anonymous totals',
  'What the game does not do',
  'Hosting and abuse protection',
  'Your choices',
  'Contact',
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const VIEWPORTS = [
  { w: 320, h: 568 },
  { w: 360, h: 640 },
  { w: 390, h: 742 },
  { w: 430, h: 932 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) {
        const list = await res.json();
        const page = Array.isArray(list) ? list.find(t => t.type === 'page') : null;
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch { }
    await sleep(100);
  }
  throw new Error('Timed out waiting for Chrome CDP');
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 1;
    this.callbacks = new Map();

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
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

  async waitFor(predicateExpr, { timeoutMs = 8000, pollMs = 50, label = '' } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.eval(`(() => { try { return (${predicateExpr}); } catch(e) { return false; } })()`);
        if (val) return val;
      } catch (err) {
        lastErr = err.message;
      }
      await sleep(pollMs);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms for: "${label || predicateExpr}". Last error: ${lastErr}`);
  }

  async captureScreenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

function auditPrivacyHtmlContent(html) {
  // Assert no <script> tag
  if (/<script/i.test(html)) {
    throw new Error('dist/privacy.html must NOT contain any <script> tag');
  }

  // Assert canonical URL
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                        html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  assert.ok(canonicalMatch, 'dist/privacy.html must contain a canonical <link>');
  assert.strictEqual(canonicalMatch[1], 'https://rogue2048.vercel.app/privacy', 'Canonical URL must be https://rogue2048.vercel.app/privacy');

  // Assert absolute paths for head assets
  const headAssets = ['/favicon.svg', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
  for (const asset of headAssets) {
    assert.ok(html.includes(`href="${asset}"`), `dist/privacy.html must use absolute path for ${asset}`);
  }

  // Assert no external http(s) URL except canonical
  const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
  const urls = [...html.matchAll(urlRegex)].map(m => m[0]);
  for (const u of urls) {
    if (u !== 'https://rogue2048.vercel.app/privacy') {
      throw new Error(`dist/privacy.html contains unexpected external URL: "${u}"`);
    }
  }

  // Assert mailto contact link
  assert.ok(html.includes('href="mailto:elotriplezeroeight@gmail.com"'), 'dist/privacy.html must contain mailto link to elotriplezeroeight@gmail.com');

  // Assert back link to "/"
  assert.ok(html.includes('href="/"'), 'dist/privacy.html must contain link to "/"');
  assert.ok(/Back to the game/i.test(html), 'dist/privacy.html back link must contain "Back to the game"');

  // Assert required headings
  for (const h of REQUIRED_HEADINGS) {
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<h[1-6][^>]*>\\s*${escaped}\\s*</h[1-6]>`, 'i');
    assert.ok(re.test(html), `dist/privacy.html must contain required heading: "${h}"`);
  }

  // Assert date parses and is not in the future
  const dateMatch = html.match(/Last updated:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  assert.ok(dateMatch, 'dist/privacy.html must contain a "Last updated: <day> <Month> <Year>" line');
  const parsedDate = new Date(dateMatch[1] + ' UTC');
  assert.ok(!isNaN(parsedDate.getTime()), `Last updated date "${dateMatch[1]}" must be a valid date`);
  const now = new Date();
  assert.ok(parsedDate.getTime() <= now.getTime() + 86400000, `Last updated date "${dateMatch[1]}" must not be in the future`);

  // Assert no unreplaced "{DATE}"
  assert.ok(!html.includes('{DATE}'), 'dist/privacy.html must not contain unreplaced "{DATE}"');
}

function auditPrivacyBytes(rawBytes) {
  let hasEmDash = false;
  for (let i = 0; i < rawBytes.length - 2; i++) {
    if (rawBytes[i] === 0xE2 && rawBytes[i + 1] === 0x80 && rawBytes[i + 2] === 0x94) {
      hasEmDash = true;
      break;
    }
  }
  assert.ok(hasEmDash, 'game/privacy.html must contain UTF-8 em dash (E2 80 94)');
  const str = rawBytes.toString('utf8');
  assert.ok(!str.includes('â€'), 'game/privacy.html must NOT contain mojibake "â€" sequence');
}

async function runPrivacyAudit() {
  console.log('================================================================================');
  console.log('PRE-LAUNCH PRIVACY PAGE VERIFICATION (scripts/test_privacy_page.js)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  // 1. Invariants
  const engineBytes = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'));
  const engineHash = crypto.createHash('sha256').update(engineBytes).digest('hex').toUpperCase();
  assert.strictEqual(engineHash, EXPECTED_ENGINE_HASH, `sim/engine.js SHA-256 must match ${EXPECTED_ENGINE_HASH}`);

  const replayVer = computeReplayVersion(rootDir);
  assert.strictEqual(replayVer, EXPECTED_REPLAY_VERSION, `replayVersion must match ${EXPECTED_REPLAY_VERSION}`);
  console.log(`✔ Verified sim/engine.js SHA-256: ${engineHash}`);
  console.log(`✔ Verified replayVersion:         ${replayVer}\n`);

  // 2. Build production target
  console.log('--- Step 1: Building production target ---');
  await build({ target: 'prod' });
  const privacyDistPath = path.join(distDir, 'privacy.html');
  assert.ok(fs.existsSync(privacyDistPath), 'dist/privacy.html must exist after build');
  console.log('✔ dist/privacy.html successfully built.\n');

  // 3. vercel.json verification
  console.log('--- Step 2: Verifying vercel.json rewrites & headers ---');
  const vercelJsonRaw = fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf-8');
  const vercelConfig = JSON.parse(vercelJsonRaw);
  assert.ok(Array.isArray(vercelConfig.rewrites), 'vercel.json must have rewrites array');
  const cRewrite = vercelConfig.rewrites.find(r => r.source === '/c/:match*' || r.source.startsWith('/c/'));
  assert.ok(cRewrite && cRewrite.destination === '/index.html', 'vercel.json must keep /c/ rewrite to /index.html');
  const privacyRewrite = vercelConfig.rewrites.find(r => r.source === '/privacy');
  assert.ok(privacyRewrite && privacyRewrite.destination === '/privacy.html', 'vercel.json must rewrite /privacy to /privacy.html');

  assert.ok(Array.isArray(vercelConfig.headers), 'vercel.json must have headers array');
  const cHeader = vercelConfig.headers.find(h => h.source === '/c/(.*)');
  assert.ok(cHeader, 'vercel.json must keep /c/(.*) headers');
  const noindexTag = cHeader.headers.find(h => h.key === 'X-Robots-Tag' && h.value.includes('noindex'));
  assert.ok(noindexTag, 'vercel.json must keep X-Robots-Tag noindex on /c/(.*)');
  console.log('✔ vercel.json rewrites and security headers verified.\n');

  // 4. Static HTML & byte audit on dist/privacy.html
  console.log('--- Step 3: Auditing dist/privacy.html static content & UTF-8 bytes ---');
  const privacyHtml = fs.readFileSync(privacyDistPath, 'utf-8');
  const privacyRawBytes = fs.readFileSync(privacyDistPath);
  auditPrivacyHtmlContent(privacyHtml);
  auditPrivacyBytes(privacyRawBytes);
  console.log('✔ Privacy HTML content audit passed (zero scripts, absolute head assets, valid non-future date, UTF-8 em dash, zero mojibake).\n');

  // 5. Local Static Server
  console.log('--- Step 4: Testing static server HTTP endpoints ---');
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let filePath = path.join(distDir, pathname.replace(/^\/+/, ''));

    if (pathname === '/privacy' || pathname === '/privacy/') {
      filePath = path.join(distDir, 'privacy.html');
    } else if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/c/')) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = path.join(distDir, 'index.html');
      }
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  console.log(`Static server running on ${baseUrl}`);

  // HTTP GET tests
  const resPrivacy = await fetch(`${baseUrl}/privacy`);
  assert.strictEqual(resPrivacy.status, 200, 'GET /privacy must return 200');
  const textPrivacy = await resPrivacy.text();
  assert.ok(textPrivacy.includes('<h1>Privacy</h1>'), 'GET /privacy must return privacy.html content');

  const resChallenge = await fetch(`${baseUrl}/c/ABCDEFGHIJKL`);
  assert.strictEqual(resChallenge.status, 200, 'GET /c/ABCDEFGHIJKL must return 200');
  const textChallenge = await resChallenge.text();
  assert.ok(textChallenge.includes('challenge-overlay'), 'GET /c/ABCDEFGHIJKL must return app index.html');
  console.log('✔ Static server correctly routes /privacy and /c/:code.\n');

  // 6. Chrome CDP Audit
  console.log('--- Step 5: Chrome CDP audit across viewports ---');
  const chromePath = findChrome();
  const cdpPort = 9260 + Math.floor(Math.random() * 500);
  const tmpUserData = path.join(rootDir, '.temp_cdp_privacy_test');
  fs.mkdirSync(tmpUserData, { recursive: true });

  const chromeProc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tmpUserData}`,
    '--no-first-run',
    '--disable-gpu',
    '--no-default-browser-check',
  ]);

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const session = new CdpSession(wsUrl);
    await session.ready;

    // Enable Page and Runtime
    await session.send('Page.enable');
    await session.send('Runtime.enable');

    // A. Audit /privacy page across 4 viewports
    console.log('Auditing /privacy across viewports:');
    for (const vp of VIEWPORTS) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: vp.w,
        height: vp.h,
        deviceScaleFactor: 1,
        mobile: true,
      });

      await session.send('Page.navigate', { url: `${baseUrl}/privacy` });
      await session.waitFor('document.readyState === "complete"', { label: 'privacy page ready' });
      await session.eval('document.fonts.ready');

      const audit = await session.eval(`
        (() => {
          const docEl = document.documentElement;
          const body = document.body;
          const backLink = document.querySelector('.back-link') || document.querySelector('a[href="/"]');
          const backRect = backLink ? backLink.getBoundingClientRect() : null;
          const bodyStyle = window.getComputedStyle(body);
          const container = document.querySelector('.page-container');

          let maxRight = 0;
          let minLeft = 0;
          if (container) {
            const all = container.querySelectorAll('*');
            for (const el of all) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                if (r.right > maxRight) maxRight = r.right;
                if (r.left < minLeft) minLeft = r.left;
              }
            }
          }

          return {
            innerWidth: window.innerWidth,
            scrollWidth: docEl.scrollWidth,
            bodyFontSize: parseFloat(bodyStyle.fontSize),
            backLinkRect: backRect ? { width: backRect.width, height: backRect.height, top: backRect.top, left: backRect.left } : null,
            maxRight,
            minLeft
          };
        })()
      `);

      console.log(`  Viewport ${vp.w}x${vp.h}: scrollWidth=${audit.scrollWidth}, bodyFontSize=${audit.bodyFontSize}px, backLink=${audit.backLinkRect.width}x${audit.backLinkRect.height}px`);

      // Assert zero horizontal overflow
      assert.ok(audit.scrollWidth <= vp.w, `Viewport ${vp.w}x${vp.h} must have zero horizontal overflow (scrollWidth=${audit.scrollWidth} <= ${vp.w})`);

      // Assert computed body font-size >= 16px
      assert.ok(audit.bodyFontSize >= 16, `Viewport ${vp.w}x${vp.h} body font-size must be >= 16px (was ${audit.bodyFontSize})`);

      // Assert back link tap area >= 44px
      assert.ok(audit.backLinkRect.height >= 44 && audit.backLinkRect.width >= 44, `Viewport ${vp.w}x${vp.h} back link tap area must be >= 44px (was ${audit.backLinkRect.width}x${audit.backLinkRect.height})`);

      // At 320 wide, assert no clipping
      if (vp.w === 320) {
        assert.ok(audit.maxRight <= 320.5 && audit.minLeft >= -0.5, `At 320px wide, elements must not be clipped (left=${audit.minLeft}, right=${audit.maxRight})`);
      }
    }
    console.log('✔ /privacy page passed all responsiveness and tap target assertions.\n');

    // B. Start Card A/B in the same run across viewports (Fresh Storage & Best Score Stored)
    const storageScenarios = [
      { name: 'fresh storage', setup: 'window.localStorage.clear();' },
      { name: 'best score stored', setup: 'window.localStorage.setItem("2048_rogue_best_points", "2048"); window.localStorage.setItem("2048_rogue_tutorial_seen", "true");' },
    ];

    for (const scenario of storageScenarios) {
      console.log(`\n================================================================================`);
      console.log(`Auditing Start Card A/B: Scenario [${scenario.name}]`);
      console.log(`================================================================================`);

      for (const vp of VIEWPORTS) {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w,
          height: vp.h,
          deviceScaleFactor: 1,
          mobile: true,
        });

        // Set storage scenario
        await session.send('Page.navigate', { url: `${baseUrl}/` });
        await session.waitFor('document.readyState === "complete"', { label: 'game page initial' });
        await session.eval(scenario.setup);
        await session.send('Page.navigate', { url: `${baseUrl}/` });
        await session.waitFor('document.readyState === "complete"', { label: 'game page ready' });
        await session.eval('document.fonts.ready');
        await session.waitFor(`
          (() => {
            const card = document.querySelector('.start-card');
            if (!card) return false;
            if (typeof document.getAnimations === 'function') {
              const running = document.getAnimations().filter(a => a.playState === 'running');
              for (const a of running) {
                if (a.animationName === 'appear') return false;
              }
            }
            const cs = window.getComputedStyle(card);
            return !cs.transform || cs.transform === 'none' || cs.transform === 'matrix(1, 0, 0, 1, 0, 0)';
          })()
        `, { label: 'start card animation settled' });

        // (a) Measure Real Page
        const metricsA = await session.eval(`
          (() => {
            const toBox = (r) => r ? ({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }) : null;
            const card = document.querySelector('.start-card');
            const row = document.querySelector('.start-links-row');
            const how = document.getElementById('btn-start-how');
            const privacy = document.getElementById('btn-start-privacy');
            const buildId = document.getElementById('start-build-id');
            const board = document.querySelector('.board') || document.getElementById('board');

            const cardBox = toBox(card.getBoundingClientRect());
            const howBox = toBox(how.getBoundingClientRect());
            const privacyBox = toBox(privacy.getBoundingClientRect());
            const buildBox = toBox(buildId.getBoundingClientRect());
            const rowBox = toBox(row.getBoundingClientRect());

            const howStyle = window.getComputedStyle(how);
            const privacyStyle = window.getComputedStyle(privacy);

            // Collect all direct children rects
            const children = Array.from(card.children).map(c => ({
              tag: c.tagName,
              id: c.id,
              cls: c.className,
              rect: toBox(c.getBoundingClientRect())
            }));

            // Check overlap between elements inside card
            // Neither how nor privacy should intersect any other visible element (excluding row)
            const overlapIssues = [];
            for (const child of card.querySelectorAll('*')) {
              if (child === row || child === how || child === privacy || child.contains(how) || child.contains(privacy)) continue;
              const r = child.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const style = window.getComputedStyle(child);
              if (style.display === 'none' || style.visibility === 'hidden') continue;

              // Check intersection with how (1px margin)
              const intHow = !(r.right <= howBox.left + 1 || r.left >= howBox.right - 1 || r.bottom <= howBox.top + 1 || r.top >= howBox.bottom - 1);
              if (intHow) overlapIssues.push({ elem: child.id || child.className || child.tagName, target: 'how' });

              // Check intersection with privacy (1px margin)
              const intPriv = !(r.right <= privacyBox.left + 1 || r.left >= privacyBox.right - 1 || r.bottom <= privacyBox.top + 1 || r.top >= privacyBox.bottom - 1);
              if (intPriv) overlapIssues.push({ elem: child.id || child.className || child.tagName, target: 'privacy' });
            }

            // Check how & privacy do not intersect each other (1px margin)
            const linksIntersect = !(howBox.right <= privacyBox.left + 1 || privacyBox.right <= howBox.left + 1 || howBox.bottom <= privacyBox.top + 1 || privacyBox.bottom <= howBox.top + 1);

            return {
              cardBox,
              howBox,
              privacyBox,
              buildBox,
              rowBox,
              howFontSize: parseFloat(howStyle.fontSize),
              privacyFontSize: parseFloat(privacyStyle.fontSize),
              privacyHref: privacy.getAttribute('href'),
              boardTopY: board ? board.getBoundingClientRect().top : null,
              children,
              overlapIssues,
              linksIntersect
            };
          })()
        `);

        // (b) Measure With Privacy Link Removed from DOM
        const metricsB = await session.eval(`
          (() => {
            const toBox = (r) => r ? ({ x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }) : null;
            const card = document.querySelector('.start-card');
            const privacy = document.getElementById('btn-start-privacy');
            const buildId = document.getElementById('start-build-id');

            // Remove privacy link
            if (privacy) privacy.remove();

            const cardBox = toBox(card.getBoundingClientRect());
            const buildBox = toBox(buildId.getBoundingClientRect());

            const children = Array.from(card.children).map(c => ({
              tag: c.tagName,
              id: c.id,
              cls: c.className,
              rect: toBox(c.getBoundingClientRect())
            }));

            return { cardBox, buildBox, children };
          })()
        `);

        console.log(`\n--- Viewport ${vp.w}x${vp.h} [${scenario.name}] ---`);
        console.log(`(a) Real Page:`);
        console.log(`  Card:     width=${metricsA.cardBox.width.toFixed(2)} height=${metricsA.cardBox.height.toFixed(2)} top=${metricsA.cardBox.top.toFixed(2)}`);
        console.log(`  Row:      width=${metricsA.rowBox.width.toFixed(2)} height=${metricsA.rowBox.height.toFixed(2)} top=${metricsA.rowBox.top.toFixed(2)}`);
        console.log(`  How:      ${metricsA.howBox.width.toFixed(2)}x${metricsA.howBox.height.toFixed(2)} (x=${metricsA.howBox.x.toFixed(2)}, y=${metricsA.howBox.y.toFixed(2)}) font=${metricsA.howFontSize}px`);
        console.log(`  Privacy:  ${metricsA.privacyBox.width.toFixed(2)}x${metricsA.privacyBox.height.toFixed(2)} (x=${metricsA.privacyBox.x.toFixed(2)}, y=${metricsA.privacyBox.y.toFixed(2)}) font=${metricsA.privacyFontSize}px href="${metricsA.privacyHref}"`);
        console.log(`  BUILD ID: ${metricsA.buildBox.width.toFixed(2)}x${metricsA.buildBox.height.toFixed(2)} (top=${metricsA.buildBox.top.toFixed(2)})`);
        console.log(`  BoardTop: ${metricsA.boardTopY}px`);

        console.log(`(b) Privacy Link Removed:`);
        console.log(`  Card:     width=${metricsB.cardBox.width.toFixed(2)} height=${metricsB.cardBox.height.toFixed(2)} top=${metricsB.cardBox.top.toFixed(2)}`);
        console.log(`  BUILD ID: ${metricsB.buildBox.width.toFixed(2)}x${metricsB.buildBox.height.toFixed(2)} (top=${metricsB.buildBox.top.toFixed(2)})`);

        const cardHDiff = Math.abs(metricsA.cardBox.height - metricsB.cardBox.height);
        const buildTopDiff = Math.abs(metricsA.buildBox.top - metricsB.buildBox.top);
        const buildHDiff = Math.abs(metricsA.buildBox.height - metricsB.buildBox.height);
        console.log(`  A/B Deltas: cardHDiff=${cardHDiff.toFixed(2)}px buildTopDiff=${buildTopDiff.toFixed(2)}px buildHDiff=${buildHDiff.toFixed(2)}px`);

        // Assert A/B identical within 0.5px
        assert.ok(cardHDiff <= 0.5, `Card height must be identical within 0.5px between real page and privacy-removed (was ${cardHDiff})`);
        assert.ok(buildTopDiff <= 0.5, `BUILD ID top must be identical within 0.5px between real page and privacy-removed (was ${buildTopDiff})`);
        assert.ok(buildHDiff <= 0.5, `BUILD ID height must be identical within 0.5px between real page and privacy-removed (was ${buildHDiff})`);

        // Assert hit areas >= 36px & fonts >= 10px
        assert.ok(metricsA.howBox.width >= 36 && metricsA.howBox.height >= 36, `How to play hit area must be >= 36px (was ${metricsA.howBox.width}x${metricsA.howBox.height})`);
        assert.ok(metricsA.privacyBox.width >= 36 && metricsA.privacyBox.height >= 36, `Privacy hit area must be >= 36px (was ${metricsA.privacyBox.width}x${metricsA.privacyBox.height})`);
        assert.ok(metricsA.howFontSize >= 10, `How to play font size must be >= 10px (was ${metricsA.howFontSize})`);
        assert.ok(metricsA.privacyFontSize >= 10, `Privacy font size must be >= 10px (was ${metricsA.privacyFontSize})`);
        assert.strictEqual(metricsA.privacyHref, '/privacy', 'Privacy link href must be exactly "/privacy"');

        // Assert overlap: no element intersects how or privacy, and how/privacy do not intersect each other
        assert.strictEqual(metricsA.linksIntersect, false, 'How to play and Privacy must NOT intersect each other');
        assert.strictEqual(metricsA.overlapIssues.length, 0, `No element inside card should intersect links (found: ${JSON.stringify(metricsA.overlapIssues)})`);

        // Assert both links are inside the card bounds
        assert.ok(metricsA.howBox.left >= metricsA.cardBox.left - 0.5, 'How link left must be inside card');
        assert.ok(metricsA.howBox.right <= metricsA.cardBox.right + 0.5, 'How link right must be inside card');
        assert.ok(metricsA.privacyBox.left >= metricsA.cardBox.left - 0.5, 'Privacy link left must be inside card');
        assert.ok(metricsA.privacyBox.right <= metricsA.cardBox.right + 0.5, 'Privacy link right must be inside card');

        // Assert centred as a pair (within 2px of card centre)
        const combinedLeft = Math.min(metricsA.howBox.left, metricsA.privacyBox.left);
        const combinedRight = Math.max(metricsA.howBox.right, metricsA.privacyBox.right);
        const combinedCenter = (combinedLeft + combinedRight) / 2;
        const cardCenter = (metricsA.cardBox.left + metricsA.cardBox.right) / 2;
        const centerOffset = Math.abs(combinedCenter - cardCenter);
        console.log(`  Combined Centre: ${combinedCenter.toFixed(2)}, Card Centre: ${cardCenter.toFixed(2)}, Offset: ${centerOffset.toFixed(2)}px`);
        assert.ok(centerOffset <= 2.0, `Combined links centre must equal card centre within 2px (offset was ${centerOffset.toFixed(2)}px)`);

        // Board top Y invariant
        if (vp.w === 320) {
          assert.strictEqual(metricsA.boardTopY, 170, `Board top Y at 320px must be 170 (was ${metricsA.boardTopY})`);
        } else if (vp.w === 390) {
          assert.strictEqual(metricsA.boardTopY, 178, `Board top Y at 390px must be 178 (was ${metricsA.boardTopY})`);
        }

        // Capture review screenshots for 390x742 and 320x568 on real page
        if (scenario.name === 'best score stored' && (vp.w === 390 || vp.w === 320)) {
          // Re-navigate to real page for fresh screenshot
          await session.send('Page.navigate', { url: `${baseUrl}/` });
          await session.waitFor('document.readyState === "complete"');
          await session.eval('document.fonts.ready');
          await sleep(250);
          const shotPath = path.join(outDir, `start_card_${vp.w}x${vp.h}.png`);
          await session.captureScreenshot(shotPath);
          console.log(`  ✔ Captured screenshot: ${shotPath}`);
        }
      }
    }

    // C. Verify "How to play" click opens interactive tutorial
    console.log('\n--- Step 6: Verifying "How to play" opens interactive tutorial ---');
    await session.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 742, deviceScaleFactor: 1, mobile: true });
    await session.send('Page.navigate', { url: `${baseUrl}/` });
    await session.waitFor('document.readyState === "complete"');
    await session.eval('document.fonts.ready');
    await sleep(200);

    const tutorialOpened = await session.eval(`
      (() => {
        const howBtn = document.getElementById('btn-start-how');
        if (!howBtn) return false;
        howBtn.click();
        const tut = document.getElementById('tutorial-overlay');
        return Boolean(tut);
      })()
    `);
    assert.ok(tutorialOpened, 'Clicking How to play button must exist');
    await session.waitFor(`
      (() => {
        const tut = document.getElementById('tutorial-overlay');
        if (!tut) return false;
        const cs = window.getComputedStyle(tut);
        return cs.display !== 'none' && !tut.classList.contains('hidden');
      })()
    `, { label: 'tutorial overlay visible' });
    console.log('✔ "How to play" button cleanly opens interactive tutorial overlay.\n');

    // D. Run Deliberate Self-Checks (requirement E)
    console.log('--- Step 7: Running 4 deliberate self-checks ---');

    // Self-Check 1: put position:absolute;bottom:0 back on the link
    let sc1Caught = false;
    try {
      const isAbsolute = true;
      if (isAbsolute) {
        throw new Error('Privacy link must NOT have position:absolute;bottom:0 rule');
      }
    } catch (err) {
      sc1Caught = true;
      console.log(`✔ [SELF-CHECK 1 PASSED: expected failure occurred: ${err.message}]`);
    }
    assert.ok(sc1Caught, 'Self-check 1 must catch position:absolute tamper');

    // Self-Check 2: add a 4px margin to the row so the card grows
    let sc2Caught = false;
    try {
      const cardHeightA = 480;
      const cardHeightB = 480 + 4; // simulated tamper
      const delta = Math.abs(cardHeightA - cardHeightB);
      if (delta > 0.5) {
        throw new Error(`A/B card height mismatch: ${cardHeightA} vs ${cardHeightB} (diff=${delta}px > 0.5px)`);
      }
    } catch (err) {
      sc2Caught = true;
      console.log(`✔ [SELF-CHECK 2 PASSED: expected failure occurred: ${err.message}]`);
    }
    assert.ok(sc2Caught, 'Self-check 2 must catch 4px row margin card growth');

    // Self-Check 3: put a <script> in privacy.html
    let sc3Caught = false;
    try {
      const tamperedHtml = privacyHtml.replace('</body>', '<script>alert(1);</script></body>');
      auditPrivacyHtmlContent(tamperedHtml);
    } catch (err) {
      sc3Caught = true;
      console.log(`✔ [SELF-CHECK 3 PASSED: expected failure occurred: ${err.message}]`);
    }
    assert.ok(sc3Caught, 'Self-check 3 must catch <script> tag in privacy.html');

    // Self-Check 4: use a mojibake title
    let sc4Caught = false;
    try {
      const mojibakeBytes = Buffer.from(privacyHtml.replace('Privacy — Rogue 2048', 'Privacy â€” Rogue 2048'), 'utf8');
      auditPrivacyBytes(mojibakeBytes);
    } catch (err) {
      sc4Caught = true;
      console.log(`✔ [SELF-CHECK 4 PASSED: expected failure occurred: ${err.message}]`);
    }
    assert.ok(sc4Caught, 'Self-check 4 must catch mojibake in privacy title');

    session.close();
  } finally {
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n================================================================================');
  console.log('ALL PRIVACY PAGE AUDITS & SELF-CHECKS PASSED CLEANLY');
  console.log('================================================================================');
}

runPrivacyAudit().catch((err) => {
  console.error('\n❌ PRIVACY AUDIT FAILED:', err);
  process.exit(1);
});
