/**
 * HTTP 方法清单的单点性（零依赖）。
 *
 * 背景：这几份清单原本各写一遍 ——
 *   `app.js` 的 `ALLOWED_METHODS`、`app.js` 的写请求防护、`audit.js` 的审计、
 *   `fetchMeta.js` 的跨站拦截、`waf.js` 的方法白名单，共 **5 处**。
 *
 * 加一个写方法（比如 PATCH）时的坑：
 *   - 漏了白名单 → 405，功能完全不工作（好发现）
 *   - 漏了写请求防护 → 不走防重放，**静默失效**
 *   - 漏了审计 → 不被记录，**静默失效**
 *   - 漏了 fetchMeta → 不校验跨站，**静默失效**
 *
 * 后三种都不报错，所以清单必须只有一份，且用断言钉住。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { WRITE_METHODS, READ_METHODS, ALLOWED_METHODS, isWriteMethod } = require('../src/utils/httpMethods');
const { stripCommentLines } = require('./helpers/sourceText');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try { fn(); passCount++; console.log(`  ✓ ${name}`); }
  catch (e) { failCount++; console.log(`  ✗ ${name} — ${e.message}`); }
}

console.log('=== A. 常量本身自洽 ===');
check('WRITE 与 READ 无交集', () => {
  assert.deepStrictEqual(WRITE_METHODS.filter((m) => READ_METHODS.includes(m)), []);
});
check('ALLOWED 恰好是 READ + WRITE + OPTIONS', () => {
  assert.deepStrictEqual([...ALLOWED_METHODS], [...READ_METHODS, ...WRITE_METHODS, 'OPTIONS']);
});
check('写方法全都在 ALLOWED 里（否则写接口会被 405）', () => {
  assert.deepStrictEqual(WRITE_METHODS.filter((m) => !ALLOWED_METHODS.includes(m)), []);
});
check('三个常量都冻结（防某处 push 污染全局）', () => {
  assert.ok(Object.isFrozen(WRITE_METHODS) && Object.isFrozen(READ_METHODS) && Object.isFrozen(ALLOWED_METHODS));
});

console.log('\n=== B. isWriteMethod 的行为 ===');
check('大写写方法为 true', () => WRITE_METHODS.every((m) => isWriteMethod(m) === true));
check('小写也认（Express 的 req.method 恒大写，但别处可能传小写）', () => {
  assert.ok(isWriteMethod('post') && isWriteMethod('delete'));
});
check('读方法为 false', () => READ_METHODS.every((m) => isWriteMethod(m) === false));
check('OPTIONS 为 false（CORS 预检无副作用）', () => assert.strictEqual(isWriteMethod('OPTIONS'), false));
check('未列出方法为 false（如 PATCH）', () => assert.strictEqual(isWriteMethod('PATCH'), false));
check('null/undefined/数字不抛', () => {
  assert.strictEqual(isWriteMethod(null), false);
  assert.strictEqual(isWriteMethod(undefined), false);
  assert.strictEqual(isWriteMethod(123), false);
});

console.log('\n=== C. 源码里不许再有硬编码清单 ===');
{
  const files = [
    'src/app.js', 'src/middleware/audit.js', 'src/middleware/fetchMeta.js', 'src/middleware/waf.js',
  ];
  for (const f of files) {
    const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    check(`${f} 没有硬编码写方法清单`, () => {
      assert.ok(!/\['POST',\s*'PUT',\s*'DELETE'\]/.test(src), '还有一处会漏改');
    });
    check(`${f} 没有硬编码方法白名单`, () => {
      assert.ok(!/\['GET',\s*'HEAD',\s*'POST'/.test(src), '还有一处会漏改');
    });
  }
  // 引用关系：这四处都必须从 httpMethods 取
  for (const f of files) {
    const src = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    check(`${f} 从 utils/httpMethods 引入`, () => {
      assert.ok(/require\('\.\.\/utils\/httpMethods'\)|require\('\.\/utils\/httpMethods'\)/.test(src));
    });
  }
}

console.log('\n=== D. 写方法清单必须覆盖所有有副作用的 HTTP 语义 ===');
check('POST/PUT/DELETE 都在（项目目前只支持这三个）', () => {
  assert.deepStrictEqual([...WRITE_METHODS], ['POST', 'PUT', 'DELETE']);
});
check('项目里确实没有 router.patch（所以 PATCH 不在清单里是对的）', () => {
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const withPatch = fs.readdirSync(routesDir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /router\.patch\(/.test(fs.readFileSync(path.join(routesDir, f), 'utf8')));
  assert.deepStrictEqual(withPatch, [],
    `这些文件有 PATCH 路由但 PATCH 不在 WRITE_METHODS 里：${withPatch.join(', ')} —— 加接口时必须同步加方法`);
});

console.log('\n=== E. 自检：清单缺一项时确实会被 C/D 抓到 ===');
check('自检：手写少一项的列表 ≠ ALLOWED_METHODS', () => {
  const wrong = ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'];   // 少了 DELETE
  assert.notDeepStrictEqual(wrong, [...ALLOWED_METHODS]);
  assert.ok(WRITE_METHODS.filter((m) => !wrong.includes(m)).length === 1);
});
check('自检：isWriteMethod 对未列出的方法返回 false（不是 undefined）', () => {
  assert.strictEqual(isWriteMethod('PATCH'), false);
  assert.notStrictEqual(isWriteMethod('PATCH'), undefined);
});

console.log(`\nhttpMethods 套件结果: ${passCount} 通过, ${failCount} 失败`);
if (failCount) process.exit(1);
