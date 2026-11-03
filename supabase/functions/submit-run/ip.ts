// ip.ts - IP normalisation for rate limiting
// IPv4 unchanged; IPv4-mapped IPv6 (::ffff:a.b.c.d) -> IPv4; other IPv6 -> /64 prefix (v6:xxxx:xxxx:xxxx:xxxx)

export function normalizeIp(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  let ip = raw.trim();
  if (!ip) return 'unknown';

  // Strip zone ID if present (only valid on IPv6)
  if (ip.includes('%')) {
    const parts = ip.split('%');
    if (parts.length !== 2 || !parts[1] || parts[0].includes('.')) return 'unknown';
    ip = parts[0];
  }

  // 1. IPv4 Check: exactly 4 decimal octets 0..255 with no leading zeros
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    for (let i = 0; i < 4; i++) {
      if (octets[i] < 0 || octets[i] > 255) return 'unknown';
      if (ipv4Match[i + 1].length > 1 && ipv4Match[i + 1].startsWith('0')) return 'unknown';
    }
    return octets.join('.');
  }

  // 2. IPv4-Mapped IPv6 Check: ::ffff:a.b.c.d or 0:0:0:0:0:ffff:a.b.c.d
  const lower = ip.toLowerCase();
  const v4MappedMatch = /^(?:::ffff:|(?:0*:){5}ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (v4MappedMatch) {
    const v4Part = v4MappedMatch[1];
    const subMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4Part);
    if (subMatch) {
      const octets = subMatch.slice(1, 5).map(Number);
      let valid = true;
      for (let i = 0; i < 4; i++) {
        if (octets[i] < 0 || octets[i] > 255) valid = false;
        if (subMatch[i + 1].length > 1 && subMatch[i + 1].startsWith('0')) valid = false;
      }
      if (valid) return octets.join('.');
    }
    return 'unknown';
  }

  // 3. IPv6 Check
  // Disallow more than one '::'
  const doubleColonCount = (lower.match(/::/g) || []).length;
  if (doubleColonCount > 1) return 'unknown';

  let hextets: string[] = [];
  if (doubleColonCount === 1) {
    const [left, right] = lower.split('::');
    const leftHextets = left ? left.split(':') : [];
    const rightHextets = right ? right.split(':') : [];
    const missing = 8 - (leftHextets.length + rightHextets.length);
    if (missing < 1) return 'unknown';
    const filled = new Array(missing).fill('0000');
    hextets = [...leftHextets, ...filled, ...rightHextets];
  } else {
    hextets = lower.split(':');
  }

  if (hextets.length !== 8) return 'unknown';

  const normalizedHextets: string[] = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return 'unknown';
    normalizedHextets.push(h.padStart(4, '0'));
  }

  // Return the /64 prefix (first 4 hextets)
  return 'v6:' + normalizedHextets.slice(0, 4).join(':');
}

