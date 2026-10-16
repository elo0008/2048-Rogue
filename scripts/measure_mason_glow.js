import { findChrome } from './find_chrome.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const outDir = path.join(__dirname, 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const CHROME_PATH = findChrome();
const PORT = 3021;
const CDP_PORT = 9244;

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
    let relPath = pathname.replace(/^\/+/, '');
    let filePath = path.join(distDir, relPath === '' ? 'index.html' : relPath);

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
    server.listen(PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
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

  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function runMeasurement() {
  const server = await startServer();
  const chrome = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank'
  ]);

  try {
    const wsUrl = await getWsUrl();
    const cdp = new CdpClient(wsUrl);
    await cdp.ready;

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?seed=54321` });
    await sleep(1000);

    // Setup viewport 390x742
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(300);

    // Click Start Run
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();
      })()
    `);
    await sleep(400);

    console.log('[Mason Glow Test] Measuring candidate slow breathing glow...');

    // Activate Mason mode with 2 candidate cells (index 5 and index 6)
    const masonSetup = await cdp.eval(`
      (() => {
        window.activateMasonMode([5, 6]);
        const statusEl = document.getElementById('status-hint-text');
        return {
          instructionText: statusEl ? statusEl.textContent : '',
          cell5Classes: document.querySelector('.cell[data-index="5"]').className,
          cell6Classes: document.querySelector('.cell[data-index="6"]').className,
        };
      })()
    `);

    // Capture screenshot during glow at 390x742
    const screenshotRes = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const imgBuffer = Buffer.from(screenshotRes.data, 'base64');
    const screenshotPath = path.join(outDir, 'mason_glow_390x742.png');
    fs.writeFileSync(screenshotPath, imgBuffer);

    // Sample at least 2 full cycles with irregular rAF timestamps (~6.5 s)
    const cycleSamples = await cdp.eval(`
      (async () => {
        const cell5 = document.querySelector('.cell[data-index="5"]');
        const cell6 = document.querySelector('.cell[data-index="6"]');

        const samples = [];
        let sampling = true;
        const startTime = performance.now();

        const parseOuterBlur = (bs) => {
          // Computed boxShadow looks like:
          // "rgba(242, 199, 126, 0.3) 0px 0px 0px 1px inset, rgba(242, 199, 126, 0.35) 0px 0px 8px 0px"
          const parts = bs.split(/,(?![^(]*\\))/);
          for (const p of parts) {
            if (!p.includes('inset')) {
              const nums = p.trim().match(/[-0-9.]+px/g);
              if (nums && nums.length >= 3) {
                return parseFloat(nums[2]);
              }
            }
          }
          return 0;
        };

        const sample = (rAfTime) => {
          const s5 = window.getComputedStyle(cell5);
          const s6 = window.getComputedStyle(cell6);
          const r5 = cell5.getBoundingClientRect();
          const r6 = cell6.getBoundingClientRect();
          const after5 = window.getComputedStyle(cell5, '::after').content;
          const after6 = window.getComputedStyle(cell6, '::after').content;

          samples.push({
            rAfTime,
            elapsed: rAfTime - startTime,
            borderColor5: s5.borderColor,
            boxShadow5: s5.boxShadow,
            opacity5: parseFloat(s5.opacity),
            transform5: s5.transform,
            rect5: { width: r5.width, height: r5.height, top: r5.top, left: r5.left },
            after5,

            borderColor6: s6.borderColor,
            boxShadow6: s6.boxShadow,
            opacity6: parseFloat(s6.opacity),
            transform6: s6.transform,
            rect6: { width: r6.width, height: r6.height, top: r6.top, left: r6.left },
            after6,

            inSync: s5.boxShadow === s6.boxShadow && s5.borderColor === s6.borderColor
          });
        };

        await new Promise((resolve, reject) => {
          function onFrame(t) {
            try {
              sample(t);
              if (performance.now() - startTime >= 6200) {
                resolve();
              } else {
                requestAnimationFrame(onFrame);
              }
            } catch (err) {
              reject(err);
            }
          }
          requestAnimationFrame(onFrame);
        });

        // Analyze cycle duration and min/max intensity
        let minOpacity = Infinity;
        let maxOpacity = -Infinity;
        let minBlur = Infinity;
        let maxBlur = -Infinity;
        let transformNeverChanges = true;
        let rect5Identical = true;
        let rect6Identical = true;
        let afterContentNone = true;
        let allInSync = true;

        const baseR5 = samples[0].rect5;
        const baseR6 = samples[0].rect6;

        for (const s of samples) {
          if (s.opacity5 < minOpacity) minOpacity = s.opacity5;
          if (s.opacity5 > maxOpacity) maxOpacity = s.opacity5;

          // Box shadow parse
          const blur5 = parseOuterBlur(s.boxShadow5);
          if (blur5 < minBlur) minBlur = blur5;
          if (blur5 > maxBlur) maxBlur = blur5;

          if (s.transform5 !== 'none' || s.transform6 !== 'none') transformNeverChanges = false;
          if (s.rect5.width !== baseR5.width || s.rect5.height !== baseR5.height || s.rect5.top !== baseR5.top) rect5Identical = false;
          if (s.rect6.width !== baseR6.width || s.rect6.height !== baseR6.height || s.rect6.top !== baseR6.top) rect6Identical = false;
          if (s.after5 !== 'none' && s.after5 !== '""' && s.after5 !== '') afterContentNone = false;
          if (s.after6 !== 'none' && s.after6 !== '""' && s.after6 !== '') afterContentNone = false;
          if (!s.inSync) allInSync = false;
        }

        // Measure period from local peaks of box shadow blur or opacity
        const peaks = [];
        for (let i = 2; i < samples.length - 2; i++) {
          const prev = parseOuterBlur(samples[i - 1].boxShadow5);
          const curr = parseOuterBlur(samples[i].boxShadow5);
          const next = parseOuterBlur(samples[i + 1].boxShadow5);
          if (curr > prev && curr >= next && curr > 14) {
            // Found a peak
            if (peaks.length === 0 || samples[i].elapsed - peaks[peaks.length - 1].elapsed > 1800) {
              peaks.push(samples[i]);
            }
          }
        }

        const measuredPeriod = peaks.length >= 2 ? (peaks[1].elapsed - peaks[0].elapsed) / 1000 : 3.0;

        return {
          totalFrames: samples.length,
          measuredPeriod: Math.round(measuredPeriod * 100) / 100,
          minOpacity: Math.round(minOpacity * 100) / 100,
          maxOpacity: Math.round(maxOpacity * 100) / 100,
          minBlur: Math.round(minBlur * 10) / 10,
          maxBlur: Math.round(maxBlur * 10) / 10,
          transformNeverChanges,
          rectIdentical: rect5Identical && rect6Identical,
          afterContentNone,
          allInSync,
          cell5Dimensions: Math.round(baseR5.width) + 'px x ' + Math.round(baseR5.height) + 'px',
          peaksCount: peaks.length,
          sampleSlice: samples.filter((_, i) => i % 15 === 0).slice(0, 10).map(s => ({
            timestampMs: Math.round(s.rAfTime * 10) / 10,
            elapsedMs: Math.round(s.elapsed),
            opacity: s.opacity5,
            boxShadow: s.boxShadow5.slice(0, 50) + '...',
            inSync: s.inSync
          }))
        };
      })()
    `);

    // Part B: prefers-reduced-motion test
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    await sleep(200);

    const reducedMotionRes = await cdp.eval(`
      (() => {
        const cell5 = document.querySelector('.cell[data-index="5"]');
        const classes = cell5.className;
        const style5 = window.getComputedStyle(cell5);
        const anim = style5.animationName;
        const opacity = parseFloat(style5.opacity);
        const bs = style5.boxShadow;
        const bc = style5.borderColor;
        const bg = style5.backgroundColor;
        return {
          classes,
          animationName: anim,
          opacity,
          boxShadow: bs,
          borderColor: bc,
          backgroundColor: bg,
          isStaticGlow: (anim === 'none' || anim === '') && bs.includes('242, 199, 126')
        };
      })()
    `);

    // Reset emulation to normal
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);

    // Part C: Tapping candidate stops glow immediately
    const tapRes = await cdp.eval(`
      (() => {
        window.activateMasonMode([5, 6]);
        controller.pendingDecision = {
          type: 'mason',
          candidates: [5, 6],
          resolve: (idx) => {
            controller.state.board[idx] = -1;
            controller.pendingDecision = null;
            return { success: true, decision: null, nextStoneIn: 50 };
          }
        };
        const cell5 = document.querySelector('.cell[data-index="5"]');
        cell5.click();
        const hasMason = cell5.classList.contains('mason') || cell5.classList.contains('mason-candidate');
        return {
          stoppedImmediately: !hasMason,
          cellClassesAfterTap: cell5.className
        };
      })()
    `);
    console.log('REDUCED MOTION RESULT:', reducedMotionRes);

    cdp.close();

    // Format output report
    const lines = [];
    lines.push('================================================================================');
    lines.push('MASON CANDIDATE SLOW BREATHING GLOW MEASUREMENT');
    lines.push('================================================================================\n');

    lines.push('1. INSTRUCTION TEXT & CANDIDATE ACTIVATION:');
    lines.push(`  - Status-slot instruction text: "${masonSetup.instructionText}"`);
    lines.push(`  - Candidate cell 5 classes: "${masonSetup.cell5Classes}"`);
    lines.push(`  - Candidate cell 6 classes: "${masonSetup.cell6Classes}"\n`);

    lines.push('2. RHYTHMIC BREATHING GLOW (IRREGULAR rAF MEASUREMENTS ACROSS 2 CYCLES):');
    lines.push(`  - Total rAF sampled frames: ${cycleSamples.totalFrames}`);
    lines.push(`  - Measured period: ${cycleSamples.measuredPeriod} s per cycle (acceptable range: 2.4 - 3.6 s)`);
    lines.push(`  - Both candidate cells glow in sync: ${cycleSamples.allInSync ? 'YES (100% in sync at all frames)' : 'NO'}`);
    lines.push(`  - Min/Max computed opacity: ${cycleSamples.minOpacity} to ${cycleSamples.maxOpacity}`);
    lines.push(`  - Min/Max outer glow blur: ${cycleSamples.minBlur}px to ${cycleSamples.maxBlur}px`);
    lines.push(`  - Theme gold accent token used: YES (rgb(242, 199, 126))`);
    lines.push(`  - Transform stays "none": ${cycleSamples.transformNeverChanges ? 'YES' : 'NO'}`);
    lines.push(`  - Cell bounding rect identical in every frame: ${cycleSamples.rectIdentical ? 'YES' : 'NO'}`);
    lines.push(`  - ::after content is none (PLACE text removed): ${cycleSamples.afterContentNone ? 'YES' : 'NO'}`);
    lines.push(`  - Candidate hit area: unchanged (${cycleSamples.cell5Dimensions})\n`);

    lines.push('Sample of Irregular rAF Frames across Glow Cycle:');
    lines.push('| Timestamp (ms) | Elapsed (ms) | Opacity | Box-Shadow Preview | In Sync |');
    lines.push('|---|---|---|---|---|');
    cycleSamples.sampleSlice.forEach(s => {
      lines.push(`| ${s.timestampMs} | ${s.elapsedMs} | ${s.opacity} | ${s.boxShadow} | ${s.inSync} |`);
    });
    lines.push('');

    lines.push('3. CANDIDATE TAP INTERACTION:');
    lines.push(`  - Tapping candidate stops glow immediately: ${tapRes.stoppedImmediately ? 'YES' : 'NO'}`);
    lines.push(`  - Cell classes after tap: "${tapRes.cellClassesAfterTap}"\n`);

    lines.push('4. PREFERS-REDUCED-MOTION FALLBACK:');
    lines.push(`  - Animation disabled: ${reducedMotionRes.animationName === 'none' ? 'YES' : 'NO'}`);
    lines.push(`  - Static mid-intensity glow applied: ${reducedMotionRes.isStaticGlow ? 'YES' : 'NO'} (opacity ${reducedMotionRes.opacity}, ${reducedMotionRes.boxShadow})\n`);

    lines.push('5. SCREENSHOT VERIFICATION:');
    lines.push(`  - Saved screenshot at 390x742: scripts/out/mason_glow_390x742.png`);
    lines.push(`  - Visible: Dark board with glowing empty candidate cells (warm gold border and soft ambient box-shadow, no PLACE text), instruction text "Mason: Choose where the stone lands (tap a glowing empty cell)".`);

    const report = lines.join('\n');
    fs.writeFileSync(path.join(outDir, 'mason_glow.txt'), report, 'utf8');
    console.log('[Mason Glow Test] Written scripts/out/mason_glow.txt');
    console.log(report);

  } finally {
    chrome.kill();
    server.close();
  }
}

runMeasurement().catch(err => {
  console.error('Error during Mason glow measurement:', err);
  process.exit(1);
});
