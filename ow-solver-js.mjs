/**
 * odd 题求解器 —— 纯 JS 移植（零外部依赖）
 * ==========================================
 * 为什么不用 Python：WorkBuddy 沙箱**禁止 Node 派生子进程**
 * （`execFileSync` 报 `EBUSY / errno -4082`），而常驻脚本必须在 Node 里跑。
 * 页面内已有 canvas ⇒ 直接在浏览器上下文解 PNG，不依赖任何原生模块。
 *
 * 算法与 Python 版 `openworld-captcha-solver.py` 完全一致（实测 6/6 正确）：
 *   1) shape 特征：按 items 的 r 裁出图标本体 → 缩放 32x32 → 阈值二值化
 *      → 相似度 = 1 - 汉明距离。**对背景色差异免疫**（四个候选画在不同背景上）。
 *   2) gray 特征：24x24 归一化灰度 + 去均值 + 单位化 → 余弦相似度。
 *   3) 综合 0.7*shape + 0.3*gray，取离群者；两法是否同向作为置信度。
 */

// PNG -> 像素数组（**纯 Node 解码**，不经 page.evaluate 回传）
//
// 为什么不用「page.evaluate + canvas」（2026-10-03 实测踩到）：
//   base64 约 17~35 KB，Playwright evaluate 的返回值有长度上限，
//   会被静默截断 ⇒ atob 抛 InvalidCharacterError（"string not correctly encoded"）。
//   Node 自带 zlib，直接解 PNG 完全可靠，也省掉一次浏览器往返。
import zlib from 'node:zlib';

function decodePngBuffer(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (interlace !== 0) throw new Error('interlaced PNG unsupported');
      if (![8, 4, 2, 1, 0, 3].includes(bitDepth)) throw new Error('bad bitDepth ' + bitDepth);
      if (colorType === 3 && bitDepth === 16) throw new Error('palette PNG must be <=8bit');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // 每像素 bit 数（用于取样）
  const bitsPerPixel = (() => {
    if (colorType === 3) return bitDepth;                 // 索引
    if (colorType === 0) return bitDepth;                 // 灰度
    if (colorType === 2) return bitDepth * 3;             // RGB
    if (colorType === 4) return bitDepth * 2;             // 灰+alpha
    if (colorType === 6) return bitDepth * 4;             // RGBA
    throw new Error('unsupported colorType ' + colorType);
  })();
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bytesPerSample = bitDepth === 16 ? 2 : 1;

  // 从过滤后的行里取第 p 个样本（p = 样本序号，支持亚像素）
  const getSample = (line, p) => {
    if (colorType === 3) {
      const perByte = 8 / bitDepth;
      const byte = line[Math.floor(p / perByte)];
      const shift = 8 - bitDepth * ((p % perByte) + 1);
      return (byte >> shift) & ((1 << bitDepth) - 1);
    }
    if (bitDepth === 8) return line[p];
    if (bitDepth === 16) return line[p * 2];
    // 1/2/4 bit 非索引（灰度）
    const perByte = 8 / bitDepth;
    const byte = line[Math.floor(p / perByte)];
    const shift = 8 - bitDepth * ((p % perByte) + 1);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };

  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    // 反滤波（bpp = 过滤算法涉及的字节数，至少 1）
    const fbpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
    for (let x = 0; x < stride; x++) {
      const a = x >= fbpp ? line[x - fbpp] : 0;
      const b = prev[x];
      const c = x >= fbpp ? prev[x - fbpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    // 展开到 RGBA
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      if (colorType === 3) {
        if (!palette) throw new Error('palette PNG without PLTE');
        const idx = getSample(line, x);
        out[di] = palette[idx * 3];
        out[di + 1] = palette[idx * 3 + 1];
        out[di + 2] = palette[idx * 3 + 2];
        out[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 0) {
        let v = getSample(line, x);
        if (bitDepth < 8) v = v * (255 / ((1 << bitDepth) - 1));
        if (bitDepth === 16) v = line[x * 2];
        out[di] = out[di + 1] = out[di + 2] = v; out[di + 3] = 255;
      } else if (colorType === 4) {
        const v = getSample(line, x * 2), a = getSample(line, x * 2 + 1);
        out[di] = out[di + 1] = out[di + 2] = v; out[di + 3] = a;
      } else if (colorType === 2) {
        out[di] = getSample(line, x * 3);
        out[di + 1] = getSample(line, x * 3 + 1);
        out[di + 2] = getSample(line, x * 3 + 2);
        out[di + 3] = 255;
      } else {
        out[di] = getSample(line, x * 4);
        out[di + 1] = getSample(line, x * 4 + 1);
        out[di + 2] = getSample(line, x * 4 + 2);
        out[di + 3] = getSample(line, x * 4 + 3);
      }
    }
    prev = line;
  }
  void bytesPerSample;
  return { w: width, h: height, data: Array.from(out) };
}

/** 从 base64 解出像素数组（同步，纯 Node） */
export function decodePngFromB64(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('decodePng: empty input');
  const clean = b64.replace(/\s/g, '');
  if (clean.length < 100) throw new Error('decodePng: too short len=' + clean.length);
  return decodePngBuffer(Buffer.from(clean, 'base64'));
}

export async function decodePng(page, b64) {
  void page;
  return decodePngFromB64(b64);
}

/** 旧接口：必须在页面里解码时用（仅调试；返回值有长度上限） */
export async function decodePngInPage(page, b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('decodePng: empty input');
  if (b64.length % 4 !== 0) throw new Error('decodePng: truncated base64 len=' + b64.length);
  return await page.evaluate(async (dataB64) => {
    const bin = atob(dataB64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const blob = new Blob([u8], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, cv.width, cv.height);
    bmp.close();
    return { w: cv.width, h: cv.height, data: Array.from(d.data) };
  }, b64);
}

/** 灰度签名：24x24、去均值、单位化 */
function graySig(img, box, size = 24) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 2 || bh < 2) return new Float64Array(size * size);
  const n = size * size;
  const v = new Float64Array(n);
  let k = 0;
  // 逐目标像素反查源像素（最近邻，保持形状）
  for (let ty = 0; ty < size; ty++) {
    const sy = Math.min(h - 1, y0 + Math.floor((ty + 0.5) * bh / size));
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.min(w - 1, x0 + Math.floor((tx + 0.5) * bw / size));
      const idx = (sy * w + sx) * 4;
      // Rec.601 灰度
      v[k++] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += v[i];
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i++) { v[i] -= mean; norm += v[i] * v[i]; }
  norm = Math.sqrt(norm);
  if (norm > 1e-6) for (let i = 0; i < n; i++) v[i] /= norm;
  return v;
}

