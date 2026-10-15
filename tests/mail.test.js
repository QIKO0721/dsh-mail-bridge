'use strict';

/**
 * mail.js 的单元测试。
 *
 * 补这个文件的原因：sendReply() 是"把结果送回给用户"的最后一环，
 * 却一直只被端到端测试间接覆盖 —— 连它会不会正确带上防自环标记，
 * 都得靠假 IMAP 的全链路才验得到。这一环单独坏掉的话，
 * 现象是"回信发出去了但助手开始套娃"，很难查。
 */

const { ok, eq, summary } = require('./helpers/_assert');
const mail = require('../src/mail');
const { LOOP_HEADER } = require('../src/security');

/** 收信的假 transport：把邮件存下来供断言 */
function captureTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(m) { sent.push(m); return { messageId: 'x' }; }
  };
}

const CFG = {
  email: 'bridge@example.com',
  fromName: 'Mail Bridge',
  maxReplyChars: 100
};

(async () => {
  console.log('\n--- envelope 里的发件人提取 ---');
  eq('能取出地址', mail.envelopeFromList({ from: [{ address: 'A@B.com' }] }).join(','), 'a@b.com');
  eq('转成小写', mail.envelopeFromList({ from: [{ address: 'Mixed@Case.COM' }] }).join(','), 'mixed@case.com');
  eq('多个发件人', mail.envelopeFromList({ from: [{ address: 'a@b.com' }, { address: 'c@d.com' }] }).length, 2);
  eq('没有 from 时返回空数组', mail.envelopeFromList({}).length, 0);
  eq('envelope 是 null 也不崩', mail.envelopeFromList(null).length, 0);
  eq('地址为空字符串时被过滤掉', mail.envelopeFromList({ from: [{ address: '' }] }).length, 0);

  console.log('\n--- 主题加 Re: 前缀 ---');
  eq('普通主题加前缀', mail.replySubject('你好'), 'Re: 你好');
  eq('已有 Re: 不重复叠加', mail.replySubject('Re: 你好'), 'Re: 你好');
  eq('小写 re: 也认', mail.replySubject('re: 你好'), 're: 你好');
  eq('RE: 大写也认', mail.replySubject('RE: 你好'), 'RE: 你好');
  eq('空主题给个默认', mail.replySubject(''), 'Re: (无主题)');
  eq('null 主题也不崩', mail.replySubject(null), 'Re: (无主题)');

  console.log('\n--- ★ sendReply：防自环标记必须带上 ---');
  {
    const t = captureTransport();
    await mail.sendReply(t, CFG, { to: 'user@example.com', subject: 'Re: x', body: '答复内容' });
    eq('发了一封', t.sent.length, 1);
    const m = t.sent[0];
    eq('★ 带上了防自环标记头', m.headers[LOOP_HEADER], '1');
    eq('收件人正确', m.to, 'user@example.com');
    eq('正文正确', m.text, '答复内容');
    ok('发件人带显示名', m.from === 'Mail Bridge <bridge@example.com>', m.from);
  }

  console.log('\n--- 没配 fromName 时的发件人 ---');
  {
    const t = captureTransport();
    await mail.sendReply(t, { email: 'bridge@example.com' }, { to: 'u@e.com', subject: 's', body: 'b' });
    eq('退化成纯邮箱地址', t.sent[0].from, 'bridge@example.com');
  }

  console.log('\n--- 正文超长要截断 ---');
  {
    const t = captureTransport();
    await mail.sendReply(t, CFG, { to: 'u@e.com', subject: 's', body: 'x'.repeat(500) });
    const body = t.sent[0].text;
    ok('正文被截到上限附近', body.length < 200, body.length);
    ok('并注明了截断', body.includes('截断'), body.slice(-40));
  }

  console.log('\n--- overrideTo：只给联调脚本用的投递地址替换 ---');
  {
    const t = captureTransport();
    await mail.sendReply(t, CFG, {
      to: 'real@example.com', subject: 's', body: 'b', overrideTo: 'nobody@example.invalid'
    });
    eq('实际投递地址被替换', t.sent[0].to, 'nobody@example.invalid');
  }
  {
    const t = captureTransport();
    await mail.sendReply(t, CFG, { to: 'real@example.com', subject: 's', body: 'b' });
    eq('不传 overrideTo 时正常投递', t.sent[0].to, 'real@example.com');
  }

  console.log('\n--- 空正文也不该崩 ---');
  {
    const t = captureTransport();
    await mail.sendReply(t, CFG, { to: 'u@e.com', subject: 's' });
    eq('正文为空字符串', t.sent[0].text, '');
  }

  process.exit(summary('mail'));
})().catch(e => {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
