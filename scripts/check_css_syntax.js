#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

export function checkCssSyntax(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let depth = 0;
  let line = 1;
  let inComment = false;
  let inString = false;
  let stringChar = '';
  let topLevelBuffer = '';
  let topLevelStartLine = 1;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const nextCh = content[i + 1] || '';

    if (ch === '\n') {
      line++;
    }

    if (inComment) {
      if (ch === '*' && nextCh === '/') {
        inComment = false;
        i++; // skip /
      }
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped character
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    // Check for comment start
    if (ch === '/' && nextCh === '*') {
      inComment = true;
      i++; // skip *
      continue;
    }

    // Check for string start
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    // Parse braces and top-level statements
    if (ch === '{') {
      depth++;
      topLevelBuffer = '';
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        throw new Error(`CSS syntax error: negative brace depth at line ${line}`);
      }
      topLevelBuffer = '';
    } else if (ch === ';') {
      if (depth === 0) {
        const stmt = topLevelBuffer.trim();
        if (stmt.length > 0) {
          const isAtRule = stmt.startsWith('@import') || stmt.startsWith('@charset') || stmt.startsWith('@namespace');
          if (!isAtRule && stmt.includes(':')) {
            throw new Error(`CSS syntax error: declaration at depth 0 at line ${topLevelStartLine}: "${stmt}"`);
          }
        }
        topLevelBuffer = '';
      }
    } else {
      if (depth === 0) {
        if (topLevelBuffer.trim().length === 0) {
          topLevelStartLine = line;
        }
        topLevelBuffer += ch;
      }
    }
  }

  if (inComment) {
    throw new Error(`CSS syntax error: unclosed comment at EOF`);
  }
  if (inString) {
    throw new Error(`CSS syntax error: unclosed string at EOF`);
  }
  if (depth !== 0) {
    throw new Error(`CSS syntax error: non-zero final depth (${depth}) at EOF`);
  }

  return { passed: true, totalLines: line };
}

const targetFile = process.argv[2] || path.join(process.cwd(), 'game', 'style.css');

try {
  const result = checkCssSyntax(targetFile);
  console.log(`✔ CSS syntax check PASSED for ${path.relative(process.cwd(), targetFile)} (${result.totalLines} lines, depth balanced at 0).`);
  process.exit(0);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}

