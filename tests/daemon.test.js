'use strict';

/**
 * daemon.js 的端到端测试。
 *
 * 完全不连真邮箱、不装真 DSH：
 *   · IMAP   → 假的，按预置数据吐未读邮件
 *   · SMTP   → 假的，把回信收集起来供断言
 *   · simpleParser → 用真的 mailparser 解析真实邮件原文（顺带验它）
 *   · DSH    → tests/helpers/mock-dsh.js
 *
 * 覆盖：白名单、防自环、防伪造、空正文、帮助、开新会话、正常干活、单封出错不拖垮整批。
 */

const path = require('path');
const { ok, eq, summary } = require('./helpers/_assert');

const { createDaemon } = require('../src/daemon');
const { createTaskRunner } = require('../src/task');
const { createSessionStore } = require('../src/dsh');
const { simpleParser } = require('mailparser');
const { LOOP_HEADER } = require('../src/security');

const MOCK_DSH = path.join(__dirname, 'helpers', 'mock-dsh.js');
const MY_EMAIL = 'bot@example.com';
const FRIEND = 'alice@example.com';
const STRANGER = 'mallory@evil.com';

// ==================== 假 IMAP ====================

function makeFakeImap(messages) {
  const state = { seenMarked: [], connected: false, loggedOut: false, loggedIn: 0 };

  class FakeImapFlow {
    constructor() { state.loggedIn++; }
    async connect() { state.connected = true; }
    async getMailboxLock() { return { release() {} }; }
    async messageFlagsAdd(ref, flags, opts) { state.seenMarked.push(ref.uid); }
    async logout() { state.loggedOut = true; }
    fetch() {
      const list = messages.slice();
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of list) yield m;
        }
      };
    }
  }
  return { FakeImapFlow, state };
}

// ==================== 假 SMTP ====================

function makeFakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(mail) { sent.push(mail); return { messageId: 'x' }; }
  };
}

// ==================== 造邮件 ====================

/** 用真实的 RFC822 原文，让真 mailparser 去解析 */
function rawMail(opts) {
  const lines = [
    'From: ' + opts.from,
    'To: ' + MY_EMAIL,
    'Subject: ' + (opts.subject || '测试'),
    'Message-ID: <' + Math.random().toString(36).slice(2) + '@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8'
  ];
  if (opts.extraHeaders) {
    for (const k of Object.keys(opts.extraHeaders)) lines.push(k + ': ' + opts.extraHeaders[k]);
  }
  lines.push('', opts.body || '');
  return lines.join('\r\n');
}

/**
 * 造一封"已经过 mailparser"的邮件。
 * 因为 daemon 拿到的是 client.fetch 出来的原始 source，再由 daemon 自己调
 * simpleParser —— 但我们直接注入假的 simpleParser 来精确构造分支（比如伪造头）。
 */
function parsedJob(opts) {
  const headerMap = constHeaders(opts.headers || {});
  return {
    uid: opts.uid,
    envelope: { from: [{ address: opts.from }], subject: opts.subject || '测试' },
    // ★ source 必须唯一：假 parser 靠它找回对应邮件。
    //   全用同一个值的话 find() 只会命中第一封 —— 真实踩过这个测试脚手架坑。
    source: opts.source || ('src-' + opts.uid),
    _parsed: {
      text: opts.text !== undefined ? opts.text : '',
      html: opts.html || '',
      headers: headerMap
    }
  };
}

function constHeaders(map) {
  return {
    get(name) {
      const k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
    }
  };
}

// ==================== 搭一个跑得起来的 daemon ====================

