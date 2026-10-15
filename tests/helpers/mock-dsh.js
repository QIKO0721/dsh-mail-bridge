#!/usr/bin/env node
'use strict';

/**
 * 假 DSH —— 给测试用的替身。
 *
 * 它模仿 `dsh --profile headless --json` 的行为：
 *   · 从 stdin 读任务文本（真 DSH 也是从 stdin 读）
 *   · 往 stdout 吐 JSONL 事件流
 *   · 支持若干"特殊任务文本"来模拟各种故障场景
 *
 * 特殊任务文本（测试用，真实 DSH 不认识这些）：
 *   __DENY__              模拟操作系统级的权限拒绝
 *   __UNKNOWN_SESSION__   往 stderr 写"会话不存在"并以非零退出
 *   __HANG__              挂住不返回，用来测超时
 *   __NO_OUTPUT__         什么都不输出，正常退出
 *
 * 这样测试就能覆盖：正常、权限被拒、会话失效、超时、无输出 —— 全都不需要真 DSH。
 */

const SESSION_PREFIX = 'session-mock-';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let task = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { task += d; });
process.stdin.on('end', () => {
  const t = task.trim();

  // 会话 id：如果命令行带了 --session-id 就沿用，否则造一个新的
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--session-id');
  const given = idx >= 0 ? argv[idx + 1] : null;
  const sessionId = given || (SESSION_PREFIX + 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  emit({ type: 'session', sessionId, cwd: process.cwd() });

  if (t === '__HANG__') {
    // 什么都不做，等被 kill
    setInterval(() => {}, 1000);
    return;
  }

  if (t === '__UNKNOWN_SESSION__') {
    // 措辞刻意跟真 DSH 的错误格式对齐（"unknown id"），
    // 这样才测得到检测逻辑本身，而不是测到一个自己编的措辞
    process.stderr.write('error: unknown id: ' + sessionId + '\n');
    process.exit(1);
    return;
  }

  if (t === '__NO_OUTPUT__') {
    process.exit(0);
    return;
  }

  emit({ type: 'status', phase: 'turn_start', turn: 1 });
  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
  emit({ type: 'thinking', text: '（假 DSH 在想事情）' });

  if (t === '__DENY__') {
    emit({
      type: 'tool_call',
      callId: 'call_mock_1',
      tool: 'pwsh',
      input: { command: 'Set-Content -Path C:\\outside\\probe.txt -Value hi' }
    });
    emit({
      type: 'tool_result',
      callId: 'call_mock_1',
      status: 'completed',
      result: "Access to the path 'C:\\outside\\probe.txt' is denied. " +
              '(0x80070005 = ERROR_ACCESS_DENIED)'
    });
    emit({ type: 'text', text: '失败' });
    emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
    emit({ type: 'final', text: '失败' });
    process.exit(0);
    return;
  }

  // 正常：把收到的任务回显出来，方便断言"任务到底传进去没有"
  const reply = '收到任务：' + t + '（会话 ' + sessionId + '）';
  emit({ type: 'text', text: reply });
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
  emit({ type: 'final', text: reply });
  process.exit(0);
});
