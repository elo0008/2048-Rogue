import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { computeIconMetrics } from './icon_metrics.js';
import { findChrome } from './find_chrome.js';
import { computeReplayVersion } from '../verify/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

export function validateAndProcessLabMarkers(code, target) {
  const beginRegex = /\/\*DEV_LAB_BEGIN\*\//g;
  const endRegex = /\/\*DEV_LAB_END\*\//g;

  const beginMatches = [...code.matchAll(beginRegex)];
  const endMatches = [...code.matchAll(endRegex)];

  if (beginMatches.length !== endMatches.length) {
    throw new Error(`[BUILD ERROR] Unbalanced DEV_LAB markers: ${beginMatches.length} BEGIN vs ${endMatches.length} END`);
  }

  const combined = [];
  for (const m of beginMatches) combined.push({ type: 'BEGIN', index: m.index });
  for (const m of endMatches) combined.push({ type: 'END', index: m.index });
  combined.sort((a, b) => a.index - b.index);

  let inBlock = false;
  for (const token of combined) {
    if (token.type === 'BEGIN') {
      if (inBlock) throw new Error(`[BUILD ERROR] Nested DEV_LAB_BEGIN marker found at offset ${token.index}`);
      inBlock = true;
    } else {
      if (!inBlock) throw new Error(`[BUILD ERROR] Unmatched DEV_LAB_END marker found at offset ${token.index}`);
      inBlock = false;
    }
  }

  if (target === 'prod') {
    code = code.replace(/\/\*DEV_LAB_BEGIN\*\/[\s\S]*?\/\*DEV_LAB_END\*\//g, '');
    const forbidden = ['/*DEV_LAB', 'lab.js', 'labApi', 'labPhase'];
    for (const f of forbidden) {
      if (code.includes(f)) {
        throw new Error(`[BUILD ERROR] Forbidden lab token "${f}" found in production build!`);
      }
    }
  }

  return code;
}

export function validateLeaderboardConfig(rawUrl, rawKey) {
  if (!rawUrl && !rawKey) return null;
  if (!rawUrl || !rawKey) {
    throw new Error('[BUILD ERROR] Both LEADERBOARD_URL and LEADERBOARD_ANON_KEY must be provided, or neither.');
  }
  const url = rawUrl.trim();
  const key = rawKey.trim();

  // URL validation: https://<ref>.supabase.co or http://localhost[:port]
  const cleanUrl = url.replace(/\/+$/, '');
  const isSupabase = /^https:\/\/[a-z0-9_-]+\.supabase\.co$/i.test(cleanUrl);
  const isLocalhost = /^http:\/\/localhost(?::\d+)?$/i.test(cleanUrl);
  if (!isSupabase && !isLocalhost) {
    throw new Error(`[BUILD ERROR] Invalid LEADERBOARD_URL "${url}". Must be https://<ref>.supabase.co or http://localhost[:port]`);
  }

  // Key validation:
  if (key.startsWith('sb_secret_')) {
    throw new Error('[BUILD ERROR] LEADERBOARD_ANON_KEY must not be a service-role/secret key (starts with "sb_secret_").');
  }

  if (key.startsWith('sb_publishable_')) {
    return { url: cleanUrl, anonKey: key };
  }

  // Check if JWT (3 parts separated by '.')
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload.role !== 'anon') {
        throw new Error(`[BUILD ERROR] LEADERBOARD_ANON_KEY JWT role must be "anon", got "${payload.role}". Do NOT use service-role key.`);
      }
      return { url: cleanUrl, anonKey: key };
    } catch (e) {
      if (e.message.startsWith('[BUILD ERROR]')) throw e;
      throw new Error(`[BUILD ERROR] Failed to decode LEADERBOARD_ANON_KEY JWT: ${e.message}`);
    }
  }

  throw new Error('[BUILD ERROR] LEADERBOARD_ANON_KEY must be a valid Supabase anon JWT or sb_publishable_ key.');
}

