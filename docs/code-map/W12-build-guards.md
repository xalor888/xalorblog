# W12 构建期自检脚本（除 focus-visible）

> ⚠ **本文是第 5 轮写的快照，数字已过时**（当时 8 个脚本 / build 串 6 个）。
> 现在 `web/scripts/` 有 **20 道门禁**，`build` 与 `test:scripts` 串的是**同一批 20 个**顺序完全一致
> （`test:scripts` 只是去掉末尾的 `vite build`，它俩的漂移由 `test-gate-integrity.mjs` 钉住）。
> 下面各节的**逐脚本说明仍然有效**，只是当时只覆盖了前 8 个。

覆盖 `web/scripts/` 下的 Node ESM 构建门禁。它们不是"测试套件"而是**构建门禁**：
任一条失败即中断 `vite build`。全部零依赖、纯 Node、无浏览器、无网络，
靠"读源码 + 正则断言"、"纯函数"与"`vm` 沙箱"三种手段，把只在真机或运行时才暴露的缺陷钉死。

---

### web/scripts/check-script-order.mjs（289 行）

**职责**：在 `vite build` 前静态扫描 `src/`，找出"顶层引用了后面才声明的 const/let/class"（TDZ `ReferenceError`）——构建期不报，只在 setup 抛错，表现为整页静默空白。

**关键结构（无导出，顶层脚本）**：`collect(dir)` 递归收集 `.vue/.js/.mjs`；`stripNoise(code)` 手写词法扫描剥离 `//`、`/* */`、单双引号字符串，模板字面量则只抹字面量部分、`${...}` 内按真实代码保留（递归处理嵌套引号与 `{}` 配平）；`scriptOf(file,text)` 用 `/<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/` 取正文，属性顺序与引号写法变化也能命中。三条核心正则：`DECL_RE`（含 `export` 前缀）、`DECL_HEAD_RE`（只认 const/let/var，用于拆"名字｜初值"）、`SKIP_RE`（顶层不可引用的语句头）；`maskNonRefs` 抹掉 `.prop` 与 `{ key: ... }` 的对象键。

**实际逻辑（两轮扫描）**：① 顶层行轮——`line !== line.trimStart()` 即跳过（只看缩进 0）；声明行不整行丢弃，而是把 `=` 左侧换空格只留初始化表达式（`const a = b` 的 `b` 因此会被检查）；`function/var` 不进 `decl` 表（提升合法，进表必误报）。② 立即求值轮——命中 `watch/watchEffect/computed/onMounted/onBeforeMount(` 先做括号配平取整段参数区，再按类型裁剪：`watch(` 只截到**第一个顶层逗号**（getter 立即求值，回调惰性），`onMounted/computed` 直接 `continue`。两轮结果合入 `findings`，按 `\bname\b` 判引用。

**项目内依赖**：仅 `node:fs/path/url`；被 `web/package.json` 的 `build` 首顺位调用；自测为 `test-script-order.mjs`。支持 `process.argv[2]` 覆盖扫描目录。

**与后端约定**：无。不发请求、不带头/票据/签名、无返回结构。坐标输出为 `src/...`（`path.relative(root 的父目录)`）。

**UI/交互要点**：无组件；交互面是终端——通过一行 `✓ …扫描 N 个文件`，失败逐条 `file:useLine 引用了第 X 行才声明的 name` + 片段 + 修法，`exit(1)` 交 CI 拦截。

**运行期副作用与失败模式**：只读、不写盘（副作用仅三次目录遍历）。失败模式三种但退出码相同：真命中、启发式误报（三元被 mask、正则字面量错位）、扫描器自身崩溃。

---

### web/scripts/test-script-order.mjs（107 行）

**职责**：给上面那个启发式检查器做回归护栏——防止它"看着通过其实瞎了"，因此每个用例只断言**退出码**，不看输出文案。

