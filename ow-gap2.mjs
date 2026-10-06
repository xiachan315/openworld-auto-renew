/**
 * ow-gap2.mjs — puzzle 缺口定位（v2，2026-10-06 重写）
 *
 * 旧版致命 bug：直接令 value = 缺口暗块左缘，**漏掉 chip 图内片块的左偏移**。
 *   实测 chip 图 96x96 里，片块并不贴左边（偏移实测 6 / 20 px 两种以上），
 *   而 chip.style.left = value（= chip 图左缘）⇒ 正确式是
 *       value = 缺口暗块左缘 - chip 图内片块左缘
 *
 * 特征依据（对 3 个 WS 原始样本实测）：
 *   · 服务端 bg 帧里的缺口 = **被暗化的片块形状**（不带 chip 元素）
 *   · 暗块 bbox 尺寸与 chip 图内片块 bbox 尺寸**逐样本吻合**
 *       p01 70x56 vs 70x56 / p02 84x56 vs 83x56 / p03 56x70 vs 56x70
 *
 * 为什么不用模板匹配：缺口内的片块内容已被抹掉（NCC 实测 0.22~0.34，无峰）。
 */
import fs from 'node:fs';
import { decodePngBuffer } from './ow-solver-js.mjs';

export function toGray(img) {
  const { w, h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j++) {
    g[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

/** 积分图 box blur */
function boxBlur(g, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const S = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1]
              - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[y * w + x] = S / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** 4-邻接连通块，返回按面积降序的数组 */
export function components(mask, w, h, minSize = 200) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const res = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !mask[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    while (sp > 0) {
      const p = stack[--sp]; const x = p % w, y = (p - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x + 1 < w) { const q = p + 1; if (!seen[q] && mask[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (x > 0)     { const q = p - 1; if (!seen[q] && mask[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (y + 1 < h) { const q = p + w; if (!seen[q] && mask[q]) { seen[q] = 1; stack[sp++] = q; } }
      if (y > 0)     { const q = p - w; if (!seen[q] && mask[q]) { seen[q] = 1; stack[sp++] = q; } }
    }
    if (n >= minSize) res.push({ n, x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  res.sort((a, b) => b.n - a.n);
  return res;
}

/**
 * chip 图内「片块」的 bbox：黑色描边围出的封闭区域。
 * 做法：暗像素(描边)=障碍，从四边 flood fill 得到「外部」，
 *       既非障碍又非外部 = 片块内部（含被描边包围的任意颜色区域）。
 */
export function pieceBBox(g, w, h, thr = 70) {
  const barrier = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) barrier[i] = g[i] < thr ? 1 : 0;
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p) => { if (!outside[p] && !barrier[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp]; const x = p % w, y = (p - x) / w;
    if (x + 1 < w) push(p + 1);
    if (x > 0)     push(p - 1);
    if (y + 1 < h) push(p + w);
    if (y > 0)     push(p - w);
  }
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, n = 0;
  for (let p = 0; p < w * h; p++) {
    if (barrier[p] || outside[p]) continue;
    const x = p % w, y = (p - x) / w;
    n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (n < 50) return null;
  return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n };
}

/**
 * 主入口。
 * @param bgImg   {w,h,data} 服务端 bg 帧
 * @param chipImg {w,h,data} 服务端 chip 帧
 * @param meta    meta 对象（用 w/vmax；py 仅作诊断）
 */
export function solveGap2(bgImg, chipImg, meta = {}) {
  const mw = meta.w || bgImg.w;
  const vmax = meta.vmax != null ? meta.vmax : (mw - (meta.pw || 96));
  const BG = toGray(bgImg);
  const CH = toGray(chipImg);
  const piece = pieceBBox(CH, chipImg.w, chipImg.h, 70);
  if (!piece) return { i: null, why: 'NO_PIECE_IN_CHIP' };

  const cands = [];
  for (const r of [25, 30, 40]) {
    const blur = boxBlur(BG, bgImg.w, bgImg.h, r);
    for (const t of [16, 22, 28, 34]) {
      const mask = new Uint8Array(bgImg.w * bgImg.h);
      for (let p = 0; p < mask.length; p++) mask[p] = (blur[p] - BG[p]) > t ? 1 : 0;
      for (const c of components(mask, bgImg.w, bgImg.h, 260)) {
        // 尺寸自校验：必须与 chip 内片块同量级
        const dw = Math.abs(c.w - piece.w) / Math.max(1, piece.w);
        const dh = Math.abs(c.h - piece.h) / Math.max(1, piece.h);
        const compact = c.n / (c.w * c.h);
        if (dw > 0.45 || dh > 0.45) continue;
        if (compact < 0.30) continue;            // 排除横跨全宽的暗带
        const score = c.n - 900 * (dw + dh);
        cands.push({ c, r, t, score, dw, dh, compact });
      }
    }
  }
  if (!cands.length) return { i: null, why: 'NO_GAP_BLOB', piece };
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  let value = Math.round(best.c.x0 - piece.x0);
  value = Math.max(0, Math.min(Math.round(vmax), value));
  return {
    i: value, value, vmax,
    piece: { x0: piece.x0, y0: piece.y0, w: piece.w, h: piece.h },
    gap: { x0: best.c.x0, x1: best.c.x1, y0: best.c.y0, y1: best.c.y1, w: best.c.w, h: best.c.h },
    r: best.r, t: best.t, dw: +best.dw.toFixed(3), dh: +best.dh.toFixed(3), cands: cands.length,
    note: 'gapLeft - chipPieceLeft',
  };
}

// ---------------- CLI 自测 ----------------
if (process.argv[2]) {
  const dir = process.argv[2];
  const files = fs.readdirSync(dir);
  const bgf = files.find((f) => /^bg\.(png|bin)$/.test(f) || /bg/.test(f));
  const cf = files.find((f) => /^chip\.(png|bin)$/.test(f) || /chip/.test(f));
  const bg = decodePngBuffer(fs.readFileSync(dir + '/' + bgf));
  const ch = decodePngBuffer(fs.readFileSync(dir + '/' + cf));
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(dir + '/meta.json', 'utf8')); } catch (e) {}
  console.log(dir, 'bg', bg.w + 'x' + bg.h, 'chip', ch.w + 'x' + ch.h, 'meta.py=' + meta.py);
  console.log(JSON.stringify(solveGap2(bg, ch, meta)));
}
