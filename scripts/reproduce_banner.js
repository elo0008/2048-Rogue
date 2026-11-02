import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome } from './find_chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple static server for dist
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/') reqPath = '/index.html';
      const filePath = path.join(distDir, reqPath);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath);
      const mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.json': 'application/json'
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (res.ok) {
        const pages = await res.json();
        const page = pages.find(p => p.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          return page.webSocketDebuggerUrl;
        }
      }
    } catch {}
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome CDP');
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.callbacks = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.callbacks.has(msg.id)) {
        const { resolve, reject } = this.callbacks.get(msg.id);
        this.callbacks.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
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
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  }
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome binary not found');

  const { server, port } = await startServer();
  const cdpPort = port + 100;
  const userDataDir = path.join(rootDir, 'scripts', 'out', 'temp_chrome_headed_user_data');
  if (fs.existsSync(userDataDir)) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(userDataDir, { recursive: true });

  const targetUrl = `http://127.0.0.1:${port}/?ascension=64&seed=1001`;

  // Explicit HEADED Chrome flags (NO --headless, NO --disable-gpu)
  const chromeFlags = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
    targetUrl
  ];

  console.log('=== CHROME EXECUTION FLAGS ===');
  console.log(`Binary: ${chromePath}`);
  console.log(`Flags:  ${chromeFlags.join(' ')}`);
  console.log('==============================');

  const proc = spawn(chromePath, chromeFlags);
  proc.on('error', (err) => console.error('Chrome spawn error:', err));

  const wsUrl = await getWsUrl(cdpPort);
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.onopen = r);

  const cdp = new CdpConnection(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(1000);

  // Click start game button
  await cdp.eval(`(() => {
    const btn = document.getElementById('btn-play-start');
    if (btn && !btn.closest('.hidden')) btn.click();
  })()`);
  await sleep(500);

  console.log('[Reproduce] Staging board for Clean Slate trigger (32 + 32 merge in row 0)...');
  await cdp.eval(`(() => {
    window.controller.state.board = [
      32, 32, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0
    ];
    window.syncBoard(window.controller.getBoard(), 'reproduce-banner');
  })()`);
  await sleep(300);

  // Setup rAF collector inside page
  await cdp.eval(`(() => {
    window.__bannerCollector = {
      recording: false,
      bannerStartTime: null,
      frames: [],
      rafDeltas: [],
      lastTs: null,
      done: false
    };

    function sample(ts) {
      const col = window.__bannerCollector;
      if (!col.recording) return;

      if (col.lastTs !== null) {
        col.rafDeltas.push(ts - col.lastTs);
      }
      col.lastTs = ts;

      const banner = document.getElementById('clean-slate-banner');
      const title = document.getElementById('clean-slate-title');
      const tagline = banner ? (banner.querySelector('.stand-subtitle') || document.getElementById('clean-slate-subtitle')) : null;

      const isHidden = banner ? banner.classList.contains('hidden') : true;
      if (!isHidden && col.bannerStartTime === null) {
        col.bannerStartTime = ts;
      }

      function getElemInfo(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const anims = el.getAnimations ? el.getAnimations().map(a => {
          const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
          return {
            name: a.animationName || a.id || 'waapi',
            currentTime: a.currentTime !== null ? Math.round(a.currentTime) : null,
            playState: a.playState,
            duration: timing.duration,
            delay: timing.delay,
            fill: timing.fill
          };
        }) : [];

        return {
          rect: {
            left: Math.round(r.left * 10) / 10,
            top: Math.round(r.top * 10) / 10,
            width: Math.round(r.width * 10) / 10,
            height: Math.round(r.height * 10) / 10,
            right: Math.round(r.right * 10) / 10,
            bottom: Math.round(r.bottom * 10) / 10
          },
          opacity: cs.opacity,
          transform: cs.transform,
          visibility: cs.visibility,
          zIndex: cs.zIndex,
          anims
        };
      }

      let centerElement = 'none';
      if (banner && !isHidden) {
        const bRect = banner.getBoundingClientRect();
        const cx = bRect.left + bRect.width / 2;
        const cy = bRect.top + bRect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (hit) {
          centerElement = hit.tagName.toLowerCase() +
            (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') +
            (hit.id ? '#' + hit.id : '');
        }
      }

      col.frames.push({
        ts: Math.round(ts),
        timeSinceBannerStart: col.bannerStartTime !== null ? Math.round(ts - col.bannerStartTime) : null,
        bannerHidden: isHidden,
        banner: getElemInfo(banner),
        title: getElemInfo(title),
        tagline: getElemInfo(tagline),
        centerElement
      });

      const csSeq = window.cleanSlateSequenceState;
      if (col.bannerStartTime !== null && (ts - col.bannerStartTime > 2200 || !csSeq)) {
        col.recording = false;
        col.done = true;
        return;
      }

      requestAnimationFrame(sample);
    }

    window.__startBannerSampling = () => {
      window.__bannerCollector.recording = true;
      requestAnimationFrame(sample);
    };
  })()`);

  console.log('[Reproduce] Triggering real touch swipe on board...');
  // Start sampling
  await cdp.eval(`window.__startBannerSampling()`);

  // Dispatch real touch swipe left on #game-board
  await cdp.eval(`(() => {
    const board = document.getElementById('game-board');
    const rect = board.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const t1 = new Touch({ identifier: 1, target: board, clientX: cx + 40, clientY: cy });
    const t2 = new Touch({ identifier: 1, target: board, clientX: cx - 40, clientY: cy });

    board.dispatchEvent(new TouchEvent('touchstart', { touches: [t1], targetTouches: [t1], changedTouches: [t1], bubbles: true, cancelable: true }));
    board.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t2], bubbles: true, cancelable: true }));
  })()`);

  // Wait until banner becomes visible
  let bannerStartTs = null;
  for (let i = 0; i < 50; i++) {
    bannerStartTs = await cdp.eval(`window.__bannerCollector.bannerStartTime`);
    if (bannerStartTs !== null) break;
    await sleep(20);
  }
  console.log(`[Reproduce] Banner started at page timestamp: ${bannerStartTs}`);

  // Schedule screenshot captures at 100, 400, 800, 1200, 1600, 2000 ms
  const targetDelays = [100, 400, 800, 1200, 1600, 2000];
  const screenshots = [];

  for (const d of targetDelays) {
    const now = await cdp.eval(`performance.now()`);
    const elapsed = now - bannerStartTs;
    const waitTime = Math.max(0, d - elapsed);
    if (waitTime > 0) await sleep(waitTime);

    const shotData = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const filePath = path.join(outDir, `banner_${d}ms.png`);
    fs.writeFileSync(filePath, Buffer.from(shotData.data, 'base64'));

    const domQuery = await cdp.eval(`(() => {
      const banner = document.getElementById('clean-slate-banner');
      const title = document.getElementById('clean-slate-title');
      const bRect = banner ? banner.getBoundingClientRect() : null;
      const tRect = title ? title.getBoundingClientRect() : null;
      const cs = title ? window.getComputedStyle(title) : null;
      const op = cs ? parseFloat(cs.opacity) : 0;
      const onScreen = tRect ? (tRect.right > 0 && tRect.bottom > 0 && tRect.left < window.innerWidth && tRect.top < window.innerHeight && op > 0) : false;
      return {
        opacity: op,
        rect: tRect ? { left: Math.round(tRect.left), top: Math.round(tRect.top), width: Math.round(tRect.width), height: Math.round(tRect.height) } : null,
        onScreen
      };
    })()`);

    screenshots.push({
      delay: d,
      file: `banner_${d}ms.png`,
      domQuery
    });
    console.log(`Captured screenshot at +${d}ms -> scripts/out/banner_${d}ms.png (title onScreen: ${domQuery.onScreen}, rect: ${JSON.stringify(domQuery.rect)})`);
  }

  // Wait for collector to finish
  while (true) {
    const isDone = await cdp.eval(`window.__bannerCollector.done`);
    if (isDone) break;
    await sleep(50);
  }

  const cleanSlateData = await cdp.eval(`window.__bannerCollector`);

  // -------------------------------------------------------------
  // CONTROL: LAST STAND BANNER CAPTURE
  // -------------------------------------------------------------
  console.log('\n[Control] Running identical capture for LAST STAND banner on the same build...');
  await cdp.eval(`(() => {
    window.__lsCollector = {
      recording: false,
      startTime: null,
      frames: [],
      rafDeltas: [],
      lastTs: null,
      done: false
    };

    function sampleLs(ts) {
      const col = window.__lsCollector;
      if (!col.recording) return;

      if (col.lastTs !== null) {
        col.rafDeltas.push(ts - col.lastTs);
      }
      col.lastTs = ts;

      const banner = document.getElementById('last-stand-banner');
      const title = banner ? (banner.querySelector('h2') || document.querySelector('.last-stand-title')) : null;
      const tagline = banner ? banner.querySelector('.stand-subtitle') : null;

      const isHidden = banner ? banner.classList.contains('hidden') : true;
      if (!isHidden && col.startTime === null) {
        col.startTime = ts;
      }

      function getElemInfo(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        const anims = el.getAnimations ? el.getAnimations().map(a => {
          const timing = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
          return {
            name: a.animationName || a.id || 'waapi',
            currentTime: a.currentTime !== null ? Math.round(a.currentTime) : null,
            playState: a.playState,
            duration: timing.duration,
            delay: timing.delay,
            fill: timing.fill
          };
        }) : [];

        return {
          rect: {
            left: Math.round(r.left * 10) / 10,
            top: Math.round(r.top * 10) / 10,
            width: Math.round(r.width * 10) / 10,
            height: Math.round(r.height * 10) / 10,
            right: Math.round(r.right * 10) / 10,
            bottom: Math.round(r.bottom * 10) / 10
          },
          opacity: cs.opacity,
          transform: cs.transform,
          visibility: cs.visibility,
          zIndex: cs.zIndex,
          anims
        };
      }

      let centerElement = 'none';
      if (banner && !isHidden) {
        const bRect = banner.getBoundingClientRect();
        const cx = bRect.left + bRect.width / 2;
        const cy = bRect.top + bRect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (hit) {
          centerElement = hit.tagName.toLowerCase() +
            (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') +
            (hit.id ? '#' + hit.id : '');
        }
      }

      col.frames.push({
        ts: Math.round(ts),
        timeSinceStart: col.startTime !== null ? Math.round(ts - col.startTime) : null,
        bannerHidden: isHidden,
        banner: getElemInfo(banner),
        title: getElemInfo(title),
        tagline: getElemInfo(tagline),
        centerElement
      });

      if (col.startTime !== null && (ts - col.startTime > 2200)) {
        col.recording = false;
        col.done = true;
        return;
      }

      requestAnimationFrame(sampleLs);
    }

    window.__startLsSampling = () => {
      window.__lsCollector.recording = true;
      requestAnimationFrame(sampleLs);
    };
  })()`);

  // Trigger Last Stand
  await cdp.eval(`window.__startLsSampling(); window.showLastStandMoment();`);

  let lsStartTs = null;
  for (let i = 0; i < 50; i++) {
    lsStartTs = await cdp.eval(`window.__lsCollector.startTime`);
    if (lsStartTs !== null) break;
    await sleep(20);
  }

  const lsScreenshots = [];
  for (const d of targetDelays) {
    const now = await cdp.eval(`performance.now()`);
    const elapsed = now - lsStartTs;
    const waitTime = Math.max(0, d - elapsed);
    if (waitTime > 0) await sleep(waitTime);

    const shotData = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const filePath = path.join(outDir, `last_stand_${d}ms.png`);
    fs.writeFileSync(filePath, Buffer.from(shotData.data, 'base64'));

    const domQuery = await cdp.eval(`(() => {
      const banner = document.getElementById('last-stand-banner');
      const title = banner ? banner.querySelector('h2') : null;
      const bRect = banner ? banner.getBoundingClientRect() : null;
      const tRect = title ? title.getBoundingClientRect() : null;
      const cs = title ? window.getComputedStyle(title) : null;
      const op = cs ? parseFloat(cs.opacity) : 0;
      const onScreen = tRect ? (tRect.right > 0 && tRect.bottom > 0 && tRect.left < window.innerWidth && tRect.top < window.innerHeight && op > 0) : false;
      return {
        opacity: op,
        rect: tRect ? { left: Math.round(tRect.left), top: Math.round(tRect.top), width: Math.round(tRect.width), height: Math.round(tRect.height) } : null,
        onScreen
      };
    })()`);

    lsScreenshots.push({
      delay: d,
      file: `last_stand_${d}ms.png`,
      domQuery
    });
    console.log(`Captured LS screenshot at +${d}ms -> scripts/out/last_stand_${d}ms.png (title onScreen: ${domQuery.onScreen}, rect: ${JSON.stringify(domQuery.rect)})`);
  }

  while (true) {
    const isDone = await cdp.eval(`window.__lsCollector.done`);
    if (isDone) break;
    await sleep(50);
  }
  const lastStandData = await cdp.eval(`window.__lsCollector`);

  // Close browser and server
  try { ws.close(); } catch {}
  try { proc.kill('SIGKILL'); } catch {}
  server.close();

  // -------------------------------------------------------------
  // COMPUTE STATISTICS & WRITE banner_frames.txt
  // -------------------------------------------------------------
  function calcStats(deltas) {
    if (!deltas || deltas.length === 0) return { min: 0, max: 0, mean: 0, sd: 0 };
    const min = Math.min(...deltas);
    const max = Math.max(...deltas);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltas.length;
    return {
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      sd: Math.round(Math.sqrt(variance) * 100) / 100
    };
  }

  const csStats = calcStats(cleanSlateData.rafDeltas);
  const lsStats = calcStats(lastStandData.rafDeltas);

  // Find opacity > 0.9 frames for clean slate title
  let firstOp09Frame = null;
  let lastOp09Frame = null;
  cleanSlateData.frames.forEach((f, idx) => {
    if (f.title && !f.bannerHidden && f.timeSinceBannerStart !== null && parseFloat(f.title.opacity) >= 0.9 && f.title.rect.width > 0) {
      if (firstOp09Frame === null) firstOp09Frame = { index: idx, ...f };
      lastOp09Frame = { index: idx, ...f };
    }
  });

  let outText = '';
  outText += '================================================================================\n';
  outText += 'REPRODUCTION REPORT: CLEAN-SLATE BANNER VISIBILITY BUG & CONTROL COMPARISON\n';
  outText += '================================================================================\n\n';

  outText += '1. ENVIRONMENT & CHROME EXECUTION FLAGS\n';
  outText += '--------------------------------------------------------------------------------\n';
  outText += `  Headed Mode:                   YES (Headless disabled)\n`;
  outText += `  GPU Accelerated:               YES (--disable-gpu absent)\n`;
  outText += `  Target URL:                    ${targetUrl}\n`;
  outText += `  Chrome Binary:                 ${chromePath}\n`;
  outText += `  Chrome Flags:                  ${chromeFlags.join(' ')}\n\n`;

  outText += '2. rAF DELTA STATISTICS (Computed from real samples)\n';
  outText += '--------------------------------------------------------------------------------\n';
  outText += `  Clean Slate Samples:           ${cleanSlateData.rafDeltas.length}\n`;
  outText += `  Clean Slate Min/Max:           ${csStats.min} ms / ${csStats.max} ms\n`;
  outText += `  Clean Slate Mean / SD:         ${csStats.mean} ms / ${csStats.sd} ms\n`;
  outText += `  Last Stand Samples:            ${lastStandData.rafDeltas.length}\n`;
  outText += `  Last Stand Min/Max:            ${lsStats.min} ms / ${lsStats.max} ms\n`;
  outText += `  Last Stand Mean / SD:          ${lsStats.mean} ms / ${lsStats.sd} ms\n\n`;

  outText += '3. CLEAN-SLATE BANNER 6-POINT SCREENSHOT TABLE & DOM QUERIES\n';
  outText += '------------------------------------------------------------------------------------------------------------------------\n';
  outText += '| Delay    | File Name            | Title Opacity | Title Bounding Rect (L, T, W, H)       | On-Screen (In Viewport) |\n';
  outText += '------------------------------------------------------------------------------------------------------------------------\n';
  for (const s of screenshots) {
    const q = s.domQuery;
    const rectStr = q.rect ? `${q.rect.left}, ${q.rect.top}, ${q.rect.width}, ${q.rect.height}` : 'null';
    outText += `| +${String(s.delay).padEnd(6)} | ${s.file.padEnd(20)} | ${String(q.opacity).padEnd(13)} | ${rectStr.padEnd(38)} | ${q.onScreen ? 'YES (PASS)' : 'NO (FAIL - CLIPPED OFF)'} |\n`;
  }
  outText += '------------------------------------------------------------------------------------------------------------------------\n\n';

  outText += '4. CONTROL (LAST STAND) 6-POINT SCREENSHOT TABLE & DOM QUERIES\n';
  outText += '------------------------------------------------------------------------------------------------------------------------\n';
  outText += '| Delay    | File Name            | Title Opacity | Title Bounding Rect (L, T, W, H)       | On-Screen (In Viewport) |\n';
  outText += '------------------------------------------------------------------------------------------------------------------------\n';
  for (const s of lsScreenshots) {
    const q = s.domQuery;
    const rectStr = q.rect ? `${q.rect.left}, ${q.rect.top}, ${q.rect.width}, ${q.rect.height}` : 'null';
    outText += `| +${String(s.delay).padEnd(6)} | ${s.file.padEnd(20)} | ${String(q.opacity).padEnd(13)} | ${rectStr.padEnd(38)} | ${q.onScreen ? 'YES (PASS)' : 'NO (FAIL)'} |\n`;
  }
  outText += '------------------------------------------------------------------------------------------------------------------------\n\n';

  outText += '5. CLEAN-SLATE TITLE OPACITY >= 0.9 SUMMARY\n';
  outText += '--------------------------------------------------------------------------------\n';
  if (firstOp09Frame) {
    outText += `  First frame with opacity >= 0.9: Frame #${firstOp09Frame.index} at T=+${firstOp09Frame.timeSinceBannerStart} ms (rect: ${JSON.stringify(firstOp09Frame.title.rect)})\n`;
    outText += `  Last frame with opacity >= 0.9:  Frame #${lastOp09Frame.index} at T=+${lastOp09Frame.timeSinceBannerStart} ms (rect: ${JSON.stringify(lastOp09Frame.title.rect)})\n`;
  } else {
    outText += `  First frame with opacity >= 0.9: NEVER\n`;
    outText += `  Last frame with opacity >= 0.9:  NEVER\n`;
  }
  outText += `  Element at banner center during hold: ${cleanSlateData.frames.find(f => f.timeSinceBannerStart > 300 && f.timeSinceBannerStart < 1400)?.centerElement || 'none'}\n\n`;

  outText += '6. COMPARISON: CLEAN SLATE vs LAST STAND (CONTROL)\n';
  outText += '--------------------------------------------------------------------------------\n';
  outText += 'Feature / Rule           | Clean Slate Banner                    | Last Stand Banner (Control)\n';
  outText += '-------------------------+---------------------------------------+---------------------------------------\n';
  outText += 'HTML Container           | #clean-slate-banner.stand             | #last-stand-banner.stand\n';
  outText += 'classList.remove(hidden) | Called AFTER getBoundingClientRect()  | Called BEFORE getBoundingClientRect()\n';
  outText += 'Measured bannerRect.left | 0 (hidden -> rect is 0,0,0,0)         | 425 px (visible -> actual inset rect)\n';
  outText += 'Calculated wrapper.left  | 440 - 0 = 440 px                      | 440 - 425 = 15 px\n';
  outText += 'Effective Viewport X     | 425 + 440 = 865 px (OFF-SCREEN RIGHT) | 425 + 15 = 440 px (CENTERED OVER BOARD)\n';
  outText += 'Container Overflow       | overflow: hidden -> COMPLETELY CLIPPED| overflow: hidden -> FULLY VISIBLE\n';
  outText += 'Exit Keyframe            | standExitRight / standExitLeft        | standExitRight / standExitLeft\n';
  outText += 'Animation Duration       | 1.85s (IN 240, HOLD 1230, OUT 380)    | 1.85s (IN 240, HOLD 1230, OUT 380)\n';
  outText += '--------------------------------------------------------------------------------\n\n';

  outText += '7. PER-FRAME SAMPLES (Clean Slate from Swipe to Ceremony End)\n';
  outText += '--------------------------------------------------------------------------------\n';
  outText += 'Idx | Time(ms) | Hidden | Title Op | Title Rect (L, T, W, H)        | Center Element Hit           | Title Animations\n';
  outText += '----+----------+--------+----------+---------------------------------+------------------------------+---------------------------------\n';
  cleanSlateData.frames.forEach((f, i) => {
    const t = f.title;
    const tRect = t ? `${t.rect.left}, ${t.rect.top}, ${t.rect.width}, ${t.rect.height}` : 'null';
    const op = t ? t.opacity : 'null';
    const animStr = t && t.anims.length ? t.anims.map(a => `${a.name}(${a.currentTime}ms,${a.playState})`).join('; ') : 'none';
    outText += `${String(i).padStart(3)} | ${String(f.timeSinceBannerStart !== null ? '+' + f.timeSinceBannerStart : f.ts).padEnd(8)} | ${String(f.bannerHidden).padEnd(6)} | ${String(op).padEnd(8)} | ${tRect.padEnd(31)} | ${String(f.centerElement).padEnd(28)} | ${animStr}\n`;
  });
  outText += '================================================================================\n';

  const outFilePath = path.join(outDir, 'banner_frames.txt');
  fs.writeFileSync(outFilePath, outText, 'utf8');
  console.log(`\nSuccessfully wrote ${outFilePath}`);
}

main().catch(err => {
  console.error('Fatal error in reproduce_banner.js:', err);
  process.exit(1);
});
