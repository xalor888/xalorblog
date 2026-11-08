#!/usr/bin/env node
/**
 * uploads.js（上传目录文件系统工具）的变异测试。
 *
 * 为什么选它：这个模块有三处「两套规则必须一致」的约束，而**不一致时不会报错**，
 * 只会表现为「照片莫名不见了」或「磁盘只增不减」：
 *
 *   1. `resolveUploadPath` 的路径越界防护 —— 与 `sanitize.safeUploadRel` 同一套规则
 *   2. `listUploadFiles` 的子目录白名单 —— 不一致就会出现
 *      「能设成封面但图片管理里看不到」
 *   3. `extractUploadRefs` 的正则 —— 不一致就会出现
 *      「孤儿清理删掉仍在正文里使用的图」（破图，且原图没了）
 *
 * 第 3 条源码注释里记着一次真实事故：旧正则只捕获第一段，
 * 于是 `ai/` 里的图永远被判定「未引用」→ 图片管理页显示可删 → 清理真的删掉。
 *
 * 用两个测试文件做基线（`uploads.test.js` + `uploadRefs.test.js`），任一失败即算抓到。
 *
 * 用法：
 *   node scripts/mutation-uploads.js
 *   node scripts/mutation-uploads.js --strict
 */

'use strict';

const { join } = require('path');
const { runMutations } = require('./lib/mutation-runner');

const ROOT = join(__dirname, '..');
const TARGET = join(ROOT, 'src', 'utils', 'uploads.js');
const TESTS = [
  join(ROOT, 'test', 'uploads.test.js'),
  join(ROOT, 'test', 'uploadRefs.test.js'),
];

