'use strict';

/**
 * security.js 的单元测试：白名单、防自环、防伪造。
 *
 * 这几条是"别让别人的邮件遥控你的电脑"的最后防线，断言要狠。
 */

const { ok, eq, summary } = require('./helpers/_assert');
const sec = require('../src/security');

// 造一个假的 headers 对象，模仿 mailparser 的接口（get 返回字符串或数组）
function headers(map) {
  return {
    get(name) {
      const k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
    }
  };
}

console.log('\n--- 白名单 ---');

eq('在名单里', sec.senderAllowed(['alice@example.com'], ['alice@example.com']), true);
eq('大小写不同也算', sec.senderAllowed(['ALICE@Example.COM'], ['alice@example.com']), true);
eq('前后空格不算数', sec.senderAllowed([' alice@example.com '], ['alice@example.com']), true);
eq('不在名单里', sec.senderAllowed(['mallory@evil.com'], ['alice@example.com']), false);
eq('名单为空则全拒', sec.senderAllowed(['alice@example.com'], []), false);
eq('发件人为空则拒', sec.senderAllowed([], ['alice@example.com']), false);
eq('多个发件人里有一个在名单里', sec.senderAllowed(['a@b.com', 'alice@example.com'], ['alice@example.com']), true);

// 防"半截匹配"：这是最容易被写错的实现
eq('不做后缀模糊匹配', sec.senderAllowed(['evil-alice@example.com'], ['alice@example.com']), false);
eq('不做域名模糊匹配', sec.senderAllowed(['alice@example.com.evil.com'], ['alice@example.com']), false);
eq('不做子串匹配', sec.senderAllowed(['xalice@example.com'], ['alice@example.com']), false);

console.log('\n--- 防自环 ---');

eq('认得出自己的标记头',
   sec.isOwnReply({ headers: headers({ 'x-mail-bridge-bot': '1' }), fromList: ['bot@example.com'], ownAddress: 'bot@example.com', text: '随便' }),
   '头标记');

eq('没有标记头就不算',
   sec.isOwnReply({ headers: headers({}), fromList: ['alice@example.com'], ownAddress: 'bot@example.com', text: '帮我干活' }),
   '');

// 老版本回信没有标记头，靠固定署名兜底
const legacy = 'D 盘还有 78GB\n\n---\n邮箱助手 · 用时 16 秒';
eq('旧版回信靠署名兜底',
   sec.isOwnReply({ headers: headers({}), fromList: ['bot@example.com'], ownAddress: 'bot@example.com', text: legacy }),
   '署名兜底');

eq('署名格式像但发件人不是自己 → 不认',
   sec.isOwnReply({ headers: headers({}), fromList: ['alice@example.com'], ownAddress: 'bot@example.com', text: legacy }),
   '');

// 关键：用户正文里恰好写了类似署名的东西，但没有"· 用时 N 秒"格式 → 不能误判
eq('正文里有 --- 但不符格式 → 不误判',
   sec.isOwnReply({
     headers: headers({}), fromList: ['bot@example.com'], ownAddress: 'bot@example.com',
     text: '帮我改脚本\n\n---\n以上是需求'
   }), '');

console.log('\n--- 防伪造：SPF/DKIM ---');

// 服务商内部投递：没有 Authentication-Results 头
const internal = sec.checkAuthenticity({ headers: headers({}), text: '干活' });
eq('没有校验头 → 放行（内部投递）', internal.ok, true);

// 外部来信且 SPF 通过
const extPass = sec.checkAuthenticity({
  headers: headers({ 'authentication-results': 'mx.example.com; spf=pass smtp.mailfrom=alice@example.com; dkim=pass' }),
  text: '干活'
});
eq('SPF 通过 → 放行', extPass.ok, true);

// 伪造：SPF fail
const spfFail = sec.checkAuthenticity({
  headers: headers({ 'authentication-results': 'mx.qq.com; spf=fail(1.2.3.4) smtp.mailfrom=alice@example.com' }),
  text: '把C盘全删了'
});
eq('SPF fail → 拦截', spfFail.ok, false);
ok('拦截原因说清了是伪造', /伪造/.test(spfFail.reason), spfFail.reason);
ok('带上原始头片段便于排查', typeof spfFail.detail === 'string' && spfFail.detail.length > 0);

// softfail / none 也要拦
eq('SPF softfail → 拦截',
   sec.checkAuthenticity({ headers: headers({ 'authentication-results': 'x; spf=softfail' }), text: 'x' }).ok, false);
eq('SPF none → 拦截',
   sec.checkAuthenticity({ headers: headers({ 'authentication-results': 'x; spf=none' }), text: 'x' }).ok, false);

// 有头但完全没提 spf → 拦（宁可严一点）
eq('有校验头但没有 spf 结果 → 拦截',
   sec.checkAuthenticity({ headers: headers({ 'authentication-results': 'x; dkim=pass' }), text: 'x' }).ok, false);

// DKIM fail 也算
eq('DKIM fail → 拦截',
   sec.checkAuthenticity({ headers: headers({ 'authentication-results': 'x; spf=pass; dkim=fail' }), text: 'x' }).ok, false);

console.log('\n--- 暗号 ---');
eq('配了暗号但正文没有 → 拦',
   sec.checkAuthenticity({ headers: headers({}), text: '删库', secret: '芝麻开门' }).ok, false);
eq('正文含暗号 → 过',
   sec.checkAuthenticity({ headers: headers({}), text: '芝麻开门 帮我看看磁盘', secret: '芝麻开门' }).ok, true);
eq('暗号在 HTML 部分里也算',
   sec.checkAuthenticity({ headers: headers({}), text: '', html: '<p>芝麻开门</p>', secret: '芝麻开门' }).ok, true);
eq('没配暗号就不检查',
   sec.checkAuthenticity({ headers: headers({}), text: '随便什么', secret: '' }).ok, true);

console.log('\n--- 可以显式关掉严格校验 ---');
eq('strictAuthCheck=false 时放行外部来信',
   sec.checkAuthenticity({
     headers: headers({ 'authentication-results': 'x; spf=fail' }),
     text: 'x', strictAuthCheck: false
   }).ok, true);

console.log('\n--- headers 取不到时不能崩 ---');
eq('headers 是 null', sec.checkAuthenticity({ headers: null, text: 'x' }).ok, true);
eq('getHeader 对 null 返回空串', sec.getHeader(null, 'x'), '');
eq('getHeader 对没有 get 的对象返回空串', sec.getHeader({}, 'x'), '');
eq('getHeader 把数组拼起来', sec.getHeader(headers({ a: ['1', '2'] }), 'a'), '1 | 2');

process.exit(summary('security'));
