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

const cssPath = path.join(rootDir, 'game', 'style.css');
const htmlPath = path.join(rootDir, 'game', 'index.html');

const cssContent = fs.readFileSync(cssPath, 'utf8');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// Parse style.css for font-size declarations
const lines = cssContent.split('\n');
const results = [];

let currentRuleSelectors = [];
let insideRule = false;
let ruleStart = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('{')) {
    const parts = line.split('{');
    currentRuleSelectors.push(parts[0].trim());
    insideRule = true;
    ruleStart = i;
  }
  const m = line.match(/font-size:\s*([^;]+);/);
  if (m) {
    const rawVal = m[1].trim();
    let px = null;
    const pxMatch = rawVal.match(/^(\d+(\.\d+)?)px$/);
    if (pxMatch) px = parseFloat(pxMatch[1]);
    
    // Check if below 11px
    if (px !== null && px < 11) {
      let selLines = [];
      let j = ruleStart;
      while (j >= 0) {
        const l = lines[j];
        if (l.includes('}') && j !== ruleStart) break;
        selLines.unshift(l);
        if (j < ruleStart && (lines[j].includes('{') || lines[j].includes('*/'))) break;
        j--;
      }
      const rawSel = selLines.join(' ').replace(/\{[\s\S]*/, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
      results.push({
        file: 'game/style.css',
        line: i + 1,
        selector: rawSel,
        value: rawVal,
        px,
      });
    }
  }
  if (line.includes('}')) {
    insideRule = false;
    currentRuleSelectors = [];
  }
}

// Check index.html for font-size
const htmlLines = htmlContent.split('\n');
for (let i = 0; i < htmlLines.length; i++) {
  const line = htmlLines[i];
  const m = line.match(/font-size:\s*([^;"]+)/);
  if (m) {
    const rawVal = m[1].trim();
    let px = null;
    const pxMatch = rawVal.match(/^(\d+(\.\d+)?)px$/);
    if (pxMatch) px = parseFloat(pxMatch[1]);
    if (px !== null && px < 11) {
      results.push({
        file: 'game/index.html',
        line: i + 1,
        selector: 'inline style',
        value: rawVal,
        px,
      });
    }
  }
}

// Annotation of where each is used and classification
function annotate(item) {
  const sel = item.selector;
  if (sel.includes('.relic-mini') && !sel.includes('ownedicons')) {
    return { usage: 'passive icon fallback monogram', type: 'decorative glyph inside icon (exempt)' };
  }
  if (sel.includes('.relic-monogram')) {
    return { usage: 'decorative monogram inside passive icon', type: 'decorative glyph inside icon (exempt)' };
  }
  if (sel.includes('.stat label') || sel.includes('.stat-label')) {
    return { usage: 'stat card labels (SCORE, MOVES, BEST)', type: 'functional' };
  }
  if (sel.includes('.candidate') || sel.includes('target-candidate')) {
    return { usage: 'PAIR badge pill in diagonal targeting', type: 'functional' };
  }
  if (sel.includes('.valid') || sel.includes('target-partner')) {
    return { usage: 'MERGE badge pill in diagonal targeting', type: 'functional' };
  }
  if (sel.includes('.mason') || sel.includes('mason-candidate')) {
    return { usage: 'PLACE badge pill on cell in mason mode', type: 'functional' };
  }
  if (sel.includes('.status') || sel.includes('.status-hint-bar')) {
    return { usage: 'status line & action hint bar', type: 'functional' };
  }
  if (sel.includes('.cancel') || sel.includes('.btn-cancel-targeting')) {
    return { usage: 'cancel targeting button pill', type: 'functional' };
  }
  if (sel.includes('.ability .icon') || sel.includes('.ability-btn-icon-wrap')) {
    return { usage: 'active ability icon monogram fallback', type: 'decorative glyph inside icon (exempt)' };
  }
  if (sel.includes('.ability .name')) {
    return { usage: 'ability button label (e.g. DIAGONAL MERGE)', type: 'functional' };
  }
  if (sel.includes('.refill') || sel.includes('.ability-btn-cooldown')) {
    return { usage: 'ability cooldown refill rate text', type: 'functional' };
  }
  if (sel.includes('.bottomhint')) {
    return { usage: 'bottom hint disclaimer text', type: 'functional' };
  }
  if (sel.includes('.tooltip') || sel.includes('.relic-popover')) {
    return { usage: 'relic tooltip / popover bubble body', type: 'functional' };
  }
  if (sel.includes('.popover-desc')) {
    return { usage: 'popover description text', type: 'functional' };
  }
  if (sel.includes('.eyebrow')) {
    return { usage: 'overlay eyebrow category text', type: 'functional' };
  }
  if (sel.includes('.best')) {
    return { usage: 'start overlay best score label', type: 'functional' };
  }
  if (sel.includes('.foot') || sel.includes('.start-build-footer')) {
    return { usage: 'build ID footer label', type: 'functional' };
  }
  if (sel.includes('.ddesc') || sel.includes('.draft-offer-desc')) {
    return { usage: 'draft offer card description text', type: 'functional' };
  }
  if (sel.includes('.tag')) {
    return { usage: 'draft offer card tag pill', type: 'functional' };
  }
  if (sel.includes('.owned summary')) {
    return { usage: 'draft screen owned relics toggle summary', type: 'functional' };
  }
  if (sel.includes('.ownedicons .art') || sel.includes('.ownedicons .relic-mini')) {
    return { usage: 'owned relics list miniature monogram', type: 'decorative glyph inside icon (exempt)' };
  }
  if (sel.includes('.newbest') || sel.includes('.badge-new-best')) {
    return { usage: 'game over NEW BEST badge pill', type: 'functional' };
  }
  if (sel.includes('.finalstat small') || sel.includes('.summary-label')) {
    return { usage: 'game over stat card labels', type: 'functional' };
  }
  if (sel.includes('.mini span')) {
    return { usage: 'game over mini board cell glyphs', type: 'decorative glyph inside icon (exempt)' };
  }
  if (sel.includes('.stand-subtitle') || sel.includes('.stand p')) {
    return { usage: 'last stand banner text', type: 'functional' };
  }
  return { usage: 'other text', type: 'functional' };
}

let out = '================================== FONT-SIZE DECLARATIONS BELOW 11px ==================================\n';
out += 'File:Line        | Current | Type       | Selector / Location                                | Usage Description\n';
out += '--------------------------------------------------------------------------------------------------------------------\n';

for (const r of results) {
  const ann = annotate(r);
  const loc = `${r.file}:${r.line}`.padEnd(16);
  const val = `${r.value}`.padEnd(7);
  const typ = (ann.type.includes('exempt') ? 'EXEMPT' : 'FUNCTIONAL').padEnd(10);
  const sel = r.selector.slice(0, 50).padEnd(50);
  const usg = ann.usage;
  out += `${loc} | ${val} | ${typ} | ${sel} | ${usg}\n`;
}
out += '====================================================================================================================\n';

fs.writeFileSync(path.join(outDir, 'font_sizes_below_11px.txt'), out, 'utf8');
console.log(out);
