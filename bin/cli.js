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
  title('邮箱助手 · 配置');

  if (fs.existsSync(file)) {
    const { config, error, hint } = loadConfig(ROOT);
    if (error) {
      line(BAD + error);
      line('    ' + hint);
      process.exitCode = 1;
      return;
    }
    line('  配置文件已存在：' + file);
    const problems = validateConfig(config);
    if (!problems.length) {
      line(OK + '检查通过，可以直接 start');
      return;
    }
    line('');
    line('  还有 ' + problems.length + ' 项要填：');
    for (const p of problems) {
      line('    · ' + p.field + '：' + p.msg);
      line('      → ' + p.fix);
    }
    return;
  }

  fs.writeFileSync(file, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  line(OK + '已生成配置文件：' + file);
  line('');
  line('  接下来：');
  line('    1. 用编辑器打开它');
  line('    2. 填 email（你的邮箱地址）');
  line('    3. 填 authCode（邮箱授权码 —— 不是登录密码！）');
  line('    4. 填 allowFrom（允许发命令的地址，收紧到只有你自己）');
  line('');
  line('  授权码怎么拿（以 QQ 邮箱为例）：');
  line('    设置 → 账户 → 开启「IMAP/SMTP 服务」→ 按提示发短信 → 拿到 16 位授权码');
  line('');
  line('  另外：这个项目本身不含 AI，干活的是 DSH。');
  line('  没装过的话先装一个（装完 doctor 会自动认出来）：');
  line('    npm install -g @deepseek-ai/dsh');
  line('');
  line('  填好后运行：  node bin/cli.js doctor');
}

// ==================== doctor ====================

function cmdDoctor() {
  title('邮箱助手 · 环境自检');
  let bad = 0;

  // 1) Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) {
    line(OK + 'Node ' + process.version);
  } else {
    line(BAD + 'Node ' + process.version + ' 太老（需要 >= 18）');
    bad++;
  }

  // 2) 依赖
  const deps = ['imapflow', 'mailparser', 'nodemailer'];
  for (const d of deps) {
    try {
      require.resolve(d, { paths: [ROOT] });
      line(OK + '依赖 ' + d);
    } catch (e) {
      line(BAD + '依赖 ' + d + ' 没装 —— 运行 npm install');
      bad++;
    }
  }

  // 3) 配置文件
  const { config, error, hint, missing } = loadConfig(ROOT);
  if (missing) {
    line(BAD + '还没有 config.json —— 先运行: node bin/cli.js init');
    bad++;
  } else if (error) {
    line(BAD + error);
    line('    ' + hint);
    bad++;
  } else {
    const problems = validateConfig(config);
    if (problems.length) {
      line(BAD + '配置有 ' + problems.length + ' 项问题：');
      for (const p of problems) {
        line('      · ' + p.field + '：' + p.msg);
        line('        → ' + p.fix);
      }
      bad++;
    } else {
      line(OK + '配置有效');
      line('      邮箱      ' + maskEmail(config.email));
      line('      白名单    ' + config.allowFrom.map(maskEmail).join(', '));
      line('      轮询间隔  ' + config.pollSeconds + ' 秒');
      line('      会话      ' + (config.sessionId || '(每封独立)'));
      line('      暗号      ' + (config.secret ? '已启用' : '未启用'));
    }
  }

  // 4) DSH
  if (config && !missing && !error) {
    const bin = findDshBin({ dshBin: config.dshBin });
    if (bin) {
      line(OK + 'DSH 入口 ' + bin);
    } else {
      line(BAD + '找不到 DSH —— 这个项目本身不含 AI，它只是把任务转交给 DSH。');
      line('      还没装的话，先装：');
      line('        npm install -g @deepseek-ai/dsh');
      line('      装完再跑一次 doctor，一般就能自动认出来了。');
      line('      如果装完还是找不到，就把入口路径手填进 config.json 的 dshBin，');
      line('      它指向包里的 lib/bin.js，例如：');
      line('        C:\\Users\\你\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js');
      bad++;
    }

    // 5) 权限配置文件（用于权限指纹）
    const pf = guessPermissionFiles({ dshHome: config.dshHome, dshProfile: config.dshProfile });
    const found = pf.filter(f => { try { return fs.existsSync(f); } catch (e) { return false; } });
    if (found.length) {
      line(OK + '权限配置 ' + found.length + ' 个文件（指纹监控生效）');
      for (const f of found) line('      ' + f);
    } else {
      line(WARN + '没找到权限配置文件 —— 权限指纹机制会静默失效（不影响使用）');
      line('      找过这些位置：');
      for (const f of pf) line('      ' + f);
    }
  }

  // 6) 目录可写
  try {
    const probe = path.join(ROOT, '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    line(OK + '工作目录可写');
  } catch (e) {
    line(BAD + '工作目录不可写：' + e.message);
    bad++;
  }

  line('');
  if (bad) {
    line('  自检发现 ' + bad + ' 个问题，先解决再 start。');
    process.exitCode = 1;
  } else {
    line('  自检通过，可以 start 了：  node bin/cli.js start');
  }
}

