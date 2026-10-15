'use strict';

/**
 * config.js 的单元测试：默认值、缺项补齐、校验提示、邮箱打码。
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary, tmpDir, rmrf } = require('./helpers/_assert');

const cfgMod = require('../src/config');

console.log('\n--- 默认配置 ---');
const d = cfgMod.defaultConfig();
eq('默认保留占位邮箱', d.email, cfgMod.PLACEHOLDER_EMAIL);
eq('默认 IMAP 端口', d.imap.port, 993);
eq('默认 SMTP 端口', d.smtp.port, 465);
eq('默认轮询间隔', d.pollSeconds, 15);
eq('默认 sessionId 为空（每封独立）', d.sessionId, '');

console.log('\n--- 校验：占位配置应该报错 ---');
const problems = cfgMod.validateConfig(d);
ok('占位配置有问题', problems.length > 0, problems.length);
ok('报了 email', problems.some(p => p.field === 'email'));
ok('报了 authCode', problems.some(p => p.field === 'authCode'));
ok('报了 allowFrom', problems.some(p => p.field === 'allowFrom'));
ok('每条问题都带修复提示', problems.every(p => typeof p.fix === 'string' && p.fix.length > 0));

console.log('\n--- 校验：正常配置应该通过 ---');
const good = cfgMod.defaultConfig();
good.email = 'someone@example.org';
good.authCode = 'abcdefghijklmnop';
good.allowFrom = ['someone@example.org'];
eq('正常配置零问题', cfgMod.validateConfig(good).length, 0);

console.log('\n--- 校验：各种边界 ---');
const p1 = cfgMod.defaultConfig();
p1.email = 'someone@example.org'; p1.authCode = 'abcdefghijklmnop';
p1.allowFrom = ['someone@example.org']; p1.pollSeconds = 1;
ok('轮询间隔太小会被拦', cfgMod.validateConfig(p1).some(p => p.field === 'pollSeconds'));

const p2 = cfgMod.defaultConfig();
p2.email = 'someone@example.org'; p2.authCode = 'abcdefghijklmnop';
p2.allowFrom = ['someone@example.org']; p2.taskTimeoutSeconds = 1;
ok('任务超时太短会被拦', cfgMod.validateConfig(p2).some(p => p.field === 'taskTimeoutSeconds'));

const p3 = cfgMod.defaultConfig();
p3.email = 'someone@example.org'; p3.authCode = 'abcdefghijklmnop';
p3.allowFrom = ['someone@example.org']; p3.secret = 'ab';
ok('暗号太短会被拦', cfgMod.validateConfig(p3).some(p => p.field === 'secret'));

const p4 = cfgMod.defaultConfig();
p4.email = '这不是邮箱'; p4.authCode = 'abcdefghijklmnop'; p4.allowFrom = ['someone@example.org'];
ok('邮箱格式不对会被拦', cfgMod.validateConfig(p4).some(p => p.field === 'email'));

console.log('\n--- 读写文件 ---');
const dir = tmpDir('dshmb-cfg-');
try {
  const first = cfgMod.loadConfig(dir);
  ok('文件不存在时报 missing', first.missing === true);
  ok('missing 时也给一份默认配置', first.config.email === cfgMod.PLACEHOLDER_EMAIL);

  // 写一份只有部分字段的配置
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    email: 'a@b.com', authCode: 'x'.repeat(16), allowFrom: ['a@b.com']
  }, null, 2), 'utf8');

  const second = cfgMod.loadConfig(dir);
  ok('能读回来', !second.missing && !second.error);
  eq('读回来的 email', second.config.email, 'a@b.com');
  eq('缺的字段被默认值补上（端口）', second.config.imap.port, 993);
  eq('缺的字段被默认值补上（超时）', second.config.taskTimeoutSeconds, 600);

  // 坏 JSON
  fs.writeFileSync(path.join(dir, 'config.json'), '{ 这不是 json', 'utf8');
  const third = cfgMod.loadConfig(dir);
  ok('坏 JSON 会报错而不是崩掉', !!third.error);
  ok('坏 JSON 会给修复提示', !!third.hint && third.hint.includes('重新运行'));

  // BOM
  fs.writeFileSync(path.join(dir, 'config.json'),
    '\uFEFF' + JSON.stringify({ email: 'c@d.com', authCode: 'y'.repeat(16), allowFrom: ['c@d.com'] }), 'utf8');
  const fourth = cfgMod.loadConfig(dir);
  eq('带 BOM 的配置能正常读', fourth.config.email, 'c@d.com');
} finally {
  rmrf(dir);
}

console.log('\n--- 邮箱打码 ---');
eq('打码保留前两位和域名', cfgMod.maskEmail('alice@example.com'), 'al***@example.com');
eq('两个字的名字', cfgMod.maskEmail('ab@x.com'), 'ab*@x.com');
eq('空串', cfgMod.maskEmail(''), '');
ok('打码后看不到原始用户名', !cfgMod.maskEmail('alice@example.com').includes('ice@'));

process.exit(summary('config'));
