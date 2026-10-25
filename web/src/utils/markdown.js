import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import kotlin from 'highlight.js/lib/languages/kotlin';
import swift from 'highlight.js/lib/languages/swift';
import DOMPurify from 'dompurify';

// 按需注册常用语言（替代全量引入，chunk 体积大幅减小）
const LANGUAGES = {
  javascript, typescript, css, scss, xml, bash, json, python, java, go, rust,
  c, cpp, sql, markdown, yaml, php, ruby, dockerfile, ini, kotlin, swift,
  html: xml,
};
for (const [name, lang] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, lang);
}

// 配置 marked
marked.setOptions({
  gfm: true,
  breaks: true,
});

/** HTML 转义 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 自定义渲染器：代码块高亮 + 语言标签 + 复制按钮
// marked v13+ 渲染器改为接收 token 对象（{ text, lang, escaped }），不再用位置参数
const renderer = new marked.Renderer();
renderer.code = ({ text, lang: langInfo }) => {
  const lang = (langInfo || '').split(/\s+/)[0] || 'text';
  let body;
  if (lang !== 'text' && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(text, { language: lang }).value;
    } catch (e) {
      body = escapeHtml(text);
    }
  } else {
    body = escapeHtml(text);
  }
  return `<div class="code-block">
  <div class="code-head">
    <span class="ch-left">
      <span class="code-dots"><i></i><i></i><i></i></span>
      <span class="code-lang">${escapeHtml(lang)}</span>
    </span>
    <!-- 按钮文字不再承担播报职责。aria-live 挂在可聚焦按钮上是无效用法：
         读屏把交互元素当作「用户已知区域」，按钮内文字变化多数不会被朗读；
         而且按钮名一旦变成「已复制」，再次聚焦时就丢失了「复制」这个含义。
         改为：按钮名稳定为「复制代码」，另设独立的 role=status 播报结果。 -->
    <button type="button" class="code-copy" data-copy aria-label="复制代码">复制</button>
    <span class="code-copy-status sr-only" role="status" aria-live="polite"></span>
  </div>
  <pre><code class="hljs language-${escapeHtml(lang)}">${body}</code></pre>
</div>`;
};
marked.use({ renderer });

/**
 * 将 Markdown 渲染为安全的 HTML
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md = '') {
  const raw = marked.parse(md, { breaks: true, gfm: true });
  // 注意顺序：先修语义（这些正则只认 marked 的原始输出），再降 h1 / 补表头
  return DOMPurify.sanitize(
    addTableScopes(demoteH1(annotateTaskItems(raw)))
  );
}

/**
 * 给 GFM 任务列表的复选框补可读语义。
 *
 * 为什么：marked 产出的是 `<input type="checkbox" disabled>`。
 * disabled 让它不会被 Tab 到（这点是对的），但读屏在浏览模式下读到它时
 * 只会说「复选框，已选中，不可用」——**不知道它标的是哪一条任务**。
 * 实测两项都是 `aria-label` 为 null、`li` 也没有 `task-list-item` 类。
 *
 * 做法：从紧邻的文本里取任务描述作为 aria-label，并给 li 加上
 * `task-list-item` 类便于样式定位。取不到文本时退回通用描述，
 * 不覆盖已有的 aria-label。
 */
