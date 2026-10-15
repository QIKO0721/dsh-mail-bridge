'use strict';

/**
 * 测试共用的小工具：断言、临时目录、路径基准。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 断言 ----------
let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log('  OK   ' + label);
  } else {
    failed++;
    failures.push(label);
    console.log(' FAIL  ' + label + (detail !== undefined ? '\n        实际: ' + JSON.stringify(detail) : ''));
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected,
     actual === expected ? undefined : { 期望: expected, 实际: actual });
}

function summary(title) {
  console.log('');
  console.log('='.repeat(52));
  console.log((title ? title + ' · ' : '') + '合计：通过 ' + passed + '，失败 ' + failed);
  console.log('='.repeat(52));
  return failed ? 1 : 0;
}

// ---------- 临时目录 ----------

/**
 * 所有通过本函数创建的临时目录都会被登记下来，进程退出时统一回收。
 *
 * 为什么要在 helper 层兜底：早先各测试文件自己清，结果 task.test.js 忘了清，
 * 每跑一次就在系统 TEMP 里积 7 个目录 —— 攒到 196 个才发现。
 * 让"创建临时目录"和"回收临时目录"由同一个地方负责，新写的测试就不会再漏。
 *
 * ⚠️ 第一版兜底只认自己默认的 'dshmb-' 前缀，于是带着自定义前缀
 *    （empty-home- / nope- …）建的目录照样漏 —— 兜底留了后门。
 *    现在改成"不管什么前缀，只要从这个函数出去的，一律登记、一律回收"。
 */
const tmpDirs = [];

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'dshmb-')));
  tmpDirs.push(d);
  return d;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const i = tmpDirs.indexOf(p);
  if (i >= 0) tmpDirs.splice(i, 1);
}

/** 立刻回收所有还没删的临时目录（想早点清就手动调） */
function cleanupTmp() {
  while (tmpDirs.length) rmrf(tmpDirs[tmpDirs.length - 1]);
}

// 进程退出时兜底回收。'exit' 里只能做同步操作，正好 rmSync 是同步的。
process.on('exit', cleanupTmp);
// 测试通过 process.exit() 结束时，'exit' 也会触发；异常退出也一样。

module.exports = {
  ROOT, ok, eq, summary, tmpDir, rmrf, cleanupTmp,
  get passed() { return passed; },
  get failed() { return failed; }
};
