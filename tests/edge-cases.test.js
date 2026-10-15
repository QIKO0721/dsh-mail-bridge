'use strict';

/**
 * 边界与对抗测试。
 *
 * 为什么单独一个文件：前面那些测试都是按"正常用法"写的用例，
 * 而这一轮穷举审计发现的问题全部出在**边界**上 ——
 * 下标 0、纯空格、类型不对、积压……正常用例永远碰不到这些。
 *
 * 每一条都对应一次真实的审计发现，注释里写清了"不修会怎样"。
 */

const path = require('path');
const { ok, eq, summary } = require('./helpers/_assert');

const email = require('../src/email');
const config = require('../src/config');
const sec = require('../src/security');
const util = require('../src/util');
const mail = require('../src/mail');

console.log('\n================ A. stripQuoted 的下标 0 ================');

// 审计发现：判据写成 `cut > 0` 时，引用标记出现在下标 0 的正文会被当成
// "没找到标记"而【原样保留】。而"整封正文就是一段引用"太常见了 ——
// 用户回复时没在引用上方写字就是这样。后果是邮箱里翻出来的旧正文
// 可能被当成新指令。
{
  const cases = [
    ['From: 开头', 'From: alice@example.com\nSubject: hi\n正文内容', ''],
    ['Outlook 分隔线开头', '-----Original Message-----\nFrom: x\n旧内容', ''],
    ['中文 写道 在开头', '在 2026年1月1日 Alice 写道：\n旧内容', ''],
    ['__ 下划线开头', '________\n历史记录', ''],
    ['= 等号开头', '========\n历史记录', ''],
    ['发件人：开头', '发件人: alice@example.com\n旧内容', '']
  ];
  for (const [label, input, want] of cases) {
    eq('整体是引用 → 清空（' + label + '）', email.stripQuoted(input).trim(), want);
  }

  // 标记在下标 0、但后面还有真实内容的情形（截断点正确就行）
  const mixed = 'From: alice@example.com\n正文在后面';
  eq('From: 在下标 0 时被截断', email.stripQuoted(mixed), '');

  // 回归：正常情况仍要工作
  eq('标记在中间照样截断', email.stripQuoted('干活\n\nFrom: a@b.com\n旧').trim(), '干活');
  eq('> 逐行引用仍被去掉', email.stripQuoted('> a\n> b').trim(), '');
  eq('没有标记时原样返回', email.stripQuoted('普通正文').trim(), '普通正文');
}

console.log('\n================ B. 配置校验的边界 ================');

// 审计发现：authCode 只判 `!cfg.authCode`，所以 '   '（几个空格）算"填了"，
// 一路带到 IMAP 登录才失败，报错是"认证失败"，用户想不到是空格。
// secret 允许数字通过，而后续 body.includes(数字) 会抛 TypeError。
{
  const mk = (o) => Object.assign({
    email: 'a@b.com', authCode: 'x'.repeat(16), allowFrom: ['a@b.com'],
    pollSeconds: 15, taskTimeoutSeconds: 600, secret: ''
  }, o || {});

  const has = (cfg, field) => config.validateConfig(cfg).some(p => p.field === field);

  eq('authCode 纯空格 → 拦住', has(mk({ authCode: '   ' }), 'authCode'), true);
  eq('authCode 制表符 → 拦住', has(mk({ authCode: '\t\t' }), 'authCode'), true);
  eq('authCode 正常 → 通过', has(mk(), 'authCode'), false);
  eq('authCode 是 null → 拦住', has(mk({ authCode: null }), 'authCode'), true);

  eq('secret 是数字 → 拦住', has(mk({ secret: 12345 }), 'secret'), true);
  eq('secret 是字符串 → 通过', has(mk({ secret: '芝麻开门' }), 'secret'), false);
  eq('secret 是空串 → 通过（等于没启用）', has(mk({ secret: '' }), 'secret'), false);
  eq('secret 太短 → 拦住', has(mk({ secret: 'ab' }), 'secret'), true);

  eq('allowFrom 含空串 → 拦住', has(mk({ allowFrom: [''] }), 'allowFrom'), true);
  eq('allowFrom 含纯空格 → 拦住', has(mk({ allowFrom: ['   '] }), 'allowFrom'), true);

  // ★ 关键：代码不能依赖"调用方一定校验过"
  const r = sec.checkAuthenticity({ headers: null, text: 'x', secret: 12345 });
  ok('secret 是数字时 checkAuthenticity 不抛异常', !!r && typeof r.ok === 'boolean', r);
  eq('并把数字当字符串比较（正文没有它 → 拦）', r.ok, false);
}

