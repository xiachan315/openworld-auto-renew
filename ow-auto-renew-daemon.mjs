/**
 * Openworld 自动续期 —— 服务器侧常驻版（headless，真正无人值守）
 * ===========================================================
 * 实测前提（2026-10-03）：
 *   1. Clerk 会话 = `__session` cookie（HttpOnly，810 字符）。导出后注入
 *      headless 浏览器即可保持登录 ⇒ **不需要人再登录、不需要人开着浏览器**。
 *   2. 反自动化门只看 `navigator.webdriver` / cdc / selenium / UA /
 *      plugins+langs。headless 下用 initScript 抹平后 `window.__owFp` 全干净
 *      （实测 webdriver=false, cdc=[], plugins=5, langs=4, chrome=true）。
 *   3. 验证码：wss://openworld.eu.org/ws/captcha 下发 meta（含 items 坐标）+ PNG 帧。
 *      odd 题 items 是**固定 2x2 网格** (85,40)(215,40)(85,120)(215,120) r=20。
 *   4. **就绪判据不能看 status 文本**（就绪后 textContent 仍是 "Loading..."，
 *      只把 display 置 none）。正解 = bg 的 blob src 就位 + status display:none。
 *   5. 写操作必须真实鼠标事件；`evaluate` 里的 el.click() 无效。
 *   6. **求解器用纯 JS（ow-solver-js.mjs）**：WorkBuddy 沙箱禁止 Node 派生子进程
 *      （execFileSync → EBUSY），Python 方案在常驻脚本里跑不起来。
 *      JS 版与 Python 版算法一致，13/13 样本回归全对。
 *
 * 用法：
 *   node ow-auto-renew-daemon.mjs once     # 跑一次（到期前 48h 内才真的续）
 *   node ow-auto-renew-daemon.js loop     # 常驻，每 8h 检查一次
 *
 * 环境变量：
 *   OW_COOKIES   cookie 文件路径（默认同目录 ow_cookies.json）
 *   OW_PW        playwright-core 所在 node_modules 的父目录
 *   OW_EDGE      Edge/Chrome 可执行文件
 *   OW_THRESHOLD_H  距到期多少小时内才真的续（默认 48）
 *   OW_INTERVAL_H   loop 模式的检查间隔小时数（默认 8）
 *   OW_NOTIFY    把每轮结果 JSONL 追加到此文件
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodePng, decodePngFromB64, solveOdd, solveGap, solveMatch, solveRotate, solveRotate2 } from './ow-solver-js.mjs';
import { notify, formatResult } from './ow-telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// playwright-core 加载：
//   · 本机：ESM 不认 NODE_PATH ⇒ 用绝对路径 import
//   · GitHub Actions：node_modules 在解析路径上 ⇒ 用普通包名 import
// 两条都试，谁成功用谁。
let chromium = null;
{
  const cands = [
    process.env.OW_PW ? 'file:///' + process.env.OW_PW.replace(/\\/g, '/') : null,
    'playwright-core',
  ].filter(Boolean);
  for (const spec of cands) {
    try {
      const m = await import(spec);
      chromium = m.chromium || (m.default && m.default.chromium);
      if (chromium) break;
    } catch (e) { /* 试下一个 */ }
  }
  if (!chromium) {
    console.error('FATAL: 无法加载 playwright-core');
    process.exit(1);
  }
}

const UUID = 'aa78a361-a445-4d41-971b-26d609f1e942';
const PANEL = `https://openworld.eu.org/vps/${UUID}`;

