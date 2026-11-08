/**
 * 数据库索引判定工具（**纯函数，不 require db**）。
 *
 * 拆出来的理由：`classifyRedundantIndex` 原本住在 `migrate.js` 里，而那个文件
 * 顶层就 `require('./db')` —— 于是任何想测这个纯函数的套件都得先准备一份
 * 合法的 `DB_PASSWORD` 环境变量来骗过 config.js 的校验，纯函数测试被迫拖上数据库配置。
 * 现在 `redundantIndex.test.js` 只 require 这个文件，零环境依赖。
 */

/**
 * 判断「indexName 是否被 keeperName 完全覆盖、可以安全删除」。
 *
 * 只在三条同时成立时返回 drop：
 *   1. 两个索引都存在；
 *   2. 列顺序与列名完全一致（覆盖关系必须精确，不做前缀包含的花活）；
 *   3. keeper 是 **UNIQUE** 索引 —— 删掉非唯一那个不会削弱任何约束。
 *
 * 为什么会有重复索引：建表时 `.string('slug').unique()` 自动产出 `articles_slug_unique`，
 * 而后续的 `ensureIndex('articles','idx_articles_slug',['slug'])` 又建了一条同列的普通索引。
 * 两条索引意味着每次 INSERT/UPDATE 都要维护两棵 B+ 树，读路径却只用得到一条。
 *
 * 判定必须偏向"不删"：删错索引不可逆（要重建），删对了只省一点写放大。
 *
 * @param {Array} rows SHOW INDEX 的原始行
 * @param {string} indexName 候选删除的索引
 * @param {string} keeperName 覆盖它的索引
 * @returns {{ drop: boolean, reason: string }}
 */
function classifyRedundantIndex(rows, indexName, keeperName) {
  const list = Array.isArray(rows) ? rows : [];
  const colsOf = (name) => list
    .filter((r) => r && r.Key_name === name)
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index))
    .map((r) => r.Column_name);
  const target = colsOf(indexName);
  const keeper = colsOf(keeperName);
  if (!target.length) return { drop: false, reason: '目标索引不存在（无需处理）' };
  if (!keeper.length) return { drop: false, reason: '覆盖索引不存在（不敢删）' };
  if (target.join(',') !== keeper.join(',')) {
    return { drop: false, reason: `列不一致（${target.join(',')} vs ${keeper.join(',')}）` };
  }
  const keeperUnique = list
    .filter((r) => r && r.Key_name === keeperName)
    .every((r) => Number(r.Non_unique) === 0);
  if (!keeperUnique) return { drop: false, reason: '覆盖索引不是 UNIQUE（删了会丢约束）' };
  return { drop: true, reason: `已由 UNIQUE 索引 ${keeperName} 完全覆盖` };
}

module.exports = { classifyRedundantIndex };
