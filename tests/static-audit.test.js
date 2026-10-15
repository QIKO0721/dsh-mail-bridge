'use strict';

/**
 * 静态自检：不跑业务逻辑，只扫代码本身。
 *
 * 这一层查的是"单元测试查不到、但上线会出事"的东西：
 *   · 相对 require 写错路径（运行时才炸 MODULE_NOT_FOUND）
 *   · 模块导出了 undefined（调用方拿到手才炸 "is not a function"）
 *   · 调试残留（debugger / TODO）
 *   · 把授权码传给日志函数（最典型的凭据泄漏方式）
 *
 * 用法：npm test 会自动带上；也可单跑 node tests/static-audit.test.js
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, summary } = require('./helpers/_assert');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// 本文件必然包含它要搜索的模式（debugger、TODO、authCode…），显式排除自己。
// 跟 scripts/privacy-scan.ps1 同一个做法。
const SELF = path.resolve(__filename);
const allFiles = walk(ROOT);
const files = allFiles.filter(f => path.resolve(f) !== SELF);

console.log('\n扫描 ' + files.length + ' 个 .js 文件（已排除本自检脚本）');

// ---------- 1) 相对 require 能否解析 ----------
console.log('\n--- 1) 相对 require 解析 ---');
{
  let n = 0;
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      n++;
      const target = path.resolve(path.dirname(f), m[1]);
      const cands = [target, target + '.js', path.join(target, 'index.js')];
      if (!cands.some(c => fs.existsSync(c))) {
        bad.push(path.relative(ROOT, f) + ' -> ' + m[1]);
      }
    }
  }
  ok('检查了 ' + n + ' 处相对 require', n > 20, n);
  eq('没有解析不了的路径', bad.length, 0);
  if (bad.length) bad.forEach(b => console.log('      ✗ ' + b));
}

// ---------- 2) 模块导出是否都有值 ----------
console.log('\n--- 2) 模块导出完整性 ---');
{
  const mods = ['util', 'logger', 'config', 'email', 'security', 'dsh', 'task', 'mail', 'daemon', 'app'];
  const undefAll = [];
  for (const name of mods) {
    const mod = require(path.join(ROOT, 'src', name));
    const keys = Object.keys(mod);
    const undef = keys.filter(k => mod[k] === undefined);
    ok('src/' + name + ' 导出了 ' + keys.length + ' 项且都非 undefined', keys.length > 0 && undef.length === 0,
       undef.length ? undef.join(',') : keys.length);
    undefAll.push(...undef);
  }
  eq('全部模块都没有 undefined 导出', undefAll.length, 0);
}

// ---------- 3) 调试残留 ----------
console.log('\n--- 3) 调试残留 / TODO ---');
{
  const patterns = [
    [/\bdebugger\b/, 'debugger 语句'],
    [/\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/, 'TODO/FIXME']
  ];
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel.startsWith('scripts' + path.sep)) continue;   // 脚本本来就输出给人看
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;             // 注释里提到不算
      for (const [re, label] of patterns) {
        if (re.test(line)) hits.push(rel + ':' + (i + 1) + ' [' + label + ']');
      }
    });
  }
  eq('没有 debugger / TODO 残留', hits.length, 0);
  if (hits.length) hits.forEach(h => console.log('      ⚠ ' + h));
}

// ---------- 4) 凭据绝不能被日志打印 ----------
console.log('\n--- 4) 授权码会不会被打进日志 ---');
{
  const leaks = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f);
    const lines = src.split('\n');

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;            // 注释不算
      // (a) 直接把 authCode 传给日志
      if (/(console\.log|log)\([^)]*\bauthCode\b/.test(line)) {
        leaks.push(rel + ':' + (i + 1) + ' 打印了 authCode');
      }
      // (b) 把整个配置对象序列化后打印（会带上 authCode）
      //     注意：只取某个字段（cfg.sessionId / cfg.email）是安全的，不算
      if (/(console\.log|log)\([^)]*JSON\.stringify\(\s*(cfg|config|raw|opts)\b/.test(line)) {
        leaks.push(rel + ':' + (i + 1) + ' 整体序列化打印了配置');
      }
    });
  }
  eq('没有任何地方把授权码或整个配置交给日志', leaks.length, 0);
  if (leaks.length) leaks.forEach(l => console.log('      ⚠ ' + l));
}

// ---------- 5) src 里不该出现裸 console.log ----------
console.log('\n--- 5) src 里的输出方式 ---');
{
  const bad = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (!rel.startsWith('src' + path.sep)) continue;
    // logger.js 就是日志器的实现，它当然要用 console.log —— 唯一豁免
    if (rel === path.join('src', 'logger.js')) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/console\.log\(/.test(line)) bad.push(rel + ':' + (i + 1));
    });
  }
  eq('src 里没有裸 console.log（logger.js 除外，那正是它的实现）', bad.length, 0);
  if (bad.length) bad.forEach(b => console.log('      ⚠ ' + b));
}

process.exit(summary('static audit'));
