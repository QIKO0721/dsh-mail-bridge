'use strict';

/**
 * dsh.js 的测试：事件流解析、权限指纹、调用真 DLL 的替身。
 *
 * 这里跑的是 tests/helpers/mock-dsh.js —— 一个假装成 DSH 的进程。
 * 所以测试完全不需要真的安装 DSH。
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const dsh = require('../src/dsh');
const MOCK = path.join(__dirname, 'helpers', 'mock-dsh.js');

console.log('\n--- 权限拒绝识别（宁可漏判，不可误判）---');

// 真实抓到的原文
const REAL = `{"type":"tool_result","callId":"c1","status":"completed","result":"失败：Access to the path 'C:\\\\Users\\\\someone\\\\probe.txt' is denied. (0x80070005 = ERROR_ACCESS_DENIED)"}`;
eq('真实原文认得出来', dsh.looksLikePermissionDenied(REAL), true);
eq('单独的错误码', dsh.looksLikePermissionDenied('Exception: (0x80070005 = ERROR_ACCESS_DENIED)'), true);
eq('英文措辞', dsh.looksLikePermissionDenied("Access to the path '/tmp/x' is denied."), true);
eq('中文措辞 + 错误码', dsh.looksLikePermissionDenied('拒绝访问。错误 0x80070005'), true);
eq('EACCES', dsh.looksLikePermissionDenied('Error: EACCES: permission denied, open /etc/shadow'), true);

// 不该误判的
eq('普通输出', dsh.looksLikePermissionDenied('D 盘还有 78GB'), false);
eq('空串', dsh.looksLikePermissionDenied(''), false);
eq('null', dsh.looksLikePermissionDenied(null), false);
eq('刚好含 denied 这个词但没错误码',
   dsh.looksLikePermissionDenied('这份文档讲了 access denied 的概念，是别的系统的'), false);
eq('普通的失败', dsh.looksLikePermissionDenied('失败：文件不存在'), false);
eq('HTTP 403', dsh.looksLikePermissionDenied('请求被拒绝：403 Forbidden'), false);
eq('只是提到了权限这个词', dsh.looksLikePermissionDenied('当前权限预设是 workspace-write'), false);

console.log('\n--- 会话不存在识别 ---');
eq('unknown id', dsh.looksLikeUnknownSession('error: unknown id: session-x'), true);
eq('no such session', dsh.looksLikeUnknownSession('no such session'), true);
eq('session not found', dsh.looksLikeUnknownSession('Session abc not found'), true);
eq('正常错误不误判', dsh.looksLikeUnknownSession('connection reset'), false);

console.log('\n--- parseJsonl ---');

const jsonl = [
  JSON.stringify({ type: 'session', sessionId: 'session-1', cwd: '/x' }),
  JSON.stringify({ type: 'status', phase: 'turn_start' }),
  JSON.stringify({ type: 'text', text: '中间文本' }),
  JSON.stringify({ type: 'final', text: '最终答复' })
].join('\n');

const parsed = dsh.parseJsonl(jsonl);
eq('拿到 sessionId', parsed.sessionId, 'session-1');
eq('优先取 final', parsed.text, '最终答复');
eq('没有权限拒绝', parsed.permissionDenied, false);

const noFinal = dsh.parseJsonl([
  JSON.stringify({ type: 'session', sessionId: 's' }),
  JSON.stringify({ type: 'text', text: '只有增量文本' })
].join('\n'));
eq('没有 final 时退回最后的 text', noFinal.text, '只有增量文本');

const denyStream = dsh.parseJsonl([
  JSON.stringify({ type: 'session', sessionId: 's' }),
  JSON.stringify({ type: 'tool_result', result: 'ERROR_ACCESS_DENIED' }),
  JSON.stringify({ type: 'final', text: '失败' })
].join('\n'));
eq('从 tool_result 里抓到权限拒绝', denyStream.permissionDenied, true);

// 关键：模型自己说"权限不足"不算数（那是措辞，不是事实）
const talkOnly = dsh.parseJsonl([
  JSON.stringify({ type: 'session', sessionId: 's' }),
  JSON.stringify({ type: 'text', text: '看起来权限不足，我换个办法' }),
  JSON.stringify({ type: 'final', text: '搞定了' })
].join('\n'));
eq('模型只是嘴上说权限不足 → 不算权限拒绝', talkOnly.permissionDenied, false);

console.log('\n--- 坏行不能把解析搞崩 ---');
const messy = dsh.parseJsonl('不是 json\n{"type":"final","text":"好"}\n{坏的\n\n');
eq('跳过坏行仍能拿到结果', messy.text, '好');

console.log('\n--- 权限指纹 ---');
const dir = tmpDir('dshmb-fp-');
try {
  const f1 = path.join(dir, 'cordis.patch.yml');
  const f2 = path.join(dir, 'cordis.yml');
  fs.writeFileSync(f1, 'defaultPreset: workspace-write\n', 'utf8');
  fs.writeFileSync(f2, '[]\n', 'utf8');

  const a = dsh.permissionFingerprint([f1, f2]);
  ok('指纹是 16 位十六进制', /^[0-9a-f]{16}$/.test(a), a);
  eq('同样输入指纹稳定', dsh.permissionFingerprint([f1, f2]), a);

  // 改内容
  const t0 = Date.now();
  while (Date.now() - t0 < 1100) { /* 等 mtime 精度过去 */ }
  fs.writeFileSync(f1, 'defaultPreset: danger-full-access\n', 'utf8');
  const b = dsh.permissionFingerprint([f1, f2]);
  ok('改了内容指纹就变', a !== b, { a, b });

  // 文件不存在也要能算（不抛）
  const c = dsh.permissionFingerprint([path.join(dir, '不存在.yml')]);
  ok('文件不存在也能算出指纹', /^[0-9a-f]{16}$/.test(c), c);

  eq('空文件列表也能算', typeof dsh.permissionFingerprint([]), 'string');
} finally {
  rmrf(dir);
}