function annotateTaskItems(html) {
  return String(html || '').replace(
    /<li>\s*(<input\b[^>]*type="checkbox"[^>]*>)\s*([\s\S]*?)<\/li>/gi,
    (whole, input, rest) => {
      // 去掉末尾可能的嵌套列表，只把本项的文字当描述
      const text = String(rest)
        .replace(/<ul\b[\s\S]*$/i, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const done = /\bchecked\b/i.test(input);
      const label = text
        ? `${done ? '已完成' : '未完成'}：${text}`
        : done ? '已完成的任务' : '未完成的任务';
      const withLabel = /\baria-label=/i.test(input)
        ? input
        : input.replace(/^<input\b/i, `<input aria-label="${escapeHtml(label)}"`);
      return `<li class="task-list-item">${withLabel}${rest}</li>`;
    }
  );
}

/**
 * 给表头补 scope 属性。
 *
 * 为什么：读屏用户停在某个数据格上时，需要知道「这一格对应哪个表头」，
 * 而这依赖 `scope`。浏览器对**简单表格**能自动推断，但一旦出现
 * 合并单元格、多行表头或嵌套结构就失效 —— 全站现有 6 篇文章都没有表格，
 * 这块从未被真实内容检验过（实测补插一个 4×4 表格后确认 `scope` 全为 null）。
 *
 * 只标记第一行表头为 col：GFM 的表格语法不产生行表头，
 * 标错反而会误导读屏。
 */
function addTableScopes(html) {
  return String(html || '').replace(
    /<table\b([^>]*)>([\s\S]*?)<\/table>/gi,
    (whole, attrs, inner) => {
      // 只在有 thead 时处理；没有 thead 的表格不猜结构
      if (!/<thead\b/i.test(inner)) return whole;
      const fixed = inner.replace(/<th\b(?![^>]*\bscope=)/gi, '<th scope="col"');
      // tabindex="0"：让键盘用户能聚焦表格并用方向键横向滚动。
      // 没有它，超宽表格在窄屏上右侧的列对键盘/读屏用户是**不可达**的 ——
      // 实测 7 列表格在 360px 下需要横向滚动，但原本完全无法用键盘滚动。
      //
      // ⚠ 这里**不能加 role**：`role="group"` 之类会覆盖 table 的角色，
      // 读屏就不再把它当表格播报（行列关系全丢）。保持隐式 table 角色，
      // 只用 tabindex 让它可以被聚焦。
      return `<table${attrs} tabindex="0">${fixed}</table>`;
    }
  );
}

/**
 * 把正文里的 <h1> 降为 <h2>。
 *
 * 为什么：文章页已经有自己的 <h1 class="detail-title">{{ article.title }}</h1>。
 * 作者在正文里写 `# 标题` 时，marked 会再产出第二个 <h1> ——
 * 实测详情页因此有 **2 个 h1**，屏幕阅读器按标题导航时会看到两个页面级标题，
 * 无法判断哪个才是这篇文档的主标题。文档大纲里「一篇文章一个 h1」是硬约束。
 *
 * 顺带把 H20/H30 这些没被引用的标题空出来：降级后 h5/h6 可能变成 h6/h7，
 * 这里只降一级且最低到 h6，不会越界。
 */
function demoteH1(html) {
  return String(html || '').replace(/<h1(\b[^>]*)>([\s\S]*?)<\/h1>/gi, '<h2$1>$2</h2>');
}

// 外链加固：所有渲染出的 <a> 统一注入安全 rel（站内链接保留权重，外链 nofollow 防 SEO
// 垃圾与 window.opener 劫持）；DOMPurify 钩子在净化完成后执行，覆盖文章/关于页全部 markdown 链接
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') || '';
  const isExternal =
    /^https?:\/\//i.test(href) &&
    (() => {
      try {
        return new URL(href).hostname !== window.location.hostname;
      } catch (e) {
        return true;
      }
    })();
  if (isExternal) {
    node.setAttribute('rel', 'nofollow noopener ugc');
  } else if (!node.getAttribute('rel')) {
    node.setAttribute('rel', 'noopener');
  }
});