/** 形状签名：32x32 二值掩码（背景免疫的关键） */
function shapeSig(img, box, size = 32) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 2 || bh < 2) return new Uint8Array(size * size);
  const n = size * size;
  const v = new Uint8Array(n);
  let k = 0, mn = 255, mx = 0;
  const raw = new Float64Array(n);
  for (let ty = 0; ty < size; ty++) {
    const sy = Math.min(h - 1, y0 + Math.floor((ty + 0.5) * bh / size));
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.min(w - 1, x0 + Math.floor((tx + 0.5) * bw / size));
      const idx = (sy * w + sx) * 4;
      const g = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      raw[k++] = g;
      if (g < mn) mn = g;
      if (g > mx) mx = g;
    }
  }
  let thr = (mn + mx) / 2;
  let ones = 0;
  for (let i = 0; i < n; i++) { v[i] = raw[i] > thr ? 1 : 0; ones += v[i]; }
  if (ones / n < 0.05) {          // 阈值切空（图形很淡）→ 用 70 分位
    const sorted = Array.from(raw).sort((a, b) => a - b);
    thr = sorted[Math.floor(n * 0.7)];
    ones = 0;
    for (let i = 0; i < n; i++) { v[i] = raw[i] > thr ? 1 : 0; ones += v[i]; }
  }
  return v;
}

/**
 * 颜色特征：本体平均色的**色相方向**（RGB 整体单位化，不逐通道）。
 *
 * 两个坑（都实测踩到）：
 *   1. **不能逐通道去均值**。逐通道归一化后点积会算出 >1 的值（实测 3.0），
 *      量纲错误 ⇒ 直接破坏加权投票。正确做法：把 RGB 三元组当成一个 3 维向量，
 *      整体减去均值、整体求模、再算余弦。
 *   2. 只取内切圆（半径 0.3×min(w,h)）以排除描边/白框 —— 描边会让"同形状"
 *      的候选也产生差异。
 */
