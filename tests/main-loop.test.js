'use strict';

/**
 * 主循环时序测试。
 *
 * 前面所有测试都是"调用一次 pollOnce()"，而从没有人验过 start() 里那个
 * while 循环本身：会不会真的按间隔跑多轮？stop() 之后能不能干净退出？
 * 间隔被配成畸形值时会不会空转？
 *
 * 这些只有把 start() 真跑起来才看得到。
 */

const path = require('path');
const { ok, eq, summary } = require('./helpers/_assert');

const { createDaemon } = require('../src/daemon');
const { createTaskRunner } = require('../src/task');
const { createSessionStore, findDshBin } = require('../src/dsh');
const { defaultConfig } = require('../src/config');
const os = require('os');

/** 假 IMAP：每轮返回固定几封（用来数"跑了几轮"） */
function fakeImap(counter, perRound) {
  class Fake {
    async connect() { counter.rounds++; }
    async getMailboxLock() { return { release() {} }; }
    async messageFlagsAdd() {}
    async logout() {}
    fetch() {
      const list = [];
      for (let i = 0; i < (perRound || 0); i++) {
        list.push({
          uid: counter.rounds * 100 + i,
          envelope: { from: [{ address: 'a@b.com' }], subject: 's' },
          source: 'x'
        });
      }
      return { async *[Symbol.asyncIterator]() { for (const m of list) yield m; } };
    }
  }
  return Fake;
}

function mk(opts) {
  const o = opts || {};
  const counter = { rounds: 0 };
  const logs = [];
  const cfg = Object.assign(defaultConfig(), {
    email: 'bot@e.com', authCode: 'x'.repeat(16), allowFrom: ['a@b.com'],
    imap: {}, smtp: {}, pollSeconds: o.pollSeconds !== undefined ? o.pollSeconds : 5,
    taskTimeoutSeconds: 20
  }, o.cfg || {});
  const store = createSessionStore(path.join(os.tmpdir(), 'dshmb-loop-' + Date.now() + '.json'));
  const runner = createTaskRunner({ log: (m) => logs.push(m), sessionStore: store, saveSessionId: () => {} });
  const daemon = createDaemon({
    cfg, log: (m) => logs.push(m),
    ImapFlow: fakeImap(counter, o.perRound || 0),
    simpleParser: async () => ({ text: '你好', html: '', headers: { get: () => undefined } }),
    nodemailer: {}, runner, saveSessionId: () => {}, permissionFiles: [],
    sleep: o.sleep
  });
  return { daemon, cfg, logs, counter };
}

(async () => {
  console.log('\n================ A. 循环真的在跑，且能干净停下 ================');
  {
    const sleepCalls = [];
    const b = mk({
      perRound: 1,
      // 注入的 sleep：记录间隔，并在第三轮请求停止
      sleep: async (ms) => {
        sleepCalls.push(ms);
        if (sleepCalls.length >= 3) b.daemon.stop();
      }
    });
    const t = { async sendMail() { return {}; } };
    await b.daemon.start({ bin: findDshBin({}), root: path.join(__dirname, '..'), transport: t });

    eq('至少跑了一轮', b.counter.rounds >= 1, true);
    eq('★ 真的按间隔循环了多轮', b.counter.rounds >= 3, true);
    ok('每轮之间都 sleep 了', sleepCalls.length >= 2, sleepCalls.length);
    eq('★ sleep 的间隔 = pollSeconds×1000', sleepCalls[0], 5000);
    ok('结束时记了"已退出"', b.logs.some(l => l.includes('已退出')), b.logs.slice(-3));
  }

  console.log('\n================ B. 间隔畸形值不能让循环空转 ================');
  {
    // pollSeconds 是 undefined / 0 / NaN 时，Math.max(5, …) 会得到 NaN，
    // 而 setTimeout(fn, NaN) 按 0 延迟处理 → 疯狂连 IMAP。
    for (const [label, val] of [['undefined', undefined], ['0', 0], ['NaN', NaN], ['负数', -5]]) {
      const sleeps = [];
      const b = mk({
        cfg: { pollSeconds: val },
        perRound: 0,
        sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= 2) b.daemon.stop(); }
      });
      const t = { async sendMail() { return {}; } };
      await b.daemon.start({ bin: '', root: '.', transport: t });
      ok('pollSeconds=' + label + ' → 间隔是有效正数（不空转）',
         sleeps.length > 0 && Number.isFinite(sleeps[0]) && sleeps[0] >= 5000, sleeps[0]);
    }
  }

  console.log('\n================ C. stop() 之后不再跑新轮 ================');
  {
    const b = mk({ perRound: 0, sleep: async () => { b.daemon.stop(); } });
    const t = { async sendMail() { return {}; } };
    await b.daemon.start({ bin: '', root: '.', transport: t });
    const roundsAtStop = b.counter.rounds;
    await new Promise(r => setTimeout(r, 200));
    eq('stop() 之后没有新轮次', b.counter.rounds, roundsAtStop);
  }

  console.log('\n================ D. 启动自检：权限变了要换会话 ================');
  {
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmb-perm-'));
    const pf = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(pf, 'defaultPreset: read-only\n', 'utf8');

    const sleeps = [];
    const b = mk({
      perRound: 0,
      sleep: async (ms) => { sleeps.push(ms); b.daemon.stop(); }
    });
    b.cfg.sessionId = 'session-old';
    const store = createSessionStore(path.join(dir, 'state.json'));
    const saved = [];
    const runner = createTaskRunner({
      log: (m) => b.logs.push(m), sessionStore: store, saveSessionId: (id) => saved.push(id)
    });
    const daemon = createDaemon({
      cfg: b.cfg, log: (m) => b.logs.push(m),
      ImapFlow: fakeImap(b.counter, 0),
      simpleParser: async () => ({}), nodemailer: {},
      runner, saveSessionId: (id) => saved.push(id),
      permissionFiles: [pf], sleep: async (ms) => { sleeps.push(ms); daemon.stop(); }
    });

    // 第一次启动：只记录指纹，不该动会话
    await daemon.start({ bin: '', root: dir, transport: { async sendMail() {} } });
    eq('首次启动不轮换', saved.length, 0);

    // 改配置后再启动：应当轮换
    await new Promise(r => setTimeout(r, 1100));
    fs.writeFileSync(pf, 'defaultPreset: danger-full-access\n', 'utf8');
    const sleeps2 = [];
    const daemon2 = createDaemon({
      cfg: b.cfg, log: (m) => b.logs.push(m),
      ImapFlow: fakeImap(b.counter, 0),
      simpleParser: async () => ({}), nodemailer: {},
      runner, saveSessionId: (id) => saved.push(id),
      permissionFiles: [pf], sleep: async (ms) => { sleeps2.push(ms); daemon2.stop(); }
    });
    await daemon2.start({ bin: '', root: dir, transport: { async sendMail() {} } });
    eq('★ 配置变了 → 清空了会话 ID', saved[saved.length - 1], '');
    ok('日志说明了原因', b.logs.some(l => l.includes('权限配置')), b.logs.filter(l => l.includes('权限')));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  process.exit(summary('main loop'));
})().catch(e => {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