/** 从标题 token 文本中剥离内联语法（加粗/斜体/链接/行内代码），生成纯文本 */
function headingText(text) {
  return String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*`_~]/g, '')
    .trim();
}

/** 从 Markdown 提取标题生成 TOC
 * 与 addHeadingIds 必须共用同一数据源：
 * - 用 marked 词法解析而非行匹配 —— 代码块内的 `## foo` 只是代码文本，
 *   渲染后不会成为 <h2>；行匹配会把它误算为标题导致编号错位
 * - 引用块内的标题（渲染后输出 <h2>）会被词法解析提取，与渲染编号保持一致
 * - 编号规则（含空文本标题）与 addHeadingIds 的 h2-h4 顺序完全一致 */
export function extractToc(md = '') {
  const toc = [];
  const walk = (tokens) => {
    if (!Array.isArray(tokens)) return;
    for (const t of tokens) {
      if (t.type === 'heading' && t.depth >= 2 && t.depth <= 4) {
        const text = headingText(t.text);
        toc.push({ level: t.depth, text: text || '…', id: `heading-${toc.length}` });
      } else if (t.type === 'blockquote' || t.type === 'list' || t.type === 'list_item') {
        walk(t.tokens); // 引用块/列表内嵌套的标题也计入（与渲染顺序一致）
      }
    }
  };
  try {
    walk(marked.lexer(md));
  } catch (e) {
    // 词法解析异常时回退行匹配（保底，正常流程不会走到）
    const lines = String(md).split('\n');
    const regex = /^(#{2,4})\s+(.*)$/;
    for (const line of lines) {
      const match = line.match(regex);
      if (!match) continue;
      const text = headingText(match[2]);
      toc.push({ level: match[1].length, text: text || '…', id: `heading-${toc.length}` });
    }
  }
  return toc;
}

/** 给渲染后的 HTML 中的标题添加 id（供 TOC 锚点跳转） */
export function addHeadingIds(html) {
  let index = 0;
  return html.replace(/<h([2-4])\b/g, (m, level) => {
    index += 1;
    // tabindex="-1"：让标题可以被**脚本**聚焦（不进 Tab 序列）。
    // 目录跳转时把焦点送到目标标题，键盘用户和读屏才知道「现在到了哪一节」；
    // 没有它 scrollIntoView 只是滚了一下，焦点仍留在目录链接甚至掉到 body。
    return `<h${level} id="heading-${index - 1}" tabindex="-1"`;
  });
}

/**
 * 从图片 URL 推一个可朗读的名字（缺 alt 时的兜底）。
 * `/uploads/2026/knex-join-diagram.png` → `knex join diagram`
 *
 * 为什么要有：缺 alt 的 <img> 在读屏里会念整条 URL（或者只念「图像」），
 * 读者听到一长串路径等于没有信息。文件名至少能说清「这是什么图」。
 */
function imgNameFromSrc(src) {
  let path = String(src || '').split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch (e) {
    /* 非法百分号编码：按原样用 */
  }
  const base = path.split('/').pop() || '';
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  const label = stem.replace(/[-_+.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return label || '文章图片';
}

/** 解析一个 <img> 标签上的属性（只做存在性判断与取值，不重建其它属性） */
function parseImgAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // 跳过标签名本身
  const body = tag.replace(/^<img\b/i, '');
  let m;
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    const raw = m[3] === undefined ? '' : (m[4] ?? m[5] ?? m[6] ?? '');
    attrs[name] = raw;
  }
  return attrs;
}

/**
 * 给渲染后的 HTML 中的图片统一补属性。
 *
 * 1. **可访问性：只补「属性完全缺失」的图，不覆盖空 alt。**
 *    语义上 `alt=""` 是作者明确声明「这是装饰图，读屏请跳过」，而属性缺失
 *    （`<img>` 上根本没有 alt）是「忘了写」。这两者的正确补救方式不同：
 *    给装饰图强塞 aria-label，会让读屏念出一串文件名，比沉默更糟。
 *    所以判定条件收窄到「连 alt 属性都不存在」才补 aria-label：
 *      - `![](x.png)`（marked 渲染为 alt=""）→ 尊重作者，不补
 *      - 手写 `<img src=...>` 无 alt → 补 role/aria-label（文件名兜底）
 *      - 已有 aria-label / aria-hidden → 一律不碰
 *    （早先版本把空 alt 也当「未描述」补了标签；考虑到本站内容里
 *      装饰性配图是常见用法，收窄到属性缺失更安全。全站实际图片数为 0，
 *      所以这条改动的风险面本来就很小。）
 * 2. **一致性**：`loading` / `decoding` 必须各自独立补齐。旧实现只在缺 loading 时
 *    整段注入，于是作者写了 `loading="eager"` 的图会**漏掉 decoding**，
 *    同一篇文章里图片解码策略不一致 —— 长文滚动时个别图会同步解码卡住主线程。
 */
export function addImgAttrs(html) {
  return String(html).replace(/<img\b[^>]*>/gi, (tag) => {
    const attrs = parseImgAttrs(tag);
    const extra = [];

    if (attrs.loading === undefined) extra.push('loading="lazy"');
    if (attrs.decoding === undefined) extra.push('decoding="async"');

    // 已有的 aria-label（作者手写）优先，不覆盖
    // 只对「连 alt 属性都没有」的图补标签：alt="" 是作者声明的装饰图，
    // 给它加 aria-label 等于把装饰图变成读屏噪音（见上方注释）。
    const needsLabel =
      attrs['aria-label'] === undefined &&
      attrs['aria-hidden'] === undefined &&
      attrs.alt === undefined;
    if (needsLabel) {
      const label = imgNameFromSrc(attrs.src || '').replace(/"/g, '&quot;');
      if (attrs.role === undefined) extra.push('role="img"');
      extra.push(`aria-label="${label}"`);
    }

    if (!extra.length) return tag;
    return tag.replace(/^<img\b/i, `<img ${extra.join(' ')}`);
  });
}

/** 复制按钮的反馈时长（任务口径 1.6s，足够读完两个字又不至于一直挂着旧状态） */
const COPY_FEEDBACK_MS = 1600;
/** 每个按钮各自的复位定时器：连点时后一次覆盖前一次，不会留下永不归位的「已复制」 */
const copyTimers = new WeakMap();

/**
 * 把文本写进剪贴板，返回**真实结果**。
 *
 * 两条路径都必须把结论交回来：
 * 1. `navigator.clipboard.writeText` —— 只在安全上下文（https / localhost）且用户
 *    授权时可用；局域网 IP 上打开、或权限被拒时会 reject。
 * 2. `document.execCommand('copy')` —— 老浏览器与非安全上下文的兜底，它**返回布尔值**
 *    且失败时可能不抛异常（只是返回 false），所以必须读返回值，不能只看有没有异常。
 */
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 落到下面的兜底路径
    }
  }
  return legacyCopy(text);
}

