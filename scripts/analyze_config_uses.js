import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const files = ['game/app.js', 'game/controller.js', 'game/slide.js'];

let report = '=== STATIC ANALYSIS: BARE CONFIG IDENTIFIERS ===\n\n';

for (const file of files) {
  report += `--------------------------------------------------\n`;
  report += `File: ${file}\n`;
  report += `--------------------------------------------------\n`;

  const content = fs.readFileSync(path.join(rootDir, file), 'utf-8');
  const lines = content.split('\n');

  let fileMatches = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Find identifier config not preceded by . or $ and not followed by alphanumeric
    const regex = /(?<![\w.\$])config(?![\w\$])/g;
    let m;
    while ((m = regex.exec(line)) !== null) {
      const col = m.index + 1;
      const trimmed = line.trim();
      // Skip pure comments
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
        continue;
      }

      fileMatches++;
      const lineNum = i + 1;

      // Determine enclosing function by scanning backwards for function keyword
      let enclosingFunc = 'top-level / module scope';
      for (let j = i; j >= 0; j--) {
        const prevLine = lines[j];
        const fnMatch = prevLine.match(/(?:function\s+([a-zA-Z0-9_$]+)|(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>)/);
        if (fnMatch) {
          enclosingFunc = fnMatch[1] || fnMatch[2] || 'anonymous function';
          break;
        }
      }

      // Determine where config is declared in that scope dynamically
      let declaration = 'MISSING';
      if (file === 'game/app.js') {
        if (enclosingFunc === 'getRelicOneLiner') {
          declaration = 'Parameter declared in getRelicOneLiner(relicId, config)';
        } else if (enclosingFunc === 'parseUrlOptions') {
          declaration = 'Local variable declared in parseUrlOptions (const config = { ... })';
        } else if (trimmed.includes('config: activeConfig')) {
          declaration = 'Property in destructuring (bound to activeConfig)';
        } else if (enclosingFunc === 'triggerShatterAnimation') {
          declaration = 'MISSING (bare config in triggerShatterAnimation)';
        } else if (enclosingFunc === 'handleMove') {
          declaration = 'MISSING (bare config in handleMove)';
        }
      } else if (file === 'game/controller.js') {
        if (trimmed.startsWith('config:')) {
          declaration = 'Property key in object literal (not an identifier reference)';
        }
      }

      report += `Line ${lineNum}:${col} | Enclosing function: ${enclosingFunc}\n`;
      report += `  Code: ${trimmed}\n`;
      report += `  Scope declaration: ${declaration}\n\n`;
    }
  }

  if (fileMatches === 0) {
    report += `No bare config identifiers found.\n\n`;
  }
}

const outputFile = path.join(outDir, 'config_uses.txt');
fs.writeFileSync(outputFile, report, 'utf-8');
console.log(`Wrote config uses report to ${outputFile}`);
console.log(report);
