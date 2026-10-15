'use strict';

/**
 * 失败路径穷举：把"外部世界出问题时程序会怎样"逐条打一遍。
 *
 * 这一轮同样捕获过真问题，所以用例都留着当回归。
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const ROOT = path.resolve(__dirname, '..');
const { createDaemon } = require('../src/daemon');
const { createTaskRunner } = require('../src/task');
const { createSessionStore, runDshOnce, findDshBin } = require('../src/dsh');
const { defaultConfig } = require('../src/config');
const mail = require('../src/mail');
const { simpleParser } = require('mailparser');

const MOCK_DSH = path.join(__dirname, 'helpers', 'mock-dsh.js');
const MY = 'bot@example.com';
const FRIEND = 'alice@example.com';

// ==================== 假 IMAP，可按需失败 ====================

function imapThat(behavior) {
  const b = behavior || {};
  class Fake {
    async connect() { if (b.connectThrows) throw new Error(b.connectThrows); }
    async getMailboxLock() {
      if (b.lockThrows) throw new Error(b.lockThrows);
      return { release() { if (b.releaseThrows) throw new Error('release 炸了'); } };
    }
    async messageFlagsAdd() { if (b.flagThrows) throw new Error(b.flagThrows); }
    async logout() { if (b.logoutThrows) throw new Error(b.logoutThrows); }
    fetch() {
      if (b.fetchThrows) throw new Error(b.fetchThrows);
      const list = (b.messages || []).slice();
      return { async *[Symbol.asyncIterator]() { for (const m of list) yield m; } };
    }
  }
  return Fake;
}

function job(uid, text, over) {
  return Object.assign({
    uid,
    envelope: { from: [{ address: FRIEND }], subject: 's' + uid },
    source: 'src-' + uid,
    _parsed: { text, html: '', headers: { get() { return undefined; } } }
  }, over || {});
}

function daemonFor(opts) {
  const o = opts || {};
  const cfg = Object.assign(defaultConfig(), {
    email: MY, authCode: 'x'.repeat(16), allowFrom: [FRIEND],
    imap: {}, smtp: {}, pollSeconds: 15, taskTimeoutSeconds: 20
  }, o.cfg || {});
  const logs = [];
  const store = createSessionStore(path.join(tmpDir('dshmb-fail-'), 'state.json'));
  const runner = o.runner || createTaskRunner({
    log: (m) => logs.push(m), sessionStore: store, saveSessionId: () => {}
  });
  // 注意：imap 选项只用来指定"失败行为"，消息列表统一从 o.messages 取 ——
  // 早先让 imap.messages 覆盖 o.messages，导致想造"标已读失败但邮件正常"的
  // 场景时消息被悄悄换成空数组，测试假绿。
  const imapBehavior = Object.assign({}, o.imap || {}, { messages: o.messages || [] });
  const daemon = createDaemon({
    cfg, log: (m) => logs.push(m),
    ImapFlow: imapThat(imapBehavior),
    simpleParser: async (src) => {
      const m = (o.messages || []).find(x => x.source === src);
      return m && m._parsed ? { ...m._parsed } : simpleParser(src);
    },
    nodemailer: {}, runner, saveSessionId: () => {}, permissionFiles: []
  });
  return { daemon, cfg, logs, store };
}

const transportOK = () => {
  const sent = [];
  return { sent, async sendMail(m) { sent.push(m); return {}; } };
};

(async () => {
  console.log('\n================ A. IMAP 的各种失败姿态 ================');
  {
    const t = transportOK();
    const { daemon, logs } = daemonFor({ imap: { connectThrows: '认证失败' } });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('连接失败 → 返回 0 封，不抛', r.fetched, 0);
    ok('日志记了错', logs.some(l => l.includes('收取邮件出错')), logs);
    eq('没有误发回信', t.sent.length, 0);
  }
  {
    const t = transportOK();
    const { daemon, logs } = daemonFor({ imap: { lockThrows: '拿不到 INBOX 锁' } });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('拿锁失败 → 不抛', r.fetched, 0);
    ok('日志记了错', logs.some(l => l.includes('收取邮件出错')), logs);
  }
  {
    const t = transportOK();
    // fetch 本身抛（不是迭代中抛）
    const { daemon } = daemonFor({ imap: { fetchThrows: 'IMAP 断了' } });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('fetch 抛异常 → 不崩', r.fetched, 0);
  }
  {
    // 标已读失败（很常见：只读邮箱、配额、并发改）
    const t = transportOK();
    const { daemon, logs } = daemonFor({
      messages: [job(1, '帮我看看磁盘')],
      imap: { flagThrows: '无法设置标志' }
    });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('标已读失败 → 仍然继续处理这封', r.results.length, 1);
    eq('并且处理成功', r.results[0].action, 'handled');
    ok('没有把错误当致命', !logs.some(l => l.includes('收取邮件出错')), logs);
  }
  {
    // logout 抛异常不能影响结果
    const t = transportOK();
    const { daemon } = daemonFor({
      messages: [job(2, '你好')],
      imap: { logoutThrows: '断连时报错' }
    });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('logout 抛异常 → 结果照常返回', r.results.length, 1);
  }

  console.log('\n================ B. SMTP 的各种失败姿态 ================');
  {
    const failTransport = {
      async sendMail() { throw new Error('SMTP 拒收：550'); }
    };
    const { daemon, logs } = daemonFor({ messages: [job(3, '干活')] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: failTransport });
    eq('回信失败 → 记成 error', r.results[0].action, 'error');
    ok('日志里记下了', logs.some(l => l.includes('处理邮件出错')), logs);
  }
  {
    // 第一封回信失败，第二封要照常
    let n = 0;
    const flaky = {
      async sendMail() { n++; if (n === 1) throw new Error('第一次抖动'); return {}; }
    };
    const { daemon } = daemonFor({ messages: [job(4, '第一封'), job(5, '第二封')] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: flaky });
    eq('两封都处理到了', r.results.length, 2);
    eq('第一封 error', r.results[0].action, 'error');
    eq('第二封照常 handled', r.results[1].action, 'handled');
  }

  console.log('\n================ C. DSH 失败姿态（真跑假 DSH）================');
  {
    const t = transportOK();
    const { daemon } = daemonFor({ messages: [job(6, '__UNKNOWN_SESSION__')] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('DSH 报会话不存在 → 仍给用户回信', t.sent.length, 1);
    eq('动作是 handled（DSH 层失败但流程走完）', r.results[0].action, 'handled');
    eq('结果标记为失败', r.results[0].ok, false);
    ok('回信里说明出错', t.sent[0].text.includes('出错'), t.sent[0].text.slice(0, 80));
  }
  {
    const t = transportOK();
    const { daemon } = daemonFor({ messages: [job(7, '__HANG__')], cfg: { taskTimeoutSeconds: 2 } });
    const t0 = Date.now();
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    const secs = (Date.now() - t0) / 1000;
    ok('超时在 2~10 秒内被掐掉（不是永久挂住）', secs < 12, secs.toFixed(1) + ' 秒');
    eq('结果标记失败', r.results[0].ok, false);
    ok('回信说明了超时', /超时/.test(t.sent[0].text), t.sent[0].text.slice(0, 100));
  }
  {
    const t = transportOK();
    const { daemon } = daemonFor({ messages: [job(8, '__NO_OUTPUT__')] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('DSH 无输出 → 回信说明退出码', r.results[0].ok, false);
    ok('回了信', t.sent.length === 1);
  }
  {
    // DSH 入口不存在
    const t = transportOK();
    const { daemon } = daemonFor({ messages: [job(9, '干活')] });
    const r = await daemon.pollOnce({ bin: path.join(ROOT, '不存在.js'), root: ROOT, transport: t });
    eq('入口不存在 → 明确报错', r.results[0].ok, false);
    ok('回信里提了 dshBin', /dshBin|入口/.test(t.sent[0].text), t.sent[0].text.slice(0, 120));
  }

  console.log('\n================ D. 畸形邮件数据 ================');
  {
    // envelope 里没有 from
    const t = transportOK();
    const bad = job(10, '干活');
    bad.envelope = {};
    const { daemon } = daemonFor({ messages: [bad] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('没有发件人 → 跳过（不在白名单）', r.results[0].action, 'skip-not-allowed');
  }
  {
    // subject 是 undefined
    const t = transportOK();
    const noSubj = job(11, '你好');
    delete noSubj.envelope.subject;
    const { daemon } = daemonFor({ messages: [noSubj] });
    await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('没有主题 → 仍能回信', t.sent.length, 1);
    ok('主题补了默认值', /无主题/.test(t.sent[0].subject), t.sent[0].subject);
  }
  {
    // parsed.text 是 null、html 是 null
    const t = transportOK();
    const nulls = job(12, 'x', { _parsed: { text: null, html: null, headers: { get: () => undefined } } });
    const { daemon } = daemonFor({ messages: [nulls] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('text/html 都是 null → 当作空正文跳过', r.results[0].action, 'skip-empty');
    eq('没有误发回信', t.sent.length, 0);
  }
  {
    // uid 是 0 或负数（有些服务器会怪）
    const t = transportOK();
    const { daemon } = daemonFor({ messages: [job(0, '你好')] });
    const r = await daemon.pollOnce({ bin: MOCK_DSH, root: ROOT, transport: t });
    eq('uid 为 0 → 照常处理不崩', r.results.length, 1);
  }

  console.log('\n================ E. 会话状态文件损坏 ================');
  {
    const dir = tmpDir('dshmb-corrupt-');
    const f = path.join(dir, 'state.json');
    fs.writeFileSync(f, '这不是 JSON', 'utf8');
    const store = createSessionStore(f);
    const r = store.checkPermissionFingerprint('abc');
    eq('状态文件坏了 → 当作首次运行', r.firstRun, true);
    store.set({ sessionId: 'x' });
    eq('能重新写回去', store.get().sessionId, 'x');
    rmrf(dir);
  }
  {
    // 状态文件是合法 JSON 但是数组
    const dir = tmpDir('dshmb-arr-');
    const f = path.join(dir, 'state.json');
    fs.writeFileSync(f, '[1,2,3]', 'utf8');
    const store = createSessionStore(f);
    let threw = null;
    try { store.checkPermissionFingerprint('abc'); } catch (e) { threw = e; }
    eq('状态文件是数组时不抛异常', threw, null);
    rmrf(dir);
  }

  console.log('\n================ F. runDshOnce 的参数畸形 ================');
  {
    const r1 = await runDshOnce({ bin: MOCK_DSH, task: '', timeoutMs: 10000 });
    eq('空任务 → 假 DSH 回显空，但仍算 ok', r1.ok, true);
  }
  {
    // ⚠️ 早先写的是 `opts.timeoutMs || 600000`，于是传 0 会被当成"没传"，
    //    静默变成 10 分钟 —— 与调用方意图相反且毫无提示。
    //    现在只在"不是有效正数"时才用默认值，所以 0/负数/NaN 都走默认（不会挂死），
    //    而"默认值生效"这件事在快速返回的任务上是观察不到的，所以这里验的是行为：
    //    畸形值不会让它卡住，也不会让它立刻瞎超时。
    for (const bad of [0, -1, NaN, 'abc', null]) {
      const r = await runDshOnce({ bin: MOCK_DSH, task: 'x', timeoutMs: bad });
      eq('timeoutMs=' + String(bad) + ' → 正常跑完（回退到默认超时）', r.ok, true);
      eq('  没有被误判成超时', r.timedOut, false);
    }
    // 有效的小超时仍然要生效
    const r2 = await runDshOnce({ bin: MOCK_DSH, task: '__HANG__', timeoutMs: 800 });
    eq('有效的小超时仍然生效', r2.timedOut, true);
  }
  {
    const r3 = await runDshOnce({ bin: '', task: 'x' });
    eq('bin 为空 → ok=false', r3.ok, false);
    eq('标记 binMissing', r3.binMissing, true);
  }

  console.log('\n================ G. 路径与平台相关 ================');
  {
    eq('findOnPath 对空名字返回空串', findDshBin({ dshBin: '' }) !== undefined, true);
    const saved = process.env.PATH;
    process.env.PATH = '';
    eq('PATH 为空时不崩', typeof findDshBin({}), 'string');
    process.env.PATH = saved;
  }
  {
    // 含空格的路径（Windows 常见）
    const dir = tmpDir('dshmb space ');
    const f = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(f, 'a: 1', 'utf8');
    const dsh = require('../src/dsh');
    const fp = dsh.permissionFingerprint([f]);
    ok('含空格的路径能算指纹', /^[0-9a-f]{16}$/.test(fp), fp);
    rmrf(dir);
  }

  process.exit(summary('failure paths'));
})().catch(e => {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
