/**
 * 种子数据脚本：初始化示例内容（幂等：已存在的 key/用户名/分类不重复插入）
 * 用法: npm run seed
 */
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const { DEFAULT_SETTINGS } = require('./utils/settings');
const { localDateStr, localDateTimeStr } = require('./utils/datetime');

// 公开测试凭据仅允许 NODE_ENV=test 使用。其他所有环境（包括漏配 NODE_ENV）
// 都必须显式提供强 SEED_ADMIN_PASSWORD，避免把“开发模式”误部署到公网。
const TEST_ADMIN_PASSWORD = 'admin123';
const isTestEnvironment = process.env.NODE_ENV === 'test';
const configuredAdminPassword = String(process.env.SEED_ADMIN_PASSWORD || '');
const ADMIN_PASSWORD = configuredAdminPassword || (isTestEnvironment ? TEST_ADMIN_PASSWORD : '');
const isWeakSeedPassword =
  ADMIN_PASSWORD.length < 12 ||
  /^\d+$/.test(ADMIN_PASSWORD) ||
  /^[a-zA-Z]+$/.test(ADMIN_PASSWORD) ||
  ['admin123', '12345678', 'password', 'password1', 'passw0rd'].includes(ADMIN_PASSWORD.toLowerCase());
if (!isTestEnvironment && (!configuredAdminPassword || isWeakSeedPassword)) {
  console.error('[seed] ✗ 除 NODE_ENV=test 外，必须设置强 SEED_ADMIN_PASSWORD（≥12 位，且不能纯数字/纯字母/常见弱密码）');
  process.exit(1);
}

const categories = [
  { name: '技术笔记', slug: 'tech', description: '编程、框架、工具链的踩坑与心得', color: '#2f6fb3' },
  { name: '生活随笔', slug: 'life', description: '日常、旅行与碎碎念', color: '#c9900f' },
  { name: '读书观影', slug: 'reading', description: '书评、影评与观后感', color: '#c24b5e' },
  { name: '产品思考', slug: 'product', description: '关于产品、设计与互联网的思考', color: '#217a5e' },
];

const tags = ['Vue', 'JavaScript', 'Node.js', 'MySQL', '前端', '设计', '旅行', '阅读', '产品', '随笔'];

