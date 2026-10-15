#!/usr/bin/env node
'use strict';

/**
 * 命令行入口。
 *
 *   node bin/cli.js init      生成/检查配置文件
 *   node bin/cli.js doctor    环境自检（不连邮箱、不跑任务）
 *   node bin/cli.js start     启动轮询
 *   node bin/cli.js help      用法
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));

// 语言要在最前面定：--lang= 是命令行参数，后面的输出全靠它
const { messages } = require(path.join(ROOT, 'src', 'i18n'));
const { lang, t, t2 } = messages(process.argv);

const { loadConfig, validateConfig, configPath, maskEmail, defaultConfig } = require(path.join(ROOT, 'src', 'config'));
const { createLogger } = require(path.join(ROOT, 'src', 'logger'));
const { findDshBin, guessPermissionFiles, createSessionStore } = require(path.join(ROOT, 'src', 'dsh'));

const OK = '  ✓ ';
const BAD = '  ✗ ';
const WARN = '  ⚠ ';

function line(s) { console.log(s || ''); }
function title(s) {
  line('');
  line('==============================================');
  line('  ' + s);
  line('==============================================');
}

// ==================== init ====================

function cmdInit() {
  const file = configPath(ROOT);
  title(t('init.title'));

  if (fs.existsSync(file)) {
    const { config, error, hint } = loadConfig(ROOT);
    if (error) {
      line(BAD + error);
      line('    ' + hint);
      process.exitCode = 1;
      return;
    }
    line('  ' + t('init.exists') + file);
    const problems = validateConfig(config);
    if (!problems.length) {
      line(OK + t('init.ok'));
      return;
    }
    line('');
    line(t('init.remaining', { n: problems.length }));
    for (const p of problems) {
      line('    · ' + p.field + '：' + p.msg);
      line('      → ' + p.fix);
    }
    return;
  }

  fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  line(OK + t('init.created') + file);
  line('');
  line('  ' + t('init.next'));
  line('    ' + t('init.step1'));
  line('    ' + t('init.step2'));
  line('    ' + t('init.step3'));
  line('    ' + t('init.step4'));
  line('');
  line('  ' + t('init.authcodeHow'));
  line('    ' + t('init.authcodePath'));
  line('');
  line('  ' + t('app.noAi'));
  line('  ' + t('init.installDsh'));
  line('    npm install -g @deepseek-ai/dsh');
  line('');
  line('  ' + t('init.then'));
}

// ==================== doctor ====================

function cmdDoctor() {
  title(t('doc.title'));
  let bad = 0;

  // 1) Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    line(OK + 'Node ' + process.version);
  } else {
    line(BAD + 'Node ' + process.version + t('doc.nodeOld'));
    bad++;
  }

  // 2) 依赖
  const deps = ['imapflow', 'mailparser', 'nodemailer'];
  for (const d of deps) {
    try {
      require.resolve(d, { paths: [ROOT] });
      line(OK + t('doc.dep') + d);
    } catch (e) {
      line(BAD + t('doc.dep') + d + t('doc.depMiss'));
      bad++;
    }
  }

  // 3) 配置文件
  const { config, error, hint, missing } = loadConfig(ROOT);
  if (missing) {
    line(BAD + t('doc.noConfig'));
    bad++;
  } else if (error) {
    line(BAD + error);
    line('    ' + hint);
    bad++;
  } else {
    const problems = validateConfig(config);
    if (problems.length) {
      line(BAD + t('doc.cfgProblems', { n: problems.length }));
      for (const p of problems) {
        line('      · ' + p.field + '：' + p.msg);
        line('        → ' + p.fix);
      }
      bad++;
    } else {
      line(OK + t('doc.cfgValid'));
      line('      ' + t('doc.lblMailbox') + maskEmail(config.email));
      line('      ' + t('doc.lblAllow') + config.allowFrom.map(maskEmail).join(', '));
      line('      ' + t('doc.lblPoll') + config.pollSeconds + t('doc.lblSeconds'));
      line('      ' + t('doc.lblSession') + (config.sessionId || t('doc.perMail')));
      line('      ' + t('doc.lblSecret') + (config.secret ? t('doc.on') : t('doc.off')));
    }
  }

  // 4) DSH
  if (config && !missing && !error) {
    const bin = findDshBin({ dshBin: config.dshBin });
    if (bin) {
      line(OK + t('doc.dshEntry') + bin);
    } else {
      line(BAD + t('doc.dshMissing'));
      line(t('doc.dshInstall'));
      line('        npm install -g @deepseek-ai/dsh');
      line(t('doc.dshRetry'));
      line(t('doc.dshManual'));
      line(t('doc.dshPoints'));
      line('        C:\\Users\\<you>\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
      bad++;
    }

    // 5) 权限配置文件（用于权限指纹）
    const pf = guessPermissionFiles({ dshHome: config.dshHome, dshProfile: config.dshProfile });
    const found = pf.filter(f => { try { return fs.existsSync(f); } catch (e) { return false; } });
    if (found.length) {
      line(OK + t('doc.permFiles', { n: found.length }));
      for (const f of found) line('      ' + f);
    } else {
      line(WARN + t('doc.permNone'));
      line('      ' + t('doc.permLooked'));
      for (const f of pf) line('      ' + f);
    }
  }

  // 6) 目录可写
  try {
    const probe = path.join(ROOT, '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    line(OK + t('doc.writable'));
  } catch (e) {
    line(BAD + t('doc.notWritable') + e.message);
    bad++;
  }

  line('');
  if (bad) {
    line(t('doc.badCount', { n: bad }));
    process.exitCode = 1;
  } else {
    line(t('doc.allGood'));
  }
}

// ==================== start ====================

async function cmdStart() {
  const { config, error, hint, missing } = loadConfig(ROOT);
  if (missing) {
    title(t('app.name'));
    line(BAD + t('doc.noConfig'));
    process.exitCode = 1;
    return;
  }
  if (error) {
    line(BAD + error);
    line('    ' + hint);
    process.exitCode = 1;
    return;
  }
  const problems = validateConfig(config);
  if (problems.length) {
    title(t('app.name'));
    line(BAD + t('start.notReady'));
    for (const p of problems) {
      line('    · ' + p.field + '：' + p.msg);
      line('      → ' + p.fix);
    }
    line('');
    line(t('start.seeDoctor'));
    process.exitCode = 1;
    return;
  }

  // 依赖在这里才 require：没装依赖时 init/doctor 也能给出友好提示
  let ImapFlow, simpleParser, nodemailer;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
    nodemailer = require('nodemailer');
  } catch (e) {
    line(BAD + t('start.depMissing'));
    line('    ' + e.message);
    process.exitCode = 1;
    return;
  }

  // 接线全部交给 src/app.js —— 那边有测试覆盖，
  // 免得"把 logger 对象当函数传"这类错误只在运行时才炸出来
  const { buildApp } = require(path.join(ROOT, 'src', 'app'));
  let app;
  try {
    app = buildApp({
      root: ROOT,
      config,
      deps: { ImapFlow, simpleParser, nodemailer }
    });
  } catch (e) {
    line(BAD + t('start.initFail') + (e && e.message ? e.message : e));
    process.exitCode = 1;
    return;
  }

  const { daemon, log, bin, transport } = app;

  title(t('app.name'));
  line(t('start.lblMailbox') + maskEmail(config.email));
  line(t('start.lblAllow') + config.allowFrom.map(maskEmail).join(', '));
  line(t('start.lblPoll') + config.pollSeconds + t('start.lblSeconds'));
  line(t('start.lblSession') + (config.sessionId || t('doc.perMail')));
  line(t('start.lblDsh') + (bin || t('start.dshPlaceholder')));
  line(t('start.lblLog') + path.join(ROOT, 'mail-bridge.log'));
  line('');
  if (!bin) {
    line(BAD + t('start.noDsh'));
    process.exitCode = 1;
    return;
  }
  line(t('start.ctrlC'));
  line('');

  process.on('SIGINT', () => {
    log(t('start.logSigint'));
    daemon.stop();
  });
  // 兜底：不让任何漏网的异常把进程整个干掉
  process.on('unhandledRejection', (e) => {
    log(t('start.logRejection') + (e && e.message ? e.message : e));
  });
  process.on('uncaughtException', (e) => {
    log(t('start.logException') + (e && e.stack ? e.stack : e));
  });

  await daemon.start({ bin, root: ROOT, transport });
}

// ==================== help ====================

function cmdHelp() {
  title(t('help.title', { v: PKG.version }));
  line('  ' + t('app.tagline'));
  line('');
  line(t('help.commands'));
  line('    node bin/cli.js init      ' + t('help.init'));
  line('    node bin/cli.js doctor    ' + t('help.doctor'));
  line('    node bin/cli.js start     ' + t('help.start'));
  line('    node bin/cli.js help      ' + t('help.help'));
  line('');
  line(t('help.npmAlso'));
  line('');
  line(t('help.docs'));
}

// ==================== 分发 ====================

// 先滤掉 --lang=xxx 这类全局选项，再取命令。
// 不滤的话 `node bin/cli.js --lang=en doctor` 会把 --lang=en 当成命令名。
const argvRest = process.argv.slice(2).filter(a => !a.startsWith('--lang='));
const cmd = (argvRest[0] || 'help').toLowerCase();

(async () => {
  try {
    if (cmd === 'init') cmdInit();
    else if (cmd === 'doctor') cmdDoctor();
    else if (cmd === 'start') await cmdStart();
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') cmdHelp();
    else if (cmd === '--version' || cmd === '-v') line(PKG.version);
    else {
      line(t('err.unknownCmd') + cmd);
      cmdHelp();
      process.exitCode = 1;
    }
  } catch (e) {
    line('');
    line(t('err.failed') + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
})();
