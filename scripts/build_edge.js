import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeRulesVersion, computeReplayVersion } from '../verify/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const VENDOR_FILES = [
  'verify/verify_run.js',
  'verify/profile.js',
  'game/controller.js',
  'sim/engine.js',
  'sim/relics.js',
];

const VENDOR_DIRS = [
  path.join(rootDir, 'supabase', 'functions', 'submit-run', 'vendor'),
  path.join(rootDir, 'supabase', 'functions', 'create-challenge', 'vendor'),
];

export function buildEdgeVendor() {
  console.log('[build_edge] Bundling edge runtime verification vendor files...');

  const rulesVersion = computeRulesVersion(rootDir);
  const replayVersion = computeReplayVersion(rootDir);
  let lastManifest = null;

  for (const vendorBaseDir of VENDOR_DIRS) {
    if (!fs.existsSync(vendorBaseDir)) {
      fs.mkdirSync(vendorBaseDir, { recursive: true });
    }

    const manifestFiles = {};

    for (const relPath of VENDOR_FILES) {
      const srcPath = path.join(rootDir, relPath);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Source file missing: ${srcPath}`);
      }

      const srcContent = fs.readFileSync(srcPath);
      const srcHash = crypto.createHash('sha256').update(srcContent).digest('hex').toUpperCase();

      const destPath = path.join(vendorBaseDir, relPath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.writeFileSync(destPath, srcContent);

      // Verify byte-for-byte copy
      const destContent = fs.readFileSync(destPath);
      const destHash = crypto.createHash('sha256').update(destContent).digest('hex').toUpperCase();

      if (srcHash !== destHash) {
        throw new Error(`Hash mismatch after copying ${relPath}: expected ${srcHash}, got ${destHash}`);
      }

      manifestFiles[relPath] = destHash;
      console.log(`  ✔ Copied ${relPath} to ${path.relative(rootDir, vendorBaseDir)} (${destContent.length} bytes, SHA256: ${destHash.slice(0, 16)}...)`);
    }

    const manifest = {
      rulesVersion,
      replayVersion,
      files: manifestFiles,
      generatedAt: new Date().toISOString(),
    };

    const manifestPath = path.join(vendorBaseDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`  ✔ Generated ${path.relative(rootDir, manifestPath)} (rulesVersion: ${rulesVersion.slice(0, 16)}..., replayVersion: ${replayVersion.slice(0, 16)}...)`);
    lastManifest = manifest;
  }

  return lastManifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    buildEdgeVendor();
    console.log('[build_edge] Vendor build successful.');
  } catch (err) {
    console.error('[build_edge] Vendor build failed:', err);
    process.exit(1);
  }
}

