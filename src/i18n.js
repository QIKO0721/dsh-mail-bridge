'use strict';

/**
 * CLI 的中英文文案。
 *
 * 为什么单独一个文件：项目定位是英文优先（README 前 359 行全英文），
 * 但作者与主要用户是中文用户。所以两边都要照顾 ——
 * 把文案集中在这里，加语言只要加一列，不用去 317 行的 cli.js 里翻。
 *
 * 语言怎么定（优先级从高到低）：
 *   1. 命令行 --lang=en / --lang=zh
 *   2. 环境变量 MAIL_BRIDGE_LANG
 *   3. 系统语言：中文环境用中文，其余一律英文
 *
 * 第 3 条是有意设计成"非中文即英文"，而不是"支持的所有语言"——
 * 界面只有两套文案，猜错不如给英文这个通用默认值。
 */

const TABLE = {
  // ---------- 通用标签 ----------
  'app.name':          { zh: '邮箱助手',                    en: 'Mail Bridge' },
  'app.tagline':       { zh: '用一封邮件，遥控一台没有公网 IP 的电脑上的 DSH 干活。',
                         en: 'Command DSH on a NAT-ed machine by sending it an email.' },
  'app.noAi':          { zh: '这个项目本身不含 AI，干活的是 DSH。',
                         en: 'This project contains no AI of its own; DSH does the work.' },

  // ---------- init ----------
  'init.title':        { zh: '邮箱助手 · 配置',              en: 'Mail Bridge · Setup' },
  'init.exists':       { zh: '配置文件已存在：',              en: 'Config already exists: ' },
  'init.ok':           { zh: '检查通过，可以直接 start',      en: 'Looks good. You can run start.' },
  'init.remaining':    { zh: ' 还有 {n} 项要填：',            en: ' {n} field(s) still need attention:' },
  'init.created':      { zh: '已生成配置文件：',              en: 'Wrote config file: ' },
  'init.next':         { zh: '接下来：',                     en: 'Next:' },
  'init.step1':        { zh: '1. 用编辑器打开它',             en: '1. Open it in an editor' },
  'init.step2':        { zh: '2. 填 email（你的邮箱地址）',    en: '2. Set email    - your mailbox address' },
  'init.step3':        { zh: '3. 填 authCode（邮箱授权码 —— 不是登录密码！）',
                         en: '3. Set authCode - the app-specific authorization code, NOT your login password' },
  'init.step4':        { zh: '4. 填 allowFrom（允许发命令的地址，收紧到只有你自己）',
                         en: '4. Set allowFrom - the ONLY addresses allowed to command this machine' },
  'init.authcodeHow':  { zh: '授权码怎么拿（以 QQ 邮箱为例）：',
                         en: 'Where to get an authorization code (QQ Mail example):' },
  'init.authcodePath': { zh: '设置 → 账户 → 开启「IMAP/SMTP 服务」→ 按提示发短信 → 拿到 16 位授权码',
                         en: 'Settings -> Account -> enable IMAP/SMTP -> follow the SMS prompt -> a 16-char code' },
  'init.installDsh':   { zh: '没装过的话先装一个（装完 doctor 会自动认出来）：',
                         en: 'If DSH is not installed yet (doctor detects it automatically afterwards):' },
  'init.then':         { zh: '填好后运行：  node bin/cli.js doctor',
                         en: 'When done, run:  node bin/cli.js doctor' },

  // ---------- doctor ----------
  'doc.title':         { zh: '邮箱助手 · 环境自检',          en: 'Mail Bridge · Doctor' },
  'doc.nodeOld':       { zh: ' 太老（需要 >= 18）',           en: ' is too old (need >= 18)' },
  'doc.dep':           { zh: '依赖 ',                        en: 'dependency ' },
  'doc.depMiss':       { zh: ' 没装 —— 运行 npm install',     en: ' is missing - run npm install' },
  'doc.noConfig':      { zh: '还没有 config.json —— 先运行: node bin/cli.js init',
                         en: 'no config.json yet - run: node bin/cli.js init' },
  'doc.cfgProblems':   { zh: '配置有 {n} 项问题：',           en: 'config has {n} problem(s):' },
  'doc.cfgValid':      { zh: '配置有效',                     en: 'config is valid' },
  'doc.lblMailbox':    { zh: '邮箱      ',                   en: 'mailbox    ' },
  'doc.lblAllow':      { zh: '白名单    ',                   en: 'allowFrom  ' },
  'doc.lblPoll':       { zh: '轮询间隔  ',                   en: 'poll every ' },
  'doc.lblSeconds':    { zh: ' 秒',                          en: 's' },
  'doc.lblSession':    { zh: '会话      ',                   en: 'session    ' },
  'doc.perMail':       { zh: '(每封独立)',                   en: '(fresh per mail)' },
  'doc.lblSecret':     { zh: '暗号      ',                   en: 'secret     ' },
  'doc.on':            { zh: '已启用',                       en: 'enabled' },
  'doc.off':           { zh: '未启用',                       en: 'not set' },
  'doc.dshEntry':      { zh: 'DSH 入口 ',                    en: 'DSH entry  ' },
  'doc.dshMissing':    { zh: '找不到 DSH —— 这个项目本身不含 AI，它只是把任务转交给 DSH。',
                         en: 'DSH not found - this project has no AI of its own, it only hands tasks to DSH.' },
  'doc.dshInstall':    { zh: '      还没装的话，先装：',        en: '      If it is not installed:' },
  'doc.dshRetry':      { zh: '      装完再跑一次 doctor，一般就能自动认出来了。',
                         en: '      Re-run doctor afterwards; it usually finds it automatically.' },
  'doc.dshManual':     { zh: '      如果装完还是找不到，就把入口路径手填进 config.json 的 dshBin，',
                         en: '      If it still cannot find it, set dshBin in config.json by hand.' },
  'doc.dshPoints':     { zh: '      它指向包里的 lib/bin.js，例如：',
                         en: '      It points at lib/bin.js inside the package, for example:' },
  'doc.permFiles':     { zh: '权限配置 {n} 个文件（指纹监控生效）',
                         en: 'permission files: {n} (fingerprint tracking active)' },
  'doc.permNone':      { zh: '没找到权限配置文件 —— 权限指纹机制会静默失效（不影响使用）',
                         en: 'no permission config files found - fingerprint rotation will silently do nothing (harmless)' },
  'doc.permLooked':    { zh: '      找过这些位置：',           en: '      Looked in:' },
  'doc.writable':      { zh: '工作目录可写',                  en: 'working directory is writable' },
  'doc.notWritable':   { zh: '工作目录不可写：',              en: 'working directory is not writable: ' },
  'doc.badCount':      { zh: '  自检发现 {n} 个问题，先解决再 start。',
                         en: '  {n} problem(s) found - fix them before start.' },
  'doc.allGood':       { zh: '  自检通过，可以 start 了：  node bin/cli.js start',
                         en: '  All good. Start it with:  node bin/cli.js start' },

  // ---------- start ----------
  'start.noConfig':    { zh: '还没有 config.json —— 先运行: node bin/cli.js init',
                         en: 'no config.json yet - run: node bin/cli.js init' },
  'start.notReady':    { zh: '配置还没填好：',                 en: 'config is not ready:' },
  'start.seeDoctor':   { zh: '  （运行 node bin/cli.js doctor 看完整自检）',
                         en: '  (run node bin/cli.js doctor for the full check)' },
  'start.depMissing':  { zh: '依赖没装全，先运行: npm install',
                         en: 'dependencies are incomplete - run: npm install' },
  'start.initFail':    { zh: '初始化失败：',                   en: 'initialization failed: ' },
  'start.lblMailbox':  { zh: '  邮箱      ',                  en: '  mailbox    ' },
  'start.lblAllow':    { zh: '  白名单    ',                  en: '  allowFrom  ' },
  'start.lblPoll':     { zh: '  轮询间隔  ',                  en: '  poll every ' },
  'start.lblSeconds':  { zh: ' 秒',                           en: 's' },
  'start.lblSession':  { zh: '  会话      ',                  en: '  session    ' },
  'start.lblDsh':      { zh: '  DSH       ',                  en: '  DSH        ' },
  'start.dshPlaceholder': { zh: '【找不到！请在 config.json 里填 dshBin】',
                            en: '[NOT FOUND - set dshBin in config.json]' },
  'start.lblLog':      { zh: '  日志      ',                  en: '  log        ' },
  'start.noDsh':       { zh: '没有 DSH 就没法干活。填好 dshBin 再启动。',
                         en: 'Without DSH there is nothing to do the work. Set dshBin and start again.' },
  'start.ctrlC':       { zh: '  按 Ctrl+C 停止。这个窗口别关。',
                         en: '  Press Ctrl+C to stop. Leave this window open.' },
  'start.logSigint':   { zh: '收到 Ctrl+C，准备退出',           en: 'Ctrl+C received, shutting down' },
  'start.logRejection':{ zh: '未处理的 Promise 异常（已忽略，继续运行）：',
                         en: 'unhandled promise rejection (ignored, still running): ' },
  'start.logException':{ zh: '未捕获的异常（已忽略，继续运行）：',
                         en: 'uncaught exception (ignored, still running): ' },

  // ---------- help ----------
  'help.title':        { zh: '邮箱助手 v{v} · 用法',           en: 'Mail Bridge v{v} · usage' },
  'help.commands':     { zh: '  命令：',                      en: '  Commands:' },
  'help.init':         { zh: '生成配置文件',                   en: 'write the config file' },
  'help.doctor':       { zh: '环境自检（不连邮箱、不跑任务）',   en: 'check the environment (no mailbox, no task)' },
  'help.start':        { zh: '启动轮询',                      en: 'start polling' },
  'help.help':         { zh: '这条说明',                      en: 'this text' },
  'help.npmAlso':      { zh: '  也可以：npm run init / npm run doctor / npm start / npm test',
                         en: '  Or via npm: npm run init / npm run doctor / npm start / npm test' },
  'help.docs':         { zh: '  文档见 README.md',             en: '  Docs: README.md' },

  // ---------- 分发 ----------
  'err.unknownCmd':    { zh: '未知命令：',                    en: 'unknown command: ' },
  'err.failed':        { zh: '出错了：',                      en: 'Failed: ' }
};

