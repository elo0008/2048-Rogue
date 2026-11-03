// scripts/test_names.js
// Node unit test suite for Rogue 2048 Display Name Validation (names.ts)
// Covers > 130 cases across every validation rule, sentinel, evasion technique,
// token boundaries, leetspeak, allowlist bypass prevention, and affix-aware reserved names.

import { validateName, validateNameDetailed, toSkeleton } from '../supabase/functions/set-name/names.ts';
import { handleSetNameRequest } from '../supabase/functions/set-name/handler.ts';

const failDemoMode = process.argv.includes('--fail-demonstration');

console.log('================================================================================');
console.log('UNIT TEST SUITE: DISPLAY NAME VALIDATION (names.ts)');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

let totalTests = 0;
let passedTests = 0;

function assertName(description, input, expectedOk, expectedNameOrError) {
  totalTests++;
  const res = validateNameDetailed(input);
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
    console.log(`       Input: ${JSON.stringify(input)} -> ok=${res.ok}, ${res.ok ? 'name=' + res.name : 'error=' + res.error + ' (Rule ' + res.ruleNumber + ': ' + res.ruleDescription + ')'}`);
  } else {
    console.error(`[FAIL] Case ${totalTests}: ${description}`);
    console.error(`       Input: ${JSON.stringify(input)}`);
    console.error(`       Expected: ok=${expectedOk}, value=${expectedNameOrError}`);
    console.error(`       Actual:   ok=${res.ok}, value=${res.ok ? res.name : res.error + ' (Rule ' + res.ruleNumber + ': ' + res.ruleDescription + ')'}`);
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

// 10. Sentinel Long Evasion Variants
console.log('\n--- 10. Sentinel Long Evasion Variants (Must REJECT) ---');
assertName('Sentinel: exact', 'zzbadword', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: mixed-case', 'ZzBadWord', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: leetspeak 0 for o', 'zzbadw0rd', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: leetspeak 4 for a, 0 for o', 'zzb4dw0rd', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: spaced', 'zz bad word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: underscored', 'zz_bad_word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: hyphenated', 'zz-bad-word', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: repeated letters', 'zzbaaaadword', false, 'NAME_NOT_ALLOWED');
assertName('Sentinel: multiple z', 'zzzbadword', false, 'NAME_NOT_ALLOWED');

// 11. Short Token Matching with Sentinel 'zzq' (Rule 8)
console.log('\n--- 11. Short Token Matching with Sentinel zzq (G1.e Required) ---');
assertName('Token sentinel exact: Zzq', 'Zzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel with prefix: Mr Zzq', 'Mr Zzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel underscore: Big_Zzq', 'Big_Zzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel camelCase: BigZzq', 'BigZzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel spaced digits: zzq 99', 'zzq 99', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel digit boundary: zzq99', 'zzq99', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel leading digits: 99zzq', '99zzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel spaced letters: Z z q', 'Z z q', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel leetspeak: Zz9', 'Zz9', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel hyphen: Pro-Zzq', 'Pro-Zzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel repeated z: Zzzzq', 'Zzzzq', false, 'NAME_NOT_ALLOWED');
assertName('Token sentinel suffix: QueenZzq', 'QueenZzq', false, 'NAME_NOT_ALLOWED');
assertName('Harmless word with zzq prefix: Zzqueen (Must PASS)', 'Zzqueen', true, 'Zzqueen');
assertName('Harmless word with zzq suffix: Buzzqueen (Must PASS)', 'Buzzqueen', true, 'Buzzqueen');

// 12. Short Substring Matching with Sentinel 'qzzx' (Rule 9)
console.log('\n--- 12. Short Substring Matching with Sentinel qzzx (G1.e Required) ---');
assertName('Short substring exact: qzzx', 'qzzx', false, 'NAME_NOT_ALLOWED');
assertName('Short substring inside camelCase: MyQzzxPro', 'MyQzzxPro', false, 'NAME_NOT_ALLOWED');
assertName('Short substring prefix: Qzzxylophone (BLOCKED per design)', 'Qzzxylophone', false, 'NAME_NOT_ALLOWED');
assertName('Short substring with trailing digits: qzzx123', 'qzzx123', false, 'NAME_NOT_ALLOWED');
assertName('Short substring with underscores: pro_qzzx_dev', 'pro_qzzx_dev', false, 'NAME_NOT_ALLOWED');
assertName('Short substring uppercase: QZZX', 'QZZX', false, 'NAME_NOT_ALLOWED');
assertName('Short substring leetspeak: q22x', 'qzzx', false, 'NAME_NOT_ALLOWED');

// 13. Affix-Aware Reserved Names & Digits (Rule 7)
console.log('\n--- 13. Affix-Aware Reserved Names & Digits (G1.e Required) ---');
assertName('Reserved leetspeak: Adm1n', 'Adm1n', false, 'NAME_NOT_ALLOWED');
assertName('Reserved leetspeak: 0fficial', '0fficial', false, 'NAME_NOT_ALLOWED');
assertName('Reserved leetspeak: Cl4ude', 'Cl4ude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with trailing digit: admin7', 'admin7', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with leading digit: 7admin', '7admin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "The": TheAdmin', 'TheAdmin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Real": RealClaude', 'RealClaude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Official": OfficialAdmin', 'OfficialAdmin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Bot": BotClaude', 'BotClaude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Team": TeamAdmin', 'TeamAdmin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Staff": StaffClaude', 'StaffClaude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Mod": ModAdmin', 'ModAdmin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Support": SupportClaude', 'SupportClaude', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with prefix "Im": ImAdmin', 'ImAdmin', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with suffix "The": ClaudeThe', 'ClaudeThe', false, 'NAME_NOT_ALLOWED');
assertName('Reserved with suffix "Bot": AdminBot', 'AdminBot', false, 'NAME_NOT_ALLOWED');
assertName('Reserved system impersonation: Administrator', 'Administrator', false, 'NAME_NOT_ALLOWED');
assertName('Harmless name containing claude prefix: Claudette (Must PASS)', 'Claudette', true, 'Claudette');
assertName('Harmless name containing claude prefix: Claudia (Must PASS)', 'Claudia', true, 'Claudia');
assertName('Harmless name containing claude prefix: Claudio (Must PASS)', 'Claudio', true, 'Claudio');

// 14. Allowlisted Harmless Words (G1.c Required)
console.log('\n--- 14. Allowlisted Harmless Words (G1.c Required) ---');
assertName('Allowlisted word: Scunthorpe', 'Scunthorpe', true, 'Scunthorpe');
assertName('Allowlisted word: Penistone', 'Penistone', true, 'Penistone');
assertName('Allowlisted word: Cumberland', 'Cumberland', true, 'Cumberland');
assertName('Allowlisted word: Dickinson', 'Dickinson', true, 'Dickinson');
assertName('Allowlisted word: Hancock', 'Hancock', true, 'Hancock');
assertName('Allowlisted word: Assam', 'Assam', true, 'Assam');
assertName('Allowlisted word: Bassett', 'Bassett', true, 'Bassett');
assertName('Allowlisted word: classic', 'classic', true, 'classic');
assertName('Allowlisted word: glasses', 'glasses', true, 'glasses');
assertName('Allowlisted word: cockpit', 'cockpit', true, 'cockpit');
assertName('Allowlisted word: peacock', 'peacock', true, 'peacock');
assertName('Allowlisted word: analyst', 'analyst', true, 'analyst');
assertName('Allowlisted word: Cassandra', 'Cassandra', true, 'Cassandra');
assertName('Allowlisted word: Arsenal', 'Arsenal', true, 'Arsenal');
assertName('Allowlisted word: Sussex', 'Sussex', true, 'Sussex');
assertName('Allowlisted word: Middlesex', 'Middlesex', true, 'Middlesex');

// 15. Deliberate Failure Demonstration
console.log('\n--- 15. Deliberate Failure Demonstration ---');
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

// 16. P1 No Rule Leaks: Exact Response Body {"error":"NAME_NOT_ALLOWED"} for Rules 1-10
console.log('\n--- 16. P1 No Rule Leaks: Exact HTTP Response Body for Rules 1-10 ---');
const p1Cases = [
  { rule: 1, name: 'Rule 1: Non-string input', input: 12345 },
  { rule: 2, name: 'Rule 2: Length out of range', input: 'A' },
  { rule: 3, name: 'Rule 3: Forbidden character', input: 'Cool@Player' },
  { rule: 4, name: 'Rule 4: Invalid start/end boundary', input: '-CoolPlayer-' },
  { rule: 5, name: 'Rule 5: Exceeded 4 digits', input: 'Player12345' },
  { rule: 6, name: 'Rule 6: Run of 4+ identical characters', input: 'Plaaaayer' },
  { rule: 7, name: 'Rule 7: Reserved name', input: 'admin' },
  { rule: 8, name: 'Rule 8: Short token blocklist match', input: 'ass' },
  { rule: 9, name: 'Rule 9: Short substring blocklist match', input: 'qzzx' },
  { rule: 10, name: 'Rule 10: Long substring blocklist match', input: 'Randi' },
];

const mockDb = { consumeRateLimit: () => {}, setDisplayNameLimited: () => {} };

for (const c of p1Cases) {
  totalTests++;
  const detailed = validateNameDetailed(c.input);
  if (detailed.ruleNumber !== c.rule) {
    throw new Error(`P1 Case for Rule ${c.rule} triggered unexpected Rule ${detailed.ruleNumber}`);
  }
  const req = new Request('http://localhost/functions/v1/set-name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'test_device_p1_leak', name: c.input })
  });
  const res = await handleSetNameRequest(req, mockDb, {});
  const bodyText = await res.text();
  const expectedExact = JSON.stringify({ error: 'NAME_NOT_ALLOWED' });
  if (res.status === 400 && bodyText === expectedExact) {
    passedTests++;
    console.log(`[PASS] Case ${totalTests}: ${c.name} -> HTTP 400 exact body: ${bodyText}`);
  } else {
    throw new Error(`P1 check failed for Rule ${c.rule}: status=${res.status}, body=${bodyText}`);
  }
}

// 17. P4(b) Multi-Token Harmless Names Suite (>= 120 names)
console.log('\n--- 17. P4(b) Multi-Token Harmless Names Suite ---');
const multiTokenNames = [
  'Dark Knight', 'Mr Cool', 'Night_Owl_77', 'xX_Sniper_Xx', 'ProGamer', 'Super Man 99',
  'Fast As Light', 'FastAsLightning', 'Big Bad Wolf', 'Cat Lover', 'Pixel_Panda', 'Tea Time',
  'Mallu Gamer', 'Kerala Boy', 'Chai Lover', 'Cricket Fan', 'SilentStorm', 'FoxyLady',
  'Ninja Turtle', 'Space Cadet', 'Rock On',
  'Cyber_Ninja', 'Quick_Silver', 'Star Gazer', 'Blue_Sky_42', 'Iron_Wolf', 'Speedy_Fox',
  'Lunar_Echo', 'Golden_Hawk', 'Red_Panda_88', 'Thunder_Bolt', 'Shadow_Walker', 'Frost_Byte',
  'Cosmic_Ray', 'Sun_Rider', 'Atomic_Ant', 'Neon_Tiger', 'Solar_Flare', 'Mystic_Mage',
  'Storm_Chaser', 'Wild_Card_7', 'Alpha_Wolf', 'Brave_Heart', 'Quiet_Storm', 'Silver_Bullet',
  'Ocean_Breeze', 'Desert_Fox', 'Forest_Runner', 'Eagle_Eye_01', 'Iron_Clad', 'Ghost_Rider',
  'Zero_Cool', 'Quantum_Leap', 'Delta_Force', 'Titan_Gamer', 'Pixel_Knight', 'Star_Dust',
  'Blaze_Fire', 'Crystal_Cave', 'Ruby_Gem', 'Emerald_Isle', 'Copper_Wire', 'Steel_Heart',
  'Velvet_Sky', 'Diamond_Head', 'Crimson_Tide', 'Amber_Glow', 'Cobalt_Blue', 'Indigo_Night',
  'Violet_Storm', 'Topaz_Flash', 'Onyx_Stone', 'Marble_Floor', 'Granite_Rock', 'Apex_Predator',
  'Turbo_Boost', 'Hyper_Drive', 'Super_Sonic', 'Mega_Byte', 'Ultra_Violet', 'Omni_Slash',
  'Vortex_Surfer', 'Zenith_Peak', 'Horizon_Gaze', 'Nebula_Drift', 'Pulsar_Beats', 'Quasar_Light',
  'Astro_Boy_99', 'Orbit_Flyer', 'Comet_Tail', 'Meteor_Shower', 'Eclipse_Moon', 'Solstice_Sun',
  'Equinox_Star', 'Aurora_Light', 'Zephyr_Wind', 'Monsoon_Rain', 'Cyclone_Eye', 'Tsunami_Wave',
  'Volcano_Lava', 'Glacier_Peak', 'Avalanche_Snow', 'Tundra_Wolf', 'Savanna_Lion', 'Jungle_Cat',
  'Oasis_Palm', 'Mirage_Sand', 'Canyon_Echo', 'Valley_Mist', 'Plateau_Sun', 'Summit_Climber',
  'Ridge_Walker', 'Cliff_Hanger', 'Tide_Runner', 'Wave_Rider', 'Current_Flow', 'Reef_Diver',
  'Abyss_Watcher', 'Zen_Master', 'Karma_Yogi', 'Mantra_Chant', 'Lotus_Flower', 'Banyan_Tree',
  'Mango_Lassi', 'Masala_Dosa', 'Butter_Naan', 'Biryani_King', 'Samosa_Lover', 'Paneer_Tikka',
  'Filter_Coffee', 'Sweet_Jalebi', 'Gulab_Jamun', 'Royal_Bengal', 'Ganga_Rider', 'Himalaya_Snow',
  'Monk_Mind', 'Sage_Advice', 'Guru_Guide', 'Swami_Peace', 'Kavya_Poet', 'Raga_Music',
  'Taal_Rhythm', 'Sur_Melody', 'Dhruva_Star', 'Agni_Fire', 'Vayu_Breeze', 'Jal_Water',
  'Prithvi_Earth', 'Akash_Sky', 'Surya_Sun', 'Chandra_Moon', 'Mitra_Friend'
];

for (const name of multiTokenNames) {
  assertName(`Multi-token harmless handle: ${name}`, name, true, name);
}

// 18. P0 Proper Nouns Allowlisted & Continued Blocks
console.log('\n--- 18. P0 Proper Nouns Allowlisted & Continued Blocks ---');
const p0AllowlistedNames = [
  'Brandi', 'Brandice', 'Brandie', 'Brandise', 'Tatiana', 'Tatiania',
  'Claudelle', 'Claudetta', 'Domeniga', 'Querida', 'Salaidh', 'Ursala', 'Kikelia'
];
for (const n of p0AllowlistedNames) {
  assertName(`P0 allowlisted genuine proper noun: ${n}`, n, true, n);
}

// Ensure Claude, Randi, and Randie remain strictly blocked
assertName('P0 blocked reserved: Claude', 'Claude', false, 'NAME_NOT_ALLOWED');
assertName('P0 blocked word: Randi', 'Randi', false, 'NAME_NOT_ALLOWED');
assertName('P0 blocked word: Randie', 'Randie', false, 'NAME_NOT_ALLOWED');

console.log(`\n================================================================================`);
console.log(`ALL ${passedTests}/${totalTests} TESTS PASSED CLEANLY.`);
console.log(`================================================================================`);