**结构与逻辑**：11 个 `cases`，每条 `{name, files, expectExit}`；`mkdtempSync` 建临时根，用例名经 `[^\w\u4e00-\u9fa5-]→_` 清洗作子目录名；逐文件 `writeFileSync` 后 `execFileSync(process.execPath, [script, dir])`，`catch` 里取 `e.status ?? 1` 并把 stdout/stderr 拼成 `out`；结束时 `rmSync(root,{recursive,force})`，按 `failed` 计数 `process.exit`。5 条期望 1（箭头函数体早期引用、`${}` 内引用、`.vue` 带额外属性、声明行右侧引用、模板字符串），6 条期望 0（函数体内引用、var/function 提升、`.prop` 访问、对象键、字符串与注释中的同名文本、正常顺序）。

**项目内依赖**：`check-script-order.mjs`（同目录解析为绝对路径）；`node:child_process/fs/os/path/url`。

**与后端约定**：无。

**UI/交互要点**：`  ✓/✗ 用例名（期望退出码 N，实际 M）`，失败时补打印前 4 行非空输出；末尾 `结果：x 通过 / y 失败`。

**副作用与失败模式**：写盘全在 `tmpdir` 并在末尾删除，中途抛异常会遗留目录；核心弱点是"退出码即唯一信号"（观察 5）。

---

### web/scripts/test-anti-debug.mjs（392 行）

**职责**：用 `node:vm` 造最小 DOM 跑 `web/public/anti-debug.js`，回归四件事：移动端误报、真检测（窗口差 320 / debugger 150ms / 元素测量异常）、关 DevTools 后自动恢复、console 策略（只静默闲聊渠道，`error` 必须透出）。

**结构与逻辑**：`run(opts)` 构造沙箱——`makeElement` 生成带 `style`/`parentNode`/`children`/`appendChild`/`removeChild`（同步从全局 `appended` 移除，模拟真实 `getElementById` 语义）/`setAttribute`/`addEventListener` 的桩，并用 `Object.defineProperty` 给 `offsetWidth/offsetHeight` 装 getter：异常模式下恒返回 120/90，正常模式回读 `style.width`；`document.getElementById` 在 `appended` 里查；`setTimeout` 只记句柄（`liveTimeouts`）不排队，`setInterval` 只收 fn，`clearTimeout` 删句柄；`Date` 被换成"每次 `now()` 前进 `clockStepMs`"的假时钟，用来无时钟依赖地模拟 debugger 停顿；`localStorage` 恒可读 `xalor_dev_mode`。`vm.runInContext(code)` 后手动派发 `DOMContentLoaded`，再可选调 `console[method]('probe')`；随后 `tick = intervals[0]`，循环 `cycles` 次（`clearFromCycle` 之后把 outer/inner 拉平、关掉元素异常与时钟步进），逐周期记录 `__x_shield__` 是否存在，返回 `{shield, everShielded, shieldTimeline, liveTimeouts, consoleCalls}`。用例分两组：15 条 `cases`（断言最终 `shield`）+ 5 条 `behaviorCases`（用 `check(r)` 断言过程：曾遮蔽→最终摘除、定时器归零、触发期恰好 1 个存活定时器、error 透出、log 静默）。

**项目内依赖**：`web/public/anti-debug.js`（`index.html:46` / `home.html:40` 以 `/anti-debug.js?v=20261018c` 同步引入的运行时脚本，内含 `WIN_DIFF_LIMIT=320`、`DEBUGGER_LIMIT=150`、`STRIKES_REQUIRED` 连续两周期、1200ms `setInterval`、无限 debugger 的 `setTimeout(fn,0)` 自循环、`__x_shield__` 遮蔽层、`eval` 拦截与 console 覆写）。支持 `argv[2]` 指向旧版本文件做"新旧对比证据"。

**与后端约定**：无。这是纯前端反调试脚本的行为回归，不涉及任何 API/票据。

**UI/交互要点**：无 EP；受测对象自身产出全屏遮蔽层与 `请关闭开发者工具` 文案，测试的交互面是 20 条 `✓/✗` + 失败原因。

**副作用与失败模式**：不写盘、不联网。失败集中在"桩骗过自己"：`cssText` 未解析、只驱动首个 interval、`keydown` 从不派发。

