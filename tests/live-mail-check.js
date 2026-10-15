'use strict';

/**
 * 真实邮箱只读验证。
 *
 * 目的：前面所有测试的 IMAP / SMTP 都是替身，这一步拿真邮箱验一遍
 * 「连接 → 取未读 → 用真 mailparser 解析 → 走真实流水线」。
 *
 * 安全边界（刻意收窄）：
 *   · 只读：直接调 handleOne()，它内部**不标已读**；本脚本也从不改 flag
 *   · 不发任何邮件、不删任何邮件
 *   · 不改任何状态
 *
 * 用法：
 *   node tests/live-mail-check.js           只看未读（跟守护进程一致）
 *   node tests/live-mail-check.js --recent  取最近几封（不管读没读）
 *   LIVE_RUN_DSH=1 node tests/live-mail-check.js --recent   真的跑 DSH 干活
 */

const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const ROOT = path.resolve(__dirname, '..');
const { loadConfig, maskEmail } = require('../src/config');
const { createDaemon } = require('../src/daemon');
const { createTaskRunner } = require('../src/task');
const { createSessionStore, findDshBin } = require('../src/dsh');
const { cleanBody, matchNewSession, matchHelp } = require('../src/email');
const { senderAllowed, isOwnReply, checkAuthenticity } = require('../src/security');

const RECENT = process.argv.includes('--recent');
const RUN_DSH = process.env.LIVE_RUN_DSH === '1';