/**
 * 决定用哪种语言。
 * @param {string[]} argv  process.argv
 * @returns {'zh'|'en'}
 */
function detectLang(argv) {
  const arg = (argv || []).find(a => a.startsWith('--lang='));
  if (arg) {
    const v = arg.slice('--lang='.length).toLowerCase();
    if (v.startsWith('zh')) return 'zh';
    if (v.startsWith('en')) return 'en';
  }
  const env = (process.env.MAIL_BRIDGE_LANG || '').toLowerCase();
  if (env.startsWith('zh')) return 'zh';
  if (env.startsWith('en')) return 'en';

  // 系统语言：中文环境给中文，其余一律英文
  let loc = '';
  try {
    loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
  } catch (e) {
    loc = process.env.LANG || process.env.LC_ALL || '';
  }
  return /^zh/i.test(loc) ? 'zh' : 'en';
}

/**
 * 造一个取文案的函数。
 * @param {'zh'|'en'} lang
 * @returns {(key: string, vars?: object) => string}
 */
function createT(lang) {
  return function t(key, vars) {
    const entry = TABLE[key];
    if (!entry) return key;                  // 缺条目就把 key 原样返回，便于发现
    let s = entry[lang] || entry.en || key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.split('{' + k + '}').join(String(vars[k]));
      }
    }
    return s;
  };
}

/**
 * 运行时用的双语二选一。
 *
 * 为什么除了 key 表还要这个：
 *   CLI 的文案是固定短句，适合 key 表；
 *   但主循环的日志和回信正文大量带变量（"已回信给 xxx"、"用时 N 秒"），
 *   拆成 key + 占位符会把一行代码撑成三行，可读性反而变差。
 *   这种地方用 t2(中文, 英文) 最直接，变量插值就是普通的字符串拼接。
 *
 * @param {'zh'|'en'} lang
 * @returns {(zh: string, en: string) => string}
 */
function createT2(lang) {
  return function t2(zh, en) {
    return lang === 'zh' ? zh : en;
  };
}

/**
 * 当前语言下的文案集合。CLI 与主循环都用它。
 *
 * @param {string[]} [argv]  传 process.argv 就会先看 --lang=
 * @returns {{ lang: 'zh'|'en', t: Function, t2: Function }}
 */
function messages(argv) {
  const lang = detectLang(argv || process.argv);
  return { lang, t: createT(lang), t2: createT2(lang) };
}

module.exports = { detectLang, createT, createT2, messages, TABLE };