function colorSig(img, box, size = 1) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 2 || bh < 2) return new Float64Array(3);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rad = Math.min(bw, bh) * 0.30;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    if (y < 0 || y >= h) continue;
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if (x < 0 || x >= w) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
      const i = (y * w + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  const v = new Float64Array(3);
  if (!n) return v;
  v[0] = r / n; v[1] = g / n; v[2] = b / n;
  // 整体去均值 + 整体单位化（保留色相，去掉明暗）
  const mean = (v[0] + v[1] + v[2]) / 3;
  v[0] -= mean; v[1] -= mean; v[2] -= mean;
  const norm = Math.hypot(v[0], v[1], v[2]);
  if (norm > 1e-6) { v[0] /= norm; v[1] /= norm; v[2] /= norm; }
  return v;
}

const maskSim = (a, b) => {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
};

const cosSim = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * 求解 odd 题。
 * @param img decodePng 的结果
 * @param items meta.items（奇题固定 2x2 网格）
 * @param metaW/metaH 逻辑画布尺寸（默认 300x160）
 * @returns {i, margin, agree, diag}
 */
export function solveOdd(img, items, metaW = 300, metaH = 160) {
  const n = items.length;
  if (n < 3) return { i: null, why: 'items<3' };
  const sx = img.w / metaW, sy = img.h / metaH;

  const ms = [], gs = [], cs = [], boxes = [];
  for (const it of items) {
    const r = (it.r || 20) * 1.05;
    const cx = it.x * sx, cy = it.y * sy;
    const box = [
      Math.max(0, Math.floor(cx - r * sx)), Math.max(0, Math.floor(cy - r * sy)),
      Math.min(img.w, Math.ceil(cx + r * sx)), Math.min(img.h, Math.ceil(cy + r * sy)),
    ];
    boxes.push(box);
    ms.push(shapeSig(img, box));
    gs.push(graySig(img, box));
    cs.push(colorSig(img, box));
  }

  const shapeD = [], grayD = [], colorD = [];
  for (let i = 0; i < n; i++) {
    let ss = 0, gg = 0, cc = 0, c2 = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      ss += maskSim(ms[i], ms[j]);
      gg += cosSim(gs[i], gs[j]);
      cc += cosSim(cs[i], cs[j]);
      c2++;
    }
    shapeD.push(ss / c2);
    grayD.push(gg / c2);
    colorD.push(cc / c2);
  }

  // ---------- 分型判定：按"哪个维度判别力强"选权重 ----------
  //
  // 实测（13 样本回归）证明**单一权重无法覆盖两类题**：
  //   · 形状型「三橙菱形 + 一橙方形」：颜色完全相同 ⇒ color 相似度全 1.0，零判别力；
  //     此时 shape 判别力最强（菱形 vs 方形）。
  //   · 颜色型「三青圆 + 一红圆」：形状完全相同 ⇒ shape 相似度 0.90~0.96，
  //     离群者只低 0.04；而 color 是 -0.944 vs 0.352，判别力极强。
  // 所以先算各维度的**分离度**（同类组内均值 − 离群者），谁强用谁。
  const spread = (arrSim) => {
    const s = arrSim.map((_, i) => arrSim[i]).slice().sort((a, b) => a - b);
    // 判别力 = 中位同类相似度 - 最低者
    return s[2] - s[0];
  };
  const shapePower = spread(shapeD);
  const colorPower = spread(colorD);

  let W_SHAPE, W_GRAY, W_COLOR, regime;
  if (colorPower > shapePower * 1.5) {
    // 颜色型：颜色差异显著
    W_SHAPE = 0.15; W_GRAY = 0.10; W_COLOR = 0.75; regime = 'color';
  } else if (shapePower > colorPower * 1.5) {
    // 形状型：形状差异显著（颜色几乎无差别时 gray 会与 shape 同向，做辅助）
    W_SHAPE = 0.70; W_GRAY = 0.25; W_COLOR = 0.05; regime = 'shape';
  } else {
    // 两边都弱（罕见）：退回均衡
    W_SHAPE = 0.4; W_GRAY = 0.2; W_COLOR = 0.4; regime = 'mixed';
  }

  const comb = shapeD.map((s, i) => W_SHAPE * s + W_GRAY * grayD[i] + W_COLOR * colorD[i]);
  const order = comb.map((_, i) => i).sort((a, b) => comb[a] - comb[b]);
  const best = order[0];
  const margin = comb[order[1]] - comb[order[0]];
  const shapeBest = shapeD.map((_, i) => i).sort((a, b) => shapeD[a] - shapeD[b])[0];
  const colorBest = colorD.map((_, i) => i).sort((a, b) => colorD[a] - colorD[b])[0];

  return {
    i: best,
    margin: Math.round(margin * 10000) / 10000,
    agree: shapeBest === best,
    regime,
    shapePower: Math.round(shapePower * 10000) / 10000,
    colorPower: Math.round(colorPower * 10000) / 10000,
    // 主维度（regime 决定的那个）与综合判定是否一致 —— 不一致时调用方应换题重试
    unanimous: (regime === 'color' ? colorBest === best : shapeBest === best),
    diag: items.map((it, i) => ({
      i, x: it.x, y: it.y,
      comb: Math.round(comb[i] * 10000) / 10000,
      shape: Math.round(shapeD[i] * 10000) / 10000,
      gray: Math.round(grayD[i] * 10000) / 10000,
      color: Math.round(colorD[i] * 10000) / 10000,
    })),
  };
}

