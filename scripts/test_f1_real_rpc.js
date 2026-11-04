import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
  }
  return env;
}

async function main() {
  console.log('================================================================================');
  console.log('F1 REAL RPC READ-ONLY CALL (my_daily_rank with apikey header only)');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('================================================================================\n');

  const env = loadEnvFile(path.join(rootDir, '.env.test'));
  const url = env.SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    console.error('ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env.test');
    process.exit(1);
  }

  const isJwt = anonKey.split('.').length === 3;
  const keyType = isJwt ? 'Legacy JWT format' : (anonKey.startsWith('sb_publishable_') ? 'sb_publishable_ format' : 'Other format');
  console.log(`Target URL:      ${url.slice(0, 12)}...${url.slice(-10)}`);
  console.log(`Anon Key Format: ${keyType}`);
  console.log(`Key Header Sent: apikey ONLY (No Authorization header)`);

  const endpoint = url.endsWith('/')
    ? `${url}rest/v1/rpc/my_daily_rank`
    : `${url}/rest/v1/rpc/my_daily_rank`;

  const todayUtc = new Date().toISOString().slice(0, 10);
  const testDevId = 'test_device_readonly_probe';

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': anonKey,
    },
    body: JSON.stringify({
      target_day: todayUtc,
      p_device_id: testDevId,
    }),
  });

  const status = res.status;
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  // Mask any potential sensitive details in the returned payload
  const maskedBody = Array.isArray(parsed)
    ? `Array(${parsed.length}) ${JSON.stringify(parsed)}`
    : (typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed));

  console.log(`\nHTTP Response Status: ${status} ${res.statusText}`);
  console.log(`Response Body:        ${maskedBody}`);

  if (res.ok) {
    console.log('\n✔ PASS: Real my_daily_rank RPC succeeded using apikey header ONLY.');
  } else {
    console.error(`\n✖ FAIL: RPC returned non-200 status (${status})`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

