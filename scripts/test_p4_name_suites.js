// scripts/test_p4_name_suites.js
// Implements P4 honest name testing:
// P4(a): names_allowlist_dependency.txt (185 false-positive names with and without allowlist)
// P4(b): Multi-token / handle suite (>=120 harmless names not added to allowlist beforehand)
// P4(c): Held-out run (public first-names list and English word list from raw.githubusercontent.com)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNameDetailed } from '../supabase/functions/set-name/names.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');
const heldoutDir = path.join(outDir, 'heldout');

if (!fs.existsSync(heldoutDir)) {
  fs.mkdirSync(heldoutDir, { recursive: true });
}

// -----------------------------------------------------------------------------
// P4(a): 185 Current False-Positive Names (Dependency Report)
// -----------------------------------------------------------------------------
const HARMLESS_NAMES_185 = [
  // 1. Mandatory seed list (66 names/words)
  'Madhav', 'Krishna', 'Sandeep', 'Chandran', 'Anand', 'Pandian', 'Randeep', 'Mallika', 'Poornima',
  'Kunjumon', 'Appu', 'Achu', 'Cherian', 'Thomas', 'Manikandan', 'Gopalakrishnan', 'Ramanathan',
  'Suresh', 'Mahesh', 'Dinesh', 'Rajesh', 'Shibu', 'Anoop', 'Arun', 'Vishnu', 'Akhil', 'Athul',
  'Nithin', 'Sreejith', 'Jithin', 'Ajith', 'Rahul', 'Abhijith', 'Devika', 'Lakshmi', 'Parvathy',
  'Anjali', 'Meera', 'Kochi', 'Thrissur', 'Kerala', 'Trivandrum', 'Calicut', 'Mallu', 'Nair',
  'Menon', 'Pillai', 'Iyer', 'Kuttan', 'Sumesh', 'Class', 'Scunthorpe', 'Cassandra', 'Shiitake',
  'Titan', 'Hello', 'Shell', 'Analytics', 'Passage', 'Bassoon', 'Pushpa', 'Gandhi', 'Sachin',
  'Kohli', 'Dhoni', 'Rohit',

  // 2. Additional Indian First Names & Surnames (54)
  'Aditya', 'Akash', 'Amit', 'Amrita', 'Anil', 'Aparna', 'Arvind', 'Ashok', 'Deepak', 'Gautam',
  'Harish', 'Kavita', 'Kiran', 'Manish', 'Mukesh', 'Naveen', 'Neha', 'Nikhil', 'Pooja', 'Pradeep',
  'Prakash', 'Prashant', 'Praveen', 'Priya', 'Radhika', 'Rakesh', 'Ramesh', 'Rohan', 'Sanjay',
  'Santosh', 'Sarita', 'Shankar', 'Sneha', 'Subramanian', 'Sunil', 'Swati', 'Varun', 'Venkatesh',
  'Vijay', 'Vinod', 'Vivek', 'Bose', 'Chatterjee', 'Das', 'Datta', 'Ghosh', 'Gupta', 'Mukherjee',
  'Patel', 'Reddy', 'Sen', 'Sharma', 'Singh', 'Verma',

  // 3. International First Names & Surnames (45)
  'Alexander', 'Benjamin', 'Catherine', 'Charlotte', 'Daniel', 'David', 'Elizabeth', 'Emily',
  'Emma', 'Gabriel', 'Hannah', 'James', 'Jennifer', 'Jessica', 'Jonathan', 'Joseph', 'Joshua',
  'Lucas', 'Margaret', 'Matthew', 'Michael', 'Nicholas', 'Olivia', 'Patrick', 'Rachel', 'Samuel',
  'Sarah', 'Sophia', 'Stephen', 'Victoria', 'William', 'Anderson', 'Baker', 'Campbell', 'Clark',
  'Davies', 'Edwards', 'Evans', 'Harris', 'Jackson', 'Johnson', 'Jones', 'Miller', 'Mitchell',
  'Moore',

  // 4. Geographical Places & Everyday Vocabulary (20)
  'London', 'Paris', 'Tokyo', 'Sydney', 'Boston', 'Toronto', 'Berlin', 'Madrid', 'Singapore',
  'Mountain', 'River', 'Forest', 'Meadow', 'Sunrise', 'Horizon', 'Galaxy', 'Starlight', 'Phoenix',
  'Dragon', 'Falcon',
];

console.log('================================================================================');
console.log('P4(a): NAMES ALLOWLIST DEPENDENCY REPORT (185 False-Positive Test Cases)');
console.log('================================================================================');

