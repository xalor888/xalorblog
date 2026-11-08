/**
 * 上传目录的文件系统工具（不碰 DB，便于单测）。
 *
 * 目录约定：顶层是历史上传，`ai/` 是 AI 写作助手转存的外链图。
 * 只支持一层子目录 —— 与 `utils/sanitize.js` 的 `safeUploadRel` 同一套规则，
 * 两处必须一致：白名单接受而这里列不出来（或反之），就会出现
 * 「能设成封面但图片管理里看不到」「孤儿清理扫不到」这类只增不减的泄漏。
 *
 * 为什么不用递归：递归会把 `node_modules` 式的意外目录也扫进来，
 * 而删除/引用判定每多一层就要多一套边界。当前只有 ai/ 一层生产者。
 */

const fs = require('fs');
const path = require('path');
const { safeUploadRel } = require('./sanitize');

/** 相对路径（`x.png` / `ai/x.png`）→ 绝对路径；非法或越界返回 '' */
function resolveUploadPath(uploadDir, rel) {
  const safe = safeUploadRel(rel);
  if (!safe) return '';
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, safe);
  // 段校验已排除 .. 与多余层级；这里再确认最终路径确实落在根内。
  // 双重校验不是冗余：Windows 分隔符、符号链接、平台大小写差异都可能让
  // "看起来安全"的拼接跑出根目录。
  if (full !== path.join(root, safe) || !full.startsWith(root + path.sep)) return '';
  return full;
}

/**
 * 列出上传目录中的文件（顶层 + 一层子目录），返回 `{ rel, size, mtime }`。
 * `rel` 是相对 `uploadDir` 的路径，直接用于引用比对与删除。
 */
function listUploadFiles(uploadDir) {
  const root = path.resolve(uploadDir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const pushFile = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.isFile()) out.push({ rel, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      // 与清理/上传并发：文件刚被删掉，跳过而不是让整个列表 500
    }
  };
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (st.isFile()) {
      // 顶层文件也要过白名单 —— 与子目录名、子文件路径同一套规则。
      //
      // 这里曾经漏了校验：子目录名查了、`ai/x.png` 查了，唯独顶层文件直接 push。
      // 后果是 `uploads/.hidden.png`（或含非法字符的名字）会出现在图片管理页里，
      // 而引用提取（`extractUploadRefs` 的字符类）根本认不出它 ——
      // 于是它永远被判定为「未引用」→ 孤儿清理会删掉它，
      // 但它的引用方（如果存在）又找不到它。**两条规则不一致就出这种事。**
      //
      // 当前顶层文件都由服务端用随机名生成（`[A-Za-z0-9_-]` 开头），
      // 所以这条实际上什么都没挡住；它的价值在于**规则一致**本身 ——
      // 将来若允许用户自定义文件名，这里是唯一的关口。
      if (safeUploadRel(entry) === entry) pushFile(entry);
      continue;
    }
    if (!st.isDirectory()) continue;
    // 子目录名同样要过白名单：否则 `list` 会列出 `.git` 之类的内容
    if (safeUploadRel(entry) !== entry) continue;
    for (const sub of fs.readdirSync(full)) {
      if (safeUploadRel(`${entry}/${sub}`) === `${entry}/${sub}`) pushFile(`${entry}/${sub}`);
    }
  }
  return out;
}

/**
 * 从任意文本里提取全部 `/uploads/<rel>` 引用（可含**一层子目录**）。
 *
 * 为什么必须认一层子目录：AI 写作助手转存的图在 `/uploads/ai/<name>`。
 * 旧正则只捕获第一段，于是 ai/ 里的图永远被判定为「未引用」——
 * 图片管理页显示可删、孤儿清理会真的删掉仍在正文里使用的图（破图），
 * 而 `/uploads/list` 又只列顶层，这些文件对站长完全不可见。
 *
 * 这个函数是纯的（不做 IO），所以能离线测；引用收集的 SQL 部分在
 * `routes/admin.js` 的 `collectReferencedUploads` 里。
 */
const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?)/g;

function extractUploadRefs(text, into) {
  const out = into || new Set();
  if (typeof text !== 'string' || !text) return out;
  // 必须重置 lastIndex：正则带 g 且有状态，复用时会从上一次位置继续
  UPLOAD_REF_RE.lastIndex = 0;
  for (const m of text.matchAll(UPLOAD_REF_RE)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * 这个 SQL 条件与 `extractUploadRefs` 的**必要条件**关系：
 * 任何能被提取出引用的文本，一定包含字面量 `/uploads/`。
 * 所以用它做预过滤不会漏行，但能把「读全部文章全文」降到「读有图文章的全文」。
 * 两处必须同步改 —— 有断言钉着（test/uploadRefs.test.js）。
 */
const UPLOAD_REF_SQL_LIKE = '%/uploads/%';

module.exports = {
  resolveUploadPath, listUploadFiles, extractUploadRefs, UPLOAD_REF_SQL_LIKE,
};
