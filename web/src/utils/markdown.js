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
const renderer = new marked.Renderer();
renderer.code = (code, infostring) => {
  const lang = (infostring || '').split(/\s+/)[0] || 'text';
  let body;
  if (lang !== 'text' && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang }).value;
    } catch (e) {
      body = escapeHtml(code);
    }
  } else {
    body = escapeHtml(code);
  }
  return `<div class="code-block">
  <div class="code-head">
    <span class="ch-left">
      <span class="code-dots"><i></i><i></i><i></i></span>
      <span class="code-lang">${escapeHtml(lang)}</span>
    </span>
    <button type="button" class="code-copy" data-copy>复制</button>
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
  const raw = marked.parse(md);
  return DOMPurify.sanitize(raw);
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
    return `<h${level} id="heading-${index - 1}"`;
  });
}

/** 给渲染后的 HTML 中的图片添加懒加载与解码提示（长文性能） */
export function addImgAttrs(html) {
  return html.replace(/<img\b(?![^>]*\bloading=)/g, '<img loading="lazy" decoding="async" ');
}

/**
 * 全局初始化 Markdown 交互（事件委托，需在应用挂载后调用一次）：
 * - 代码块复制按钮
 */
export function initMarkdownInteractions() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = block?.querySelector('pre code');
    if (!code) return;
    const text = code.innerText;
    const done = () => {
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
      }, 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (e) {
    /* 忽略 */
  }
  document.body.removeChild(ta);
}
