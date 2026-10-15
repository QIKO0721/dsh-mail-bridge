'use strict';

/**
 * 邮件正文处理：引文清洗、签名剥离、特殊指令判定。
 *
 * 这个模块是纯函数集合 —— 不碰网络、不碰文件，方便单测。
 * 之所以单独拎出来，是因为这里每一条规则背后都有一个真实踩过的坑（见 README「踩坑记录」）。
 */

const { normalizeNewlines, tidy } = require('./util');

// ==================== 引文清洗 ====================

/**
 * 回复邮件时，客户端会自动把原文引用带上。
 * 如果不清洗，那些引用会被当成主人的新指令 —— 于是机器人把自己的回信又执行一遍。
 *
 * 不同客户端的引用格式：
 *   Gmail        On Mon, Jan 1, 2026 at 9:00 AM Alice <a@b.com> wrote:
 *   网易/QQ      ---- 原始邮件 ----
 *   中文客户端    在 2026年1月1日 09:00，Alice<a@b.com> 写道：
 *   Outlook      -----Original Message-----
 *                发件人: Alice <a@b.com>
 *   通用          > 开头逐行引用
 *                 From: ...
 */
const QUOTE_MARKERS = [
  /^[ \t]*在[ \t]*[^\n]{0,80}写道[：:][ \t]*$/m,            // 在 ... 写道：
  /^[ \t]*-{2,}[ \t]*原始邮件[ \t]*-{2,}[ \t]*$/m,          // ---- 原始邮件 ----
  /^[ \t]*-{2,}[ \t]*(Original Message|Forwarded message)[ \t]*-{2,}[ \t]*$/mi,
  /^[ \t]*On[ \t][^\n]{0,120}[ \t]wrote[：:][ \t]*$/mi,      // On ... wrote:
  /^[ \t]*_{8,}[ \t]*$/m,                                    // ________
  /^[ \t]*={8,}[ \t]*$/m,                                    // ========
  /^[ \t]*(发件人|寄件人|发信人)[：:][ \t]*/m,
  /^[ \t]*From:[ \t]*/mi,
  /^[ \t]*-{2,}[ \t]*以下为回复内容[ \t]*-{2,}[ \t]*$/m,
  /^[ \t]*>{1,}[ \t]*$/m                                     // 单独一行的 >
];

/**
 * 从"引用开始标记"处截断正文。
 *
 * ⚠️ 截断判断必须是 `cut >= 0`，不能是 `cut > 0`。
 *    用 `> 0` 的话，标记出现在**下标 0** 的正文会被当成"没找到标记"而原样保留 ——
 *    而"整封正文就是一段引用"是很常见的（用户回复时没在引用上方写东西）。
 *    真实踩过：`From: xxx` 开头的正文整段没被剥掉。
 *
 * @returns {string} 清洗后的正文
 */
function stripQuoted(text) {
  const t = normalizeNewlines(text);
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const m = t.match(re);
    if (m && typeof m.index === 'number') {
      if (cut < 0 || m.index < cut) cut = m.index;
    }
  }
  let out = cut >= 0 ? t.slice(0, cut) : t;

  // 逐行去掉 > 引用
  out = out.split('\n').filter(line => !/^[ \t]*>/.test(line)).join('\n');
  return out;
}

// ==================== 签名剥离 ====================

/** 标准邮件签名分隔符：单独一行的 "--" （RFC 3676），之后全是签名 */
const SIG_SEPARATOR = /\n--[ \t]*\n/;

/**
 * 剥掉末尾的签名块。
 *
 * 为什么必须做：很多邮件 App 会自动在正文末尾追加签名，例如
 *     新对话
 *
 *     Alice
 *     alice@example.com
 * 用户以为自己只发了"新对话"三个字，程序收到的却是 30 多字的一段文本 ——
 * 如果判定逻辑要求"整句就是个指令"，就会因为这段自动签名而判定失败。
 * **这是真实踩过的坑，不是假想。**
 *
 * @param {string} text       正文
 * @param {object} [opts]
 * @param {string} [opts.from] 发件人地址，用来认"含自己邮箱的签名尾巴"
 * @returns {string}
 */
