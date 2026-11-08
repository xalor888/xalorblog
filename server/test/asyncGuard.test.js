/**
 * `asyncGuard`：Express 4 的 async 错误捕获（零 DB、零服务）。
 *
 * 它修的是一个**只在故障时暴露**的问题：Express 4 不捕获 async handler 的 rejection，
 * 于是 `await db(...)` 抛错时 HTTP 响应**永远不发**，客户端等到超时；
 * 服务器日志里只有一行没头没尾的 `[unhandledRejection]`。
 *
 * 这组断言的重点不是「能转发错误」，而是三件事：
 *   1. rejection 真的会走到 next（否则等于没包）；
 *   2. 正常返回值不被干扰（不能把 res.json 的返回值当 promise 处理）；
 *   3. 同步抛出的错误也走同一条路（行为一致，调用方不用区分两种写法）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const assert = require('assert');
const asyncGuard = require('../src/utils/asyncGuard');

let passCount = 0, failCount = 0;
function check(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failCount++;
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}

const nextCalls = () => {
  const calls = [];
  const next = (err) => { calls.push(err); };
  return { calls, next };
};

console.log('=== A. 基本形态 ===');
check('asyncGuard 返回函数', () => {
  assert.strictEqual(typeof asyncGuard(async () => {}), 'function');
});
check('非函数入参直接抛 TypeError（早失败，不要静默吞掉）', () => {
  assert.throws(() => asyncGuard(null), TypeError);
  assert.throws(() => asyncGuard(undefined), TypeError);
  assert.throws(() => asyncGuard('fn'), TypeError);
});
check('包装后的函数是普通函数（Express 4 要求 fn.length 或 typeof function）', () => {
  const wrapped = asyncGuard(async (req, res) => {});
  assert.strictEqual(typeof wrapped, 'function');
  assert.strictEqual(wrapped.length, 3); // (req, res, next)
});

console.log('\n=== B. async rejection 必须走到 next（核心）===');
{
  const boom = new Error('db down');
  const { calls, next } = nextCalls();
  const wrapped = asyncGuard(async () => { throw boom; });
  wrapped({}, {}, next);

  // next 是异步调用的（rejection 在微任务里），等一轮
  setImmediate(() => {
    check('rejection 转给 next', () => {
      assert.strictEqual(calls.length, 1, `next 被调用 ${calls.length} 次`);
      assert.strictEqual(calls[0], boom);
    });
    check('错误对象是原来那个（不重新包装，保留 stack）', () => {
      assert.strictEqual(calls[0], boom);
      assert.strictEqual(calls[0].message, 'db down');
    });
    console.log('\n=== C. 正常返回不被打扰 ===');
    {
      const { calls, next } = nextCalls();
      const wrapped = asyncGuard(async (req, res) => { res.sent = true; return 'value'; });
      const req = {}, res = {};
      wrapped(req, res, next);
      setImmediate(() => {
        check('正常返回时 next 不被调用', () => {
          assert.strictEqual(calls.length, 0);
        });
        check('handler 的副作用正常发生', () => {
          assert.strictEqual(res.sent, true);
        });

        console.log('\n=== D. 同步抛错也走同一条路 ===');
        {
          const syncBoom = new Error('sync fail');
          const c2 = nextCalls();
          const wrapped2 = asyncGuard((req, res) => { throw syncBoom; });
          wrapped2({}, {}, c2.next);
          check('同步抛错 → next（不需要等微任务）', () => {
            assert.strictEqual(c2.calls.length, 1, `next 被调用 ${c2.calls.length} 次`);
            assert.strictEqual(c2.calls[0], syncBoom);
          });
          check('同步抛错后不再继续执行 handler 剩余部分', () => {
            let reached = false;
            const c3 = nextCalls();
            asyncGuard((req, res) => { throw new Error('x'); reached = true; })({}, {}, c3.next);
            assert.strictEqual(reached, false);
          });
        }

        console.log('\n=== E. 返回值不是 thenable 时不乱调 .catch ===');
        {
          const c4 = nextCalls();
          // 普通函数返回一个非 promise 对象（比如 res.json 的返回值）
          const ret = { json: true };
          const wrapped3 = asyncGuard(() => ret);
          wrapped3({}, {}, c4.next);
          check('非 thenable 返回值不会触发 .catch', () => {
            assert.strictEqual(c4.calls.length, 0);
          });
          check('返回 null 也不会炸', () => {
            const c5 = nextCalls();
            asyncGuard(() => null)({}, {}, c5.next);
            assert.strictEqual(c5.calls.length, 0);
          });
          check('返回 undefined 也不会炸', () => {
            const c6 = nextCalls();
            asyncGuard(() => undefined)({}, {}, c6.next);
            assert.strictEqual(c6.calls.length, 0);
          });
        }

        console.log('\n=== F. next 只被调用一次（否则 Express 会重复进错误中间件）===');
        {
          const c7 = nextCalls();
          const wrapped4 = asyncGuard(async () => { throw new Error('once'); });
          wrapped4({}, {}, c7.next);
          setImmediate(() => {
            check('一次 rejection 只调用一次 next', () => {
              assert.strictEqual(c7.calls.length, 1, `被调用 ${c7.calls.length} 次`);
            });

            console.log('\n=== G. 全仓接线：所有未用 try 的 async handler 都已包 guard ===');
            {
              const fs = require('fs');
              const path = require('path');
              const dir = path.join(__dirname, '..', 'src', 'routes');
              const offenders = [];
              const re = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*(asyncGuard\()?async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{/g;
              for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.js')) continue;
                const src = fs.readFileSync(path.join(dir, f), 'utf8');
                let m;
                while ((m = re.exec(src))) {
                  if (m[3]) continue;
                  const window = src.slice(m.index, m.index + 500);
                  if (/try\s*\{/.test(window)) continue;
                  const line = src.slice(0, m.index).split('\n').length;
                  offenders.push(`${f}:${line} ${m[2]}`);
                }
              }
              check('没有「既没 try 也没 asyncGuard」的 async handler', () => {
                assert.deepStrictEqual(offenders, [],
                  `这些 handler 抛错时响应永远不发：\n      ${offenders.join('\n      ')}`);
              });
              check('至少扫到 100 个 async handler（确认正则没瞎）', () => {
                let total = 0;
                for (const f of fs.readdirSync(dir)) {
                  if (!f.endsWith('.js')) continue;
                  const src = fs.readFileSync(path.join(dir, f), 'utf8');
                  total += (src.match(/router\.(get|post|put|delete|patch)\(/g) || []).length;
                }
                assert.ok(total >= 100, `只扫到 ${total} 个路由注册`);
              });
            }

            console.log('\n=== H. 自检：扫描规则能抓到真问题 ===');
            {
              const fakeSrc = `router.get('/x', async (req, res) => { await db(); });`;
              const guardedSrc = `router.get('/x', asyncGuard(async (req, res) => { await db(); }));`;
              // ⚠ 不能用带 g 的同一个 regex 连续 exec 两个不同字符串：g 标志有 lastIndex 状态，
              // 第二次会从上次的位置继续找，导致漏匹配。每次新建一个（或不带 g）。
              const rex = () => /router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*(asyncGuard\()?async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{/;
              const mm = rex().exec(fakeSrc);
              check('自检：未包装的 async handler 能被识别', () => {
                assert.ok(mm);
                assert.strictEqual(mm[3], undefined);
              });
              const mm2 = rex().exec(guardedSrc);
              check('自检：已包装的会被识别为已处理', () => {
                assert.ok(mm2);
                assert.strictEqual(mm2[3], 'asyncGuard(');
              });

              // guard 真的有效：造一个会 reject 的 handler，确认 next 收到错误
              let got = null;
              asyncGuard(async () => { throw new Error('proof'); })({}, {}, (e) => { got = e; });
              setImmediate(() => {
                check('自检：guard 端到端能接住 rejection', () => {
                  assert.ok(got, 'next 没收到错误 —— 那这个 guard 是摆设');
                  assert.strictEqual(got.message, 'proof');
                });

                console.log(`\nasyncGuard 套件结果: ${passCount} 通过, ${failCount} 失败`);
                if (failCount) process.exit(1);
              });
            }
          });
        }
      });
    }
  });
}
