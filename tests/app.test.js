'use strict';

/**
 * 接线与启动的集成测试。
 *
 * 为什么单独一个文件：单元测试都是把依赖一个个手工传进去的，
 * 所以"组装时传错了"这类 bug 它们一个都抓不到 ——
 * 真实踩过的例子：把 createLogger() 返回的 { log, file } 整个对象
 * 当成日志函数传下去，单元测试全绿，一 start 就 "log is not a function"。
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const { buildApp } = require('../src/app');
const { defaultConfig } = require('../src/config');
const { createLogger } = require('../src/logger');

const MOCK_DSH = path.join(__dirname, 'helpers', 'mock-dsh.js');

/** 假 IMAP：连得上、没有未读邮件 */
function fakeImap() {
  class FakeImapFlow {
    async connect() {}
    async getMailboxLock() { return { release() {} }; }
    async messageFlagsAdd() {}
    async logout() {}
    fetch() {
      return { async *[Symbol.asyncIterator]() { /* 没有未读 */ } };
    }
  }
  return FakeImapFlow;
}

function fakeNodemailer() {
  return {
    createTransport() {
      return { async sendMail() { return {}; } };
    }
  };
}

function makeConfig(over) {
  const c = defaultConfig();
  c.email = 'tester@example.com';
  c.authCode = 'x'.repeat(16);
  c.allowFrom = ['tester@example.com'];
  c.dshBin = MOCK_DSH;
  c.pollSeconds = 5;
  return Object.assign(c, over || {});
}

/** 在临时目录里准备一个根（含 config.json），并组装一套 app */
function setupApp(opts) {
  // 本块新产生的临时目录；块结束时由 teardown 回收
  const cleanupDirs = [];
  const o = opts || {};
  const dir = tmpDir('dshmb-app-');
  const cfg = o.config || makeConfig();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  const app = buildApp({
    root: dir,
    config: cfg,
    deps: { ImapFlow: fakeImap(), simpleParser: async () => ({}), nodemailer: fakeNodemailer() },
    loggerFactory: o.loggerFactory
  });
  return { dir, cfg, app };
}

// 临时目录用完就删。
// ⚠️ 早先写的是"全部 push 进数组、最后统一删一次"，结果每跑一次测试就在系统
//    TEMP 里积一堆目录 —— 攒到 196 个才发现。临时目录必须在【当块】回收。
const cleanups = [];
function done() {
  for (const d of cleanups) rmrf(d);
  cleanups.length = 0;
}

(async () => {
  console.log('\n--- buildApp：组装出来的东西必须都能用 ---');
  {
    const { dir, app } = setupApp();
    cleanups.push(dir);

    ok('返回了 daemon', !!app.daemon);
    ok('返回了 runner', !!app.runner);
    ok('返回了 transport', !!app.transport);

    // ★ 这条就是那个真实 bug 的回归测试
    eq('★ log 是函数（不是 logger 对象）', typeof app.log, 'function');
    ok('log() 调得动、不抛', (() => { try { app.log('测试一行'); return true; } catch (e) { return false; } })());
    ok('日志真的落到文件里了',
       fs.readFileSync(path.join(dir, 'mail-bridge.log'), 'utf8').includes('测试一行'));

    eq('找到了 DSH 入口', app.bin, MOCK_DSH);
    ok('权限文件列表是数组', Array.isArray(app.permissionFiles));
    eq('会话状态文件路径正确', app.store.file, path.join(dir, 'state.json'));
    done();
  }

  console.log('\n--- ★ daemon.start() 真实跑一遍（之前完全没测到的那条路）---');
  {
    const { dir, cfg, app } = setupApp();
    cleanups.push(dir);

    let threw = null;
    const p = app.daemon.start({ bin: app.bin, root: dir, transport: app.transport });
    // 给它跑一轮的时间，然后停下
    setTimeout(() => app.daemon.stop(), 400);
    try { await p; } catch (e) { threw = e; }

    ok('start() 没有抛异常（回归：log is not a function）', !threw,
       threw ? threw.message : undefined);

    const logText = fs.readFileSync(path.join(dir, 'mail-bridge.log'), 'utf8');
    ok('start() 记下了"开始轮询"', logText.includes('开始轮询'), logText.slice(0, 200));
    ok('start() 记下了"已退出"', logText.includes('已退出'), logText.slice(-200));
    ok('start() 做了权限指纹自检（生成了 state.json）',
       fs.existsSync(path.join(dir, 'state.json')), 'state.json 不存在');
    done();
  }

  console.log('\n--- saveSessionId 真的会写回 config.json ---');
  {
    const { dir, cfg, app } = setupApp();
    cleanups.push(dir);

    app.saveSessionId('session-written');
    cfg.sessionId = 'session-written';
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    eq('会话 ID 已写盘', written.sessionId, 'session-written');
    eq('其他字段没被弄丢', written.email, 'tester@example.com');
    eq('allowFrom 没被弄丢', written.allowFrom.length, 1);
    done();
  }

  console.log('\n--- saveSessionId 遇到坏 config.json 也不能崩 ---');
  {
    const { dir, cfg, app } = setupApp();
    cleanups.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{坏掉的', 'utf8');

    let threw = null;
    try { app.saveSessionId('session-x'); } catch (e) { threw = e; }
    ok('坏配置时不抛异常（只记日志）', !threw, threw ? threw.message : undefined);
    eq('内存里的值仍然更新了', cfg.sessionId, 'session-x');

    const logText = fs.readFileSync(path.join(dir, 'mail-bridge.log'), 'utf8');
    ok('日志里记了保存失败', logText.includes('保存会话 ID 失败'), logText);
    done();
  }

  console.log('\n--- 日志工厂可以被注入（测试友好）---');
  {
    const calls = [];
    const { dir } = setupApp({
      loggerFactory: (o) => {
        calls.push(o.file);
        return createLogger({ file: o.file, silent: true });
      }
    });
    cleanups.push(dir);

    eq('注入的日志工厂被调用了一次', calls.length, 1);
    eq('工厂收到了日志路径', path.basename(calls[0] || ''), 'mail-bridge.log');
    done();
  }

  console.log('\n--- 这台机器没装 DSH 时，bin 为空、交给调用方报错 ---');
  {
    // 把查找路径全部隔离到空目录，模拟"没装 DSH"。
    // （直接指望"找不到"是不行的 —— 开发机上往往真装着 DSH，
    //   而且 npm i -g 之后 dsh 就在 PATH 上，所以 PATH 也必须隔离）
    const saved = {
      DSH_BIN: process.env.DSH_BIN,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT
    };
    const emptyHome = tmpDir('empty-home-');
    const nowhere = path.join(emptyHome, '没有这个文件.js');
    process.env.DSH_BIN = nowhere;
    process.env.LOCALAPPDATA = emptyHome;
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    process.env.PATH = emptyHome;          // 空 PATH：找不到任何命令
    process.env.PATHEXT = '';              // 空 PATHEXT：不瞎拼扩展名

    const { dir, app } = setupApp({ config: makeConfig({ dshBin: nowhere }) });
    cleanups.push(dir);

    // 恢复环境
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }

    ok('bin 为空（不崩、不瞎猜）', app.bin === '', app.bin);
    done();
  }

  process.exit(summary('app (wiring)'));
})();
