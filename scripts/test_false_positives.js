// scripts/test_false_positives.js
// False-Positive Test Suite for Rogue 2048 Display Name Validation (G1.f)
// Evaluates >= 150 harmless first names, surnames, geographical places, and everyday words.
// Outputs per-name result and rule number if blocked (never printing any blocklist content).
// Writes output directly to scripts/out/names_false_positives.txt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNameDetailed } from '../supabase/functions/set-name/names.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'scripts', 'out');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const HARMLESS_NAMES = [
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

let report = '================================================================================\n';
report += 'FALSE-POSITIVE VALIDATION REPORT (G1.f)\n';
report += `Timestamp: ${new Date().toISOString()}\n`;
report += `Total Names Tested: ${HARMLESS_NAMES.length}\n`;
report += '================================================================================\n\n';

let okCount = 0;
let blockedCount = 0;

for (let i = 0; i < HARMLESS_NAMES.length; i++) {
  const name = HARMLESS_NAMES[i];
  const res = validateNameDetailed(name);
  const numStr = String(i + 1).padStart(3, ' ');
  if (res.ok) {
    okCount++;
    report += `[${numStr}] ${name.padEnd(20, ' ')} -> Status: OK\n`;
  } else {
    blockedCount++;
    report += `[${numStr}] ${name.padEnd(20, ' ')} -> Status: BLOCKED (Rule ${res.ruleNumber}: ${res.ruleDescription})\n`;
  }
}

report += '\n================================================================================\n';
report += 'SUMMARY TOTALS:\n';
report += `  Total Evaluated: ${HARMLESS_NAMES.length}\n`;
report += `  Allowed (OK):    ${okCount}\n`;
report += `  Blocked:         ${blockedCount}\n`;
report += `  Target:          0 Blocked\n`;
report += `  Result:          ${blockedCount === 0 ? 'PASSED (0 FALSE POSITIVES)' : 'FAILED'}\n`;
report += '================================================================================\n';

const outPath = path.join(outDir, 'names_false_positives.txt');
fs.writeFileSync(outPath, report, 'utf8');

console.log(report);
if (blockedCount !== 0) {
  process.exit(1);
}

