/**
 * 断言用的源码文本工具（**只在构建门禁里用**，不进产品包）。
 *
 * 为什么需要它：这个项目里已经有三次「断言被注释绊倒」——
 *   1. 断言 `migrate.js` 不再 `ensureIndex('articles','idx_articles_slug')`，结果匹配到解释该改动的注释；
 *   2. 断言不再出现 `idx_articles_slug` 建索引语句，同样命中注释；
 *   3. 断言不许用 `.$reset(`，命中了自己写的反面说明。
 *
 * 规律：**凡是「某写法不许再出现」的断言，必须先剥掉注释再扫**，
 * 否则你越是在注释里解释「为什么不要这么写」，断言就越红 —— 而红的原因是自己的文档。
 *
 * 实现是最小版：按行去掉整行注释。不处理行尾注释与字符串里的 `//`，
 * 那些在本项目的门禁语境里不影响判定，而写一个完整 JS 词法器会引入它自己的 bug 面。
 */

/**
 * 去掉注释行：`//...`、块注释内部行、单行块注释。
 *
 * ⚠ 块注释内部行**必须按上下文判断**，不能只看到 `*` 开头就删：
 * CSS 的通用选择器 `* {` 也是 `*` 开头。曾经就是这么写的，后果是
 * `stripCommentLines('* {\n  margin: 0;\n}')` 返回 `'  margin: 0;\n}'` ——
 * 一条语法无效的 CSS，于是「全局 reset 存在」那类断言会对着被自己弄坏的内容报假红。
 * （发现方式：把 test-focus-visible 的所有读取临时改成剥注释版，9 条断言变红，
 *   其中这一条正是被工具弄坏的。）
 *
 * 现在用一个 `inBlock` 状态跟踪：只有真的在 `/* ... *\/` 里面才删 `*` 开头的行。
 */
export function stripCommentLines(src) {
  let inBlock = false;
  const out = [];
  for (const line of String(src || '').split('\n')) {
    const t = line.trim();
    if (inBlock) {
      // 块注释结束：本行整行都是注释的一部分（即使 `*/` 后面还有内容也很罕见，忽略）
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      // 单行块注释 `/* ... */` 不进入块状态
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** 同时拿到原文与去注释版，便于同一断言里比对 */
export function withCode(raw) {
  return { raw: String(raw || ''), code: stripCommentLines(raw) };
}

/* ============================================================
 * 自检：这个工具本身必须可信，否则所有依赖它的门禁一起失真
 * ============================================================ */
export function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });

  ok('整行 // 注释被去掉', !stripCommentLines('// badPattern(').includes('badPattern'));
  // 块注释内部行去掉 —— 但**必须给它上下文**（真实的 `/*` 开头）。
  // 单独一行 ` * xxx` 无法判断它是块注释内部还是 CSS 通用选择器，所以保留（见下面的局限声明）。
  ok('块注释内部行（在 /* 之后）被去掉',
    !stripCommentLines('/*\n * badPattern(\n */').includes('badPattern'));
  ok('已知局限：孤立的 `* xxx` 行不剥（无法区分块注释与 CSS 选择器）',
    stripCommentLines(' * badPattern(').includes('badPattern'));
  ok('单行块注释（/* 开头）被去掉', !stripCommentLines('/* badPattern( */').includes('badPattern'));
  ok('普通代码行保留', stripCommentLines('const a = 1;').includes('const a = 1'));
  ok('缩进的注释也被去掉', !stripCommentLines('    // badPattern(').includes('badPattern'));

  const mixed = ['// badPattern(', 'const a = 1;', '/* 块注释', ' * badPattern(', ' */', '/* badPattern */', 'const b = badPattern(1);'].join('\n');
  const out = stripCommentLines(mixed);
  ok('混合输入只保留 2 行代码', out.split('\n').length === 2, out.split('\n').length + ' 行');
  ok('混合输入里仍能找到真代码里的 badPattern', out.includes('badPattern'));
  ok('混合输入里注释中的 badPattern 已消失', (out.match(/badPattern/g) || []).length === 1);

  // 已知局限：行尾注释与字符串里的 // 不处理。这里**显式钉住这个局限**，
  // 免得下一个人以为它是完整词法器。
  ok('已知局限：行尾注释不被剥离（文档已声明）',
    stripCommentLines('const a = 1; // badPattern').includes('badPattern'));

  // 回归：CSS 通用选择器 `*` 不能被当成块注释内部行删掉
  const css = '* {\n  margin: 0;\n}\n/* 注释\n * 内部\n */\n.a { color: red; }';
  const cssOut = stripCommentLines(css);
  ok('CSS 通用选择器 `* {` 被保留', cssOut.includes('* {'), cssOut.slice(0, 40));
  ok('CSS 的 margin 声明仍在', cssOut.includes('margin: 0'));
  ok('块注释内部行仍被剥离', !cssOut.includes('内部'));
  ok('块注释之后的代码仍在', cssOut.includes('.a { color: red; }'));
  ok('剥完仍是合法 CSS 片段（不以属性声明开头）',
    !/^\s*margin:/.test(cssOut), cssOut.slice(0, 20));

  // 块注释跨行时，其后的代码必须恢复正常
  const afterBlock = '/*\na\nb\n*/\nconst keep = 1;';
  ok('跨行块注释结束后代码被保留', stripCommentLines(afterBlock).includes('const keep = 1;'));

  ok('空输入返回空串', stripCommentLines('') === '' && stripCommentLines(null) === '');
  ok('withCode 返回 raw 与 code 两份', (() => {
    const r = withCode('// x\nconst a = 1;');
    return r.raw.includes('// x') && !r.code.includes('// x');
  })());

  return cases;
}
