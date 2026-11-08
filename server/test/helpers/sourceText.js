/**
 * 断言用的源码文本工具（**只在测试里用**，不进产品）。
 *
 * 与 `web/scripts/lib/sourceText.mjs` 是同一套逻辑的两份实现 ——
 * 跨项目 import 会把 web 的构建依赖拖进 server，所以各留一份。
 * 两份的判据必须一致：**凡「某写法必须出现/不许出现」的结构断言，先剥注释**。
 *
 * 为什么需要它：这个项目里「注释让断言假红或假绿」已经发生过六次以上。两个方向都出现过：
 *   - 假红：断言「不许再出现 `ensureIndex('articles','idx_articles_slug')`」，
 *     结果匹配到了解释该改动的注释；
 *   - 假绿：断言「sitemap 用 `/api/share-page/*`」，那个字面量只在注释里，
 *     真实代码用的是模板变量 —— 断言一年都在匹配注释（第 66 轮发现）。
 *
 * 实现是最小版：按行去掉整行注释 + 块注释内部行。
 * **块注释内部行必须按上下文判断**（用 `inBlock` 跟踪），不能看到 `*` 开头就删 ——
 * CSS 的通用选择器 `* {` 也是 `*` 开头，删掉会产出语法无效的片段。
 *
 * 已知局限（显式声明，免得被当成完整词法器）：行尾注释、字符串里的 `//` 与 `/*` 不处理。
 */

/** 去掉注释行 */
function stripCommentLines(src) {
  let inBlock = false;
  const out = [];
  for (const line of String(src || '').split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** 同时拿到原文与去注释版 */
function withCode(raw) {
  return { raw: String(raw || ''), code: stripCommentLines(raw) };
}

/** 自检：这个工具本身必须可信，否则所有依赖它的测试一起失真 */
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });

  ok('整行 // 注释被去掉', !stripCommentLines('// badPattern(').includes('badPattern'));
  ok('块注释内部行（在 /* 之后）被去掉',
    !stripCommentLines('/*\n * badPattern(\n */').includes('badPattern'));
  ok('单行块注释被去掉', !stripCommentLines('/* badPattern( */').includes('badPattern'));
  ok('普通代码行保留', stripCommentLines('const a = 1;').includes('const a = 1'));

  // CSS 通用选择器不能被当成块注释内部行
  const css = '* {\n  margin: 0;\n}\n/* 注释\n * 内部\n */\n.a { color: red; }';
  const cssOut = stripCommentLines(css);
  ok('CSS 通用选择器 `* {` 被保留', cssOut.includes('* {'));
  ok('块注释内部行仍被剥离', !cssOut.includes('内部'));
  ok('块注释之后的代码仍在', cssOut.includes('.a { color: red; }'));

  // 跨行块注释结束后代码恢复
  ok('跨行块注释结束后代码被保留',
    stripCommentLines('/*\na\nb\n*/\nconst keep = 1;').includes('const keep = 1;'));

  // 已知局限
  ok('已知局限：行尾注释不被剥离',
    stripCommentLines('const a = 1; // badPattern').includes('badPattern'));
  ok('已知局限：孤立的 `* xxx` 行不剥（无法区分块注释与 CSS 选择器）',
    stripCommentLines(' * badPattern(').includes('badPattern'));

  ok('空输入返回空串', stripCommentLines('') === '' && stripCommentLines(null) === '');
  ok('withCode 返回 raw 与 code 两份', (() => {
    const r = withCode('// x\nconst a = 1;');
    return r.raw.includes('// x') && !r.code.includes('// x');
  })());

  return cases;
}

module.exports = { stripCommentLines, withCode, selfTest };
