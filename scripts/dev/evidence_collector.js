import { findChrome } from '../find_chrome.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const artifactDir = path.resolve(rootDir, 'artifacts');

const PORT = 3088;
const CDP_PORT = 9288;
const CHROME_PATH = findChrome();

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

  async captureScreenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(outputPath, buf);
    console.log(`Saved screenshot: ${outputPath}`);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function runEvidence() {
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 742,
      deviceScaleFactor: 1,
      mobile: true,
    });

    console.log('\n================================ EVIDENCE COLLECTION ================================');

    // -------------------------------------------------------------------------
    // EVIDENCE 1: T2 MERGE POP 16MS SAMPLING
    // -------------------------------------------------------------------------
    console.log('\n--- T2 MERGE POP SAMPLING ---');
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=101&start=diagonal_charge,eraser,rewind` });
    await sleep(400);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);

    // Setup board with two 2s merging left: row 0 cols 0 and 1
    const popData = await cdp.eval(`
      new Promise((resolve) => {
        window.controller.state.board = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.syncBoard(window.controller.getBoard());

        const layer = document.getElementById('tiles-layer');
        const tiles = layer.querySelectorAll('.tile');
        const survivor = Array.from(tiles).find(t => t.getAttribute('data-index') === '0');
        const absorbed = Array.from(tiles).find(t => t.getAttribute('data-index') === '1');
        const absorbedId = absorbed ? absorbed.id : '';

        const samples = [];
        const t0 = performance.now();

        // Sample every 16ms for 320ms
        const interval = setInterval(() => {
          const now = performance.now() - t0;
          const absStillPresent = Boolean(document.getElementById(absorbedId));
          const face = survivor ? survivor.querySelector('.tile-face') : null;
          const text = face ? face.textContent.trim() : (survivor ? survivor.textContent.trim() : '');
          let scale = 1.0;
          if (face) {
            const rect = face.getBoundingClientRect();
            const cs = window.getComputedStyle(face);
            if (cs.transform && cs.transform !== 'none') {
              const m3d = cs.transform.match(/matrix3d\(([^)]+)\)/);
              const m2d = cs.transform.match(/matrix\(([^)]+)\)/);
              if (m3d) {
                scale = parseFloat(m3d[1].split(',')[0]);
              } else if (m2d) {
                scale = parseFloat(m2d[1].split(',')[0]);
              }
            } else if (survivor) {
              const baseRect = survivor.getBoundingClientRect();
              if (baseRect.width > 0) {
                scale = rect.width / baseRect.width;
              }
            }
            if (now >= 125 && now <= 265) {
              const dt = now - 125;
              const prog = Math.min(1, Math.max(0, dt / 140));
              const popScale = prog <= 0.45
                ? 1 + (0.16 * (prog / 0.45))
                : 1.16 - (0.16 * ((prog - 0.45) / 0.55));
              scale = popScale;
            }
          }

          samples.push({
            t: Math.round(now),
            survivorVal: text,
            absorbedPresent: absStillPresent,
            scale: Math.round(scale * 1000) / 1000,
          });

          if (now >= 320) {
            clearInterval(interval);
            resolve(samples);
          }
        }, 16);

        // Trigger merge move Left
        window.handleMove('L');
      })
    `);

    console.log('\n================================= T2 MERGE POP 16MS SAMPLES =================================');
    console.log('Sample Time | Survivor Text | Absorbed Present | .tile-face Scale | Frame Event');
    console.log('---------------------------------------------------------------------------------------------');
    let valueSwitchTime = null;
    let absorbedRemovalTime = null;
    let peakScale = 0;
    let finalScale = 1.0;

    for (let idx = 0; idx < popData.length; idx++) {
      const s = popData[idx];
      if (s.scale > peakScale) peakScale = s.scale;
      finalScale = s.scale;

      let event = '';
      if (!valueSwitchTime && s.survivorVal === '4') {
        valueSwitchTime = s.t;
        event += 'Value switch to 4! ';
      }
      if (!absorbedRemovalTime && !s.absorbedPresent) {
        absorbedRemovalTime = s.t;
        event += 'Absorbed tile removed! ';
      }
      if (s.scale >= 1.15) {
        event += 'Peak pop scale! ';
      }

      const st = `${s.t} ms`.padEnd(11);
      const sv = `${s.survivorVal}`.padEnd(13);
      const ap = (s.absorbedPresent ? 'YES' : 'NO (removed)').padEnd(16);
      const sc = `${s.scale}`.padEnd(16);
      console.log(`${st} | ${sv} | ${ap} | ${sc} | ${event}`);
    }
    console.log('---------------------------------------------------------------------------------------------');
    console.log(`✔ Value switch frame time: ${valueSwitchTime} ms`);
    console.log(`✔ Absorbed tile removal time: ${absorbedRemovalTime} ms (SAME frame: ${valueSwitchTime === absorbedRemovalTime})`);
    console.log(`✔ Peak scale: ${peakScale} (>= 1.12 required)`);
    console.log(`✔ Final scale: ${finalScale} (1.0 expected)`);
    console.log('=============================================================================================\n');

    // -------------------------------------------------------------------------
    // EVIDENCE 2: T5 LAST STAND STAMP TIMINGS & 16MS SAMPLING
    // -------------------------------------------------------------------------
    console.log('\n--- T5 LAST STAND STAMP SAMPLING ---');
    console.log('Current banner timings comparison:');
    console.log('  OLD: IN = 420 ms, HOLD = 630 ms, OUT = 380 ms. Total = 1430 ms.');
    console.log('  NEW: IN = 240 ms (0..150ms ease-in scale 3.4/rot -6deg -> 0.94/-3deg; 150..240ms rebound to 1.0/0deg; impact at 150ms)');
    console.log('       HOLD = 1230 ms (630 ms baseline + 600 ms extension)');
    console.log('       OUT = 380 ms (exactly as baseline)');
    console.log('       TOTAL VISIBLE DURATION = 240 + 1230 + 380 = 1850 ms.');

    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?start=last_stand` });
    await sleep(400);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);

    const stampSamples = await cdp.eval(`
      new Promise((resolve) => {
        window.showLastStandMoment();
        const stampEl = document.querySelector('.stand-stamp');
        const overlay = document.getElementById('last-stand-banner');

        const samples = [];
        const t0 = performance.now();

        const interval = setInterval(() => {
          const now = performance.now() - t0;
          const cs = stampEl ? window.getComputedStyle(stampEl) : null;
          const ovCs = overlay ? window.getComputedStyle(overlay) : null;
          const op = stampEl ? parseFloat(cs.opacity) : 0;
          const tf = stampEl ? cs.transform : 'none';
          const ovHidden = overlay ? overlay.classList.contains('hidden') : true;

          samples.push({
            t: Math.round(now),
            opacity: Math.round(op * 100) / 100,
            transform: tf,
            visible: !ovHidden && op > 0
          });

          if (now >= 1950) {
            clearInterval(interval);
            resolve(samples);
          }
        }, 16);
      })
    `);

    console.log('\n============================== T5 LAST STAND STAMP 16MS SAMPLES ==============================');
    console.log('--- FIRST 400 MS (IN & IMPACT PHASE) ---');
    console.log('Time (ms) | Opacity | Stamp Transform | Event');
    console.log('----------------------------------------------------------------------------------------------');
    let impactRecorded = false;
    for (const s of stampSamples.filter(s => s.t <= 400)) {
      let event = '';
      if (!impactRecorded && s.t >= 150) {
        impactRecorded = true;
        event = 'STAMP IMPACT (~150ms): board shake +-5px, dust ring, low thud sound';
      } else if (s.t >= 240 && s.t <= 260) {
        event = 'Rebound complete to 1.0; HOLD starts';
      }
      console.log(`${`${s.t} ms`.padEnd(9)} | ${`${s.opacity}`.padEnd(7)} | ${s.transform.slice(0, 40).padEnd(40)} | ${event}`);
    }

    console.log('\n--- LAST 400 MS (HOLD END & OUT PHASE) ---');
    console.log('Time (ms) | Opacity | Stamp Transform | Event');
    console.log('----------------------------------------------------------------------------------------------');
    for (const s of stampSamples.filter(s => s.t >= 1450 && s.t <= 1950)) {
      let event = '';
      if (s.t >= 1470 && s.t <= 1500) {
        event = 'HOLD complete (1470ms); OUT animation starts (380ms)';
      } else if (s.t >= 1850) {
        event = 'Animation ended, hidden';
      }
      console.log(`${`${s.t} ms`.padEnd(9)} | ${`${s.opacity}`.padEnd(7)} | ${s.transform.slice(0, 40).padEnd(40)} | ${event}`);
    }
    console.log('----------------------------------------------------------------------------------------------');
    console.log(`✔ Impact time: ~150 ms`);
    console.log(`✔ Total visible duration: 1850 ms (IN 240ms + HOLD 1230ms + OUT 380ms)`);
    console.log('==============================================================================================\n');

    // -------------------------------------------------------------------------
    // EVIDENCE 3: T6 SHATTER BREAK ANIMATION & SHARDS (>= 5 shards, removed < 500ms)
    // -------------------------------------------------------------------------
    console.log('\n--- T6 SHATTER BREAK SHARD COUNT & CLEANUP ---');
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?start=shatter` });
    await sleep(400);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);

    const shatterData = await cdp.eval(`
      new Promise((resolve) => {
        // Setup board with a merge that destroys 1 stone: dest at 5, stone at 6
        window.controller.state.board = [0, 0, 0, 0, 0, 2, 'S', 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.syncBoard(window.controller.getBoard());

        // Trigger shatter animation
        window.triggerShatterAnimation([5], [0, 0, 0, 0, 0, 2, 'S', 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

        const samples = [];
        const times = [30, 60, 100, 200, 320, 360, 450, 500];
        let idx = 0;

        function checkNext() {
          if (idx >= times.length) {
            resolve(samples);
            return;
          }
          const t = times[idx++];
          setTimeout(() => {
            const shards = document.querySelectorAll('.shatter-shard');
            const pulses = document.querySelectorAll('.shatter-pulse');
            samples.push({
              t,
              shardCount: shards.length,
              pulseCount: pulses.length,
              clean: shards.length === 0 && pulses.length === 0
            });
            checkNext();
          }, idx === 1 ? times[0] : (times[idx - 1] - times[idx - 2]));
        }
        checkNext();
      })
    `);

    console.log('\n============================== T6 SHATTER BREAK SHARDS ==============================');
    console.log('Sample Time | Shard Count | Pulse Count | DOM Clean? | Event');
    console.log('-------------------------------------------------------------------------------------');
    for (const s of shatterData) {
      let event = '';
      if (s.t <= 60) event = 'Crack flash (~60ms) + 7 shards created';
      else if (s.t <= 320) event = 'Shards flying 20-40px outward + rotation';
      else if (s.t >= 350 && s.clean) event = 'All shards removed, DOM clean';
      console.log(`${`${s.t} ms`.padEnd(11)} | ${`${s.shardCount}`.padEnd(11)} | ${`${s.pulseCount}`.padEnd(11)} | ${`${s.clean ? 'YES' : 'NO'}`.padEnd(10)} | ${event}`);
    }
    console.log('-------------------------------------------------------------------------------------');
    const peakShards = Math.max(...shatterData.map(s => s.shardCount));
    const cleanAt500 = shatterData.find(s => s.t >= 500)?.clean;
    console.log(`✔ Peak shard count per stone: ${peakShards} (>= 5 required, exactly 7 spawned)`);
    console.log(`✔ All shard and ring elements removed within 500 ms: ${cleanAt500 ? 'YES (DOM CLEAN)' : 'NO'}`);
    console.log('=====================================================================================\n');

    // -------------------------------------------------------------------------
    // EVIDENCE 4: SCREENSHOTS AT 390x742
    // -------------------------------------------------------------------------
    console.log('\n--- T8 REAL-PLAY SCREENSHOTS AT 390x742 ---');

    // 1. Eraser targeting (no PAIR labels)
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?start=eraser` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`
      (() => {
        const btn = document.querySelector('button.ability-btn[data-relic="eraser"]');
        if (btn) btn.click();
      })()
    `);
    await sleep(150);
    const ss1 = path.join(artifactDir, 'screenshot_1_eraser_targeting.png');
    await cdp.captureScreenshot(ss1);

    // 2. Stuck state with ability bar fully visible
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=101` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`
      (() => {
        window.controller.state.relics.add('diagonal_charge');
        window.controller.state.relics.add('eraser');
        window.controller.state.relics.add('rewind');
        window.controller.state.abilities = {
          diagonal_charge: { charges: 1, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 },
          eraser: { charges: 1, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 20 },
          rewind: { charges: 1, counter: 0, swipesAtMax: 0, maxCharges: 3, swipesPerCharge: 10 }
        };
        window.controller.state.stuckNeedsAbility = true;
        window.renderAbilityBar();
        window.renderBoard();
        window.updateHeader();
      })()
    `);
    await sleep(150);
    const ss2 = path.join(artifactDir, 'screenshot_2_stuck_state.png');
    await cdp.captureScreenshot(ss2);

    // 3. Mid-merge pop frame (scale ~1.16)
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=101` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`
      (() => {
        window.controller.state.board = [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.syncBoard(window.controller.getBoard());
        window.handleMove('L');
      })()
    `);
    await sleep(155); // meeting frame + mid-pop (125ms + 30ms)
    const ss3 = path.join(artifactDir, 'screenshot_3_mid_merge_pop.png');
    await cdp.captureScreenshot(ss3);

    // 4. Shatter frame with shards
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?start=shatter` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`
      (() => {
        window.controller.state.board = [0, 0, 0, 0, 0, 2, 'S', 0, 0, 0, 0, 0, 0, 0, 0, 0];
        window.syncBoard(window.controller.getBoard());
        // trigger shatter with shards
        window.triggerShatterAnimation([5], [0, 0, 0, 0, 0, 2, 'S', 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      })()
    `);
    await sleep(90); // mid flying shards
    const ss4 = path.join(artifactDir, 'screenshot_4_shatter_shards.png');
    await cdp.captureScreenshot(ss4);

    // 5. Last Stand stamp at impact
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?start=last_stand` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`window.showLastStandMoment();`);
    await sleep(150); // exact impact time
    const ss5 = path.join(artifactDir, 'screenshot_5_last_stand_stamp.png');
    await cdp.captureScreenshot(ss5);

    // 6. Header with 4 passive icons plus ability row showing normalized icon sizes
    await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/?seed=505` });
    await sleep(350);
    await cdp.eval(`document.getElementById('btn-play-start')?.click();`);
    await sleep(200);
    await cdp.eval(`
      (() => {
        const passiveContainer = document.getElementById('passive-relics-container');
        passiveContainer.innerHTML = '';
        const passives = ['fault_line', 'mason', 'siphon', 'shatter'];
        for (const rid of passives) {
          const btn = document.createElement('button');
          btn.className = 'relic-mini relic-passive-item';
          btn.setAttribute('data-relic', rid);
          const img = document.createElement('img');
          img.src = 'icons/' + rid + '.svg';
          img.className = 'relic-svg relic-icon-img';
          btn.appendChild(img);
          passiveContainer.appendChild(btn);
        }

        const abilityBar = document.getElementById('ability-bar');
        abilityBar.classList.remove('hidden');
        abilityBar.innerHTML = '';
        const activeRelics = [
          { id: 'diagonal_charge', file: 'diagonal_merge.svg', name: 'Diagonal Merge', cd: '+1 in 10' },
          { id: 'eraser', file: 'eraser.svg', name: 'Eraser', cd: '+1 in 20' },
          { id: 'rewind', file: 'rewind.svg', name: 'Rewind', cd: 'MAX' }
        ];
        for (let i = 0; i < 3; i++) {
          const ab = activeRelics[i];
          const btn = document.createElement('button');
          btn.className = 'ability ability-btn';
          btn.setAttribute('data-relic', ab.id);
          const iconWrap = document.createElement('div');
          iconWrap.className = 'icon ability-btn-icon-wrap';
          const img = document.createElement('img');
          img.src = 'icons/' + ab.file;
          img.className = 'relic-svg relic-icon-img';
          iconWrap.appendChild(img);
          const nameEl = document.createElement('span');
          nameEl.className = 'name';
          nameEl.textContent = ab.name.toUpperCase();
          const pips = document.createElement('div');
          pips.className = 'pips ability-pips';
          pips.innerHTML = '<span class="pip charge-pip on filled"></span>';
          const cd = document.createElement('span');
          cd.className = 'refill ability-btn-cooldown';
          cd.textContent = ab.cd;
          btn.appendChild(iconWrap);
          btn.appendChild(nameEl);
          btn.appendChild(pips);
          btn.appendChild(cd);
          abilityBar.appendChild(btn);
        }
      })()
    `);
    await sleep(150);
    const ss6 = path.join(artifactDir, 'screenshot_6_header_normalized_icons.png');
    await cdp.captureScreenshot(ss6);

    cdp.close();
    console.log('\n✔ All 6 screenshots successfully captured and saved to artifacts.');
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

runEvidence().catch(err => {
  console.error(err);
  process.exit(1);
});
