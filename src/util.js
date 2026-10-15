'use strict';

/**
 * 小工具集合：文本归一化、统一换行、深合并。
 * 这里只放跟"业务"无关的纯函数，方便单测。
 */

const { messages } = require('./i18n');

// humanSeconds 的输出要给用户看，所以要跟着语言走
const { lang } = messages();

/**
 * 统一换行为 \n，并去掉行尾空白。
 * 邮件正文里 \r\n / \r / \n 三种都可能出现，不统一后面所有正则都会翻车。
 */
function normalizeNewlines(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** 去掉首尾空白，并把 3 个以上连续换行压成 2 个 */
function tidy(text) {
  return String(text == null ? '' : text)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 比较两个值是否"深度相等"。测试和配置比对用，够用即可。
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

/** 把可能带 BOM 的 JSON 文本解析成对象 */
function parseJsonLoose(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

/** 秒数格式化成人类可读 */
function humanSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  if (lang === 'zh') {
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return m + ' 分' + (rest ? rest + ' 秒' : '');
    const h = Math.floor(m / 60);
    return h + ' 时' + (m % 60) + ' 分';
  }
  // 英文用 "1m 35s" 这种紧凑写法
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return m + 'm' + (rest ? ' ' + rest + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

module.exports = { normalizeNewlines, tidy, deepEqual, parseJsonLoose, humanSeconds };
