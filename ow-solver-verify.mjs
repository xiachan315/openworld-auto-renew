/**
 * 离线回归：用已抓取的真实样本验证 JS 求解器与 Python 版判定一致
 * 用法: node ow-solver-verify.mjs
 */
import fs from 'fs';
// ESM 不认 NODE_PATH，必须用绝对路径 require/import
const PW = 'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const pwMod = await import('file:///' + PW.replace(/\\/g, '/'));
const chromium = pwMod.chromium || (pwMod.default && pwMod.default.chromium);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SAMPLES = process.argv[2] || 'C:/Users/Administrator/AppData/Local/Temp/owr_samples.json';
const GRID = [
  { x: 85, y: 40, r: 20 }, { x: 215, y: 40, r: 20 },
  { x: 85, y: 120, r: 20 }, { x: 215, y: 120, r: 20 },
];

const { decodePngFromB64, solveOdd } = await import('./ow-solver-js.mjs');

const samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
const arr = Array.isArray(samples) ? samples : [samples];

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

// 目视核对过的真值基准（2026-10-03 逐张放大确认）
// ⚠️ 教训：曾把拼图上下两行的编号看反，误判「样本2 真值=3」；
//    实际是 0（青绿 vs 三个粉红，colorPower 1.30 压倒性）——**算法一直是对的**。
const TRUTH = {
  'owr_samples.json':  [0, 1, 3, 0, 3],
  'owr_samples2.json': [2, 0, 0, 3, 2, 1, 2, 0],
};
const key = Object.keys(TRUTH).find((k) => SAMPLES.includes(k));
const truth = key ? TRUTH[key] : null;
let hit = 0;

console.log(`样本数: ${arr.length}${truth ? '  (带目视真值基准)' : ''}`);
for (let n = 0; n < arr.length; n++) {
  const img = decodePngFromB64(arr[n].pngsB64[0]);
  const r = solveOdd(img, GRID, 300, 160);
  const ok = truth ? (r.i === truth[n]) : null;
  if (ok) hit++;
  console.log(`  样本${n}: i=${r.i} margin=${String(r.margin).padEnd(7)} regime=${String(r.regime).padEnd(6)}` +
    ` agree=${r.agree ? 'Y' : 'n'} unanimous=${r.unanimous ? 'Y' : 'n'}` +
    (ok === null ? '' : `  真值=${truth[n]} ${ok ? 'OK' : 'MISS'}`) + `  (${img.w}x${img.h})`);
}
if (truth) console.log(`>>> 命中 ${hit}/${arr.length}`);
await browser.close();
