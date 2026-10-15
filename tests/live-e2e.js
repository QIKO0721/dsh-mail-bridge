'use strict';

/**
 * 真实链路联调（会真的连邮箱、真的跑 DSH）。
 *
 * 目的：把前面所有"替身测试"覆盖不到的那一段，用真家伙走一遍：
 *   · 真实 IMAP 登录、取信、真 mailparser 解析
 *   · 真实邮件过真实流水线（含真的调 DSH）
 *   · 真实 mail.sendReply() 走一遍 SMTP 发送路径
 *
 * ★ 安全设计：回信【绝不发进主人的收件箱】。
 *   通过 opts.overrideTo 把投递地址换成 example.invalid —— 按 RFC 2606 保留域名，
 *   DNS 永远解析不出来，所以 SMTP 一定会拒收，不可能误投给任何人。
 *   这样既真实验证了"组装 + 发送"这条代码路径，又什么都不会污染。
 *
 * 用法： node tests/live-e2e.js [UID]
 */

const path = require('path');
const os = require('os');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const ROOT = path.resolve(__dirname, '..');
const { loadConfig, maskEmail } = require('../src/config');
const { createDaemon } = require('../src/daemon');
const { createTaskRunner } = require('../src/task');
const { createSessionStore, findDshBin } = require('../src/dsh');
const { cleanBody } = require('../src/email');
const { senderAllowed } = require('../src/security');
const mail = require('../src/mail');

/** 永远不会被投递的收件人（RFC 2606 保留域名） */
const BLACKHOLE = 'nobody@example.invalid';

(async () => {
  const { config: cfg, error, missing } = loadConfig(ROOT);
  if (missing || error) { console.log('没有 config.json，跳过'); process.exit(0); }

  const bin = findDshBin({ dshBin: cfg.dshBin });
  console.log('');
  console.log('='.repeat(60));
  console.log('  真实链路联调（IMAP 真连 / DSH 真跑 / SMTP 真发但投黑洞）');
  console.log('  邮箱: ' + maskEmail(cfg.email));
  console.log('  DSH : ' + (bin || '(找不到)'));
  console.log('='.repeat(60));
  if (!bin) { console.log('\n没有 DSH，只能验到邮件部分'); }

  // ---- 1) 取一封白名单来信 ----
  const client = new ImapFlow({
    host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure !== false,
    auth: { user: cfg.email, pass: cfg.authCode }, logger: false
  });
  await client.connect();
  console.log('\n[1] IMAP 登录                     OK');

  const wantUid = process.argv[2] ? Number(process.argv[2]) : null;
  const jobs = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    for await (const m of client.fetch({ since: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
                                       { uid: true, envelope: true, source: true })) {
      if (wantUid && m.uid !== wantUid) continue;
      let parsed = null, parseError = null;
      try { parsed = await simpleParser(m.source); } catch (e) { parseError = e.message; }
      jobs.push({
        uid: m.uid,
        fromList: ((m.envelope && m.envelope.from) || [])
          .map(a => String(a.address || '').toLowerCase()).filter(Boolean),
        subject: (m.envelope && m.envelope.subject) || '(无主题)',
        parsed, parseError
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  jobs.sort((a, b) => b.uid - a.uid);
  console.log('[2] 取信 + 解析                    OK  ' + jobs.length + ' 封');

  const target = jobs.find(j => senderAllowed(j.fromList, cfg.allowFrom) && !j.parseError);
  if (!target) { console.log('\n没有可用的白名单来信，结束'); process.exit(0); }

  const task = cleanBody(String(target.parsed.text || ''),
                         target.parsed.html ? String(target.parsed.html) : '',
                         { from: target.fromList[0], stripSignatures: cfg.stripSignatures });
  console.log('    选中 UID ' + target.uid + '（' + maskEmail(target.fromList[0]) + '）');
  console.log('    洗净后的任务: ' + JSON.stringify(task));

  if (!bin) { console.log('\n没 DSH，无法继续'); process.exit(0); }

  // ---- 3) 真跑流水线 ----
  console.log('\n[3] 真实流水线（含真的调 DSH，可能要几十秒）');
  const logs = [];
  const store = createSessionStore(path.join(os.tmpdir(), 'dshmb-e2e-' + Date.now() + '.json'));
  const runner = createTaskRunner({ log: (m) => logs.push(m), sessionStore: store, saveSessionId: () => {} });

  const t = nodemailer.createTransport({
    host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure !== false,
    auth: { user: cfg.email, pass: cfg.authCode }
  });

  // 包一层：记录 sendReply 收到的信封，同时把它投到黑洞地址
  const captured = [];
  const wrapped = {
    async sendMail(m) {
      captured.push({ to: m.to, subject: m.subject, headers: m.headers, textLen: (m.text || '').length });
      return t.sendMail(Object.assign({}, m, { to: BLACKHOLE }));
    }
  };

  const daemon = createDaemon({
    cfg, log: (m) => logs.push(m), ImapFlow, simpleParser, nodemailer,
    runner, saveSessionId: () => {}, permissionFiles: []
  });

  const r = await daemon.handleOne(target, { bin, root: ROOT, transport: wrapped });
  console.log('    动作: ' + r.action + (r.ok !== undefined ? '   成功=' + r.ok : '') +
              (r.seconds !== undefined ? '   用时 ' + r.seconds + ' 秒' : ''));
  console.log('    日志:');
  logs.forEach(l => console.log('      ' + l));

  console.log('\n[4] mail.sendReply 真实走 SMTP（投到 ' + BLACKHOLE + '）');
  console.log('    捕获到的信封: ' + JSON.stringify(captured, null, 2).replace(/\n/g, '\n    '));

  if (captured.length) {
    // 直接调一次 sendReply，验证它会抛出的"收件人不存在"
    try {
      await mail.sendReply(t, cfg, {
        to: 'someone@example.invalid', subject: 'Re: 联调', body: '这封信不应该被任何人收到',
        overrideTo: BLACKHOLE
      });
      console.log('    ⚠ SMTP 居然接受了（意外，说明服务器没校验收件人）');
    } catch (e) {
      console.log('    ✓ 发送路径已真实执行，服务器按预期拒收：');
      console.log('      ' + String(e.message || e).split('\n')[0]);
    }
  }

  t.close();
  console.log('\n' + '='.repeat(60));
  console.log('  结束。主人的收件箱【没有】收到任何东西 —— 回信全部投向了不存在的域名。');
  console.log('='.repeat(60));
  console.log('');
})().catch(e => {
  console.error('联调异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