export function computeGameContentHash(dir = path.join(rootDir, 'game')) {
  const gameFiles = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const hash = crypto.createHash('sha256');
  for (const f of gameFiles) {
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return hash.digest('hex').slice(0, 8);
}

export async function build(options = {}) {
  const target = options.target || process.env.BUILD_TARGET || (process.argv[2] === 'dev' ? 'dev' : 'prod');
  const isDev = target === 'dev';

  // DEV BUILD GUARD
  if (isDev) {
    const vercelEnv = process.env.VERCEL_ENV || '';
    let gitBranch = process.env.VERCEL_GIT_COMMIT_REF || '';
    if (!gitBranch) {
      try {
        gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
      } catch {}
    }
    if (vercelEnv === 'production' || gitBranch === 'main') {
      const reason = vercelEnv === 'production'
        ? `VERCEL_ENV is 'production'`
        : `git branch is 'main' (VERCEL_GIT_COMMIT_REF='${process.env.VERCEL_GIT_COMMIT_REF || ''}', git branch='${gitBranch}')`;
      const msg = `[BUILD GUARD ERROR] Dev target build is forbidden when VERCEL_ENV === 'production' or on branch 'main'. Rejected: ${reason}`;
      console.error(`\n${msg}\n`);
      throw new Error(msg);
    }
  }

  const targetDistDir = options.distDir || (isDev ? (process.env.VERCEL ? path.join(rootDir, 'dist') : path.join(rootDir, 'dist-dev')) : distDir);
  const targetRootDir = options.rootDir || rootDir;
  console.log(`Building target "${target}" in ${path.relative(rootDir, targetDistDir) || 'dist/'} ...`);

  // Verify or regenerate icon metrics
  const iconsSrcDir = path.join(targetRootDir, 'game', 'icons');
  const iconMetricsFile = path.join(iconsSrcDir, 'icon_metrics.json');
  const svgFiles = fs.existsSync(iconsSrcDir)
    ? fs.readdirSync(iconsSrcDir).filter(f => f.endsWith('.svg')).sort()
    : [];

  let metricsValid = false;
  if (fs.existsSync(iconMetricsFile)) {
    try {
      const currentMetrics = JSON.parse(fs.readFileSync(iconMetricsFile, 'utf-8'));
      const metricsKeys = Object.keys(currentMetrics).sort();
      const expectedKeys = svgFiles.map(f => f.replace('.svg', '')).sort();

      if (JSON.stringify(metricsKeys) === JSON.stringify(expectedKeys)) {
        metricsValid = true;
        for (const f of svgFiles) {
          const relic = f.replace('.svg', '');
          const content = fs.readFileSync(path.join(iconsSrcDir, f));
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          if (!currentMetrics[relic] || currentMetrics[relic].sha256 !== hash) {
            metricsValid = false;
            break;
          }
        }
      }
    } catch {
      metricsValid = false;
    }
  }

  if (!metricsValid) {
    const chromePath = findChrome();
    if (chromePath) {
      console.log('Icon metrics stale or missing, regenerating with Chrome...');
      await computeIconMetrics(0);
    } else {
      console.error('icon_metrics.json is stale: run `npm run icons` locally and commit it');
      process.exit(1);
    }
  } else {
    console.log('Icon metrics are verified and up to date.');
  }

  // Generate buildId from build timestamp + short content hash of game/*.js
  const contentHash = computeGameContentHash(path.join(targetRootDir, 'game'));
  const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().replace(/[:.]/g, '-')
    : new Date().toISOString().replace(/[:.]/g, '-');
  const buildId = `build_${timestamp}_${contentHash}`;
  console.log(`Generated buildId: ${buildId}`);

  const replayVersion = computeReplayVersion(targetRootDir);
  console.log(`Computed replayVersion: ${replayVersion}`);

  // Clean or create dist
  if (fs.existsSync(targetDistDir)) {
    fs.rmSync(targetDistDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDistDir, { recursive: true });

  // Copy index.html with buildId replacement
  let indexHtml = fs.readFileSync(path.join(targetRootDir, 'game', 'index.html'), 'utf-8');
  indexHtml = indexHtml.replaceAll('__BUILD_ID__', buildId);
  fs.writeFileSync(path.join(targetDistDir, 'index.html'), indexHtml, 'utf-8');

  // Copy style.css
  const styleCss = fs.readFileSync(path.join(targetRootDir, 'game', 'style.css'), 'utf-8');
  fs.writeFileSync(path.join(targetDistDir, 'style.css'), styleCss, 'utf-8');

  // Copy app.js with buildId and replayVersion replacement
  let appJs = fs.readFileSync(path.join(targetRootDir, 'game', 'app.js'), 'utf-8');
  appJs = validateAndProcessLabMarkers(appJs, target);
  appJs = appJs.replaceAll('__BUILD_ID__', buildId).replaceAll('__REPLAY_VERSION__', replayVersion);
  fs.writeFileSync(path.join(targetDistDir, 'app.js'), appJs, 'utf-8');

  // Copy controller.js and adjust imports to self-contained relative paths
  let controllerJs = fs.readFileSync(path.join(targetRootDir, 'game', 'controller.js'), 'utf-8');
  controllerJs = controllerJs
    .replace(/from\s+['"]\.\.\/sim\/engine\.js['"]/g, "from './engine.js'")
    .replace(/from\s+['"]\.\.\/sim\/relics\.js['"]/g, "from './relics.js'")
    .replaceAll('__BUILD_ID__', buildId)
    .replaceAll('__REPLAY_VERSION__', replayVersion);
  fs.writeFileSync(path.join(targetDistDir, 'controller.js'), controllerJs, 'utf-8');

  // Copy engine.js
  const engineJs = fs.readFileSync(path.join(targetRootDir, 'sim', 'engine.js'), 'utf-8');
  fs.writeFileSync(path.join(targetDistDir, 'engine.js'), engineJs, 'utf-8');

  // Copy relics.js
  const relicsJs = fs.readFileSync(path.join(targetRootDir, 'sim', 'relics.js'), 'utf-8');
  fs.writeFileSync(path.join(targetDistDir, 'relics.js'), relicsJs, 'utf-8');

  // Copy slide.js
  const slideJs = fs.readFileSync(path.join(targetRootDir, 'game', 'slide.js'), 'utf-8');
  fs.writeFileSync(path.join(targetDistDir, 'slide.js'), slideJs, 'utf-8');

  // Copy audio.js
  if (fs.existsSync(path.join(targetRootDir, 'game', 'audio.js'))) {
    const audioJs = fs.readFileSync(path.join(targetRootDir, 'game', 'audio.js'), 'utf-8');
    fs.writeFileSync(path.join(targetDistDir, 'audio.js'), audioJs, 'utf-8');
  }

  // Copy daily.js
  if (fs.existsSync(path.join(targetRootDir, 'game', 'daily.js'))) {
    const dailyJs = fs.readFileSync(path.join(targetRootDir, 'game', 'daily.js'), 'utf-8');
    fs.writeFileSync(path.join(targetDistDir, 'daily.js'), dailyJs, 'utf-8');
  }

  // Copy leaderboard.js
  if (fs.existsSync(path.join(targetRootDir, 'game', 'leaderboard.js'))) {
    const leaderboardJs = fs.readFileSync(path.join(targetRootDir, 'game', 'leaderboard.js'), 'utf-8');
    fs.writeFileSync(path.join(targetDistDir, 'leaderboard.js'), leaderboardJs, 'utf-8');
  }

  // Generate and emit leaderboard-config.js (ALWAYS emitted)
  const lbConfig = validateLeaderboardConfig(
    options.leaderboardUrl ?? process.env.LEADERBOARD_URL,
    options.leaderboardAnonKey ?? process.env.LEADERBOARD_ANON_KEY
  );
  const lbConfigJs = lbConfig
    ? `window.__LB = ${JSON.stringify(lbConfig)};\n`
    : `window.__LB = null;\n`;
  fs.writeFileSync(path.join(targetDistDir, 'leaderboard-config.js'), lbConfigJs, 'utf-8');

  // Copy icons directory to dist/icons
  const iconsDistDir = path.join(targetDistDir, 'icons');
  if (fs.existsSync(iconsSrcDir)) {
    fs.mkdirSync(iconsDistDir, { recursive: true });
    for (const f of fs.readdirSync(iconsSrcDir)) {
      fs.copyFileSync(path.join(iconsSrcDir, f), path.join(iconsDistDir, f));
    }
  }

  // Copy favicon.svg
  const faviconSrc = path.join(targetRootDir, 'game', 'favicon.svg');
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(targetDistDir, 'favicon.svg'));
  }

  // Copy fonts directory to dist/fonts
  const fontsSrcDir = path.join(targetRootDir, 'game', 'fonts');
  const fontsDistDir = path.join(targetDistDir, 'fonts');
  if (fs.existsSync(fontsSrcDir)) {
    fs.mkdirSync(fontsDistDir, { recursive: true });
    for (const f of fs.readdirSync(fontsSrcDir)) {
      fs.copyFileSync(path.join(fontsSrcDir, f), path.join(fontsDistDir, f));
    }
  }

  // Copy game/dev directory ONLY if target is dev
  if (target === 'dev') {
    const devSrcDir = path.join(targetRootDir, 'game', 'dev');
    const devDistDir = path.join(targetDistDir, 'dev');
    if (fs.existsSync(devSrcDir)) {
      fs.mkdirSync(devDistDir, { recursive: true });
      for (const f of fs.readdirSync(devSrcDir)) {
        fs.copyFileSync(path.join(devSrcDir, f), path.join(devDistDir, f));
      }
    }
  }

  // Calculate real total size recursively
  function getDirSizeBytes(dir) {
    let bytes = 0;
    for (const item of fs.readdirSync(dir)) {
      const p = path.join(dir, item);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        bytes += getDirSizeBytes(p);
      } else {
        bytes += stat.size;
      }
    }
    return bytes;
  }

  const totalBytes = getDirSizeBytes(targetDistDir);
  const totalKb = (totalBytes / 1024).toFixed(2);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(3);

  console.log('\n--- Dist Files ---');
  function logDirFiles(dir, prefix = '') {
    for (const item of fs.readdirSync(dir)) {
      const p = path.join(dir, item);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        logDirFiles(p, path.join(prefix, item));
      } else {
        const relPath = path.join(prefix, item);
        console.log(`  ${relPath.padEnd(25)} : ${stat.size.toLocaleString().padStart(8)} bytes (${(stat.size / 1024).toFixed(2)} KB)`);
      }
    }
  }
  logDirFiles(targetDistDir);

  console.log('------------------');
  console.log(`Total dist/ size: ${totalBytes.toLocaleString()} bytes (${totalKb} KB / ${totalMb} MB)`);

  if (totalBytes < 1024 * 1024) {
    console.log('✔ Bundle size is under 1 MB limit.\n');
  } else {
    console.warn('⚠ WARNING: Bundle size exceeds 1 MB limit!\n');
  }

  return { totalBytes, buildId, contentHash };
}

const isMain = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (isMain) {
  const target = process.env.BUILD_TARGET || (process.argv[2] === 'dev' ? 'dev' : 'prod');
  await build({ target });
}