// cookie 来源：① OW_COOKIES_B64 环境变量（GitHub Actions Secret，base64 JSON）
//            ② ow_cookies.json 文件（本地）
//            ③ OW_COOKIES 指定的路径
function loadCookies() {
  const b64 = process.env.OW_COOKIES_B64;
  if (b64) return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const f = process.env.OW_COOKIES || path.join(__dirname, 'ow_cookies.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
// 浏览器可执行文件：Windows 用系统 Edge；Linux（Actions）用 Playwright 自带 Chromium。
// 传空串 / undefined ⇒ playwright-core 会用它自带的浏览器。
const EDGE_ENV = process.env.OW_EDGE !== undefined
  ? process.env.OW_EDGE
  : (process.platform === 'win32'
      ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
      : '');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// 必须在任何页面脚本之前执行
const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
try { delete navigator.__proto__.webdriver; } catch (e) {}
window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en-US','en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
`;

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

// ---------- 验证码相关 ----------
/** 从 PNG 的 IHDR 直接读宽高（不做完整解码，便宜） */
function pngSize(b64) {
  if (!b64 || b64.length < 32) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch (e) { return null; }
}

/**
 * 抓到的图太小 ⇒ 截到了空白/半渲染。
 * ⚠️ 阈值必须**分类型**：背景图 300x160，但 chip 只有 72x72（实测）
 *   ⇒ 一刀切 100x60 会把 chip 误判为空图。
 *   用 `minSide`：背景 100，chip 40。
 */
const grabTooSmall = (b64, kind) => {
  const sz = pngSize(b64);
  if (!sz) return true;                        // 不是合法 PNG
  const min = (kind === 'chip') ? 40 : 100;
  const minH = (kind === 'chip') ? 40 : 60;
  return sz.w < min || sz.h < minH;
};

const ready = (page) => page.evaluate(() => {
  const bg = document.getElementById('captcha_bg_default');
  const st = document.getElementById('captcha_status_default');
  if (!bg || !bg.src || !bg.src.startsWith('blob:')) return false;
  if (getComputedStyle(bg).display !== 'block') return false;
  if (!st || getComputedStyle(st).display !== 'none') return false;
  // ★ 必须**解码完成且有实际尺寸**。
  //   实测（Actions run#20）：bg.src 已就位但 complete=false 时就截图，
  //   抓到的是空白/半渲染 ⇒ 只有 3360 字节（正常 37239）⇒ 求解器必然失败，
  //   随后 waitReady 也过不去 ⇒ 整轮 NOT_READY。
  //   naturalWidth/Height 是解码完成的硬判据。
  if (!bg.complete) return false;
  const nw = bg.naturalWidth || 0, nh = bg.naturalHeight || 0;
  if (nw < 100 || nh < 60) return false;
  // 顺带确认渲染宽度与自然宽度比例合理（避免 display:block 但尺寸为 0）
  const r = bg.getBoundingClientRect();
  if (r.width < 100 || r.height < 40) return false;
  return true;
});

async function waitReady(page, max = 25, gap = 500) {
  for (let i = 0; i < max; i++) {
    if (await ready(page)) return true;
    await page.waitForTimeout(gap);
  }
  return false;
}

const readState = (page) => page.evaluate(() => {
  const g = (id) => document.getElementById(id);
  const tk = g('captcha_token_default');
  const dn = g('captcha_done_default');
  return {
    stage: (g('captcha_stage_default')?.textContent || '').trim(),
    hint: (g('captcha_hint_default')?.textContent || '').trim(),
    tokenLen: (tk?.value || '').length,
    verified: dn ? getComputedStyle(dn).display !== 'none' : false,
    canSwitch: !!g('captcha_switch_default')?.offsetParent,
  };
});

/** 带抖动与缓动的真实鼠标移动；接近终点时抖动收敛到 0 */
async function moveHuman(page, x, y) {
  const sx = x - 40 - Math.random() * 30, sy = y - 28 - Math.random() * 20;
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(160);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const amp = 5 * (1 - e) + 0.3;
    await page.mouse.move(sx + (x - sx) * e + (Math.random() - 0.5) * amp,
                          sy + (y - sy) * e + (Math.random() - 0.5) * amp);
    await page.waitForTimeout(14 + Math.random() * 24);
  }
  await page.mouse.move(x, y);
  await page.waitForTimeout(140);
}

/** 取 chip（拼块）自己的 PNG —— rotate 题判定朝向要用 */
async function grabChipPng(page) {
  // ★★★ 2026-10-05 实测修掉的两个真 bug（rotate 题型连续 20 次 not a PNG）：
  //
  // bug 1：原「优先」路径把**原始二进制字符串**直接返回（`s`），
  //        但调用方 `decodePngFromB64(chipPng)` 需要的是 **base64**
  //        ⇒ 第一道就抛 "not a PNG"，**永远走不到截图兜底**。
  //        修法：改成 `btoa(s)`。
  // bug 2：`page.evaluate` 回传有上限（实测截断在 ~4KB 字符），
  //        chip 若超过该大小，btoa 后也会被截断 ⇒ 仍是非法 PNG。
  //        ⇒ **截图优先**（Buffer 直接在 Node 侧，不经 evaluate，无上限），
  //          evaluate 只作兜底（小图才可靠）。
  //
  // 实测 chip 本身完全正常：<img id=captcha_chip_default src=blob:...>，
  // naturalWidth/Height=72，blob 5090 字节，签名 iVBORw0KGgo。
  const sel = '#captcha_chip_default';

  // ---- 路径 1：元素截图（无回传上限，首选）----
  try {
    const png = await page.locator(sel).first().screenshot({ type: 'png' });
    if (png && png.length > 200) return png.toString('base64');
  } catch (e) { /* 落到 clip / evaluate */ }

  // ---- 路径 2：视口内 clip 截图 ----
  const box = await page.evaluate((s) => {
    const c = document.querySelector(s);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    // 必须完全在视口内，否则 clip 截到空白
    if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  if (box) {
    try {
      const png = await page.screenshot({
        clip: { x: box.x, y: box.y, width: box.width, height: box.height }, type: 'png',
      });
      if (png && png.length > 200) return png.toString('base64');
    } catch (e) { /* 落到 evaluate */ }
  }

  // ---- 路径 3：页面内 fetch blob（★ 必须 btoa）----
  const b64 = await page.evaluate(async (s) => {
    const chip = document.querySelector(s);
    if (!chip || chip.tagName !== 'IMG' || !chip.src || !chip.src.startsWith('blob:')) return null;
    try {
      const buf = await (await (await fetch(chip.src)).blob()).arrayBuffer();
      const u8 = new Uint8Array(buf);
      let bin = '';
      // 分块 concat，避免 apply 参数上限
      const CH = 4096;
      for (let i = 0; i < u8.length; i += CH) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      }
      return btoa(bin);
    } catch (e) { return null; }
  }, sel);
  if (b64 && b64.length > 200) return b64;

  return null;
}

/** 取页面**当前这道题**的 PNG（另开 ws 拿到的是另一题，必错） */
async function grabPng(page) {
  // ★ 与 grabChipPng 同一个坑：`page.evaluate` 的返回值有硬上限（实测 ~4KB 字符）。
  //   背景 PNG 实测 17152 字节 ⇒ base64 后 22869 字符 ⇒ **必然被截断**
  //   ⇒ 表现是「图片明明有 src，却解析失败 / 结果恒定」。
  //   修法：**元素截图优先**（Buffer 直接在 Node 侧，绕过回传上限）。
  const sel = '#captcha_bg_default';

  // ---- 路径 1：元素截图 ----
  try {
    const png = await page.locator(sel).first().screenshot({ type: 'png' });
    if (png && png.length > 200) return { b64: png.toString('base64'), via: 'shot' };
  } catch (e) { /* 落到 evaluate */ }

  // ---- 路径 2：页面内 fetch blob（小图才可靠）----
  const r = await page.evaluate(async (s) => {
    const bg = document.querySelector(s);
    if (!bg || !bg.src || !bg.src.startsWith('blob:')) return { err: 'no blob' };
    try {
      const buf = await (await (await fetch(bg.src)).blob()).arrayBuffer();
      const u8 = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < u8.length; i += 4096) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
      }
      return { b64: btoa(bin), bytes: u8.length };
    } catch (e) { return { err: 'fetch: ' + String(e.message).slice(0, 40) }; }
  }, sel);
  if (r && r.b64) return { b64: r.b64, via: 'eval', bytes: r.bytes };
  return { err: (r && r.err) || 'grab-failed' };
}

// odd 题固定网格（实测 5/5 样本一致）
const GRID = [
  { x: 85, y: 40, r: 20 }, { x: 215, y: 40, r: 20 },
  { x: 85, y: 120, r: 20 }, { x: 215, y: 120, r: 20 },
];

// ---------- 主流程 ----------
async function launch() {
  const cookies = loadCookies();
  const browser = await chromium.launch({
    ...(EDGE_ENV ? { executablePath: EDGE_ENV } : {}),
    headless: process.env.OW_HEADLESS !== '0',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox',
           '--disable-dev-shm-usage', '--disable-gpu'],
  });
  // ★ 时区固定为 Asia/Shanghai。实测（2026-10-05）：
  //   面板按**浏览器本地时区**渲染到期时间，同一时刻：
  //     timezoneId=Asia/Shanghai → "2026-10-12 13:39:03"（正确）
  //     timezoneId=UTC           → "2026-10-12 05:39:03"（差 8 小时）
  //   GitHub runner 是 UTC ⇒ 不设这一项，通知里的到期时间就全错 8 小时。
  //   显式指定后，页面渲染、读数、通知三处天然一致，无需事后换算。
  const TZ_ID = process.env.OW_TZ || 'Asia/Shanghai';
  const ctx = await browser.newContext({
    userAgent: UA, locale: 'zh-CN', viewport: { width: 1280, height: 900 },
    timezoneId: TZ_ID,
  });
  await ctx.addCookies(cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    sameSite: c.sameSite || 'Lax',
  })));
  // 捕获验证码 meta（服务端下发的 kind/id/坐标），这是判题型与换题的唯一可靠依据
  await ctx.addInitScript(() => {
    const OW = window.WebSocket;
    function Wrapped(...a) {
      const ws = new OW(...a);
      ws.addEventListener('message', (e) => {
        try { const d = JSON.parse(e.data); if (d && d.kind && d.id) window.__owCapMeta = d; } catch (_) {}
      });
      return ws;
    }
    Wrapped.prototype = OW.prototype;
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) Wrapped[k] = OW[k];
    window.WebSocket = Wrapped;
  });
  await ctx.addInitScript(STEALTH);
  const page = await ctx.newPage();
  return { browser, page };
}

/**
 * 读到期信息。
 *
 * ★★ 时区 bug（2026-10-05 实测）：面板用**浏览器本地时区**渲染到期时间，
 *   所以同一时刻读到不同值：
 *     本机（北京）  → "2026-10-12 13:39:03"
 *     Actions（UTC）→ "2026-10-12 05:39:03"     ← 差 8 小时
 *   而这个串被原样存进 `renews` 并写进通知 ⇒ 服务器侧的通知时间全错 8 小时。
 *
 * 修法：**页面内用 `Date` 对象取时区偏移**，据此反推出北京时间串，
 *   输出与运行环境的时区无关。
 *   - 页面时区偏移 = Date 的 getTimezoneOffset()（北京 = -480）
 *   - 若面板渲染的是本地时间，则北京时间 = 本地时间 - offset/60 小时
 */
/**
 * 读到期信息。
 *
 * ★ 时区（2026-10-05 实测修正）：
 *   面板按**浏览器本地时区**渲染到期时间。实测同一时刻：
 *     timezoneId=Asia/Shanghai → "2026-10-12 13:39:03"
 *     timezoneId=UTC           → "2026-10-12 05:39:03"    差 8 小时
 *   GitHub runner 是 UTC，所以在 `launch()` 里**显式指定 timezoneId=Asia/Shanghai**
 *   （见该文件 launch 函数）。这里直接原样读取即可，**不要再做二次换算**。
 *
 *   ⚠️ 我一度在这里又按 getTimezoneOffset() 换算了一次，
 *      结果在北京时区下被重复减 8 小时（21:39，错的）。换算只做一次，且必须做在
 *      **浏览器侧**（timezoneId），不能在字符串层重复做。
 *
 * 同时保留 `renewsRaw` 与 `tzShiftH` 作为诊断证据，便于事后核对。
 */
async function readRenew(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const raw = (t.match(/Renews until\s*([0-9\-: ]+)/) || [])[1]?.trim() || null;
    return {
      renews: raw,
      renewsRaw: raw,
      // 诊断用：页面时区偏移（分钟）。北京 = -480，UTC = 0
      tzShiftMin: new Date().getTimezoneOffset(),
      inDays: (t.match(/Renews in\s*([^\n]+)/) || [])[1]?.trim() || null,
      running: /RUNNING/.test(t),
      loggedIn: !/Sign in|Log in|Redirecting/i.test(t),
    };
  });
}

/** 解析面板上的到期时间，算出距到期小时数 */
function hoursLeft(renewsStr) {
  if (!renewsStr) return null;
  // 形如 "2026-10-09 18:34:27 (GMT+8)"
  const m = renewsStr.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, Y, Mo, D, H, Mi, S] = m.map(Number);
  // 面板标注 GMT+8 ⇒ 换算成 UTC 毫秒
  const ts = Date.UTC(Y, Mo - 1, D, H - 8, Mi, S);
  return (ts - Date.now()) / 3600000;
}

/** 由 hint 文案判定题型 */
function kindOf(hint) {
  if (/doesn't belong/i.test(hint)) return 'odd';
  if (/matching partner/i.test(hint)) return 'match';
  if (/stands upright/i.test(hint)) return 'rotate';
  if (/piece into the gap/i.test(hint)) return 'puzzle';
  if (/chip onto the matching shape/i.test(hint)) return 'key';
  return 'unknown';
}


/** 点 "Try another way" 换题，并等新题就绪。返回是否成功换到新题。 */
/**
 * 题面唯一标识。
 *
 * ★ 2026-10-04 实测纠正：之前用「hint 文本」或「背景图指纹」判换题是否生效，
 *   **都是错的**：
 *   · hint 是模板字符串，4 种题型可能共用同一句提示，文本不变 ≠ 没换
 *   · 背景图可能来自小图库，连续刷很可能挑到同一张，图像指纹不变 ≠ 没换
 *
 * 正确判据：服务端下发的 meta 里带 **id**（16 字符挑战 ID）和 **kind**。
 * 实测连点换题 8 次 ⇒ 8 个不同的 id/kind 组合，换题机制本身完全正常。
 * meta 由页面内的 WebSocket 钩子缓存到 window.__owCapMeta。
 */
async function puzzleFingerprint(page) {
  return page.evaluate(() => {
    const m = window.__owCapMeta;
    if (!m || !m.id) return null;
    return `${m.kind}:${m.id}`;
  });
}

/**
 * 点 "Try another way" 换题，并确认**题面真的换了**。
 *
 * ★ 这是所有死循环的总根源（2026-10-04 Actions run#6 实测）：
 *   原实现用「hint 文本是否变化」判成功，但服务端换题时**题型不变、hint 文案也不变**，
 *   只是换了图 ⇒ `if (after !== before)` 永远不成立 ⇒ 换题形同虚设，
 *   脚本在原地反复算同一个答案（日志里 odd 重复 20 次，margin 恒为 0.1243）。
 * ⇒ 改用**题面图像指纹**（blob src 的 FNV-1a 哈希 + 长度）作为判据。
 *   顺带也接受 stage 推进（token 出现）作为成功信号。
 */
/**
 * 点「Try another way」换题，并确认**题面真的换了**。
 *
 * ★★ 2026-10-05 Actions run#19 实测：**坐标点击在 Linux headless 上 100% 失效**
 *   （40 阶段全是同一题型，`→ 已换到` 计数 = 0），
 *   而本机 Windows headless 实测 6 次点击 6 个不同 id 完全正常。
 *   ⇒ 不能只靠 `page.mouse.click(x, y)`：headless Chromium 的元素坐标
 *     与 hover 触发的可见性都可能与本机不同。
 *
 * 解法（按可靠性排序，逐级回退）：
 *   ① DOM 直接 click（`el.click()`，触发组件自己的事件处理，不依赖坐标/可见性）
 *   ② Playwright 的 `locator.click()`（自带滚动 + 可见性检查）
 *   ③ 坐标点击（兜底，本机实测有效）
 * 每一级都单独验证 meta.id 是否变化，全失败才算换题失败。
 */
async function switchKind(page) {
  const beforeFp = await puzzleFingerprint(page);
  const beforeStage = (await readState(page)).stage;
  const beforeSrc = await page.evaluate(() => document.getElementById('captcha_bg_default')?.src || null);

  // ---- 尝试 1：DOM click ----
  await page.evaluate(() => {
    const el = document.getElementById('captcha_switch_default');
    if (el) el.click();
  });
  if (await waitFpChange(page, beforeFp, beforeStage, beforeSrc)) return true;

  // ---- 尝试 2：Playwright locator.click（自动滚动到元素）----
  try {
    const loc = page.locator('#captcha_switch_default').first();
    if (await loc.count()) {
      await loc.click({ timeout: 4000, force: true });
    }
  } catch (e) { /* 落到坐标点击 */ }
  if (await waitFpChange(page, beforeFp, beforeStage, beforeSrc)) return true;

  // ---- 尝试 3：坐标点击（本机实测有效的那条）----
  const bb = await page.locator('#captcha_switch_default').first().boundingBox().catch(() => null);
  if (bb) {
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    await moveHuman(page, cx, cy);
    await page.mouse.click(cx, cy);
    if (await waitFpChange(page, beforeFp, beforeStage, beforeSrc)) return true;
  }

  const st = await readState(page);
  // ★ 实测（2026-10-05）：换题**不是点击方式的问题**，而是服务端给每个会话
  //   有限的重摇预算（本机实测 5 次后永久失效，之后点击毫无反应）。
  //   ⇒ 换题无效 = 预算耗尽，正确反应是**重开会话**，不是继续换。
  log(`  ⚠️ 换题预算耗尽（3 种点击方式均无新题）stage=${st.stage} id=${
    (beforeFp || 'null').split(':')[1] || 'null'} —— 需重开会话重摇`);
  return false;
}

/** 等题面指纹变化；变了返回 true。最多约 6 秒。 */
async function waitFpChange(page, beforeFp, beforeStage, beforeSrc) {
  // 18 × 500ms ≈ 9s。实测服务端下发新 meta 有 2~3s 延迟，6s 太紧会漏判。
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(500);
    const stNow = await readState(page);
    if (stNow.tokenLen > 0) return true;               // 答案已过 = 成功
    // ⚠️ 不要再把「stage 变化」当换题成功：答错后服务端会重发同 stage 的新题，
    //   实测 stage 会在 1/6 ↔ 2/6 之间反复倒退（换题前后同一个 stage 也可能变），
    //   用它做判据会把「没换题」误判成「换题成功」，然后原地空转。
    //   唯一可靠判据 = meta.id 变化（见 puzzleFingerprint）。
    if (await waitReady(page, 2, 300)) {
      const afterFp = await puzzleFingerprint(page);
      const afterSrc = await page.evaluate(() => document.getElementById('captcha_bg_default')?.src || null);
      if (beforeFp && afterFp && afterFp !== beforeFp) return true;
      if ((!beforeFp || !afterFp) && beforeSrc && afterSrc && beforeSrc !== afterSrc) return true;
    }
  }
  return false;
}

async function doRenew(page) {
  // 1) 开弹窗
  await page.locator('button').filter({ hasText: /^Renew free$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  // ⚠️ 实测：新会话首次点 Renew 后题面偶尔要 10s+ 才就绪。
  //   waitReady 失败时重开一次弹窗，仍失败才算 NOT_READY。
  if (!await waitReady(page)) {
    log('  ⚠️ 弹窗未就绪，重开一次');
    await page.waitForTimeout(3000);
    try {
      await page.locator('button').filter({ hasText: /^Renew free$/ }).first()
        .click({ timeout: 8000 });
    } catch (e) { /* 弹窗可能已开着 */ }
    if (!await waitReady(page)) return { ok: false, why: 'STAGE_NOT_READY' };
  }

  // 2) 若首阶段是 rotate / key（暂不能稳定离线求解的题型），先换题
  for (let i = 0; i < 8; i++) {
    const st = await readState(page);
    const k = kindOf(st.hint);
    if (k !== 'rotate' && k !== 'key') break;
    if (!st.canSwitch) break;
    // ★ 换题无效就别在这空转 —— 直接进入求解阶段，让多会话去重摇题型。
    if (!await switchKind(page)) {
      log(`  ⚠️ 开局换题无效（题型仍是 ${k}），直接进求解阶段`);
      break;
    }
  }
  // 3) 逐阶段求解（按题型分派）
  const rounds = [];
  let st = await readState(page);
  let keySwitches = 0;
  let switchFails = 0;
  let grabVia = null;
  let grabBytes = 0;
  let lastMatch = null;
  let lastOdd = null;
  let lastPuzzle = null;
  // ★ 时间预算：换题路径会消耗大量阶段（60 阶段 × 换题等待 ≈ 25 分钟，
  //   会撞 Actions 的 job timeout）。必须自己限时，到点就带着已有进度返回。
  //   24 不够（换题也占阶段），但也不能无限换。
  const DEADLINE_MS = Number(process.env.OW_ROUND_BUDGET_MS || 15 * 60 * 1000);
  const t0 = Date.now();
  for (let stage = 0; stage < 40; stage++) {
    if (Date.now() - t0 > DEADLINE_MS) {
      return { ok: false, why: 'ROUND_TIMEOUT', rounds,
               note: `本轮用时预算 ${Math.round((Date.now()-t0)/1000)}s 已到，放弃（已尝试 ${stage} 阶段）` };
    }
    st = await readState(page);
    if (st.tokenLen > 0) break;
    if (!await waitReady(page)) return { ok: false, why: 'NOT_READY', rounds };

    const kind = kindOf(st.hint);
    // ★ no-blob 是**时序**问题不是算法问题（实测 39 次）：
    //   waitReady 通过后、grabPng 执行前，服务端可能正在重发新题（答错后必发），
    //   旧 blob 被 revoke、新 blob 还没挂上 ⇒ src 变空。
    //   ⇒ 抓不到时**重等就绪再抓**，最多 4 次；仍失败才放弃。
    let png = await grabPng(page);
    let grabRetry = 0;
    while (png.err && grabRetry < 4) {
      grabRetry++;
      log(`  阶段${stage + 1} 抓图失败(${png.err})，第 ${grabRetry} 次重等就绪`);
      await page.waitForTimeout(1200);
      if (!await waitReady(page)) {
        return { ok: false, why: 'NOT_READY', rounds };
      }
      png = await grabPng(page);
    }
    if (png.err) return { ok: false, why: 'GRAB_FAIL:' + png.err, rounds, grabRetry };
    // 记录抓取路径：'shot' = 元素截图（不受 ~4KB 回传上限影响，可信）
    //                'eval' = 页面内 fetch blob（超过上限会被静默截断）
    grabVia = png.via || '?';
    grabBytes = png.b64 ? Math.round(png.b64.length * 3 / 4) : 0;
    // ★ 二次校验：PNG 头里的宽高必须够大。
    //   实测（run#20）：半渲染时截到 3360 字节的背景图，解码后尺寸不足 ⇒ 求解器必错。
    //   元素截图本身不报错，只能靠**尺寸**判断抓到了空图。
    if (grabTooSmall(png.b64, 'bg')) {
      grabRetry++;
      log(`  阶段${stage + 1} 抓到空图（${grabBytes}B，重试 ${grabRetry}/3），重等就绪`);
      await page.waitForTimeout(1000);
      if (!await waitReady(page)) return { ok: false, why: 'NOT_READY', rounds, grabRetry };
      png = await grabPng(page);
      if (png.err || grabTooSmall(png.b64, 'bg')) {
        return { ok: false, why: 'GRAB_EMPTY', rounds, grabRetry, grabVia };
      }
      grabVia = png.via || '?';
      grabBytes = png.b64 ? Math.round(png.b64.length * 3 / 4) : 0;
    }
    const img = await decodePng(page, png.b64);
    if (!img || img.w < 100 || img.h < 60) {   // img 是背景图（300x160）
      return { ok: false, why: 'IMG_TOO_SMALL', rounds, grabVia, grabBytes,
               imgSize: img ? [img.w, img.h] : null };
    }

    if (kind === 'odd') {
      const sol = solveOdd(img, GRID, 300, 160);
      if (sol.i === null) return { ok: false, why: 'SOLVER_NULL', rounds };
      const pt = await page.evaluate(({ lx, ly }) => {
        const r = document.getElementById('captcha_box_default').getBoundingClientRect();
        return { x: r.x + (lx / 300) * r.width, y: r.y + (ly / 160) * r.height };
      }, { lx: GRID[sol.i].x, ly: GRID[sol.i].y });
      // ★ 关键修复：答案不推进就**换题**，不要在旧图上重试。
      // 实测（Actions run #3）：odd 答错后脚本自循环 24 次，
      // 每次 margin 都是 0.9037 完全相同 —— 同一张旧 PNG 算了同一个答案，
      // 白烧 3 分钟。现在改为：重复判定即换题。
      if (lastOdd && lastOdd.i === sol.i && Math.abs(lastOdd.margin - sol.margin) < 1e-6) {
        // 答案重复 ⇒ 换题。**不要在这里放弃**：
        // 换题机制已证明有效（实测连点 8 次得 8 种题型），放弃是多余的。
        // 真正的止损点是「整轮 24 个阶段用尽」，那时自然返回失败。
        rounds.push({ stage, kind, i: sol.i, margin: sol.margin, note: '答案重复，换题' });
        log(`  阶段${stage + 1} odd 判定重复，换题`);
        if (!await switchKind(page)) {
          if (++switchFails > 1) {
            return { ok: false, why: 'SWITCH_DEAD', rounds,
                     note: '换题按钮连续无效，重开会话重摇题型' };
          }
        } else switchFails = 0;
        continue;
      }
      // ★ 低置信度门槛：**按 regime 分档**，不是一刀切 margin。
      //   实测统计（owrun7/8 + Actions run#20）：
      //     regime=color  → margin 0.90 / 1.02   （高置信，可答）
      //     regime=shape  → margin 0.0009 ~ 0.076 （全是瞎猜，且 0.0087 重复 4 次 = 原地打转）
      //   ⇒ shape 型低于阈值直接换题，别浪费提交；color 型不设门槛。
      const MIN_MARGIN = Number(
        process.env.OW_MIN_ODD_MARGIN ||
        (sol.regime === 'shape' ? 0.15 : 0.02));
      if (sol.margin !== undefined && sol.margin < MIN_MARGIN) {
        rounds.push({ stage, kind, i: sol.i, margin: sol.margin,
                      note: `低置信(${sol.margin}<${MIN_MARGIN})，换题` });
        log(`  阶段${stage + 1} odd 置信度不足（margin=${sol.margin}），换题`);
        const swOk = await switchKind(page);
        if (swOk) switchFails = 0;
        else if (++switchFails > 1) {
          return { ok: false, why: 'SWITCH_DEAD', rounds,
                   note: '换题按钮连续无效，重开会话重摇题型' };
        }
        continue;
      }
      lastOdd = { i: sol.i, margin: sol.margin };
      await moveHuman(page, pt.x, pt.y);
      await page.mouse.click(pt.x, pt.y);
      rounds.push({ stage, kind, i: sol.i, margin: sol.margin, regime: sol.regime });
      log(`  阶段${stage + 1} odd 判 items[${sol.i}] margin=${sol.margin} regime=${sol.regime}`);
    } else if (kind === 'puzzle' || kind === 'key' || kind === 'rotate') {
      // 协议要点（读前端源码确认）：
      //   · 答案 = Math.round(value)，value 即 chip 左边缘的**逻辑 x 坐标**
      //     （positionChip: chip.style.left = (value/meta.w*100)%）
      //   · 拖拽过程**不提交**；只有 submitSolution 才发 "ans:"
      //   · 提交时机：chip/track 的 pointerup（setPointerCapture 后）、
      //     或键盘 Enter/Space
      //   · 键盘：ArrowLeft/Right 调 value（步进 2，Shift 为 vmax/18）
      //     ⇒ 键盘更可控，优先用；chip 上 Enter 提交
      const meta = await page.evaluate(() => {
        const chip = document.getElementById('captcha_chip_default');
        const track = document.getElementById('captcha_track_default');
        const box = document.getElementById('captcha_box_default');
        if (!chip || !track) return null;
        const cb = chip.getBoundingClientRect(), tb = track.getBoundingClientRect(), bb = box.getBoundingClientRect();
        return {
          chipCx: cb.x + cb.width / 2, chipCy: cb.y + cb.height / 2,
          trackCx: tb.x + tb.width / 2, trackCy: tb.y + tb.height / 2,
          trackX: tb.x, trackW: tb.width,
          handleW: (document.getElementById('captcha_handle_default')?.offsetWidth) || 24,
          boxX: bb.x, boxY: bb.y, boxW: bb.width, boxH: bb.height,
          vmax: Number(track.getAttribute('aria-valuemax') || 0),
          valuenow: Number(chip.getAttribute('aria-valuenow') || 0),
          // chip 宽度是百分比字符串（如 "32%"）⇒ 供 solveGap 算拼块宽度
          chipWPct: parseFloat(chip.style.width) || 32,
          // rotate 题的缺口框（来自服务端 meta：ow/oh/ox/oy）
          // ⚠️ 必须从 __owCapMeta 读，不能猜 —— 实测 ow=oh=72, ox/oy 每次都变
          cm: window.__owCapMeta || null,
        };
      });
      if (!meta) return { ok: false, why: 'NO_CHIP', rounds };

      // 目标 value：rotate 恒为 0（正立）；puzzle = 缺口暗块左缘；
      //             key 的形状匹配不可靠（描边连通 + 纹理污染）⇒ 换题
      let target;
      if (kind === 'rotate') {
        // 需要 chip 帧（第二张 PNG）来判定箭头朝向
        const chipPng = await grabChipPng(page);
        let r2 = { i: null, why: 'no-chip' };
        if (chipPng) {
          try {
            // chip 只有 72x72（实测），阈值与背景图不同
            if (grabTooSmall(chipPng, 'chip')) {
              r2 = { i: null, why: 'chip-empty(' + (pngSize(chipPng)?.w || 0) + 'px)' };
            } else {
              const chipImg = decodePngFromB64(chipPng);
              const cm = meta.cm || {};
              r2 = solveRotate2(chipImg, img, {
                vmax: cm.vmax || meta.vmax, ow: cm.ow, oh: cm.oh,
                ox: cm.ox, oy: cm.oy,
              });
            }
          } catch (e) {
            // chip 的 blob 可能还没换成新题（src 仍是旧图或空）⇒ 换题重来
            r2 = { i: null, why: 'chip-decode:' + String(e.message).slice(0, 40) };
          }
        }
        if (r2.i === null) {
          rounds.push({ stage, kind, skipped: r2.why });
          log(`  阶段${stage + 1} rotate ${r2.why}，换题`);
          if (!await switchKind(page)) {
            if (++switchFails > 1) {
              return { ok: false, why: 'SWITCH_DEAD', rounds,
                       note: '换题按钮连续无效，重开会话重摇题型' };
            }
            await page.waitForTimeout(1500);
          } else switchFails = 0;
          continue;
        }
        target = r2.i;
        rounds.push({ stage, kind, theta: r2.theta, aniso: r2.aniso, target });
      } else if (kind === 'key') {
        // ★ 换题机制一直是好的，是我之前的**判据错了**（用 hint 文本/背景图指纹，
        //   两者都不随换题变化 ⇒ 误判成 alt 自环）。
        //   2026-10-04 本机实测：连点换题 8 次 ⇒ 8 种不同题型，key 只占 1/9。
        //   正确判据是 meta.id / meta.kind（见 puzzleFingerprint）。
        // ⇒ 抽到 key 就换，最多换 12 次；抽到别的题型立刻清零。
        // 换题 3 次仍抽到 key ⇒ 结束本会话，让多会话重试去**重摇题型**
        //（实测 run#18：会话 1 在 key 上耗掉 13 阶段，其余会话抽到 puzzle/odd 都能走）
        if (++keySwitches > 3) {
          return { ok: false, why: 'KEY_NEED_RESHUFFLE', rounds,
                   note: `换题 ${keySwitches} 次仍抽到 key，重开会话重摇题型` };
        }
        rounds.push({ stage, kind, skipped: 'unreliable', keySwitch: keySwitches });
        log(`  阶段${stage + 1} key 不可靠，换题（第 ${keySwitches} 次）`);
        await switchKind(page);
        // 换题后**必须重读 meta**；没换掉就返回，不能原地 continue 转圈
        const newKind = await page.evaluate(() => window.__owCapMeta?.kind || null);
        if (newKind && newKind !== 'key') {
          log(`  → 已换到 ${newKind} 题型，清零 key 计数`);
          keySwitches = 0;
        } else {
          log('  → 换题未生效，结束本会话');
          return { ok: false, why: 'KEY_STUCK', rounds,
                   note: '换题按钮对本会话已失效，需重开会话' };
        }
        continue;
      } else {
        // 拼块宽度必须从 DOM 的 chip style.width 读（puzzle=32% / key=24%，不能猜）
        const pw = Math.round((meta.chipWPct / 100) * 300);
        // ★ meta.px / meta.py 从页面里读（solveGap 依赖 py 限定 y 搜索范围，
        //   硬编码 px:4 会把搜索起点推到 110，直接漏掉左半张图的答案）。
        const cm = await page.evaluate(() => window.__owCapMeta || null);
        const sol = solveGap(img, { w: 300, h: 160, vmax: meta.vmax, pw, ph: pw,
                                    px: cm?.px, py: cm?.py });
        // 诊断字段透传（solveGap 已在返回里带上）
        if (sol.i === null) {
          // ★ 这里原来自己实现了一套坐标点击，绕过了 switchKind 的
          //   三级回退（DOM click / locator.click / 坐标）与失败计数，
          //   结果「缺口未定位」时空转 40 阶段（实测 119 次 puzzle 全耗在这）。
          //   ⇒ 统一走 switchKind，止损交给 switchFails。
          // 带上 solveGap 的诊断字段（usedPy/py/probes/pwPx），一眼看出是没图还是没对上
          rounds.push({ stage, kind, skipped: 'no-gap-located', grabVia, grabBytes,
                        diag: sol.diag || null });
          log(`  阶段${stage + 1} ${kind} 缺口未定位（via=${grabVia}, ${grabBytes}B, ` +
              `usedPy=${sol.usedPy}, py=${sol.py}, pwPx=${sol.pwPx}, probes=${JSON.stringify(sol.probes)}），换题`);
          const swOk = await switchKind(page);
          if (swOk) switchFails = 0;
          else if (++switchFails > 1) {
            return { ok: false, why: 'SWITCH_DEAD', rounds,
                     note: '换题预算耗尽，重开会话重摇题型' };
          }
          continue;
        }
        target = sol.i;
      }

      // 当前 value 读数（aria-valuenow）
      const readVal = () => page.evaluate(() =>
        Number(document.getElementById('captcha_chip_default')?.getAttribute('aria-valuenow') || 0));

      // ---- 滑轨精调（键盘未命中时兜底）。定义在分支外，键盘/拖拽两条路径共用 ----
      const vmax = meta.vmax || 204;
      const handleW = meta.handleW || 24;
      const span = Math.max(1, (meta.trackW || 0) - handleW);
      // 协议 trackToValue：
      //   frac = clamp((clientX - trackLeft - handleW/2) / (trackW - handleW), 0, 1)
      //   value = round(frac * vmax)
      const trackTo = async (want) => {
        const f = Math.max(0, Math.min(1, want / vmax));
        const x = meta.trackX + handleW / 2 + f * span;
        await moveHuman(page, x, meta.trackCy);
        await page.mouse.down();
        await page.waitForTimeout(80);
        await page.mouse.up();
        await page.waitForTimeout(450);
      };
      const trackNudge = async (want) => {
        // 精确逼近：每次按误差收缩，最多 10 次
        let v = await readVal();
        for (let i = 0; i < 10 && Math.abs(v - want) > 1; i++) {
          await trackTo(want);
          const nv = await readVal();
          if (nv === v) break;          // 滑轨不动了（多半是 handleW/trackW 读错）
          v = nv;
        }
        return v;
      };

      // ---- 交互策略：先粗拖（产生真实 pointer 轨迹喂行为门），再键盘精调，最后 Enter 提交 ----
      // 协议关键（读前端源码确认）：
      //   · chip 的 pointerdown/move 只改 value；**pointerup 才 submitSolution**
      //   · 键盘 ArrowLeft/Right 调 value（步进 2；Shift = vmax/18 粗调），Enter 提交
      //   · ⚠️ 键盘事件绑在 chip 上，**必须让 chip 真正获得焦点**。
      //     只调 el.focus() 不够（headless 下 tabindex=0 的元素不一定接受键盘），
      //     实测 141 次方向键全无效 —— 必须用真实 mouse.click 点一下 chip。
      //   · 之前另一个失败原因：拖到一半 pointerup 就提交，后续调整没再提交
      await moveHuman(page, meta.chipCx, meta.chipCy);
      await page.mouse.click(meta.chipCx, meta.chipCy);   // 真实点击 → 聚焦
      await page.waitForTimeout(300);
      const focused = await page.evaluate(() => document.activeElement?.id || '');
      if (focused !== 'captcha_chip_default') {
        // 兜底：直接 focus()，并在读数前验证键盘是否生效
        await page.evaluate(() => document.getElementById('captcha_chip_default')?.focus());
        await page.waitForTimeout(200);
      }

      // 1) 真实拖动：只做行为采样。⚠️ 不要在这里松手提交 ——
      //    pointerup 会立刻 submitSolution，而此时 value 还没调准。
      //    做法：按下后拖回原位再松手，让"行为样本"有了但答案不变糟。
      const targetPx = meta.boxX + (target / 300) * meta.boxW;
      await page.mouse.down();
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        await page.mouse.move(meta.chipCx + (targetPx - meta.chipCx) * e,
                              meta.chipCy + (Math.random() - 0.5) * 2);
        await page.waitForTimeout(20);
      }
      // 拖回起始位再松手 —— 提交的 value 与初始一致，不会误判
      for (let k = 12; k >= 0; k--) {
        const t = k / 12;
        const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        await page.mouse.move(meta.chipCx + (targetPx - meta.chipCx) * e,
                              meta.chipCy + (Math.random() - 0.5) * 2);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await page.waitForTimeout(1200);

      // 2) 键盘精确逼近。先验证一次按键是否真的改变 value（防焦点陷阱）
      let cur = await readVal();
      const probe0 = cur;
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
      const probe1 = await readVal();
      const keyboardWorks = probe1 !== probe0;
      if (!keyboardWorks) {
        // 滑轨定位（协议 trackToValue）：
        //   frac = clamp((clientX - trackLeft - handleW/2) / (trackW - handleW), 0, 1)
        //   apply(frac * vmax)
        // ⚠️ 之前失败的原因：点 track 只 apply 不 submit，随后点 chip 提交时
        //    value 已被下一步的 apply 改偏了。⇒ 改成「只在 track 上迭代逼近，
        //    精确命中后再点 chip 提交」。
        // trackTo / span / handleW / vmax 已提升到本分支外（键盘路径也要用）
        cur = await readVal();
        // 二分收缩：每次按当前误差方向重定位，最多 8 次
        for (let g2 = 0; g2 < 8 && Math.abs(cur - target) > 1; g2++) {
          const err = target - cur;
          await trackTo(cur + err);          // 按误差比例直接跳
          cur = await readVal();
        }
        // ★ 与 odd 同理：拖拽类题型答错时服务端不会换题，
        //   脚本在同一张图上重试就是死循环（实测 run#4：171 chip→24 重复 20 次）。
        //   判据：目标 value 相同 ⇒ 同一张图同一定位 ⇒ 换题；连续 3 次则放弃本轮。
        const sig = `${kind}:${target}`;
        if (lastPuzzle === sig) {
          rounds.push({ stage, kind, value: target, note: '定位重复，换题' });
          log(`  阶段${stage + 1} ${kind} 定位重复，换题`);
          const swOk = await switchKind(page);
          if (swOk) switchFails = 0;
          else if (++switchFails > 1) {
            return { ok: false, why: 'SWITCH_DEAD', rounds,
                     note: '换题按钮连续无效，重开会话重摇题型' };
          }
          continue;
        }
        lastPuzzle = sig;

        // 命中后提交：点 chip 触发 pointerup -> submitSolution
        // （chip 已被 trackTo 移动 ⇒ 用实时坐标，不用 meta.chipCx）
        const posNow = await page.evaluate(() => {
          const c = document.getElementById('captcha_chip_default');
          const r = c.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        await moveHuman(page, posNow.x, posNow.y);
        await page.mouse.click(posNow.x, posNow.y);
        await page.waitForTimeout(1400);
        let stNow = await readState(page);
        const beforeStage = stNow.stage;
        // 兜底：若没推进（暗块/朝向判定有偏差），在目标附近做小范围扫描
        if (stNow.tokenLen === 0) {
          const span = kind === 'rotate' ? 20 : 12;
          const step = kind === 'rotate' ? 10 : 4;
          for (let d = step; d <= span; d += step) {
            for (const sgn of [1, -1]) {
              await trackTo(Math.max(0, Math.min(vmax, target + sgn * d)));
              // ⚠️ chip 已随 value 移动 ⇒ 必须重新读它的当前位置再点
              const nb = await page.evaluate(() => {
                const c = document.getElementById('captcha_chip_default');
                const r = c.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              });
              await moveHuman(page, nb.x, nb.y);
              await page.mouse.click(nb.x, nb.y);
              await page.waitForTimeout(1300);
              stNow = await readState(page);
              // ⚠️ 不用 stage 判成功（答错后服务端会重发同 stage 新题，stage 会倒退）
              if (stNow.tokenLen > 0) break;
            }
            if (stNow.tokenLen > 0) break;
          }
          // 扫描失败后把 chip 停回最优解，避免下一阶段起点错位
          await trackTo(target);
          cur = await readVal();
        }
        rounds.push({ stage, kind, value: target, vmax: meta.vmax, via: 'track+scan',
                      chipNow: cur, stageAfter: stNow.stage, tokenLen: stNow.tokenLen,
                      grabVia, grabBytes });
        log(`  阶段${stage + 1} ${kind} value=${target} chip→${cur} ${stNow.stage}` +
            (stNow.tokenLen > 0 ? ' ★token' : ''));
      } else {
        // ⚠️ 实测 bug：ArrowLeft/Right **步进是 2**（不是 1）。
        //   旧循环条件 `|cur-target|>1` 在奇偶差时会死循环到 guard 耗尽仍差 1，
        //   然后拿错值提交 ⇒ 日志里大量 "目标 179 chip→83"。
        // 修法：① 用 Shift 做粗调（协议：Shift = vmax/18）；② 收敛判据放宽到 ±2；
        //      ③ 退出后**必须校验**，偏差 >2 就改走 trackTo（滑轨）精确逼近。
        const STEP = 2;
        let guard = 0;
        while (Math.abs(cur - target) > STEP && guard < 40) {
          const err = target - cur;
          if (Math.abs(err) > 20) {
            // 大偏差：Shift 粗调（一次 vmax/18）
            await page.keyboard.press(err > 0 ? 'Shift+ArrowRight' : 'Shift+ArrowLeft');
          } else {
            await page.keyboard.press(err > 0 ? 'ArrowRight' : 'ArrowLeft');
          }
          if (guard % 6 === 0) await page.waitForTimeout(120);
          cur = await readVal();
          guard++;
        }
        // 键盘没能精确命中（奇偶差 / 焦点丢失）⇒ 记录并交给下面的滑轨兜底
        const kbErr = Math.abs(cur - target);
        rounds.push({ stage, kind, value: target, vmax: meta.vmax, chipNow: cur,
                      iters: guard, kbErr, via: 'keyboard' });
        if (kbErr > 2) {
          log(`  阶段${stage + 1} ${kind} 键盘未精确命中（差 ${kbErr}），走滑轨`);
        } else {
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1500);
          log(`  阶段${stage + 1} ${kind} 目标 value=${target} chip→${cur} (${guard} 次) ★已提交`);
          cur = await readVal();
          if (cur === target) { /* 提交成功，继续下一阶段 */ }
        }
        // 键盘未精确命中 ⇒ 走滑轨精确逼近后再提交（否则拿错值提交，必错）
        if (Math.abs(cur - target) > 2) {
          const fixed = await trackNudge(target);
          rounds.push({ stage, kind, note: 'keyboard-miss->track', from: cur, to: fixed, target });
          log(`  阶段${stage + 1} ${kind} 滑轨兜底 ${cur} → ${fixed}（目标 ${target}）`);
          cur = fixed;
          if (Math.abs(cur - target) <= 2) {
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1500);
            log(`  阶段${stage + 1} ${kind} 滑轨命中 ${cur} ★已提交`);
          }
        }
      }

    } else if (kind === 'match') {
      const meta = await page.evaluate(() => {
        // left/right 坐标是固定值，从 DOM 的 svg line 无法读，用已知常量
        return null;
      });
      // match 的 left/right 固定：x=58/242, y=42/80/118, r=28
      const MMETA = { w: 300, h: 160,
        left: [58, 80, 118].map(y => ({ x: 58, y, r: 28 })),
        right: [58, 80, 118].map(y => ({ x: 242, y, r: 28 })) };
      const sol = solveMatch(img, MMETA);
      if (!sol.pairs.length) return { ok: false, why: 'MATCH_FAIL', rounds };
      const box = await page.locator('#captcha_box_default').boundingBox();
      const toPx = (lx, ly) => ({ x: box.x + (lx / 300) * box.width, y: box.y + (ly / 160) * box.height });
      for (const [li, ri] of sol.pairs) {
        const a = toPx(58, MMETA.left[li].y);
        await moveHuman(page, a.x, a.y); await page.mouse.click(a.x, a.y);
        await page.waitForTimeout(500);
        const bpt = toPx(242, MMETA.right[ri].y);
        await moveHuman(page, bpt.x, bpt.y); await page.mouse.click(bpt.x, bpt.y);
        await page.waitForTimeout(500);
      }
      // ★ 答错就在原地重复（实测 run#14：match 同一配对重复 17 次）。
      //   判据：同一 meta.id 下算出同一个配对 ⇒ 答案没被接受 ⇒ 换题。
      const sig = JSON.stringify(sol.pairs);
      if (lastMatch === sig) {
        rounds.push({ stage, kind, pairs: sol.pairs, note: '配对重复，换题' });
        log(`  阶段${stage + 1} match 配对重复，换题`);
        const swOk = await switchKind(page);
        if (swOk) switchFails = 0;
        else if (++switchFails > 1) {
          return { ok: false, why: 'SWITCH_DEAD', rounds,
                   note: '换题按钮连续无效，重开会话重摇题型' };
        }
        continue;
      }
      lastMatch = sig;
      rounds.push({ stage, kind, pairs: sol.pairs, scores: sol.scores });
      log(`  阶段${stage + 1} match 配对 ${JSON.stringify(sol.pairs)}`);
    } else {
      // rotate 或未知题型：换题
      const sw = page.locator('#captcha_switch_default').first();
      const bb = await sw.boundingBox();
      if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1200); }
      rounds.push({ stage, kind: kind || 'unknown', skipped: 'unsupported' });
      log(`  阶段${stage + 1} ${kind} 暂不支持，换题`);
      continue;
    }

    await page.waitForTimeout(3500);
    const after = await readState(page);
    rounds[rounds.length - 1].stageAfter = after.stage;
    rounds[rounds.length - 1].tokenLen = after.tokenLen;
    log(`    -> ${after.stage}${after.tokenLen > 0 ? ' (token 已拿到)' : ''}`);
    if (after.tokenLen > 0) break;
  }

  st = await readState(page);
  if (st.tokenLen === 0) return { ok: false, why: 'CAPTCHA_NOT_PASSED', rounds, st };

  // 4) 提交
  const btn = page.locator('button').filter({ hasText: /Confirm Renewal/i }).first();
  const bb = await btn.boundingBox();
  if (!bb) return { ok: false, why: 'NO_CONFIRM_BUTTON', rounds };
  const cx = Math.round(bb.x + bb.width / 2), cy = Math.round(bb.y + bb.height / 2);
  await moveHuman(page, cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(9000);

  const res = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return {
      renews: (t.match(/Renews until\s*([0-9\-: ]+)/) || [])[1]?.trim() || null,
      alert: (document.querySelector('.alert,.toast,[role=alert]')?.textContent || '').trim().slice(0, 220),
    };
  });
  return {
    ok: true, rounds, tokenLen: st.tokenLen,
    renewsAfter: res.renews,
    // 服务端冷却话术 = 请求已被受理，只是撞了 24h 限额
    throttled: /only be renewed once every/i.test(res.alert || ''),
    alert: res.alert,
  };
}

async function once() {
  let { browser, page } = await launch();
  try {
    await page.goto(PANEL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const fp = await page.evaluate(() => window.__owFp || null);
    const info = await readRenew(page);
    log('登录态:', info.loggedIn, '| 实例:', info.running,
        '| 到期:', info.renews, `(${info.inDays})`, '| 指纹:', JSON.stringify(fp));
    if (!info.loggedIn) {
      return { ok: false, why: 'COOKIE_EXPIRED',
               note: 'Clerk 会话已失效，需重新导出 ow_cookies.json' };
    }
    const hl = hoursLeft(info.renews);
    log('距到期', hl === null ? '?' : hl.toFixed(1), '小时');

    // 阈值：到期前 48h 内才真的动（平台每 24h 可续 1 次，别无节制点）
    const THRESHOLD_H = Number(process.env.OW_THRESHOLD_H || 48);
    if (hl !== null && hl > THRESHOLD_H) {
      return { ok: true, skipped: true, hoursLeft: hl, renews: info.renews,
               note: `距到期 ${hl.toFixed(1)}h > 阈值 ${THRESHOLD_H}h，本轮不续` };
    }

    // ★ 多会话重试：换题在坏会话里会失效（实测 run#17：40 阶段全是 puzzle，

    //   换题后题型不变 => 换题按钮对同一会话已无效）。

    //   正确策略 = **重开浏览器会话重摇**，而不是在原地空转。

    // 依据：7 天周期 + 24h 冷却 ⇒ 一周期内 7 次机会；题型 5 选 1、已通 4 种

    //   ⇒ 单次 4/5，7 次全败 = (1/5)^7 = 0.0013%。

    const SESSIONS = Number(process.env.OW_SESSIONS || 4);

    let r = { ok: false, why: 'NO_ATTEMPT', rounds: [], sessions: [] };

    for (let si = 0; si < SESSIONS; si++) {

      if (si > 0) {

        log(`换新会话（第 ${si + 1}/${SESSIONS} 次）`);

        // ★ 整个重开：browser + page + cookie 注入 + 打开面板。
        //   换题按钮在同一会话里会失效（实测 40 阶段全是 puzzle，
        //   换题后 meta.id 不变），只有新会话才能重新摇题型。
        try { await browser.close(); } catch (e) {}

        const s = await launch();

        if (!s || !s.page) break;

        browser = s.browser; page = s.page;

        await page.goto(PANEL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        await page.waitForTimeout(4000);

      }

      r = await doRenew(page);

      r.sessions = si + 1;

      if (r.ok || r.throttled || r.skipped) break;      // 成功/冷却/跳过 ⇒ 无需再试

      if (r.rounds && r.rounds.length) log(`会话 ${si + 1} 结束：${r.rounds.length} 阶段（${r.why || '未通过'}），重开会话`);

    }
    const after = await readRenew(page);
    return { ...r, hoursLeft: hl, renewsBefore: info.renews, after };
  } finally {
    await browser.close();
  }
}

async function loop() {
  const HOURS = Number(process.env.OW_INTERVAL_H || 8);
  for (;;) {
    try {
      const r = await once();
      log('结果:', JSON.stringify(r));
      if (process.env.OW_NOTIFY) {
        try { fs.appendFileSync(process.env.OW_NOTIFY, JSON.stringify(r) + '\n'); } catch (e) {}
      }
    } catch (e) {
      log('异常:', e.message);
    }
    await new Promise(r => setTimeout(r, HOURS * 3600 * 1000));
  }
}

const mode = process.argv[2] || 'once';
(mode === 'loop' ? loop() : once()).then(async (r) => {
  if (mode !== 'loop') {
    console.log(JSON.stringify(r, null, 1));

    // Telegram 通知：续期成功/失败/跳过都发。
    // ⚠️ 只在「真跑了」时通知：skipped（未到窗口）每 6h 一次会刷屏，
    //    所以 skipped 除非 force 模式否则静默。
    // ⚠️ formatResult 自己就带标题行（🎁/⚠️ + 续期通知），
    //    这里不要再拼标题，否则会出现两条标题。
    if (process.env.TG_TOKEN && process.env.TG_CHAT) {
      const isForce = process.env.OW_THRESHOLD_H === '9999';
      if (!r.skipped || isForce) {
        try {
          await notify('', formatResult(r), { raw: true });
        } catch (e) {
          console.warn('Telegram 通知异常（不影响结果）:', e.message);
        }
      } else {
        console.log('[TG] 跳过通知（未到续期窗口，避免刷屏）');
      }
    }
    // GitHub Actions：把结论写进 $GITHUB_STEP_SUMMARY，便于在网页上直接看
    if (process.env.GITHUB_STEP_SUMMARY) {
      const line = r.skipped
        ? `跳过：距到期 ${r.hoursLeft?.toFixed(1)}h > 阈值（当前 ${r.renews}）`
        : r.ok
          ? `续期${r.throttled ? '已提交（服务端 24h 冷却）' : '成功'}：${r.renewsBefore} -> ${r.renewsAfter}`
          : `失败：${r.why}`;
      try {
        require('fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          `## Openworld 自动续期\n\n- 结果：${line}\n- 到期：${r.renews || r.renewsBefore || '?'}\n`);
      } catch (e) { /* summary 可选 */ }
    }
    process.exit(r.ok ? 0 : 1);
  }
}).catch(e => { console.error('FATAL', e); process.exit(1); });