---

### web/scripts/test-mobile-baseline.mjs（286 行）

**职责**：用静态正则把"桌面模拟器看不出来、真机必出"的移动端基线钉死，防重构时被删。共 11 组断言。

**结构与逻辑**：顶部 `read(p)` 以 `web/` 为根读文件；`ok(name, cond, hint)` 统一计数。分组：① 双入口 viewport：`viewport-fit=cover` + `interactive-widget=resizes-content`；② 禁缩放：不得出现 `user-scalable=no` / `maximum-scale=1`；③ `main.css`：`tap-highlight-color: transparent`、`touch-action: manipulation`、`@media (pointer: coarse)` 内 `font-size:16px` 且必须 `!important`（否则输给 scoped `.form-input[data-v-*]` 的 (0,2,0)）、`--sat/--sab` token、`user-select: none`；④ `--hero-h: 100svh` 且保留 `100vh` 兜底；⑤ `.float-dock` 用 `var(--sab)`；⑥ `Layout.vue`/`ArticleDetail.vue` 的 `overscroll-behavior: contain`（文件不存在则**跳过**）；⑦ 视差 6 条：`requestAnimationFrame(applyHeroParallax)`、`heroTicking` 闸、入口复位、`prefers-reduced-motion` + `heroMotionAllowed`、`cancelAnimationFrame(heroRafId)`、`translate3d`；⑧ 触摸目标 9 条（`.ticker-close` 44×44、`::before` 22px、`.ticker` 必须 `overflow: visible`、`top: calc(var(--nav-h) + 33px`、`.ticker-text` 省略号、`.hot-tabs button` 8px、`.tag-cloud a` 32px、两处 `.emoji-toggle` 36px）；⑨ 个人主页 `.block-more` ≥40px、`.brand` 44px；⑩ `RouteProgress.vue` 容器 `overflow:hidden` 且保留 `@keyframes rpSlide`；⑪ 移动菜单语义：`:aria-expanded="mobileOpen"`、标签随开合切换、焦点进面板、`Escape` 关闭。

**项目内依赖**：`index.html`、`home.html`、`src/styles/main.css`、`src/views/site/{Home,Layout,ArticleDetail,Messages}.vue`、`src/components/site/CommentSection.vue`、`src/components/ui/RouteProgress.vue`、`src/views/home/{Home,Layout}.vue`。

**与后端约定**：无。全部是 HTML/CSS/Vue 源码文本断言。

**UI/交互要点**：无 Element Plus 使用；受测面是原生 CSS 交互（点击热区、`touch-action`、安全区、`overscroll`、视差与 rAF 节流）与移动菜单的 ARIA/焦点语义。

**副作用与失败模式**：只读。失败模式是"正则窗口"（`{0,900}` 可跨出目标块）与"文件缺失即跳过"。

---

### web/scripts/test-reading-prefs.mjs（346 行）

**职责**：(a) `readingPrefs` 纯函数的坏输入回落/夹紧/步进；(b) 这些偏好**真的接进了**文章页、markdown 与列表页的静态断言。

