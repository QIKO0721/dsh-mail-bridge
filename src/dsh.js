'use strict';

/**
 * DSH 适配层：怎么把一封邮件变成一次 DSH 调用，再把结果取回来。
 *
 * 与 DSH 的全部耦合都集中在这一个文件里 —— 以后 DSH 的命令行接口变了，只改这里。
 *
 * 调用形式（DSH 的 headless 模式输出 JSONL 事件流）：
 *   dsh --profile headless --json [--session-id <id>]
 *   任务文本从 stdin 喂进去
 *
 * 任务为什么走 stdin 而不是命令行参数：
 *   Windows 命令行长度上限约 32767 字符，任务长一点就会 spawn 失败（E2BIG），
 *   而且报错信息完全看不出原因。走 stdin 就没有这个限制。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ==================== 事件流解析 ====================

/**
 * 事件类型（DSH --json 输出的 JSONL）：
 *   {"type":"session","sessionId":"session-xxx","cwd":"..."}
 *   {"type":"status","phase":"turn_start"|"step_start"|"turn_end",...}
 *   {"type":"thinking","text":"..."}
 *   {"type":"tool_call","tool":"pwsh","input":{...}}
 *   {"type":"tool_result","status":"completed","result":"..."}
 *   {"type":"text","text":"..."}      流式增量文本
 *   {"type":"final","text":"..."}     最终答复
 */

/**
 * 这段文本像不像"操作系统层面的权限拒绝"？
 *
 * 为什么要单独识别：实测发现权限被拒时 DSH **不会**发出任何权限事件 ——
 * 内层 agent 自己 try/catch 掉了，最后只回一句"失败"。
 * 所以绝不能靠最终答复的文字判断（那是模型的措辞，靠不住），
 * 只能去看 tool_result 里操作系统抛出来的原始报错。
 *
 * 原则：**宁可漏判，不可误判**。误判会把正常任务当成权限问题、白清一次会话记忆。
 * 所以只在同时出现"访问被拒的措辞"和一个错误码时才认。
 */
function looksLikePermissionDenied(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (/ERROR_ACCESS_DENIED|0x80070005/i.test(s)) return true;
  if (/access to the path/i.test(s) && /is denied/i.test(s)) return true;
  if (/EACCES|EPERM/.test(s) && /(denied|permission)/i.test(s)) return true;
  if (/拒绝访问|访问被拒绝/.test(s) && /(0x[0-9a-f]{8}|错误|error)/i.test(s)) return true;
  return false;
}

/**
 * 从 stderr / 事件里认"会话不存在"。
 *
 * ⚠️ 措辞必须按真实 DSH 的原话来认。实测（v0.2.0-rc.2）它说的是：
 *     dsh: session "xxx" does not exist; omit --session-id to start a new Session
 *   早期版本只认 unknown id / no such session / session...not found，
 *   结果这条【does not exist】根本匹配不上 —— 于是会话失效的自动降级不会触发，
 *   用户只会收到一封错误信。真实踩过。
 *
 * 注意别写太宽：`session[^\n]*not\s+found` 配不上 "session ... does not exist"，
 * 所以必须显式覆盖 does not exist / doesn't exist。
 */