const articles = [
  {
    title: '欢迎来到 Xalor 的小站 🎉',
    slug: 'welcome-to-xalor-blog',
    category: '生活随笔',
    tags: ['随笔'],
    cover: '',
    is_top: true,
    status: 'published',
    summary: '这是我的第一个博客站点，使用 Vue 3 + Express + MySQL 全栈构建，记录技术与生活。',
    content: `# 欢迎来到 Xalor 的小站 🎉

大家好！这里是我的个人博客，记录**技术笔记**、**生活随笔**与**所思所想**。

## 这个站是怎么建成的？

- 🖥️ 前端：Vue 3 + Vite + Pinia
- ⚙️ 后端：Node.js + Express
- 🗄️ 数据库：MySQL 8

> 前后端完全分离，Restful API 通信。

## 你可以在本站做什么？

1. 阅读文章、查看归档与标签
2. 在文章下方**发表评论**，与作者互动
3. 在留言板**留下你想说的话**
4. 申请**友情链接**互相交换

## 代码高亮示例

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}! 👋\`;
}

console.log(greet('Xalor'));
\`\`\`

## 结语

欢迎常来坐坐，喜欢的话点个赞再走！❤️`,
  },
  {
    title: 'Vue 3 组合式 API 实战：从零搭建个人博客前端',
    slug: 'vue3-composition-api-blog-frontend',
    category: '技术笔记',
    tags: ['Vue', '前端', 'JavaScript'],
    cover: '',
    status: 'published',
    summary: '分享使用 Vue 3 组合式 API + Vite 搭建博客前端的心得：路由、状态管理、Markdown 渲染与暗色模式。',
    content: `# Vue 3 组合式 API 实战

个人博客的前端我用 **Vue 3** + **Vite** 搭建，整体体验非常丝滑。本文分享几个核心实践。

## 1. 为什么选组合式 API

组合式 API 让逻辑复用变得非常自然。比如**暗色模式切换**，一个 \`useTheme\` 组合函数就搞定了：

\`\`\`javascript
import { ref, watchEffect } from 'vue';

export function useTheme() {
  const theme = ref(localStorage.getItem('theme') || 'light');

  watchEffect(() => {
    document.documentElement.dataset.theme = theme.value;
    localStorage.setItem('theme', theme.value);
  });

  const toggle = () => {
    theme.value = theme.value === 'light' ? 'dark' : 'light';
  };

  return { theme, toggle };
}
\`\`\`

## 2. Markdown 渲染

文章正文以 Markdown 存储，前端用 \`marked\` 渲染 + \`highlight.js\` 高亮代码 + \`DOMPurify\` 清洗 XSS。

## 3. 性能优化

- 路由懒加载：\`() => import('...')\`
- 图片懒加载：\`loading="lazy"\`
- 文章列表虚拟滚动（当文章多时）

## 总结

Vue 3 的生态已经非常成熟，配合 Vite 的开发体验让人心情舒畅，强烈推荐。`,
  },
  {
    title: 'MySQL 8 从安装到建库建表：一篇就够了',
    slug: 'mysql8-install-and-setup-guide',
    category: '技术笔记',
    tags: ['MySQL', 'Node.js'],
    cover: '',
    status: 'published',
    summary: '记录 MySQL 8.4 在 Windows 上的初始化、启动与建库过程，以及 Node.js 连接踩坑实录。',
    content: `# MySQL 8 从安装到建库建表

## 1. 初始化数据目录

\`\`\`bash
mysqld --defaults-file=my.ini --initialize-insecure --console
\`\`\`

\`--initialize-insecure\` 会创建 root 空密码账号，适合本地开发。

## 2. 启动服务

\`\`\`bash
mysqld --defaults-file=my.ini --console
\`\`\`

## 3. 建库建表

\`\`\`sql
CREATE DATABASE blog DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
\`\`\`

注意 MySQL 8 默认使用 \`caching_sha2_password\` 认证，Node 用 \`mysql2\` 驱动可以无缝支持。

## 4. Node.js 连接

\`\`\`javascript
const knex = require('knex');
const db = knex({
  client: 'mysql2',
  connection: {
    host: '127.0.0.1',
    user: 'xalor',
    password: '****',
    database: 'blog',
    charset: 'utf8mb4',
  },
});
\`\`\`

## 踩坑记录

> 8.4 版本移除了 \`default-authentication-plugin\` 参数，不需要再配置它。

搞定！祝大家建库顺利 🎉`,
  },
  {
    title: '给博客做一套好看的卡片式 UI 是什么体验',
    slug: 'card-style-ui-design-notes',
    category: '产品思考',
    tags: ['设计', '前端'],
    cover: '',
    status: 'published',
    summary: '明亮多彩的卡片风格如何设计？从配色、圆角、阴影到微动效，分享我的设计笔记。',
    content: `# 给博客做一套好看的卡片式 UI

我一直喜欢**明亮多彩的卡片风**：鲜艳但不刺眼，活泼但有秩序。

## 配色方案

每张卡片用一个柔和的主题色点缀：

- 🔵 主色 \`#6366f1\`（靛蓝）
- 🟠 强调色 \`#f59e0b\`（琥珀）
- 🟢 成功色 \`#10b981\`（翡翠）

## 卡片设计要点

1. **大圆角**：16px+ 的圆角让界面更亲和
2. **柔和阴影**：\`0 4px 20px rgba(0,0,0,0.06)\`
3. **悬停微动效**：轻微上浮 + 阴影加深

\`\`\`css
.article-card {
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.06);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}
.article-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
}
\`\`\`

## 一点感悟

设计的本质是**让内容被更好地阅读**，好看的皮囊只是加分项，内核永远是有价值的内容。`,
  },
  {
    title: '最近读的几本书：关于自我与时间',
    slug: 'recent-books-self-and-time',
    category: '读书观影',
    tags: ['阅读', '随笔'],
    cover: '',
    status: 'published',
    summary: '分享最近在读的三本书，以及它们带给我的思考：时间管理、自我认知与长期主义。',
    content: `# 最近读的几本书

## 《深度工作》

> 高质量工作产出 = 时间 × 专注度

这本书让我意识到：**减少碎片化**是提升效率的第一要义。我把手机通知全关了，写作时用番茄钟，效果立竿见影。

## 《被讨厌的勇气》

阿德勒心理学的入门神作。核心观点：**一切烦恼都来自人际关系**，而课题分离是解决之道——分清"我的课题"和"别人的课题"。

## 《纳瓦尔宝典》

关于财富与幸福的智慧语录。印象最深的一句：

> 财富是你睡觉时也在为你赚钱的资产。

## 读书方法分享

- 先看目录和序言，建立地图
- 划重点 + 写批注
- 读完后输出一篇笔记（就像这篇！）

阅读是性价比最高的自我投资，没有之一。`,
  },
  {
    title: '用 Knex 优雅地操作 MySQL：ORM 与原生 SQL 的平衡',
    slug: 'knex-mysql-orm-guide',
    category: '技术笔记',
    tags: ['Node.js', 'MySQL'],
    cover: '',
    status: 'published',
    summary: 'Knex 是介于原生 SQL 与重型 ORM 之间的优秀选择，聊聊它的查询构建器、事务与迁移。',
    content: `# 用 Knex 优雅地操作 MySQL

在 Node.js 生态中，\`knex\` 是一个很特别的库：它不是完整 ORM，而是 **SQL 查询构建器**。

## 为什么选 Knex

- 语法接近 SQL，心智负担小
- 支持连接池、事务、迁移
- 底层可切换 mysql2 / pg / sqlite3

## 基本用法

\`\`\`javascript
// 查询
const posts = await db('articles')
  .where('status', 'published')
  .orderBy('published_at', 'desc')
  .limit(10);

// 插入
await db('articles').insert({ title: '标题', content: '正文' });

// 事务
await db.transaction(async (trx) => {
  await trx('articles').where('id', 1).del();
  await trx('article_tags').where('article_id', 1).del();
});
\`\`\`

## 进阶：动态查询

\`\`\`javascript
const base = db('articles')
  .modify((q) => {
    if (category) q.where('category_id', category);
    if (keyword) q.where('title', 'like', \`%\${keyword}%\`);
  });
\`\`\`

## 结语

如果你不想被重型 ORM 绑架，又不想手写一堆 SQL，Knex 是一个恰到好处的选择。`,
  },
];

