'use strict';

/**
 * 安全校验：白名单、防伪造、防自环。
 *
 * 三条独立的防线，任何一条不通过就不处理这封邮件。
 */

const LOOP_HEADER = 'x-mail-bridge-bot';

/** 从 mailparser 的 headers 对象里安全地取一个头，取不到返回 '' */
function getHeader(headers, name) {
  try {
    if (!headers || typeof headers.get !== 'function') return '';
    const v = headers.get(name);
    if (!v) return '';
    return Array.isArray(v) ? v.join(' | ') : String(v);
  } catch (e) {
    return '';
  }
}

/**
 * 发件人是否在白名单里。精确全等匹配 —— 绝不做模糊匹配，
 * 否则 someone@evil.com 可能被 `@` 后面半截之类的规则放进来。
 *
 * @param {string[]} fromList 邮件里解析出的发件人地址列表
 * @param {string[]} allowFrom 配置里的白名单
 */
function senderAllowed(fromList, allowFrom) {
  const allow = (allowFrom || []).map(a => String(a).trim().toLowerCase()).filter(Boolean);
  const from = (fromList || []).map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
  if (!from.length || !allow.length) return false;
  return from.some(a => allow.includes(a));
}

/**
 * 防自环：认出"这是本程序自己发出去的回信"。
 *
 * 为什么需要：本程序用自己的邮箱收发。如果收件箱里落进了自己发的信，
 * 而白名单里又有自己，就会把回信当成新指令 → 再回一封 → 无限套娃，白烧额度。
 *
 * 两道识别：
 *   1) 自己发的信带 X-Mail-Bridge-Bot 头 —— 最可靠
 *   2) 兜底：老版本回信没那个头，但结尾有固定署名格式
 */
function isOwnReply(opts) {
  const headers = opts.headers;
  const fromList = (opts.fromList || []).map(a => String(a || '').toLowerCase());
  const own = String(opts.ownAddress || '').toLowerCase();
  const text = String(opts.text || '');

  // 1) 标记头
  if (getHeader(headers, LOOP_HEADER)) return '头标记';

  // 2) 兜底署名：必须同时满足"寄件人是自己"+"结尾是固定格式"
  const legacySig = /\n\s*---\s*\n\s*[^\n]{0,20}·\s*用时\s*\d+\s*秒\s*$/;
  if (own && fromList.includes(own) && legacySig.test(text)) return '署名兜底';

  return '';
}

/**
 * 防伪造：光看 From 是不够的 —— 发件人地址可以伪造。
 *
 * 实测规律（以 QQ 邮箱为例，其他大厂类似）：
 *   · 从服务商**内部**发出的信（网页版 / 官方 App / 自家 SMTP）
 *       不会带 Authentication-Results 头
 *   · 从**外部服务器**发进来的信
 *       入站网关会加上 Authentication-Results，里面有 spf= / dkim= 结果
 *
 * 所以策略是：
 *   没有该头  → 视为服务商内部投递，放行
 *   有该头    → 外部来信，必须 SPF 通过；伪造大厂地址的必然 spf=fail
 *
 * 副作用：如果用户用**别的服务商**发信，也会被当作外部来信要求 SPF。
 *        正常的服务商都会通过，但自建邮件服务器可能不通过 ——
 *        那种情况把地址加进 allowFrom 并关掉 strictAuthCheck（见配置说明）。
 *
 * @returns {{ok: boolean, reason?: string, detail?: string, note?: string}}
 */
function checkAuthenticity(opts) {
  const headers = opts.headers;
  // ⚠️ 一律 String() 之后再比较 —— 如果 config 里把暗号写成了数字，
  //    `String.prototype.includes(数字)` 会抛 TypeError。
  //    配置校验虽然会拦，但代码不该依赖"调用方一定校验过"。
  const secret = opts.secret == null ? '' : String(opts.secret);

  // 可选暗号：填了就必须包含
  if (secret) {
    const body = String(opts.text || '') + '\n' + String(opts.html || '');
    if (!body.includes(secret)) {
      return { ok: false, reason: '正文里没有找到暗号' };
    }
  }

  if (opts.strictAuthCheck === false) {
    return { ok: true, note: '已关闭 SPF/DKIM 校验（strictAuthCheck=false）' };
  }

  const ar = getHeader(headers, 'authentication-results');

  // ⚠️ 这里是整个安全模型里【最该被质疑】的一条假设：
  //    「没有 Authentication-Results 头 = 服务商内部投递」。
  //
  //    实测依据（QQ 邮箱）：从网页版 / 官方 App / 自家 SMTP 发出的信确实没有这个头，
  //    而从外部服务器发进来的信，入站网关一定会加上它。
  //
  //    但这条规律【取决于服务商】。如果换一家邮箱，而它对外部来信也不加这个头，
  //    那么下面的放行就等于「跳过校验」，此时白名单就是唯一防线了。
  //
  //    想更保险：在 config.json 里设一个 secret —— 那样即使头部规律失效，
  //    没有暗号的信也进不来。README 里也写了这一点。
  if (!ar.trim()) return { ok: true, note: '服务商内部投递（未做 SPF/DKIM 校验）' };

  const spfPass = /spf\s*=\s*pass/i.test(ar);
  const spfBad = /spf\s*=\s*(fail|softfail|permerror|temperror|none)/i.test(ar);
  const dkimBad = /dkim\s*=\s*(fail|policy|permerror|temperror)/i.test(ar);

  if (spfBad || !spfPass) {
    return {
      ok: false,
      reason: 'SPF 未通过（发件人地址可能是伪造的）',
      detail: ar.slice(0, 200)
    };
  }
  if (dkimBad) {
    return { ok: false, reason: 'DKIM 校验失败', detail: ar.slice(0, 200) };
  }
  return { ok: true, note: '外部来信，SPF 通过' };
}

module.exports = {
  LOOP_HEADER,
  getHeader,
  senderAllowed,
  isOwnReply,
  checkAuthenticity
};