/** execCommand 兜底：返回它真实给出的成功与否 */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  // 固定在视口内但不可见：display:none / visibility:hidden 会让 select() 失效
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement;
  let ok = false;
  try {
    ta.select();
    // iOS Safari 只认 range 选中，仅 select() 会复制出空串
    ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand('copy') === true;
  } catch (e) {
    ok = false;
  } finally {
    ta.remove();
    // 把焦点还给原来的元素（按钮），否则键盘用户会掉回 body
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus({ preventScroll: true });
      } catch (e) {
        /* 老浏览器不认 options 参数 */
      }
    }
  }
  return ok;
}

/** 按钮回到「复制」状态（复位文案与状态标记） */
function resetCopyButton(btn) {
  btn.textContent = '复制';
  btn.classList.remove('copied', 'copy-failed');
}

/**
 * 给一个复制按钮播放结果反馈：成功显示「已复制」，失败显示「复制失败」。
 * 两种结果都必须在 1.6s 后复位 —— 失败状态挂着不消失同样会让读者以为按钮坏了。
 */
function showCopyResult(btn, ok) {
  clearTimeout(copyTimers.get(btn));
  // 视觉反馈仍改按钮文字（鼠标用户看这里最直接），
  // 但**播报交给独立的 role=status 元素** —— 见模板里的注释。
  btn.textContent = ok ? '已复制 ✓' : '复制失败';
  btn.classList.toggle('copied', ok);
  btn.classList.toggle('copy-failed', !ok);
  const status = btn.parentElement?.querySelector('.code-copy-status');
  if (status) {
    // 先清空再写入：内容相同的话 live region 不会重复播报
    status.textContent = '';
    // 用 rAF 保证两次变更被读屏视为独立事件
    requestAnimationFrame(() => {
      status.textContent = ok ? '代码已复制到剪贴板' : '复制失败，请手动选择代码';
    });
  }
  copyTimers.set(
    btn,
    setTimeout(() => {
      copyTimers.delete(btn);
      resetCopyButton(btn);
    }, COPY_FEEDBACK_MS)
  );
}

/**
 * 全局初始化 Markdown 交互（事件委托，需在应用挂载后调用一次）：
 * - 代码块复制按钮
 */
export function initMarkdownInteractions() {
  document.addEventListener('click', async (e) => {
    // 委托在 document 上，target 理论上永远是元素；但合成事件/文档级点击可能是
    // 非元素节点，`.closest` 不存在会抛错 —— 一个复制按钮的边界不该打断整页脚本
    const el = e.target;
    if (!el || typeof el.closest !== 'function') return;
    const btn = el.closest('[data-copy]');
    if (!btn || btn.dataset.copying === '1') return; // 连点不加倍复制，也不叠定时器
    const block = btn.closest('.code-block');
    const code = block?.querySelector('pre code');
    if (!code) return;
    // 必须取代码文本的原始内容：innerText 会受白空格折叠影响（缩进全变单空格）
    const text = code.textContent ?? '';
    if (!text) return;

    btn.dataset.copying = '1';
    try {
      showCopyResult(btn, await copyToClipboard(text));
    } finally {
      btn.dataset.copying = '0';
    }
  });
}