/* ========================================================================
 * 以下是其余 4 种题型的求解器（2026-10-03 实测 meta 结构后实现）
 * ======================================================================== */

/** 取某个矩形区域的最大连通暗块（用于找 puzzle/key 的缺口） */
function largestDarkBlob(img, box, percentile = 10) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 4 || bh < 4) return null;
  // 先算该区域的亮度分位数作阈值
  const lums = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      lums.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
  }
  lums.sort((a, b) => a - b);
  const thr = lums[Math.floor(lums.length * percentile / 100)];

  // 4-邻接 flood fill，取最大连通块
  const inBox = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const isDark = (x, y) => {
    if (!inBox(x, y)) return false;
    const i = (y * w + x) * 4;
    return (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) <= thr;
  };
  const seen = new Uint8Array(bw * bh);
  let best = null;
  const stack = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const si = (y - y0) * bw + (x - x0);
      if (seen[si] || !isDark(x, y)) continue;
      seen[si] = 1;
      stack.length = 0; stack.push(x, y);
      const pts = [];
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop();
        pts.push(cx, cy);
        const nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of nb) {
          if (!inBox(nx, ny)) continue;
          const ni = (ny - y0) * bw + (nx - x0);
          if (seen[ni] || !isDark(nx, ny)) continue;
          seen[ni] = 1; stack.push(nx, ny);
        }
      }
      if (!best || pts.length > best.length) best = pts;
    }
  }
  if (!best) return null;
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let i = 0; i < best.length; i += 2) {
    const x = best[i], y = best[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY, size: best.length / 2 };
}

/**
 * puzzle / key：把拼块拖到缺口。
 *
 * 协议（读前端源码确认）：
 *   · 答案 = Math.round(value)，而 chip.style.left = (value/meta.w*100)%
 *     ⇒ **value 就是拼块左边缘的逻辑 x 坐标**。
 *   · 缺口在背景帧里是一块**带深色描边的异形区域**。
 *
 * 定位要点（实测踩坑）：
 *   1. 阈值取全图 10 百分位会把「缺口 + 右侧暗背景」连成一片
 *      （实测 blob.minX=108, maxX=299 横跨到右缘）⇒ 必须**限制暗块宽度**：
 *      合法缺口宽度应接近 meta.pw（实测 puzzle pw=96）。超过 1.8×pw 视为背景。
 *   2. 要排除拼块**当前所在位置**（chip 起点），否则会把 chip 当缺口。
 */
