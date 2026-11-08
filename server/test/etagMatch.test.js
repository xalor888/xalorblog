/**
 * ETag 弱比较（零 DB、零服务）。
 *
 * 这是一条「错了也不报错、只是悄悄变慢」的规则：
 * 严格相等时，凡是经过 nginx/CDN 转发的 `If-None-Match`（会把强 ETag 改写成 `W/"..."`）
 * 全部不命中，订阅器每次轮询都重建整页 —— 查库 + 拼 RSS + 拼 sitemap，
 * 开销全白付，而日志里看不到任何异常。
 *
 * RFC 9110 §13.1.2：If-None-Match 使用**弱比较**，`W/"x"` 与 `"x"` 视为匹配。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { etagMatches, weakCompare } = require('../src/utils/etag');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ETAG = '"abc123"';

console.log('=== A. 强比较基线 ===');
ok('完全相同的强 ETag 命中', etagMatches(ETAG, ETAG) === true);
ok('不同的 ETag 不命中', etagMatches('"other"', ETAG) === false);

console.log('\n=== B. 弱比较（核心） ===');
ok('W/"abc123" 命中 "abc123"（代理改写后的形态）',
  etagMatches('W/"abc123"', ETAG) === true);
ok('小写 w/ 也命中（大小写不敏感）',
  etagMatches('w/"abc123"', ETAG) === true);
ok('服务端发弱、客户端回强也算命中（对称）',
  etagMatches('"abc123"', 'W/"abc123"') === true);
ok('weakCompare 忽略 W/ 前缀',
  weakCompare('W/"x"', '"x"') === true && weakCompare('"x"', '"y"') === false);

console.log('\n=== C. 多值与通配 ===');
ok('逗号分隔的多值中任一项命中即可',
  etagMatches('"old", "abc123"', ETAG) === true);
ok('多值里有 W/ 前缀的项也参与比较',
  etagMatches('"old", W/"abc123"', ETAG) === true);
ok('多值全不命中时不命中',
  etagMatches('"a", "b"', ETAG) === false);
ok('`*` 永远命中（RFC：任意当前表示都算）', etagMatches('*', ETAG) === true);
ok('`*` 周围的空白不影响', etagMatches('  *  ', ETAG) === true);

console.log('\n=== D. 不能用 includes 偷懒 ===');
ok('"abc" 不应被 "abcdef" 命中（子串陷阱）',
  etagMatches('"abcdef"', '"abc"') === false);
ok('反过来也不命中', etagMatches('"abc"', '"abcdef"') === false);

console.log('\n=== E. 脏输入 ===');
ok('空头不命中', etagMatches('', ETAG) === false);
ok('undefined 头不命中', etagMatches(undefined, ETAG) === false);
ok('缺少服务端 etag 时不命中', etagMatches(ETAG, '') === false);
ok('纯空白头不命中', etagMatches('   ', ETAG) === false);
ok('多余逗号不抛错', etagMatches('"a",,,"abc123"', ETAG) === true);

console.log('\n=== F. 源码契约：两个条件发送点都改用它 ===');
{
  const fs = require('fs');
  const path = require('path');
  for (const f of ['feed.js', 'share.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', f), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    ok(`${f} 用 etagMatches 而不是严格相等`,
      /etagMatches\(req\.headers\['if-none-match'\], etag\)/.test(code));
    ok(`${f} 不再有 if-none-match 的 === 比较`,
      !/if-none-match'\]\s*===/.test(code));
  }
}

console.log(`\netagMatch 套件结果: ${pass} 通过, ${fail} 失败`);
if (fail) process.exit(1);
