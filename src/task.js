'use strict';

/**
 * 任务编排：把一封邮件的正文变成一次（或两次）DSH 调用，并处理会话问题。
 *
 * 这一层要解决三个真实发生过的问题：
 *   1. 会话续接失败       —— session-id 失效了要能自动降级成新会话
 *   2. 权限改了不生效     —— 权限指纹变了要换会话
 *   3. 干活时才发现没权限 —— 事件流里出现权限拒绝要自动换会话重跑一次
 *
 * 依赖全部注入，所以测试可以塞一个假的 runOnce，不用真装 DSH。
 */

const { runDshOnce, permissionFingerprint, guessPermissionFiles } = require('./dsh');

/**
 * 造一个任务执行器。
 *
 * @param {object} deps
 * @param {Function} deps.log            日志函数
 * @param {Function} deps.runOnce        跑一次 DSH（默认 dsh.runDshOnce）
 * @param {object}   deps.sessionStore   会话/权限状态存储
 * @param {Function} deps.saveSessionId  把新的 sessionId 写回配置
 */
function createTaskRunner(deps) {
  const log = deps.log;
  const runOnce = deps.runOnce || runDshOnce;
  const sessionStore = deps.sessionStore;
  const saveSessionId = deps.saveSessionId || (() => {});

  /**
   * 启动自检：权限配置变过就把会话 ID 清掉。
   *
   * 为什么放在启动时：用户的心理模型是"改完配置 → 重启 → 生效"。
   * 但 DSH 的权限只在建会话时读一次，不主动换会话的话，
   * 重启完看起来毫无变化 —— 会让人以为是配置没写对，白折腾很久。
   */
  function rotateSessionIfPermissionChanged(opts) {
    if (!opts.permissionFiles || !opts.permissionFiles.length) {
      return { rotated: false, reason: 'no-permission-files' };
    }
    const fp = permissionFingerprint(opts.permissionFiles);
    const res = sessionStore.checkPermissionFingerprint(fp);

    if (res.rotate) {
      const old = opts.sessionId || '';
      if (old) saveSessionId('');
      sessionStore.set({
        permissionHash: res.to,
        rotatedAt: new Date().toISOString(),
        rotatedFrom: old
      });
      log('⚠ 检测到 DSH 权限配置有变化（指纹 ' + res.from + ' → ' + res.to + '）—— ' +
          '权限预设只对新会话生效，已清空会话 ID' + (old ? '（原会话 ' + old + '）' : '') +
          '，下一封邮件会新建会话');
      return { rotated: true, from: res.from, to: res.to, droppedSession: old };
    }
    return { rotated: false, fingerprint: fp, firstRun: res.firstRun };
  }

  /**
   * 跑一个任务。
   *
   * @param {object} opts
   * @param {string} opts.task
   * @param {object} opts.cfg   配置
   * @param {string} opts.bin   DSH 入口
   * @returns {Promise<{ok, text, rotated, sessionId}>}
   */
  async function run(opts) {
    const cfg = opts.cfg;
    const base = {
      bin: opts.bin,
      task: opts.task,
      profile: cfg.dshProfile,
      timeoutMs: (cfg.taskTimeoutSeconds || 600) * 1000,
      cwd: opts.cwd,
      spawnFn: deps.spawnFn
    };

    let result = await runOnce(Object.assign({}, base, { sessionId: cfg.sessionId || undefined }));

    // ---- 会话失效 → 去掉 session-id 重开一个 ----
    if (!result.ok && cfg.sessionId && (result.unknownSession || result.sessionId)) {
      log('会话 ' + cfg.sessionId + ' 不可用，改开新会话重试');
      result = await runOnce(Object.assign({}, base, { sessionId: undefined }));
    }

    // ---- ★ 权限兜底：当前会话被操作系统拒了 → 换新会话重跑一次 ----
    //
    // 只重试一次，绝不循环：换新会话还被拒，说明是权限配置本身的问题，
    // 不是会话陈旧 —— 那种情况必须如实告诉用户，而不是无休止地重试。
    let rotated = null;
    if (result.permissionDenied && cfg.sessionId) {
      const oldId = cfg.sessionId;
      saveSessionId('');
      cfg.sessionId = '';
      log('⚠ 检测到权限被拒（操作系统级拒绝），会话 ' + oldId +
          ' 可能仍是旧权限 —— 改开新会话重跑本次任务');

      const retry = await runOnce(Object.assign({}, base, { sessionId: undefined }));
      rotated = {
        from: oldId,
        to: retry.sessionId || null,
        ok: !!retry.ok,
        stillDenied: !!retry.permissionDenied
      };
      if (retry.ok || retry.sessionId) result = retry;
      log('换会话重跑完成：' + (retry.ok ? '成功' : '失败') +
          (retry.permissionDenied ? '（新会话仍被拒 —— 说明是权限配置本身的问题）' : ''));
    }

    // ---- 新会话 ID 持久化 ----
    if (result.sessionId && result.sessionId !== cfg.sessionId) {
      cfg.sessionId = result.sessionId;
      saveSessionId(result.sessionId);
      log('会话 ID 已保存: ' + result.sessionId);
    }

    result.rotated = rotated;
    return result;
  }

  return { run, rotateSessionIfPermissionChanged };
}

/** 把回信正文拼出来，自动换过会话时加一段说明 */
function buildReply(result, elapsedSeconds, opts) {
  const o = opts || {};
  const tag = o.tag || '邮箱助手';

  if (!result.ok) {
    return '【出错了】\n' + result.text;
  }

  let notice = '';
  if (result.rotated) {
    notice = result.rotated.stillDenied
      ? '【注意】检测到权限被拒，已自动换了一个新会话重试，但**新会话仍然被拒** ——\n' +
        '这说明是权限配置本身的问题，不是会话陈旧。请检查 DSH 的权限预设。\n' +
        '（另外：会话记忆已重置）\n\n'
      : '【注意】检测到刚才那个会话是旧权限（DSH 的权限预设只对新会话生效），\n' +
        '已自动换成新会话重跑本次任务。**会话记忆已重置**，\n' +
        '之前那个会话里聊的内容不记得了，有必要的话请再说一次。\n\n';
  }

  return notice + result.text + '\n\n---\n' + tag + ' · 用时 ' + elapsedSeconds + ' 秒';
}

module.exports = { createTaskRunner, buildReply };