**结构与逻辑**：import 15 个符号（`FONT_SIZE/LINE_HEIGHT/READ_WIDTH/STORAGE_KEYS`、5 个 `load*`、3 个 `step*`、5 个 `save*`、`charsPerLine`）；`storageOf(initial)` 造 Map 版 localStorage 桩并提供 `_dump()`，`throwing` 桩模拟隐私模式抛 `SecurityError/QuotaExceededError`；`eq()` 用 `Object.is`。断言序列：读（`''`/`abc`/`NaN`/`Infinity`/越界上下/合法值/缺省）、行距（含浮点 `1.9000000000000001→1.9`）、版心、`fontStyle` 大小写规范化、`focusMode` 只认 `'1'`、storage 抛异常时不崩且 `save*` 不抛、步进到边界停住不回绕、写入前先夹（`saveFontSize(999)→20`）、`charsPerLine(760,16)=48`。随后三段读源码的静态断言：ArticleDetail 接线（`loadFontSize(localStorage)`、`lineHeight: String(lineHeight)`、`maxWidth: readWidth + 'px'`、`saveFocusMode`、`documentElement.dataset.focus`、离开清空、工具栏控件、窄屏 Aa 折叠与 `.rt-group{display:none}`、`.rt-btn.rt-toggle` 特指度、禁止 `transition: max-width`）；markdown/目录（`execCommand` 返回值、`已复制/复制失败` 反馈、`COPY_FEEDBACK_MS=1600`、`textContent` 保缩进、`copyTimers` 用 `WeakMap`、`loading/decoding/alt` 独立补齐、`aria-label` 不覆盖、`.toc-item/.td-item{flex-shrink:0}`、`scrollIntoView({block:'nearest'})`、`.code-copy.copy-failed`、`min-width>=6em`）；ArticleList（`emptyTitle` 的 `parts` 拼接、`clearFilter` 只清 keyword/category/tag/page 不清 sort/pageSize、`hasFilter` 控制清除按钮、失败态 `role="alert"` + `.state-error` + `load(page)` 重试）。

**项目内依赖**：`src/utils/readingPrefs.js`（`FONT_SIZE{14,20,16}`/`LINE_HEIGHT{1.5,2.4,1.9}`/`READ_WIDTH{620,980,760}`、keys `xalor_font_size|line_height|read_width|font_style|focus_mode`）、`src/views/site/ArticleDetail.vue`、`src/styles/main.css`、`src/utils/markdown.js`、`src/styles/markdown.css`、`src/views/site/ArticleList.vue`。

**与后端约定**：无。空态/错误态断言只依赖 ArticleList 的本地状态，不校验 `/api/article` 返回结构。

**UI/交互要点**：断言覆盖自研阅读工具栏（字号/行距/版心/字体/沉浸）、代码块复制三态反馈、灯箱 caption 兜底、目录高亮滚动、列表页空态/失败态出口；无 EP 组件参与。

**副作用与失败模式**：只读；5 处重复 `await import()` + 重算 `here`。断言的是"源码里有某个字符串"，等价重构即红、注释写同样字样即绿。

---

### web/scripts/test-word-stats.mjs（331 行）

**职责**：`wordStats` 行为回归 + **跨仓一致性**（直接 `require` `server/` 的纯函数逐例比对），锁住"同一篇文章详情页 8 分钟、统计里 7 分钟"这类口径分叉。

**结构与逻辑**：import `CN_WPM=350/EN_WPM=250/stripMarkdown/countWords/readingMinutes/aggregateReading`；`eq()` 用 `JSON.stringify` 比较（便于比对象）。三段：① 剥离与计数（代码块剔除、行内代码保留、图片连 alt 剔除、链接留锚文本、标记清除、CJK 按字/拉丁按词、`null` 不炸、`raw:true` 编辑器语义）；② 时长与聚合（总量一次取整、`minOne`、空内容 0、100 篇 10 字 = 3 分钟而非 100、`avg_words` 不出 NaN、全空时 `longest:null`、代码块不污染聚合、`readingMinutes` 与 `aggregateReading` 同篇必须同值）；③ 跨仓：按 `^\s*KEY\s*=\s*(.*)$` 解析 `server/.env` 写入 `process.env`（只补缺失键），`createRequire(resolve(serverRoot,'package.json'))` 后 `require('./src/routes/stats.js')` 与 `'./src/utils/markdownText.js'`，比对 `WORDS_PER_MINUTE`、12 条 `parityCases` 的计数与**剥离后纯文本逐字相同**、100 篇聚合，以及两条"界定性断言"——要求服务端仍用单除数 350 且前端已分口径（`sWeb !== sServer`）。

**项目内依赖**：`src/utils/wordStats.js`；跨仓 `server/src/routes/stats.js`（导出 `countWords/buildReadingStats/WORDS_PER_MINUTE/invalidateReadingCache/READING_TTL/READING_FIELDS`，其中 `total_reading_minutes: Math.ceil(totalWords / 350)`）、`server/src/utils/markdownText.js`（`plainText`）、`server/src/config.js`（顶层校验 `DB_PASSWORD`）。