const links = [
  { name: 'Vue.js 官网', url: 'https://cn.vuejs.org/', avatar: '', description: '渐进式 JavaScript 框架', status: 'approved', sort: 10 },
  { name: 'Vite 中文文档', url: 'https://cn.vitejs.dev/', avatar: '', description: '下一代前端构建工具', status: 'approved', sort: 9 },
  { name: 'MDN Web Docs', url: 'https://developer.mozilla.org/', avatar: '', description: 'Web 开发权威文档', status: 'approved', sort: 8 },
];

const comments = [
  { article: 'welcome-to-xalor-blog', nickname: '访客小蓝', email: 'blue@example.com', content: '沙发！欢迎开博，站点很漂亮，期待更多文章！', status: 'approved' },
  { article: 'welcome-to-xalor-blog', nickname: '技术宅阿健', email: 'jian@example.com', content: '回复楼上：同感！卡片风格 UI 很有活力～', parent: 0, status: 'approved' },
  { article: 'vue3-composition-api-blog-frontend', nickname: 'Nana', email: 'nana@example.com', content: '组合式 API 那段 useTheme 写得真简洁，学到了！', status: 'approved' },
];

const messages = [
  { nickname: '路人甲', email: 'a@example.com', content: '路过留言，祝博客越办越好！', status: 'approved' },
  { nickname: '旅人', email: 'b@example.com', content: '留言板设计得不错，mark！', status: 'approved' },
];

