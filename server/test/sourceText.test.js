/**
 * `test/helpers/sourceText` 自身的行为（零依赖）。
 *
 * 工具本身不可信时，所有依赖它的测试一起失真 —— 所以这里把它的判据钉住，
 * 尤其是那个「CSS 通用选择器 `* {` 被当成块注释删掉」的坑（web 侧修过一次，
 * server 侧手写过滤里也有同一个 bug 面）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const { stripCommentLines, withCode, selfTest } = require('./helpers/sourceText');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try { fn(); passCount++; console.log(`  ✓ ${name}`); }
  catch (e) { failCount++; console.log(`  ✗ ${name} — ${e.message}`); }
}

console.log('=== A. 工具内建自检全绿 ===');
{
  const cases = selfTest();
  check(`自检共 ${cases.length} 条且全部通过`, () => {
    const bad = cases.filter((c) => !c.pass);
    assert.deepStrictEqual(bad, [], bad.map((b) => b.name).join(', '));
  });
}

console.log('\n=== B. 三种注释都被剥掉，代码保留 ===');
check('整行 // 注释', () => {
  assert.ok(!stripCommentLines('// a').includes('a'));
  assert.ok(stripCommentLines('const a = 1; // 行尾').includes('const a = 1;'));
});
check('块注释（含多行）', () => {
  const out = stripCommentLines('/* one\ntwo\nthree */\nconst keep = 1;');
  assert.ok(!out.includes('two'));
  assert.ok(out.includes('const keep = 1;'));
});
check('单行块注释', () => {
  assert.ok(!stripCommentLines('/* gone */').includes('gone'));
});
check('缩进的注释也认', () => {
  assert.ok(!stripCommentLines('    // indented').includes('indented'));
  assert.ok(!stripCommentLines('    /* indented block */').includes('indented block'));
});

console.log('\n=== C. 回归：CSS 通用选择器不能被吃掉 ===');
{
  const css = '* {\n  margin: 0;\n}\n/* 说明\n * 内部\n */\n.a { color: red; }';
  const out = stripCommentLines(css);
  check('`* {` 保留', () => assert.ok(out.includes('* {'), JSON.stringify(out.slice(0, 40))));
  check('margin 声明保留', () => assert.ok(out.includes('margin: 0')));
  check('块注释内部行被剥', () => assert.ok(!out.includes('内部')));
  check('注释后的规则保留', () => assert.ok(out.includes('.a { color: red; }')));
  check('剥完不以属性声明开头（说明没被削掉选择器）', () => {
    assert.ok(!/^\s*margin:/.test(out), JSON.stringify(out.slice(0, 20)));
  });
}

console.log('\n=== D. 真代码里的注释不会让否定断言假红 ===');
{
  // 这是这类工具存在的全部理由：注释里越详细解释「不要这么写」，全文正则越容易命中
  const src = [
    '// 旧写法 ensureIndex(\'articles\', \'idx_articles_slug\') 已废弃',
    'const ok = 1;',
    '/*',
    ' * 也不要写 ensureIndex(\'articles\', \'idx_articles_slug\')',
    ' */',
  ].join('\n');
  check('原文里能匹配到被禁止的写法（所以全文正则会假红）', () => {
    assert.ok(/ensureIndex\('articles',\s*'idx_articles_slug'/.test(src));
  });
  check('剥注释后匹配不到（否定断言才可靠）', () => {
    assert.ok(!/ensureIndex\('articles',\s*'idx_articles_slug'/.test(stripCommentLines(src)));
  });
  check('真代码里的写法仍能匹配', () => {
    const real = "ensureIndex('articles', 'idx_articles_slug');";
    assert.ok(/ensureIndex\('articles',\s*'idx_articles_slug'/.test(stripCommentLines(real)));
  });
}

console.log('\n=== E. 已知局限（显式钉住，免得被当成完整词法器） ===');
check('行尾注释不被剥离', () => {
  assert.ok(stripCommentLines('const a = 1; // marker').includes('marker'));
});
check('字符串里的 // 不被剥离', () => {
  assert.ok(stripCommentLines('const u = "http://x";').includes('http://x'));
});
check('孤立的 `* xxx` 行不剥', () => {
  assert.ok(stripCommentLines(' * still here').includes('still here'));
});

console.log('\n=== F. withCode ===');
check('返回 raw / code 两份，code 不含注释', () => {
  const r = withCode('// x\nconst a = 1;');
  assert.ok(r.raw.includes('// x'));
  assert.ok(!r.code.includes('// x'));
  assert.ok(r.code.includes('const a = 1;'));
});
check('null / undefined 安全', () => {
  assert.strictEqual(stripCommentLines(null), '');
  assert.strictEqual(stripCommentLines(undefined), '');
  assert.strictEqual(withCode(null).code, '');
});

console.log(`\nsourceText 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
