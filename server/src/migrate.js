/**
 * 数据库建表脚本：确保所有表存在（幂等，可重复执行）
 */
const db = require('./db');

async function migrate() {
  // ---------- 分类 ----------
  await db.schema.hasTable('categories').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('categories', (t) => {
        t.increments('id').primary();
        t.string('name', 50).notNullable().unique();
        t.string('slug', 80).notNullable().unique();
        t.string('description', 255).defaultTo('');
        t.string('color', 20).defaultTo('#6366f1'); // 卡片主题色
        t.integer('sort').defaultTo(0); // 前台展示顺序（0-100，小在前）
        t.timestamp('created_at').defaultTo(db.fn.now());
        t.timestamp('updated_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] categories 表已创建');
    } else {
      // 老库升级：补齐 sort / updated_at 列（sitemap 与分类排序功能依赖）
      const cols = await db('categories').columnInfo();
      if (!cols.sort) {
        await db.schema.alterTable('categories', (t) => t.integer('sort').defaultTo(0));
        console.log('[migrate] categories.sort 列已补齐');
      }
      if (!cols.updated_at) {
        await db.schema.alterTable('categories', (t) => t.timestamp('updated_at').defaultTo(db.fn.now()));
        console.log('[migrate] categories.updated_at 列已补齐');
      }
    }
  });

  // ---------- 标签 ----------
  await db.schema.hasTable('tags').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('tags', (t) => {
        t.increments('id').primary();
        t.string('name', 50).notNullable().unique();
        t.string('slug', 80).notNullable().unique();
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] tags 表已创建');
    }
  });

  // ---------- 文章 ----------
  await db.schema.hasTable('articles').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('articles', (t) => {
        t.increments('id').primary();
        t.string('title', 200).notNullable();
        t.string('slug', 220).notNullable().unique();
        t.string('summary', 500).defaultTo('');
        t.text('content').notNullable(); // Markdown 原文
        t.string('cover', 500).defaultTo(''); // 封面图 URL
        t.integer('category_id').unsigned().references('id').inTable('categories').onDelete('SET NULL');
        t.enum('status', ['draft', 'published']).defaultTo('draft');
        t.boolean('is_top').defaultTo(false); // 置顶
        t.integer('views').defaultTo(0);
        t.integer('likes').defaultTo(0);
        t.boolean('allow_comment').defaultTo(true);
        t.timestamp('published_at').nullable();
        t.timestamp('created_at').defaultTo(db.fn.now());
        t.timestamp('updated_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] articles 表已创建');
    }
  });

  // ---------- 文章-标签 关联 ----------
  await db.schema.hasTable('article_tags').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('article_tags', (t) => {
        t.increments('id').primary();
        t.integer('article_id').unsigned().notNullable().references('id').inTable('articles').onDelete('CASCADE');
        t.integer('tag_id').unsigned().notNullable().references('id').inTable('tags').onDelete('CASCADE');
        t.unique(['article_id', 'tag_id']);
      });
      console.log('[migrate] article_tags 表已创建');
    }
  });

  // ---------- 评论 ----------
  await db.schema.hasTable('comments').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('comments', (t) => {
        t.increments('id').primary();
        t.integer('article_id').unsigned().notNullable().references('id').inTable('articles').onDelete('CASCADE');
        t.integer('parent_id').unsigned().nullable().references('id').inTable('comments').onDelete('CASCADE'); // 楼中楼回复
        t.string('nickname', 50).notNullable();
        t.string('email', 100).defaultTo('');
        t.string('website', 200).defaultTo('');
        t.string('content', 2000).notNullable();
        t.string('ip', 64).defaultTo('');
        t.enum('status', ['pending', 'approved', 'rejected']).defaultTo('approved');
        t.string('ai_reason', 120).defaultTo(''); // AI 审核标记原因（管理员可见，定位可疑评论）
        t.integer('likes').notNullable().defaultTo(0); // 评论点赞数
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] comments 表已创建');
    } else {
      // 老库升级：补齐 ai_reason / likes 列
      await db.schema.hasColumn('comments', 'ai_reason').then(async (has) => {
        if (!has) {
          await db.schema.alterTable('comments', (t) => t.string('ai_reason', 120).defaultTo(''));
          console.log('[migrate] comments.ai_reason 列已补齐');
        }
      });
      await db.schema.hasColumn('comments', 'likes').then(async (has) => {
        if (!has) {
          await db.schema.alterTable('comments', (t) => t.integer('likes').notNullable().defaultTo(0));
          console.log('[migrate] comments.likes 列已补齐');
        }
      });
    }
  });

  // ---------- 友链 ----------
  await db.schema.hasTable('links').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('links', (t) => {
        t.increments('id').primary();
        t.string('name', 80).notNullable();
        t.string('url', 300).notNullable();
        t.string('avatar', 500).defaultTo('');
        t.string('description', 200).defaultTo('');
        t.string('email', 100).defaultTo(''); // 申请时留下的联系方式
        t.enum('status', ['pending', 'approved', 'rejected']).defaultTo('pending');
        t.integer('sort').defaultTo(0);
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] links 表已创建');
    }
  });

  // ---------- 站点设置 ----------
  await db.schema.hasTable('settings').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('settings', (t) => {
        t.increments('id').primary();
        t.string('key', 80).notNullable().unique();
        t.text('value'); // JSON 字符串
        t.timestamp('updated_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] settings 表已创建');
    }
  });

  // ---------- 用户 ----------
  await db.schema.hasTable('users').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('users', (t) => {
        t.increments('id').primary();
        t.string('username', 50).notNullable().unique();
        t.string('password', 200).notNullable();
        t.string('nickname', 50).defaultTo('');
        t.string('avatar', 500).defaultTo('');
        t.string('role', 20).defaultTo('admin');
        t.string('totp_secret', 64).nullable(); // TOTP 密钥（Base32），启用两步验证后非空
        t.boolean('totp_enabled').defaultTo(false); // 是否启用两步验证
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] users 表已创建');
    } else {
      // 老库升级：补齐 TOTP 两列
      const cols = await db('users').columnInfo();
      if (!cols.totp_secret) {
        await db.schema.alterTable('users', (t) => {
          t.string('totp_secret', 64).nullable();
        });
        console.log('[migrate] users.totp_secret 列已补齐');
      }
      if (!cols.totp_enabled) {
        await db.schema.alterTable('users', (t) => {
          t.boolean('totp_enabled').defaultTo(false);
        });
        console.log('[migrate] users.totp_enabled 列已补齐');
      }
    }
  });

  // ---------- 会话（JWT 服务端管理：可撤销/枚举） ----------
  await db.schema.hasTable('sessions').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('sessions', (t) => {
        t.string('jti', 64).primary();
        t.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.string('fp', 128).defaultTo('');
        t.string('ip', 64).defaultTo('');
        t.string('ua', 255).defaultTo('');
        t.boolean('revoked').defaultTo(false);
        t.timestamp('expires_at').notNullable();
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] sessions 表已创建');
    }
  });

  // ---------- 管理员操作审计日志 ----------
  await db.schema.hasTable('audit_logs').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('audit_logs', (t) => {
        t.increments('id').primary();
        t.integer('user_id').unsigned().nullable();
        t.string('username', 50).defaultTo('');
        t.string('action', 120).notNullable();
        t.string('detail', 200).defaultTo('');
        t.string('ip', 64).defaultTo('');
        t.string('fp', 128).defaultTo('');
        t.timestamp('created_at').defaultTo(db.fn.now());
        t.index('created_at');
      });
      console.log('[migrate] audit_logs 表已创建');
    }
  });

  // ---------- 访问统计（按日） ----------
  await db.schema.hasTable('visits').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('visits', (t) => {
        t.increments('id').primary();
        t.date('day').notNullable().unique(); // 日期 YYYY-MM-DD
        t.integer('pv').defaultTo(0);
        t.integer('uv').defaultTo(0);
      });
      console.log('[migrate] visits 表已创建');
    }
  });

  // ---------- 留言板 ----------
  await db.schema.hasTable('messages').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('messages', (t) => {
        t.increments('id').primary();
        t.string('nickname', 50).notNullable();
        t.string('email', 100).defaultTo('');
        t.string('content', 2000).notNullable();
        t.string('ip', 64).defaultTo(''); // 用于重复内容检测
        t.enum('status', ['pending', 'approved', 'rejected']).defaultTo('approved');
        t.string('ai_reason', 120).defaultTo(''); // AI 审核标记原因
        t.string('reply', 2000).defaultTo(''); // 站长回复
        t.timestamp('replied_at').nullable(); // 回复时间
        t.timestamp('created_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] messages 表已创建');
    } else {
      // 列补齐：确保 ai_reason 字段存在（老库升级）
      const cols = await db('messages').columnInfo();
      if (!cols.ai_reason) {
        await db.schema.alterTable('messages', (t) => t.string('ai_reason', 120).defaultTo(''));
        console.log('[migrate] messages.ai_reason 列已补齐');
      }
      if (!cols.reply) {
        await db.schema.alterTable('messages', (t) => {
          t.string('reply', 2000).defaultTo('');
          t.timestamp('replied_at').nullable();
        });
        console.log('[migrate] messages.reply 列已补齐（留言回复功能）');
      }
      if (!cols.ip) {
        await db.schema.alterTable('messages', (t) => {
          t.string('ip', 64).defaultTo('');
        });
        console.log('[migrate] messages.ip 列已补齐');
      }
    }
  });

  // ---------- IP 封禁持久化（重启不丢封禁） ----------
  await db.schema.hasTable('ip_bans').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('ip_bans', (t) => {
        t.string('ip', 64).primary();
        t.timestamp('banned_until').notNullable();
        t.integer('ban_count').defaultTo(1);
        t.string('reason', 120).defaultTo('');
        t.timestamp('updated_at').defaultTo(db.fn.now());
      });
      console.log('[migrate] ip_bans 表已创建');
    } else {
      // 老库升级：补齐 reason 列
      const cols = await db('ip_bans').columnInfo();
      if (!cols.reason) {
        await db.schema.alterTable('ip_bans', (t) => {
          t.string('reason', 120).defaultTo('');
        });
        console.log('[migrate] ip_bans.reason 列已补齐');
      }
    }
  });

  // ---------- UV 去重日志（持久化：重启后 UV 统计不虚高） ----------
  await db.schema.hasTable('visit_uv').then(async (exists) => {
    if (!exists) {
      await db.schema.createTable('visit_uv', (t) => {
        t.increments('id').primary();
        t.date('day').notNullable();
        t.string('h', 32).notNullable(); // sha256(day:ip:fp) 前 32 位，防明文 IP 留存
        t.unique(['day', 'h']);
      });
      console.log('[migrate] visit_uv 表已创建');
    }
  });

  // ---------- 索引优化（幂等：仅在缺失时创建） ----------
  async function ensureIndex(table, indexName, columns) {
    const exists = await db.schema.hasTable(table);
    if (!exists) return;
    const indexes = await db.raw(`SHOW INDEX FROM \`${table}\``).then(([rows]) => rows.map((r) => r.Key_name));
    if (!indexes.includes(indexName)) {
      await db.schema.alterTable(table, (t) => {
        t.index(columns, indexName);
      });
      console.log(`[migrate] ${table}.${indexName} 索引已创建`);
    }
  }

  await ensureIndex('articles', 'idx_articles_status_published_at', ['status', 'published_at']);
  await ensureIndex('articles', 'idx_articles_category_id', ['category_id']);
  // 详情页按 slug 查询（高频读路径）
  await ensureIndex('articles', 'idx_articles_slug', ['slug']);
  await ensureIndex('comments', 'idx_comments_article_status', ['article_id', 'status']);
  await ensureIndex('article_tags', 'idx_article_tags_tag_id', ['tag_id']);
  // 文章标签反查（列表/详情聚合）
  await ensureIndex('article_tags', 'idx_article_tags_article_id', ['article_id']);
  await ensureIndex('visits', 'idx_visits_day', ['day']);
  // UV 去重查询按 day
  await ensureIndex('visit_uv', 'idx_visit_uv_day', ['day']);
  await ensureIndex('sessions', 'idx_sessions_user_id', ['user_id']);
  // 每次认证按 jti 查会话（高频读路径）
  await ensureIndex('sessions', 'idx_sessions_jti', ['jti']);

  console.log('[migrate] 所有表已就绪 ✓');
}

// 仅直接运行时执行（npm run migrate）；被其他模块 require 时不触发
if (require.main === module) {
  migrate()
    .then(() => db.destroy())
    .catch((err) => {
      console.error('[migrate] 失败:', err.message);
      db.destroy();
      process.exit(1);
    });
}
module.exports = { migrate };
