import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const iconsDir = path.join(rootDir, 'game', 'icons');

import { RELIC_IDS } from '../sim/relics.js';

const ALIASES = {
  diagonal_charge: ['diagonal_charge', 'diagonal', 'diagonal_merge', 'merge'],
  eraser: ['eraser', 'erase'],
  rewind: ['rewind', 'undo'],
  fault_line: ['fault_line', 'faultline', 'fault'],
  mason: ['mason'],
  siphon: ['siphon'],
  shatter: ['shatter'],
  last_stand: ['last_stand', 'laststand'],
};

export function getIconMapping() {
  const files = fs.existsSync(iconsDir) ? fs.readdirSync(iconsDir) : [];
  const mapping = {};
  const unmapped = [];

  // Consider all known relics
  for (const relic of RELIC_IDS) {
    const aliasList = ALIASES[relic] || [relic];
    let matchedFile = null;

    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!['.svg', '.png', '.webp'].includes(ext)) continue;
      const baseName = path.basename(f, ext).toLowerCase();
      if (aliasList.some(alias => alias.toLowerCase() === baseName)) {
        matchedFile = f;
        break;
      }
    }

    if (matchedFile) {
      const filePath = path.join(iconsDir, matchedFile);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      let pixelSize = 'vector (scalable)';
      const vbMatch = content.match(/viewBox=["']([^"']+)["']/);
      const wMatch = content.match(/width=["']([^"']+)["']/);
      const hMatch = content.match(/height=["']([^"']+)["']/);
      
      if (vbMatch) {
        const parts = vbMatch[1].trim().split(/[\s,]+/);
        if (parts.length === 4) {
          pixelSize = `${Math.round(parseFloat(parts[2]))}x${Math.round(parseFloat(parts[3]))} (viewBox)`;
        }
      } else if (wMatch && hMatch) {
        pixelSize = `${wMatch[1]}x${hMatch[1]}`;
      }

      mapping[relic] = {
        relic,
        file: matchedFile,
        pixelSize,
        bytes: stat.size,
      };
    } else {
      unmapped.push(relic);
    }
  }

  return { mapping, unmapped };
}

export function printIconTable() {
  const { mapping, unmapped } = getIconMapping();
  console.log('\n================================ ICON MAPPING TABLE ================================');
  console.log('Relic                | File                 | Pixel Size           | Bytes');
  console.log('------------------------------------------------------------------------------------');
  for (const [relic, info] of Object.entries(mapping)) {
    console.log(
      `${relic.padEnd(20)} | ${info.file.padEnd(20)} | ${info.pixelSize.padEnd(20)} | ${info.bytes.toString().padStart(6)} B`
    );
  }
  console.log('====================================================================================');
  console.log('Relics with NO ICON (fallback to 2-letter monogram in rounded square):');
  for (const r of unmapped) {
    const mono = r.slice(0, 2).toUpperCase();
    console.warn(`  ⚠ [WARN] No icon for "${r}" -> rendering fallback monogram "[${mono}]" in rounded square`);
  }
  console.log('====================================================================================\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase().includes(path.basename(process.argv[1]).toLowerCase());
if (isMain) {
  printIconTable();
}