(async () => {
  const { config: cfg, error, missing } = loadConfig(ROOT);
  if (missing || error) {
    console.log('没有可用的 config.json，跳过真实邮箱验证');
    process.exit(0);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('  真实邮箱 · 只读验证');
  console.log('  邮箱: ' + maskEmail(cfg.email));
  console.log('  IMAP: ' + cfg.imap.host + ':' + cfg.imap.port);
  console.log('  模式: ' + (RECENT ? '取最近几封（不管读没读）' : '只看未读') +
              (RUN_DSH ? '  + 真的跑 DSH' : '  （不跑 DSH）'));
  console.log('='.repeat(60));

  // ---- 1) 真实连接 ----
  const client = new ImapFlow({
    host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure !== false,
    auth: { user: cfg.email, pass: cfg.authCode }, logger: false
  });

  let jobs = [];
  try {
    await client.connect();
    console.log('\n[1] IMAP 登录                    OK');

    const lock = await client.getMailboxLock('INBOX');
    try {
      // RECENT 模式不按 seen 过滤，只按时间取最近的；本脚本不修改任何 flag
      const query = RECENT
        ? { since: new Date(Date.now() - 7 * 24 * 3600 * 1000) }
        : { seen: false };

      for await (const msg of client.fetch(query, { uid: true, envelope: true, source: true })) {
        let parsed = null, parseErr = null;
        try { parsed = await simpleParser(msg.source); } catch (e) { parseErr = e.message; }
        jobs.push({
          uid: msg.uid,
          fromList: ((msg.envelope && msg.envelope.from) || [])
            .map(a => String(a.address || '').toLowerCase()).filter(Boolean),
          subject: (msg.envelope && msg.envelope.subject) || '(无主题)',
          parsed, parseError: parseErr
        });
      }
    } finally {
      lock.release();
    }
    if (RECENT) jobs.sort((a, b) => b.uid - a.uid);
    console.log('[2] 取信 + 真 mailparser 解析      OK  拿到 ' + jobs.length + ' 封');
  } catch (e) {
    console.log('\n✗ IMAP 阶段失败：' + (e && e.message ? e.message : e));
    try { await client.logout(); } catch (x) {}
    process.exit(1);
  }
  try { await client.logout(); } catch (e) {}
  console.log('[3] IMAP 登出                    OK');

  // ---- 2) 真实邮件过一遍判定链路（纯函数，零副作用）----
  console.log('\n[4] 真实邮件过判定链路（纯函数，零副作用）');
  if (!jobs.length) {
    console.log('    没有邮件可验（收件箱是空的？）');
  }
  for (const job of jobs.slice(0, 8)) {
    const from = job.fromList[0] || '';
    const p = job.parsed || {};
    const rawText = String(p.text || '');
    const rawHtml = p.html ? String(p.html) : '';

    const mine = senderAllowed(job.fromList, cfg.allowFrom);
    const loop = isOwnReply({ headers: p.headers, fromList: job.fromList, ownAddress: cfg.email, text: rawText });
    const auth = checkAuthenticity({
      headers: p.headers, secret: cfg.secret, text: rawText, html: rawHtml,
      strictAuthCheck: cfg.strictAuthCheck
    });
    const bodyOpts = { from, stripSignatures: cfg.stripSignatures };
    const task = cleanBody(rawText, rawHtml, bodyOpts);

    let verdict;
    if (job.parseError) verdict = '解析失败';
    else if (!mine) verdict = '跳过·不在白名单';
    else if (loop) verdict = '跳过·自己的回信(' + loop + ')';
    else if (!auth.ok) verdict = '拦截·' + auth.reason;
    else if (!task) verdict = '跳过·正文空';
    else if (matchNewSession(task, bodyOpts)) verdict = '指令·开新会话';
    else if (matchHelp(task, bodyOpts)) verdict = '指令·帮助';
    else verdict = '派活给 DSH';

    console.log('    UID ' + String(job.uid).padEnd(4) +
                ' ' + maskEmail(from).padEnd(24) +
                ' 原文' + String(rawText.length).padStart(5) + '字' +
                ' 洗净' + String(task.length).padStart(4) + '字' +
                '  → ' + verdict);

    // 真实邮件里如果有"洗净后和原文差很多"的，值得看一眼是不是被误剥了
    if (task && rawText.length - task.length > 40) {
      console.log('        洗净后: ' + JSON.stringify(task.slice(0, 70)));
    }
  }

  // ---- 3) 真要跑 DSH 的话，用第一封白名单来信 ----
  if (RUN_DSH) {
    console.log('\n[5] 真的跑一次 DSH（用第一封白名单来信）');
    const bin = findDshBin({ dshBin: cfg.dshBin });
    console.log('    DSH 入口: ' + (bin || '(找不到)'));

    const target = jobs.find(j => senderAllowed(j.fromList, cfg.allowFrom) && !j.parseError);
    if (!bin) console.log('    找不到 DSH，跳过');
    else if (!target) console.log('    没有可用的白名单来信，跳过');
    else {
      const logs = [];
      const store = createSessionStore(path.join(require('os').tmpdir(), 'dshmb-live-' + Date.now() + '.json'));
      const runner = createTaskRunner({ log: (m) => logs.push(m), sessionStore: store, saveSessionId: () => {} });
      const sent = [];
      const daemon = createDaemon({
        cfg, log: (m) => logs.push(m), ImapFlow, simpleParser, nodemailer: {},
        runner, saveSessionId: () => {}, permissionFiles: []
      });
      const r = await daemon.handleOne(target, {
        bin, root: ROOT,
        transport: { async sendMail(m) { sent.push(m); return {}; } }
      });
      console.log('    动作: ' + r.action + (r.ok !== undefined ? '  成功=' + r.ok : ''));
      console.log('    耗时: ' + (r.seconds !== undefined ? r.seconds + ' 秒' : '-'));
      console.log('    日志:');
      logs.slice(-6).forEach(l => console.log('      ' + l));
      if (sent.length) {
        console.log('    （捕获到的回信，未真正发出）正文前 200 字:');
        console.log('      ' + String(sent[0].text || '').slice(0, 200).replace(/\n/g, '\n      '));
      }
    }
  } else {
    console.log('\n[5] 跳过真跑 DSH（想跑就加 LIVE_RUN_DSH=1）');
  }

  // ---- 4) SMTP 只验证连接 ----
  console.log('\n[6] SMTP 连接验证（只 verify，不发信）');
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure !== false,
      auth: { user: cfg.email, pass: cfg.authCode }
    });
    await t.verify();
    console.log('    SMTP verify                     OK（凭据可用，能发信）');
    t.close();
  } catch (e) {
    console.log('    ✗ SMTP verify 失败：' + (e && e.message ? e.message : e));
  }

  console.log('\n' + '='.repeat(60));
  console.log('  结束。没有发信、没有标已读、没有删信、没有改任何状态。');
  console.log('='.repeat(60));
  console.log('');
})().catch(e => {
  console.error('验证脚本异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
