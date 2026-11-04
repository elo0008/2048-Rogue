// scripts/test_version_endpoint.js
// Unit tests for submit-run S0 Version Endpoint

import assert from 'node:assert/strict';
import { handleSubmissionRequest } from '../supabase/functions/submit-run/handler.ts';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';

console.log('================================================================================');
console.log('UNIT TEST SUITE: S0 VERSION ENDPOINT (GET /submit-run)');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

let total = 0;
let passed = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`[PASS] Case ${total}: ${name}`);
  } catch (err) {
    console.error(`[FAIL] Case ${total}: ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function runTests() {
  const localRules = computeRulesVersion();
  const localReplay = computeReplayVersion();

  // Test 1: Normal GET with default vendored manifest
  {
    total++;
    const req = new Request('https://test.supabase.co/functions/v1/submit-run', {
      method: 'GET',
      headers: { 'origin': 'https://rogue2048.vercel.app' },
    });
    const res = await handleSubmissionRequest(req);
    assert.equal(res.status, 200, 'Expected HTTP 200');
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://rogue2048.vercel.app');
    const body = await res.json();
    assert.equal(body.rulesVersion, localRules, 'rulesVersion matches');
    assert.equal(body.replayVersion, localReplay, 'replayVersion matches');
    assert.equal(Object.keys(body).length, 2, 'No other data in response');
    passed++;
    console.log(`[PASS] Case ${total}: Normal GET returns 200 with rulesVersion and replayVersion`);
  }

  // Test 2: GET with localhost origin
  {
    total++;
    const req = new Request('https://test.supabase.co/functions/v1/submit-run', {
      method: 'GET',
      headers: { 'origin': 'http://localhost:8080' },
    });
    const res = await handleSubmissionRequest(req);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    passed++;
    console.log(`[PASS] Case ${total}: GET with localhost origin returns 200 and allowed CORS origin`);
  }

  // Test 3: GET with missing manifest (null) -> 500 SERVER_CONFIGURATION_ERROR
  {
    total++;
    const req = new Request('https://test.supabase.co/functions/v1/submit-run', {
      method: 'GET',
    });
    const res = await handleSubmissionRequest(req, undefined, null);
    assert.equal(res.status, 500, 'Expected HTTP 500 for missing manifest');
    const body = await res.json();
    assert.equal(body.error, 'SERVER_CONFIGURATION_ERROR');
    passed++;
    console.log(`[PASS] Case ${total}: Manifest missing (null) returns 500 SERVER_CONFIGURATION_ERROR`);
  }

  // Test 4: GET with incomplete manifest (missing replayVersion) -> 500
  {
    total++;
    const req = new Request('https://test.supabase.co/functions/v1/submit-run', {
      method: 'GET',
    });
    const res = await handleSubmissionRequest(req, undefined, { rulesVersion: 'xyz' });
    assert.equal(res.status, 500, 'Expected HTTP 500 for incomplete manifest');
    const body = await res.json();
    assert.equal(body.error, 'SERVER_CONFIGURATION_ERROR');
    passed++;
    console.log(`[PASS] Case ${total}: Manifest incomplete returns 500 SERVER_CONFIGURATION_ERROR`);
  }

  // Test 5: Disallowed method (e.g. PUT) -> 405 METHOD_NOT_ALLOWED
  {
    total++;
    const req = new Request('https://test.supabase.co/functions/v1/submit-run', {
      method: 'PUT',
    });
    const res = await handleSubmissionRequest(req);
    assert.equal(res.status, 405, 'Expected HTTP 405 for PUT');
    const body = await res.json();
    assert.equal(body.error, 'METHOD_NOT_ALLOWED');
    passed++;
    console.log(`[PASS] Case ${total}: Disallowed HTTP method (PUT) returns 405 METHOD_NOT_ALLOWED`);
  }

  console.log('\n================================================================================');
  console.log(`ALL ${passed}/${total} S0 VERSION ENDPOINT TESTS PASSED CLEANLY.`);
  console.log('================================================================================');
}

runTests().catch(err => {
  console.error('Fatal error in version tests:', err);
  process.exit(1);
});