console.log('\n================ C. 回信上限的兜底 ================');

// 审计发现：`cfg.maxReplyChars || 40000` 挡不住 0 与负数，
// 而 slice(0, 负数) 会把正文整段切掉 —— 用户收到空回信，比不截断更糟。
(async () => {
  const capture = () => {
    const sent = [];
    return { sent, async sendMail(m) { sent.push(m); return {}; } };
  };
  const body = 'x'.repeat(500);

  for (const [label, val] of [['0', 0], ['负数', -1], ['NaN', NaN], ['undefined', undefined]]) {
    const t = capture();
    await mail.sendReply(t, { email: 'a@b.com', maxReplyChars: val },
                         { to: 'u@e.com', subject: 's', body });
    ok('maxReplyChars 是 ' + label + ' 时正文没被切没', t.sent[0].text.length > 400, t.sent[0].text.length);
  }

  const t2 = capture();
  await mail.sendReply(t2, { email: 'a@b.com', maxReplyChars: 10 }, { to: 'u@e.com', subject: 's', body });
  ok('正常的正数上限仍然生效', t2.sent[0].text.includes('截断'), t2.sent[0].text.length);

  console.log('\n================ D. 工具函数的边界 ================');
  eq('humanSeconds 负数不为负', util.humanSeconds(-5), '0 秒');
  eq('humanSeconds 0', util.humanSeconds(0), '0 秒');
  eq('humanSeconds NaN 不崩', typeof util.humanSeconds(NaN), 'string');
  eq('tidy 保留两个换行', util.tidy('a\n\n\nb'), 'a\n\nb');
  eq('maskEmail 无 @ 时整体打码', config.maskEmail('no-at-sign'), '***');
  eq('maskEmail 空串', config.maskEmail(''), '');

  console.log('\n================ E. 同形字与对抗输入 ================');
  // 西里尔字母 е (U+0435) 与拉丁 e 视觉相同 —— 白名单必须精确匹配，不能被蒙混
  const cyrillic = 'alic\u0435@example.com';
  eq('西里尔 е 冒充拉丁 e → 拒绝', sec.senderAllowed([cyrillic], ['alice@example.com']), false);
  eq('零宽字符插在中间 → 拒绝', sec.senderAllowed(['ali\u200Bce@example.com'], ['alice@example.com']), false);
  eq('前后带换行 → 仍然匹配（正常情况）',
     sec.senderAllowed(['alice@example.com\n'], ['alice@example.com']), true);
  eq('子域名冒充 → 拒绝', sec.senderAllowed(['alice@example.com.evil.com'], ['alice@example.com']), false);

  console.log('\n================ F. 指令判定的边界 ================');
  {
    const hit = (t) => !!email.matchNewSession(t, { from: 'a@b.com' });
    eq('超长（70 个"会"）→ 不认', hit('新' + '会'.repeat(70) + '话'), false);
    eq('指令后接第二行 → 不认', hit('新会话\n第二行还有内容'), false);
    eq('"把新会话删掉" → 不认', hit('把新会话删掉'), false);
    eq('"请问新会话怎么用" → 不认', hit('请问新会话怎么用'), false);
    eq('前后空格 → 认', hit('  新会话  '), true);
    eq('纯空白 → 不认', hit('   \n  '), false);
    eq('空串 → 不认', hit(''), false);
    eq('null → 不认', hit(null), false);
  }

  console.log('\n================ G. HTML 兜底的边界 ================');
  eq('script 内容被丢弃', email.htmlToText('<script>alert(1)</script>正文'), '正文');
  eq('style 内容被丢弃', email.htmlToText('<style>.a{color:red}</style>正文'), '正文');
  eq('只有标签 → 空串', email.htmlToText('<div><span></span></div>'), '');
  eq('未闭合标签不崩', email.htmlToText('<div>没关'), '没关');
  eq('实体 &nbsp; 变空格', email.htmlToText('a&nbsp;b'), 'a b');
  eq('null → 空串', email.htmlToText(null), '');

  process.exit(summary('edge cases'));
})();
