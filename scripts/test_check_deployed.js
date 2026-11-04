// scripts/test_check_deployed.js
// Tests scripts/check_deployed.js against a mock server returning mismatched versions

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('================================================================================');
console.log('TESTING npm run check:deployed AGAINST MISMATCHED MOCK');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    rulesVersion: 'MOCK_WRONG_RULES_VERSION_12345',
    replayVersion: 'MOCK_WRONG_REPLAY_VERSION_67890',
  }));
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const mockUrl = `http://localhost:${port}`;
  console.log(`Mock server listening on ${mockUrl}`);
  console.log('Spawning check_deployed.js against mock server...\n');

  const proc = spawn(process.execPath, [
    path.join(rootDir, 'scripts', 'check_deployed.js'),
    '--url',
    mockUrl,
  ], {
    stdio: 'inherit',
    cwd: rootDir,
  });

  proc.on('close', (code) => {
    server.close(() => {
      console.log(`\nMock check process exited with status: ${code} (Expected: 1)`);
      if (code === 1) {
        console.log('✔ PASS: check_deployed.js properly caught mismatch and exited 1.');
        process.exit(0);
      } else {
        console.error(`✖ FAIL: Expected exit code 1, got ${code}`);
        process.exit(1);
      }
    });
  });
});

