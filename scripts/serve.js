import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from './build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isDev = process.argv[2] === 'dev' || process.env.BUILD_TARGET === 'dev';
const targetDir = isDev
  ? (fs.existsSync(path.join(rootDir, 'dist-dev')) ? path.join(rootDir, 'dist-dev') : path.join(rootDir, 'dist'))
  : path.join(rootDir, 'dist');

// Auto-build guard: ensure dist and dist/icons exist before serving
if (!fs.existsSync(targetDir) || !fs.existsSync(path.join(targetDir, 'icons')) || !fs.existsSync(path.join(targetDir, 'index.html'))) {
  console.log(`[serve] Target ${path.relative(rootDir, targetDir) || 'dist/'} is missing or incomplete. Building first...`);
  await build({ target: isDev ? 'dev' : 'prod' });
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = isDev ? '0.0.0.0' : '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(parsedUrl.pathname);

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(targetDir, safePath);

  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(targetDir, 'index.html');
  }

  // If directory, check for index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${pathname}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

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

server.listen(PORT, HOST, () => {
  if (isDev) {
    const ips = getLanIps();
    console.log(`\n2048 Rogue Animation Lab (Dev Server) running at:`);
    console.log(`  > Local:   http://localhost:${PORT}/?lab=1`);
    for (const ip of ips) {
      console.log(`  > LAN:     http://${ip}:${PORT}/?lab=1`);
    }
    console.log(`\nServing: ${path.relative(rootDir, targetDir) || 'dist-dev/'}`);
    console.log(`(Note: Phone must be on the same Wi-Fi / local network. Ensure Windows Firewall allows Node traffic if unreachable.)`);
    console.log(`Press Ctrl+C to stop.\n`);
  } else {
    console.log(`2048 Rogue server running at:`);
    console.log(`  > http://localhost:${PORT}/`);
    console.log(`Press Ctrl+C to stop.`);
  }
});