function looksLikeUnknownSession(text) {
  const s = String(text || '');
  return /unknown\s+id/i.test(s) ||
         /no\s+such\s+session/i.test(s) ||
         /session[^\n]*not\s+found/i.test(s) ||
         /session[^\n]*does\s*n[o']?t?\s*exist/i.test(s) ||
         /会话[^\n]*不存在/.test(s);
}

/**
 * 创建一个逐行喂入的解析器。
 * 返回的对象会累积状态，processLine() 每行调一次，最后读 result()。
 */
function createEventParser() {
  const state = {
    sessionId: null,
    finalText: null,
    lastText: null,
    permissionDenied: false,
    sawSessionEvent: false
  };

  function processLine(line) {
    const s = String(line || '').trim();
    if (!s || s[0] !== '{') return;
    let ev;
    try { ev = JSON.parse(s); } catch (e) { return; }

    switch (ev.type) {
      case 'session':
        if (ev.sessionId) { state.sessionId = ev.sessionId; state.sawSessionEvent = true; }
        break;
      case 'final':
        if (typeof ev.text === 'string') state.finalText = ev.text;
        break;
      case 'text':
        if (typeof ev.text === 'string') state.lastText = ev.text;
        break;
      case 'tool_result':
      case 'error':
      case 'tool_error':
        // ★ 只看工具执行结果，不看模型自己写的文字
        if (!state.permissionDenied && looksLikePermissionDenied(JSON.stringify(ev))) {
          state.permissionDenied = true;
        }
        break;
      default:
        break;
    }
  }

  function feed(chunk) {
    // 返回还没凑成整行的残留
    const lines = String(chunk).split('\n');
    return lines;
  }

  return { processLine, state };
}

/**
 * 把一段完整的 JSONL 文本解析成结果对象。测试和简单场景直接用这个。
 * @returns {{sessionId, text, permissionDenied, sawSessionEvent}}
 */
function parseJsonl(raw) {
  const p = createEventParser();
  for (const line of String(raw || '').split('\n')) p.processLine(line);
  const st = p.state;
  return {
    sessionId: st.sessionId,
    text: (st.finalText || st.lastText || '').trim(),
    permissionDenied: st.permissionDenied,
    sawSessionEvent: st.sawSessionEvent
  };
}

// ==================== 权限配置指纹 ====================

/**
 * 为什么需要：DSH 的权限预设**只在创建会话时读一次**，之后改配置绝不影响已有会话。
 * 而本程序为了记住上下文会一直复用同一个 session-id ——
 * 于是"改完权限 → 重启 → 毫无变化"，会话永远钉在旧权限上。
 *
 * 解法：把权限配置的指纹记下来，指纹变了就换个新会话。
 *
 * 指纹 = sha256(各文件内容 + 各文件的 mtime)
 *
 * ⚠️ 这里**故意只看文件自己和它自己的 mtime，不看任何目录的 mtime**。
 *    原因是真实踩过的坑：只要把目录 mtime 算进来，
 *    任何"往同一个目录里写文件"的动作都会改掉它 ——
 *    包括本程序自己写会话状态文件，以及编辑器保存备份文件。
 *    结果就是指纹自己变、每次启动都误判"权限配置改了"、白白清空一次会话记忆。
 *    只看文件自身已经足够：内容变了会变，文件被替换 mtime 也必然变。
 */
function permissionFingerprint(files) {
  const parts = [];
  for (const f of (files || [])) {
    let content = '';
    try {
      content = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
      parts.push('file:' + path.basename(f) + ':' + content);
    } catch (e) {
      parts.push('file:' + path.basename(f) + ':MISSING');
    }
    try {
      parts.push('mtime:' + path.basename(f) + ':' + fs.statSync(f).mtimeMs);
    } catch (e) { /* ignore */ }
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * 算出这台机器上 DSH 的权限配置文件在哪。
 * 只做"猜"，猜不到就返回空数组（那指纹机制静默失效，不影响主流程）。
 */
function guessPermissionFiles(opts) {
  const home = (opts && opts.dshHome) ||
    process.env.DSH_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const profile = (opts && opts.dshProfile) || 'headless';
  const dir = path.join(home, 'profiles', profile);
  return [
    path.join(dir, 'cordis.patch.yml'),
    path.join(dir, 'cordis.yml')
  ];
}

// ==================== 会话状态 ====================

/**
 * 会话状态持久化：sessionId + 当时的权限指纹。
 * 状态文件放在项目根目录（已被 .gitignore 排除）。
 */
function createSessionStore(file) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) { return {}; }
  }
  function write(obj) {
    try { fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  }
  return {
    file,
    get: read,
    // ★ 是合并写入，不是覆盖：状态文件里既有 permissionHash 又有 sessionId，
    //   直接赋值会把另一项抹掉（真实踩过）。
    set: (patch) => write(Object.assign(read(), patch)),
    /**
     * 权限配置变过就报告需要轮换。
     *
     * 注意：**检测到变化时也立刻把新指纹写回去**。
     * 不写的话，状态文件里永远留着旧指纹 ——
     * 调用方紧接着 saveSessionId('') 或 set() 时，会把旧指纹一起带回来，
     * 于是下次启动又判定"变了"，反复白清会话。（真实踩过）
     *
     * @returns {{rotate: boolean, from?: string, to: string, firstRun: boolean}}
     */
    checkPermissionFingerprint(fingerprint) {
      const st = read();
      const prev = st.permissionHash;
      // 无论哪种情况都把当前指纹写回去（见上面注释：不写会反复误判）
      write(Object.assign({}, st, { permissionHash: fingerprint }));

      if (!prev) return { rotate: false, to: fingerprint, firstRun: true };
      if (prev !== fingerprint) {
        return { rotate: true, from: prev, to: fingerprint, firstRun: false };
      }
      return { rotate: false, to: fingerprint, firstRun: false };
    }
  };
}

// ==================== 查找 DSH ====================

/**
 * 在 PATH 里找一个可执行文件。
 *
 * 为什么必须做这件事：`npm install -g @deepseek-ai/dsh` 之后，
 * 用户手上有一个叫 `dsh` 的命令（包里的 bin 映射），而不是一个 .js 路径。
 * 只按"文件路径"去找的话，会漏掉这种最常见的安装方式。
 *
 * ⚠️ Windows 上 PATHEXT 通常写成大写（.COM;.EXE;.BAT;.CMD），
 *    但实际文件常是小写（dsh.cmd）。拼出来的 `dsh.CMD` 在 Windows 上能打开，
 *    可返回给调用方的路径必须**真的是磁盘上那个文件** ——
 *    否则 spawn 的某些路径、以及字符串比较都会出问题。
 *    所以拼不到时列一次目录，按大小写不敏感找回真实文件名。
 */
function findOnPath(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    // ★ 先列目录、按真实文件名找。
    //   不能先做 fs.existsSync('dsh.CMD') —— Windows 的文件系统大小写不敏感，
    //   那一句会直接成功，返回的却是磁盘上并不存在的拼写（dsh.CMD vs dsh.cmd）。
    let entries = null;
    try { entries = fs.readdirSync(dir); } catch (e) { entries = null; }

    for (const ext of exts) {
      const want = (name + ext).toLowerCase();

      // 1) 从目录里按真实拼写找
      if (entries) {
        const hit = entries.find(f => f.toLowerCase() === want);
        if (hit) {
          try {
            const full = path.join(dir, hit);
            if (fs.statSync(full).isFile()) return full;
          } catch (e) { /* ignore */ }
        }
      } else {
        // 2) 目录读不到（权限等）才退回直接拼——此时只能接受拼写可能与实际不同
        try {
          const full = path.join(dir, name + ext);
          if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
        } catch (e) { /* ignore */ }
      }
    }
  }
  return '';
}

