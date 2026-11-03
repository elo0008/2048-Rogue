// scripts/test_ip_norm.js
// Unit tests for IP normalisation (>= 15 test cases)

import { normalizeIp } from '../supabase/functions/submit-run/ip.ts';

const testCases = [
  // 1-4: Standard IPv4 (unchanged)
  { name: 'Standard public IPv4', input: '103.70.199.29', expected: '103.70.199.29' },
  { name: 'IPv4 loopback', input: '127.0.0.1', expected: '127.0.0.1' },
  { name: 'IPv4 broadcast', input: '255.255.255.255', expected: '255.255.255.255' },
  { name: 'IPv4 zero', input: '0.0.0.0', expected: '0.0.0.0' },

  // 5-7: IPv4-Mapped IPv6 (collapses to IPv4)
  { name: 'IPv4-mapped standard', input: '::ffff:192.0.2.128', expected: '192.0.2.128' },
  { name: 'IPv4-mapped uppercase', input: '::FFFF:103.70.199.29', expected: '103.70.199.29' },
  { name: 'IPv4-mapped full zero prefix', input: '0:0:0:0:0:ffff:10.0.0.1', expected: '10.0.0.1' },

  // 8-12: IPv6 (normalized to /64 prefix: v6:xxxx:xxxx:xxxx:xxxx)
  { name: 'IPv6 loopback ::1', input: '::1', expected: 'v6:0000:0000:0000:0000' },
  { name: 'IPv6 unspecified ::', input: '::', expected: 'v6:0000:0000:0000:0000' },
  { name: 'IPv6 compressed mid', input: '2001:db8:85a3::8a2e:370:7334', expected: 'v6:2001:0db8:85a3:0000' },
  { name: 'IPv6 compressed end mixed case', input: '2001:DB8:ABCD:0012::', expected: 'v6:2001:0db8:abcd:0012' },
  { name: 'IPv6 full 8 hextets', input: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', expected: 'v6:2001:0db8:85a3:0000' },
  { name: 'IPv6 typical ISP /64', input: '2409:4073:288:9418:1234:5678:9abc:def0', expected: 'v6:2409:4073:0288:9418' },

  // 13-14: Zone IDs on IPv6 (stripped)
  { name: 'IPv6 zone id interface stripped', input: 'fe80::1%eth0', expected: 'v6:fe80:0000:0000:0000' },
  { name: 'IPv6 zone id numeric stripped', input: 'fe80::1%25', expected: 'v6:fe80:0000:0000:0000' },

  // 15-23: Malformed inputs (rejected to 'unknown')
  { name: 'Empty string', input: '', expected: 'unknown' },
  { name: 'Whitespace only', input: '   ', expected: 'unknown' },
  { name: 'Non-string null', input: null, expected: 'unknown' },
  { name: 'Non-string undefined', input: undefined, expected: 'unknown' },
  { name: 'Arbitrary text', input: 'not-an-ip-address', expected: 'unknown' },
  { name: 'IPv4 octet out of range', input: '999.999.999.999', expected: 'unknown' },
  { name: 'IPv4 leading zero disallowed', input: '103.70.199.029', expected: 'unknown' },
  { name: 'IPv6 invalid hex character', input: '2001:xyz::', expected: 'unknown' },
  { name: 'IPv6 too many hextets', input: '1:2:3:4:5:6:7:8:9', expected: 'unknown' },
  { name: 'IPv6 multiple double colons', input: '::1::1', expected: 'unknown' },
  { name: 'IPv4 with zone id rejected', input: '103.70.199.29%eth0', expected: 'unknown' },
  { name: 'IPv6 empty zone id rejected', input: 'fe80::1%', expected: 'unknown' },
];

console.log('================================================================================');
console.log('UNIT TEST SUITE: IP NORMALISATION (normalizeIp)');
console.log(`Timestamp: ${new Date().toISOString()}`);
console.log('================================================================================\n');

let passed = 0;
for (const [idx, tc] of testCases.entries()) {
  const actual = normalizeIp(tc.input);
  if (actual === tc.expected) {
    passed++;
    console.log(`[PASS] Case ${String(idx + 1).padStart(2, ' ')}: ${tc.name.padEnd(35)} -> "${actual}"`);
  } else {
    console.error(`[FAIL] Case ${idx + 1}: ${tc.name} | Input: ${JSON.stringify(tc.input)} | Expected: "${tc.expected}", Got: "${actual}"`);
    throw new Error(`Assertion failed for case ${idx + 1}: ${tc.name}`);
  }
}

console.log(`\n================================================================================`);
console.log(`ALL ${passed}/${testCases.length} IP NORMALISATION TESTS PASSED CLEANLY.`);
console.log('================================================================================');

