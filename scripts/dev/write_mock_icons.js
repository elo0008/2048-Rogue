import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const mockHtml = fs.readFileSync(path.join(rootDir, 'design', 'index_updated.html'), 'utf8');
const relicIconsMatch = mockHtml.match(/const RELIC_ICONS = ({[\s\S]*?});/);
if (!relicIconsMatch) {
  console.error('Could not find RELIC_ICONS');
  process.exit(1);
}

const RELIC_ICONS = new Function(`return ${relicIconsMatch[1]};`)();

const FILE_MAP = {
  diagonal: 'diagonal_merge.svg',
  eraser: 'eraser.svg',
  rewind: 'rewind.svg',
  fault: 'fault_line.svg',
  mason: 'mason.svg',
  siphon: 'siphon.svg',
  shatter: 'shatter.svg',
  last: 'last_stand.svg',
};

const iconsDir = path.join(rootDir, 'game', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const [key, fileName] of Object.entries(FILE_MAP)) {
  const dataUri = RELIC_ICONS[key];
  if (!dataUri) {
    console.error(`Missing icon for ${key}`);
    continue;
  }
  const b64 = dataUri.replace(/^data:image\/svg\+xml;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  const targetPath = path.join(iconsDir, fileName);
  fs.writeFileSync(targetPath, buf);
  console.log(`Wrote ${fileName} (${buf.length} bytes)`);
}

console.log('✔ Successfully wrote all 8 mock gold icons to game/icons/');
