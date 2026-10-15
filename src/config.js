'use strict';

/**
 * 配置：默认值、读写、校验。
 *
 * 设计原则：
 *   1. config.json 里只有**用户必须自己填**的东西，其余全部有合理默认值；
 *   2. 校验失败时给出的报错必须**告诉用户怎么修**，而不是只说"配置无效"；
 *   3. 全程不打印授权码（日志里出现密码是最常见的事故）。
 */

const fs = require('fs');
const path = require('path');
const { parseJsonLoose } = require('./util');

/** 判断配置里的邮箱是不是还是占位符 */
const PLACEHOLDER_EMAIL = 'you@example.com';
const PLACEHOLDER_CODE = 'PASTE-YOUR-16-CHAR-AUTH-CODE-HERE';

function defaultConfig() {
  return {
    _readme: [
      '这个文件含邮箱授权码，等同密码，绝对不要提交到 git 或发给别人。',
      '授权码不是邮箱登录密码 —— 到邮箱服务商的设置里单独生成一个。',
      'QQ 邮箱：设置 → 账户 → 开启 IMAP/SMTP 服务 → 拿到 16 位授权码。'
    ],

    // ---- 必填 ----
    email: PLACEHOLDER_EMAIL,
    authCode: PLACEHOLDER_CODE,
    allowFrom: [PLACEHOLDER_EMAIL],

    // ---- 邮箱服务器 ----
    // 默认按 QQ 邮箱填好，用别的服务商改这两组即可
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },

    // ---- 行为 ----
    pollSeconds: 15,           // 轮询间隔
    taskTimeoutSeconds: 600,   // 单个任务超时（10 分钟）
    maxTaskChars: 8000,        // 超过就截断（避免超长正文拖慢模型）
    maxReplyChars: 40000,      // 回信正文上限
    maxPerPoll: 10,            // 每轮最多处理几封未读（防止积压拖垮轮询）

    // ---- DSH ----
    dshBin: '',                // 留空则自动查找
    dshProfile: 'headless',    // dsh --profile <这个>
    sessionId: '',             // 留空 = 每封邮件独立；非空 = 接着聊

    // ---- 回信署名 ----
    // 发件人显示名，同时用作回信末尾的署名标签。留空则只显示邮箱地址。
    fromName: 'Mail Bridge',

    // ---- 安全 ----
    secret: '',                // 可选暗号：正文必须包含它才处理
    strictAuthCheck: true,     // 是否校验 SPF/DKIM（自建邮件服务器通不过时可关）

    // 是否剥掉正文末尾的签名块。
    // 默认开：很多邮件 App 会自动追加"名字 + 邮箱"两行，不剥掉就会混进任务文本、
    // 还会干扰特殊指令判定（「新会话」后面多两行就判不出来了）。
    // 想让结尾那两行原样传给 AI，设成 false。
    stripSignatures: true
  };
}

function configPath(root) {
  return path.join(root, 'config.json');
}

/**
 * 读配置。文件不存在时返回 { missing: true }，由调用方决定是生成还是报错。
 */
function loadConfig(root) {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    return { missing: true, file, config: defaultConfig() };
  }

  let raw;
  try {
    raw = parseJsonLoose(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      file,
      error: '配置文件不是合法 JSON：' + e.message,
      hint: '用编辑器打开 ' + file + ' 检查一下 —— 常见原因是多了一个逗号、少了引号，' +
            '或者保存成了带 BOM 的编码。也可以删掉它重新运行，会重新生成一份。'
    };
  }

  // 用默认值补齐缺项（深一层，够用）
  const cfg = defaultConfig();
  for (const k of Object.keys(cfg)) {
    if (raw[k] !== undefined) {
      if (cfg[k] && typeof cfg[k] === 'object' && !Array.isArray(cfg[k])) {
        cfg[k] = Object.assign({}, cfg[k], raw[k]);
      } else {
        cfg[k] = raw[k];
      }
    }
  }
  return { file, config: cfg, raw };
}

