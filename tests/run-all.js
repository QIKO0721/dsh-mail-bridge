#!/usr/bin/env node
'use strict';

/**
 * 一键跑全部测试。
 *
 * 用法：
 *   npm test                    跑所有 *.test.js
 *   node tests/run-all.js 权限   只跑文件名里带关键字的
 *   node tests/run-all.js --list 只列出来不跑
 *
 * 说明：
 *   · 每个测试跑在独立进程里 —— 一个崩了不影响别的，退出码照样收集
 *   · 有任何一个失败，本进程退出码就是 1（可以直接挂 CI）
 *   · 不需要真邮箱、不需要真 DSH —— 全部用 tests/helpers 里的替身
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const filter = args.find(a => !a.startsWith('-')) || '';

const files = fs.readdirSync(HERE)
  .filter(n => n.endsWith('.test.js'))
  .filter(n => !filter || n.includes(filter))
  .sort();

if (!files.length) {
  console.log('没有找到测试文件' + (filter ? '（过滤词：' + filter + '）' : ''));
  process.exit(1);
}

if (listOnly) {
  console.log('会跑这些测试：');
  for (const f of files) console.log('  ' + f);
  process.exit(0);
}

console.log('==============================================');
console.log('  dsh-mail-bridge · 测试套件');
console.log('  共 ' + files.length + ' 个测试文件' + (filter ? '（过滤：' + filter + '）' : ''));
console.log('==============================================');

const results = [];

for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    timeout: 120000
  });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');

  // 从输出里抠出「合计：通过 X，失败 Y」
  let pass = null, fail = null;
  const m = out.match(/合计[：:]\s*(?:通过\s*)?(\d+)\s*[，,]\s*失败\s*(\d+)/);
  if (m) { pass = Number(m[1]); fail = Number(m[2]); }

  const okRun = r.status === 0;
  results.push({ file: f, ok: okRun, code: r.status, pass, fail, ms, out });

  console.log('\n--- ' + f + ' ---');
  const tail = out.trim().split('\n').slice(-4).join('\n');
  console.log(tail || '(无输出)');
  console.log('  → ' + (okRun ? '通过' : '失败') + '  退出码=' + r.status +
              '  用时 ' + ms + 'ms' + (pass !== null ? '  断言 ' + pass + ' 通过 / ' + fail + ' 失败' : ''));
}

console.log('\n==============================================');
console.log('  汇总');
console.log('==============================================');

let bad = 0, totalPass = 0, totalFail = 0;
for (const r of results) {
  if (!r.ok) bad++;
  if (r.pass !== null) { totalPass += r.pass; totalFail += r.fail; }
  console.log('  ' + (r.ok ? '✓' : '✗') + ' ' + r.file.padEnd(22) +
              (r.pass !== null ? String(r.pass).padStart(4) + ' 项通过' : '          ') +
              (r.ok ? '' : '   ← 退出码 ' + r.code));
}
console.log('  ' + '-'.repeat(46));
console.log('  ' + results.length + ' 个测试文件，失败 ' + bad + ' 个；' +
            '断言合计 通过 ' + totalPass + ' / 失败 ' + totalFail);
console.log('');

process.exit(bad ? 1 : 0);
