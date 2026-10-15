'use strict';

/**
 * task.js 的测试：会话续接、失效降级、权限兜底、回信拼装。
 *
 * 这里把 runOnce 换成假的，所以能精确构造各种会话/权限场景，
 * 不用碰真的 DSH。
 */

const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const { createTaskRunner, buildReply } = require('../src/task');
const dsh = require('../src/dsh');

/** 造一个假的 runOnce：按队列依次返回预置结果，并记录每次调用参数 */
function fakeRunOnce(queue) {
  const calls = [];
  const fn = async (opts) => {
    calls.push({ sessionId: opts.sessionId, task: opts.task });
    const next = queue.shift();
    if (typeof next === 'function') return next(opts);
    return Object.assign({
      ok: true, text: '答复', sessionId: 'session-new',
      permissionDenied: false, unknownSession: false
    }, next || {});
  };
  fn.calls = calls;
  return fn;
}

function makeRunner(opts) {
  const o = opts || {};
  const saved = [];
  const logs = [];
  const dir = tmpDir('dshmb-task-');
  const store = dsh.createSessionStore(path.join(dir, 'state.json'));
  const runOnce = o.runOnce || fakeRunOnce([]);
  const runner = createTaskRunner({
    log: (m) => logs.push(m),
    runOnce,
    sessionStore: store,
    saveSessionId: (id) => saved.push(id)
  });
  return { runner, runOnce, saved, logs, store, dir };
}

function baseCfg(over) {
  return Object.assign({
    dshProfile: 'headless',
    taskTimeoutSeconds: 60,
    sessionId: ''
  }, over || {});
}