let depReport = '================================================================================\n';
depReport += 'P4(a): NAMES ALLOWLIST DEPENDENCY REPORT\n';
depReport += `Timestamp: ${new Date().toISOString()}\n`;
depReport += `Total Names Tested: ${HARMLESS_NAMES_185.length}\n`;
depReport += '================================================================================\n\n';

let allowlistDependentCount = 0;
let withAllowlistPassCount = 0;
let withoutAllowlistPassCount = 0;

for (let i = 0; i < HARMLESS_NAMES_185.length; i++) {
  const name = HARMLESS_NAMES_185[i];
  const withRes = validateNameDetailed(name);
  const withoutRes = validateNameDetailed(name, { disableAllowlist: true });

  const withStr = withRes.ok ? 'OK' : `BLOCKED(rule ${withRes.ruleNumber})`;
  const withoutStr = withoutRes.ok ? 'OK' : `BLOCKED(rule ${withoutRes.ruleNumber})`;

  const passesOnlyWithAllowlist = withRes.ok && !withoutRes.ok;
  if (passesOnlyWithAllowlist) {
    allowlistDependentCount++;
  }
  if (withRes.ok) withAllowlistPassCount++;
  if (withoutRes.ok) withoutAllowlistPassCount++;

  depReport += `[${String(i + 1).padStart(3, ' ')}] ${name.padEnd(16, ' ')} | WITH: ${withStr.padEnd(17, ' ')} | WITHOUT: ${withoutStr.padEnd(17, ' ')} | DEPENDENT: ${passesOnlyWithAllowlist ? 'YES' : 'NO'}\n`;
}

depReport += '\n--------------------------------------------------------------------------------\n';
depReport += 'SUMMARY:\n';
depReport += `  Total Names Tested:               ${HARMLESS_NAMES_185.length}\n`;
depReport += `  Passing WITH Allowlist:           ${withAllowlistPassCount} / ${HARMLESS_NAMES_185.length}\n`;
depReport += `  Passing WITHOUT Allowlist:        ${withoutAllowlistPassCount} / ${HARMLESS_NAMES_185.length}\n`;
depReport += `  Pass ONLY because of Allowlist:   ${allowlistDependentCount} (e.g. Scunthorpe, Cassandra, etc.)\n`;
depReport += '================================================================================\n';

fs.writeFileSync(path.join(outDir, 'names_allowlist_dependency.txt'), depReport, 'utf8');
console.log(`Report written to scripts/out/names_allowlist_dependency.txt`);
console.log(`Passing WITH allowlist: ${withAllowlistPassCount} / ${HARMLESS_NAMES_185.length}`);
console.log(`Passing WITHOUT allowlist: ${withoutAllowlistPassCount} / ${HARMLESS_NAMES_185.length}`);
console.log(`Names that pass ONLY because of the allowlist: ${allowlistDependentCount}`);

// -----------------------------------------------------------------------------
// P4(b): Multi-Token / Handle Suite (>= 120 Harmless Names Not on Allowlist)
// -----------------------------------------------------------------------------
console.log('\n================================================================================');
console.log('P4(b): MULTI-TOKEN / HANDLE SUITE (>= 120 HARMLESS NAMES)');
console.log('================================================================================');

