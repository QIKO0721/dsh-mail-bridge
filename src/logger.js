'use strict';

/**
 * 日志：同时写控制台和文件，文件超限自动轮转。
 *
 * 为什么要轮转：这个程序是长期常驻的，日志只增不减的话，
 * 跑几个月就能把硬盘吃出几个 G。默认超过 2MB 只留尾部 500KB。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // 超过这个大小就轮转
const KEEP_BYTES = 500 * 1024;       // 轮转后保留尾部多少字节

/**
 * @param {object} opts
 * @param {string} opts.file      日志文件路径
 * @param {boolean} [opts.silent] 不在控制台输出（测试用）
 * @param {Function} [opts.now]   注入时钟，方便测试
 */
function createLogger(opts) {
  const file = opts.file;
  const silent = !!opts.silent;
  const now = opts.now || (() => new Date());

  function stamp() {
    const d = now();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function rotate() {
    try {
      const st = fs.statSync(file);
      if (st.size <= MAX_BYTES) return;
      const tail = fs.readFileSync(file, 'utf8').slice(-KEEP_BYTES);
      fs.writeFileSync(file, tail, 'utf8');
    } catch (e) { /* 文件不存在或读不到，无所谓 */ }
  }

  function log(msg) {
    const line = '[' + stamp() + '] ' + msg;
    if (!silent) console.log(line);
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
      rotate();
    } catch (e) { /* 日志写不进去也不能让主流程挂掉 */ }
  }

  return { log, file };
}

module.exports = { createLogger, MAX_BYTES, KEEP_BYTES };
