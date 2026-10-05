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
const ready = (page) => page.evaluate(() => {
  const bg = document.getElementById('captcha_bg_default');
  const st = document.getElementById('captcha_status_default');
  return !!(bg && bg.src && bg.src.startsWith('blob:') &&
            getComputedStyle(bg).display === 'block' &&
            st && getComputedStyle(st).display === 'none');
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
  // 优先：chip 是 <img> 且 src 是 blob（key/puzzle 题型）
  const fromImg = await page.evaluate(async () => {
    const chip = document.getElementById('captcha_chip_default');
    if (!chip) return null;
    if (chip.tagName === 'IMG' && chip.src && chip.src.startsWith('blob:')) {
      const buf = await (await (await fetch(chip.src)).blob()).arrayBuffer();
      const u8 = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return s;
    }
    return null;
  });
  if (fromImg) return fromImg;

  // 兜底（rotate 题型实测 chip 不是 img，src 取到非 PNG）：
  // 直接对 chip 的屏幕区域截图 —— 对任何题型都成立。
  const box = await page.evaluate(() => {
    const c = document.getElementById('captcha_chip_default');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    // ★ 必须确认 chip 完全落在视口内，否则 page.screenshot({clip}) 会截到
    //   视口外的空白 ⇒ 拿到非 PNG 数据（实测 rotate 题型 20 次全部 not a PNG）。
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.x < 0 || r.y < 0 || r.right > vw || r.bottom > vh) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) return null;
  // 优先用元素截图（Playwright 会自动滚动到元素）
  try {
    const png = await page.locator('#captcha_chip_default').first().screenshot({ type: 'png' });
    const b64 = png.toString('base64');
    if (b64 && b64.length > 200) return b64;
  } catch (e) { /* 退到 clip */ }
  try {
    const png = await page.screenshot({
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      type: 'png',
    });
    return png.toString('base64');
  } catch (e) {
    return null;
  }
}

/** 取页面**当前这道题**的 PNG（另开 ws 拿到的是另一题，必错） */
async function grabPng(page) {
  return page.evaluate(async () => {
    const bg = document.getElementById('captcha_bg_default');
    if (!bg || !bg.src || !bg.src.startsWith('blob:')) return { err: 'no blob' };
    const buf = await (await (await fetch(bg.src)).blob()).arrayBuffer();
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return { b64: btoa(s) };
  });
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
  const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
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

async function readRenew(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    return {
      renews: (t.match(/Renews until\s*([0-9\-: ]+)/) || [])[1]?.trim() || null,
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
async function switchKind(page) {
  const sw = page.locator('#captcha_switch_default').first();
  const bb = await sw.boundingBox();
  if (!bb) return false;
  const beforeFp = await puzzleFingerprint(page);
  const beforeStage = (await readState(page)).stage;
  const beforeSrc = await page.evaluate(() => document.getElementById('captcha_bg_default')?.src || null);
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  await moveHuman(page, cx, cy);
  await page.mouse.click(cx, cy);
  // 服务端可能限流 / 冷却 ⇒ 轮询等新题就绪
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(700);
    const stNow = await readState(page);
    if (stNow.tokenLen > 0) return true;               // 答案已过 = 成功
    if (stNow.stage !== beforeStage) return true;     // 阶段推进 = 成功
    if (await waitReady(page, 2, 300)) {
      const afterFp = await puzzleFingerprint(page);
      const afterSrc = await page.evaluate(() => document.getElementById('captcha_bg_default')?.src || null);
      // 指纹变了才叫换题成功；指纹为 null（还没图）时退回等就绪
      if (afterFp && beforeFp && afterFp !== beforeFp) return true;
      // meta 未捕获时（钩子没装上）的兜底：比对背景 blob src 的 href 字符串
      if ((!beforeFp || !afterFp) && beforeSrc && afterSrc && beforeSrc !== afterSrc) return true;
    }
  }
  return false;
}

async function doRenew(page) {
  // 1) 开弹窗
  await page.locator('button').filter({ hasText: /^Renew free$/ }).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  if (!await waitReady(page)) return { ok: false, why: 'STAGE_NOT_READY' };

  // 2) 若首阶段是 rotate / key（暂不能稳定离线求解的题型），先换题
  for (let i = 0; i < 8; i++) {
    const st = await readState(page);
    const k = kindOf(st.hint);
    if (k !== 'rotate' && k !== 'key') break;
    if (!st.canSwitch) break;
    if (!await switchKind(page)) { await page.waitForTimeout(1800); }
  }
  // 3) 逐阶段求解（按题型分派）
  const rounds = [];
  let st = await readState(page);
  let keySwitches = 0;
  let lastOdd = null;
  let stuckRepeats = 0;
  let lastPuzzle = null;
  let samePuzzleCount = 0;
  for (let stage = 0; stage < 24; stage++) {
    st = await readState(page);
    if (st.tokenLen > 0) break;
    if (!await waitReady(page)) return { ok: false, why: 'NOT_READY', rounds };

    const kind = kindOf(st.hint);
    const png = await grabPng(page);
    if (png.err) return { ok: false, why: 'GRAB_FAIL', rounds };
    const img = await decodePng(page, png.b64);

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
        // 换题按钮点不动时（run#7 实测：连续 20 次重复，switchKind 静默失败），
        // 再点也是白点。⇒ 累计 3 次就放弃本轮，等下次 cron 换一批题。
        if (++stuckRepeats > 2) {
          return { ok: false, why: 'STUCK_NO_SWITCH', rounds,
                   note: `odd 答案重复 ${stuckRepeats} 次且换题无效（按钮点不动），本轮放弃` };
        }
        rounds.push({ stage, kind, i: sol.i, margin: sol.margin, note: '答案重复，换题' });
        log(`  阶段${stage + 1} odd 判定重复，换题（第 ${stuckRepeats} 次）`);
        if (!await switchKind(page)) {
          await page.waitForTimeout(2500);
          const still = await readState(page);
          if (still.tokenLen === 0 && still.stage === st.stage) {
            // 换题没生效：直接放弃，别空转
            return { ok: false, why: 'STUCK_NO_SWITCH', rounds,
                     note: '换题无效（stage 与 token 均未变化），本轮放弃' };
          }
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
            const chipImg = decodePngFromB64(chipPng);
            r2 = solveRotate2(chipImg, { vmax: meta.vmax });
          } catch (e) {
            // chip 的 blob 可能还没换成新题（src 仍是旧图或空）⇒ 换题重来
            r2 = { i: null, why: 'chip-decode:' + String(e.message).slice(0, 40) };
          }
        }
        if (r2.i === null) {
          rounds.push({ stage, kind, skipped: r2.why });
          log(`  阶段${stage + 1} rotate ${r2.why}，换题`);
          if (!await switchKind(page)) await page.waitForTimeout(2000);
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
        if (++keySwitches > 12) {
          return { ok: false, why: 'KEY_STUCK', rounds,
                   note: `连换 ${keySwitches} 次仍抽到 key（本轮放弃，等下次 cron）` };
        }
        rounds.push({ stage, kind, skipped: 'unreliable', keySwitch: keySwitches });
        log(`  阶段${stage + 1} key 不可靠，换题（第 ${keySwitches} 次）`);
        await switchKind(page);
        // 换题后看新题型：不是 key 就清零（说明换题真的生效了）
        const newKind = await page.evaluate(() => window.__owCapMeta?.kind || null);
        if (newKind && newKind !== 'key') {
          log(`  → 已换到 ${newKind} 题型，清零 key 计数`);
          keySwitches = 0;
        } else {
          await page.waitForTimeout(2000);
        }
        continue;
      } else {
        // 拼块宽度必须从 DOM 的 chip style.width 读（puzzle=32% / key=24%，不能猜）
        const pw = Math.round((meta.chipWPct / 100) * 300);
        const sol = solveGap(img, { w: 300, h: 160, vmax: meta.vmax, pw, px: 4 });
        if (sol.i === null) {
          const sw = page.locator('#captcha_switch_default').first();
          const bb = await sw.boundingBox();
          if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1200); }
          rounds.push({ stage, kind, skipped: 'no-blob' });
          log(`  阶段${stage + 1} ${kind} 缺口未定位，换题`);
          continue;
        }
        target = sol.i;
      }

      // ---- 交互策略：先粗拖（产生真实 pointer 轨迹喂行为门），再键盘精调，最后 Enter 提交 ----
      // ---- 交互策略 ----
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
      const readVal = () => page.evaluate(() =>
        Number(document.getElementById('captcha_chip_default')?.getAttribute('aria-valuenow') || 0));
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
        const handleW = meta.handleW || 24;
        const span = Math.max(1, meta.trackW - handleW);
        const vmax = meta.vmax || 204;
        const trackTo = async (want) => {
          const f = Math.max(0, Math.min(1, want / vmax));
          const x = meta.trackX + handleW / 2 + f * span;
          await moveHuman(page, x, meta.trackCy);
          await page.mouse.down();
          await page.waitForTimeout(90);
          await page.mouse.up();
          await page.waitForTimeout(600);
        };
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
          if (++samePuzzleCount > 2) {
            return { ok: false, why: 'PUZZLE_STUCK', rounds,
                     note: `${kind} 定位重复 ${samePuzzleCount} 次（value=${target}），本轮放弃` };
          }
          rounds.push({ stage, kind, value: target, note: '定位重复，换题' });
          log(`  阶段${stage + 1} ${kind} 定位重复，换题`);
          if (!await switchKind(page)) await page.waitForTimeout(2500);
          continue;
        }
        lastPuzzle = sig;
        samePuzzleCount = 0;

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
              if (stNow.tokenLen > 0 || stNow.stage !== beforeStage) break;
            }
            if (stNow.tokenLen > 0 || stNow.stage !== beforeStage) break;
          }
          cur = await readVal();
        }
        rounds.push({ stage, kind, value: target, vmax: meta.vmax, via: 'track+scan',
                      chipNow: cur, stageAfter: stNow.stage, tokenLen: stNow.tokenLen });
        log(`  阶段${stage + 1} ${kind} value=${target} chip→${cur} ${stNow.stage}` +
            (stNow.tokenLen > 0 ? ' ★token' : ''));
      } else {
        let guard = 0;
        while (Math.abs(cur - target) > 1 && guard++ < 60) {
          await page.keyboard.press(cur < target ? 'ArrowRight' : 'ArrowLeft');
          if (guard % 8 === 0) await page.waitForTimeout(150);
          cur = await readVal();
        }
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        rounds.push({ stage, kind, value: target, vmax: meta.vmax, chipNow: cur, iters: guard, via: 'keyboard' });
        log(`  阶段${stage + 1} ${kind} 目标 value=${target} chip→${cur} (${guard} 次)`);
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
  const { browser, page } = await launch();
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

    const r = await doRenew(page);
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