console.log('\n--- 会话状态存储 ---');
const dir2 = tmpDir('dshmb-store-');
try {
  const file = path.join(dir2, 'state.json');
  const store = dsh.createSessionStore(file);

  const first = store.checkPermissionFingerprint('hash-1');
  eq('首次运行不轮换', first.rotate, false);
  eq('首次运行被标记', first.firstRun, true);

  const same = store.checkPermissionFingerprint('hash-1');
  eq('指纹没变不轮换', same.rotate, false);
  eq('第二次不算首次', same.firstRun, false);

  const changed = store.checkPermissionFingerprint('hash-2');
  eq('指纹变了要轮换', changed.rotate, true);
  eq('轮换报告里带旧指纹', changed.from, 'hash-1');
  eq('轮换报告里带新指纹', changed.to, 'hash-2');

  store.set({ sessionId: 'session-x' });
  eq('能存别的字段', store.get().sessionId, 'session-x');
  eq('存别的字段不会丢指纹', store.get().permissionHash, 'hash-2');

  // 坏文件不能崩
  fs.writeFileSync(file, '{坏', 'utf8');
  const bad = store.get();
  eq('状态文件坏了就当空的', typeof bad, 'object');
} finally {
  rmrf(dir2);
}

console.log('\n--- 真调一次假 DSH（走 stdin）---');