/**
 * 把一个 PATH 上的包装脚本（.cmd / .sh / 无扩展名）解析成它背后真正的 JS 入口。
 *
 * 为什么要多这一步：走 shell 跑 .cmd 能work，但 Node 会发 DEP0190 警告
 * （参数不转义、只做字符串拼接）。虽然本项目的命令行参数全部来自用户自己的
 * config、邮件正文走 stdin 不经过命令行，风险很低，但**能不走 shell 就别走**：
 * 既不触发警告，也不给"参数转义"留任何想象空间。
 *
 * 做法是不去解析包装脚本的内容（太脆），而是借 Node 自身的模块解析：
 * 包装脚本住在 .../node_modules/.bin/ 下，从这里能按包名解析到真正的入口。
 *
 * @returns {string} 真实 JS 入口路径，解析不出来就返回空串
 */
function resolveRealEntry(shimPath) {
  try {
    const shimDir = path.dirname(shimPath);              // .../node_modules/.bin
    const js = require.resolve('@deepseek-ai/dsh/lib/bin.js', { paths: [shimDir] });
    if (js && fs.existsSync(js)) return js;
  } catch (e) { /* 解析不出来很正常，交给调用方用包装脚本 */ }
  return '';
}

/**
 * 自动找 DSH 的命令行入口。
 *
 * 顺序：
 *   1) 配置里明确指定的 dshBin
 *   2) 环境变量 DSH_BIN
 *   3) 常见安装位置里真正的 lib/bin.js（最干净：不经 shell、不触发 DEP0190）
 *   4) PATH 上的 `dsh` 命令（npm i -g 之后就是这样），
 *      并尽量把它背后的 bin.js 解析出来
 *
 * 找不到就返回空串，由调用方明确报错 ——
 * 与其猜错位置跑一个不对的东西，不如老实说"没找到"。
 */