function stripSignature(text, opts) {
  const options = opts || {};
  let t = normalizeNewlines(text).trim();

  // 1) RFC 3676 标准分隔符：最可靠，直接砍
  const sep = t.search(SIG_SEPARATOR);
  if (sep >= 0) t = t.slice(0, sep).trim();

  // 2) 形如「名字 + 邮箱」的尾巴（很多邮件 App 会自动追加）
  //    只在末尾两行、且第二行像邮箱地址时才动手 —— 宁可漏剥，不可误伤正文
  //
  //    ⚠️ 邮箱那段的量词必须是 {0,64} 而不是 {1,64}：
  //       用 {1,64} 的话，"@ 后面至少还得有一个字符"，
  //       而签名常常正好在字符串结尾，$ 就落空了 —— 整个正则直接不匹配。
  //       这个坑真实踩过：单行邮箱签名剥不掉，连带"新会话"指令判定失效。
  for (let i = 0; i < 5; i++) {
    const m = t.match(/(?:^|\n)([^\n]{0,40})\n[ \t]*([^\s\n]{1,64}@[^\s\n]{0,64})[ \t]*$/);
    if (!m) break;

    const lineAbove = m[1].trim();
    const addr = m[2].trim();

    // 往上那行如果非空，必须"短且不像正文"：没有句末标点
    const lineAboveLooksLikeName = lineAbove.length === 0 ||
      (lineAbove.length <= 24 && !/[。！？!?；;]$/.test(lineAbove));

    const isOwnAddress = options.from && addr.toLowerCase() === String(options.from).toLowerCase();

    // ⚠️ 空行也算"像签名"：签名的最常见形态就是
    //        指令正文
    //        （空行）
    //        name@example.com
    //    上面那行是空行。早期版本要求"上一行非空且像名字"，
    //    于是这种单行邮箱签名永远剥不掉 —— 真实踩过。
    if (!isOwnAddress && !lineAboveLooksLikeName) break;
    t = t.slice(0, m.index).trim();
  }

  return t;
}

// ==================== 特殊指令 ====================

/**
 * 判断正文是不是「开新会话」的指令。
 *
 * 判定步骤：
 *   0) 先剥掉末尾签名（否则自动签名会把整句判定搞挂）
 *   1) 去掉所有空白和常见标点，避免中英标点混用导致匹配失败
 *   2) 长度设上限：太长说明用户在派活，不是在重置记忆
 *   3) 认多种说法，但**不认"指令后面还接了活"** 的情况 ——
 *      「新会话，帮我看看 D 盘」应当被当成任务，不是重置
 *
 * @param {string} text
 * @param {object} [opts] { from: 发件人地址 }
 * @returns {string} 命中的原始写法（用于日志），没命中返回空串
 */
function matchNewSession(text, opts) {
  const options = opts || {};
  // 跟 cleanBody 保持同一套规则：stripSignatures 为 false 时不剥签名，
  // 否则会出现"任务文本没剥、判定却剥了"的不一致
  const stripped = options.stripSignatures === false
    ? String(text || '').trim()
    : stripSignature(text, options);

  const norm = stripped
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:～~…\-—/\\'"“”‘’（）()【】\[\]]/g, '');
  if (!norm) return '';
  if (norm.length > 60) return '';   // 太长 = 在派活

  // 英文
  if (/^(new|reset|clear)$/i.test(norm)) return norm;

  // 中文：「铺垫词」+ 新/一轮 +（会话|对话）
  const prep = '(?:那|请|现在|开启|开始|开个|来个|开|来|进入|重新|重置|再次|再|帮我|帮忙|个|一个|了)*';
  const core = '(?:新(?:的)?(?:[一1]轮)?(?:的)?(?:会话|对话)|[一1]轮新(?:的)?(?:会话|对话))';
  if (new RegExp('^' + prep + core + '$').test(norm)) return norm;

  // 「重置会话」这种不带「新」字的说法
  const clearPrefix = '(?:那|请|现在|帮我|帮忙|先|重新|再次|再|把|来|一下|一次|了)*';
  const clearVerb = '(?:重置|清空|清除|重开|重来|重启|换)';
  if (new RegExp('^' + clearPrefix + clearVerb + '(?:一下|一个|个)?(?:新)?(?:的)?(?:会话|对话)$').test(norm)) {
    return norm;
  }

  return '';
}

/** 判断正文是不是「帮助」指令 */
function matchHelp(text, opts) {
  const options = opts || {};
  const base = options.stripSignatures === false
    ? String(text || '').trim()
    : stripSignature(text, options);
  const norm = base
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?；;：:～~…\-—/\\'"“”‘’（）()【】\[\]]/g, '')
    .toLowerCase();
  return norm === '帮助' || norm === 'help' || norm === '/help';
}

// ==================== HTML 兜底 ====================

/**
 * 有些邮件只有 HTML 正文，没有纯文本部分。
 * 这里不做完整 HTML 解析（不值得引入依赖），够用即可。
 */
function htmlToText(html) {
  return tidy(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, '&'));
}

/**
 * 完整清洗流程：原文 → 可执行的指令文本。
 *
 * @param {string} rawText 邮件的 text 部分（可为空）
 * @param {string} rawHtml 邮件的 html 部分（可为空）
 * @param {object} [opts]
 * @param {string}  [opts.from]            发件人地址，用于认签名尾巴
 * @param {boolean} [opts.stripSignatures] 是否剥签名块，默认 true
 * @returns {string}
 */
function cleanBody(rawText, rawHtml, opts) {
  const options = opts || {};
  let text = normalizeNewlines(rawText || '').trim();
  if (!text && rawHtml) text = htmlToText(rawHtml);

  text = stripQuoted(text);
  // 默认剥签名；只有显式传 false 才跳过（对应 config.json 的 stripSignatures）
  if (options.stripSignatures !== false) {
    text = stripSignature(text, options);
  }
  return tidy(text);
}

module.exports = {
  stripQuoted,
  stripSignature,
  matchNewSession,
  matchHelp,
  htmlToText,
  cleanBody,
  SIG_SEPARATOR
};
