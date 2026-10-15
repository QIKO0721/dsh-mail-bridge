'use strict';

/**
 * 邮件收发：IMAP 收信、SMTP 回信。
 *
 * 这一层只负责"跟邮箱服务器说话"，判定逻辑一概不在这里。
 * 依赖全部注入（ImapFlow / simpleParser / nodemailer 都是传进来的），
 * 所以测试不需要真的连邮箱。
 */

const { LOOP_HEADER } = require('./security');
const { messages } = require('./i18n');

// 回信主题里的占位符也要跟语言走
const { t2 } = messages();

/** 从 mailparser 的 envelope 里取出干净的发件人地址列表 */
function envelopeFromList(envelope) {
  const from = (envelope && envelope.from) || [];
  return from
    .map(a => String((a && a.address) || '').trim().toLowerCase())
    .filter(Boolean);
}

/** 用配置造一个 IMAP 连接 */
function createImapClient(ImapFlow, cfg) {
  return new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure !== false,
    auth: { user: cfg.email, pass: cfg.authCode },
    logger: false          // imapflow 默认会往控制台吐一堆东西，关掉
  });
}

/** 用配置造一个 SMTP 传输 */
function createTransport(nodemailer, cfg) {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure !== false,
    auth: { user: cfg.email, pass: cfg.authCode }
  });
}

/**
 * 取一封未读邮件的原始数据。
 * 只取信封 + 原始源文，不下载附件内容 —— 附件由 mailparser 自己处理。
 */
async function fetchUnread(client, simpleParser) {
  const lock = await client.getMailboxLock('INBOX');
  const jobs = [];
  try {
    // 注意：{ seen: false } 只拿未读的；处理完立刻标已读，避免重复处理
    for await (const msg of client.fetch({ seen: false },
                                         { uid: true, envelope: true, source: true })) {
      const envelope = msg.envelope || {};
      let parsed = null;
      try {
        parsed = await simpleParser(msg.source);
      } catch (e) {
        parsed = null;
      }
      jobs.push({
        uid: msg.uid,
        fromList: envelopeFromList(envelope),
        subject: envelope.subject || t2('(无主题)', '(no subject)'),
        date: envelope.date || null,
        parsed,
        parseError: parsed ? null : t2('邮件解析失败', 'failed to parse the email')
      });
    }
  } finally {
    lock.release();
  }
  return jobs;
}

/** 标记已读。先标已读再处理，避免处理失败时被无限重复处理 */
async function markSeen(client, uid) {
  try {
    await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 发回信。
 *
 * ★ 必带 X-Mail-Bridge-Bot 头：这是防自环的第一道保险。
 *   本程序用自己的邮箱收发，如果回信落回同一个收件箱又被当成新指令，
 *   就会无限套娃、白烧额度。
 *
 * @param {object} opts
 * @param {string} opts.to      收件人
 * @param {string} opts.subject
 * @param {string} opts.body
 * @param {string} [opts.overrideTo] 仅供联调脚本使用：替换真正投递的地址，
 *        好在不打扰任何人的前提下真实走一遍 SMTP 发送路径。主流程从不传它。
 */
async function sendReply(transport, cfg, opts) {
  let text = String(opts.body || '');
  // 上限兜底：万一被配成 0 或负数，`slice(0, 负数)` 会把正文整段切没，
  // 用户收到的是一封空回信 —— 比"没截断"更糟。所以非正数一律按默认值处理。
  const configured = Number(cfg.maxReplyChars);
  const max = configured > 0 ? configured : 40000;
  if (text.length > max) {
    text = text.slice(0, max) + t2('\n\n…（内容太长，已截断）', '\n\n... (truncated, too long)');
  }

  const mail = {
    from: cfg.fromName ? (cfg.fromName + ' <' + cfg.email + '>') : cfg.email,
    to: opts.overrideTo || opts.to,
    subject: opts.subject,
    text,
    headers: {}
  };
  mail.headers[LOOP_HEADER] = '1';

  await transport.sendMail(mail);
}

/** 回复时统一加 Re: 前缀，但不重复叠加 */
function replySubject(subject) {
  const s = String(subject || t2('(无主题)', '(no subject)')).trim();
  return /^re\s*:/i.test(s) ? s : ('Re: ' + s);
}

module.exports = {
  envelopeFromList,
  createImapClient,
  createTransport,
  fetchUnread,
  markSeen,
  sendReply,
  replySubject
};
