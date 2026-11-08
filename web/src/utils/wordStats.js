/**
 * 字数与阅读时长（前台唯一口径）
 *
 * 为什么需要这个模块：这套数字在三处出现过，各写各的，结果对不上：
 *   - ArticleDetail 的「N 分钟」（format.js 的 readingTime）
 *   - 后台编辑器的「N 字 · 约 N 分钟」（ArticleEdit 内联的 wordCount）
 *   - 侧栏/首页的阅读统计（本轮新增）
 *
 * 三个实现的分歧点：
 *  1. **字数口径**：`cn + en`（中文字符数 + 英文词数）是本站的既有语义，
 *     后台编辑器一直这么算，保留。但 `readingTime()` 把它算成
 *     `ceil(cn/300 + en/250)` —— 中英两个比值相加，等于假设一篇文章
 *     「同时」以中文速度和英文速度读完，短英文文章会被估成 1 分钟，
 *     长中英混排文章会被高估。正确的是把「等效字数」汇总后一次性取整。
 *  2. **阅读速度**：前台 300+250，后端统计 350。350 是中文技术阅读的常见
 *     经验值；编辑器里的 300 同样是经验值。统一到一个常量，避免同一篇
 *     文章在详情页说 8 分钟、在统计里说 7 分钟。
 *  3. **零字文章**：原来 `Math.max(1, ...)` 把 0 字也算成 1 分钟。
 *     那是为了「不要显示 0 分钟」的展示妥协，但它会污染「总时长」这类
 *     聚合值（100 篇空文章变成 100 分钟）。聚合应该拿到真实值，
 *     展示层再决定要不要兜底成 1。
 *
 * 纯函数、无依赖，Node 与浏览器都能跑，便于单测。
 */

/** 中文阅读速度（字/分钟） */
export const CN_WPM = 350;
/** 英文阅读速度（词/分钟） */
export const EN_WPM = 250;

/** 中日韩统一表意文字（含扩展 A 区常用部分）：按字计数 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 拉丁字母/数字串：按「词」计数（`hello world` = 2，`v2` = 1） */
const WORD_RE = /[a-zA-Z0-9]+/g;

/**
 * 拆 Markdown 标记，只留正文 —— 与后端 utils/markdownText.js 的 plainText 保持同语义，
 * 否则前端数的是「含 `#` 和 `**` 的源码」，后端数的是纯文本，两边又对不上。
 */
export function stripMarkdown(md = '') {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ') // 代码块
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接（留锚文本）
    .replace(/[#>*_~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 数一篇内容的字数。
 * @param {string} content Markdown 源文
 * @param {{ raw?: boolean }} [opts] raw=true 时按原文计数（后台编辑器用，
 *        编辑时不该因为写了个代码块就把字数砍掉）
 * @returns {{ cn: number, en: number, total: number }}
 */
export function countWords(content = '', opts = {}) {
  const text = opts.raw ? String(content || '') : stripMarkdown(content);
  const cn = (text.match(CJK_RE) || []).length;
  const en = (text.match(WORD_RE) || []).length;
  return { cn, en, total: cn + en };
}

/**
 * 阅读时长（分钟，向上取整）。
 *
 * 聚合取整，不是逐篇取整后相加：后者系统性放大短文章的影响
 * （100 篇 10 字文章 = 100 分钟，而总量 1000 字只有 3 分钟）。
 *
 * @param {string} content
 * @param {{ minOne?: boolean, raw?: boolean }} [opts]
 *        minOne=true 用于**展示**（不要出现「0 分钟」）；
 *        聚合统计必须传 false（默认），拿到真实值。
 */
export function readingMinutes(content = '', opts = {}) {
  const { cn, en } = countWords(content, { raw: opts.raw });
  if (cn === 0 && en === 0) return opts.minOne ? 1 : 0;
  const minutes = Math.ceil(cn / CN_WPM + en / EN_WPM);
  return opts.minOne ? Math.max(1, minutes) : minutes;
}

/**
 * 把一组文章的时长汇总成站点统计。
 * 单次遍历、单口径：count 与 sum 来自同一批数据，不会因为并发发布而错位。
 *
 * @param {Array<{ title?: string, slug?: string, content?: string }>} articles
 */
export function aggregateReading(articles = []) {
  const list = Array.isArray(articles) ? articles : [];
  let totalCn = 0;
  let totalEn = 0;
  let longest = null;

  for (const a of list) {
    const { cn, en } = countWords(a?.content || '');
    totalCn += cn;
    totalEn += en;
    // 逐篇比较只为挑出「最长」那篇；总时长**不**在循环里累加，
    // 否则就变成「逐篇取整再相加」（100 篇 10 字文章 = 100 分钟）。
    if (cn + en > 0 && (!longest || cn + en > longest.words)) {
      longest = { title: a?.title || '', slug: a?.slug || '', words: cn + en };
    }
  }

  const totalWords = totalCn + totalEn;
  return {
    total_articles: list.length,
    total_words: totalWords,
    // 0 篇时不能是 NaN（0/0）；这里显式给 0
    avg_words: list.length === 0 ? 0 : Math.round(totalWords / list.length),
    longest,
    /**
     * 总阅读时长：中文、英文要**分开算再相加**，与 readingMinutes 同一口径。
     *
     * ⚠ 原来这里写的是 `Math.ceil(totalWords / CN_WPM)` —— 把英文词也按
     * 中文的 350 字/分钟折算。英文的阅读速度是 250 词/分钟（EN_WPM），
     * 于是同一篇文章在两个地方报出不同时长：
     *   700 词纯英文 → 详情页 readingMinutes 说 **3 分钟**，
     *                  站点统计 aggregateReading 说 **2 分钟**；
     *   2000 词 → 8 分钟 vs 6 分钟。
     * 用户看到的就是「文章里写 8 分钟，统计页说全站才 6 分钟」。
     * 统计口径不一致比数字偏差更伤信任，所以这里改成和详情页同一套算法。
     *
     * 取整时机保持不变：**总量一次性取整**，不逐篇取整后相加。
     */
    total_reading_minutes:
      totalWords === 0 ? 0 : Math.ceil(totalCn / CN_WPM + totalEn / EN_WPM),
  };
}
