#!/usr/bin/env node
/**
 * 检查「顶层语句引用了后面才声明的标识符」（TDZ / const 暂时性死区）。
 *
 * 为什么需要这个脚本：这类问题**构建期不报错**（Vite/terser 只看语法与类型），
 * 只在运行时抛 `ReferenceError: Cannot access 'x' before initialization`，
 * 而组件在 setup 里抛错时整页会静默渲染为空 —— 表现和「路由没匹配上」一模一样，
 * 极难排查。本项目已真实踩过一次（NoteEdit.vue 的 watch(form) 写在 const form 之前）。
 *
 * 用法：npm run check:script-order（在 web/ 下执行）
 * 退出码：发现可疑处为 1（可用于 CI），否则 0。
 *
 * 说明：这是**启发式**检查，不是编译器。会先剥离注释与字符串字面量以降低误报；
 * 报出的每一处都应当人工确认。它只检查顶层（缩进 0）语句 —— 函数体内的引用
 * 走的是运行时求值，不受此约束。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 目录可用第一个参数覆盖（便于自测：node scripts/check-script-order.mjs <dir>）
const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src'));

/** 递归收集待检查文件 */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collect(full));
    else if (/\.(vue|js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** 剥离注释与字符串字面量（保留长度与换行，便于按行号定位） */
function stripNoise(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out += ' '; i += 1;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += ' '; i += 1;
      continue;
    }
    if (c === '`') {
      // 模板字符串：字面量部分抹掉，但 `${...}` 里的表达式是**真实代码**，必须保留。
      // 旧版把整段反引号内容当普通字符串吞掉，于是
      //   const a = `${b}`; const b = 1;
      // 这类「先引用后声明」被整段抹平，检查器一声不响地漏报。
      out += ' '; i += 1;
      while (i < n) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === '`') { out += ' '; i += 1; break; }
        if (code[i] === '$' && code[i + 1] === '{') {
          out += '  '; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const d = code[i];
            if (d === '"' || d === "'" || d === '`') {
              const q = d;
              out += ' '; i += 1;
              while (i < n && code[i] !== q) {
                if (code[i] === '\\') { out += '  '; i += 2; continue; }
                out += code[i] === '\n' ? '\n' : ' ';
                i += 1;
              }
              out += ' '; i += 1;
              continue;
            }
            if (d === '{') depth += 1;
            else if (d === '}') depth -= 1;
            out += d;
            i += 1;
          }
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** 取 .vue 的 <script setup> 内容，.js 取全文 */
function scriptOf(file, text) {
  if (!file.endsWith('.vue')) return text;
  // 属性顺序与引号写法都可能不同（<script setup lang="js"> / <script lang="ts" setup>），
  // 旧版只认字面量 `<script setup>`，换个写法就静默返回空串 —— 整份文件被跳过，等于不检查。
  const m = text.match(/<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

/** 顶层声明行（行首的 const / let / var / class / function） */
const DECL_RE = /^(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/;
/** 声明语句的语句头：用于把这一行拆成「左侧名字」与「右侧初始化表达式」 */
const DECL_HEAD_RE = /^(?:const|let|var)\s+/;
const SKIP_RE = /^(?:const|let|var|function|async\s+function|class|import|export|if|for|while|switch|return|try|throw|\}|\{|\)|])/;

/**
 * 把「不是变量引用」的同名出现抹掉，避免误报：
 *   - `.name` 属性访问
 *   - `{ name: ... }` 对象字面量的键
 * 抹成等长空格以保持列位置。
 */
function maskNonRefs(text) {
  return text
    .replace(/(\.)\s*([A-Za-z_$][\w$]*)/g, (m, dot, name) => dot + ' '.repeat(m.length - dot.length))
    .replace(/([A-Za-z_$][\w$]*)(\s*:)/g, (m, name, colon) => ' '.repeat(name.length) + colon);
}

const findings = [];
for (const file of collect(root)) {
  const raw = readFileSync(file, 'utf8');
  const code = stripNoise(scriptOf(file, raw));
  if (!code.trim()) continue;
  const lines = code.split('\n');
  // 顶层声明名 → 所在行号
  const decl = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(DECL_RE);
    if (!m || decl.has(m[1])) continue;
    // 只收 TDZ 类声明（const / let / class）。`function` / `var` 会提升，
    // 在声明行之前引用它们是合法 JS，收进对照表会产生误报。
    if (/^(?:async\s+function|function|var)\b/.test(line)) continue;
    decl.set(m[1], i);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line !== line.trimStart()) continue; // 只看顶层
    // 声明行不能整行跳过：`const a = b` 里右侧的 b 就是一次真实引用，
    // 若 b 在后面才声明（`const b = ...`）同样是 TDZ。
    // 旧版直接 `SKIP_RE` 掉整行，于是最常见的「初值里引用后声明变量」全部漏报。
    let probe = line;
    const head = line.match(DECL_HEAD_RE);
    if (head) {
      const eq = probe.indexOf('=');
      if (eq === -1) continue; // 无初始化的裸声明，不产生引用
      probe = ' '.repeat(eq + 1) + probe.slice(eq + 1);
    } else if (SKIP_RE.test(line)) {
      continue;
    }
    const self = head ? head[1] : null;
    const masked = maskNonRefs(probe);
    for (const [name, at] of decl) {
      if (at <= i) continue;
      if (name === self) continue; // 自引用声明本身不算（`let x = x` 属另一类问题）
      if (new RegExp(`\\b${name}\\b`).test(masked)) {
        findings.push({
          file: path.relative(path.resolve(root, '..'), file),
          declarationLine: at + 1,
          useLine: i + 1,
          name,
          snippet: line.trim().slice(0, 80),
        });
      }
    }
  }
}

if (!findings.length) {
  console.log(`✓ script-order 检查通过（扫描 ${collect(root).length} 个文件，未发现「先引用后声明」）`);
  process.exit(0);
}
console.error(`✗ 发现 ${findings.length} 处「顶层引用了后面才声明的标识符」（运行时 TDZ ReferenceError，构建不会报错）：\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.useLine} 引用了第 ${f.declarationLine} 行才声明的 \`${f.name}\``);
  console.error(`      ${f.snippet}`);
}
console.error('\n修法：把该标识符的声明挪到使用之前（或把使用挪进函数体，函数体内的引用不受影响）。');
process.exit(1);
