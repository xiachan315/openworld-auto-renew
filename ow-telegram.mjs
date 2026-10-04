/**
 * Telegram 通知模块（零依赖，只用 node:https）
 *
 * 用法：
 *   import { notify } from './ow-telegram.mjs';
 *   await notify('标题', '正文');
 *
 * 环境变量：
 *   TG_TOKEN   Bot token（形如 123456:ABC-DEF...）
 *   TG_CHAT    目标 chat id
 *   TG_SILENT  设成 1 时静默（不发送），只打日志 —— 便于本地试跑
 *
 * 设计要点：
 *   · 通知失败**绝不影响主流程**（续期成功与否比通知重要）
 *   · 超时 15s，失败重试 2 次（Actions 网络偶发抖动）
 *   · 本机沙箱访问不了 Telegram（http=000）⇒ 静默降级为日志
 */
import https from 'node:https';

const TOKEN = process.env.TG_TOKEN || '';
const CHAT = process.env.TG_CHAT || '';
const SILENT = process.env.TG_SILENT === '1';

function post(host, path, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, data: e.message }));
    req.write(payload);
    req.end();
  });
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 发一条通知。
 * @param {string} title 标题（会加粗）
 * @param {string} body  正文（放 code block 里，避免 Markdown 解析出错）
 * @param {object} opts  { silent: true } 时不实际发送
 */
export async function notify(title, body, opts = {}) {
  // raw 模式：body 自带标题与排版（续期通知走这条），不再外包一层
  const text = opts.raw
    ? String(body ?? '').slice(0, 3900)
    : [
        `*${esc(title)}*`,
        '',
        '```',
        String(body ?? '').slice(0, 3500),
        '```',
      ].join('\n');

  if (!TOKEN || !CHAT) {
    console.log(`[TG 未配置] ${title} :: ${String(body).slice(0, 200)}`);
    return { ok: false, why: 'no-config' };
  }
  if (SILENT || opts.silent) {
    console.log(`[TG 静默] ${title} :: ${String(body).slice(0, 200)}`);
    return { ok: true, skipped: true };
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await post('api.telegram.org',
      `/bot${TOKEN}/sendMessage`,
      {
        chat_id: CHAT,
        text,
        ...(opts.raw ? {} : { parse_mode: 'MarkdownV2' }),
        disable_web_page_preview: true,
      });
    if (r.status === 200) {
      console.log('[TG 已发送]', title);
      return { ok: true };
    }
    // MarkdownV2 解析失败就去掉格式重试一次
    if (r.status === 400 && r.data.includes('parse_mode')) {
      const r2 = await post('api.telegram.org', `/bot${TOKEN}/sendMessage`,
        { chat_id: CHAT, text: `${title}\n\n${body}`.slice(0, 3500) });
      if (r2.status === 200) { console.log('[TG 已发送(纯文本)]', title); return { ok: true }; }
    }
    console.warn(`[TG 第 ${attempt} 次失败] status=${r.status} ${String(r.data).slice(0, 120)}`);
    if (attempt < 3) await new Promise((r2) => setTimeout(r2, 2000 * attempt));
  }
  // 通知失败不抛异常 —— 续期结果比通知重要
  return { ok: false, why: 'send-failed' };
}

// --------------------------------------------------------------------------
// 通知正文格式 —— 与 HostShip-Renew 保持一致
// （⚠️ 续期通知 / 👤 账户 / ⏰ 时间 / ✅ 实例 / 📅 剩余 / 🎉 结果 / 📊 统计）
// ---------------------------------------------------------------------------

/** UTC → 北京时间（Actions runner 是 UTC） */
export function bjNow(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate())
       + ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes());
}

/** "2026-10-09 18:34:27" -> 5（天）；解析不了返回 null */
export function daysLeft(renews) {
  if (!renews) return null;
  const m = String(renews).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  // 面板给的是北京时间，转成 UTC 毫秒再算差
  const bj = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Math.floor((bj - Date.now()) / 86400000);
}

const ICONS = {
  renewed: '✅',
  skip: '⏳',
  warn: '⏰',
  failed: '❌',
};

const STATUS_TEXT = {
  skip: '⏳ 未到续期时间，已跳过',
  warn: '⏰ 即将到期，等待自动续期窗口',
  failed: '❌ 续期失败',
};

/**
 * 把续期结果整理成通知正文。
 * 结构与 HostShip-Renew 的通知完全一致。
 */
export function formatResult(r, opts = {}) {
  const who = opts.account || 'openworld';
  const days = daysLeft(r.renewsBefore || r.renews);
  const daysAfter = daysLeft(r.renewsAfter);

  // ⚠️ status 文本里不要再带 emoji —— 外层已按状态选好 icon，重复会显示成
  //    「🎉 🎉 续期成功」（实测踩到）。
  let icon, status, failed;
  if (r.ok && r.throttled) { icon = ICONS.skip;    status = '已提交，服务端 24h 冷却中（明天会真正续上）'; failed = false; }
  else if (r.ok)            { icon = ICONS.renewed; status = '续期成功'; failed = false; }
  else if (r.skipped)       { icon = ICONS.skip;    status = '未到续期时间，已跳过'; failed = false; }
  else                      { icon = ICONS.failed;  status = '续期失败'; failed = true; }

  const L = [];
  L.push((failed ? '⚠️' : '🎁') + ' Openworld 续期通知（1 台）');
  L.push('');
  L.push('👤 账户：' + who);
  L.push('⏰ 时间：' + bjNow() + '（北京时间）');
  L.push('');
  L.push(icon + ' ' + (opts.instance || 'openworld-vps'));
  const dayTxt = days === null ? '未知' : days + ' 天';
  L.push('　📅 剩余：' + dayTxt
         + (r.renewsBefore || r.renews ? '（' + String(r.renewsBefore || r.renews).slice(0, 16) + '）' : ''));
  if (r.ok) {
    L.push('　' + (r.throttled ? '⏳' : '🎉') + ' ' + status
           + (daysAfter === null ? '' : '，续期后剩余 ' + daysAfter + ' 天'));
  } else if (r.skipped) {
    L.push('　' + icon + ' ' + status);
  } else {
    L.push('　' + icon + ' ' + status + '：' + (r.why || '未知原因'));
    if (r.note) L.push('　📝 ' + r.note);
  }
  L.push('');

  // 阶段明细（只在真解验证码失败时给，便于排查）
  if (r.rounds && r.rounds.length && !r.skipped) {
    L.push('🔍 验证码阶段：');
    for (const x of r.rounds.slice(0, 6)) {
      const bits = ['#' + (x.stage + 1), x.kind];
      if (x.i !== undefined) bits.push('i=' + x.i);
      if (x.margin !== undefined) bits.push('margin=' + x.margin);
      if (x.value !== undefined) bits.push('value=' + x.value);
      if (x.pairs) bits.push(JSON.stringify(x.pairs));
      if (x.skipped) bits.push('skipped=' + x.skipped);
      L.push('　' + bits.join(' '));
    }
    if (r.rounds.length > 6) L.push('　… 共 ' + r.rounds.length + ' 条');
    L.push('');
  }

  // 失败只算真失败；skipped 归到「跳过」，不能同时计入失败
  L.push('📊 续期 ' + (r.ok ? 1 : 0)
       + ' / 跳过 ' + (r.skipped ? 1 : 0)
       + ' / 失败 ' + (failed ? 1 : 0));

  return L.join('\n');
}
