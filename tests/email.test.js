'use strict';

/**
 * email.js 的单元测试：引文清洗、签名剥离、指令判定、HTML 兜底。
 *
 * 这里每一条都对应一个真实踩过的坑，所以断言写得比较细。
 */

const { ok, eq, summary } = require('./helpers/_assert');
const email = require('../src/email');

const SENDER = 'alice@example.com';

console.log('\n--- 引文清洗：各家客户端的引用格式 ---');

const gmail = '帮我看看磁盘\n\nOn Mon, Jan 1, 2026 at 9:00 AM Bot <bot@example.com> wrote:\n> 之前的对话';
ok('Gmail 的 On ... wrote: 被截断', !email.stripQuoted(gmail).includes('之前的对话'), email.stripQuoted(gmail));

const netease = '重启一下\n\n---- 原始邮件 ----\n发件人: bot\n之前说的都不算';
ok('网易的 ---- 原始邮件 ---- 被截断', !email.stripQuoted(netease).includes('之前说的都不算'));

const cn = '帮我算个数\n\n在 2026年1月1日 09:00，Bot<bot@example.com> 写道：\n> 旧内容';
ok('中文客户端的 在...写道： 被截断', !email.stripQuoted(cn).includes('旧内容'));

const outlook = '看看日志\n\n-----Original Message-----\nFrom: bot@example.com\n旧内容';
ok('Outlook 的 Original Message 被截断', !email.stripQuoted(outlook).includes('旧内容'));

const quoted = '新指令\n\n> 这是引用\n> 还有一行\n正常行';
const q = email.stripQuoted(quoted);
ok('逐行 > 引用被去掉', !q.includes('这是引用'), q);
ok('非引用行保留', q.includes('正常行'), q);

const underline = '干活吧\n\n________\n历史记录';
ok('下划线分隔被截断', !email.stripQuoted(underline).includes('历史记录'));

console.log('\n--- 签名剥离（这是真实踩过的坑）---');

// 最常见的坑：邮件 App 自动加"名字 + 邮箱"两行
const withSig = '新对话\n\nAlice\nAlice@Example.com';
eq('剥掉「名字+邮箱」签名', email.stripSignature(withSig, { from: SENDER }), '新对话');

const sigUpper = '新会话\n\nSOMEONE\nsomeone@example.com';
eq('签名大小写不同也能剥', email.stripSignature(sigUpper, { from: SENDER }), '新会话');

const onlyAddr = '新对话\n\nsomeone@example.com';
eq('只有邮箱一行也能剥', email.stripSignature(onlyAddr, { from: SENDER }), '新对话');

const rfc = '干活\n\n-- \nAlice\n签名档内容';
eq('RFC 3676 的 "-- " 分隔符之后全砍', email.stripSignature(rfc, { from: SENDER }), '干活');

// 不该误伤：正文本身有多行，但结尾不是签名
const realText = '帮我改一下这个脚本\n第二行说明\n第三行说明';
eq('正常多行正文不被误剥', email.stripSignature(realText, { from: SENDER }), realText);

const longLast = '帮我看看这段代码有没有问题，最后一行是结论请参考上面的分析结果。\nAlice\nsomeone@example.com';
ok('签名上一行像正文时不剥（宁可漏剥）',
   email.stripSignature(longLast, { from: SENDER }).includes('结论请参考'), 
   email.stripSignature(longLast, { from: SENDER }));

console.log('\n--- 开新会话指令判定 ---');

const newCase = (body, want) => {
  const hit = !!email.matchNewSession(body, { from: SENDER });
  ok((want ? '认' : '不认').padEnd(4) + ' | ' + JSON.stringify(body).slice(0, 60),
     hit === want, { 期望: want, 实际: hit });
};

// 应该认
newCase('新会话', true);
newCase('新对话', true);
newCase('new', true);
newCase('NEW', true);
newCase('reset', true);
newCase('/new', true);
newCase('新 会 话', true);
newCase('新会话。', true);
newCase('那开启一轮新对话', true);
newCase('现在开了新对话', true);
newCase('开启新会话', true);
newCase('帮我开个新对话', true);
newCase('重新开始一个新会话', true);
newCase('来一轮新对话', true);
newCase('新一轮对话', true);
newCase('重置会话', true);
newCase('清空对话', true);

