import fs from 'node:fs';
import path from 'node:path';

export function findChrome() {
  if (process.env.NO_CHROME === '1' || process.env.NO_CHROME === 'true') {
    return null;
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const winCandidates = [];
  if (process.env.PROGRAMFILES) {
    winCandidates.push(path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    winCandidates.push(path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (process.env['PROGRAMFILES(X86)']) {
    winCandidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'));
    winCandidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    winCandidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    winCandidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }

  const linuxMacCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];

  const allCandidates = [...winCandidates, ...linuxMacCandidates];
  for (const c of allCandidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}