// ==================== start ====================

async function cmdStart() {
  const { config, error, hint, missing } = loadConfig(ROOT);
  if (missing) {
    title('邮箱助手');
    line(BAD + '还没有 config.json —— 先运行: node bin/cli.js init');
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
    title('邮箱助手');
    line(BAD + '配置还没填好：');
    for (const p of problems) {
      line('    · ' + p.field + '：' + p.msg);
      line('      → ' + p.fix);
    }
    line('');
    line('  （运行 node bin/cli.js doctor 看完整自检）');
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
    line(BAD + '依赖没装全，先运行: npm install');
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
    line(BAD + '初始化失败：' + (e && e.message ? e.message : e));
    process.exitCode = 1;
    return;
  }

  const { daemon, log, bin, transport } = app;

  title('邮箱助手');
  line('  邮箱      ' + maskEmail(config.email));
  line('  白名单    ' + config.allowFrom.map(maskEmail).join(', '));
  line('  轮询间隔  ' + config.pollSeconds + ' 秒');
  line('  会话      ' + (config.sessionId || '(每封独立)'));
  line('  DSH       ' + (bin || '【找不到！请在 config.json 里填 dshBin】'));
  line('  日志      ' + path.join(ROOT, 'mail-bridge.log'));
  line('');
  if (!bin) {
    line(BAD + '没有 DSH 就没法干活。填好 dshBin 再启动。');
    process.exitCode = 1;
    return;
  }
  line('  按 Ctrl+C 停止。这个窗口别关。');
  line('');

  process.on('SIGINT', () => {
    log('收到 Ctrl+C，准备退出');
    daemon.stop();
  });
  // 兜底：不让任何漏网的异常把进程整个干掉
  process.on('unhandledRejection', (e) => {
    log('未处理的 Promise 异常（已忽略，继续运行）：' + (e && e.message ? e.message : e));
  });
  process.on('uncaughtException', (e) => {
    log('未捕获的异常（已忽略，继续运行）：' + (e && e.stack ? e.stack : e));
  });

  await daemon.start({ bin, root: ROOT, transport });
}

// ==================== help ====================

function cmdHelp() {
  title('邮箱助手 v' + PKG.version + ' · 用法');
  line('  用一封邮件，遥控一台没有公网 IP 的电脑上的 DSH 干活。');
  line('');
  line('  命令：');
  line('    node bin/cli.js init      生成配置文件');
  line('    node bin/cli.js doctor    环境自检（不连邮箱、不跑任务）');
  line('    node bin/cli.js start     启动轮询');
  line('    node bin/cli.js help      这条说明');
  line('');
  line('  也可以：npm run init / npm run doctor / npm start / npm test');
  line('');
  line('  文档见 README.md');
}

// ==================== 分发 ====================

const cmd = (process.argv[2] || 'help').toLowerCase();

(async () => {
  try {
    if (cmd === 'init') cmdInit();
    else if (cmd === 'doctor') cmdDoctor();
    else if (cmd === 'start') await cmdStart();
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') cmdHelp();
    else if (cmd === '--version' || cmd === '-v') line(PKG.version);
    else {
      line('未知命令：' + cmd);
      cmdHelp();
      process.exitCode = 1;
    }
  } catch (e) {
    line('');
    line('出错了：' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
})();