console.log('');
console.log('  --- 带自动签名的真实场景 ---');
newCase('新对话\n\nAlice\nAlice@Example.com', true);
newCase('新会话\n\nsomeone@example.com', true);

console.log('');
console.log('  --- 以下不该认（在派活，不是重置）---');
newCase('新对话，帮我看看D盘还有多少空间', false);
newCase('现在开了新对话，往 C:\\tmp\\x.txt 写一行字，告诉我成不成', false);
newCase('新对话\n\nAlice\nAlice@Example.com\n帮我看看磁盘', false);
newCase('把新会话里的内容总结一下发给我', false);
newCase('新会话是什么意思', false);
newCase('清空对话里的那个临时文件', false);
newCase('帮我看看D盘', false);
newCase('', false);
newCase('帮助', false);
newCase('这是一段很长很长很长很长很长很长很长很长很长很长很长很长的正文，明显不是指令', false);

console.log('\n--- 帮助指令判定 ---');
eq('帮助', !!email.matchHelp('帮助', {}), true);
eq('help', !!email.matchHelp('help', {}), true);
eq('HELP', !!email.matchHelp('HELP', {}), true);
eq('/help', !!email.matchHelp('/help', {}), true);
eq('帮助我一下', !!email.matchHelp('帮助我一下', {}), false);
eq('带签名的帮助', !!email.matchHelp('帮助\n\nsomeone@example.com', { from: SENDER }), true);

console.log('\n--- HTML 兜底 ---');
const html = '<html><body><p>第一段</p><p>第二段</p><br><b>粗体</b>&nbsp;&amp;&lt;</body></html>';
const text = email.htmlToText(html);
ok('HTML 能转出文本', text.includes('第一段') && text.includes('第二段'), text);
ok('HTML 实体被解码', text.includes('&') && text.includes('<'), text);
ok('标签被清掉', !text.includes('<p>'), text);

console.log('\n--- cleanBody 全流程 ---');
const full = [
  '  帮我重启一下服务  ',
  '',
  'On Mon, Jan 1, 2026 Alice wrote:',
  '> 旧对话',
  '',
  'Alice',
  'alice@example.com'
].join('\r\n');
eq('CRLF + 引文 + 签名 全清干净', email.cleanBody(full, '', { from: SENDER }), '帮我重启一下服务');

eq('只有 HTML 时也能出文本',
   email.cleanBody('', '<p>从 HTML 来的指令</p>', { from: SENDER }), '从 HTML 来的指令');

eq('空输入返回空串', email.cleanBody('', '', {}), '');

console.log('\n--- stripSignatures 开关（它曾经是个死配置，没有任何代码读它）---');
const withTail = '帮我查一下\n\nAlice\nalice@example.com';
eq('默认：剥掉签名', email.cleanBody(withTail, '', { from: SENDER }), '帮我查一下');
eq('显式 true：剥掉签名', email.cleanBody(withTail, '', { from: SENDER, stripSignatures: true }), '帮我查一下');
eq('显式 false：保留签名',
   email.cleanBody(withTail, '', { from: SENDER, stripSignatures: false }), withTail);

// 关键：指令判定必须跟清洗用同一套规则，否则会出现"任务没剥、判定剥了"的不一致
const cmdWithSig = '新会话\n\nAlice\nalice@example.com';
ok('默认：带签名的「新会话」能认出来', !!email.matchNewSession(cmdWithSig, { from: SENDER }));
ok('stripSignatures=false 时判定保持一致',
   !!email.matchNewSession('新会话', { from: SENDER, stripSignatures: false }));
eq('帮助判定也尊重这个开关',
   email.matchHelp(withTail, { from: SENDER, stripSignatures: false }), false);

console.log('\n--- fromName 有默认值吗（它曾经是"代码读了但配置里没有"的影子配置）---');
{
  const { defaultConfig } = require('../src/config');
  const d = defaultConfig();
  ok('默认配置里有 fromName', Object.prototype.hasOwnProperty.call(d, 'fromName'), d.fromName);
  ok('默认值非空（否则回信署名会空一块）', String(d.fromName || '').length > 0, d.fromName);
  ok('默认值是 ASCII（不把中文硬塞给国外用户）', /^[\x20-\x7e]+$/.test(String(d.fromName)), d.fromName);
  ok('默认配置里有 stripSignatures', Object.prototype.hasOwnProperty.call(d, 'stripSignatures'));
}

process.exit(summary('email'));
