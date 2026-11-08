/**
 * 枚举值的单点定义（**唯一来源**）。
 *
 * 为什么需要：同一个枚举常常要写好几遍 —— 数据库 schema（`migrate.js` 的 `t.enum`）、
 * 接口校验（`admin.js` 的 `includes`）、展示映射（中文化）、以及查询里的 `where('status', ...)`。
 * 分头写的后果是**新增一个值时要改 5~6 处，漏一处就是静默不一致**：
 *   - 漏了接口校验 → 新值永远提交不进去（好发现：一测就 400）
 *   - 漏了展示映射 → 界面上显示原始英文（不好发现：只有那个状态才看得出）
 *   - 漏了 schema enum → 写入直接报错（好发现）
 *
 * 这里只统一**运行时**用的那份（校验 + 展示）。schema 的 `t.enum` 是数据库结构，
 * 改动需要迁移，不能跟着常量自动变 —— 但测试会检查两者一致。
 */

/**
 * 审核状态。**三个实体共用同一套值**：`comments` / `links` / `messages`。
 * （所以名字不叫 COMMENT_STATUS —— 那会让人以为只有评论用。）
 * 与 `migrate.js` 里各自的 `t.enum('status', [...])` 一致。
 */
const REVIEW_STATUS = Object.freeze(['pending', 'approved', 'rejected']);

/** 审核状态的中文展示（导出、后台列表共用） */
const REVIEW_STATUS_ZH = Object.freeze({
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
});

/** 文章状态 */
const ARTICLE_STATUS = Object.freeze(['draft', 'published']);

/** 是否属于该枚举（大小写敏感 —— 这些值是数据库里存的字面量） */
function isOneOf(list, value) {
  return Array.isArray(list) && list.includes(value);
}

module.exports = { REVIEW_STATUS, REVIEW_STATUS_ZH, ARTICLE_STATUS, isOneOf };