**与后端约定**：不是 HTTP 调用，而是**进程内 require 服务端模块**：无 URL、无鉴权头、无签名；代价是需要 `DB_PASSWORD` 才能把整条 require 链拉起来（`config.js` 在顶层 throw），因此本脚本自己解析 `server/.env`。返回结构即上述导出函数的返回值（数字 / `{total_articles,total_words,avg_words,longest,total_reading_minutes}`）。

**UI/交互要点**：无组件；输出为分节 `【…】` + `✓/✗`，跨仓段落额外打印 `⚠ 跳过…` 与 `ℹ 已知跨仓口径差异`。

**副作用与失败模式**：把 `server/.env` **全量键**展开进 `process.env`（不止 DB 密码）。失败模式：无 `.env` 时跳过而不失败；服务端修正口径反令我方断言失败。

---

### web/scripts/test-contrast-tokens.mjs（372 行）

**职责**：离线算 WCAG AA，检查**设计 token 本身**，让 token 漂出 AA 时构建直接失败。

**结构与逻辑**：自定义 `lin/parseHex/lum/contrast`（sRGB 线性化 + 相对亮度 + `toFixed(2)`）；`token(name, scope)` 用 `new RegExp('名字(-dark)?\\s*:\\s*(#hex)')` 从 `main.css` 取字面量（深色值以 `-dark` 后缀定义在 `:root`，`[data-theme='dark']` 里只是 `var()` 映射）。断言分组：浅色 `--text≥7`、`--text-2/--text-3≥4.5`、`--text-3` 对玻璃卡片底 `#ede9e0`；主色三分（`--accent-text` 对页底与 `--accent-soft`、`--accent-contrast` 对 `--accent-fill`，并**反向**断言 `--accent` 原色确实不足 4.5）；深色反向（`--accent-deep-dark` 必须比浅色 `--accent` 更亮、`--accent-soft-dark` 对深底 <3）；分类色（`--amber-text`、4 个 `[style*='hex']` 按后端色值点名、深色 `.grid-cat` 双 `[data-theme]` 提特指度）；代码高亮（`.hljs-comment` 对 `#1b1a17`、`.code-lang` 对 `#252421`）；后台 EP（`--el-text-color-placeholder/secondary` 覆盖到 `.el-input` 等容器、`.el-input__count` 加祖先避 (0,2,0)、warning 底 `#a06614`、success plain `#2f7a37`、danger link `#a8323a`、`SecurityManage.vue` 徽标压深）；reduced-motion 全局兜底 8 条（`*` 选择器、`animation-duration:0.01ms !important` 而非 `animation:none`、`iteration-count:1`、`transition-duration`、`scroll-behavior:auto`、`.rp-bar` 显式停、"不依赖 transitionend"）；反向保护（`::selection`/`.btn-primary` 用 `--accent-fill`、`--accent-text` 恰好定义 2 处）；7 色 `--accent-fill` 遍历（先从 `theme.js` 抽 `shade(accent.value, X)` 的 X，再逐色算白字比并反向要求压深不过头）；跨站激活态 `.external.active{color:#fff}`。

**项目内依赖**：`src/styles/main.css`、`src/styles/markdown.css`、`src/stores/theme.js`（`shade/mix` 实现与 `--accent-fill` 系数）、`src/views/admin/SecurityManage.vue`、`src/views/site/Layout.vue`、`src/App.vue`。

**与后端约定**：无。分类色断言按**后端返回的颜色字面 hex**（琥珀 `c9900f`、绛红 `c24b5e`、黛绿 `217a5e`、黛蓝 `2f6fb3`）做选择器匹配，等于隐式依赖分类数据里存的色值不变。

**UI/交互要点**：无组件/EP 实例；断言对象是整套视觉可达性（文字层级、实心底白字、代码注释、后台密集表格、reduced-motion 兜底、激活态层级）。

