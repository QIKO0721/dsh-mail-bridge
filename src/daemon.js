'use strict';

/**
 * 主循环：轮询收件箱 → 逐个处理 → 回信。
 *
 * 处理一封邮件的完整流水线：
 *   1. 标已读（先标，避免处理失败被无限重投）
 *   2. 白名单校验        —— 不在名单里直接跳过
 *   3. 防自环            —— 自己发出去的回信不当指令
 *   4. 防伪造            —— SPF/DKIM + 可选暗号
 *   5. 清洗正文          —— 去引文、去签名
 *   6. 特殊指令          —— 开新会话 / 帮助
 *   7. 交给任务执行器    —— 会话续接 + 权限兜底
 *   8. 回信
 */

const { senderAllowed, isOwnReply, checkAuthenticity } = require('./security');
const { cleanBody, matchNewSession, matchHelp } = require('./email');
const mail = require('./mail');
const { buildReply } = require('./task');
const { maskEmail } = require('./config');

/** 帮助回信的内容 */
function helpText(cfg, sessionId) {
  return [
    '邮箱助手 · 用法',
    '',
    '直接发邮件，正文就是你说的话，处理完会回信。',
    '',
    '特殊指令（正文只写这几个词）：',
    '  帮助 / help                       看这条说明',
    '  新会话 / 新对话 / new / reset     清空记忆，重新开始',
    '',
    '⚠ 关于「开新会话」：',
    '  DSH 的权限预设【只对新会话生效】。',
    '  如果 AI 动不了工作区外的文件，说明当前会话还是旧权限 ——',
    '  发一封正文只写「新会话」的邮件，下一篇就会拿到新权限。',
    '  注意：清空是【下一篇】才生效，这一封本身还是旧记忆在答。',
    '',
    '当前会话：' + (sessionId || '(还没有，下封信会新建)'),
    '',
    '只处理来自这些地址的邮件：',
    '  ' + (cfg.allowFrom || []).join('\n  ')
  ].join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.log
 * @param {object} deps.ImapFlow       注入的 imapflow 构造函数
 * @param {Function} deps.simpleParser 注入的 mailparser.simpleParser
 * @param {Function} deps.nodemailer   注入的 nodemailer
 * @param {object} deps.runner         任务执行器（task.createTaskRunner 的产物）
 * @param {Function} deps.saveSessionId
 * @param {Function} [deps.sleep]      注入 sleep，测试可加速
 */
function createDaemon(deps) {
  const cfg = deps.cfg;
  const log = deps.log;
  const runner = deps.runner;
  const saveSessionId = deps.saveSessionId || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  let running = false;

  /** 处理一封邮件，返回一份"结果摘要"（方便测试和日志） */
  async function handleOne(job, ctx) {
    const from = job.fromList[0] || '';

    // 2) 白名单
    if (!senderAllowed(job.fromList, cfg.allowFrom)) {
      log('跳过（不在白名单）：' + (job.fromList.join(',') || '(无发件人)'));
      return { action: 'skip-not-allowed' };
    }

    if (job.parseError) {
      log('跳过（' + job.parseError + '）：UID ' + job.uid);
      return { action: 'skip-parse-error' };
    }

    const parsed = job.parsed;
    const rawText = String(parsed.text || '');
    const rawHtml = parsed.html ? String(parsed.html) : '';

    // 3) 防自环
    const loop = isOwnReply({
      headers: parsed.headers, fromList: job.fromList,
      ownAddress: cfg.email, text: rawText
    });
    if (loop) {
      log('跳过（认出是自己发出的回信，防自环 · ' + loop + '）');
      return { action: 'skip-own-reply' };
    }

    // 4) 防伪造
    const auth = checkAuthenticity({
      headers: parsed.headers, secret: cfg.secret,
      text: rawText, html: rawHtml,
      strictAuthCheck: cfg.strictAuthCheck
    });
    if (!auth.ok) {
      log('!! 拦截可疑邮件（UID ' + job.uid + '）：' + auth.reason +
          '  声称发件人=' + job.fromList.join(',') +
          (auth.detail ? '  [' + auth.detail + ']' : ''));
      return { action: 'blocked-forgery' };
    }

    // 5) 清洗正文
    //    把这里的选项统一带上，保证"任务文本"和"指令判定"用同一套规则
    const bodyOpts = { from, stripSignatures: cfg.stripSignatures };
    const task = cleanBody(rawText, rawHtml, bodyOpts);
    if (!task) {
      log('跳过（正文是空的，或只剩引用）');
      return { action: 'skip-empty' };
    }

    const subject = mail.replySubject(job.subject);

    // 6a) 开新会话
    const resetHit = matchNewSession(task, bodyOpts);
    if (resetHit) {
      saveSessionId('');
      cfg.sessionId = '';
      log('已清空会话 ID（触发词「' + resetHit + '」），下一篇邮件会开新会话');
      await mail.sendReply(ctx.transport, cfg, {
        to: from, subject,
        body: '已清空记忆（触发了「' + resetHit + '」）。\n\n' +
              '注意：是【下一篇】邮件才生效 —— 下一篇会当全新对话开始，' +
              '记得把它当成第一句话来说。'
      });
      return { action: 'new-session', trigger: resetHit };
    }

    // 6b) 帮助
    if (matchHelp(task, bodyOpts)) {
      await mail.sendReply(ctx.transport, cfg, {
        to: from, subject, body: helpText(cfg, cfg.sessionId)
      });
      return { action: 'help' };
    }

    // 7) 交给 DSH
    let limited = task;
    const maxTask = cfg.maxTaskChars || 8000;
    if (limited.length > maxTask) {
      log('任务正文过长（' + limited.length + ' 字），截断到 ' + maxTask);
      limited = '（提醒：原邮件正文过长，只截取了开头 ' + maxTask + ' 字）\n\n' +
                limited.slice(0, maxTask);
    }

    log('收到任务：' + limited.slice(0, 80).replace(/\n/g, ' ') +
        (limited.length > 80 ? '…' : ''));

    const t0 = Date.now();
    const result = await runner.run({
      task: limited, cfg, bin: ctx.bin, cwd: ctx.root, spawnFn: deps.spawnFn
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    log('处理完，用时 ' + secs + ' 秒，' + (result.ok ? '成功' : '失败'));

    // 8) 回信
    await mail.sendReply(ctx.transport, cfg, {
      to: from, subject, body: buildReply(result, secs, { tag: cfg.fromName || '邮箱助手' })
    });
    log('已回信给 ' + maskEmail(from));

    return { action: 'handled', ok: result.ok, seconds: secs, rotated: result.rotated || null };
  }

  /** 跑一轮：连上、取未读、逐个处理、断开 */
  async function pollOnce(ctx) {
    const client = mail.createImapClient(deps.ImapFlow, cfg);
    let jobs = [];
    try {
      await client.connect();

      // 先取全部未读并标记，避免处理过程中被重复拉到
      jobs = await mail.fetchUnread(client, deps.simpleParser);
    } catch (e) {
      log('收取邮件出错：' + (e && e.message ? e.message : e));
      try { await client.logout(); } catch (x) { /* ignore */ }
      return { fetched: 0, results: [] };
    }

    if (jobs.length) log('发现 ' + jobs.length + ' 封未读');

    // ★ 每轮处理上限：不设的话，收件箱一旦积压就出事。
    //   实测：50 封未读会让一轮串行跑 50 次任务；而真实单次 DSH 任务要 30~60 秒，
    //   于是积压 200 封 = 两个半小时里完全不轮询新邮件 ——
    //   这期间用户还以为助手在正常工作，新发的指令要等到最后才被看到。
    //   限制每轮消化几封，剩下的下一轮继续，轮询节奏就不会被拖垮。
    const perPoll = Number(cfg.maxPerPoll) > 0 ? Math.floor(Number(cfg.maxPerPoll)) : 10;
    let batch = jobs;
    if (jobs.length > perPoll) {
      log('未读较多（' + jobs.length + ' 封），本轮只处理前 ' + perPoll +
          ' 封，其余留到下一轮（避免积压拖垮轮询）');
      batch = jobs.slice(0, perPoll);
    }

    const results = [];
    for (const job of batch) {
      // ★ 每封独立 try/catch：一封出问题不能让同批的其他邮件被跳过
      try {
        await mail.markSeen(client, job.uid);
      } catch (e) { /* ignore */ }

      try {
        results.push(await handleOne(job, ctx));
      } catch (e) {
        const msg = (e && e.message ? e.message : String(e));
        log('处理邮件出错（UID ' + job.uid + '）：' + msg);
        results.push({ action: 'error', error: msg });
        // 尽力回一封出错信，回不出去也不能让整批挂掉
        try {
          await mail.sendReply(ctx.transport, cfg, {
            to: job.fromList[0] || cfg.email,
            subject: mail.replySubject(job.subject),
            body: '【出错了】处理这封邮件时发生异常：\n' + msg
          });
        } catch (x) { /* ignore */ }
      }
    }

    try { await client.logout(); } catch (e) { /* ignore */ }
    return { fetched: jobs.length, results };
  }

  /**
   * 启动：自检 → 循环。
   * @param {object} ctx { bin, root, transport }
   */
  async function start(ctx) {
    running = true;

    // 启动自检：权限配置变过就换会话
    const rot = runner.rotateSessionIfPermissionChanged({
      sessionId: cfg.sessionId,
      permissionFiles: deps.permissionFiles || []
    });
    if (rot.rotated) cfg.sessionId = '';

    // ⚠️ 间隔要做数值兜底：CLI 启动前会校验配置，但 start() 也能被当库直接调用。
    //    一旦 pollSeconds 是 undefined，Math.max(5, undefined) = NaN，
    //    而 setTimeout(fn, NaN) 会被当成 0 延迟 —— 变成不停连 IMAP 的空转。
    const pollSeconds = Number(cfg.pollSeconds) > 0 ? Number(cfg.pollSeconds) : 15;

    log('启动，开始轮询（间隔 ' + pollSeconds + ' 秒）');

    while (running) {
      await pollOnce(ctx);
      if (!running) break;
      await sleep(Math.max(5, pollSeconds) * 1000);
    }
    log('已退出');
  }

  function stop() { running = false; }

  return { start, stop, pollOnce, handleOne };
}

module.exports = { createDaemon, helpText };