const MULTITOKEN_SUITE = [
  // Required prompt examples
  'Dark Knight', 'Mr Cool', 'Night_Owl_77', 'xX_Sniper_Xx', 'ProGamer', 'Super Man 99',
  'Fast As Light', 'FastAsLightning', 'Big Bad Wolf', 'Cat Lover', 'Pixel_Panda', 'Tea Time',
  'Mallu Gamer', 'Kerala Boy', 'Chai Lover', 'Cricket Fan', 'SilentStorm', 'FoxyLady',
  'Ninja Turtle', 'Space Cadet', 'Rock On',

  // Additional handles / gamer tags / multi-token names (all 3..16 chars, ASCII)
  'Cyber_Ninja', 'Quick_Silver', 'Star Gazer', 'Blue_Sky_42', 'Iron_Wolf', 'Speedy_Fox',
  'Lunar_Echo', 'Golden_Hawk', 'Red_Panda_88', 'Thunder_Bolt', 'Shadow_Walker', 'Frost_Byte',
  'Cosmic_Ray', 'Sun_Rider', 'Atomic_Ant', 'Neon_Tiger', 'Solar_Flare', 'Mystic_Mage',
  'Storm_Chaser', 'Wild_Card_7', 'Alpha_Wolf', 'Brave_Heart', 'Quiet_Storm', 'Silver_Bullet',
  'Ocean_Breeze', 'Desert_Fox', 'Forest_Runner', 'Eagle_Eye_01', 'Iron_Clad', 'Ghost_Rider',
  'Zero_Cool', 'Quantum_Leap', 'Delta_Force', 'Titan_Gamer', 'Pixel_Knight', 'Star_Dust',
  'Blaze_Fire', 'Crystal_Cave', 'Ruby_Gem', 'Emerald_Isle', 'Copper_Wire', 'Steel_Heart',
  'Velvet_Sky', 'Diamond_Head', 'Crimson_Tide', 'Amber_Glow', 'Cobalt_Blue', 'Indigo_Night',
  'Violet_Storm', 'Topaz_Flash', 'Onyx_Stone', 'Marble_Floor', 'Granite_Rock', 'Apex_Predator',
  'Turbo_Boost', 'Hyper_Drive', 'Super_Sonic', 'Mega_Byte', 'Ultra_Violet', 'Omni_Slash',
  'Vortex_Surfer', 'Zenith_Peak', 'Horizon_Gaze', 'Nebula_Drift', 'Pulsar_Beats', 'Quasar_Light',
  'Astro_Boy_99', 'Orbit_Flyer', 'Comet_Tail', 'Meteor_Shower', 'Eclipse_Moon', 'Solstice_Sun',
  'Equinox_Star', 'Aurora_Light', 'Zephyr_Wind', 'Monsoon_Rain', 'Cyclone_Eye', 'Tsunami_Wave',
  'Volcano_Lava', 'Glacier_Peak', 'Avalanche_Snow', 'Tundra_Wolf', 'Savanna_Lion', 'Jungle_Cat',
  'Oasis_Palm', 'Mirage_Sand', 'Canyon_Echo', 'Valley_Mist', 'Plateau_Sun', 'Summit_Climber',
  'Ridge_Walker', 'Cliff_Hanger', 'Tide_Runner', 'Wave_Rider', 'Current_Flow', 'Reef_Diver',
  'Abyss_Watcher', 'Zen_Master', 'Karma_Yogi', 'Mantra_Chant', 'Lotus_Flower', 'Banyan_Tree',
  'Mango_Lassi', 'Masala_Dosa', 'Butter_Naan', 'Biryani_King', 'Samosa_Lover', 'Paneer_Tikka',
  'Filter_Coffee', 'Sweet_Jalebi', 'Gulab_Jamun', 'Royal_Bengal', 'Ganga_Rider', 'Himalaya_Snow',
  'Monk_Mind', 'Sage_Advice', 'Guru_Guide', 'Swami_Peace', 'Kavya_Poet', 'Raga_Music',
  'Taal_Rhythm', 'Sur_Melody', 'Dhruva_Star', 'Agni_Fire', 'Vayu_Breeze', 'Jal_Water',
  'Prithvi_Earth', 'Akash_Sky', 'Surya_Sun', 'Chandra_Moon', 'Mitra_Friend'
];

let multiReport = '================================================================================\n';
multiReport += 'P4(b): MULTI-TOKEN / HANDLE SUITE REPORT\n';
multiReport += `Timestamp: ${new Date().toISOString()}\n`;
multiReport += `Total Handles Tested: ${MULTITOKEN_SUITE.length}\n`;
multiReport += '================================================================================\n\n';

let multiOkCount = 0;
let multiBlockedCount = 0;
const blockedHandles = [];

for (let i = 0; i < MULTITOKEN_SUITE.length; i++) {
  const handle = MULTITOKEN_SUITE[i];
  const res = validateNameDetailed(handle);
  if (res.ok) {
    multiOkCount++;
    multiReport += `[PASS] ${handle.padEnd(18, ' ')} -> OK\n`;
  } else {
    multiBlockedCount++;
    blockedHandles.push({ handle, ruleNumber: res.ruleNumber, description: res.ruleDescription });
    multiReport += `[BLOCK] ${handle.padEnd(18, ' ')} -> BLOCKED(rule ${res.ruleNumber}: ${res.ruleDescription})\n`;
  }
}

multiReport += '\n--------------------------------------------------------------------------------\n';
multiReport += 'SUMMARY:\n';
multiReport += `  Total Handles Tested: ${MULTITOKEN_SUITE.length} (>= 120 required)\n`;
multiReport += `  Passed:               ${multiOkCount}\n`;
multiReport += `  Blocked:              ${multiBlockedCount}\n`;
if (blockedHandles.length > 0) {
  multiReport += '  Blocked List:\n';
  for (const b of blockedHandles) {
    multiReport += `    - ${b.handle} (Rule ${b.ruleNumber}: ${b.description})\n`;
  }
} else {
  multiReport += '  Zero False Positives in Multi-Token Suite.\n';
}
multiReport += '================================================================================\n';

