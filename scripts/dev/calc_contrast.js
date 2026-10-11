const TILE_HEX = {
  2: '#343336',
  4: '#4b4949',
  8: '#696867',
  16: '#8e8c86',
  32: '#b8b3a7',
  64: '#e4ded0',
  128: '#f1d7a4',
  256: '#e9c17c',
  512: '#dba65f',
  1024: '#e6c7a8',
  2048: '#f5e4bf',
  4096: '#fff3d8',
};

const BOARD_DARK = [20, 18, 19]; // #141213
const TEXT = [232, 223, 214]; // #e8dfd6
const WELL = [33, 31, 32]; // #211f20

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(c1, c2, w1 = 0.35, w2 = 0.65) {
  return [
    Math.round(c1[0] * w1 + c2[0] * w2),
    Math.round(c1[1] * w1 + c2[1] * w2),
    Math.round(c1[2] * w1 + c2[2] * w2),
  ];
}

function relLum([r, g, b]) {
  const [sR, sG, sB] = [r, g, b].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * sR + 0.7152 * sG + 0.0722 * sB;
}

function contrast(rgb1, rgb2) {
  const l1 = relLum(rgb1);
  const l2 = relLum(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

console.log('Value | Dimmed BG (RGB)       | Dimmed Hex | Text (#e8dfd6) Contrast | Well (#211f20) Contrast');
console.log('------------------------------------------------------------------------------------------------');
for (const [val, hex] of Object.entries(TILE_HEX)) {
  const rawRgb = hexToRgb(hex);
  const dimmed = mix(rawRgb, BOARD_DARK, 0.35, 0.65);
  const dimmedHex = '#' + dimmed.map(x => x.toString(16).padStart(2, '0')).join('');
  const textCr = contrast(TEXT, dimmed);
  const wellCr = contrast(dimmed, WELL);
  console.log(`${val.padEnd(5)} | rgb(${dimmed.join(', ').padEnd(14)}) | ${dimmedHex}    | ${textCr.toFixed(2)}:1 (${textCr >= 4.5 ? 'PASS' : 'FAIL'})         | ${wellCr.toFixed(2)}:1 (${wellCr >= 1.3 ? 'PASS' : 'N/A'})`);
}
