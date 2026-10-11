import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const CHROME_PATH = fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

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
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);
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
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function getWsUrl(cdpPort) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
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

async function runNetworkCheck() {
  const server = await startStaticServer();
  const serverPort = server.address().port;

  const cdpPort = 9226;
  const chromeProcess = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--no-sandbox',
      '--disable-gpu',
      `http://127.0.0.1:${serverPort}/?start=eraser`,
    ],
    { stdio: 'ignore' }
  );

  const iconRequests = [];

  try {
    const wsUrl = await getWsUrl(cdpPort);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 1;
    function send(method, params = {}) {
      return new Promise((res) => {
        const curId = id++;
        const onMsg = (event) => {
          const data = JSON.parse(event.data);
          if (data.id === curId) {
            ws.removeEventListener('message', onMsg);
            res(data.result);
          }
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    }

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Network.responseReceived') {
        const url = data.params.response.url;
        if (url.includes('/icons/')) {
          iconRequests.push({
            url: url.replace(/^http:\/\/[^/]+/, ''),
            status: data.params.response.status,
            statusText: data.params.response.statusText,
            mimeType: data.params.response.mimeType
          });
        }
      }
    });

    await send('Network.enable');
    await send('Page.enable');
    await send('Runtime.enable');

    await sleep(400);

    // Click START
    await send('Runtime.evaluate', {
      expression: `document.getElementById('btn-play-start').click()`
    });

    await sleep(400);

    console.log('\n================================ ICON NETWORK REQUESTS (CDP) ================================');
    console.log('Request URL                                  | HTTP Status | Status Text | MIME Type');
    console.log('---------------------------------------------------------------------------------------------');
    for (const req of iconRequests) {
      console.log(`${req.url.padEnd(44)} | ${req.status.toString().padEnd(11)} | ${req.statusText.padEnd(11)} | ${req.mimeType}`);
    }
    console.log('---------------------------------------------------------------------------------------------');
    const eraserReq = iconRequests.find(r => r.url.includes('eraser'));
    if (!eraserReq) {
      console.log('Eraser icon request status: NEVER REQUESTED (no HTTP request made because app.js ICON_MAP has no entry for eraser)');
    } else {
      console.log('Eraser icon request status:', eraserReq.status, eraserReq.statusText);
    }
    console.log('=============================================================================================\n');

    ws.close();
  } finally {
    chromeProcess.kill();
    server.close();
  }
}

runNetworkCheck().catch(console.error);
