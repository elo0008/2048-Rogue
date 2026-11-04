// scripts/test_config_validation.js
// Unit tests for C1 leaderboard config validation in scripts/build.js

import assert from 'node:assert/strict';
import { validateLeaderboardConfig } from './build.js';

console.log('================================================================================');
console.log('UNIT TEST SUITE: C1 LEADERBOARD CONFIG VALIDATION');
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

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = 'mock_signature';
  return `${header}.${body}.${sig}`;
}

// 1. Neither set -> null
test('Neither URL nor Key set returns null', () => {
  assert.equal(validateLeaderboardConfig(undefined, undefined), null);
  assert.equal(validateLeaderboardConfig('', ''), null);
  assert.equal(validateLeaderboardConfig(null, null), null);
});

// 2. Only URL set -> error
test('Only URL set throws error', () => {
  assert.throws(
    () => validateLeaderboardConfig('https://myproject.supabase.co', ''),
    /Both LEADERBOARD_URL and LEADERBOARD_ANON_KEY must be provided/
  );
});

// 3. Only Key set -> error
test('Only Key set throws error', () => {
  assert.throws(
    () => validateLeaderboardConfig('', 'sb_publishable_123'),
    /Both LEADERBOARD_URL and LEADERBOARD_ANON_KEY must be provided/
  );
});

// 4. Wrong URL (not supabase.co and not localhost) -> error
test('Wrong URL throws clear error', () => {
  assert.throws(
    () => validateLeaderboardConfig('https://example.com', 'sb_publishable_123'),
    /Invalid LEADERBOARD_URL/
  );
  assert.throws(
    () => validateLeaderboardConfig('ftp://localhost', 'sb_publishable_123'),
    /Invalid LEADERBOARD_URL/
  );
});

// 5. Service-role key starting with sb_secret_ -> error
test('Secret key starting with sb_secret_ is rejected', () => {
  assert.throws(
    () => validateLeaderboardConfig('https://myproj.supabase.co', 'sb_secret_supersecretkey123'),
    /must not be a service-role\/secret key/
  );
});

// 6. Service-role-looking JWT (role === 'service_role') -> error
test('Service-role JWT is decoded and rejected', () => {
  const serviceJwt = makeJwt({ role: 'service_role', exp: 1999999999 });
  assert.throws(
    () => validateLeaderboardConfig('https://myproj.supabase.co', serviceJwt),
    /JWT role must be "anon", got "service_role"/
  );
});

// 7. Non-anon JWT (e.g. role === 'authenticated') -> error
test('Non-anon JWT (e.g. authenticated) is rejected', () => {
  const authJwt = makeJwt({ role: 'authenticated', exp: 1999999999 });
  assert.throws(
    () => validateLeaderboardConfig('https://myproj.supabase.co', authJwt),
    /JWT role must be "anon", got "authenticated"/
  );
});

// 8. Malformed JWT -> error
test('Malformed JWT string is rejected', () => {
  assert.throws(
    () => validateLeaderboardConfig('https://myproj.supabase.co', 'header.not_base64_json.sig'),
    /Failed to decode LEADERBOARD_ANON_KEY JWT/
  );
});

// 9. Valid publishable key with Supabase URL -> valid config
test('Valid sb_publishable_ key with Supabase URL succeeds', () => {
  const res = validateLeaderboardConfig('https://myproj.supabase.co', 'sb_publishable_abcdef123');
  assert.deepEqual(res, {
    url: 'https://myproj.supabase.co',
    anonKey: 'sb_publishable_abcdef123',
  });
});

// 10. Valid anon JWT with Supabase URL -> valid config
test('Valid anon JWT with Supabase URL succeeds', () => {
  const anonJwt = makeJwt({ role: 'anon', iss: 'supabase' });
  const res = validateLeaderboardConfig('https://myproj.supabase.co/', anonJwt);
  assert.deepEqual(res, {
    url: 'https://myproj.supabase.co',
    anonKey: anonJwt,
  });
});

// 11. Valid localhost URL (with port) -> valid config
test('Valid localhost URL with port succeeds', () => {
  const anonJwt = makeJwt({ role: 'anon' });
  const res = validateLeaderboardConfig('http://localhost:54321', anonJwt);
  assert.deepEqual(res, {
    url: 'http://localhost:54321',
    anonKey: anonJwt,
  });
});

console.log('\n================================================================================');
console.log(`ALL ${passed}/${total} CONFIG VALIDATION TESTS PASSED CLEANLY.`);
console.log('================================================================================');

