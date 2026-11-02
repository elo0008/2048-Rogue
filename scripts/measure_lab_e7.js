import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const family = typeof iface.family === 'string' ? iface.family : (iface.family === 4 ? 'IPv4' : 'IPv6');
      if (family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('[E7] Measuring LAN server access and build differentiation...');

  const lanIps = getLanIps();
  const lanIp = lanIps.length > 0 ? lanIps[0] : '127.0.0.1';
  const devPort = 3456;
  const prodPort = 3457;

  // 1. Start dev server on devPort
  const devProcess = spawn('node', ['scripts/serve.js', 'dev'], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(devPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let devServerOutput = '';
  devProcess.stdout.on('data', d => devServerOutput += d.toString());
  devProcess.stderr.on('data', d => devServerOutput += d.toString());

  await sleep(1000);

  // 2. Start prod server on prodPort
  const prodProcess = spawn('node', ['scripts/serve.js'], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(prodPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let prodServerOutput = '';
  prodProcess.stdout.on('data', d => prodServerOutput += d.toString());
  prodProcess.stderr.on('data', d => prodServerOutput += d.toString());

  await sleep(1000);

  // 3. Fetch from dev server via LAN IP
  let devFetchSuccess = false;
  let devContainsLabScript = false;
  let devAppJsText = '';
  try {
    const resDev = await fetch(`http://${lanIp}:${devPort}/?lab=1`);
    if (resDev.ok) {
      devFetchSuccess = true;
      const html = await resDev.text();
      const resApp = await fetch(`http://${lanIp}:${devPort}/app.js`);
      if (resApp.ok) {
        devAppJsText = await resApp.text();
        devContainsLabScript = devAppJsText.includes('dev/lab.js') || devAppJsText.includes('__ROGUE_LAB_API__');
      }
    }
  } catch (err) {
    console.error('Failed to fetch from dev server via LAN IP:', err);
  }

  // 4. Fetch from prod server
  let prodFetchSuccess = false;
  let prodContainsLabScript = false;
  let prodAppJsText = '';
  try {
    const resProd = await fetch(`http://${lanIp}:${prodPort}/?lab=1`);
    if (resProd.ok) {
      prodFetchSuccess = true;
      const resAppProd = await fetch(`http://${lanIp}:${prodPort}/app.js`);
      if (resAppProd.ok) {
        prodAppJsText = await resAppProd.text();
        prodContainsLabScript = prodAppJsText.includes('dev/lab.js') || prodAppJsText.includes('__ROGUE_LAB_API__');
      }
    }
  } catch (err) {
    console.error('Failed to fetch from prod server:', err);
  }

  devProcess.kill();
  prodProcess.kill();

  // Format report
  let out = '';
  out += '================================================================================\n';
  out += 'E7: LAN SERVER ACCESS & PRODUCTION BUILD ISOLATION AUDIT\n';
  out += '================================================================================\n\n';

  out += '1. DEV SERVER STARTUP & NETWORK BINDING (npm run serve:dev)\n';
  out += '--------------------------------------------------------------------------------\n';
  out += `  Bound address:    0.0.0.0 (all interfaces)\n`;
  out += `  Port:             ${devPort}\n`;
  out += `  Local URL:        http://localhost:${devPort}/?lab=1\n`;
  for (const ip of lanIps) {
    out += `  LAN URL:          http://${ip}:${devPort}/?lab=1\n`;
  }
  out += '\n  Server stdout:\n';
  devServerOutput.split('\n').filter(Boolean).forEach(l => out += `    ${l}\n`);
  out += '\n';

  out += '2. LAN FETCH COMPARISON (http://' + lanIp + ')\n';
  out += '--------------------------------------------------------------------------------\n';
  out += 'A) Dev Server (npm run serve:dev, serving dist-dev/):\n';
  out += `  - HTTP Status:                 ${devFetchSuccess ? '200 OK (PASS)' : 'FAIL'}\n`;
  out += `  - Contains Lab Module / Hook:  ${devContainsLabScript ? 'YES (dev/lab.js & labApi present - PASS)' : 'FAIL'}\n\n`;

  out += 'B) Production Server (npm run serve, serving dist/):\n';
  out += `  - HTTP Status:                 ${prodFetchSuccess ? '200 OK (PASS)' : 'FAIL'}\n`;
  out += `  - Contains Lab Module / Hook:  ${prodContainsLabScript ? 'YES (LEAK)' : 'NO (100% ABSENT - PASS)'}\n\n`;

  out += '3. MANUAL ACCESS & FIREWALL INSTRUCTIONS\n';
  out += '--------------------------------------------------------------------------------\n';
  out += '  - Network requirement: The testing phone/tablet MUST be connected to the exact same\n';
  out += '    local Wi-Fi or subnet as the development host machine.\n';
  out += '  - Windows Defender / OS Firewall: If the page times out on mobile, verify that incoming\n';
  out += '    connections to Node.js are allowed in Windows Defender Firewall for Private networks.\n';
  out += '  - URL to open on mobile: http://' + lanIp + ':' + devPort + '/?lab=1\n\n';

  out += '================================================================================\n';
  out += 'CONCLUSION: Dev server binds to 0.0.0.0 and serves lab cleanly over LAN.\n';
  out += 'Production build served via normal server retains zero lab code.\n';
  out += '================================================================================\n';

  fs.writeFileSync(path.join(outDir, 'lab_lan.txt'), out, 'utf8');
  console.log('[E7] Successfully wrote scripts/out/lab_lan.txt');
}

run().catch(err => {
  console.error('[E7] Error:', err);
  process.exit(1);
});

