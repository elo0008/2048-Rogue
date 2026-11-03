// scripts/check_name.js
// CLI tool for Rogue 2048 display name validation
// Usage: node scripts/check_name.js "Name 1" "Name2"
// Note: For project owner's local diagnostic use.

import { validateNameDetailed } from '../supabase/functions/set-name/names.ts';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: node scripts/check_name.js "Name 1" "Name 2" ...');
  process.exit(0);
}

for (const name of args) {
  const res = validateNameDetailed(name);
  if (res.ok) {
    console.log(`${name}: OK`);
  } else {
    console.log(`${name}: BLOCKED(rule ${res.ruleNumber})`);
  }
}