(async () => {
  // 正常
  const r1 = await dsh.runDshOnce({ bin: MOCK, task: '你好', timeoutMs: 15000 });
  eq('正常调用 ok', r1.ok, true);
  ok('回显里带上了任务文本', r1.text.includes('你好'), r1.text);
  ok('拿到了 sessionId', /^session-mock-/.test(r1.sessionId || ''), r1.sessionId);
  eq('没有权限拒绝', r1.permissionDenied, false);

  // 接续会话
  const r2 = await dsh.runDshOnce({ bin: MOCK, task: '接着聊', sessionId: 'session-given-123', timeoutMs: 15000 });
  ok('使用了指定的 sessionId', r2.text.includes('session-given-123'), r2.text);

  // ★ 长任务：走 stdin，不受命令行长度限制
  const longTask = 'A'.repeat(100000);
  const r3 = await dsh.runDshOnce({ bin: MOCK, task: longTask, timeoutMs: 20000 });
  eq('10 万字的任务也能正常执行（走 stdin 的好处）', r3.ok, true);
  ok('长任务内容完整送达', r3.text.includes('A'.repeat(1000)), '回显里能找到连续 A');

  // 权限拒绝
  const r4 = await dsh.runDshOnce({ bin: MOCK, task: '__DENY__', timeoutMs: 15000 });
  eq('权限拒绝被识别', r4.permissionDenied, true);
  eq('权限拒绝时仍算跑完（有答复）', r4.ok, true);

  // 会话不存在
  const r5 = await dsh.runDshOnce({ bin: MOCK, task: '__UNKNOWN_SESSION__', sessionId: 'session-x', timeoutMs: 15000 });
  eq('退出码非零 → ok=false', r5.ok, false);
  eq('识别出会话不存在', r5.unknownSession, true);

  // 没有输出
  const r6 = await dsh.runDshOnce({ bin: MOCK, task: '__NO_OUTPUT__', timeoutMs: 15000 });
  eq('没有任何输出 → ok=false', r6.ok, false);
  ok('错误信息说明了退出码', r6.text.includes('退出码'), r6.text);

  // 超时
  const r7 = await dsh.runDshOnce({ bin: MOCK, task: '__HANG__', timeoutMs: 1200 });
  eq('超时 → ok=false', r7.ok, false);
  eq('标记了超时', r7.timedOut, true);
  ok('超时提示写清了秒数', r7.text.includes('超时'), r7.text);

  // 命令不存在
  const r8 = await dsh.runDshOnce({ bin: path.join(__dirname, 'helpers', '不存在的文件.js'), task: 'x', timeoutMs: 10000 });
  eq('入口不存在 → ok=false', r8.ok, false);
  eq('入口不存在时立刻返回（不傻等超时）', r8.timedOut, false);
  eq('标记了 binMissing', r8.binMissing, true);
  ok('给了排查提示', r8.text.includes('dshBin') || r8.text.includes('入口'), r8.text);

  console.log('\n--- 自动查找 DSH ---');
  eq('显式指定优先', dsh.findDshBin({ dshBin: MOCK }), MOCK);
  eq('指定了不存在的路径则继续找（这里应找不到）',
     dsh.findDshBin({ dshBin: path.join(__dirname, '没有这个.js') }) === path.join(__dirname, '没有这个.js'),
     false);

  console.log('\n--- ★ PATH 查找（npm i -g 之后 dsh 就在 PATH 上）---');
  {
    // 当前进程的 node 一定在 PATH 里（否则测试都跑不起来）
    const found = dsh.findOnPath('node');
    ok('能在 PATH 里找到 node', !!found, found);
    eq('找不到的命令返回空串', dsh.findOnPath('definitely-not-a-real-command-xyz'), '');

    // 造一个假 PATH。注意必须把常见安装位置也隔离掉 ——
    // 否则开发机上真装着 DSH 时，findDshBin 会先命中真货，永远走不到这里。
    const fakeDir = tmpDir('dshmb-path-');
    const fakeName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const fakeFile = path.join(fakeDir, fakeName);
    fs.writeFileSync(fakeFile, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(fakeFile, 0o755);

    const emptyHome = tmpDir('dshmb-emptyhome-');
    const saved = {
      PATH: process.env.PATH, DSH_BIN: process.env.DSH_BIN,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME
    };
    delete process.env.DSH_BIN;
    process.env.LOCALAPPDATA = emptyHome;
    process.env.USERPROFILE = emptyHome;
    process.env.HOME = emptyHome;
    process.env.PATH = fakeDir;

    const viaPath = dsh.findDshBin({ dshBin: '' });
    // 假目录里没有真的 node_modules，所以解析不出 bin.js，
    // 应当原样返回那个包装脚本 —— 这正是"退而求其次"的那条路
    eq('找不到真 bin.js 时，回退到 PATH 上的包装脚本', viaPath, fakeFile);

    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmrf(fakeDir);
    rmrf(emptyHome);
  }

  console.log('\n--- 优先返回真正的 bin.js（不经 shell，避免 DEP0190）---');
  {
    // 在这台机器上（装了 DSH 的话），findDshBin 应当返回 .js 而不是 .cmd
    const real = dsh.findDshBin({});
    if (real) {
      ok('返回的是可用的路径', fs.existsSync(real), real);
      console.log('        实际返回: ' + real);
      if (process.platform === 'win32') {
        const isJs = /\.js$/i.test(real);
        const isShim = /\.(cmd|bat)$/i.test(real);
        ok('优先选中 .js（而不是 .cmd 包装脚本）', isJs || !isShim,
           isJs ? undefined : '返回了包装脚本：' + real);
      }
    } else {
      console.log('        （这台机器没装 DSH，跳过这条）');
    }
  }

  console.log('\n--- 光秃秃一个命令名也能跑（shell 兜底，不抛异常）---');
  {
    const r9 = await dsh.runDshOnce({ bin: 'no-such-cmd-xyz-123', task: 'x', timeoutMs: 8000 });
    eq('找不到的命令 → ok=false，不崩', r9.ok, false);
  }

  process.exit(summary('dsh'));
})();