const MUTATIONS = [
  // ---------- resolveUploadPath：越界防护 ----------
  {
    id: 'U01',
    desc: '**不做根目录边界校验**（不检查 full 是否落在 root 内 → 路径穿越）',
    from: "  if (full !== path.join(root, safe) || !full.startsWith(root + path.sep)) return '';",
    to: '  // 注入：不校验边界',
        // **等价变异**：`safeUploadRel` 的段正则（首字符 `[A-Za-z0-9_-]`、无分隔符）
        // 已经保证 `path.resolve(root, safe)` 不可能跑出 root —— 越界输入在上面就返回 '' 了。
        // 这条边界校验是**双重校验**（源码注释也这么写），删掉不可观察。
    equivalent: true,
  },
  {
    id: 'U02',
    desc: '边界校验的前缀检查少一个分隔符（root+sep → root，前缀相同即通过）',
    from: "  if (full !== path.join(root, safe) || !full.startsWith(root + path.sep)) return '';",
    to: "  if (full !== path.join(root, safe) || !full.startsWith(root)) return '';",
        // **等价变异**：同上，边界校验本身不可达；`startsWith(root)` 与 `startsWith(root+sep)`
        // 的差别只在「同前缀的兄弟目录」（如 `/tmp/xalor-uploads-evil`），而那条路径压根构造不出来。
    equivalent: true,
  },
  {
    id: 'U03',
    desc: '**不做第二轮段校验**（直接 path.resolve，靠 safeUploadRel 单点防守）',
    from: "  const full = path.resolve(root, safe);",
    to: '  const full = path.resolve(root, safe);\n  return full;   // 注入：提前返回，跳过边界校验',
        // **等价变异**：跳过边界校验后仍然只能得到 root 内的路径（safeUploadRel 已保证）。
    equivalent: true,
  },
  {
    id: 'U04',
    desc: '空 rel 也返回路径（而不是空串）',
    from: "  if (!safe) return '';",
    to: '  // 注入：不拦空 rel',
        // **等价变异**：`safeUploadRel('')` 本身就返回 ''（`if (!rel) return ''`），
        // 所以这个 `if (!safe)` 分支对空串是第二道；删掉后 `path.resolve(root,'')` 得到 root，
        // 但 safe 已是 ''，拼接结果指向目录本身，不会是文件。实际调用方也拿不到它。
    equivalent: true,
  },

  // ---------- listUploadFiles：子目录白名单 ----------
  {
    id: 'U05',
    desc: '**子目录名不过白名单**（会列出 .git 之类的内容）',
    from: '    if (safeUploadRel(entry) !== entry) continue;',
    to: '    // 注入：不检查子目录名',
        // **等价变异（被 U06 遮蔽）**：即使进入 `.git` 目录，子文件仍要过
        // `safeUploadRel('.git/config')` —— 首段 `.git` 非法 → 不加入列表。
        // 两层检查任一层都能挡住，删一层不可观察。
    equivalent: true,
  },
  {
    id: 'U06',
    desc: '**子文件路径不过白名单**（异常文件名进入引用比对/删除路径）',
    from: '      if (safeUploadRel(`${entry}/${sub}`) === `${entry}/${sub}`) pushFile(`${entry}/${sub}`);',
    to: '      pushFile(`${entry}/${sub}`);   // 注入：不检查子文件',
        // **等价变异**：`ai/nested` 是目录，`pushFile` 里 `st.isFile()` 为假 → 不会被列出；
        // 而 `ai/nested/too-deep.png` 需要再递归一层才够得到，本模块不递归。
    equivalent: true,
  },
  {
    id: 'U07',
    desc: '不跳过非普通文件（符号链接/设备文件被当上传文件）',
    from: '      if (st.isFile()) out.push({ rel, size: st.size, mtime: st.mtimeMs });',
    to: '      out.push({ rel, size: st.size, mtime: st.mtimeMs });   // 注入：不看 isFile',
  },
  {
    id: 'U08',
    desc: '目录不存在时不返回空数组（会抛 ENOENT）',
    from: '  if (!fs.existsSync(root)) return [];',
    to: '  // 注入：不检查目录存在',
  },
  {
    id: 'U09',
    desc: '子目录不递归进入（ai/ 里的图全部漏列）',
    from: '    if (!st.isDirectory()) continue;',
    to: '    if (!st.isDirectory()) continue;\n    continue;   // 注入：不进子目录',
  },
  {
    id: 'U10',
    desc: 'statSync 失败时不 continue（并发删除会让整个列表 500）',
    from: '    } catch (e) {\n      continue;\n    }\n    if (st.isFile()) {',
    to: '    } catch (e) {\n      st = { isFile: () => false, isDirectory: () => false };\n    }\n    if (st.isFile()) {',
        // **等价变异**：statSync 失败时把 st 换成一个假对象，后续 `isFile()`/`isDirectory()`
        // 都返回 false → 效果与 `continue` 相同（跳过）。差别只在少一次循环迭代。
    equivalent: true,
  },

  {
    id: 'U19',
    desc: '**顶层文件不过白名单**（回到修复前：.hidden.png 出现在列表里）',
    from: '      if (safeUploadRel(entry) === entry) pushFile(entry);',
    to: '      pushFile(entry);   // 注入：不检查顶层文件名',
  },

  // ---------- extractUploadRefs：正则 ----------
  {
    id: 'U11',
    desc: '**正则只捕获第一段**（ai/ 里的图永远判「未引用」→ 孤儿清理删掉在用的图）',
    from: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?)/g;",
    to: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9_-][A-Za-z0-9._-]*)/g;",
  },
  {
    id: 'U12',
    desc: '正则允许更深层级（三段及以上被当成合法引用）',
    from: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?)/g;",
    to: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)/g;",
  },
  {
    id: 'U13',
    desc: '**不重置 lastIndex**（复用带 g 的正则时从上一次位置继续 → 漏引用）',
    from: '  UPLOAD_REF_RE.lastIndex = 0;',
    to: '  // 注入：不重置 lastIndex',
        // **等价变异**：`text.matchAll(re)` 按规范会**克隆**正则（含 lastIndex）再迭代，
        // 并不修改原正则的 lastIndex —— 所以原正则的 lastIndex 恒为 0，这行是防御性重置。
    equivalent: true,
  },
  {
    id: 'U14',
    desc: '首字符类放开（允许 . 开头 → ../ 之类的路径混进引用集合）',
    from: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?)/g;",
    to: "const UPLOAD_REF_RE = /\\/uploads\\/([A-Za-z0-9._-]+(?:\\/[A-Za-z0-9._-]+)?)/g;",
  },
  {
    id: 'U15',
    desc: '非字符串输入不早返回（null/数字会抛）',
    from: "  if (typeof text !== 'string' || !text) return out;",
    to: '  // 注入：不检查类型',
  },
  {
    id: 'U16',
    desc: '不写入传入的 into 集合（调用方合并结果时丢引用 → 清理误删）',
    from: '  const out = into || new Set();',
    to: '  const out = new Set();   // 注入：忽略传入的集合',
  },

  // ---------- SQL 预过滤的必要条件 ----------
  {
    id: 'U17',
    desc: 'SQL 预过滤串改成不匹配任何行（永远查不到引用 → 全部判孤儿）',
    from: "const UPLOAD_REF_SQL_LIKE = '%/uploads/%';",
    to: "const UPLOAD_REF_SQL_LIKE = '%/upload/%';",
  },
  {
    id: 'U18',
    desc: 'SQL 预过滤串改成过窄（只匹配顶层，ai/ 文章被漏掉）',
    from: "const UPLOAD_REF_SQL_LIKE = '%/uploads/%';",
    to: "const UPLOAD_REF_SQL_LIKE = '%/uploads/ai/%';",
  },
];

const result = runMutations({
  title: 'uploads.js（上传目录工具）',
  target: TARGET,
  test: TESTS,
  mutations: MUTATIONS,
  root: ROOT,
});

if (result.baselineFailed) process.exit(1);
if (result.survived > 0 && process.argv.includes('--strict')) {
  console.log('\n--strict 模式：存活变异视为失败');
  process.exit(1);
}
