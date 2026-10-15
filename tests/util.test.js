'use strict';

/**
 * util.js 与 logger.js 的单元测试。
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const util = require('../src/util');
const { createLogger } = require('../src/logger');

console.log('\n--- util：文本归一化 ---');

eq('三种换行统一成 \\n', util.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
eq('null 变空串', util.normalizeNewlines(null), '');
eq('undefined 变空串', util.normalizeNewlines(undefined), '');

eq('去掉行尾空白', util.tidy('a   \nb\t\n'), 'a\nb');
eq('3 个以上连续换行压成 2 个', util.tidy('a\n\n\n\n\nb'), 'a\n\nb');
eq('首尾空白清掉', util.tidy('  \n abc \n  '), 'abc');
eq('空串还是空串', util.tidy('   '), '');

console.log('\n--- util：其它 ---');

eq('deepEqual 相同对象', util.deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), true);
eq('deepEqual 不同对象', util.deepEqual({ a: 1 }, { a: 2 }), false);
eq('deepEqual null 与 null', util.deepEqual(null, null), true);
eq('deepEqual null 与对象', util.deepEqual(null, {}), false);

eq('parseJsonLoose 能吃掉 BOM', util.parseJsonLoose('\uFEFF{"a":1}').a, 1);

eq('humanSeconds 秒', util.humanSeconds(45), '45 秒');
eq('humanSeconds 分', util.humanSeconds(95), '1 分35 秒');
eq('humanSeconds 整分', util.humanSeconds(120), '2 分');
eq('humanSeconds 时', util.humanSeconds(3700), '1 时1 分');

console.log('\n--- logger：写文件与轮转 ---');

const dir = tmpDir('dshmb-log-');
try {
  const file = path.join(dir, 'test.log');
  const log = createLogger({ file, silent: true });

  log.log('第一行');
  log.log('第二行');
  const content = fs.readFileSync(file, 'utf8');
  ok('日志写进了文件', content.includes('第一行') && content.includes('第二行'));

  const lines = content.trim().split('\n');
  eq('两行日志', lines.length, 2);
  ok('每行都带 [时间] 前缀', /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] /.test(lines[0]), lines[0]);

  // 轮转：写超过上限的内容
  const big = 'x'.repeat(1200);
  for (let i = 0; i < 2000; i++) log.log(big);
  const sizeAfter = fs.statSync(file).size;
  ok('超过上限后文件被轮转（没无限增长）', sizeAfter <= 2 * 1024 * 1024, sizeAfter);

  // 日志写不进去时不能抛
  const badLog = createLogger({ file: path.join(dir, 'no-such-dir', 'x.log'), silent: true });
  let threw = false;
  try { badLog.log('这条写不进去'); } catch (e) { threw = true; }
  ok('日志路径不可写时不抛异常', !threw);

  // 注入时钟
  const fixed = createLogger({
    file: path.join(dir, 'fixed.log'), silent: true,
    now: () => new Date(2026, 0, 2, 3, 4, 5)
  });
  fixed.log('时间可控');
  ok('注入时钟生效', fs.readFileSync(path.join(dir, 'fixed.log'), 'utf8').includes('[2026/01/02 03:04:05]'));
} finally {
  rmrf(dir);
}

process.exit(summary('util / logger'));