fs.writeFileSync(path.join(outDir, 'multitoken_suite.txt'), multiReport, 'utf8');
console.log(`Multi-token suite written to scripts/out/multitoken_suite.txt`);
console.log(`Passed: ${multiOkCount} / ${MULTITOKEN_SUITE.length}, Blocked: ${multiBlockedCount}`);

// -----------------------------------------------------------------------------
// P4(c): Held-Out Datasets Run
// -----------------------------------------------------------------------------
console.log('\n================================================================================');
console.log('P4(c): HELD-OUT RUN (Public First-Names & English Words)');
console.log('================================================================================');

const FIRST_NAMES_URL = 'https://raw.githubusercontent.com/dominictarr/random-name/master/first-names.txt';
const FIRST_NAMES_LICENSE = 'MIT (source: github.com/dominictarr/random-name)';

const WORDS_ALPHA_URL = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';
const WORDS_ALPHA_LICENSE = 'Public Domain / Unlicense (source: github.com/dwyl/english-words)';

console.log(`First-names source URL: ${FIRST_NAMES_URL}`);
console.log(`First-names stated license: ${FIRST_NAMES_LICENSE}`);
console.log(`English words source URL: ${WORDS_ALPHA_URL}`);
console.log(`English words stated license: ${WORDS_ALPHA_LICENSE}`);

