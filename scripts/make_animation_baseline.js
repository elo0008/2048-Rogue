#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { extractCssInventory } from './inventory_animations.js';

const rootDir = process.cwd();
const baselinePath = path.join(rootDir, 'scripts', 'baselines', 'animation_inventory_before.json');
const sourceCommit = 'e6332a3';

console.log(`Reading game/style.css from commit ${sourceCommit}...`);
const cssText = execSync(`git --no-pager show ${sourceCommit}:game/style.css`, { encoding: 'utf8' });

const inventory = extractCssInventory(cssText);

if (inventory.keyframeNames.length !== 23) {
  throw new Error(`Expected exactly 23 keyframes from commit ${sourceCommit}, found ${inventory.keyframeNames.length}`);
}

const baselineData = {
  sourceCommit,
  keyframeCount: inventory.keyframeNames.length,
  keyframeNames: inventory.keyframeNames,
  relevantRules: inventory.relevantRules,
  totalRulesWithAnimationOrTransition: inventory.totalRulesWithAnimationOrTransition,
};

fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
fs.writeFileSync(baselinePath, JSON.stringify(baselineData, null, 2), 'utf8');

console.log(`✔ Baseline written to scripts/baselines/animation_inventory_before.json with source commit ${sourceCommit}`);
console.log(`Found exactly ${inventory.keyframeNames.length} keyframes:`);
inventory.keyframeNames.forEach((name, i) => {
  console.log(`  ${(i + 1).toString().padStart(2, ' ')}. ${name}`);
});