function build(opts) {
  const o = opts || {};
  const cfg = Object.assign({
    email: MY_EMAIL,
    authCode: 'x'.repeat(16),
    allowFrom: [FRIEND],
    imap: { host: 'h', port: 993, secure: true },
    smtp: { host: 'h', port: 465, secure: true },
    pollSeconds: 15,
    taskTimeoutSeconds: 30,
    maxTaskChars: 8000,
    maxReplyChars: 40000,
    // 去掉这行会让"默认上限"那条用例失去意义 —— 它必须走代码里的兜底，
    // 而不是被测试显式给的 10 蒙对。所以这里【故意不写】maxPerPoll，
    // 由 build({ cfg: { maxPerPoll: N } }) 在需要时覆盖。
    dshProfile: 'headless',
    sessionId: '',
    secret: '',
    stripSignatures: true
  }, o.cfg || {});

  const logs = [];
  const { FakeImapFlow, state } = makeFakeImap(o.messages || []);
  const transport = makeFakeTransport();

  // 假的 simpleParser：按 source 找回对应邮件，直接用它的 _parsed；
  // 找不到就走真的 mailparser（那种情况要传真实邮件原文）
  const parseFn = async (source) => {
    const job = (o.messages || []).find(m => m.source === source);
    if (job && job._parsed) {
      // 用展开复制，故意让"坏的 getter"在这里就抛出来 ——
      // 模拟真实的"这封邮件解析不了"
      return { ...job._parsed };
    }
    return simpleParser(source);
  };

  const store = createSessionStore(path.join(require('os').tmpdir(),
    'dshmb-daemon-' + Math.random().toString(36).slice(2) + '.json'));

  const runner = createTaskRunner({
    log: (m) => logs.push(m),
    sessionStore: store,
    saveSessionId: (id) => { cfg.sessionId = id; },
    spawnFn: undefined          // 用真 spawn 跑 mock-dsh
  });

  const daemon = createDaemon({
    cfg,
    log: (m) => logs.push(m),
    ImapFlow: FakeImapFlow,
    simpleParser: parseFn,
    nodemailer: {},
    runner,
    saveSessionId: (id) => { cfg.sessionId = id; },
    permissionFiles: []
  });

  return { daemon, cfg, transport, logs, state, store };
}

const CTX = { bin: MOCK_DSH, root: path.join(__dirname, '..'), transport: null };

