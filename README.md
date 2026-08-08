# 🚀 Xalor的小站

一个**前后端分离**的个人博客系统，采用 Vue 3 + Express + MySQL 全栈构建，明亮多彩卡片风 UI，支持暗色模式与主题色切换。

内置**腾讯视频级反爬体系**：PoW 工作量证明、设备指纹绑定、请求签名、正文加密传输、反调试、WAF 特征库、IP 信誉自动封禁。

## ✨ 功能特性

### 前台
- 🏠 **首页**：编辑感精选文章 + 打字机特效 Hero + 光晕动效 + 统计数字滚动动画 + 文章卡片流（含热门徽章）+ 分类/标签入口
- 📝 **文章**：分类/标签筛选、关键词搜索（标题+摘要+**正文**，高亮）、分页（**每页条数 8/16/32 可切换**，URL+本地双记忆）、**列表/卡片双视图切换**（偏好本地记忆）；Markdown 渲染、代码高亮（macOS 风格代码块头 + 复制按钮）、TOC 目录（桌面侧栏 / 移动端悬浮抽屉，**折叠状态记忆**）、阅读时长、字数统计、浏览量、点赞、字号 + 衬线/无衬线阅读模式切换、上一篇/下一篇（键盘 ←→ 切换）、相关文章（含封面缩略图）、本地收藏、**打印按钮**（打印样式优化）、Telegram 分享渠道
- 🔖 **收藏**：文章一键收藏（浏览器本地书签），`/bookmarks` 页管理，无需登录
- 🖼️ **图片灯箱**：点击放大，滚轮缩放、双击 1x/2x、按钮缩放，图片加载失败自动兜底
- 🔍 **全局搜索**：`Ctrl+K / ⌘K` 唤起搜索弹窗，↑↓ 选择、Enter 打开、搜索历史
- 💬 **评论系统**：Gravatar 头像（**邮箱不下发访客**，服务端计算头像 URL）、楼中楼回复（**深层自动折叠可展开**，直达链接穿透展开，展开/收起淡入动画）、**评论排序**（最早/最新，偏好记忆）、**评论直达链接**（点击时间复制 `?comment=id`，自动滚动高亮）、**评论点赞**（本地记忆防刷 + 乐观更新）、博主皇冠角标、honeypot 反垃圾、**回复邮件通知**（被回复者留过邮箱且配置 SMTP 时自动通知，自我回复跳过，邮箱仅服务端使用）、**评论草稿自动保存**（24h 内恢复，刷新/关闭浏览器不丢长评论）、**回复上下文预览**（显示父评论摘要 + 一键取消）、**表情面板**（分组常用表情，可折叠记忆偏好）、**AI 自动审核**（本地规则引擎默认开启：广告/辱骂/色情关键词 + 链接密度/联系方式/乱码/提示注入特征启发式评分，高可疑直接拦截并计 spam 信誉；可选配置 `AI_API_KEY` 接入 LLM 深度二判——含提示注入防护与严格输出解析，中风险评论自动转人工待审；**隐私**：启用 LLM 后仅中风险评论正文发送至所配置的第三方 API，邮箱/昵称/IP 不外传）
- 📂 **归档**：按年份分组的年/月时间线 + 月份产出进度条
- 🏷️ **标签云**：字号分级形成自然的云形
- 🔢 **列表分页**：数字页码 + 省略号折叠，直达任意页
- 👋 **关于页**（含站点数据统计：文章/评论/浏览/访客）+ 🔗 **友链**（可在线申请，无头像渐变兜底）+ 💌 **留言板**（支持分页 + **站长回复展示** + **草稿自动保存** + 访客信息记忆）
- 🎨 **主题三态**（跟随系统 / 亮 / 暗循环切换，系统偏好实时跟随）+ 8 种主题强调色随意切换（切换时全局柔和过渡动画）
- 📱 **响应式** + 打印样式 + 页面切换过渡动画（尊重 `prefers-reduced-motion`）+ 移动端抽屉完整操作入口（搜索/主题/后台）+ 文章页移动端悬浮操作栏（点赞/评论/目录/回顶，评论数角标）
- 📡 **RSS 订阅**（`/api/rss.xml`，含**封面媒体标签** enclosure + Media RSS 缩略图 + **频道站标** channel image + **全文/摘要模式可切换**）+ **Sitemap**（`/api/sitemap.xml`，含常驻页/分类页收录）+ 社交分享 OG 页（**JSON-LD 结构化数据**：BlogPosting/WebSite 富摘要收录，canonical 指向服务端 HTML 页）+ **ICP 备案号**（页脚展示，可配置）
- 🏠 **首页**：热门排行**最热/热议 tab 切换** + 最新评论区块（直达定位）