**副作用与失败模式**：只读。失败模式：公式写两遍、`toFixed(2)` 先舍入再比较、部分断言靠注释文字或"恰好 2 次"。

---

### web/scripts/test-theme-init-parity.mjs（345 行）

**职责**：锁住 `public/theme-init.js`（CSS 前同步阻塞、不能用 ESM/store）与 `src/stores/theme.js`（挂载后接管）对同一强调色算出的 `--accent / --accent-deep / --accent-text / --accent-fill / --accent-soft` **逐值一致**——不一致即"刷新时颜色跳变"，而首屏那一帧完全由前者决定。

**结构与逻辑**：`RATIO` 常量表（accentDark .28 / deepDark .4 / deepLight .28 / textDark .4 / textLight .28 / fill .24 / softDark .82 / softLight .9）；`shade=c*(1-a)`、`mixWhite=c+(255-c)*a`；`expectedFromStore(hex,isDark)` 按 store 的 apply() 规则算出五组 rgb 期望值（深色 soft 向 `#12110f` 混 82%）。四段检查：① `parseInitRatios` 用正则从 theme-init.js **按变量名抽首通道系数**（`var a = dark ? [mixWhite(r, X)…] : [r,g,b]` 一路匹配到 `setProperty('--accent'`），并单独抽 `--accent-fill` 的 `'rgb(' + shade(r, X)` 拼接写法；② 三通道一致性（全局扫 `[mixWhite/shade/fill]` 三元组，要求 r=g=b 且组数 ≥5）＋"代码里没有 0.72 调暗残留/没有 `var f = dark ?` 一刀切系数"（先剥离注释再用 `/(^|[^:])\/\/` 避开 URL）；③ theme.js 侧 `grabStore`（accent 用 `const base = isDark.value ? mix(accent.value,'#ffffff',X)`，deep/text 用跨行组合正则）＋ `--accent-fill` 系数＋"apply() 必须自己写 `--accent-text`"（否则切主题后内联值残留）；④ main.css 字面量兜底（`toHex(shade(珊瑚,#e4573d))` 与 `--accent-fill/--accent-text/--accent-deep` 逐值相等）＋深色 `--accent-fill` 必须是字面量而非 `var(--accent-dark)`；⑤ 数学段（9 个 hex × 明暗）；⑥ 语义段（算出来的颜色本身要过 AA：深色 accent/text ≥4.5、浅色 text ≥4.5、fill 对白字 ≥4.5、深色 soft <3）。

**项目内依赖**：`web/public/theme-init.js`（`index.html:44`、`home.html:39` 引入，`?v=20261103`（每次改 theme-init.js 必须同步递增，否则老客户端会继续吃缓存里的旧实现））、`src/stores/theme.js`、`src/styles/main.css`。

**与后端约定**：无。强调色来自前端 store/本地持久化，不经 API。

**UI/交互要点**：无组件；受测面是主题切换与首屏防闪白的观感一致性，以及强调色在深/浅两套下的可读性。

**副作用与失败模式**：只读。失败模式：抽取正则与书写格式强耦合（换行/引号/变量名 `a/d/t`），数学段两边都是测试自己的常量。

---

## 观察