/**
 * 校验配置，返回问题列表。空数组 = 没问题。
 * 每条都写成"用户看了就知道怎么改"的话。
 */
function validateConfig(cfg) {
  const problems = [];

  if (!cfg.email || cfg.email === PLACEHOLDER_EMAIL || !/^[^@\s]+@[^@\s]+$/.test(cfg.email)) {
    problems.push({
      field: 'email',
      msg: 'email 没填或格式不对',
      fix: '填上你自己的邮箱地址，例如 someone@qq.com'
    });
  }

  // ⚠️ authCode 要 trim 后再判断：只写几个空格也算"没填"。
  //    只判 `!cfg.authCode` 的话，'   ' 是真值，会一路带到 IMAP 登录才失败 ——
  //    而那时的报错是"认证失败"，用户根本想不到是配置里多打了几个空格。
  const code = String(cfg.authCode == null ? '' : cfg.authCode).trim();
  if (!code || code === PLACEHOLDER_CODE) {
    problems.push({
      field: 'authCode',
      msg: 'authCode 没填（或只有空白）',
      fix: '到邮箱设置里开启 IMAP/SMTP 服务，生成 16 位授权码（不是登录密码），粘贴到这里'
    });
  }

  if (!Array.isArray(cfg.allowFrom) || cfg.allowFrom.length === 0) {
    problems.push({
      field: 'allowFrom',
      msg: 'allowFrom 是空的',
      fix: '至少填一个允许发命令的邮箱地址 —— 留空等于谁都不能用'
    });
  } else if (cfg.allowFrom.some(a => !String(a || '').trim() || a === PLACEHOLDER_EMAIL)) {
    problems.push({
      field: 'allowFrom',
      msg: 'allowFrom 里有空串或占位地址',
      fix: '换成你自己的邮箱地址；这个列表决定谁能遥控这台电脑，务必收紧'
    });
  }

  if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds < 5) {
    problems.push({
      field: 'pollSeconds',
      msg: 'pollSeconds 太小或不是数字',
      fix: '建议 10~60 秒。太频繁会被邮箱服务商限流'
    });
  }

  if (!Number.isFinite(cfg.taskTimeoutSeconds) || cfg.taskTimeoutSeconds < 10) {
    problems.push({
      field: 'taskTimeoutSeconds',
      msg: 'taskTimeoutSeconds 太小或不是数字',
      fix: '建议 300~900 秒'
    });
  }

  // ⚠️ secret 必须是字符串：后面 checkAuthenticity 里用的是
  //    `body.includes(cfg.secret)`，而 String.prototype.includes 收到数字会抛
  //    TypeError —— 配置校验放过去、运行时才炸，最难查。
  if (cfg.secret !== undefined && cfg.secret !== null && cfg.secret !== '' &&
      typeof cfg.secret !== 'string') {
    problems.push({
      field: 'secret',
      msg: 'secret 必须是字符串（现在是 ' + typeof cfg.secret + '）',
      fix: '用引号包起来，例如 "secret": "我的暗号"'
    });
  }

  if (typeof cfg.secret === 'string' && cfg.secret && cfg.secret.length < 4) {
    problems.push({
      field: 'secret',
      msg: 'secret 太短',
      fix: '要么留空（关闭暗号），要么设一个长一点的'
    });
  }

  return problems;
}

/** 日志里安全地显示邮箱：只露首字母和域名 */
function maskEmail(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  const name = s.slice(0, at);
  const head = name.slice(0, 2);
  return head + '*'.repeat(Math.max(1, name.length - 2)) + s.slice(at);
}

module.exports = {
  defaultConfig,
  loadConfig,
  validateConfig,
  configPath,
  maskEmail,
  PLACEHOLDER_EMAIL,
  PLACEHOLDER_CODE
};
