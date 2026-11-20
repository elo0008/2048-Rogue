import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { build } from './build.js';
import { computeReplayVersion } from '../verify/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const EXPECTED_ENGINE_HASH = '7EE89200FAB78AE2B5F333244CA2E59B9D7DEC261E6A9DF4FDFB28CDD734569B';
const EXPECTED_REPLAY_VERSION = '3C7C88F57E5B29A1DFA196A55C054F40D748CF948101C50E4E834FBFAD33EE98';

export function getJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    throw new Error('Not a valid JPEG file (missing SOI marker 0xFFD8)');
  }
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xFF) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF markers: 0xC0 (SOF0 Baseline), 0xC1 (SOF1 Extended), 0xC2 (SOF2 Progressive), 0xC3 (SOF3 Lossless)
    if (marker >= 0xC0 && marker <= 0xC3) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height, marker: '0x' + marker.toString(16).toUpperCase() };
    }
    if (offset + 3 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  throw new Error('SOF marker not found in JPEG file');
}

export function validateHtmlMetadata(htmlContent, distPath = distDir) {
  // Extract <head>...</head>
  const headMatch = htmlContent.match(/<head[\s\S]*?>([\s\S]*?)<\/head>/i);
  assert.ok(headMatch, 'HTML must contain a <head> block');
  const headContent = headMatch[1];

  // 1. Meta charset must be present and first in head
  const charsetMatch = headContent.match(/<meta\s+charset=["']utf-8["']/i);
  assert.ok(charsetMatch, 'Head must contain <meta charset="UTF-8"> (case-insensitive)');
  const charsetIndex = headContent.indexOf(charsetMatch[0]);

  // 2. Base href must be present
  const baseMatch = headContent.match(/<base\s+href=["']\/["']\s*\/?>/i);
  assert.ok(baseMatch, 'Head must contain <base href="/">');
  const baseIndex = headContent.indexOf(baseMatch[0]);
  assert.ok(charsetIndex < baseIndex, '<meta charset> must precede <base href="/">');

  // 3. Inline first-paint script must exist and contain tutorial and challenge gating logic
  const inlineScriptRegex = /<script>([\s\S]*?2048_rogue_tutorial_seen[\s\S]*?)<\/script>/;
  const inlineScriptMatch = headContent.match(inlineScriptRegex);
  assert.ok(inlineScriptMatch, 'Head must contain the inline first-paint gating script');
  assert.ok(inlineScriptMatch[1].includes('challenge-active'), 'Inline script must contain challenge-active gating');
  assert.ok(inlineScriptMatch[1].includes('tutorial-active'), 'Inline script must contain tutorial-active gating');
  const inlineScriptIndex = headContent.indexOf(inlineScriptMatch[0]);
  assert.ok(baseIndex < inlineScriptIndex, '<base href="/"> must precede inline gating script');

  // Helper to count occurrences of a tag or pattern
  function countMatches(str, regex) {
    const m = str.match(regex);
    return m ? m.length : 0;
  }

  // 4. Title tag
  const expectedTitle = 'Rogue 2048 — Outlast the grid';
  const titleMatches = headContent.match(/<title>([\s\S]*?)<\/title>/gi);
  assert.strictEqual(titleMatches ? titleMatches.length : 0, 1, 'Exactly one <title> tag must exist in <head>');
  assert.strictEqual(titleMatches[0], `<title>${expectedTitle}</title>`, `Title must equal "${expectedTitle}"`);
  const titleIndex = headContent.indexOf(titleMatches[0]);
  assert.ok(inlineScriptIndex < titleIndex, 'Inline first-paint script must precede <title>');

  // 5. Meta description
  const expectedDescription = 'A roguelike 2048. Permanent stones fill the board, relics change the rules, and everyone gets the same Daily seed. Can you outlast the grid?';
  assert.ok(expectedDescription.length <= 160, `Description length must be <= 160 (got ${expectedDescription.length})`);
  const descRegex = /<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>/i;
  const descMatches = headContent.match(new RegExp(descRegex.source, 'gi'));
  assert.strictEqual(descMatches ? descMatches.length : 0, 1, 'Exactly one meta description must exist in <head>');
  const descMatch = headContent.match(descRegex);
  assert.strictEqual(descMatch[1], expectedDescription, 'Meta description content must match expected text');
  const descIndex = headContent.indexOf(descMatch[0]);
  assert.ok(inlineScriptIndex < descIndex, 'Inline first-paint script must precede meta description');

  // 6. Meta robots (production)
  const robotsRegex = /<meta\s+name=["']robots["']\s+content=["']([\s\S]*?)["']\s*\/?>/i;
  const robotsMatches = headContent.match(new RegExp(robotsRegex.source, 'gi'));
  assert.strictEqual(robotsMatches ? robotsMatches.length : 0, 1, 'Exactly one meta robots must exist in <head>');
  const robotsMatch = headContent.match(robotsRegex);
  assert.strictEqual(robotsMatch[1], 'index,follow,max-image-preview:large', 'Meta robots must be "index,follow,max-image-preview:large"');
  assert.strictEqual(robotsMatch[1].includes('noindex'), false, 'Meta robots must not contain "noindex"');
  const robotsIndex = headContent.indexOf(robotsMatch[0]);
  assert.ok(inlineScriptIndex < robotsIndex, 'Inline first-paint script must precede meta robots');

  // 7. Theme-color
  const themeRegex = /<meta\s+name=["']theme-color["']\s+content=["']#100f11["']\s*\/?>/i;
  assert.strictEqual(countMatches(headContent, new RegExp(themeRegex.source, 'gi')), 1, 'Exactly one meta theme-color with #100f11 must exist');

  // 8. Canonical URL
  const canonicalRegex = /<link\s+rel=["']canonical["']\s+href=["']https:\/\/rogue2048\.vercel\.app\/["']\s*\/?>/i;
  assert.strictEqual(countMatches(headContent, new RegExp(canonicalRegex.source, 'gi')), 1, 'Canonical link must exist exactly once pointing to https://rogue2048.vercel.app/');
  const canonicalIndex = headContent.indexOf(headContent.match(canonicalRegex)[0]);
  assert.ok(inlineScriptIndex < canonicalIndex, 'Inline first-paint script must precede canonical link');

  // 9. Open Graph tags
  const expectedOg = {
    'og:type': 'website',
    'og:site_name': 'Rogue 2048',
    'og:title': 'Rogue 2048 — Outlast the grid',
    'og:description': expectedDescription,
    'og:url': 'https://rogue2048.vercel.app/',
    'og:image': 'https://rogue2048.vercel.app/og-image.jpg',
    'og:image:type': 'image/jpeg',
    'og:image:width': '1200',
    'og:image:height': '630',
    'og:image:alt': 'Rogue 2048: a rotated roguelike 2048 board next to the title and the line Outlast the grid',
    'og:locale': 'en_US',
  };

  for (const [prop, val] of Object.entries(expectedOg)) {
    const escapedProp = prop.replace(':', '\\:');
    const ogRegex = new RegExp(`<meta\\s+property=["']${escapedProp}["']\\s+content=["']([\\s\\S]*?)["']\\s*\\/?>`, 'i');
    const ogAll = headContent.match(new RegExp(ogRegex.source, 'gi'));
    assert.strictEqual(ogAll ? ogAll.length : 0, 1, `Open Graph tag "${prop}" must appear exactly once in <head>`);
    const m = headContent.match(ogRegex);
    assert.strictEqual(m[1], val, `Open Graph tag "${prop}" content must be "${val}", got "${m[1]}"`);
    const tagIndex = headContent.indexOf(m[0]);
    assert.ok(inlineScriptIndex < tagIndex, `Inline first-paint script must precede Open Graph tag ${prop}`);
  }

  // 10. Twitter tags
  const expectedTwitter = {
    'twitter:card': 'summary_large_image',
    'twitter:title': 'Rogue 2048 — Outlast the grid',
    'twitter:description': expectedDescription,
    'twitter:image': 'https://rogue2048.vercel.app/og-image.jpg',
    'twitter:image:alt': 'Rogue 2048: a rotated roguelike 2048 board next to the title and the line Outlast the grid',
  };

  for (const [name, val] of Object.entries(expectedTwitter)) {
    const escapedName = name.replace(':', '\\:');
    const twRegex = new RegExp(`<meta\\s+name=["']${escapedName}["']\\s+content=["']([\\s\\S]*?)["']\\s*\\/?>`, 'i');
    const twAll = headContent.match(new RegExp(twRegex.source, 'gi'));
    assert.strictEqual(twAll ? twAll.length : 0, 1, `Twitter tag "${name}" must appear exactly once in <head>`);
    const m = headContent.match(twRegex);
    assert.strictEqual(m[1], val, `Twitter tag "${name}" content must be "${val}", got "${m[1]}"`);
    const tagIndex = headContent.indexOf(m[0]);
    assert.ok(inlineScriptIndex < tagIndex, `Inline first-paint script must precede Twitter tag ${name}`);
  }

  // Verify og:image is absolute https URL
  assert.ok(expectedOg['og:image'].startsWith('https://rogue2048.vercel.app/'), 'og:image must be absolute https URL on rogue2048.vercel.app');
  assert.ok(expectedTwitter['twitter:image'].startsWith('https://rogue2048.vercel.app/'), 'twitter:image must be absolute https URL on rogue2048.vercel.app');

  // 11. Check that dist/og-image.jpg exists, dimensions match, size < 300000, and og-image.png does NOT exist
  const ogPngPath = path.join(distPath, 'og-image.png');
  assert.strictEqual(fs.existsSync(ogPngPath), false, `dist/og-image.png must NOT exist in dist`);

  const ogJpgPath = path.join(distPath, 'og-image.jpg');
  assert.ok(fs.existsSync(ogJpgPath), `og-image.jpg must exist in dist root at ${ogJpgPath}`);
  const ogJpgBuf = fs.readFileSync(ogJpgPath);
  assert.ok(ogJpgBuf.length < 300000, `og-image.jpg file size must be < 300000 bytes (got ${ogJpgBuf.length} bytes)`);
  const { width: realWidth, height: realHeight } = getJpegDimensions(ogJpgBuf);
  assert.strictEqual(String(realWidth), expectedOg['og:image:width'], `og:image:width (${expectedOg['og:image:width']}) must match image header width (${realWidth})`);
  assert.strictEqual(String(realHeight), expectedOg['og:image:height'], `og:image:height (${expectedOg['og:image:height']}) must match image header height (${realHeight})`);

  // 12. Check for external URLs in index.html (only rogue2048.vercel.app metadata URLs allowed; SVG xmlns preserved)
  const urlMatches = htmlContent.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  for (const u of urlMatches) {
    assert.ok(
      u.startsWith('https://rogue2048.vercel.app/') ||
      u === 'http://www.w3.org/2000/svg' ||
      u.startsWith('http://localhost') ||
      u.startsWith('http://127.0.0.1'),
      `No external URL allowed in production index.html other than rogue2048.vercel.app: found "${u}"`
    );
  }
}

export function validateRobotsTxt(distPath = distDir, robotsContent = null) {
  let content = robotsContent;
  if (content === null) {
    const robotsPath = path.join(distPath, 'robots.txt');
    assert.ok(fs.existsSync(robotsPath), `dist/robots.txt must exist at ${robotsPath}`);
    content = fs.readFileSync(robotsPath, 'utf8');
  }
  assert.ok(content.includes('User-agent: *'), 'robots.txt must contain "User-agent: *"');
  assert.ok(content.includes('Allow: /'), 'robots.txt must contain "Allow: /"');
  assert.strictEqual(/Disallow:\s*\/c/i.test(content), false, 'robots.txt must NOT contain any "Disallow: /c" rule');
  assert.ok(content.includes('Sitemap: https://rogue2048.vercel.app/sitemap.xml'), 'robots.txt must contain Sitemap link');
}

export function validateSitemapXml(distPath = distDir) {
  const sitemapPath = path.join(distPath, 'sitemap.xml');
  assert.ok(fs.existsSync(sitemapPath), `dist/sitemap.xml must exist at ${sitemapPath}`);
  const content = fs.readFileSync(sitemapPath, 'utf8');
  assert.ok(content.includes('<loc>https://rogue2048.vercel.app/</loc>'), 'sitemap.xml must contain homepage URL');
  const match = content.match(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/);
  assert.ok(match, 'sitemap.xml must contain lastmod with YYYY-MM-DD date');
  const lastmodStr = match[1];
  const lastmodDate = new Date(lastmodStr + 'T00:00:00Z');
  assert.ok(!isNaN(lastmodDate.getTime()), 'lastmod must be a valid date');
  const todayUtcStr = new Date().toISOString().slice(0, 10);
  assert.ok(lastmodStr <= todayUtcStr, `sitemap.xml lastmod (${lastmodStr}) must not be in the future (today is ${todayUtcStr})`);
}

export function validateVercelJson(configPath = path.join(rootDir, 'vercel.json')) {
  assert.ok(fs.existsSync(configPath), `vercel.json must exist at ${configPath}`);
  const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Must have /c/ rewrite
  assert.ok(Array.isArray(json.rewrites), 'vercel.json must have rewrites array');
  const chalRewrite = json.rewrites.find(r => r.source === '/c/:match*' && r.destination === '/index.html');
  assert.ok(chalRewrite, 'vercel.json must preserve rewrite { source: "/c/:match*", destination: "/index.html" }');

  // Must have /c/ X-Robots-Tag rule
  assert.ok(Array.isArray(json.headers), 'vercel.json must have headers array');
  const chalHeader = json.headers.find(h => (h.source === '/c/(.*)' || h.source === '/c/:match*' || h.source === '/c/*') &&
    Array.isArray(h.headers) &&
    h.headers.some(hdr => hdr.key.toLowerCase() === 'x-robots-tag' && hdr.value === 'noindex, nofollow')
  );
  assert.ok(chalHeader, 'vercel.json must contain header rule setting X-Robots-Tag: noindex, nofollow for /c/ paths');

  // Must NOT have noindex on homepage or global catch-all
  for (const h of json.headers) {
    if (h.source === '/(.*)' || h.source === '/' || h.source === '/index.html') {
      const hasNoindex = Array.isArray(h.headers) && h.headers.some(hdr => hdr.key.toLowerCase() === 'x-robots-tag' && hdr.value.includes('noindex'));
      assert.strictEqual(hasNoindex, false, `vercel.json rule for "${h.source}" must not set noindex`);
    }
  }
}

async function run() {
  console.log('================================================================================');
  console.log('PRE-LAUNCH METADATA & INDEXING VERIFICATION');
  console.log('================================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Check invariants
  const engineBytes = fs.readFileSync(path.join(rootDir, 'sim', 'engine.js'));
  const engineHash = crypto.createHash('sha256').update(engineBytes).digest('hex').toUpperCase();
  assert.strictEqual(engineHash, EXPECTED_ENGINE_HASH, `sim/engine.js SHA-256 must match ${EXPECTED_ENGINE_HASH}`);
  console.log(`✔ Verified sim/engine.js SHA-256: ${engineHash}`);

  const replayVer = computeReplayVersion(rootDir);
  assert.strictEqual(replayVer, EXPECTED_REPLAY_VERSION, `replayVersion must match ${EXPECTED_REPLAY_VERSION}`);
  console.log(`✔ Verified replayVersion:         ${replayVer}\n`);

  // CLI self-check fail trigger
  const failArg = process.argv.find(a => a.startsWith('--self-check-fail'));
  if (failArg) {
    console.log(`Running deliberate self-check failure for flag: ${failArg}`);
    const originalHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    if (failArg === '--self-check-fail=noindex' || failArg === '--self-check-fail') {
      const tampered = originalHtml.replace('index,follow,max-image-preview:large', 'noindex, nofollow');
      validateHtmlMetadata(tampered);
    } else if (failArg === '--self-check-fail=relative-image') {
      const tampered = originalHtml.replace('https://rogue2048.vercel.app/og-image.jpg', '/og-image.jpg');
      validateHtmlMetadata(tampered);
    } else if (failArg === '--self-check-fail=disallow-c') {
      const robotsContent = fs.readFileSync(path.join(distDir, 'robots.txt'), 'utf8') + '\nDisallow: /c/\n';
      validateRobotsTxt(distDir, robotsContent);
    } else if (failArg === '--self-check-fail=oversized-image') {
      const tempOversizedDist = path.join(rootDir, '.temp_cli_oversized_test');
      fs.mkdirSync(tempOversizedDist, { recursive: true });
      try {
        const realJpg = fs.readFileSync(path.join(distDir, 'og-image.jpg'));
        const oversizedBuf = Buffer.concat([realJpg, Buffer.alloc(300001 - realJpg.length)]);
        fs.writeFileSync(path.join(tempOversizedDist, 'og-image.jpg'), oversizedBuf);
        validateHtmlMetadata(originalHtml, tempOversizedDist);
      } finally {
        try { fs.rmSync(tempOversizedDist, { recursive: true, force: true }); } catch {}
      }
    } else {
      throw new Error(`Unknown self-check failure target: ${failArg}`);
    }
    return;
  }

  // 1. Build dist
  console.log('[Step 1] Building production target...');
  await build({ target: 'prod', distDir, rootDir });

  // 2. Validate dist/index.html
  console.log('\n[Step 2] Validating dist/index.html metadata and head ordering...');
  const distIndexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  validateHtmlMetadata(distIndexHtml, distDir);
  console.log('✔ dist/index.html tags, Open Graph, Twitter/X, and ordering verified.');

  // 3. Validate dist/robots.txt and dist/sitemap.xml
  console.log('\n[Step 3] Validating dist/robots.txt and dist/sitemap.xml...');
  validateRobotsTxt(distDir);
  console.log('✔ dist/robots.txt verified.');
  validateSitemapXml(distDir);
  console.log('✔ dist/sitemap.xml verified.');

  // 4. Validate vercel.json
  console.log('\n[Step 4] Validating vercel.json rewrites and headers...');
  validateVercelJson();
  console.log('✔ vercel.json verified.');

  // 5. Hermetic Self-Check (proving deliberate tampers fail)
  console.log('\n[Step 5] Running hermetic tamper self-checks (proving test catches invalid metadata)...');
  
  // Tamper 1: noindex in production build
  let caughtNoindex = false;
  try {
    const tamperedNoindex = distIndexHtml.replace('index,follow,max-image-preview:large', 'noindex, nofollow');
    validateHtmlMetadata(tamperedNoindex, distDir);
  } catch (err) {
    caughtNoindex = true;
    console.log(`  ✔ Tamper 1 (noindex restored): correctly caught failure (${err.message})`);
  }
  assert.strictEqual(caughtNoindex, true, 'Self-check MUST fail when noindex is present');

  // Tamper 2: relative og:image
  let caughtRelativeImage = false;
  try {
    const tamperedRelative = distIndexHtml.replace('https://rogue2048.vercel.app/og-image.jpg', '/og-image.jpg');
    validateHtmlMetadata(tamperedRelative, distDir);
  } catch (err) {
    caughtRelativeImage = true;
    console.log(`  ✔ Tamper 2 (relative og:image): correctly caught failure (${err.message})`);
  }
  assert.strictEqual(caughtRelativeImage, true, 'Self-check MUST fail when og:image is relative');

  // Tamper 3: Disallow: /c/ in robots.txt
  let caughtDisallowC = false;
  try {
    const distRobots = fs.readFileSync(path.join(distDir, 'robots.txt'), 'utf8');
    const tamperedRobots = distRobots + '\nDisallow: /c/\n';
    validateRobotsTxt(distDir, tamperedRobots);
  } catch (err) {
    caughtDisallowC = true;
    console.log(`  ✔ Tamper 3 (Disallow: /c/ restored): correctly caught failure (${err.message})`);
  }
  assert.strictEqual(caughtDisallowC, true, 'Self-check MUST fail when "Disallow: /c/" is present in robots.txt');

  // Tamper 4: oversized og-image.jpg (> 300000 bytes)
  let caughtOversizedImage = false;
  const tempOversizedDist = path.join(rootDir, '.temp_oversized_test');
  try {
    fs.mkdirSync(tempOversizedDist, { recursive: true });
    const realJpg = fs.readFileSync(path.join(distDir, 'og-image.jpg'));
    const oversizedBuf = Buffer.concat([realJpg, Buffer.alloc(300001 - realJpg.length)]);
    fs.writeFileSync(path.join(tempOversizedDist, 'og-image.jpg'), oversizedBuf);
    validateHtmlMetadata(distIndexHtml, tempOversizedDist);
  } catch (err) {
    caughtOversizedImage = true;
    console.log(`  ✔ Tamper 4 (oversized og-image.jpg > 300000 bytes): correctly caught failure (${err.message})`);
  } finally {
    try { fs.rmSync(tempOversizedDist, { recursive: true, force: true }); } catch {}
  }
  assert.strictEqual(caughtOversizedImage, true, 'Self-check MUST fail when og-image.jpg is >= 300000 bytes');

  // Tamper 5: future sitemap lastmod date (> today)
  let caughtFutureDate = false;
  const tempFutureDist = path.join(rootDir, '.temp_future_sitemap_test');
  try {
    fs.mkdirSync(tempFutureDist, { recursive: true });
    fs.writeFileSync(path.join(tempFutureDist, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://rogue2048.vercel.app/</loc><lastmod>2099-01-01</lastmod></url></urlset>');
    validateSitemapXml(tempFutureDist);
  } catch (err) {
    caughtFutureDate = true;
    console.log(`  ✔ Tamper 5 (future sitemap lastmod): correctly caught failure (${err.message})`);
  } finally {
    try { fs.rmSync(tempFutureDist, { recursive: true, force: true }); } catch {}
  }
  assert.strictEqual(caughtFutureDate, true, 'Self-check MUST fail when sitemap lastmod is in the future');

  console.log('\n================================================================================');
  console.log('ALL PRE-LAUNCH METADATA CHECKS PASSED');
  console.log('================================================================================\n');
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMain) {
  run().catch(err => {
    console.error(`\n❌ VERIFICATION FAILED: ${err.message}\n`, err.stack);
    process.exit(1);
  });
}
