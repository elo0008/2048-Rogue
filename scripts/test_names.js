// scripts/test_names.js
// Node unit test suite for Rogue 2048 Display Name Validation (names.ts)
// Covers > 60 cases across every validation rule and evasion technique.

import { validateName, toSkeleton } from '../supabase/functions/set-name/names.ts';

const failDemoMode = process.argv.includes('--fail-demonstration');

console.log('================================================================================');
console.log('UNIT TEST SUITE: DISPLAY NAME VALIDATION (names.ts)');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

let totalTests = 0;
let passedTests = 0;

function assertName(description, input, expectedOk, expectedNameOrError) {
  totalTests++;
  const res = validateName(input);
  const okMatches = res.ok === expectedOk;
  let valMatches = false;
  if (expectedOk) {
    valMatches = res.ok && res.name === expectedNameOrError;
  } else {
    valMatches = !res.ok && res.error === expectedNameOrError;
  }

  const passed = okMatches && valMatches;
  if (passed) {
    passedTests++;
    console.log(`[PASS] Case ${totalTests}: ${description}`);
    console.log(`       Input: ${JSON.stringify(input)} -> ok=${res.ok}, ${res.ok ? 'name=' + res.name : 'error=' + res.error}`);
  } else {
    console.error(`[FAIL] Case ${totalTests}: ${description}`);
    console.error(`       Input: ${JSON.stringify(input)}`);
    console.error(`       Expected: ok=${expectedOk}, value=${expectedNameOrError}`);
    console.error(`       Actual:   ok=${res.ok}, value=${res.ok ? res.name : res.error}`);
    throw new Error(`Test failed: ${description}`);
  }
}

// 1. Valid Names
console.log('--- 1. Valid Names ---');
assertName('Simple valid name', 'CoolPlayer', true, 'CoolPlayer');
assertName('Valid name with space', 'Cool Player', true, 'Cool Player');
assertName('Valid name with hyphen', 'Cool-Player', true, 'Cool-Player');
assertName('Valid name with underscore', 'Cool_Player', true, 'Cool_Player');
assertName('Valid name with 4 digits', 'Player1234', true, 'Player1234');
assertName('Min length 3 chars', 'Ace', true, 'Ace');
assertName('Max length 16 chars', 'SixteenCharsLong', true, 'SixteenCharsLong');
assertName('Leading and trailing whitespace trimmed', '  SwiftFox  ', true, 'SwiftFox');
assertName('Internal consecutive spaces collapsed', 'Swift   Fox', true, 'Swift Fox');
assertName('Valid with 3 repeating chars', 'Raaapid', true, 'Raaapid');

// 2. Harmless Words (Must PASS)
console.log('\n--- 2. Harmless False-Positive-Prone Words (Must PASS) ---');
assertName('Harmless word: class', 'class', true, 'class');
assertName('Harmless word: assistant', 'assistant', true, 'assistant');
assertName('Harmless word: passion', 'passion', true, 'passion');
assertName('Harmless word: grape', 'grape', true, 'grape');
assertName('Harmless word: Essex', 'Essex', true, 'Essex');
assertName('Harmless word: therapist', 'therapist', true, 'therapist');
assertName('Harmless word: document', 'document', true, 'document');
assertName('Harmless word: cocktail', 'cocktail', true, 'cocktail');

// 3. Type Checks
console.log('\n--- 3. Type Checks (Must REJECT) ---');
assertName('Non-string: number', 12345, false, 'NAME_NOT_ALLOWED');
assertName('Non-string: boolean', true, false, 'NAME_NOT_ALLOWED');
assertName('Non-string: null', null, false, 'NAME_NOT_ALLOWED');
assertName('Non-string: undefined', undefined, false, 'NAME_NOT_ALLOWED');
assertName('Non-string: object', { name: 'Player' }, false, 'NAME_NOT_ALLOWED');

// 4. Length Limits
console.log('\n--- 4. Length Limits (Must REJECT) ---');
assertName('Too short: empty string', '', false, 'NAME_NOT_ALLOWED');
assertName('Too short: 1 char', 'A', false, 'NAME_NOT_ALLOWED');
assertName('Too short: 2 chars', 'Ab', false, 'NAME_NOT_ALLOWED');
assertName('Too long: 17 chars', 'SeventeenCharsLon', false, 'NAME_NOT_ALLOWED');
assertName('Too short after trim', '  A  ', false, 'NAME_NOT_ALLOWED');