async function seed() {
  console.log('开始写入种子数据...');

  // 用户
  let adminPasswordChanged = false;
  const existingAdmin = await db('users').where('username', 'admin').first();
  if (!existingAdmin) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await db('users').insert({ username: 'admin', password: hash, nickname: 'Xalor', role: 'admin' });
    adminPasswordChanged = true;
    console.log('[seed] 管理员已创建: admin（密码未写入日志）');
  } else {
    const usesPublicTestPassword = await bcrypt.compare(TEST_ADMIN_PASSWORD, existingAdmin.password);
    if (!isTestEnvironment && usesPublicTestPassword) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      // 改密与撤销历史会话必须原子完成；缺少 sessions 表时先迁移并安全失败，
      // 不能留下“密码已换但旧 JWT 仍有效”的窗口。
      const sessionsReady = await db.schema.hasTable('sessions');
      if (!sessionsReady) {
        throw new Error('检测到默认管理员密码，但 sessions 表不存在；请先执行 npm run migrate 后重试 seed');
      }
      await db.transaction(async (trx) => {
        await trx('users').where('id', existingAdmin.id).update({ password: hash });
        await trx('sessions').where('user_id', existingAdmin.id).update({ revoked: true });
      });
      adminPasswordChanged = true;
      console.log('[seed] 已替换公开的默认管理员密码并撤销全部旧会话（新密码未写入日志）');
    } else {
      console.log('[seed] 管理员已存在，跳过');
    }
  }

  // 分类
  const catIds = {};
  const catIdByName = {};
  for (const c of categories) {
    let row = await db('categories').where('slug', c.slug).first();
    if (!row) {
      const [id] = await db('categories').insert(c);
      row = { id };
    } else {
      // 已存在：同步最新描述与主题色
      await db('categories').where('id', row.id).update({ description: c.description, color: c.color });
    }
    catIds[c.slug] = row.id;
    catIdByName[c.name] = row.id;
  }
  console.log('[seed] 分类就绪');

  // 标签
  const tagIds = {};
  for (const name of tags) {
    let row = await db('tags').where('name', name).first();
    if (!row) {
      const [id] = await db('tags').insert({ name, slug: name.toLowerCase() });
      row = { id };
    }
    tagIds[name] = row.id;
  }
  console.log('[seed] 标签就绪');

  // 文章
  const articleIdBySlug = {};
  for (const a of articles) {
    const categoryId = catIdByName[a.category] || null;
    let row = await db('articles').where('slug', a.slug).first();
    if (!row) {
      const [id] = await db('articles').insert({
        title: a.title,
        slug: a.slug,
        summary: a.summary,
        content: a.content,
        cover: a.cover,
        category_id: categoryId,
        status: a.status,
        is_top: !!a.is_top,
        allow_comment: true,
        published_at: localDateTimeStr(new Date(Date.now() - Math.floor(Math.random() * 20) * 24 * 3600 * 1000)),
        views: Math.floor(Math.random() * 500) + 50,
        likes: Math.floor(Math.random() * 60),
      });
      row = { id };
      // 关联标签
      for (const tagName of a.tags) {
        if (tagIds[tagName]) {
          await db('article_tags').insert({ article_id: id, tag_id: tagIds[tagName] }).catch(() => {});
        }
      }
    } else {
      // 已存在则修正分类
      await db('articles').where('id', row.id).update({ category_id: categoryId });
    }
    articleIdBySlug[a.slug] = row.id;
  }
  console.log(`[seed] 文章 ${articles.length} 篇就绪`);

  // 评论
  const commentRows = [];
  const articleRows = await db('articles').whereIn('slug', comments.map((c) => c.article)).select('id', 'slug');
  const idBySlug = {};
  for (const r of articleRows) idBySlug[r.slug] = r.id;

  const cCount = await db('comments').count('* as cnt').first();
  if (Number(cCount.cnt) === 0) {
    for (const c of comments) {
      const base = {
        article_id: idBySlug[c.article],
        nickname: c.nickname,
        email: c.email,
        content: c.content,
        status: c.status,
        ip: '127.0.0.1',
        created_at: localDateTimeStr(new Date(Date.now() - Math.floor(Math.random() * 10) * 24 * 3600 * 1000)),
      };
      const [id] = await db('comments').insert(base);
      commentRows.push({ id, ...base });
    }
    // 处理回复
    for (const c of comments) {
      if (c.parent !== undefined) {
        await db('comments')
          .where('article_id', idBySlug[c.article])
          .where('nickname', c.nickname)
          .where('content', c.content)
          .update({ parent_id: commentRows[c.parent].id });
      }
    }
    console.log('[seed] 评论就绪');
  } else {
    console.log('[seed] 评论已存在，跳过');
  }

  // 友链
  const linkCount = await db('links').count('* as cnt').first();
  if (Number(linkCount.cnt) === 0) {
    for (const l of links) {
      await db('links').insert({ ...l, created_at: localDateTimeStr() });
    }
    console.log('[seed] 友链就绪');
  }

  // 留言
  const msgCount = await db('messages').count('* as cnt').first();
  if (Number(msgCount.cnt) === 0) {
    for (const m of messages) {
      await db('messages').insert({ ...m, created_at: localDateTimeStr() });
    }
    console.log('[seed] 留言就绪');
  }

  // 设置：只补缺，不覆盖站长已改的项（尤其 rss_full_content）
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const json = JSON.stringify(value);
    await db('settings').insert({ key, value: json })
      .onConflict('key')
      .ignore();
  }
  console.log('[seed] 设置就绪（仅补缺，未覆盖已有项）');

  // 访问趋势只记真实 /stats/record，不再灌随机数把仪表盘画歪
  if (isTestEnvironment) {
    for (let i = 13; i >= 0; i--) {
      const d = localDateStr(new Date(Date.now() - i * 24 * 3600 * 1000));
      const pv = 20 + (i % 7) * 3;
      const uv = Math.max(1, Math.floor(pv * 0.4));
      await db('visits').insert({ day: d, pv, uv })
        .onConflict('day')
        .merge({ pv: db.raw('visits.pv + ?', [pv]), uv: db.raw('visits.uv + ?', [uv]) });
    }
    console.log('[seed] 测试环境写入访问统计');
  } else {
    console.log('[seed] 跳过访问统计种子（生产只记真实访问）');
  }

  console.log('\n✅ 种子数据全部完成！');
  if (adminPasswordChanged && !isTestEnvironment) {
    console.log('   后台登录: admin（密码为 SEED_ADMIN_PASSWORD 设置值）');
  } else if (adminPasswordChanged) {
    console.log('   后台登录: admin（测试密码未写入日志）');
  } else {
    console.log('   后台账号: admin（现有密码未被修改）');
  }
  console.log(`   后台地址: /#/${config.adminPath}（秘钥路径，也可点击站点右上角 ⚙️ 进入）`);
}

// 仅直接运行时执行（npm run seed）；被其他模块 require 时不触发
if (require.main === module) {
  seed()
    .then(() => db.destroy())
    .catch((e) => {
      console.error('[seed] 失败:', e);
      db.destroy();
      process.exit(1);
    });
}
