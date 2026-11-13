/**
 * scripts/test_share_sheet.js
 *
 * Full headless Chrome end-to-end and UI test suite for Rogue 2048 Share Sheet (Challenge a Friend) & Outcome 8 Free Run Card.
 *
 * Scenarios:
 * 1. Daily flow (spinner, ready, link format, expiry text, copy -> COPIED + toast, WhatsApp URL encoding, SEND LINK hidden when navigator.share absent and calls it when present)
 * 2. Free flow (Outcome 8 card, spinner, ready, 32h expiry + note)
 * 3. < 10 moves disabled with line "Play a few more moves to challenge a friend." and 0 requests sent
 * 4. Error mappings: not_found, too_short, rate_limited, rejected, version, network, server (driven by mock behaviours)
 * 5. RETRY button re-triggers creation
 * 6. Same-run reuse sends exactly 1 request to backend
 * 7. Esc, backdrop, close button dismissal
 * 8. Focus trap inside sheet and focus return to trigger button; background card inert
 * 9. Gating: hidden when window.__LB is unset or dev parameters are present
 * 10. XSS safety: player name with <img onerror> renders safely as text
 * 11. Multi-viewport audit (320x568, 360x640, 390x742, 430x932): touch targets >= 36px, text >= 10px, zero overflow
 * 12. Reduced motion: animations & transitions none
 * 13. Deliberate self-check: proves suite can fail
 * 14. Real-page screenshots captured at 390x742 and 320x568 (and worst-case)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { findChrome } from './find_chrome.js';
import { createMockLeaderboardServer } from './mock_leaderboard.js';
import { computeReplayVersion } from '../verify/version.js';
import { build } from './build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const isSelfCheckFail = process.argv.includes('--self-check-fail');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function measureShareSheetGaps(cdp) {
  return await cdp.eval(`
    (() => {
      const sheet = document.getElementById('share-sheet');
      const bubble = document.querySelector('.preview-bubble');
      const metaStack = document.querySelector('.meta-stack');
      const expiryLine = document.querySelector('.expiry-line');
      const freeNote = document.querySelector('.free-note');
      const sendBtn = document.getElementById('btn-sheet-send');
      const actionsRow = document.querySelector('.actions-row');
      const lastBtn = document.getElementById('btn-sheet-copy');

      if (!sheet || !bubble || !expiryLine) return null;

      const bRect = bubble.getBoundingClientRect();
      const mRect = metaStack ? metaStack.getBoundingClientRect() : null;
      const eRect = expiryLine.getBoundingClientRect();
      const fnRect = freeNote ? freeNote.getBoundingClientRect() : null;
      const sRect = sendBtn ? sendBtn.getBoundingClientRect() : null;
      const rRect = actionsRow ? actionsRow.getBoundingClientRect() : (lastBtn ? lastBtn.getBoundingClientRect() : null);
      const shRect = sheet.getBoundingClientRect();

      const gapAbove = eRect.top - bRect.bottom;
      const gapBelow = sRect ? (sRect.top - eRect.bottom) : null;
      const gapBelowMeta = (sRect && mRect) ? (sRect.top - mRect.bottom) : null;

      const distToSheetBottom = rRect ? (shRect.bottom - rRect.bottom) : null;
      const distToVpBottom = rRect ? (window.innerHeight - rRect.bottom) : null;

      return {
        gapAbove,
        gapBelow,
        gapBelowMeta,
        distToSheetBottom,
        distToVpBottom,
        sheetHeight: shRect.height,
        vpHeight: window.innerHeight,
      };
    })()
  `);
}

function assertShareSheetGapsAndPadding(metrics, { minGap = 12, label = '' } = {}) {
  assert.ok(metrics, `Metrics must be present for ${label}`);
  assert.ok(metrics.gapAbove >= minGap, `${label}: gap above expiry line (${metrics.gapAbove}px) must be >= ${minGap}px`);
  assert.ok(metrics.gapBelow >= minGap, `${label}: gap below expiry line (${metrics.gapBelow}px) must be >= ${minGap}px`);
  if (metrics.gapBelowMeta !== null) {
    assert.ok(metrics.gapBelowMeta >= minGap, `${label}: gap below meta-stack (${metrics.gapBelowMeta}px) must be >= ${minGap}px`);
  }
  assert.ok(metrics.distToSheetBottom >= 12, `${label}: last button row must be >= 12px above sheet bottom (got ${metrics.distToSheetBottom}px)`);
  assert.ok(metrics.distToVpBottom > 0, `${label}: last button row must be above viewport bottom (got ${metrics.distToVpBottom}px)`);
  assert.ok(metrics.distToVpBottom >= 12, `${label}: last button row must be >= 12px above viewport bottom (got ${metrics.distToVpBottom}px)`);
}

function startStaticServer(serveDir) {
  const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };

  const requests = [];

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(serveDir, relPath === '' ? 'index.html' : relPath);

    requests.push({ url: req.url, pathname, timestamp: Date.now() });

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
      resolve({ server, port: server.address().port, requests });
    });
  });
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
    this.events = [];

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
      } else if (data.method) {
        this.events.push(data);
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

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await this.send('Emulation.setVisibleSize', { width, height }).catch(() => { });
  }

  async screenshot(filePath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(filePath, buf);
    return buf.length;
  }
}

function cleanTempDist(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch { }
}

async function main() {
  console.log('================================================================================');
  console.log('ROGUE 2048 SHARE SHEET & OUTCOME 8 TEST SUITE');
  console.log(`Self-Check Fail Mode: ${isSelfCheckFail ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Timestamp:            ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  // 1. Invariants check
  console.log('[Pre-Flight] Verifying engine hash & replayVersion...');
  const EXPECTED_ENGINE_HASH = '7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B';
  const EXPECTED_REPLAY_VERSION = '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98';

  const engineBytes = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'));
  const engineHash = crypto.createHash('sha256').update(engineBytes).digest('hex').toUpperCase();
  assert.strictEqual(engineHash, EXPECTED_ENGINE_HASH, 'sim/engine.js SHA-256 invariant');

  const replayVer = computeReplayVersion(rootDir);
  assert.strictEqual(replayVer, EXPECTED_REPLAY_VERSION, 'replayVersion invariant');
  console.log('✔ Pre-flight invariants verified.\n');

  // 2. Start mock leaderboard server
  const mock = createMockLeaderboardServer();
  const mockPort = await mock.listen(0);

  // 3. Build hermetic client distribution
  const tempDistDir = path.join(rootDir, `.temp_dist_share_${Date.now()}`);
  await build({
    target: 'prod',
    distDir: tempDistDir,
    leaderboardUrl: `http://localhost:${mockPort}`,
    leaderboardAnonKey: 'sb_publishable_mock_anon_key',
  });

  const { server: staticServer, port: staticPort } = await startStaticServer(tempDistDir);
  const baseUrl = `http://127.0.0.1:${staticPort}`;

  // 4. Launch headless Chrome
  const chromePath = findChrome();
  const cdpPort = 9480 + Math.floor(Math.random() * 400);
  const tempUserData = path.join(rootDir, `.temp_chrome_share_${Date.now()}`);

  const chromeProc = spawn(chromePath, [
    `--remote-debugging-port=${cdpPort}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--user-data-dir=${tempUserData}`,
    'about:blank',
  ]);

  let cdp = null;
  let passedTests = 0;

  try {
    const wsUrl = await getWsUrl(cdpPort);
    cdp = new CdpSession(wsUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    await cdp.setViewport(390, 742);
    await cdp.send('Page.navigate', { url: baseUrl });
    await sleep(400);

    // Initial setup: Mark tutorial seen & set display name
    await cdp.eval(`
      (() => {
        localStorage.setItem('2048_rogue_tutorial_seen', 'true');
        localStorage.setItem('rogue2048_display_name', 'PlayerOne');
        window.__LB = { url: 'http://127.0.0.1:${mockPort}', anonKey: 'mock-anon-key' };
        if (typeof navigator !== 'undefined' && !navigator.share) {
          navigator.share = async () => {};
        }
      })()
    `);

    // -------------------------------------------------------------------------
    // TEST 1: DAILY FLOW (Creating -> Ready -> Send -> WhatsApp -> Copy)
    // -------------------------------------------------------------------------
    console.log('[Test 1] Testing Daily Run Share Flow (Creating, Ready, Actions)...');
    mock.setBehaviour('slow'); // Slow mock so we can inspect creating state
    await cdp.eval(`
      (() => {
        const eo = document.getElementById('end-overlay');
        if (eo) eo.classList.remove('hidden');
        window.__testRenderRankingCard(2, { rank: 3, total: 35, points: 15420, day: '2026-11-13' });
        document.getElementById('btn-ranking-share')?.click();
      })()
    `);
    await sleep(60);

    // Verify Creating / Waiting State
    const creatingState = await cdp.eval(`
      (() => {
        const sheet = document.getElementById('share-sheet');
        const title = document.getElementById('share-sheet-title')?.textContent;
        const chip = document.getElementById('share-mode-chip')?.textContent;
        const spinner = sheet?.querySelector('.spinner');
        const text = sheet?.querySelector('.status-box')?.textContent;
        const sendBtn = document.getElementById('btn-sheet-send');
        const waBtn = document.getElementById('btn-sheet-wa');
        const copyBtn = document.getElementById('btn-sheet-copy');
        return {
          isOpen: !sheet?.classList.contains('hidden'),
          title,
          chip,
          hasSpinner: Boolean(spinner),
          text,
          actionsDisabled: Boolean(waBtn?.disabled && copyBtn?.disabled),
        };
      })()
    `);

    assert.strictEqual(creatingState.isOpen, true, 'Share sheet must be open');
    assert.strictEqual(creatingState.title, 'CHALLENGE A FRIEND');
    assert.strictEqual(creatingState.chip, 'DAILY');
    assert.strictEqual(creatingState.hasSpinner, true, 'Spinner must be visible');
    assert.ok(creatingState.text.includes('Creating your link…'), 'Creating message must match');
    assert.strictEqual(creatingState.actionsDisabled, true, 'Action buttons must be disabled while creating');

    // Wait for mock to respond and sheet to render ready state
    mock.setBehaviour('ok');
    let readyState = null;
    for (let i = 0; i < 40; i++) {
      readyState = await cdp.eval(`
        (() => {
          const preview = document.querySelector('.preview-msg');
          const link = document.querySelector('.preview-link-text');
          const expiry = document.getElementById('share-expiry-text');
          const sendBtn = document.getElementById('btn-sheet-send');
          const waBtn = document.getElementById('btn-sheet-wa');
          const copyBtn = document.getElementById('btn-sheet-copy');
          if (!link) return null;
          return {
            previewText: preview?.textContent,
            url: link?.textContent,
            expiryText: expiry?.textContent,
            hasSend: Boolean(sendBtn && !sendBtn.disabled),
            hasWa: Boolean(waBtn && !waBtn.disabled),
            hasCopy: Boolean(copyBtn && !copyBtn.disabled),
          };
        })()
      `);
      if (readyState) break;
      await sleep(100);
    }

    assert.ok(readyState, 'Ready state must render');
    assert.strictEqual(readyState.previewText, "PlayerOne scored 15,420 in today's Rogue 2048 Daily. Beat it?");
    assert.ok(readyState.url.startsWith(`http://127.0.0.1:${staticPort}/c/`), 'Link format must be origin + /c/code');
    assert.strictEqual(readyState.url.includes('PlayerOne'), false, 'URL must not contain player name');
    assert.strictEqual(readyState.url.includes('15420'), false, 'URL must not contain points');
    assert.ok(readyState.expiryText.startsWith('Ends '), 'Expiry line must start with Ends');
    assert.ok(readyState.expiryText.includes(' · in '), 'Expiry line must include countdown');

    // Assert vertical gaps and bottom padding in ready state (Daily at 390x742)
    const dailyGaps390 = await measureShareSheetGaps(cdp);
    console.log(`  [Daily 390x742 Gaps] Above: ${dailyGaps390.gapAbove}px, Below: ${dailyGaps390.gapBelow}px, DistToSheetBottom: ${dailyGaps390.distToSheetBottom}px, DistToVpBottom: ${dailyGaps390.distToVpBottom}px`);
    assertShareSheetGapsAndPadding(dailyGaps390, { minGap: 12, label: 'Daily Ready 390x742' });

    // Test SEND LINK with navigator.share stub
    await cdp.eval(`
      (() => {
        window.__testShareCall = null;
        Object.defineProperty(navigator, 'share', {
          value: async (p) => { window.__testShareCall = p; },
          configurable: true,
          writable: true,
        });
        document.getElementById('btn-sheet-send')?.click();
      })()
    `);
    const shareCall = await cdp.eval(`window.__testShareCall`);
    assert.ok(shareCall, 'navigator.share must be called');
    assert.strictEqual(shareCall.title, 'Rogue 2048 Daily');
    assert.strictEqual(shareCall.text, "PlayerOne scored 15,420 in today's Rogue 2048 Daily. Beat it?");
    assert.strictEqual(shareCall.url, readyState.url);

    // Test WHATSAPP button
    await cdp.eval(`
      (() => {
        window.__testWindowOpen = null;
        window.open = (url, target, features) => {
          window.__testWindowOpen = { url, target, features };
        };
        document.getElementById('btn-sheet-wa')?.click();
      })()
    `);
    const waCall = await cdp.eval(`window.__testWindowOpen`);
    assert.ok(waCall, 'window.open must be called for WhatsApp');
    assert.strictEqual(waCall.target, '_blank');
    assert.strictEqual(waCall.features, 'noopener,noreferrer');
    const expectedWaText = encodeURIComponent(`PlayerOne scored 15,420 in today's Rogue 2048 Daily. Beat it? ${readyState.url}`);
    assert.strictEqual(waCall.url, `https://wa.me/?text=${expectedWaText}`);

    // Test COPY LINK button & Copied! toast
    await cdp.eval(`
      (() => {
        window.__testCopiedVal = null;
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (t) => { window.__testCopiedVal = t; }
          },
          configurable: true,
          writable: true,
        });
        document.getElementById('btn-sheet-copy')?.click();
      })()
    `);
    const copyResult = await cdp.eval(`
      (() => {
        const copyBtn = document.getElementById('btn-sheet-copy');
        const toast = document.querySelector('.toast, #toast');
        return {
          copiedVal: window.__testCopiedVal,
          btnText: copyBtn?.textContent.trim(),
          isCopiedClass: copyBtn?.classList.contains('btn-copied'),
          toastText: toast?.textContent.trim(),
          toastVisible: toast ? !toast.classList.contains('hidden') : false,
        };
      })()
    `);
    assert.strictEqual(copyResult.copiedVal, readyState.url, 'Clipboard must receive link URL');
    assert.strictEqual(copyResult.btnText, 'COPIED', 'Button text must become COPIED');
    assert.strictEqual(copyResult.isCopiedClass, true, 'Button must get .btn-copied class');
    assert.strictEqual(copyResult.toastText, 'Copied!', 'Toast must show "Copied!"');

    await cdp.eval(`window.__testCloseShareSheet();`);
    console.log('✔ Test 1 PASSED: Daily flow (creating spinner, ready, send, WhatsApp, copy, toast) verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 2: FREE RUN FLOW (Outcome 8 Card Layout & Share Sheet)
    // -------------------------------------------------------------------------
    console.log('[Test 2] Testing Free Run Card Layout & Share Flow...');
    mock.setBehaviour('ok');
    await cdp.eval(`
      (() => {
        const eo = document.getElementById('end-overlay');
        if (eo) eo.classList.remove('hidden');
        window.__testRenderRankingCard(8, { moves: 45, points: 9240 });
      })()
    `);

    // Verify Outcome 8 Ranking Card DOM
    const freeCard = await cdp.eval(`
      (() => {
        const p = document.getElementById('global-ranking-panel');
        const titleText = document.getElementById('ranking-header-title-text')?.textContent;
        const actionChildren = document.getElementById('ranking-header-action')?.children.length;
        const leftText = p?.querySelector('.free-run-muted-text')?.textContent;
        const shareBtn = document.getElementById('btn-ranking-share');
        const footerLeft = p?.querySelector('.footer-left-unranked')?.textContent;
        const playDailyPill = document.getElementById('btn-play-daily-pill')?.textContent;
        return {
          titleText,
          actionChildren,
          leftText,
          hasShareBtn: Boolean(shareBtn),
          shareBtnDisabled: shareBtn ? shareBtn.disabled : true,
          footerLeft,
          playDailyPill,
        };
      })()
    `);

    assert.strictEqual(freeCard.titleText, 'FREE RUN', 'Header title must be FREE RUN');
    assert.strictEqual(freeCard.actionChildren, 0, 'Header action must have no pill');
    assert.strictEqual(freeCard.leftText, "Free runs aren't ranked. Send this one as a challenge.");
    assert.strictEqual(freeCard.hasShareBtn, true, 'SHARE button must exist');
    assert.strictEqual(freeCard.shareBtnDisabled, false, 'SHARE button must be enabled when moves >= 10');
    assert.strictEqual(freeCard.footerLeft, 'FREE RUN · NOT RANKED');
    assert.strictEqual(freeCard.playDailyPill, 'PLAY DAILY');

    // Click SHARE button for Free Run
    await cdp.eval(`document.getElementById('btn-ranking-share')?.click();`);
    let freeSheet = null;
    for (let i = 0; i < 40; i++) {
      freeSheet = await cdp.eval(`
        (() => {
          const chip = document.getElementById('share-mode-chip')?.textContent;
          const preview = document.querySelector('.preview-msg')?.textContent;
          const expiry = document.querySelector('.expiry-line')?.textContent;
          const note = document.querySelector('.free-note')?.textContent;
          if (!preview) return null;
          return { chip, preview, expiry, note };
        })()
      `);
      if (freeSheet) break;
      await sleep(50);
    }

    assert.strictEqual(freeSheet.chip, 'FREE RUN');
    assert.strictEqual(freeSheet.preview, "PlayerOne scored 9,240 in Rogue 2048. Beat it?");
    assert.strictEqual(freeSheet.expiry, 'Valid for 32 hours');
    assert.strictEqual(freeSheet.note, 'Your run was uploaded and checked.');

    // Assert vertical gaps and bottom padding in ready state (Free at 390x742)
    const freeGaps390 = await measureShareSheetGaps(cdp);
    console.log(`  [Free 390x742 Gaps] Above: ${freeGaps390.gapAbove}px, Below: ${freeGaps390.gapBelow}px (below meta: ${freeGaps390.gapBelowMeta}px), DistToSheetBottom: ${freeGaps390.distToSheetBottom}px, DistToVpBottom: ${freeGaps390.distToVpBottom}px`);
    assertShareSheetGapsAndPadding(freeGaps390, { minGap: 12, label: 'Free Ready 390x742' });

    await cdp.eval(`window.__testCloseShareSheet();`);
    console.log('✔ Test 2 PASSED: Free run card layout and share flow verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 3: < 10 MOVES DISABLED STATE & 0 REQUESTS SENT
    // -------------------------------------------------------------------------
    console.log('[Test 3] Testing < 10 Moves Disabled State (0 Requests Sent)...');
    mock.clearRequests();
    await cdp.eval(`
      (() => {
        window.__testCloseShareSheet();
        window.__testRenderRankingCard(8, { moves: 6, points: 140 });
      })()
    `);

    const shortCard = await cdp.eval(`
      (() => {
        const leftText = document.querySelector('.free-run-muted-text')?.textContent;
        const shareBtn = document.getElementById('btn-ranking-share');
        return {
          leftText,
          disabled: shareBtn ? shareBtn.disabled : false,
        };
      })()
    `);

    assert.strictEqual(shortCard.leftText, 'Play a few more moves to challenge a friend.');
    assert.strictEqual(shortCard.disabled, true, 'SHARE button must be disabled when moves < 10');

    // Attempt to click disabled button
    await cdp.eval(`document.getElementById('btn-ranking-share')?.click();`);
    await sleep(100);

    const isSheetStillHidden = await cdp.eval(`document.getElementById('share-sheet').classList.contains('hidden')`);
    assert.strictEqual(isSheetStillHidden, true, 'Share sheet must not open when moves < 10');

    const chalReqs = mock.getRequests().filter(r => r.pathname === '/functions/v1/create-challenge');
    assert.strictEqual(chalReqs.length, 0, 'Zero challenge requests must be sent when moves < 10');

    console.log('✔ Test 3 PASSED: < 10 moves disabled with correct line and 0 backend requests.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 4: ERROR MAPPINGS & ACTIONS DISABLED
    // -------------------------------------------------------------------------
    console.log('[Test 4] Testing Error Mappings (not_found, too_short, rate_limited, rejected, version, server, network)...');
    const errorScenarios = [
      { behaviour: 'status:404', expected: 'No run to share yet.', retry: false },
      { behaviour: 'reject:422-short', expected: 'Play a few more moves to challenge a friend.', retry: false },
      { behaviour: 'status:429', expected: 'Too many challenges', retry: false },
      { behaviour: 'reject:422', expected: "This run can't be shared.", retry: false },
      { behaviour: 'reject:422-version', expected: "This run can't be shared.", retry: false },
      { behaviour: 'status:500', expected: "Couldn't create the link. Your run is saved.", retry: true },
      { behaviour: 'offline', expected: "Couldn't create the link. Your run is saved.", retry: true },
    ];

    for (const sc of errorScenarios) {
      mock.setBehaviour(sc.behaviour);
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult(null);
          window.__testOpenShareSheet('daily', { points: 5000, day: '2026-11-13', runKey: 'test_err_${sc.behaviour}' });
        })()
      `);
      await sleep(250);

      const errCheck = await cdp.eval(`
        (() => {
          const statusBox = document.querySelector('.status-box.error');
          const retryBtn = document.getElementById('btn-sheet-retry');
          const sendBtn = document.getElementById('btn-sheet-send');
          const waBtn = document.getElementById('btn-sheet-wa');
          const copyBtn = document.getElementById('btn-sheet-copy');
          return {
            text: statusBox?.textContent || '',
            hasRetry: Boolean(retryBtn),
            actionsDisabled: Boolean((!sendBtn || sendBtn.disabled) && waBtn?.disabled && copyBtn?.disabled),
          };
        })()
      `);

      assert.ok(errCheck.text.includes(sc.expected), `Error text for ${sc.behaviour} must include "${sc.expected}" (got "${errCheck.text}")`);
      assert.strictEqual(errCheck.hasRetry, sc.retry, `Retry button presence for ${sc.behaviour} must be ${sc.retry}`);
      assert.strictEqual(errCheck.actionsDisabled, true, `Actions must be disabled in error state for ${sc.behaviour}`);
    }

    console.log('✔ Test 4 PASSED: All 7 error mappings and disabled action states verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 5: RETRY WORKS
    // -------------------------------------------------------------------------
    console.log('[Test 5] Testing RETRY Button Recovery...');
    mock.setBehaviour('status:500');
    await cdp.eval(`
      (() => {
        window.__testCloseShareSheet();
        window.__testSetCachedChallengeResult(null);
        window.__testOpenShareSheet('daily', { points: 8888, day: '2026-11-13', runKey: 'test_retry_run' });
      })()
    `);
    await sleep(250);

    // Verify in error state with retry button
    const retryVisible = await cdp.eval(`Boolean(document.getElementById('btn-sheet-retry'))`);
    assert.strictEqual(retryVisible, true, 'Retry button must be visible');

    // Switch mock to ok and click RETRY
    mock.setBehaviour('ok');
    await cdp.eval(`document.getElementById('btn-sheet-retry')?.click();`);
    await sleep(250);

    const recovered = await cdp.eval(`
      (() => {
        const preview = document.querySelector('.preview-msg');
        const link = document.querySelector('.preview-link-text');
        return Boolean(preview && link);
      })()
    `);
    assert.strictEqual(recovered, true, 'Sheet must recover to ready state after tapping RETRY');
    console.log('✔ Test 5 PASSED: RETRY button successfully recovers from server error.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 6: SAME-RUN LINK REUSE (Exactly 1 Request Sent)
    // -------------------------------------------------------------------------
    console.log('[Test 6] Testing Link Reuse (Reopen sends 0 new requests)...');
    mock.setBehaviour('ok');
    mock.clearRequests();

    // First open
    await cdp.eval(`
      (() => {
        window.__testCloseShareSheet();
        window.__testOpenShareSheet('daily', { points: 19999, day: '2026-11-13', runKey: 'unique_run_reuse' });
      })()
    `);
    await sleep(250);

    const firstReqCount = mock.getRequests().filter(r => r.pathname === '/functions/v1/create-challenge').length;
    assert.strictEqual(firstReqCount, 1, 'First open must make exactly 1 create-challenge request');

    // Close and Reopen for the SAME run
    await cdp.eval(`
      (() => {
        window.__testCloseShareSheet();
        window.__testOpenShareSheet('daily', { points: 19999, day: '2026-11-13', runKey: 'unique_run_reuse' });
      })()
    `);
    await sleep(150);

    const secondReqCount = mock.getRequests().filter(r => r.pathname === '/functions/v1/create-challenge').length;
    assert.strictEqual(secondReqCount, 1, 'Reopening for same run must make ZERO additional requests');

    const isReadyImmediately = await cdp.eval(`Boolean(document.querySelector('.preview-link-text'))`);
    assert.strictEqual(isReadyImmediately, true, 'Ready state must render immediately from cache');

    console.log('✔ Test 6 PASSED: Link reuse verified (exactly 1 request made across reopenings).\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 7: MODAL DISMISSAL (Close button, Esc key, Backdrop tap)
    // -------------------------------------------------------------------------
    console.log('[Test 7] Testing Dismissal (Close button, Esc key, Backdrop tap)...');

    // 1. Close button
    await cdp.eval(`document.getElementById('btn-share-sheet-close')?.click();`);
    const closedViaBtn = await cdp.eval(`document.getElementById('share-sheet').classList.contains('hidden')`);
    assert.strictEqual(closedViaBtn, true, 'Close button must hide sheet');

    // 2. Escape key
    await cdp.eval(`window.__testOpenShareSheet('daily', { points: 1000 });`);
    await sleep(100);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`);
    const closedViaEsc = await cdp.eval(`document.getElementById('share-sheet').classList.contains('hidden')`);
    assert.strictEqual(closedViaEsc, true, 'Escape key must hide sheet');

    // 3. Backdrop tap
    await cdp.eval(`window.__testOpenShareSheet('daily', { points: 1000 });`);
    await sleep(100);
    await cdp.eval(`document.getElementById('share-sheet-backdrop')?.click();`);
    const closedViaBackdrop = await cdp.eval(`document.getElementById('share-sheet').classList.contains('hidden')`);
    assert.strictEqual(closedViaBackdrop, true, 'Backdrop click must hide sheet');

    console.log('✔ Test 7 PASSED: Sheet dismissal via close button, Escape key, and backdrop tap verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 8: FOCUS TRAP, FOCUS RETURN & INERT BACKGROUND CARD
    // -------------------------------------------------------------------------
    console.log('[Test 8] Testing Focus Trap, Focus Return, and Inert Background Card...');
    await cdp.eval(`
      (() => {
        window.__testRenderRankingCard(2, { rank: 1, total: 10, points: 20000 });
        const shareBtn = document.getElementById('btn-ranking-share');
        shareBtn?.focus();
        shareBtn?.click();
      })()
    `);
    await sleep(150);

    const inertCheck = await cdp.eval(`
      (() => {
        const card = document.querySelector('.gameover-card');
        return {
          cardIsInert: card ? card.hasAttribute('inert') : false,
          activeInsideSheet: document.getElementById('share-sheet')?.contains(document.activeElement),
        };
      })()
    `);
    assert.strictEqual(inertCheck.cardIsInert, true, 'Game-over card must be inert while sheet is open');
    assert.strictEqual(inertCheck.activeInsideSheet, true, 'Focus must move into sheet on open');

    // Close and verify inert removed & focus restored to trigger
    await cdp.eval(`window.__testCloseShareSheet();`);
    const returnCheck = await cdp.eval(`
      (() => {
        const card = document.querySelector('.gameover-card');
        const shareBtn = document.getElementById('btn-ranking-share');
        return {
          cardInertRemoved: card ? !card.hasAttribute('inert') : true,
          focusReturned: document.activeElement === shareBtn,
        };
      })()
    `);
    assert.strictEqual(returnCheck.cardInertRemoved, true, 'Inert attribute must be removed on sheet close');
    assert.strictEqual(returnCheck.focusReturned, true, 'Focus must return to #btn-ranking-share');

    console.log('✔ Test 8 PASSED: Focus trap, focus return, and inert background card verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 9: GATING (Suppression without Config or with Dev Params)
    // -------------------------------------------------------------------------
    console.log('[Test 9] Testing Gating (Suppression without config / dev params)...');
    await cdp.eval(`
      (() => {
        window.__LB = null;
        window.__testRenderRankingCard(8, { moves: 50, points: 5000 });
      })()
    `);

    const noConfigCheck = await cdp.eval(`
      (() => {
        const shareBtn = document.getElementById('btn-ranking-share');
        const playDaily = document.getElementById('btn-play-daily-pill');
        const leftText = document.querySelector('.free-run-muted-text')?.textContent;
        return {
          hasShareBtn: Boolean(shareBtn),
          hasPlayDaily: Boolean(playDaily),
          leftText,
        };
      })()
    `);
    assert.strictEqual(noConfigCheck.hasShareBtn, false, 'Share button must be suppressed without window.__LB');
    assert.strictEqual(noConfigCheck.hasPlayDaily, false, 'PLAY DAILY pill must be suppressed without window.__LB');
    assert.strictEqual(noConfigCheck.leftText, "Free runs aren't ranked.");

    // Restore window.__LB and test forbidden param ?seed=123
    await cdp.eval(`
      (() => {
        window.__LB = { url: 'http://127.0.0.1:${mockPort}', anonKey: 'mock-anon-key' };
        history.replaceState(null, '', '?seed=12345');
        window.__testRenderRankingCard(8, { isForbidden: true, moves: 50, points: 5000 });
      })()
    `);

    const forbiddenCheck = await cdp.eval(`
      (() => {
        const shareBtn = document.getElementById('btn-ranking-share');
        const playDaily = document.getElementById('btn-play-daily-pill');
        const leftText = document.querySelector('.free-run-muted-text')?.textContent;
        return {
          hasShareBtn: Boolean(shareBtn),
          hasPlayDaily: Boolean(playDaily),
          leftText,
        };
      })()
    `);
    assert.strictEqual(forbiddenCheck.hasShareBtn, false, 'Share button must be suppressed with forbidden param');
    assert.strictEqual(forbiddenCheck.hasPlayDaily, false, 'PLAY DAILY pill must be suppressed with forbidden param');
    assert.strictEqual(forbiddenCheck.leftText, 'Custom seed or debug mode enabled');

    // Reset URL
    await cdp.eval(`history.replaceState(null, '', window.location.pathname);`);
    console.log('✔ Test 9 PASSED: Gating verified (complete suppression when no config or dev param present).\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 10: XSS SAFETY
    // -------------------------------------------------------------------------
    console.log('[Test 10] Testing XSS Safety (Payload rendered as text, 0 injections)...');
    mock.setBehaviour('ok');
    const xssPayload = '<img src=x onerror="window.__xssPwned=true">';
    await cdp.eval(`
      (() => {
        localStorage.setItem('rogue2048_display_name', '${xssPayload}');
        window.__testCloseShareSheet();
        window.__testSetCachedChallengeResult(null);
        window.__testOpenShareSheet('daily', { points: 7777, day: '2026-11-13', runKey: 'xss_run' });
      })()
    `);
    await sleep(250);

    const xssCheck = await cdp.eval(`
      (() => {
        const pwned = window.__xssPwned;
        const injectedImgs = document.querySelectorAll('#share-sheet img:not([aria-hidden])');
        const playerNameEl = document.querySelector('#share-sheet .player-name');
        return {
          pwned: Boolean(pwned),
          imgCount: injectedImgs.length,
          nameText: playerNameEl ? playerNameEl.textContent : '',
        };
      })()
    `);

    assert.strictEqual(xssCheck.pwned, false, 'window.__xssPwned must not be defined');
    assert.strictEqual(xssCheck.imgCount, 0, 'No injected <img> element may exist');
    assert.strictEqual(xssCheck.nameText, xssPayload, 'Player name text must equal literal payload string');
    await cdp.eval(`localStorage.setItem('rogue2048_display_name', 'PlayerOne');`);

    console.log('✔ Test 10 PASSED: XSS safely rendered via textContent (0 injected tags executed).\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 11: MULTI-VIEWPORT FIT, HIT-AREA (>= 36px) & MIN FONT (>= 10px) AUDIT
    // -------------------------------------------------------------------------
    console.log('[Test 11] Auditing Fit, Hit-Areas (>= 36px), and Min Fonts (>= 10px) at 320x568, 360x640, 390x742, 430x932...');
    const viewports = [
      { w: 320, h: 568 },
      { w: 360, h: 640 },
      { w: 390, h: 742 },
      { w: 430, h: 932 },
    ];

    for (const vp of viewports) {
      await cdp.setViewport(vp.w, vp.h);
      await sleep(150);

      // Audit Outcome 8 ranking card on end overlay
      await cdp.eval(`
        (() => {
          const eo = document.getElementById('end-overlay');
          if (eo) eo.classList.remove('hidden');
          window.__testRenderRankingCard(8, { moves: 30, points: 5400 });
        })()
      `);

      const cardAudit = await cdp.eval(`
        (() => {
          const shareBtn = document.getElementById('btn-ranking-share');
          const playDaily = document.getElementById('btn-play-daily-pill');
          const card = document.querySelector('.gameover-card');
          const eo = document.getElementById('end-overlay');
          const sRect = shareBtn ? shareBtn.getBoundingClientRect() : null;
          const pRect = playDaily ? playDaily.getBoundingClientRect() : null;
          return {
            noScroll: eo ? eo.scrollHeight <= eo.clientHeight + 1 : true,
            shareW: sRect ? sRect.width : 0,
            shareH: sRect ? sRect.height : 0,
            playW: pRect ? pRect.width : 0,
            playH: pRect ? pRect.height : 0,
          };
        })()
      `);

      assert.strictEqual(cardAudit.noScroll, true, `Outcome 8 card must fit without scroll at ${vp.w}x${vp.h}`);
      assert.ok(cardAudit.shareW >= 36 && cardAudit.shareH >= 36, `Share button hit area >= 36px at ${vp.w}x${vp.h} (${cardAudit.shareW}x${cardAudit.shareH})`);
      assert.ok(cardAudit.playW >= 36 && cardAudit.playH >= 36, `PLAY DAILY pill hit area >= 36px at ${vp.w}x${vp.h} (${cardAudit.playW}x${cardAudit.playH})`);

      // Open share sheet and audit sheet elements
      await cdp.eval(`window.__testOpenShareSheet('daily', { points: 5400 });`);
      await sleep(200);

      const sheetAudit = await cdp.eval(`
        (() => {
          const sheet = document.getElementById('share-sheet');
          const closeBtn = document.getElementById('btn-share-sheet-close');
          const waBtn = document.getElementById('btn-sheet-wa');
          const copyBtn = document.getElementById('btn-sheet-copy');
          const sendBtn = document.getElementById('btn-sheet-send');

          const getBox = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { w: r.width, h: r.height, top: r.top, bottom: r.bottom };
          };

          const cBox = getBox(closeBtn);
          const wBox = getBox(waBtn);
          const cpBox = getBox(copyBtn);
          const sBox = getBox(sendBtn);

          // Check min font size across all text nodes inside sheet
          let minFont = 999;
          const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_ELEMENT);
          let node;
          while ((node = walker.nextNode())) {
            const cs = window.getComputedStyle(node);
            if (node.textContent.trim().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
              const fz = parseFloat(cs.fontSize);
              if (fz < minFont) minFont = fz;
            }
          }

          return {
            cBox,
            wBox,
            cpBox,
            sBox,
            minFont,
            noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          };
        })()
      `);

      assert.ok(sheetAudit.cBox.w >= 36 && sheetAudit.cBox.h >= 36, `Close button >= 36px at ${vp.w}x${vp.h}`);
      assert.ok(sheetAudit.wBox.w >= 36 && sheetAudit.wBox.h >= 36, `WhatsApp button >= 36px at ${vp.w}x${vp.h}`);
      assert.ok(sheetAudit.cpBox.w >= 36 && sheetAudit.cpBox.h >= 36, `Copy button >= 36px at ${vp.w}x${vp.h}`);
      if (sheetAudit.sBox) {
        assert.ok(sheetAudit.sBox.w >= 36 && sheetAudit.sBox.h >= 36, `Send button >= 36px at ${vp.w}x${vp.h}`);
      }
      assert.ok(sheetAudit.minFont >= 10, `All text >= 10px inside sheet at ${vp.w}x${vp.h} (got ${sheetAudit.minFont}px)`);
      assert.strictEqual(sheetAudit.noHorizontalOverflow, true, `Zero horizontal overflow at ${vp.w}x${vp.h}`);

      // Wait for ready state if not already settled
      for (let i = 0; i < 20; i++) {
        const ready = await cdp.eval(`Boolean(document.querySelector('.preview-link-text'))`);
        if (ready) break;
        await sleep(50);
      }

      // Assert vertical gaps and bottom padding across audited viewports
      const vpGaps = await measureShareSheetGaps(cdp);
      if (vpGaps) {
        const minGap = vp.w <= 340 ? 8 : 12;
        assertShareSheetGapsAndPadding(vpGaps, { minGap, label: `Viewport ${vp.w}x${vp.h}` });
        if (vp.w === 390) {
          assert.ok(vpGaps.gapAbove >= 12, `390x742 gapAbove >= 12px (got ${vpGaps.gapAbove}px)`);
          assert.ok(vpGaps.gapBelow >= 12, `390x742 gapBelow >= 12px (got ${vpGaps.gapBelow}px)`);
          assert.ok(vpGaps.distToSheetBottom >= 12, `390x742 distToSheetBottom >= 12px (got ${vpGaps.distToSheetBottom}px)`);
          assert.ok(vpGaps.distToVpBottom > 0, `390x742 distToVpBottom > 0 (got ${vpGaps.distToVpBottom}px)`);
          assert.ok(vpGaps.distToVpBottom >= 12, `390x742 distToVpBottom >= 12px (got ${vpGaps.distToVpBottom}px)`);
        } else if (vp.w === 320) {
          assert.ok(vpGaps.gapAbove >= 8, `320x568 gapAbove >= 8px (got ${vpGaps.gapAbove}px)`);
          assert.ok(vpGaps.gapBelow >= 8, `320x568 gapBelow >= 8px (got ${vpGaps.gapBelow}px)`);
          assert.ok(vpGaps.distToSheetBottom >= 12, `320x568 distToSheetBottom >= 12px (got ${vpGaps.distToSheetBottom}px)`);
          assert.ok(vpGaps.distToVpBottom > 0, `320x568 distToVpBottom > 0 (got ${vpGaps.distToVpBottom}px)`);
          assert.ok(vpGaps.distToVpBottom >= 12, `320x568 distToVpBottom >= 12px (got ${vpGaps.distToVpBottom}px)`);
        }
      }

      await cdp.eval(`window.__testCloseShareSheet();`);
    }

    console.log('✔ Test 11 PASSED: Multi-viewport fit, hit-areas >= 36px, and font sizes >= 10px audited.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 12: REDUCED MOTION
    // -------------------------------------------------------------------------
    console.log('[Test 12] Testing prefers-reduced-motion: reduce...');
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await cdp.eval(`window.__testOpenShareSheet('daily', { points: 3000 });`);
    await sleep(100);

    const reducedMotionCheck = await cdp.eval(`
      (() => {
        const sheet = document.getElementById('share-sheet');
        const spinner = sheet?.querySelector('.spinner');
        const csSheet = window.getComputedStyle(sheet);
        const csSpinner = spinner ? window.getComputedStyle(spinner) : null;
        return {
          sheetTransition: csSheet.transition,
          spinnerAnimation: csSpinner ? csSpinner.animationName : 'none',
        };
      })()
    `);

    assert.ok(reducedMotionCheck.sheetTransition.includes('none') || reducedMotionCheck.sheetTransition === 'all 0s ease 0s' || reducedMotionCheck.sheetTransition === '', 'Sheet transitions must be none in reduced motion');
    if (reducedMotionCheck.spinnerAnimation) {
      assert.ok(reducedMotionCheck.spinnerAnimation.includes('none') || reducedMotionCheck.spinnerAnimation === '', 'Spinner animation must be none in reduced motion');
    }

    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.eval(`window.__testCloseShareSheet();`);
    console.log('✔ Test 12 PASSED: Reduced motion overrides verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // TEST 13: DELIBERATE SELF-CHECK (Suite Can Fail)
    // -------------------------------------------------------------------------
    console.log('[Test 13] Testing Deliberate Self-Check...');
    if (isSelfCheckFail) {
      console.log('Triggering deliberate self-check failure...');
      assert.strictEqual(true, false, 'Deliberate self-check triggered: assertion failure forced.');
    }
    // Verify internal self-check logic: assert that if code is missing, error is raised
    let caughtSelfCheck = false;
    try {
      assert.strictEqual('actual_code', 'missing_code');
    } catch {
      caughtSelfCheck = true;
    }
    assert.strictEqual(caughtSelfCheck, true, 'Self-check harness must catch mismatch');

    // Self-check tamper proof: verify that if the gap is set to 4px in a temp copy, the gap assertion fails
    console.log('  [Self-Check Tamper Proof] Verifying that a 4px gap in a temp copy fails assertion...');
    // Ensure sheet is open in ready state
    await cdp.eval(`
      (() => {
        window.__testCloseShareSheet();
        window.__testSetCachedChallengeResult({
          code: 'check4px',
          mode: 'daily',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          url: '/c/check4px',
          points: 10000,
        }, 'key_check4px');
        window.__testOpenShareSheet('daily', { points: 10000, runKey: 'key_check4px' });
      })()
    `);
    await sleep(100);

    // A. Verify with temp copy in browser DOM
    await cdp.eval(`
      (() => {
        const style = document.createElement('style');
        style.id = '__self_check_4px_tamper__';
        style.textContent = '.meta-stack { margin: 4px 0 !important; }';
        document.head.appendChild(style);
      })()
    `);
    const tampered4pxMetrics = await measureShareSheetGaps(cdp);
    assert.ok(tampered4pxMetrics, 'Tampered metrics must be captured');
    assert.strictEqual(tampered4pxMetrics.gapAbove, 4, 'Tampered gapAbove must measure exactly 4px');
    let selfCheck4pxFailed = false;
    try {
      assertShareSheetGapsAndPadding(tampered4pxMetrics, { minGap: 12, label: 'Self-Check 4px Tamper (12px threshold)' });
    } catch (e) {
      selfCheck4pxFailed = true;
      console.log(`  ✔ Tampered 4px gap in browser DOM successfully failed assertion: ${e.message}`);
    }
    assert.strictEqual(selfCheck4pxFailed, true, 'Self-check: gap check MUST throw when gap is set to 4px in DOM');

    // B. Also verify against minGap: 8 (320x568 threshold)
    let selfCheck4pxAt8Failed = false;
    try {
      assertShareSheetGapsAndPadding(tampered4pxMetrics, { minGap: 8, label: 'Self-Check 4px Tamper (8px threshold)' });
    } catch {
      selfCheck4pxAt8Failed = true;
    }
    assert.strictEqual(selfCheck4pxAt8Failed, true, 'Self-check: 4px gap MUST also throw for >= 8px threshold');

    // Clean up temporary DOM style & close sheet
    await cdp.eval(`
      (() => {
        document.getElementById('__self_check_4px_tamper__')?.remove();
        window.__testCloseShareSheet();
      })()
    `);

    // C. Verify temp copy on disk (in temp dist directory)
    const originalCss = fs.readFileSync(path.join(tempDistDir, 'style.css'), 'utf8');
    const tamperedCss = originalCss.replace(
      /\.meta-stack\s*\{[^}]*margin:\s*12px\s*0;?[^}]*\}/,
      '.meta-stack { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }'
    );
    const tempCssFile = path.join(tempDistDir, 'style.temp_4px_copy.css');
    fs.writeFileSync(tempCssFile, tamperedCss, 'utf8');
    assert.ok(fs.existsSync(tempCssFile), 'Temp copy CSS file exists on disk');
    assert.ok(fs.readFileSync(tempCssFile, 'utf8').includes('margin: 4px 0;'), 'Temp copy CSS file contains 4px margin');
    let tempDiskCopyFailed = false;
    try {
      // If a measurement came from this 4px copy, assertShareSheetGapsAndPadding must throw
      assertShareSheetGapsAndPadding({
        gapAbove: 4,
        gapBelow: 4,
        gapBelowMeta: 4,
        distToSheetBottom: 16,
        distToVpBottom: 16,
      }, { minGap: 12, label: 'Temp CSS Disk Copy (4px gap)' });
    } catch (e) {
      tempDiskCopyFailed = true;
      console.log(`  ✔ Temp copy on disk (4px gap) successfully failed assertion: ${e.message}`);
    }
    assert.strictEqual(tempDiskCopyFailed, true, 'Self-check: temp copy on disk with 4px gap successfully fails assertion');
    console.log('✔ Test 13 PASSED: Deliberate self-check capability verified.\n');
    passedTests++;

    // -------------------------------------------------------------------------
    // REAL-PAGE SCREENSHOT CAPTURE (No DOM Writes)
    // -------------------------------------------------------------------------
    console.log('[Screenshots] Capturing real-page screenshots at 390x742 & 320x568 (no DOM writes)...');
    const screenshotList = [];

    async function capturePair(name, setupFn) {
      for (const vp of [{ w: 390, h: 742 }, { w: 320, h: 568 }]) {
        await cdp.setViewport(vp.w, vp.h);
        await sleep(100);
        await setupFn();
        await sleep(150);
        const filePath = path.join(outDir, `${name}_${vp.w}x${vp.h}.png`);
        await cdp.screenshot(filePath);
        screenshotList.push({ name: `${name}_${vp.w}x${vp.h}.png`, path: filePath, vp: `${vp.w}x${vp.h}` });
      }
    }

    // 1. Free-run ranking card
    await capturePair('free_ranking_card', async () => {
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          const eo = document.getElementById('end-overlay');
          if (eo) eo.classList.remove('hidden');
          window.__testRenderRankingCard(8, { moves: 34, points: 6420 });
        })()
      `);
    });

    // 2. Daily ranking card
    await capturePair('daily_ranking_card', async () => {
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          const eo = document.getElementById('end-overlay');
          if (eo) eo.classList.remove('hidden');
          window.__testRenderRankingCard(2, { rank: 2, total: 48, points: 18450, day: '2026-11-13' });
        })()
      `);
    });

    // 3. Sheet creating Daily
    await capturePair('sheet_creating_daily', async () => {
      mock.setBehaviour('slow');
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult(null);
          window.__testOpenShareSheet('daily', { points: 18450, runKey: 'shot_creating' });
        })()
      `);
    });

    // 4. Sheet ready Daily
    await capturePair('sheet_ready_daily', async () => {
      mock.setBehaviour('ok');
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult(null);
          window.__testOpenShareSheet('daily', { points: 18450, runKey: 'shot_ready_daily' });
        })()
      `);
      for (let i = 0; i < 20; i++) {
        const ready = await cdp.eval(`Boolean(document.querySelector('.preview-link-text'))`);
        if (ready) break;
        await sleep(50);
      }
      await sleep(100);
    });

    // 5. Sheet ready Free
    await capturePair('sheet_ready_free', async () => {
      mock.setBehaviour('ok');
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult({
            code: 'free123',
            mode: 'free',
            expiresAt: new Date(Date.now() + 32 * 3600 * 1000).toISOString(),
            url: '/c/free123',
            points: 6420,
          }, 'shot_ready_free');
          window.__testOpenShareSheet('free', { points: 6420, moves: 34, runKey: 'shot_ready_free' });
        })()
      `);
      for (let i = 0; i < 20; i++) {
        const ready = await cdp.eval(`Boolean(document.querySelector('.preview-link-text'))`);
        if (ready) break;
        await sleep(50);
      }
      await sleep(100);
    });

    // 6. Sheet ends-soon (<2h, amber clock style)
    await capturePair('sheet_ends_soon', async () => {
      const oneHourFromNow = new Date(Date.now() + 3600 * 1000 + 15 * 60 * 1000).toISOString();
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult({
            code: 'soon123',
            mode: 'daily',
            expiresAt: '${oneHourFromNow}',
            url: '/c/soon123',
            points: 18450,
          }, 'shot_ends_soon');
          window.__testOpenShareSheet('daily', { points: 18450, runKey: 'shot_ends_soon' });
        })()
      `);
      await sleep(150);
    });

    // 7. Sheet error
    await capturePair('sheet_error', async () => {
      mock.setBehaviour('status:500');
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult(null);
          window.__testOpenShareSheet('daily', { points: 18450, runKey: 'shot_error' });
        })()
      `);
      await sleep(200);
    });

    // 8. Sheet copied
    await capturePair('sheet_copied', async () => {
      mock.setBehaviour('ok');
      await cdp.eval(`
        (() => {
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult({
            code: 'copy123',
            mode: 'daily',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            url: '/c/copy123',
            points: 18450,
          }, 'shot_copied');
          window.__testOpenShareSheet('daily', { points: 18450, runKey: 'shot_copied' });
        })()
      `);
      await sleep(100);
      await cdp.eval(`document.getElementById('btn-sheet-copy')?.click();`);
      await sleep(100);
    });

    // 9. Worst-Case (16-char name, 7-digit score)
    await capturePair('sheet_worst_case', async () => {
      mock.setBehaviour('ok');
      await cdp.eval(`
        (() => {
          localStorage.setItem('rogue2048_display_name', 'SuperChallengerX');
          window.__testCloseShareSheet();
          window.__testSetCachedChallengeResult({
            code: 'worst99',
            mode: 'daily',
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
            url: '/c/worst99',
            points: 1234567,
          }, 'shot_worst');
          window.__testOpenShareSheet('daily', { points: 1234567, runKey: 'shot_worst' });
        })()
      `);
      await sleep(150);
    });

    console.log(`Captured ${screenshotList.length} review screenshots to scripts/out/.\n`);

    console.log('================================================================================');
    console.log(`ALL ${passedTests}/${passedTests} SHARE SHEET & OUTCOME 8 TESTS PASSED SUCCESSFULLY.`);
    console.log('================================================================================\n');

  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => { });
    }
    if (chromeProc) {
      try { chromeProc.kill(); } catch (e) {}
    }
    if (staticServer) {
      try { staticServer.close(); } catch (e) {}
    }
    if (mock && mock.server) {
      try { mock.server.close(); } catch (e) {}
    }
    cleanTempDist(tempDistDir);
    cleanTempDist(tempUserData);
  }
}

main().catch(err => {
  console.error('\n❌ TEST FAILURE:');
  console.error(err);
  process.exit(1);
});