1. `web/scripts/check-script-order.mjs:141` — `([A-Za-z_$][\w$]*)(\s*:)` 会把三元表达式 `cond ? b : c` 里的 `b :` 当作对象字面量键抹成空格，导致**真实引用被掩掉而漏报**。
2. `web/scripts/check-script-order.mjs:37` — `stripNoise` 的手写词法器不识别正则字面量与除号，`/['"]/` 这类正则会开启一个"字符串"，把后续若干行吞成空格，检查器随即静默失效。
3. `web/scripts/check-script-order.mjs:183` — 报出的 `useLine` 是**剥离并截取 script 正文后**的行号，`.vue` 文件未加 `<script setup>` 之前的偏移，按输出跳到编辑器会指错行。
4. `web/scripts/check-script-order.mjs:150-160` 与 `:218-224` — `decl` 收集逻辑整段复制两遍，`collect(root)` 在 `:145/:213/:280` 被遍历三次，`:181` 又在"每行 × 每声明"上重建 `RegExp`，重复实现且是 O(行×声明) 的正则编译开销。
5. `web/scripts/test-script-order.mjs:94-97` — 用 `e.status ?? 1` 归一退出码：检查器**自身崩溃也返回 1**，5 条 `expectExit:1` 的用例无法区分"抓到 TDZ"与"脚本炸了"，护栏可以假绿；`:93` 的 `execFileSync` 也没有 `timeout`。
6. `web/scripts/test-anti-debug.mjs:106-108` — 桩的 `style` 是普通对象且 `style.cssText` 赋值不被解析，`offsetWidth` 只能回落到硬编码的 120/90；一旦 `anti-debug.js` 把 probe 尺寸改掉，`detectByElement` 会在**所有**环境判异常，20 条用例集体翻转且归因错误。
7. `web/scripts/test-anti-debug.mjs:182` 与 `:144-147` — 只驱动 `intervals[0]`，`setInterval` 桩不排队回调，且 `document.hidden` 恒 `false`：新增第二个周期定时器或"后台标签页跳过检测"分支都不会被测到。
8. `web/scripts/test-anti-debug.mjs:120-124` — `addEventListener` 只登记不派发，`anti-debug.js` 的 `keydown` 拦截（F12 / Ctrl+Shift+I / Ctrl+U / **Ctrl+S 在输入框内必须放行**）零覆盖，而那是最容易误伤编辑器的代码。
9. `web/scripts/test-anti-debug.mjs:130-135` — 假时钟"每次 `now()` 前进 N ms"默认 `detectByDebugger` 恰好两次取时；若被测脚本多加一次时间戳调用，149/151 的边界用例实际测的是 298/302。
10. `web/scripts/test-mobile-baseline.mjs:281` — `ok('打开时焦点移进面板', /nextTick\(...\.focus\(\)/.test(layout) || /focus\(\)/.test(layout))` 的 `||` 兜底使断言在 `Layout.vue` 任意一处 `.focus()` 存在时恒真，这条可访问性护栏实际无效。
11. `web/scripts/test-mobile-baseline.mjs:131` — 滚动容器文件不存在时 `continue` 静默跳过，重命名/删除 `Layout.vue`、`ArticleDetail.vue` 会让 `overscroll-behavior` 检查无声消失，而报告仍是"全绿"。
12. `web/scripts/test-mobile-baseline.mjs:90` / `:98` / `:200` — `[\s\S]{0,900}` 窗口可纵跨出 `@media (pointer: coarse)` 块抓到无关规则；同时把 `+ 33px` 这种魔法数字直接钉进断言，正常调整间距就会红。
13. `web/scripts/test-reading-prefs.mjs:344-346` — 打印 `【空态文案区分层级】` 后立即 `process.exit`，该标题下没有任何断言，是遗留的死代码（会让人误以为这一层已被覆盖）。
14. `web/scripts/test-reading-prefs.mjs:237-241` — `const minEm = all.length ? Math.min(...all) : Infinity` 后判 `minEm >= 6`：样式里**一个 `min-width:…em` 都没有**时反而通过，这条"无更窄重复声明"的护栏可空过。
15. `web/scripts/test-reading-prefs.mjs:142-144`（同类样板另见 `:186-188`、`:246-249`、`:285-288`、`:313-316`）— 同一段 `await import('node:fs/url/path') + here = dirname(fileURLToPath(...))` 复制五遍，文件顶部已有 `fileURLToPath` 却不用；脚本名只提 reading-prefs，实际大半断言在测 ArticleDetail/markdown/ArticleList，职责与命名不符。
16. `web/scripts/test-word-stats.mjs:224-227` — 加载 `server/src/routes/stats.js` 失败只打印 `⚠ 跳过` 并继续，不计入 `fail`：CI 无 `server/.env` 时整段跨仓一致性**跳过即绿**，与 `:226` 自己写的"这不算通过"直接矛盾（退出码仍为 0）。
17. `web/scripts/test-word-stats.mjs:203-215` — 手动解析把 `server/.env` 的**全部键**灌进 `process.env`（不只 `DB_PASSWORD`），测试进程因此持有生产库与其他集成凭据，任何后续 stack dump / 派生进程都会看到。
18. `web/scripts/test-word-stats.mjs:301-316` — 两条"界定性断言"要求 `sWeb !== sServer`，即**强制前后端持续不一致**；而 `package.json` 的 `build` 串了这个脚本，于是服务端一旦修正为 cn/en 分口径，**web 端构建**会先失败。
19. `web/scripts/test-contrast-tokens.mjs:44-52` 与 `:323-336` — 相对亮度/对比度实现两遍（hex 版 `lum/contrast` 与 rgb 数组版 `lum/ratio`），阈值常量 `0.03928` 也写了两份，改一处不会同步另一处；`:51` 先 `toFixed(2)` 再比较，4.495 会被舍入成 4.5 判"达标"。
20. `web/scripts/test-contrast-tokens.mjs:278-283` — "项目不依赖 transitionend"靠匹配 `App.vue` 里的**注释文字** `/不依赖 transitionend/`：删注释即红，真引入 `transitionend` 依赖反而不会红。
21. `web/scripts/test-contrast-tokens.mjs:310-313` 与 `web/scripts/test-theme-init-parity.mjs:300` — 同一件事的色板硬编码不一致（`#6d5bb8/#0f8f8f` vs `#7c3aed/#0ea5e9`），两套守卫各测各的色，色板漂移时无法同时报警。
22. `web/scripts/test-theme-init-parity.mjs:302-315` — 标称"两套实现逐值相同"的数学段里，`initAccent` 直接写死 `0.28`，`want` 来自测试自己的 `RATIO.accentDark=0.28`，等价于 `0.28===0.28`，恒真；`:92-104` 注释承认旧版恒真，这段却未跟着修。
23. `web/scripts/test-theme-init-parity.mjs:201` — `ok('--accent-soft 深色向页面底色混 82%', /0\.82/.test(initSrc))` 是全文件裸匹配，任何 `0.82`（透明度、比例、注释）都能满足，变量名与语义都没被约束。
24. `web/scripts/test-theme-init-parity.mjs:119-130` — 系数抽取依赖 theme-init.js 的书写细节（`var a = dark ? …`、`setProperty('--accent'`、`'rgb(' + shade(r, …` 的换行与加号），格式一重排就红在"抽取失败"而非数值漂移，诱使人改测试而非查实现。