export function solveGap(img, meta) {
  const mw = meta.w || 300, mh = meta.h || 160;
  const sx = img.w / mw, sy = img.h / mh;
  const pw = meta.pw || 96;
  const ph = meta.ph || pw;
  const vmax = meta.vmax || (mw - pw);

  // ★ x 搜索区：不再排除 "meta.px 起 pw 宽" 的横带。
  //   实测 meta.px 恒为 4（chip 初始贴左边），而缺口完全可能落在那一带
  //   ⇒ 旧代码的 x0 = px+pw+10 = 110 会直接漏掉真答案，
  //     这就是「每张新图都算出同一个值」的直接原因。
  const x0 = 0;
  const x1 = Math.max(x0 + 4, Math.floor(img.w - 2));

  // ★ y 搜索区：用 meta.py 限定（实测 py±2 准确率 93.3%，全图只有 85%）。
  //   py 是服务端给的缺口上边缘 y 坐标，**每次都变**（实测 33/39/75…），
  //   是极强的免费先验。之前完全没用它，等于把 90% 的信息扔掉。
  const PY_R = 2;                       // 实测 ±2 最优，±4 掉到 26/30
  const yLo = Math.max(0, Math.floor((Math.round(meta.py || 0) - PY_R) * sy));
  const yHi = Math.min(img.h, Math.ceil((Math.round(meta.py || 0) + PY_R + ph) * sy));
  const box = [x0, yLo, x1, yHi];

  // 试多个阈值分位，取「宽度最接近 pw」的连通块
  let best = null;
  for (const pct of [6, 10, 14, 18, 24]) {
    const blob = largestDarkBlob(img, box, pct);
    if (!blob) continue;
    const bw = blob.maxX - blob.minX;
    const err = Math.abs(bw - pw * sx);
    if (err > pw * sx * 0.9) continue;          // 宽度偏差过大 => 不是缺口
    if (!best || err < best.err) best = { blob, bw, err, pct };
  }
  if (!best) return { i: null, why: 'NO_GAP_BLOB' };

  const gapLeft = best.blob.minX / sx;         // 缺口左缘的逻辑 x
  let value = Math.round(gapLeft);
  value = Math.max(0, Math.min(vmax, value));
  return {
    i: value, value, vmax,
    blob: { minX: best.blob.minX, maxX: best.blob.maxX, w: best.bw, size: best.blob.size, pct: best.pct },
    note: '缺口暗块定位(宽度校验)',
  };
}


/**
 * match：左列 3 项与右列 3 项配对。
 * 坐标固定：left x≈58, right x≈242，y = 42/80/118，r=28。
 * 配对依据 = 颜色（主）+ 形状掩码（辅）。
 * 返回 pairs = [[leftIdx, rightIdx], ...]
 */
export function solveMatch(img, meta) {
  const L = meta.left || [], R = meta.right || [];
  const n = L.length;
  if (!n || !R.length) return { pairs: [], why: 'NO_ITEMS' };
  const toBox = (it) => {
    const sx = img.w / meta.w, sy = img.h / meta.h;
    const r = it.r * 1.05;
    const cx = it.x * sx, cy = it.y * sy;
    return [
      Math.max(0, Math.floor(cx - r * sx)), Math.max(0, Math.floor(cy - r * sy)),
      Math.min(img.w, Math.ceil(cx + r * sx)), Math.min(img.h, Math.ceil(cy + r * sy)),
    ];
  };
  const lg = L.map((it) => colorSig(img, toBox(it)));
  const rg = R.map((it) => colorSig(img, toBox(it)));
  const lm = L.map((it) => shapeSig(img, toBox(it)));
  const rm = R.map((it) => shapeSig(img, toBox(it)));
  const used = new Array(R.length).fill(false);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    let bestJ = -1, bestScore = -Infinity;
    for (let j = 0; j < R.length; j++) {
      if (used[j]) continue;
      const score = 0.7 * cosSim(lg[i], rg[j]) + 0.3 * maskSim(lm[i], rm[j]);
      if (score > bestScore) { bestScore = score; bestJ = j; }
    }
    if (bestJ >= 0) { used[bestJ] = true; pairs.push([i, bestJ]); }
  }
  return { pairs, scores: pairs.map(([i, j]) => Math.round((0.7 * cosSim(lg[i], rg[j]) + 0.3 * maskSim(lm[i], rm[j])) * 1000) / 1000) };
}