async function runHeldout() {
  const firstNamesPath = path.join(heldoutDir, 'first-names.txt');
  const wordsPath = path.join(heldoutDir, 'words_alpha.txt');

  if (!fs.existsSync(firstNamesPath)) {
    console.log('Downloading first-names.txt...');
    const r = await fetch(FIRST_NAMES_URL);
    if (!r.ok) throw new Error(`Failed to download first-names.txt: HTTP ${r.status}`);
    const text = await r.text();
    fs.writeFileSync(firstNamesPath, text, 'utf8');
  }

  if (!fs.existsSync(wordsPath)) {
    console.log('Downloading words_alpha.txt...');
    const r = await fetch(WORDS_ALPHA_URL);
    if (!r.ok) throw new Error(`Failed to download words_alpha.txt: HTTP ${r.status}`);
    const text = await r.text();
    fs.writeFileSync(wordsPath, text, 'utf8');
  }

  // 1. Evaluate First Names
  const rawFirstNames = fs.readFileSync(firstNamesPath, 'utf8').split(/\r?\n/);
  const validFirstNames = rawFirstNames
    .map(s => s.trim())
    .filter(s => s.length >= 3 && s.length <= 16 && /^[a-zA-Z]+$/.test(s));

  console.log(`\nEvaluating ${validFirstNames.length} first names (length 3..16, ASCII)...`);

  const firstNameRules = {};
  for (let r = 1; r <= 10; r++) firstNameRules[r] = 0;
  let firstNamesOk = 0;
  const blockedFirstNames = [];

  for (const fn of validFirstNames) {
    const res = validateNameDetailed(fn);
    if (res.ok) {
      firstNamesOk++;
    } else {
      firstNameRules[res.ruleNumber] = (firstNameRules[res.ruleNumber] || 0) + 1;
      blockedFirstNames.push({ name: fn, ruleNumber: res.ruleNumber, description: res.ruleDescription });
    }
  }

  console.log(`\n--- First Names Results (${validFirstNames.length} evaluated) ---`);
  console.log(`OK (Passed): ${firstNamesOk} (${((firstNamesOk / validFirstNames.length) * 100).toFixed(2)}%)`);
  console.log(`Blocked:     ${blockedFirstNames.length} (${((blockedFirstNames.length / validFirstNames.length) * 100).toFixed(2)}%)`);
  console.log('Breakdown by Rule:');
  for (let r = 1; r <= 10; r++) {
    console.log(`  Rule ${String(r).padStart(2, ' ')}: ${firstNameRules[r] || 0}`);
  }

  console.log('\nBlocked First Names (Full List with Rule Numbers):');
  for (const b of blockedFirstNames) {
    console.log(`  - ${b.name}: BLOCKED(rule ${b.ruleNumber}: ${b.description})`);
  }

  // 2. Evaluate English Words
  const rawWords = fs.readFileSync(wordsPath, 'utf8').split(/\r?\n/);
  const validWords = rawWords
    .map(s => s.trim())
    .filter(s => s.length >= 3 && s.length <= 16 && /^[a-zA-Z]+$/.test(s));

  console.log(`\nEvaluating ${validWords.length} English words (length 3..16, ASCII)...`);

  const wordRules = {};
  for (let r = 1; r <= 10; r++) wordRules[r] = 0;
  let wordsOk = 0;
  const blockedWordsList = [];

  for (const w of validWords) {
    const res = validateNameDetailed(w);
    if (res.ok) {
      wordsOk++;
    } else {
      wordRules[res.ruleNumber] = (wordRules[res.ruleNumber] || 0) + 1;
      blockedWordsList.push(`${w} (Rule ${res.ruleNumber}: ${res.ruleDescription})`);
    }
  }

  console.log(`\n--- English Words Results (${validWords.length} evaluated) ---`);
  console.log(`OK (Passed): ${wordsOk} (${((wordsOk / validWords.length) * 100).toFixed(2)}%)`);
  console.log(`Blocked:     ${blockedWordsList.length} (${((blockedWordsList.length / validWords.length) * 100).toFixed(2)}%)`);
  console.log('Breakdown by Rule:');
  for (let r = 1; r <= 10; r++) {
    console.log(`  Rule ${String(r).padStart(2, ' ')}: ${wordRules[r] || 0}`);
  }

  // Write blocked words to scripts/out/heldout/blocked_words.txt without printing in console
  const blockedWordsFilePath = path.join(heldoutDir, 'blocked_words.txt');
  fs.writeFileSync(blockedWordsFilePath, blockedWordsList.join('\n') + '\n', 'utf8');
  console.log(`\nBlocked words written to ${blockedWordsFilePath} (NOT printed to stdout per safety policy).`);

  // Write full summary report to scripts/out/heldout_report.txt
  let heldoutReport = '================================================================================\n';
  heldoutReport += 'P4(c): HELD-OUT DATASET EVALUATION REPORT\n';
  heldoutReport += `Timestamp: ${new Date().toISOString()}\n`;
  heldoutReport += `First-Names Source: ${FIRST_NAMES_URL} [${FIRST_NAMES_LICENSE}]\n`;
  heldoutReport += `Words Source:       ${WORDS_ALPHA_URL} [${WORDS_ALPHA_LICENSE}]\n`;
  heldoutReport += '================================================================================\n\n';

  heldoutReport += '--- 1. First Names Evaluation ---\n';
  heldoutReport += `Total Evaluated (length 3..16, ASCII): ${validFirstNames.length}\n`;
  heldoutReport += `Passed:  ${firstNamesOk} (${((firstNamesOk / validFirstNames.length) * 100).toFixed(2)}%)\n`;
  heldoutReport += `Blocked: ${blockedFirstNames.length} (${((blockedFirstNames.length / validFirstNames.length) * 100).toFixed(2)}%)\n`;
  heldoutReport += 'Counts by Rule:\n';
  for (let r = 1; r <= 10; r++) {
    heldoutReport += `  Rule ${String(r).padStart(2, ' ')}: ${firstNameRules[r] || 0}\n`;
  }
  heldoutReport += '\nEvery Blocked First Name with Rule Number:\n';
  for (const b of blockedFirstNames) {
    heldoutReport += `  - ${b.name}: BLOCKED(rule ${b.ruleNumber}: ${b.description})\n`;
  }

  heldoutReport += '\n--------------------------------------------------------------------------------\n';
  heldoutReport += '--- 2. English Words Evaluation ---\n';
  heldoutReport += `Total Evaluated (length 3..16, ASCII): ${validWords.length}\n`;
  heldoutReport += `Passed:  ${wordsOk} (${((wordsOk / validWords.length) * 100).toFixed(2)}%)\n`;
  heldoutReport += `Blocked: ${blockedWordsList.length} (${((blockedWordsList.length / validWords.length) * 100).toFixed(2)}%)\n`;
  heldoutReport += 'Counts by Rule:\n';
  for (let r = 1; r <= 10; r++) {
    heldoutReport += `  Rule ${String(r).padStart(2, ' ')}: ${wordRules[r] || 0}\n`;
  }
  heldoutReport += `Blocked words saved to scripts/out/heldout/blocked_words.txt (${blockedWordsList.length} entries).\n`;
  heldoutReport += '================================================================================\n';

  fs.writeFileSync(path.join(outDir, 'heldout_report.txt'), heldoutReport, 'utf8');
  console.log(`Held-out report written to scripts/out/heldout_report.txt`);
}

runHeldout().catch(err => {
  console.error('Held-out evaluation error:', err);
  process.exit(1);
});