## 小结

1. 这批脚本是 web 侧**构建前防线**，被 `build` / `test:scripts` 串成顺序门禁：任一条失败即中断 `vite build`，属"改了会挡发版"的高耦合代码。（`test-focus-visible.mjs` 本轮曾排除在外，现在已在链里。）
2. 手段只有两种：静态正则断言（mobile-baseline、reading-prefs 后半、contrast-tokens、theme-init-parity）与纯函数/沙箱行为断言（script-order fixture、anti-debug 的 vm、word-stats、reading-prefs 前半）。前者锁"不许删掉这条修复"，断言的常是源码文本；后者才是真回归。
3. 跨仓边界只有一处：`test-word-stats.mjs` 用 `createRequire` 直拉 `server/src/routes/stats.js` 与 `utils/markdownText.js`，绕开 HTTP 也绕开 API 契约——锁的是函数返回值口径，代价是依赖 `server/.env` 的 `DB_PASSWORD`。
4. 与后端/网络的边界为零：其余 7 个不发请求、不需头/票据/签名，全离线；`anti-debug.js` 是唯一被真正执行的产物（vm 内），其余只被读取。
5. 脆弱点集中在三处：启发式词法（正则字面量、三元掩码）、桩与实现的隐式耦合（120/90 与两次取时、theme-init 书写格式）、"空过"型断言（`Infinity`、`||` 兜底、裸 `/0.82/`、跳过不失败）——不误报，但真出问题时沉默。