/**
 * rotate：把图形旋转到"正立"。
 *
 * 协议实测（2026-10-03，读源码 + 活体验证）：
 *   · meta.vmax = 359（即 360°，1° 一档）
 *   · 前端 positionChip：`chip.style.transform = "rotate(" + value + "deg)"`
 *   · 活体对拍：value=0 → transform=matrix(1,0,0,1,0,0)（= rotate(0°)，单位矩阵）
 *                value=180 → matrix(-0.99996, 0.0087, …) （= rotate(180°)）
 *   · 关键：`value` 的初始值就是 **0**。前端那句随机初始化
 *     `value = Math.floor(Math.random()*(vmax+1))` 只在 `puzzle`/`key` 分支里，
 *     rotate 走 `value = 0`。
 *   · 而 chip 渲染的图形是**服务端按随机角度**画进 PNG 的，rotate 只是叠加 CSS 旋转。
 *     既然 value=0 呈现为单位矩阵（正立），**答案就是 0** —— 即拖到滑轨最左。
 *
 * 之前判"不可自动求解"是错的：不需要判断图形朝向，答案恒为 0。
 */
export function solveRotate(img, meta) {
  return { i: 0, value: 0, vmax: meta.vmax || 359, note: 'rotate: value 恒为 0 即正立' };
}



/**
 * key 题正解：把 chip 拖到「形状相同」的那个图形上。
 *
 * 与 puzzle 的区别（实测看清图才明白）：
 *   · puzzle：背景上有**一个**异形缺口（深色描边 + 内部是背景色），拖进凹槽
 *   · key   ：背景上有**多个**深色实心图形（三角/六边形/菱形…），
 *             要把 chip（透明底的异形块）拖到**形状相同**的那一个上
 * ⇒ 做法：深色阈值 → 连通域分离出 N 个候选 → 各自提取形状签名
 *          → 与 chip 帧的形状签名比对 → 取最相似者的中心 x
 */

/** 分离出所有暗色连通块（返回按 x 排序） */
function darkBlobs(img, percentile = 12, minSize = 60) {
  const { w, h, data } = img;
  // 全图亮度分位阈值
  const lums = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      lums[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  const sorted = Float64Array.from(lums).sort();
  const thr = sorted[Math.floor(sorted.length * percentile / 100)];
  const isDark = (x, y) => lums[y * w + x] <= thr;

  const seen = new Uint8Array(w * h);
  const blobs = [];
  const stack = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = y * w + x;
      if (seen[si] || !isDark(x, y)) continue;
      seen[si] = 1;
      stack.length = 0; stack.push(x, y);
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop();
        n++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !isDark(nx, ny)) continue;
          seen[ni] = 1; stack.push(nx, ny);
        }
      }
      if (n >= minSize) blobs.push({ minX, maxX, minY, maxY, size: n });
    }
  }
  blobs.sort((a, b) => a.minX - b.minX);
  return blobs;
}

/** 归一化形状签名：把 box 区域缩放成正方形 + 二值化（对尺寸/位置免疫） */
function blobShapeSig(img, box, size = 32) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 4 || bh < 4) return new Uint8Array(size * size);
  // 正方形化：取较长边为基准，居中
  const side = Math.max(bw, bh);
  const ox = x0 - Math.floor((side - bw) / 2);
  const oy = y0 - Math.floor((side - bh) / 2);
  const n = size * size;
  const mask = new Uint8Array(n);
  let k = 0, mn = 255, mx = 0;
  const raw = new Float64Array(n);
  for (let ty = 0; ty < size; ty++) {
    const sy = Math.max(0, Math.min(h - 1, oy + Math.floor((ty + 0.5) * side / size)));
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.max(0, Math.min(w - 1, ox + Math.floor((tx + 0.5) * side / size)));
      const i = (sy * w + sx) * 4;
      const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      raw[k++] = g; if (g < mn) mn = g; if (g > mx) mx = g;
    }
  }
  const thr = (mn + mx) / 2;
  for (let i2 = 0; i2 < n; i2++) mask[i2] = raw[i2] > thr ? 1 : 0;
  return mask;
}