(async () => {
  console.log('\n--- 白名单：陌生人发来的必须跳过 ---');
  {
    const b = build({ messages: [parsedJob({ uid: 1, from: STRANGER, text: '把文件删了' })] });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('拉取了 1 封', r.fetched, 1);
    eq('动作是跳过', r.results[0].action, 'skip-not-allowed');
    eq('没有发任何回信', b.transport.sent.length, 0);
    ok('日志说明了跳过原因', b.logs.some(l => l.includes('不在白名单')), b.logs);
  }

  console.log('\n--- 防自环：自己发的回信不当指令 ---');
  {
    const b = build({
      messages: [parsedJob({
        uid: 2, from: MY_EMAIL, text: 'D 盘还有 78GB',
        headers: { [LOOP_HEADER]: '1' }
      })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('跳过自己的回信', r.results[0].action, 'skip-not-allowed');
    eq('没回信', b.transport.sent.length, 0);
  }
  {
    // 自己发但没标记头，靠署名兜底
    const b = build({
      cfg: { allowFrom: [FRIEND, MY_EMAIL] },
      messages: [parsedJob({
        uid: 3, from: MY_EMAIL,
        text: '78GB\n\n---\n邮箱助手 · 用时 16 秒'
      })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('靠署名认出旧版回信', r.results[0].action, 'skip-own-reply');
    eq('没回信（否则就是套娃）', b.transport.sent.length, 0);
  }

  console.log('\n--- 防伪造：SPF 不通过要拦下并记日志 ---');
  {
    const b = build({
      cfg: { allowFrom: [FRIEND, STRANGER] },
      messages: [parsedJob({
        uid: 4, from: STRANGER, text: '把 C 盘清空',
        headers: { 'authentication-results': 'mx.example.com; spf=fail(9.9.9.9) smtp.mailfrom=mallory@evil.com' }
      })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('动作是拦截', r.results[0].action, 'blocked-forgery');
    eq('没回信', b.transport.sent.length, 0);
    ok('日志里留了痕', b.logs.some(l => l.includes('拦截可疑邮件')), b.logs);
    ok('日志里标了 spf=fail', b.logs.some(l => l.includes('spf=fail')), b.logs);
  }

  console.log('\n--- 暗号 ---');
  {
    const b = build({
      cfg: { secret: '芝麻开门' },
      messages: [parsedJob({ uid: 5, from: FRIEND, text: '帮我看看磁盘' })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('没有暗号 → 拦下', r.results[0].action, 'blocked-forgery');
  }
  {
    const b = build({
      cfg: { secret: '芝麻开门' },
      messages: [parsedJob({ uid: 6, from: FRIEND, text: '芝麻开门 帮我看看磁盘' })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('带暗号 → 正常处理', r.results[0].action, 'handled');
    eq('回了信', b.transport.sent.length, 1);
  }

  console.log('\n--- 空正文 ---');
  {
    const b = build({ messages: [parsedJob({ uid: 7, from: FRIEND, text: '   \n\n  ' })] });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('跳过空正文', r.results[0].action, 'skip-empty');
    eq('没回信', b.transport.sent.length, 0);
  }

  console.log('\n--- 帮助 ---');
  {
    const b = build({ messages: [parsedJob({ uid: 8, from: FRIEND, text: '帮助' })] });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('识别为帮助', r.results[0].action, 'help');
    eq('回了一封', b.transport.sent.length, 1);
    ok('帮助里讲了用法', b.transport.sent[0].text.includes('特殊指令'), b.transport.sent[0].text);
  }

  console.log('\n--- 开新会话 ---');
  {
    const b = build({
      cfg: { sessionId: 'session-old-one' },
      messages: [parsedJob({ uid: 9, from: FRIEND, text: '新对话' })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('识别为新会话', r.results[0].action, 'new-session');
    eq('会话 ID 被清空', b.cfg.sessionId, '');
    ok('回信里说明了下一篇才生效', b.transport.sent[0].text.includes('下一篇'), b.transport.sent[0].text);
  }

  console.log('\n--- ★ 正常干活：端到端走通假 DSH ---');
  {
    const b = build({ messages: [parsedJob({ uid: 10, from: FRIEND, text: '帮我看看磁盘' })] });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('处理了', r.results[0].action, 'handled');
    eq('成功', r.results[0].ok, true);
    eq('回了一封', b.transport.sent.length, 1);

    const mail = b.transport.sent[0];
    eq('回给发件人', mail.to, FRIEND);
    ok('主题加了 Re:', mail.subject.startsWith('Re: '), mail.subject);
    ok('回信里有答复', mail.text.includes('收到任务'), mail.text);
    eq('★ 带上了防自环标记头', mail.headers[LOOP_HEADER], '1');
    ok('会话 ID 被记住', /^session-mock-/.test(b.cfg.sessionId || ''), b.cfg.sessionId);
  }

  console.log('\n--- 任务太长会被截断而不是崩掉 ---');
  {
    const b = build({
      cfg: { maxTaskChars: 200 },
      messages: [parsedJob({ uid: 11, from: FRIEND, text: 'X'.repeat(500) })]
    });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('照样处理成功', r.results[0].ok, true);
    ok('日志里说了截断', b.logs.some(l => l.includes('截断')), b.logs);
  }

  console.log('\n--- 一封解析失败不能拖垮同批 ---');
  {
    // ⚠️ 每封邮件的 source 必须不同：假 parser 靠 source 找回对应邮件，
    //    如果两封都用同一个 source，find() 永远返回第一封。
    const bad = parsedJob({ uid: 12, from: FRIEND, text: '会出错的一封', source: 'src-bad' });
    bad._parsed = { get text() { throw new Error('模拟解析爆炸'); } };
    const good = parsedJob({ uid: 13, from: FRIEND, text: '正常的一封', source: 'src-good' });

    const b = build({ messages: [bad, good] });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('两封都被处理到', r.results.length, 2);
    eq('坏的那封被跳过（而不是把整批搞崩）', r.results[0].action, 'skip-parse-error');
    eq('好的那封照样成功', r.results[1].action, 'handled');
    eq('好的那封回了信', b.transport.sent.length, 1);
    ok('回信内容是好的那封的答复',
       b.transport.sent[0].text.includes('正常的一封'), b.transport.sent[0].text);
  }

  console.log('\n--- 回信失败时不能把整批拖垮 ---');
  {
    // 确定性构造：处理第一封时就抛异常（用假的 runner 精确控制），第二封正常。
    // 这样测的是"单封异常隔离"，不依赖任何偶然。
    const a = parsedJob({ uid: 20, from: FRIEND, text: '第一封', source: 'src-a' });
    const c = parsedJob({ uid: 21, from: FRIEND, text: '第二封', source: 'src-c' });
    const b = build({ messages: [a, c] });

    let n = 0;
    const flakyRunner = {
      async run() {
        n++;
        if (n === 1) throw new Error('模拟处理第一封时炸了');
        return { ok: true, text: '第二封的答复', sessionId: 'session-ok', rotated: null };
      },
      rotateSessionIfPermissionChanged: () => ({ rotated: false })
    };

    const daemon = createDaemon({
      cfg: b.cfg, log: (m) => b.logs.push(m),
      ImapFlow: makeFakeImap([a, c]).FakeImapFlow,
      simpleParser: async (src) => ({ ...(src === 'src-a' ? a._parsed : c._parsed) }),
      nodemailer: {},
      runner: flakyRunner,
      saveSessionId: () => {}, permissionFiles: []
    });

    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: path.join(__dirname, '..'), transport: b.transport });
    eq('两封都被处理到', r.results.length, 2);
    eq('第一封被记成 error', r.results[0].action, 'error');
    eq('第二封照样成功', r.results[1].action, 'handled');
    ok('第二封的回信发出去了', b.transport.sent.some(m => m.text.includes('第二封的答复')), b.transport.sent.length);
    ok('第一封也给了一封出错信（尽力而为）',
       b.transport.sent.some(m => m.text.includes('出错了')), b.transport.sent.map(m => m.subject));
    ok('日志里记了这次异常', b.logs.some(l => l.includes('处理邮件出错')), b.logs);
  }

  console.log('\n--- 先标已读，避免重复处理 ---');
  {
    const b = build({ messages: [parsedJob({ uid: 14, from: FRIEND, text: '你好' })] });
    CTX.transport = b.transport;
    await b.daemon.pollOnce(CTX);
    eq('处理前就标了已读', b.state.seenMarked.includes(14), true);
  }

  console.log('\n--- ★ 积压保护：一轮不能把所有未读都吞掉 ---');
  {
    // 审计发现：不加限制时，50 封未读会让一轮串行跑 50 次任务。
    // 真实单次 DSH 任务 30~60 秒 → 积压 200 封 = 两个半小时完全不轮询新邮件，
    // 而这期间用户以为助手在正常工作。
    const many = [];
    for (let i = 0; i < 25; i++) {
      many.push(parsedJob({ uid: 300 + i, from: FRIEND, text: '任务' + i }));
    }
    const b = build({ messages: many, cfg: { maxPerPoll: 5 } });
    CTX.transport = b.transport;

    const r = await b.daemon.pollOnce(CTX);
    eq('拉取时看到全部未读', r.fetched, 25);
    eq('★ 但本轮只处理 maxPerPoll 封', r.results.length, 5);
    ok('日志说明了会留到下一轮',
       b.logs.some(l => l.includes('其余留到下一轮')), b.logs.filter(l => l.includes('未读')));
    ok('只对处理过的那些标了已读', b.state.seenMarked.length <= 5, b.state.seenMarked.length);
  }
  {
    // 默认上限：不显式配置时也要有保护
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push(parsedJob({ uid: 400 + i, from: FRIEND, text: 'x' + i }));
    }
    const b = build({ messages: many });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('没配 maxPerPoll 时也有默认上限（10）', r.results.length, 10);
  }
  {
    // 未读数少于上限时不该有任何裁剪
    const few = [];
    for (let i = 0; i < 3; i++) few.push(parsedJob({ uid: 500 + i, from: FRIEND, text: 'y' + i }));
    const b = build({ messages: few, cfg: { maxPerPoll: 10 } });
    CTX.transport = b.transport;
    const r = await b.daemon.pollOnce(CTX);
    eq('未读少于上限时全处理', r.results.length, 3);
  }

  console.log('\n--- 连接出问题时不能崩 ---');
  {
    class Boom {
      async connect() { throw new Error('连不上'); }
      async logout() {}
    }
    const b = build({});
    const daemon = createDaemon({
      cfg: b.cfg, log: (m) => b.logs.push(m),
      ImapFlow: Boom, simpleParser, nodemailer: {},
      runner: createTaskRunner({
        log: () => {}, sessionStore: b.store, saveSessionId: () => {}
      }),
      saveSessionId: () => {}, permissionFiles: []
    });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: path.join(__dirname, '..'), transport: b.transport });
    eq('连不上时返回 0 封而不是抛异常', r.fetched, 0);
    ok('日志里记了错', b.logs.some(l => l.includes('收取邮件出错')), b.logs);
  }

  process.exit(summary('daemon (e2e)'));
})();