// 5. Forbidden Characters
console.log('\n--- 5. Forbidden Characters (Must REJECT) ---');
assertName('Forbidden: emoji', 'Player🎮12', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: accent é', 'Renée', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: CJK characters', '山田太郎', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: zero-width space', 'Zero\u200BWidth', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: bidi override', 'Bidi\u202EOverride', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: HTML script tag', '<script>', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: dot', 'player.one', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: slash', 'player/one', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: at sign', 'player@one', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: single quote', "O'Connor", false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: double quote', 'Player"One', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: backslash', 'Player\\One', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: punctuation !', 'Player!', false, 'NAME_NOT_ALLOWED');
assertName('Forbidden: colon :', 'Player:One', false, 'NAME_NOT_ALLOWED');

// 6. Boundary Start/End Constraints
console.log('\n--- 6. Boundary Start/End Constraints (Must REJECT) ---');
assertName('Starts with hyphen', '-Player', false, 'NAME_NOT_ALLOWED');
assertName('Ends with hyphen', 'Player-', false, 'NAME_NOT_ALLOWED');
assertName('Starts with underscore', '_Player', false, 'NAME_NOT_ALLOWED');
assertName('Ends with underscore', 'Player_', false, 'NAME_NOT_ALLOWED');
assertName('Starts with space (trimmed then hyphen)', ' -Player ', false, 'NAME_NOT_ALLOWED');

// 7. Digit Constraints
console.log('\n--- 7. Digit Constraints (Must REJECT) ---');
assertName('5 digits total', 'Player12345', false, 'NAME_NOT_ALLOWED');
assertName('6 digits total', '123456', false, 'NAME_NOT_ALLOWED');
assertName('Scattered 5 digits', 'P1l2a3y4e5r', false, 'NAME_NOT_ALLOWED');

// 8. Repeated Characters (4+ identical)
console.log('\n--- 8. Run of 4+ Identical Characters (Must REJECT) ---');
assertName('4 identical letters', 'Raaaaapid', false, 'NAME_NOT_ALLOWED');
assertName('4 identical digits', 'Pro9999', false, 'NAME_NOT_ALLOWED');
assertName('4 identical underscores', 'Pro____One', false, 'NAME_NOT_ALLOWED');
assertName('4 identical mixed case', 'RaaAaPid', false, 'NAME_NOT_ALLOWED');

// 9. Reserved Names
console.log('\n--- 9. Reserved Names (Must REJECT) ---');
assertName('Reserved: admin', 'admin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: moderator', 'moderator', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: support', 'support', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: official', 'official', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: system', 'system', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: anthropic', 'anthropic', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: claude', 'claude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: synera', 'synera', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: rogue2048', 'rogue2048', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: null', 'null', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: undefined', 'undefined', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: admin with spaces', 'ad min', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: admin uppercase', 'ADMIN', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: anon followed by digits', 'anon123', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: anon followed by underscore and digits', 'anon_456', false, 'NAME_NOT_ALLOWED');
assertName('Reserved: Anon_99', 'Anon_99', false, 'NAME_NOT_ALLOWED');

// 10. Sentinel and Evasion Variants
console.log('\n--- 10. Sentinel and Evasion Variants (Must REJECT) ---');
assertName('Sentinel: exact', 'zzbadword', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: mixed-case', 'ZzBadWord', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: leetspeak 0 for o', 'zzbadw0rd', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: leetspeak 4 for a, 0 for o', 'zzb4dw0rd', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: spaced', 'zz bad word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: underscored', 'zz_bad_word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: hyphenated', 'zz-bad-word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: repeated letters', 'zzbaaaadword', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: multiple z', 'zzzbadword', false, 'NAME_NOT_ALLOWED');

// 11. Deliberate Failure Demonstration
console.log('\n--- 11. Deliberate Failure Demonstration ---');
if (failDemoMode) {
  console.log('Triggering intentional unhandled assertion failure for --fail-demonstration...');
  assertName('Deliberate failure: assert reserved "admin" is valid', 'admin', true, 'admin');
} else {
  let deliberateCaught = false;
  try {
    const res = validateName('admin');
    if (res.ok !== true) {
      throw new Error('[INTENTIONAL FAILURE PROOF] Expected reserved name "admin" to be valid, but validateName rejected it as expected.');
    }
  } catch (err) {
    deliberateCaught = true;
    console.log(`  ✔ Deliberately wrong expectation caught as expected: ${err.message}`);
  }
  if (!deliberateCaught) {
    throw new Error('Self-check verification failed: deliberately wrong expectation was not caught!');
  }
}

console.log(`\n================================================================================`);
console.log(`ALL ${passedTests}/${totalTests} TESTS PASSED CLEANLY.`);
console.log(`================================================================================`);