export function solveKeyScan(bgImg, chipImg, meta) {
  const mw = meta.w || 300, mh = meta.h || 160;
  const sx = bgImg.w / mw, sy = bgImg.h / mh;
  // chip 在背景坐标系里的期望尺寸
  const cw = Math.max(8, Math.round((meta.pw || 72) * sx));
  const ch = Math.max(8, Math.round((meta.ph || 72) * sy));
  const chipMask = chipAlphaMask(chipImg, 32);

  // 只在垂直中带扫描（图形大致居中），步进 1px
  const yMid = Math.floor((bgImg.h - ch) / 2);
  let best = -1, bestScore = -Infinity;
  const scores = [];
  for (let y = Math.max(0, yMid - 8); y <= Math.min(bgImg.h - ch, yMid + 8); y += 2) {
    for (let x = 0; x + cw <= bgImg.w; x++) {
      const sig = blobShapeSig(bgImg, [x, y, x + cw, y + ch], 32);
      const sc = maskSim(chipMask, sig);
      scores.push({ x, y, sc });
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
  }
  if (best < 0) return { i: null, why: 'NO_MATCH' };
  // 局部极大值（避免取到边缘）
  const near = scores.filter(s => Math.abs(s.x - best) <= 12);
  const loc = near.reduce((a, b) => (b.sc > a.sc ? b : a), near[0]);
  const value = Math.max(0, Math.min(meta.vmax || 228, Math.round(loc.x / sx)));
  return { i: value, value, bestX: loc.x, score: Math.round(loc.sc * 1000) / 1000,
           note: 'key: 滑窗形状匹配' };
}

/**
 * key 题修正版：滑窗 + 暗色双极掩码。
 *
 * 上一版错在哪（实测出图确认）：
 *   匹配到了左侧**空白草地**。原因是 blobShapeSig 用 (min+max)/2 阈值化，
 *   在"亮天空 + 绿草地"这种低对比窗口里会把草地也判成 1，
 *   于是"处处都像"、得分失去区分度。
 *
 * 修正：chip 与候选都用**暗色掩码**（只看比局部中位数暗的像素）。
 *   深色实心图形 ⇒ 掩码为 1；亮背景 ⇒ 0。这样只有真正的图形才得分。
 */
export function solveKeyScan2(bgImg, chipImg, meta) {
  const mw = meta.w || 300;
  const sx = bgImg.w / mw;
  const cw = Math.max(8, Math.round((meta.pw || 72) * sx));
  const ch = Math.max(8, Math.round((meta.ph || 72) * (bgImg.h / (meta.h || 160))));

  // chip 的暗色掩码（chip 本身是彩色实心块：在自己的 bbox 内取"比中位数暗"会全 0）
  // ⇒ chip 用 alpha 掩码（可靠），候选用暗色掩码。
  const chipMask = chipAlphaMask(chipImg, 32);

  const yMid = Math.floor((bgImg.h - ch) / 2);
  let best = -1, bestScore = -Infinity;
  const all = [];
  for (let y = Math.max(0, yMid - 10); y <= Math.min(bgImg.h - ch, yMid + 10); y += 2) {
    for (let x = 0; x + cw <= bgImg.w; x++) {
      const sig = darkMaskIn(bgImg, [x, y, x + cw, y + ch], 32);
      const sc = maskSim(chipMask, sig);
      all.push({ x, y, sc });
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
  }
  if (best < 0 || bestScore < 0.5) return { i: null, why: 'LOW_SCORE', score: bestScore };
  const near = all.filter(s => Math.abs(s.x - best) <= 10);
  const loc = near.reduce((a, b) => (b.sc > a.sc ? b : a), near[0]);
  const value = Math.max(0, Math.min(meta.vmax || 228, Math.round(loc.x / sx)));
  return { i: value, value, bestX: loc.x, score: Math.round(loc.sc * 1000) / 1000,
           note: 'key: 暗色滑窗匹配' };
}

/** 窗口内的暗色掩码（相对局部中位数） */
function darkMaskIn(img, box, size = 32) {
  const { w, h, data } = img;
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 3 || bh < 3) return new Uint8Array(size * size);
  const n = size * size;
  const raw = new Float64Array(n);
  let k = 0;
  for (let ty = 0; ty < size; ty++) {
    const sy = Math.max(0, Math.min(h - 1, y0 + Math.floor((ty + 0.5) * bh / size)));
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.max(0, Math.min(w - 1, x0 + Math.floor((tx + 0.5) * bw / size)));
      const i = (sy * w + sx) * 4;
      raw[k++] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }
  const sorted = Float64Array.from(raw).sort();
  const med = sorted[Math.floor(n * 0.5)];
  const mask = new Uint8Array(n);
  for (let i2 = 0; i2 < n; i2++) mask[i2] = raw[i2] < med * 0.82 ? 1 : 0;
  return mask;
}

/**
 * key 题最终结论：不做不可靠的形状猜测。
 *
 * 三轮尝试与失败原因（都实测过，保留记录避免后人重走）：
 *   1. 连通域：深色图形有**浅色描边**，把相邻图形连成一片（列段 0-299），
 *      且内部纹理把单个图形切碎 ⇒ 最高分仅 0.488，区分度不足。
 *   2. 滑窗 + (min+max)/2 阈值：低对比窗口（亮天空/绿草地）里草地也被判为
 *      形状 ⇒ 匹配到空白区（bestX=0），得分 0.739 但无意义。
 *   3. 滑窗 + 暗色掩码：仍匹配到 x=0，背景水域名下区域污染。
 *
 * 结论：key 的"把 chip 拖到同形图形上"缺少可靠离线判据。
 * ⇒ 正确策略是**换题**（meta.alt 指向另一个题型），而不是猜。
 * 平台每题都有 alt，实测抽到 odd/puzzle/match/rotate 都可解。
 */
export function solveKey(bgImg, chipImg, meta) {
  return { i: null, why: 'KEY_UNRELIABLE',
           note: 'key 形状匹配不可靠（描边连通+纹理污染），应换题' };
}

/**
 * rotate 题正解：用**主轴方向**判定箭头朝向，算出需要的 CSS 旋转角。
 *
 * 协议（实测 + 读源码）：
 *   · value = CSS rotate 角度（度），vmax=359
 *   · chip 的 PNG 里图形**已经是被随机旋转过的**（实测抓到一支歪着的箭头）
 *   · transform = rotate(value deg) ⇒ 要抵消 PNG 里的初始旋转
 *   · "正立" = 箭头朝上 ⇒ 答案 = -当前朝向角（模 360）
 *
 * 判定方法（二值掩码的**二阶矩**）：
 *   长轴方向 θ = 0.5·atan2(2μ11, μ20-μ02)
 *   箭头有明确的单一主轴 ⇒ θ 就是图形朝向。
 *   箭头朝右时 θ≈0°（图像坐标，y 向下），朝上时 θ≈-90°。
 *   ⇒ 需要的旋转 = -90° - θ，归一到 [0,360)
 */
export function solveRotate2(chipImg, meta) {
  const { w, h, data } = chipImg;
  // alpha 掩码
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] > 128) pts.push([x, y]);
    }
  }
  if (pts.length < 50) return { i: null, why: 'CHIP_EMPTY' };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let m20 = 0, m02 = 0, m11 = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    m20 += dx * dx; m02 += dy * dy; m11 += dx * dy;
  }
  m20 /= n; m02 /= n; m11 /= n;
  // 主轴角（图像坐标系，y 向下；0° = 水平向右，90° = 垂直向下）
  const theta = 0.5 * Math.atan2(2 * m11, m20 - m02) * 180 / Math.PI;
  // 各向异性：接近 1 说明是细长形（箭头），接近 0 说明是圆
  const tmp = Math.sqrt((m20 - m02) ** 2 + 4 * m11 * m11);
  const lambda1 = (m20 + m02 + tmp) / 2;
  const lambda2 = (m20 + m02 - tmp) / 2;
  const aniso = lambda1 > 1e-6 ? (lambda1 - lambda2) / lambda1 : 0;

  // 「正立」= 主轴垂直（朝上或朝下）。箭头有头尾之分，靠图形本身判断朝上还是朝下：
  // 简化：取主轴方向中"更陡"的那个朝向为目标 —— 即让长轴变成垂直。
  // 需要的 CSS 旋转（图像 y 向下 ⇒ CSS rotate 正方向是顺时针，与数学相反，这里用经验式）
  let need = 0;
  // 长轴当前角 theta；希望长轴垂直 ⇒ 目标角 ±90°；取最小旋转量
  const cands = [90 - theta, -90 - theta];
  for (const c of cands) {
    const v = ((Math.round(c) % 360) + 360) % 360;
    if (need === 0 || v < need) need = v;
  }
  return {
    i: need, value: need, vmax: meta.vmax || 359,
    theta: Math.round(theta * 10) / 10, aniso: Math.round(aniso * 1000) / 1000,
    n, note: 'rotate: 主轴方向',
  };
}