### 后台（`#/<秘钥路径>`，非固定 `/admin`）
- 🔐 **秘钥路径**：后台地址由 `JWT_SECRET` 派生的 12 位随机段（`#/3f9a2c7e51bd`），每个实例不同，且需完成 PoW 才可获取；探测 `/admin` 等常见路径只会得到蜜罐诱捕 + 自动封禁
- 🔐 **JWT 登录认证**（设备指纹绑定 + 服务端会话可撤销 + 登录事件审计 + 初始密码检测提示）
- 🔐 **两步验证（TOTP）**：可选开启，登录需密码 + 动态验证码双重校验；验证器应用扫码/密钥添加；**验证码输满 6 位自动登录**
- 📊 **仪表盘**：统计卡片（**可点击直达对应管理页**：文章/草稿/浏览/评论/留言 + 今日 PV/UV）+ 访问趋势柱状图（**7/14/30 天范围切换**）+ 分类文章分布 + 待审事项 + **最新动态流**（评论/留言/文章三源合并）+ 一键刷新
- ✍️ **文章管理**：Markdown 实时预览编辑器（**粘贴图片自动上传插入**、**一键自动生成摘要**）、草稿/发布（**发布二次确认**）、置顶、封面上传、**访问链接实时预览**、**发布时间可手动调整**（补发旧文归档）、**状态/分类/关键词多维筛选**、批量发布/置顶/**批量设置分类**/**批量添加标签**/删除、更新时间列、Ctrl+S 保存快捷键、**全量备份导出（JSON）/分片合并导入**（按 slug 查重不覆盖，分类/标签自动重建）
- 🗂️ **分类管理**、🏷️ **标签管理**（**支持标签合并**去重）、✅ **评论/友链/留言审核**（评论与留言可设置默认待审；**AI 复核**可对误拒内容重跑审核引擎；**仅看 AI 标记**筛选；评论/留言/审计 **CSV 导出**（状态中文化 + 公式注入防护））
- 🖼️ **图片管理**：网格预览全部上传图片、**引用中/未引用标记**（被引用的图片禁止误删）、**一键复制图片 Markdown 链接**、单个删除 + **一键清理孤儿文件**（未被任何文章/设置引用的残留，24h 竞态保护）、**JPEG 上传自动剥离 EXIF**（GPS 坐标/设备型号/拍摄时间隐私保护）
- 🛡️ **安全中心**：攻击拦截日志（实时刷新 + 攻击类型分布统计 + **一键导出 CSV**）、封禁 IP 列表（含封禁原因，可手动解封，重启不丢）、**封禁触发自动邮件告警**（配置 SMTP 后）、管理员操作审计（谁在何时做了什么，**可导出 CSV**）、登录会话管理（撤销异地设备/一键退出所有设备）
- 📜 **审计日志页**：全量操作审计（90 天自动清理），支持关键词搜索（操作者/操作/详情/IP）与分页，方法着色展示，可一键清空（清空动作本身也入账）
- ⚙️ **站点设置**：站名/公告/页脚/社交链接/关于页内容/头像上传/**ICP 备案号** + 修改密码（强度策略，改后强制撤销其他会话）+ 2FA 管理 + 内容审核开关 + RSS 全文/摘要切换 + 后台秘钥路径展示 + **活跃会话管理**（查看设备/IP/状态，单设备踢出或一键注销其他全部设备）+ **设置备份导出/导入**（白名单键校验）

## 🛡️ 安全与反爬体系（腾讯视频级）

### 反爬闸门（核心）
| 机制 | 说明 |
|---|---|
| **PoW 工作量证明（自适应）** | 访问前须完成 SHA-256 前导零求解；**bit 级难度语义**（16→24 档，与前端求解器严格一致），难度随 IP 信誉积分自动上调，被标记的可疑 IP 需付出指数级计算成本 |
| **票据续期上限** | 单票据最多续期 10 次（≈110 分钟连续浏览），用尽强制重新 PoW——防「一次求解无限滑动续期」长期免计算抓取全站 |
| **设备指纹绑定** | Canvas/WebGL/硬件信息哈希指纹（64 位十六进制强制校验），票据与指纹/UA/IP 三重绑定，盗用即失效 |
| **通行证票据** | HMAC 签名票据（含版本号），10 分钟有效，到期前自动滑动续期（免重复 PoW）；jti 签发登记防旧密钥残留重放 |
| **请求签名** | 写请求必须携带 `X-Sig`（票据为密钥的 HMAC：方法+路径+时间戳+body 哈希+`X-Nonce` 一次性随机数），防篡改防重放 |
| **正文加密传输** | 文章正文 AES-256-GCM 加密下发，仅持有票据的浏览器可解密，抓包只得密文 |
| **表单签名令牌** | 绑定指纹/UA/目标接口路径，2 秒最小填写间隔 + 单次使用 + 随机字段名蜜罐 |

### 应用防护
| 机制 | 说明 |
|---|---|
| **企业级 WAF** | SQL 注入（含编码/注释/盲注/堆叠/布尔变体）、XSS（事件属性/实体/Unicode/新向量）、路径遍历（双重编码/宽字节）、命令注入（管道/重定向/IFS）、SSRF（内网段/十进制/八进制 IP 变形）、XXE、SSTI、Log4Shell、Spring4Shell、FastJSON/OGNL/SpEL、CRLF、原型污染；**双层 URL 解码 + HTML 实体 + Unicode 转义 + 全角归一化**，单层编码变体直接击穿；**JSON body 递归检测**（嵌套对象中的攻击载荷同样拦截，豁免键子树除外）；**HTTP 请求走私检测**（CL+TE 双头/重复长度头直接拒绝）；**HTTP 方法白名单**（TRACE/CONNECT 等直接拒绝）+ **URL/请求头长度基线**（>8KB 拒绝，防解析/日志撑爆） |
| **扫描器识别** | sqlmap/nikto/nuclei/dirsearch/GoBuster/WPScan 等 60+ 已知工具 UA 特征库，命中即 403；**超长 UA（>300 字符）畸形请求直接拒绝**；**UA 轮换检测**（同 IP 5 分钟内切换 ≥6 个浏览器 UA → 计信誉积分） |
| **蜜罐诱捕** | 潜伏 80+ 常用攻击路径（/admin、/.env、/.git、/wp-login.php、/actuator 等），命中即高积分封禁（404 同形响应不泄露） |
| **目录爆破检测** | 30 秒内 ≥12 次访问不存在路径 → 判定扫描行为，自动累计信誉积分 |
| **IP 信誉系统** | WAF/蜜罐/限流/登录失败/垃圾提交/扫描行为多维度积分，超阈值自动封禁（15 分钟起指数翻倍，最长 24h）；**封禁记录持久化到 ip_bans 表，重启不丢**；**攻击事件批量落库审计**（30s/100 条 flush，重启后安全中心历史事件不丢）；后台可查可解封；**指纹-IP 关联检测**（同一设备指纹出现在 ≥3 个不同 IP → 判代理池，PoW 难度拉满并计信誉） |
| **CSRF 纵深防御** | 写请求 Referer/Origin **双头一致性校验**（白名单由 ALLOWED_HOSTS 动态派生，杜绝硬编码 localhost 盲区；`Origin: null` 一律拒绝）+ Fetch Metadata 跨站校验 + 签名令牌 + 时间戳防重放，四层纵深 |
| **跨源隔离** | `Cross-Origin-Opener-Policy: same-origin`（切断 window.opener 链）+ API 级 `Cross-Origin-Resource-Policy: same-origin`（防跨站读取响应体）；上传资源显式 `cross-origin` 保证社交平台可抓取分享图 |
| **数据生命周期** | 定时清理（每 6 小时）：过期/已撤销 24h 会话、过期封禁、90 天前审计日志、2 年前访问明细（visits/visit_uv 保留对比基线）；进程退出不阻塞 |
| **登录爆破防护** | IP + 用户名双维度锁定、指数退避、TOTP 验证码失败同维度计罚 |
| **JWT 会话加固** | jti/iss/aud 标准声明 + 服务端 sessions 表（指纹一致性强制校验，缺省头即拒绝）+ 可撤销/枚举 + 每用户会话上限 20 |
| **统一错误门面** | 404/403 同形响应，未知接口不泄露路由存在性；错误信息脱敏；拒绝响应一律 no-store 防缓存 |
| **接口隐蔽** | API 前缀可配置为随机字符串（`API_PREFIX`）；**全部后台接口**（文章/分类/标签/评论/友链/留言/统计/设置/上传/安全中心）挂在由 JWT_SECRET 派生的秘钥路径 `/api/<秘钥>/` 下，公共前缀探测不到任何后台路由 |
| **数据一致性** | 删除分类/标签/文章/评论时显式清理关联数据（与数据库外键 SET NULL/CASCADE 双保险）；保存文章时校验引用分类仍存在 |
| **Host/方法校验** | Host 头白名单防投毒，非白名单方法一律 405 |
| **上传安全** | 扩展名 + magic bytes 双重校验、服务端随机重命名、**SVG 全文危险扫描**（脚本/事件/外部实体/HTML 双解析，防大注释填充绕过）+ 静态服务强制附件下载（执行面归零） |
| **SQL 安全** | 全部 Knex 参数化查询、禁用多语句、SQL 严格模式、WAF 纵深防御 |
| **请求体防护** | 2MB 上限、请求/响应超时、连接超时、**慢速攻击防护**（纯定时器兜底：任何请求 30 秒未完成即 408+销毁，兼容 Node 25 socket timeout 不触发的场景）、**JSON 炸弹防护**（嵌套深度 ≤20、数组长度 ≤1000） |
| **操作审计** | 管理员全部写操作 + 登录成功/失败自动入库（audit_logs），后台安全中心可查 |

### 前端反调试
- **DevTools 检测**：窗口尺寸差 / 元素测量异常 / debugger 断点耗时 / console 劫持探测
- **检测即反制**：无限 debugger 卡死 + 全屏遮蔽层，关闭 DevTools 自动恢复
- **键盘拦截**：F12、Ctrl+Shift+I/J/C/K、Ctrl+U/P/S
- **右键/选择/拖拽**：非输入区全面禁用
- **console 静默**：仅显示一条定制提示，生产日志不外泄
- 开发模式可用 `localStorage['xalor_dev_mode']='1'` 临时关闭

### 反爬放行通道
- 搜索引擎爬虫（Googlebot/Bingbot/Baiduspider 等）在**只读接口**放行，利于 SEO 收录
- RSS / Sitemap / 分享页保持公开（附限流防全文刷取）

### 防刷与访问控制
- **浏览量防刷**：文章详情 5 分钟窗口（IP+设备），站点统计 PV 10 秒窗口（IP）
- **点赞防刷**：文章/评论点赞 10 秒窗口（IP+设备指纹）
- **批量操作上限**：后台批量删除/更新单次 ≤500 条（防超大 IN 查询）
- **CORS 可配置**：`CORS_ORIGINS` 环境变量（默认本地开发端口），与 ALLOWED_HOSTS 独立配置

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + Vue Router + Pinia + Element Plus（unplugin 按需引入）+ axios |
| 前端渲染 | marked + highlight.js（按需注册语言）+ DOMPurify |
| 图标 | lucide-vue-next（显式映射按需打包） |
| 加密 | WebCrypto（AES-GCM / SHA-256 / HMAC） |
| 后端 | Node.js + Express |
| 数据库 | MySQL 8（Knex 查询构建器） |
| 认证 | JWT + bcryptjs（12 轮） |
| 上传 | multer（本地 uploads 目录） |

## 📁 目录结构

```
Xalorblog/
├── server/            # 后端 API (端口 3000)
│   ├── src/
│   │   ├── routes/    # 路由: 文章/分类/标签/评论/友链/留言/统计/设置/认证/引导
│   │   ├── routes/admin.js # 后台统一路由（全部挂在秘钥路径下，含上传与安全中心）
│   │   ├── middleware/# 反爬闸门 / WAF / IP信誉 / JWT / 表单令牌 / 请求守卫
│   │   ├── utils/     # 响应封装 / 内容加密 / 清洗 / 设置 / 日期 / slug / TOTP
│   │   ├── migrate.js # 建表脚本（幂等）
│   │   ├── seed.js    # 种子数据
│   │   └── server.js  # 入口（含超时防护）
│   └── uploads/       # 上传的图片
├── web/               # 前端 (端口 5173)
│   └── src/
│       ├── views/site/    # 前台页面
│       ├── views/admin/   # 后台页面（含安全中心）
│       ├── components/    # 通用组件
│       ├── stores/        # Pinia (主题/认证/站点/后台)
│       ├── api/           # axios 封装（票据/签名/解密拦截器）
│       ├── utils/         # 指纹 / PoW / 票据会话 / 加解密 / Markdown
│       └── styles/        # 全局样式
├── mysql/             # 本地 MySQL 实例数据（可选）
└── blog.sql           # 建库脚本
```

## 🚀 快速开始

### 环境要求
- Node.js ≥ 18
- MySQL 8.x（本地可运行）

### 1. 初始化数据库

```bash
# 方式一：执行脚本建库建用户
mysql -u root < blog.sql

# 方式二：手动执行
CREATE DATABASE xalor_blog DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'xalor'@'localhost' IDENTIFIED BY 'xalor2026';
GRANT ALL PRIVILEGES ON xalor_blog.* TO 'xalor'@'localhost';
FLUSH PRIVILEGES;
```

> 若你的 MySQL 账号密码不同，复制 `server/.env.example` 为 `server/.env` 修改 `DB_*` 配置即可。

### 2. 启动后端

```bash
cd server
npm install
cp .env.example .env   # 按需修改（生产务必设置 JWT_SECRET）
npm run migrate   # 建表（幂等）
SEED_ADMIN_PASSWORD=xxx npm run seed   # 写入示例数据（管理员: admin；生产环境必须设置 SEED_ADMIN_PASSWORD —— 未设置时生产模式 seed 直接拒绝执行，默认 admin123 仅限本地演示）
npm run dev       # 启动 API → http://localhost:3000
```

### 3. 启动前端

```bash
cd web
npm install
npm run dev       # 启动 → http://localhost:5173
```

打开浏览器访问 **http://localhost:5173**。后台地址不再固定为 `/admin`：

1. 查看服务端启动日志中的 `🗝️ 管理后台路径`（如 `/#/3f9a2c7e51bd`），或
2. 点击页面右上角 ⚙️ 图标自动跳转

登录账号 `admin` / `admin123`（登录后请立即修改密码，并建议开启两步验证）。

## ⚙️ 常用命令

| 命令 | 说明 |
|---|---|
| `server: npm run migrate` | 建表（幂等，可重复执行，含老库列补齐） |
| `server: npm run seed` | 写入/补齐种子数据 |
| `server: npm run dev` | 后端开发模式（热重载） |
| `server: node test/run.js` | 安全回归测试（246 项 · 9 套件：admin/2FA/会话/爆破锁定/全链路验收/WAF 专项/请求守卫单元/点赞防刷单元/安全全向量），自动重置封禁/TOTP 状态，套件间隔离重启 |
| `web: npm run dev` | 前端开发模式 |
| `web: npm run build` | 前端生产构建（产物在 `web/dist`） |

## 🔧 生产部署建议

1. 前端执行 `npm run build`，用 Nginx 托管 `web/dist`
2. Nginx 将 `/api`（或自定义前缀）和 `/uploads` 反代到 Node 服务（3000 端口）
3. `server/.env` 配置：
   - `JWT_SECRET`：随机长字符串（`openssl rand -hex 32`）—— 同时决定后台秘钥路径
   - `ADMIN_PATH`：（可选）自定义后台路径段，默认由 JWT_SECRET 派生
   - `API_PREFIX`：随机字符串，同时设置前端 `VITE_API_PREFIX` 并重新构建
   - `TRUST_PROXY`：部署在 Nginx 后设置为 `1`（否则真实客户端 IP 会被识别为代理 IP）
   - `ALLOWED_HOSTS`：你的域名
   - `CORS_ORIGINS`：你的前端域名（默认仅本地开发端口，生产必须显式配置）
   - `NODE_ENV=production`
4. 数据库账号使用强密码，限制远程访问
5. 部署辅助文件见 `deploy/` 目录：
   - `xalor-blog.service`：systemd 服务单元（Linux 常驻 + 崩溃重启 + 最小权限）
   - `backup.sh`：数据库 + 上传文件 + 配置一键备份（保留最近 14 份，含恢复命令提示）
6. Nginx 建议配置：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # 安全响应头
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
    # 生产 CSP（与前端 index.html 的 meta CSP 一致：脚本已全部外部化，
    # 无 unsafe-inline —— 内容层 XSS 逃逸也无法注入脚本读取令牌）
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

    # 前端静态资源
    root /path/to/web/dist;
    location / {
        try_files $uri $uri/ /index.html;
        # index.html 不缓存（构建产物文件名带 hash，assets 可长缓存）
        location = /index.html {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }
        # 带 hash 的静态资源长缓存（Vite 产物文件名含内容哈希）
        location ~* \.(js|css|png|jpg|jpeg|gif|webp|svg|ico)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
            try_files $uri =404;
        }
    }

    # API 反代
    # client_max_body_size：与后端 5MB 上传限制对齐（nginx 默认 1MB，
    # 不调大则 >1MB 的图片上传会被 nginx 直接 413 拒绝）
    client_max_body_size 6m;
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 与后端慢速攻击防护（30s 超时）对齐，长请求不被 nginx 提前掐断
        proxy_read_timeout 35s;
        proxy_send_timeout 35s;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

## 📌 常见问题

**Q: 后台地址是什么？** 不是 `/admin`！查看服务端启动日志的「管理后台路径」行，或点击页面右上角 ⚙️ 图标；也可在浏览器地址栏访问 `http://localhost:5173/#/<日志中的路径段>`。路径由 `JWT_SECRET` 派生，更换密钥后路径随之变化（`ADMIN_PATH` 可固定）。

**Q: 如何开启两步验证？** 登录后台 → 站点设置 → 两步验证 → 立即开启，用 Google Authenticator 等应用扫码或手动输入密钥，输入动态码完成启用。

**Q: 验证器丢失/2FA 无法通过怎么办？** 需在服务器上重置（需要数据库访问权限，这是唯一后门，请妥善保管服务器凭据）：
```sql
-- 进入 MySQL 后执行（将 <用户名> 替换为管理员用户名）
UPDATE users SET totp_secret = NULL, totp_enabled = false WHERE username = '<用户名>';
```
完成后用密码直接登录，重新设置两步验证。**建议启用 2FA 前先确认服务器凭据安全**。

**Q: 页面一直提示「访问被拒绝」？** 检查浏览器是否开启了「阻止第三方请求头」类扩展；VIP/隐私模式下 PoW 与指纹仍可正常执行。若被误封（如误触蜜罐路径），可稍候 15 分钟自动解封，或从其他 IP 登录后台解封。

**Q: 端口冲突？** 修改 `server/.env` 的 `port` 和 `web/vite.config.js` 的 `server.port`，并同步代理 target。

**Q: 如何重置所有数据？** 清空数据库后重新执行 `npm run migrate && npm run seed`。

**Q: 开发时想用控制台调试？** 在浏览器控制台执行 `localStorage.setItem('xalor_dev_mode','1')` 后刷新（仅建议本地开发使用）。

**Q: 评论/留言如何审核？** 后台「评论管理」「留言管理」中可对状态进行审批；申请友链在「友链管理」中审核。

**Q: 如何查看反爬拦截记录？** 后台「安全中心」实时展示攻击日志、封禁 IP 与登录会话。

---

© 2026 Xalor的小站 · Powered by Vue 3 & Express & MySQL
