import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const origDir = path.join(rootDir, 'design', 'icons_original');
const gameDir = path.join(rootDir, 'game', 'icons');

/**
 * Exact color and attribute transformation discovered from unchanged reference icons:
 * - pagecolor="#ffffff"          -> pagecolor="#f7e7c8"
 * - bordercolor="#000000"        -> bordercolor="#f2c77e"
 * - inkscape:deskcolor="#d1d1d1" -> inkscape:deskcolor="#3b302b"
 * - fill:#000000                 -> fill:#f2c77e
 * - stroke:#000000               -> stroke:#f2c77e
 * - stroke:#ffffff               -> stroke:#f7e7c8
 */
export function recolorSvg(svgText) {
  // Normalize line endings to LF first to preserve clean formatting
  let result = svgText.replace(/\r\n/g, '\n');

  result = result
    .replaceAll('pagecolor="#ffffff"', 'pagecolor="#f7e7c8"')
    .replaceAll('bordercolor="#000000"', 'bordercolor="#f2c77e"')
    .replaceAll('inkscape:deskcolor="#d1d1d1"', 'inkscape:deskcolor="#3b302b"')
    .replaceAll('fill:#000000', 'fill:#f2c77e')
    .replaceAll('stroke:#000000', 'stroke:#f2c77e')
    .replaceAll('stroke:#ffffff', 'stroke:#f7e7c8');

  return result;
}

export function verifyUnchangedIcons() {
  const unchangedIcons = [
    'diagonal_merge',
    'eraser',
    'fault_line',
    'last_stand',
    'mason',
    'rewind',
    'shatter'
  ];

  console.log('Verifying recoloring pipeline against all unchanged reference icons:');
  const results = [];

  for (const name of unchangedIcons) {
    const origPath = path.join(origDir, `${name}.svg`);
    const gamePath = path.join(gameDir, `${name}.svg`);

    if (!fs.existsSync(origPath) || !fs.existsSync(gamePath)) {
      throw new Error(`Missing icon file for ${name}`);
    }

    const origContent = fs.readFileSync(origPath, 'utf8');
    const expectedGameContent = fs.readFileSync(gamePath, 'utf8').replace(/\r\n/g, '\n');
    const transformed = recolorSvg(origContent);

    const isMatch = (transformed === expectedGameContent);
    results.push({ name, isMatch, origLen: origContent.length, gameLen: expectedGameContent.length });

    console.log(`  - ${name.padEnd(16)}: ${isMatch ? '✔ BYTE-FOR-BYTE IDENTICAL' : '❌ MISMATCH'}`);
    if (!isMatch) {
      throw new Error(`Transformation mismatch for reference icon "${name}". Stopping.`);
    }
  }

  return results;
}

export function recolorIcon(name) {
  // 1. Verify byte-for-byte reproducibility on reference icons before proceeding
  verifyUnchangedIcons();

  const origPath = path.join(origDir, `${name}.svg`);
  const targetPath = path.join(gameDir, `${name}.svg`);

  if (!fs.existsSync(origPath)) {
    throw new Error(`Original icon not found at ${origPath}`);
  }

  console.log(`\nTransforming ${name}.svg from design/icons_original to game/icons...`);
  const origContent = fs.readFileSync(origPath, 'utf8');
  const transformed = recolorSvg(origContent);

  // Write with strict LF line endings
  fs.writeFileSync(targetPath, transformed, { encoding: 'utf8' });
  console.log(`✔ Successfully generated ${targetPath} (${Buffer.byteLength(transformed, 'utf8')} bytes, LF).`);
}

// CLI Execution
if (process.argv[1] && process.argv[1].includes('recolor_icon.js')) {
  const iconName = process.argv[2] || 'siphon';
  if (iconName === '--verify-only') {
    verifyUnchangedIcons();
  } else {
    recolorIcon(iconName);
  }
}
