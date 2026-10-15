'use strict';

/**
 * 组装：把配置、日志、会话状态、任务执行器、主循环拼成一套能跑的东西。
 *
 * 为什么单独一个文件：这些"接线"出错的时候最难查 ——
 * 比如把 `createLogger()` 返回的 { log, file } 整个对象当成日志函数传下去，
 * 类型检查不会有意见，只在运行时炸成 "log is not a function"。
 * 把接线抽出来，测试才能直接验它。
 */

const fs = require('fs');
const path = require('path');

const { configPath } = require('./config');
const { messages } = require('./i18n');

const { t2 } = messages();
const { createLogger } = require('./logger');
const { createSessionStore, guessPermissionFiles, findDshBin } = require('./dsh');
const { createTaskRunner } = require('./task');
const { createDaemon } = require('./daemon');
const mail = require('./mail');

/**
 * @param {object} opts
 * @param {string} opts.root          项目根目录
 * @param {object} opts.config        已校验过的配置
 * @param {object} opts.deps          运行时依赖
 * @param {object} opts.deps.ImapFlow
 * @param {Function} opts.deps.simpleParser
 * @param {object} opts.deps.nodemailer
 * @param {Function} [opts.loggerFactory] 注入日志工厂（测试用）
 * @returns {{daemon, runner, transport, log, bin, permissionFiles, store, saveSessionId}}
 */
function buildApp(opts) {
  const root = opts.root;
  const config = opts.config;
  const deps = opts.deps || {};

  // ★ 注意：createLogger 返回的是 { log, file }，这里必须取出 .log 这个函数。
  //   直接把整个对象传下去会变成 "log is not a function"（真实踩过）。
  const loggerFactory = opts.loggerFactory || createLogger;
  const logger = loggerFactory({ file: path.join(root, 'mail-bridge.log') });
  const log = logger.log;

  const bin = findDshBin({ dshBin: config.dshBin });
  const permissionFiles = guessPermissionFiles({
    dshHome: config.dshHome,
    dshProfile: config.dshProfile
  });
  const store = createSessionStore(path.join(root, 'state.json'));

  /** 把新的会话 ID 写回 config.json（内存 + 磁盘） */
  function saveSessionId(id) {
    config.sessionId = id;
    try {
      const file = configPath(root);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      raw.sessionId = id;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
    } catch (e) {
      log(t2('保存会话 ID 失败：', 'failed to save the session id: ') + (e && e.message ? e.message : e));
    }
  }

  const runner = createTaskRunner({ log, sessionStore: store, saveSessionId });

  const transport = mail.createTransport(deps.nodemailer, config);

  const daemon = createDaemon({
    cfg: config,
    log,
    ImapFlow: deps.ImapFlow,
    simpleParser: deps.simpleParser,
    nodemailer: deps.nodemailer,
    runner,
    saveSessionId,
    permissionFiles
  });

  return { daemon, runner, transport, log, bin, permissionFiles, store, saveSessionId, logger };
}

module.exports = { buildApp };