function findDshBin(opts) {
  const o = opts || {};
  if (o.dshBin && fs.existsSync(o.dshBin)) return o.dshBin;
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;

  const candidates = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';
  // 允许覆盖，方便测试隔离（不然测试机上真装着 DSH 就永远测不到"找不到"这条分支）
  const localAppData = process.env.LOCALAPPDATA || path.join(home, '.npm');

  // npx 缓存里的 DSH（用 npx 跑过就会有）
  try {
    const npxCache = path.join(localAppData, 'npm-cache', '_npx');
    if (fs.existsSync(npxCache)) {
      for (const d of fs.readdirSync(npxCache)) {
        candidates.push(path.join(npxCache, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
      }
    }
  } catch (e) { /* ignore */ }

  // 全局安装位置（覆盖 npm / pnpm / yarn / Homebrew / 系统包管理器）
  const globalRoots = [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(localAppData, 'pnpm', 'global', '5', 'node_modules'),
    path.join(localAppData, 'Yarn', 'Data', 'global', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules'
  ];
  for (const root of globalRoots) {
    candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }

  // 先挑真正的 bin.js —— 它不需要 shell，是最干净的跑法
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }

  // 再退到 PATH 上的命令（npm i -g 的典型产物）
  const onPath = findOnPath('dsh');
  if (onPath) {
    const real = resolveRealEntry(onPath);
    return real || onPath;
  }

  return '';
}

// ==================== 跑一次 ====================

/**
 * 跑一次 DSH。
 *
 * @param {object} opts
 * @param {string} opts.bin            DSH 入口（bin.js 或可执行文件）
 * @param {string} opts.task           任务文本
 * @param {string} [opts.sessionId]    要接续的会话
 * @param {string} [opts.profile]      DSH profile 名
 * @param {number} [opts.timeoutMs]    超时毫秒
 * @param {string} [opts.cwd]          工作目录
 * @param {Function} [opts.spawnFn]    注入的 spawn（测试用）
 * @param {Function} [opts.onEvent]    每解析出一个事件回调一次（可选）
 * @returns {Promise<{ok, text, sessionId, permissionDenied, unknownSession, timedOut, exitCode}>}
 */
function runDshOnce(opts) {
  const spawnFn = opts.spawnFn || spawn;
  // ⚠️ 别用 `opts.timeoutMs || 600000` —— 那样传进来的 0 会被当成"没传"，
  //    静默变成 10 分钟。调用方想表达"立刻超时"或"不要超时"时，
  //    得到的结果和预期完全相反，而且没有任何提示。
  //    这里只在"不是有效正数"时才用默认值。
  const asked = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? asked : 600000;

  // ★ 入口不存在就别启动了。
  //   不加这一手的话，.js 入口会交给 node 去跑，node 报 MODULE_NOT_FOUND 之后
  //   进程有时并不干脆退出，于是调用方会一直等到超时 ——
  //   用户看到的是"任务超时"，而真正的原因是"压根没找到 DSH"，排查方向全错。
  try {
    if (!opts.bin || !fs.existsSync(opts.bin)) {
      return Promise.resolve({
        ok: false,
        text: '找不到 DSH 入口：' + (opts.bin || '(空)') +
              '\n\n请在 config.json 里把 dshBin 填成 DSH 命令行入口的完整路径' +
              '（一般叫 lib/bin.js），或者先运行  node bin/cli.js doctor  看自检结果。',
        sessionId: null,
        permissionDenied: false,
        unknownSession: false,
        timedOut: false,
        binMissing: true
      });
    }
  } catch (e) { /* statSync 出错就继续走正常流程 */ }

  return new Promise((resolve) => {
    const args = ['--profile', opts.profile || 'headless', '--json'];
    if (opts.sessionId) args.push('--session-id', opts.sessionId);

    // 四种情形：
    //   .js 路径              → 用当前 node 跑它（直接指 lib/bin.js 就是这样）
    //   .cmd / .bat（Windows） → ★ 必须走 shell
    //   .exe / 无扩展名的可执行 → 直接跑
    //   光秃秃一个命令名        → 交给 shell 解析
    //
    // ⚠️ .cmd/.bat 那条是真实踩过的坑：Node（v20+ 起为防注入）**拒绝**在没有
    //    shell 的情况下 spawn 批处理文件，直接抛 `spawn EINVAL`。
    //    而 `npm install -g` 在 Windows 上给出的 dsh 正是 dsh.cmd ——
    //    也就是说"支持 PATH 查找"这件事，不一起处理它反而会让程序跑不起来。
    let isFile = false;
    try { isFile = fs.statSync(opts.bin).isFile(); } catch (e) { isFile = false; }

    const isJs = /\.(js|cjs|mjs)$/i.test(opts.bin);
    const isBatch = /\.(cmd|bat)$/i.test(opts.bin);
    const cmd = isJs ? process.execPath : opts.bin;
    const argv = isJs ? [opts.bin, ...args] : args;
    const useShell = isBatch || (!isFile && !isJs);

    let done = false;
    let stderr = '';
    let buf = '';
    const parser = createEventParser();

    let child;
    try {
      child = spawnFn(cmd, argv, {
        cwd: opts.cwd || process.cwd(),
        windowsHide: true,
        shell: useShell,
        env: Object.assign({}, process.env, { NO_COLOR: '1' })
      });
    } catch (e) {
      return resolve({
        ok: false, text: '无法启动 DSH：' + e.message,
        sessionId: null, permissionDenied: false, unknownSession: false, timedOut: false
      });
    }

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) { /* ignore */ }
      resolve({
        ok: false,
        text: '任务超时（' + Math.round(timeoutMs / 1000) + ' 秒），已中止子进程',
        sessionId: parser.state.sessionId,
        permissionDenied: parser.state.permissionDenied,
        unknownSession: false,
        timedOut: true
      });
    }, timeoutMs);

    // ★ 任务文本走 stdin，绕开命令行长度上限
    try {
      child.stdin.write(opts.task, 'utf8');
      child.stdin.end();
    } catch (e) { /* 有些 mock 进程没有 stdin，忽略 */ }

    if (child.stdout && child.stdout.on) {
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          parser.processLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
    }
    if (child.stderr && child.stderr.on) {
      child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    }

    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        text: '启动 DSH 失败：' + e.message +
              '\n\n提示：确认 dshBin 指向的是 DSH 的命令行入口（lib/bin.js），或者把 dsh 装好。',
        sessionId: parser.state.sessionId,
        permissionDenied: false,
        unknownSession: false,
        timedOut: false
      });
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (buf.trim()) parser.processLine(buf);

      const st = parser.state;
      const text = (st.finalText || st.lastText || '').trim();
      const base = {
        sessionId: st.sessionId,
        permissionDenied: st.permissionDenied,
        unknownSession: looksLikeUnknownSession(stderr),
        timedOut: false,
        exitCode: code
      };

      if (text) return resolve(Object.assign({ ok: true, text }, base));
      return resolve(Object.assign({
        ok: false,
        text: 'DSH 退出码 ' + code + (stderr ? '\n\n' + stderr.slice(-1500) : '（没有任何输出）')
      }, base));
    });
  });
}

module.exports = {
  createEventParser,
  parseJsonl,
  looksLikePermissionDenied,
  looksLikeUnknownSession,
  permissionFingerprint,
  guessPermissionFiles,
  createSessionStore,
  findDshBin,
  findOnPath,
  runDshOnce
};
