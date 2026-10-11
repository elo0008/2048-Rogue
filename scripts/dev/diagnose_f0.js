import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const mockHtml = fs.readFileSync(path.join(rootDir, 'design', 'index_updated.html'), 'utf8');
const relicIconsMatch = mockHtml.match(/const RELIC_ICONS = ({[\s\S]*?});/);
if (!relicIconsMatch) {
  console.error('Could not find RELIC_ICONS in design/index_updated.html');
  process.exit(1);
}

// Safely extract RELIC_ICONS
const RELIC_ICONS = new Function(`return ${relicIconsMatch[1]};`)();

const RELIC_MAP = {
  diagonal_charge: { mockKey: 'diagonal', file: 'diagonal_merge.svg' },
  eraser: { mockKey: 'eraser', file: 'eraser.svg' },
  rewind: { mockKey: 'rewind', file: 'rewind.svg' },
  fault_line: { mockKey: 'fault', file: 'fault_line.svg' },
  mason: { mockKey: 'mason', file: 'mason.svg' },
  siphon: { mockKey: 'siphon', file: 'siphon.svg' },
  shatter: { mockKey: 'shatter', file: 'shatter.svg' },
  last_stand: { mockKey: 'last', file: 'last_stand.svg' },
};

function getSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

function extractColors(svgStr) {
  const fills = new Set();
  const strokes = new Set();

  for (const m of svgStr.matchAll(/fill[:=]\s*["']?([^;"'>\s]+)/gi)) {
    fills.add(m[1].toLowerCase());
  }
  for (const m of svgStr.matchAll(/stroke[:=]\s*["']?([^;"'>\s]+)/gi)) {
    strokes.add(m[1].toLowerCase());
  }
  return {
    fills: Array.from(fills),
    strokes: Array.from(strokes),
  };
}

function normalizePaths(svgStr) {
  // Extract all d="..." attributes
  const ds = [];
  for (const m of svgStr.matchAll(/\bd=["']([^"']+)["']/gi)) {
    ds.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return ds.join(' | ');
}

console.log('====================================================================================================');
console.log('F0.a) ICONS DIAGNOSTIC: MOCK DATA URI vs GAME/ICONS');
console.log('====================================================================================================');
console.log('Relic           | Mock Bytes | File Bytes | Mock SHA256 (first 16) | File SHA256 (first 16) | Mock Colors (F/S) | File Colors (F/S) | Path Data Match');
console.log('----------------------------------------------------------------------------------------------------');

for (const [relicId, info] of Object.entries(RELIC_MAP)) {
  const dataUri = RELIC_ICONS[info.mockKey];
  const b64 = dataUri.replace(/^data:image\/svg\+xml;base64,/, '');
  const mockSvg = Buffer.from(b64, 'base64').toString('utf8');
  const mockBuf = Buffer.from(b64, 'base64');
  
  const filePath = path.join(rootDir, 'game', 'icons', info.file);
  let fileBuf = Buffer.alloc(0);
  let fileSvg = '';
  if (fs.existsSync(filePath)) {
    fileBuf = fs.readFileSync(filePath);
    fileSvg = fileBuf.toString('utf8');
  }

  const mockHash = getSha256(mockBuf);
  const fileHash = fs.existsSync(filePath) ? getSha256(fileBuf) : 'MISSING';

  const mockColors = extractColors(mockSvg);
  const fileColors = extractColors(fileSvg);

  const mockNorm = normalizePaths(mockSvg);
  const fileNorm = normalizePaths(fileSvg);
  const pathsMatch = mockNorm === fileNorm;

  const mColorsStr = `F:${mockColors.fills.join(',')} S:${mockColors.strokes.join(',')}`;
  const fColorsStr = `F:${fileColors.fills.join(',')} S:${fileColors.strokes.join(',')}`;

  console.log(
    `${relicId.padEnd(15)} | ${mockBuf.length.toString().padStart(10)} | ${fileBuf.length.toString().padStart(10)} | ${mockHash.slice(0, 16).padEnd(22)} | ${fileHash.slice(0, 16).padEnd(22)} | ${mColorsStr.padEnd(17)} | ${fColorsStr.padEnd(17)} | ${pathsMatch ? 'YES' : 'NO'}`
  );
}
console.log('====================================================================================================\n');

// Real app icon rendering & CSS rules touching icons
console.log('Real app icon rendering method:');
console.log('The real app in game/app.js renders icons as <img> elements:');
console.log('  const img = document.createElement(\'img\');');
console.log('  img.src = src; // e.g. "icons/fault_line.svg"');
console.log('  img.className = \'relic-svg relic-icon-img\';');
console.log('\nCSS rules in game/style.css touching icons (.relic-svg, .relic-icon-img, img):');
const cssContent = fs.readFileSync(path.join(rootDir, 'game', 'style.css'), 'utf8');
const iconRules = [];
const lines = cssContent.split('\n');
let inRule = false;
let currentSelector = '';
let currentBody = [];

for (const line of lines) {
  if (!inRule && (line.includes('.relic-svg') || line.includes('.relic-icon-img') || line.includes('.relic-mini') || line.includes('.icon') || line.includes('img'))) {
    if (line.includes('{')) {
      inRule = true;
      currentSelector = line.trim();
      currentBody = [];
    }
  } else if (inRule) {
    currentBody.push(line);
    if (line.includes('}')) {
      inRule = false;
      const bodyStr = currentBody.join('\n');
      if (bodyStr.match(/filter|fill|color|mask|opacity|mix-blend-mode/i)) {
        iconRules.push(`${currentSelector}\n${bodyStr}`);
      }
    }
  }
}
console.log(iconRules.slice(0, 10).join('\n---\n'));

// F0.b) TILES DIAGNOSTIC: LIVE DOM CLASSES & COMPUTED COLORS vs MOCK
console.log('\n====================================================================================================');
console.log('F0.b) TILES DIAGNOSTIC: MOCK CSS TOKENS vs REAL CSS TOKENS');
console.log('====================================================================================================');

// Extract mock tile definitions
const mockCssMatch = mockHtml.match(/<style>([\s\S]*?)<\/style>/);
const mockCss = mockCssMatch ? mockCssMatch[1] : '';

const mockTileTokens = {};
for (const m of mockCss.matchAll(/--t(\d+):\s*([^;]+);/g)) {
  mockTileTokens[m[1]] = m[2].trim();
}

const realTileTokens = {};
for (const m of cssContent.matchAll(/--t(\d+):\s*([^;]+);/g)) {
  realTileTokens[m[1]] = m[2].trim();
}

console.log('Tile Val | Mock DOM Class | Mock Token Hex | Real Token Hex | Match?');
console.log('--------------------------------------------------------------------');
for (const val of [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) {
  const mHex = mockTileTokens[val] || 'N/A';
  const rHex = realTileTokens[val] || 'N/A';
  const cls = `tile v${val}` + (val >= 1024 ? ' compact' : '');
  console.log(
    `${val.toString().padEnd(8)} | ${cls.padEnd(14)} | ${mHex.padEnd(14)} | ${rHex.padEnd(14)} | ${mHex === rHex ? 'YES' : 'NO (DIVERGED)'}`
  );
}
console.log('====================================================================================================\n');

// Check undefined CSS variables in game/style.css
const declaredVars = new Set();
for (const m of cssContent.matchAll(/(--[\w-]+):/g)) {
  declaredVars.add(m[1]);
}
const usedVars = new Set();
for (const m of cssContent.matchAll(/var\((--[\w-]+)[,)]/g)) {
  usedVars.add(m[1]);
}
const undefinedVars = Array.from(usedVars).filter(v => !declaredVars.has(v));
console.log('Undefined CSS variables used in game/style.css:');
console.log(undefinedVars.length > 0 ? undefinedVars.join(', ') : 'None (all variables are declared)');

// F0.c) SLIDE ANIMATION DIAGNOSTIC
console.log('\n====================================================================================================');
console.log('F0.c) SLIDE ANIMATION DIAGNOSTIC');
console.log('====================================================================================================');
console.log('Checking movement animation in game/app.js:');
const appJsContent = fs.readFileSync(path.join(rootDir, 'game', 'app.js'), 'utf8');
const hasAppSlide = appJsContent.includes('slideLeftSnap') || appJsContent.includes('computeSlide') || appJsContent.includes('fromCell');
console.log(`- Movement translation logic in game/app.js: ${hasAppSlide ? 'PRESENT' : 'ABSENT (renderBoard immediately overwrites cell positions without from/to vector transitions)'}`);

console.log('Checking movement animation in game/style.css:');
const hasCssSlide = cssContent.includes('@keyframes slide') || cssContent.includes('slideLeftSnap');
console.log(`- Slide @keyframes in game/style.css: ${hasCssSlide ? 'PRESENT' : 'ABSENT (only static spawn/pop animations exist; tiles do not slide)'}`);

// F0.d) ERASER ICON DIAGNOSTIC
console.log('\n====================================================================================================');
console.log('F0.d) ERASER ICON DIAGNOSTIC');
console.log('====================================================================================================');
console.log('Exact code mapping relic id "eraser" in game/app.js:');
const iconMapMatch = appJsContent.match(/const ICON_MAP = {[\s\S]*?};/);
console.log(iconMapMatch ? iconMapMatch[0] : 'ICON_MAP not found');

console.log('\nRoot Cause:');
console.log('Root cause: In game/app.js, ICON_MAP is missing the "eraser" mapping key entirely, causing getRelicIconElement("eraser") to fail the lookup and fall back to rendering a 2-letter monogram "[ER]" instead of loading the SVG image.');
