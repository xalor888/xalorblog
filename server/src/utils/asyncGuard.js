/**
 * Express 4 的 async 路由守卫。
 *
 * 背景：Express 4 **不会**捕获 async handler 的 rejection。
 * `router.get('/x', async (req, res) => { await db(...) })` 里一旦抛错，
 * 错误变成一个 unhandledRejection（`server.js` 里只是打一行日志），
 * 而 **HTTP 响应永远不会发出** —— 客户端一直等到超时。
 *
 * 这比 500 难查得多：
 *   - 服务器日志里只有一行 `[unhandledRejection] xxx`，没有路径、没有 IP；
 *   - 客户端看到的是「请求超时」，会怀疑网络；
 *   - 同一个 handler 在正常情况下完全正常，只在 DB 抖动时卡住。
 *
 * 用法：把 handler 包一层即可，错误会转给全局错误中间件（app.js 里那个
 * `app.use((err, req, res, next) => ...)`），对外脱敏成 500。
 *
 *   router.get('/x', asyncGuard(async (req, res) => { ... }));
 *
 * 参考：Express 5 内置了这个行为；本项目仍在 Express 4.22，所以需要显式包裹。
 */
function asyncGuard(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('asyncGuard 需要一个函数');
  }
  return function guarded(req, res, next) {
    // 用 Promise.resolve 包一层：既能接住 async 函数的 rejection，
    // 也能接住普通函数同步抛出的错误（后者 Express 本来就能处理，
    // 但统一走这条路让行为一致）。
    let result;
    try {
      result = fn(req, res, next);
    } catch (e) {
      next(e);
      return;
    }
    if (result && typeof result.then === 'function') {
      result.catch(next);
    }
  };
}

module.exports = asyncGuard;