(async () => {
  console.log('\n--- 没有会话 ID：直接新开会话 ---');
  {
    const { runner, runOnce, saved } = makeRunner({
      runOnce: fakeRunOnce([{ sessionId: 'session-first' }])
    });
    const r = await runner.run({ task: '你好', cfg: baseCfg(), bin: 'x' });
    eq('成功', r.ok, true);
    eq('只调用了一次', runOnce.calls.length, 1);
    eq('第一次不带 sessionId', runOnce.calls[0].sessionId, undefined);
    eq('新会话 ID 被持久化', saved[0], 'session-first');
    eq('返回值里带上会话 ID', r.sessionId, 'session-first');
  }

  console.log('\n--- 有会话 ID：应当续接 ---');
  {
    const { runner, runOnce } = makeRunner({
      runOnce: fakeRunOnce([{ sessionId: 'session-abc' }])
    });
    await runner.run({ task: '接着聊', cfg: baseCfg({ sessionId: 'session-abc' }), bin: 'x' });
    eq('带上了原会话 ID', runOnce.calls[0].sessionId, 'session-abc');
    eq('只调用一次', runOnce.calls.length, 1);
  }

  console.log('\n--- 会话失效：自动降级重开 ---');
  {
    const { runner, runOnce, saved, logs } = makeRunner({
      runOnce: fakeRunOnce([
        { ok: false, unknownSession: true, sessionId: 'session-dead', text: 'unknown id' },
        { ok: true, text: '成功', sessionId: 'session-fresh' }
      ])
    });
    const r = await runner.run({ task: '干活', cfg: baseCfg({ sessionId: 'session-dead' }), bin: 'x' });
    eq('最终成功', r.ok, true);
    eq('调用了两次', runOnce.calls.length, 2);
    eq('第二次不带 sessionId', runOnce.calls[1].sessionId, undefined);
    eq('新会话被保存', saved[saved.length - 1], 'session-fresh');
    ok('日志里说明了降级', logs.some(l => l.includes('不可用')), logs);
  }

  console.log('\n--- ★ 权限兜底：被拒后自动换会话重跑一次 ---');
  {
    const { runner, runOnce, saved, logs } = makeRunner({
      runOnce: fakeRunOnce([
        { ok: true, text: '失败', sessionId: 'session-old', permissionDenied: true },
        { ok: true, text: '成功', sessionId: 'session-brand-new', permissionDenied: false }
      ])
    });
    const cfg = baseCfg({ sessionId: 'session-old' });
    const r = await runner.run({ task: '往工作区外写文件', cfg, bin: 'x' });

    eq('重跑后成功', r.ok, true);
    eq('最终答复来自新会话', r.text, '成功');
    eq('一共调用两次', runOnce.calls.length, 2);
    eq('第一次用旧会话', runOnce.calls[0].sessionId, 'session-old');
    eq('第二次不带 sessionId（新会话）', runOnce.calls[1].sessionId, undefined);
    eq('旧会话被清空过', saved[0], '');
    eq('新会话被保存', saved[saved.length - 1], 'session-brand-new');

    ok('返回了轮换信息', !!r.rotated, r.rotated);
    eq('轮换信息里有旧会话', r.rotated.from, 'session-old');
    eq('轮换信息里有新会话', r.rotated.to, 'session-brand-new');
    eq('新会话没再被拒', r.rotated.stillDenied, false);
    eq('当前 cfg.sessionId 已更新', cfg.sessionId, 'session-brand-new');
    ok('日志写清了原因', logs.some(l => l.includes('权限被拒')), logs);
  }

  console.log('\n--- 权限兜底：新会话仍被拒 → 只重试一次，不循环 ---');
  {
    const { runner, runOnce } = makeRunner({
      runOnce: fakeRunOnce([
        { ok: true, text: '失败', sessionId: 'session-old', permissionDenied: true },
        { ok: true, text: '还是失败', sessionId: 'session-new', permissionDenied: true }
      ])
    });
    const r = await runner.run({ task: 'x', cfg: baseCfg({ sessionId: 'session-old' }), bin: 'x' });
    eq('绝不循环：只调用两次', runOnce.calls.length, 2);
    eq('轮换信息标记仍然被拒', r.rotated.stillDenied, true);
    eq('如实返回失败结果', r.text, '还是失败');
  }

  console.log('\n--- 权限被拒但没有会话 ID：没什么可换的，不重跑 ---');
  {
    const { runner, runOnce } = makeRunner({
      runOnce: fakeRunOnce([{ ok: true, text: '失败', sessionId: 'session-new', permissionDenied: true }])
    });
    await runner.run({ task: 'x', cfg: baseCfg({ sessionId: '' }), bin: 'x' });
    eq('只调用一次', runOnce.calls.length, 1);
  }

  console.log('\n--- 没被拒就不该重跑 ---');
  {
    const { runner, runOnce } = makeRunner({
      runOnce: fakeRunOnce([{ ok: true, text: '正常', sessionId: 'session-abc', permissionDenied: false }])
    });
    const r = await runner.run({ task: 'x', cfg: baseCfg({ sessionId: 'session-abc' }), bin: 'x' });
    eq('只调用一次', runOnce.calls.length, 1);
    eq('没有轮换信息', r.rotated, null);
  }

  console.log('\n--- 启动自检：权限指纹变了要换会话 ---');
  {
    const dir = tmpDir('dshmb-rot-');
    const fs = require('fs');
    const f = path.join(dir, 'cordis.patch.yml');
    fs.writeFileSync(f, 'defaultPreset: workspace-write\n', 'utf8');

    const store = dsh.createSessionStore(path.join(dir, 'state.json'));
    const saved = [];
    const logs = [];
    const runner = createTaskRunner({
      log: (m) => logs.push(m),
      runOnce: fakeRunOnce([]),
      sessionStore: store,
      saveSessionId: (id) => saved.push(id)
    });

    // 首次：只记录，不轮换
    const r1 = runner.rotateSessionIfPermissionChanged({ sessionId: 'session-abc', permissionFiles: [f] });
    eq('首次不轮换', r1.rotated, false);
    eq('首次没动会话 ID', saved.length, 0);

    // 没变：还是不轮换
    const r2 = runner.rotateSessionIfPermissionChanged({ sessionId: 'session-abc', permissionFiles: [f] });
    eq('没变不轮换', r2.rotated, false);
    eq('仍没动会话 ID', saved.length, 0);

    // 改配置：必须轮换
    const t0 = Date.now();
    while (Date.now() - t0 < 1100) { /* 等 mtime */ }
    fs.writeFileSync(f, 'defaultPreset: danger-full-access\n', 'utf8');
    const r3 = runner.rotateSessionIfPermissionChanged({ sessionId: 'session-abc', permissionFiles: [f] });
    eq('配置变了要轮换', r3.rotated, true);
    eq('清空了会话 ID', saved[0], '');
    eq('报告里带上了旧会话', r3.droppedSession, 'session-abc');
    ok('日志说明了原因', logs.some(l => l.includes('权限配置')), logs);

    // 再跑一次不该反复轮换
    const r4 = runner.rotateSessionIfPermissionChanged({ sessionId: '', permissionFiles: [f] });
    eq('不会反复轮换', r4.rotated, false);

    // 没有权限文件时静默跳过
    const r5 = runner.rotateSessionIfPermissionChanged({ sessionId: '', permissionFiles: [] });
    eq('没有权限文件时不轮换', r5.rotated, false);
    eq('并说明原因', r5.reason, 'no-permission-files');
    rmrf(dir);
  }

  console.log('\n--- 回信拼装 ---');
  {
    const okResult = { ok: true, text: '这是答复', rotated: null };
    const body = buildReply(okResult, 12, { tag: '邮箱助手' });
    ok('带上了答复正文', body.includes('这是答复'), body);
    ok('带上了用时', body.includes('用时 12 秒'), body);
    ok('带上了署名', body.includes('邮箱助手'), body);
    ok('没有轮换时不该出现注意字样', !body.includes('【注意】'), body);

    const failResult = { ok: false, text: '第 1 号退出' };
    const failBody = buildReply(failResult, 5, {});
    ok('失败时有【出错了】标记', failBody.startsWith('【出错了】'), failBody);

    const rotated = buildReply({
      ok: true, text: '答复',
      rotated: { from: 'a', to: 'b', ok: true, stillDenied: false }
    }, 3, {});
    ok('换过会话时要提醒记忆已重置', rotated.includes('记忆已重置'), rotated);
    ok('提醒在最前面', rotated.startsWith('【注意】'), rotated.slice(0, 20));

    const stillDenied = buildReply({
      ok: true, text: '答复',
      rotated: { from: 'a', to: 'b', ok: true, stillDenied: true }
    }, 3, {});
    ok('新会话仍被拒时要指出是配置问题', stillDenied.includes('权限配置本身'), stillDenied);

    const longText = buildReply({ ok: true, text: 'x', rotated: null }, 1, {});
    ok('默认署名可自定义', buildReply({ ok: true, text: 'x' }, 1, { tag: '自定义' }).includes('自定义'));
    ok('空 tag 用默认值', longText.includes('邮箱助手'));
  }

  process.exit(summary('task'));
})();
