/**
 * HTTP 方法清单（**唯一来源**）。
 *
 * 为什么要单独一个模块：这三份清单原本各写一遍，彼此没有联系 ——
 *
 *   1. `app.js:94`  `ALLOWED_METHODS = ['GET','HEAD','POST','PUT','DELETE','OPTIONS']`
 *      不在其中的方法一律 405。
 *   2. `app.js:284` 写请求的 Referer + 时间戳防重放
 *   3. `audit.js:27` 管理员操作审计
 *   4. `fetchMeta.js:9` Fetch Metadata 跨站写请求拦截
 *
 * 2/3/4 用的都是 `['POST','PUT','DELETE']`。
 *
 * **加一个写方法（比如 PATCH）时会踩的坑**：
 * 只在路由里写了 `router.patch`，忘了改这四处中的某几处 ——
 *   - 漏了 1 → PATCH 直接被 405，功能完全不工作（这个好发现，因为一测就报错）
 *   - 漏了 2 → PATCH 不走防重放，可被重放攻击
 *   - 漏了 3 → PATCH 不被审计，管理员改了什么查不到
 *   - 漏了 4 → PATCH 不校验跨站来源，可被 CSRF 式直调
 *
 * 后三种都是**静默失效**：功能正常，防护没有。所以清单必须只有一份。
 */

/** 写方法（有副作用、需要防护与审计） */
const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'DELETE']);

/** 读方法（无副作用） */
const READ_METHODS = Object.freeze(['GET', 'HEAD']);

/** 允许的方法全集（其余一律 405）。OPTIONS 用于 CORS 预检。 */
const ALLOWED_METHODS = Object.freeze([...READ_METHODS, ...WRITE_METHODS, 'OPTIONS']);

/** 判断是否为写方法（大小写不敏感，Express 的 req.method 恒为大写） */
function isWriteMethod(m) {
  return WRITE_METHODS.includes(String(m || '').toUpperCase());
}

module.exports = { WRITE_METHODS, READ_METHODS, ALLOWED_METHODS, isWriteMethod };
