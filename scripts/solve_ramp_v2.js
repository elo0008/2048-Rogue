function srgbToLin(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLum(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

function contrast(hex1, hex2) {
  const l1 = relLum(hex1);
  const l2 = relLum(hex2);
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  return (max + 0.05) / (min + 0.05);
}

const emptyCell = '#211f20';
const stoneBg = '#1c191a';

// Target luminances for strictly increasing, each step ratio >= 1.152:
// Step 0: Tile 2: L ~ 0.049  (ratio vs cell: 1.545 >= 1.5, vs stone: 1.64 >= 1.5)
// Step 1: Tile 4: L ~ 0.065  (ratio vs 2: 1.162)
// Step 2: Tile 8: L ~ 0.084  (ratio vs 4: 1.165)
// Step 3: Tile 16: L ~ 0.106 (ratio vs 8: 1.164)
// Text for 2, 4, 8, 16 is light (#fff, L=1.0):
//   Contrast on 16: 1.05 / 0.156 = 6.73 >= 4.5!
//   Contrast on 8:  1.05 / 0.134 = 7.83 >= 4.5!
//   Contrast on 4:  1.05 / 0.115 = 9.13 >= 4.5!
//   Contrast on 2:  1.05 / 0.099 = 10.6 >= 4.5!
// Step 4: Tile 32: L ~ 0.238 (ratio vs 16: 1.84 >= 1.15)
//   Text for 32..4096 is dark (#1e1715, L=0.0125, L+0.05=0.0625):
//   Contrast on 32: 0.288 / 0.0625 = 4.60 >= 4.5!
// Step 5: Tile 64: L ~ 0.285 (ratio vs 32: (0.335)/(0.288) = 1.163 >= 1.15)
// Step 6: Tile 128: L ~ 0.340 (ratio vs 64: (0.390)/(0.335) = 1.164 >= 1.15)
// Step 7: Tile 256: L ~ 0.405 (ratio vs 128: (0.455)/(0.390) = 1.166 >= 1.15)
// Step 8: Tile 512: L ~ 0.480 (ratio vs 256: (0.530)/(0.455) = 1.164 >= 1.15)
// Step 9: Tile 1024: L ~ 0.570 (ratio vs 512: (0.620)/(0.530) = 1.169 >= 1.15)
// Step 10: Tile 2048: L ~ 0.675 (ratio vs 1024: (0.725)/(0.620) = 1.169 >= 1.15)
// Step 11: Tile 4096: L ~ 0.800 (ratio vs 2048: (0.850)/(0.725) = 1.172 >= 1.15)

const palette = {
  2:    { hex: '#423d3f', text: '#ffffff' },
  4:    { hex: '#4e4849', text: '#ffffff' },
  8:    { hex: '#5b5454', text: '#ffffff' },
  16:   { hex: '#69605e', text: '#ffffff' },
  32:   { hex: '#948375', text: '#1e1715' },
  64:   { hex: '#ab957d', text: '#1e1715' },
  128:  { hex: '#c5a76f', text: '#1e1715' },
  256:  { hex: '#d4b35e', text: '#1e1715' },
  512:  { hex: '#e2bf52', text: '#1e1715' },
  1024: { hex: '#f0cd5a', text: '#1e1715' },
  2048: { hex: '#f9de79', text: '#1e1715' },
  4096: { hex: '#fff0a8', text: '#1e1715' },
};

console.log('Testing palette...');
let prevLum = 0;
let allOk = true;

const values = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];

for (let i = 0; i < values.length; i++) {
  const v = values[i];
  const { hex, text } = palette[v];
  const lum = relLum(hex);
  const ratioPrev = i === 0 ? null : (lum + 0.05) / (prevLum + 0.05);
  const ratioEmpty = (lum + 0.05) / (relLum(emptyCell) + 0.05);
  const ratioStone = (lum + 0.05) / (relLum(stoneBg) + 0.05);
  const textCr = contrast(hex, text);

  console.log(`Tile ${String(v).padStart(4)}: ${hex} | Lum: ${lum.toFixed(4)} | RatioPrev: ${ratioPrev ? ratioPrev.toFixed(3) : '   N/A'} | RatioEmpty: ${ratioEmpty.toFixed(3)} | TextCR: ${textCr.toFixed(2)}`);

  if (lum <= prevLum) { console.error(`FAIL: Lum not strictly increasing at ${v}`); allOk = false; }
  if (ratioPrev !== null && ratioPrev < 1.15) { console.error(`FAIL: Ratio to prev < 1.15 at ${v}: ${ratioPrev}`); allOk = false; }
  if (v === 2 && ratioEmpty < 1.5) { console.error(`FAIL: Tile 2 vs empty < 1.5: ${ratioEmpty}`); allOk = false; }
  if (v === 2 && ratioStone < 1.5) { console.error(`FAIL: Tile 2 vs stone < 1.5: ${ratioStone}`); allOk = false; }
  if (textCr < 4.5) { console.error(`FAIL: Text contrast < 4.5 at ${v}: ${textCr}`); allOk = false; }

  prevLum = lum;
}

if (allOk) {
  console.log('✔ All palette constraints passed perfectly!');
}
