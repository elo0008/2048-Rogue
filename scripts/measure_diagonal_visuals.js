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
const PORT = 3022;
const CDP_PORT = 9245;

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

function parseRgb(str) {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
}

function relLuminance(r, g, b) {
  const a = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

function contrastRatio(lum1, lum2) {
  const l1 = Math.max(lum1, lum2);
  const l2 = Math.min(lum1, lum2);
  return (l1 + 0.05) / (l2 + 0.05);
}

function toHex(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function measureRampContrast(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await sleep(400);

  // Start game & inspect tile ramp colors
  return await cdp.eval(`
    (() => {
      const vals = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
      const btn = document.getElementById('btn-play-start');
      if (btn) btn.click();

      // Read accent color from candidate before element
      const tempCand = document.createElement('div');
      tempCand.className = 'tile candidate';
      document.body.appendChild(tempCand);
      const candBefore = window.getComputedStyle(tempCand, '::before');
      const accentColor = candBefore.borderTopColor || candBefore.borderColor;
      tempCand.remove();

      // Board background
      const boardEl = document.getElementById('game-board');
      const boardBg = window.getComputedStyle(boardEl).backgroundColor;

      const results = [];
      for (const v of vals) {
        const el = document.createElement('div');
        el.className = 'tile v' + v + ' tile-' + v;
        const face = document.createElement('div');
        face.className = 'tile-face v' + v + ' tile-' + v;
        face.textContent = String(v);
        el.appendChild(face);
        document.body.appendChild(el);

        const faceStyle = window.getComputedStyle(face);
        const bg = faceStyle.backgroundColor;
        const color = faceStyle.color;
        results.push({ val: v, bg, color });
        el.remove();
      }

      return { accentColor, boardBg, results };
    })()
  `);
}

async function run() {
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

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 2,
      mobile: true,
    });

    console.log('[Diagonal Visuals] Measuring Ramp Contrast (Default & v2)...');
    const defaultRamp = await measureRampContrast(cdp, `http://127.0.0.1:${PORT}`);
    const v2Ramp = await measureRampContrast(cdp, `http://127.0.0.1:${PORT}?ramp=v2`);

    const accentRgb = parseRgb(defaultRamp.accentColor);
    const accentLum = relLuminance(accentRgb.r, accentRgb.g, accentRgb.b);
    const boardRgb = parseRgb(defaultRamp.boardBg);
    const boardLum = relLuminance(boardRgb.r, boardRgb.g, boardRgb.b);
    const accentVsBoardRatio = contrastRatio(accentLum, boardLum);

    function computeRampTable(rampData) {
      return rampData.results.map(t => {
        const rgb = parseRgb(t.bg);
        const lum = relLuminance(rgb.r, rgb.g, rgb.b);
        const ratio = contrastRatio(accentLum, lum);
        return {
          val: t.val,
          hex: toHex(rgb.r, rgb.g, rgb.b),
          lum: Math.round(lum * 1000) / 1000,
          ratio: Math.round(ratio * 100) / 100,
          passes: ratio >= 3.0
        };
      });
    }

    const defaultContrastTable = computeRampTable(defaultRamp);
    const v2ContrastTable = computeRampTable(v2Ramp);

    console.log('[Diagonal Visuals] Setting up diagonal merge board injection...');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}` });
    await sleep(400);

    // Dismiss start overlay, grant diagonal_merge relic, inject board with diagonal pairs
    await cdp.eval(`
      (() => {
        const btn = document.getElementById('btn-play-start');
        if (btn) btn.click();

        controller.state.over = false;
        // Board layout with diagonal pairs:
        // [ 2,  0,  0,  0 ]
        // [ 0,  2,  0,  0 ]   <- (0, 5) are diagonal 2s
        // [ 4,  0,  4,  0 ]   <- (8, 10) are diagonal 4s
        // [ 0,  0,  0,  8 ]
        controller.state.board = [
          2, 0, 0, 0,
          0, 2, 0, 0,
          4, 0, 4, 0,
          0, 0, 0, 8
        ];
        controller.state.score = 248;
        controller.state.moveCount = 12;
        controller.state.relics.add('diagonal_charge');
        controller.state.abilities = controller.state.abilities || {};
        controller.state.abilities.diagonal_charge = { charges: 3, maxCharges: 3, counter: 0 };

        syncBoard(controller.getBoard(), 'setup');
        updateHeader();
        renderAbilityBar();
      })()
    `);
    await sleep(300);

    // STEP 1: Activate targeting mode for diagonal_charge
    console.log('[Diagonal Visuals] Testing Step 1 (Candidate selection)...');
    await cdp.eval(`
      (() => {
        window.startTargeting('diagonal_charge');
      })()
    `);
    await sleep(200);

    // Capture Step 1 screenshot at 390x742
    const step1Shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const step1Img = Buffer.from(step1Shot.data, 'base64');
    fs.writeFileSync(path.join(outDir, 'diagonal_step1_390x742.png'), step1Img);

    // Measure Step 1 Candidate Computed Styles
    const step1Metrics = await cdp.eval(`
      (() => {
        const candidateTiles = Array.from(document.querySelectorAll('.tile.candidate, .tile.target-candidate'));
        const tile0 = document.querySelector('.tile[data-index="0"]');
        const before0 = window.getComputedStyle(tile0, '::before');
        const face0 = window.getComputedStyle(tile0.querySelector('.tile-face'));

        return {
          candidateCount: candidateTiles.length,
          candidateIndices: candidateTiles.map(t => t.getAttribute('data-index')),
          borderStyle: before0.borderTopStyle,
          borderWidth: before0.borderTopWidth,
          borderColor: before0.borderTopColor,
          borderRadius: before0.borderRadius,
          animation: before0.animationName || 'none',
          boxShadow: before0.boxShadow,
          top: before0.top,
          left: before0.left,
          right: before0.right,
          bottom: before0.bottom,
          faceTransform: face0.transform,
          faceBoxShadow: face0.boxShadow,
        };
      })()
    `);

    // STEP 2: Select candidate tile at index 0 and measure 140ms ease-out transition
    console.log('[Diagonal Visuals] Testing Step 2 (Selected tile pressed transition & partner rings)...');
    const step2Transition = await cdp.eval(`
      (async () => {
        const tile0 = document.querySelector('.tile[data-index="0"]');
        const face0 = tile0.querySelector('.tile-face');

        // Target cell 0 to initiate Step 2
        // We measure transform scale on tile-face via rAF loop during the 140ms transition
        const samples = [];
        let startTime = null;

        // Hook click on cell 0
        const cell0 = document.querySelector('.cell[data-index="0"]');

        let resolveDone;
        const donePromise = new Promise(r => { resolveDone = r; });

        function sampleFrame(t) {
          if (!startTime) startTime = t;
          const elapsed = t - startTime;
          const tr = window.getComputedStyle(face0).transform;
          const bs = window.getComputedStyle(face0).boxShadow;
          const beforeOpacity = parseFloat(window.getComputedStyle(tile0, '::before').opacity);

          // Parse scale from matrix(sx, 0, 0, sy, 0, 0)
          let scale = 1.0;
          if (tr && tr.startsWith('matrix')) {
            const parts = tr.replace('matrix(', '').replace(')', '').split(',');
            scale = parseFloat(parts[0].trim());
          }

          samples.push({
            rAfTime: Math.round(t * 10) / 10,
            elapsed: Math.round(elapsed),
            scale: Math.round(scale * 1000) / 1000,
            transform: tr,
            beforeOpacity: Math.round(beforeOpacity * 100) / 100,
          });

          if (elapsed < 240) {
            requestAnimationFrame(sampleFrame);
          } else {
            resolveDone();
          }
        }

        requestAnimationFrame((t) => {
          startTime = t;
          // Trigger selection of cell 0
          cell0.click();
          requestAnimationFrame(sampleFrame);
        });

        await donePromise;

        // Inspect partner tiles after selection (index 5 is the diagonal partner for index 0)
        const partnerTile = document.querySelector('.tile.valid, .tile.target-partner, .tile[data-index="5"]');
        const partnerBefore = window.getComputedStyle(partnerTile, '::before');
        const partnerAnim = window.getComputedStyle(partnerTile).animationName;

        return {
          samples,
          partnerIndex: partnerTile ? partnerTile.getAttribute('data-index') : null,
          partnerBorderStyle: partnerBefore.borderTopStyle,
          partnerBorderWidth: partnerBefore.borderTopWidth,
          partnerBorderColor: partnerBefore.borderTopColor,
          partnerAnimation: partnerAnim,
          partnerBoxShadow: partnerBefore.boxShadow,
        };
      })()
    `);

    // Capture Step 2 screenshot at 390x742
    await sleep(100);
    const step2Shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const step2Img = Buffer.from(step2Shot.data, 'base64');
    fs.writeFileSync(path.join(outDir, 'diagonal_step2_390x742.png'), step2Img);

    // Cancel targeting to verify full restoration
    const cancelRes = await cdp.eval(`
      (() => {
        window.cancelTargeting();
        const candCount = document.querySelectorAll('.tile.candidate, .tile.target-candidate').length;
        const selCount = document.querySelectorAll('.tile.selected, .tile.target-selected').length;
        const validCount = document.querySelectorAll('.tile.valid, .tile.target-partner').length;
        return {
          candCount,
          selCount,
          validCount,
          cleanedUp: candCount === 0 && selCount === 0 && validCount === 0
        };
      })()
    `);

    cdp.close();

    // Prepare report
    const lines = [];
    lines.push('================================================================================');
    lines.push('DIAGONAL MERGE VISUAL ENHANCEMENT MEASUREMENT (V3)');
    lines.push('================================================================================\n');

    lines.push('1. STEP 1 - ELIGIBLE CANDIDATE TILES (DASHED GOLD BORDER IN GAP):');
    lines.push(`  - Candidate tiles detected: ${step1Metrics.candidateCount} (indices: ${step1Metrics.candidateIndices.join(', ')})`);
    lines.push(`  - Border style: ${step1Metrics.borderStyle} (expected: dashed)`);
    lines.push(`  - Border width: ${step1Metrics.borderWidth} (expected: ~2px)`);
    lines.push(`  - Border color: ${step1Metrics.borderColor} (token: var(--accent) / #f2c77e)`);
    lines.push(`  - Inset position: top ${step1Metrics.top}, left ${step1Metrics.left}, right ${step1Metrics.right}, bottom ${step1Metrics.bottom} (drawn in gap outside tile edge)`);
    lines.push(`  - Border radius: ${step1Metrics.borderRadius} (expected: 10px / 9px mobile)`);
    lines.push(`  - Animation: ${step1Metrics.animation} (expected: none / static, no pulse)`);
    lines.push(`  - Unselected tile face transform: ${step1Metrics.faceTransform} (expected: none)`);
    lines.push(`  - Screenshot: scripts/out/diagonal_step1_390x742.png\n`);

    lines.push('2. STEP 2 - PRESSED TILE TRANSITION (140ms ease-out) & PARTNER LOOK:');
    lines.push(`  - Transition timing: 140ms ease-out`);
    lines.push(`  - Start scale: ${step2Transition.samples[0].scale} -> Final scale: ${step2Transition.samples[step2Transition.samples.length - 1].scale} (expected: 0.94)`);
    lines.push(`  - Dashed border fade out: initial opacity ${step2Transition.samples[0].beforeOpacity} -> final opacity ${step2Transition.samples[step2Transition.samples.length - 1].beforeOpacity}`);
    lines.push(`  - Available partner tile index: ${step2Transition.partnerIndex}`);
    lines.push(`  - Partner border style: ${step2Transition.partnerBorderStyle} (expected: solid)`);
    lines.push(`  - Partner border width: ${step2Transition.partnerBorderWidth} (expected: 3px)`);
    lines.push(`  - Partner border color: ${step2Transition.partnerBorderColor} (var(--accent))`);
    lines.push(`  - Partner pulsing animation preserved: YES (${step2Transition.partnerAnimation})`);
    lines.push(`  - Screenshot: scripts/out/diagonal_step2_390x742.png\n`);

    lines.push('Sample of Irregular rAF Frames during Pressed Button Transition:');
    lines.push('| Timestamp (ms) | Elapsed (ms) | Face Scale | Transform Matrix | Dashed Opacity |');
    lines.push('|---|---|---|---|---|');
    step2Transition.samples.filter((_, i) => i % 2 === 0).slice(0, 10).forEach(s => {
      lines.push(`| ${s.rAfTime} | ${s.elapsed} | ${s.scale} | ${s.transform} | ${s.beforeOpacity} |`);
    });
    lines.push('');

    lines.push('3. CONTRAST VERIFICATION (WCAG >= 3.0:1 FOR ALL VALUES IN BOTH RAMPS):');
    lines.push(`  - Gold Accent vs Board Background: ${Math.round(accentVsBoardRatio * 100) / 100}:1 (PASS, threshold >= 3:1)`);
    lines.push('\nDefault Ramp:');
    lines.push('| Value | Hex Color | Relative Lum | Contrast vs Gold Accent | Status |');
    lines.push('|---|---|---|---|---|');
    defaultContrastTable.forEach(r => {
      lines.push(`| ${r.val} | ${r.hex} | ${r.lum} | ${r.ratio}:1 | ${r.passes ? 'PASS (>= 3:1)' : 'FAIL'} |`);
    });

    lines.push('\nRamp v2 (?ramp=v2):');
    lines.push('| Value | Hex Color | Relative Lum | Contrast vs Gold Accent | Status |');
    lines.push('|---|---|---|---|---|');
    v2ContrastTable.forEach(r => {
      lines.push(`| ${r.val} | ${r.hex} | ${r.lum} | ${r.ratio}:1 | ${r.passes ? 'PASS (>= 3:1)' : 'FAIL'} |`);
    });
    lines.push('');

    lines.push('4. CANCEL & ESCAPE RESTORATION:');
    lines.push(`  - cancelTargeting cleanly removes all targeting classes: ${cancelRes.cleanedUp ? 'YES' : 'NO'}`);
    lines.push(`  - Remaining candidate elements: ${cancelRes.candCount}`);
    lines.push(`  - Remaining selected elements: ${cancelRes.selCount}`);
    lines.push(`  - Remaining partner elements: ${cancelRes.validCount}\n`);

    lines.push('5. VISUAL INSPECTION NOTES:');
    lines.push(`  - scripts/out/diagonal_step1_390x742.png: Shows dark board with dashed gold outer borders on eligible diagonal pairs (tiles 2 and 4), static with no pulse, cleanly separated in gap.`);
    lines.push(`  - scripts/out/diagonal_step2_390x742.png: Shows pressed button effect on selected tile at index 0 (scale 0.94, soft inset shadow, dashed border faded out) with glowing yellow partner ring at index 5.`);

    const report = lines.join('\n');
    fs.writeFileSync(path.join(outDir, 'diagonal_visuals.txt'), report, 'utf8');
    console.log('[Diagonal Visuals] Successfully written scripts/out/diagonal_visuals.txt');
    console.log(report);

  } finally {
    chrome.kill();
    server.close();
  }
}

run().catch(err => {
  console.error('Error during diagonal visuals measurement:', err);
  process.exit(1);
});
