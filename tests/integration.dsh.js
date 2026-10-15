'use strict';

/**
 * 对着【真实 DSH】跑的集成测试。
 *
 * 为什么需要它：其它测试全部用替身（mock-dsh、假 IMAP、假 SMTP），
 * 替身能验逻辑，但验不出"我们对真实接口的假设是不是错的"。
 * 真实踩过的例子：
 *   · 以为 DSH 报的是 "unknown id"，实际它说的是 "does not exist" —— 匹配不上
 *   · 以为不传位置参数就等于读 stdin（这条侥幸是对的，但当时并不知道）
 *
 * 默认**自动跳过**：机器上没有 DSH 时不报失败，只是提示跳过。
 * 想强制跑（没有 DSH 就算失败）：
 *     DSH_INTEGRATION=require node tests/integration.dsh.js
 *
 * 这个文件不叫 *.test.js，所以不会进 npm test 的自动轮转 ——
 * 它要连真实的 DSH、花真实的额度，不该每次提交都跑。
 */

const path = require('path');
const { ok, eq, summary } = require('./helpers/_assert');
const dsh = require('../src/dsh');
const { createTaskRunner } = require('../src/task');
const { defaultConfig } = require('../src/config');

const FORCE = process.env.DSH_INTEGRATION === 'require';
const found = dsh.findDshBin({});
const bin = process.env.DSH_TEST_BIN || found;

if (!bin) {
  console.log('');
  console.log('='.repeat(52));
  if (FORCE) {
    console.log('  ✗ 要求跑真实 DSH 集成测试，但没找到 DSH');
    console.log('    装一个：npm install -g @deepseek-ai/dsh');
    console.log('    或指定：DSH_TEST_BIN=<lib/bin.js 的路径>');
    process.exit(1);
  }
  console.log('  跳过：这台机器上没有 DSH（属正常，集成测试非必跑）');
  console.log('  想跑：npm install -g @deepseek-ai/dsh');
  console.log('='.repeat(52));
  process.exit(0);
}

console.log('');
console.log('='.repeat(52));
console.log('  真实 DSH 集成测试');
console.log('  DSH 入口: ' + bin);
console.log('='.repeat(52));

(async () => {
  console.log('\n--- 1) 从 stdin 喂任务，能不能拿到 final ---');
  {
    const r = await dsh.runDshOnce({
      bin, task: '只回答两个字：收到', timeoutMs: 180000
    });
    eq('ok', r.ok, true);
    ok('拿回了答复', /收到/.test(r.text), r.text.slice(0, 200));
    ok('拿到了 sessionId', /^session-/.test(r.sessionId || ''), r.sessionId);
    eq('不是权限拒绝', r.permissionDenied, false);
  }

  console.log('\n--- 2) 长任务走 stdin（命令行长度限制的根治手段）---');
  {
    // 3 万字，远超 Windows 命令行上限。能跑通就说明 stdin 这条路是真的。
    const filler = '这是一段用来占位的中文内容。'.repeat(2000);
    const task = '下面是一段很长的文字，你不需要理解它，' +
                 '只需要在回答里原样包含「长文本已收到」这几个字即可：\n\n' + filler;
    const r = await dsh.runDshOnce({ bin, task, timeoutMs: 300000 });
    eq('3 万字任务也能跑完', r.ok, true);
    ok('任务真的被读进去了（不是超时或报错）',
       /长文本已收到/.test(r.text), r.text.slice(0, 300));
  }

  console.log('\n--- 3) 会话续接：同一 ID 能不能接着聊 ---');
  {
    const first = await dsh.runDshOnce({
      bin, task: '请记住这个数字：7391。只回答「记住了」。', timeoutMs: 180000
    });
    eq('第一轮 ok', first.ok, true);
    const sid = first.sessionId;
    ok('拿到了会话 ID', !!sid, sid);

    if (sid) {
      const second = await dsh.runDshOnce({
        bin, task: '我刚才让你记的数字是多少？只回答那个数字。',
        sessionId: sid, timeoutMs: 180000
      });
      eq('续接 ok', second.ok, true);
      ok('★ 记得上文（证明会话真的续上了）', /7391/.test(second.text), second.text.slice(0, 200));
      eq('续接后会话 ID 不变', second.sessionId, sid);
    }
  }

  console.log('\n--- 4) ★ 不存在的会话 ID：必须被识别为"会话失效" ---');
  {
    // 这正是真实 DSH 报 "does not exist" 的场景，
    // 早期正则匹配不上，导致自动降级不触发。
    const bogus = 'definitely-not-a-real-session-' + Date.now();
    const r = await dsh.runDshOnce({
      bin, task: '随便说点什么', sessionId: bogus, timeoutMs: 120000
    });
    eq('不存在的会话 → ok=false', r.ok, false);
    eq('★ 被识别为会话不存在（自动降级的前提）', r.unknownSession, true);
    ok('错误信息里保留了 DSH 的原话',
       /does not exist|不存在/.test(r.text), r.text.slice(0, 300));

    // 走完整的 runner：应当自动降级、重开新会话、把任务跑完
    const sessions = [];
    const store = dsh.createSessionStore(path.join(require('os').tmpdir(),
      'dshmb-int-' + Date.now() + '.json'));
    const runner = createTaskRunner({
      log: () => {},
      sessionStore: store,
      saveSessionId: (id) => sessions.push(id)
    });
    const cfg = Object.assign(defaultConfig(), {
      email: 'x@example.com', authCode: 'x'.repeat(16), allowFrom: ['x@example.com'],
      dshProfile: 'headless', sessionId: bogus, taskTimeoutSeconds: 300
    });

    const r2 = await runner.run({ task: '只回答两个字：好了', cfg, bin });
    eq('★ 坏会话 ID 能被自动降级救回来', r2.ok, true);
    ok('拿回了答复', /好了/.test(r2.text), r2.text.slice(0, 200));
    ok('并保存了新的会话 ID',
       sessions.some(s => /^session-/.test(s)), sessions);
  }

  console.log('\n--- 5) 事件流里的 permissionDenied 判定（不该误报）---');
  {
    const r = await dsh.runDshOnce({
      bin, task: '在回答里说一句「我没有权限删这个文件，但这是举例」。只回答这句话。',
      timeoutMs: 180000
    });
    eq('正常任务 ok', r.ok, true);
    eq('★ 模型嘴上说"没有权限"不算权限拒绝', r.permissionDenied, false);
  }

  process.exit(summary('integration (real DSH)'));
})().catch(e => {
  console.error('集成测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
