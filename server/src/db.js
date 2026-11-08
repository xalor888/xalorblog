const knex = require('knex');
const config = require('./config');

// 数据库会话时区 = **站点时区**（SITE_TZ 推导），不是进程时区。
//
// 必须与 utils/datetime.js 的本地时间生成逻辑完全一致，否则会出现一个只在
// 非 +08:00 服务器上暴露的错位：
//   - `comments.created_at` 是 `timestamp DEFAULT CURRENT_TIMESTAMP`，值由**这个会话时区**决定；
//   - 而评论/留言的 30 分钟查重用的是 `localDateTimeStr()`（固定 SITE_TZ）生成的比较值。
// 服务器跑在 UTC 时两者差 8 小时，查重窗口整体平移 → 重复提交不再被拦，
// 而功能表现毫无异常（只是拦截失效）。读进程时区的版本在本机（+08:00）看不出问题，
// 所以这件事只能靠「两处共用同一来源」来保证，而不是靠人记得对齐。
const { siteTimezoneOffset } = require('./utils/datetime');

const db = knex({
  client: 'mysql2',
  connection: {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    // utf8mb4 字符集 + unicode_ci 排序规则：与 blog.sql 建库排序规则一致
    // （emoji 4 字节存储、中文排序正确）。注意 charset 只能填字符集名，
    // 排序规则在 afterCreate 中通过 SET NAMES 指定 —— 若把排序规则名填进
    // charset，Knex 生成建表 DDL 时会输出 `default charset utf8mb4_unicode_ci`
    // 导致 `Unknown character set` 建表失败
    charset: 'utf8mb4',
    supportBigNumbers: true,
    // 显式写出 mysql2 的默认值（false）：这不是"额外保险"，而是把"不允许堆叠语句"
    // 固化成代码里的显式约定 —— 真出现堆叠注入时，它是唯一能让第二条语句直接报错的地方。
    multipleStatements: false,
    // 直接返回日期字符串(YYYY-MM-DD HH:mm:ss)，避免 UTC 时区偏移
    dateStrings: true,
    connectTimeout: 10000,
    // 禁掉客户端 `LOAD DATA LOCAL INFILE`（mysql2 默认允许，可被恶意服务端诱导读本地文件）。
    // 严格 SQL 模式不在这里设 —— 它是会话级设置，见下方 afterCreate 的 SET SESSION sql_mode。
    flags: ['-LOCAL_FILES'],
    timezone: siteTimezoneOffset(),
  },
  pool: {
    min: 0,
    max: 10,
    idleTimeoutMillis: 30000,
    // 获取连接超时 10s：瞬时高并发排队时不至于悬挂 60s（knex 默认），
    // 超时后返回 500 而非无限等待
    acquireTimeoutMillis: 10000,
    createTimeoutMillis: 10000,
    destroyTimeoutMillis: 10000,
    // 连接错误快速失败，避免排队堆积
    afterCreate: (conn, done) => {
      // 连接字符集/排序规则显式指定（utf8mb4_unicode_ci），并启用严格 SQL 模式
      conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci', (err1) => {
        if (err1) return done(err1, conn);
        // 会话时区按**连接创建时刻**重新计算：模块加载时算出的偏移在 DST 切换后
        // 会过期（存量连接仍用旧偏移）。SITE_TZ 是 Asia/Shanghai（无 DST），
        // 但保持「每连接重算」的写法，将来换成有 DST 的时区也不会引入偏差。
        const tzOffset = siteTimezoneOffset();
        conn.query(`SET SESSION time_zone = '${tzOffset}'`, (err2) => {
          if (err2) return done(err2, conn);
          conn.query('SET SESSION sql_mode = "STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"', (err) => {
            done(err, conn);
          });
        });
      });
    },
  },
});

module.exports = db;
