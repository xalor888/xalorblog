const knex = require('knex');
const config = require('./config');

// 动态服务器时区偏移（如中国 +08:00、UTC +00:00）：
// 必须与 utils/datetime.js 的本地时间生成逻辑一致，
// 否则在 UTC 等非 +08:00 服务器上存储的时间会整体偏差
function localTimezone() {
  const offsetMin = -new Date().getTimezoneOffset(); // getTimezoneOffset = UTC - 本地（分钟）
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

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
    // 强制禁用多语句（防御堆叠注入的最后一层保险）
    multipleStatements: false,
    // 直接返回日期字符串(YYYY-MM-DD HH:mm:ss)，避免 UTC 时区偏移
    dateStrings: true,
    connectTimeout: 10000,
    // SQL 模式加固：拒绝除零、严格模式
    flags: ['-LOCAL_FILES'],
    timezone: localTimezone(),
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
        // 会话时区按连接创建时刻实时计算：模块加载时计算的偏移在
        // DST 切换后过期（存量连接仍用旧偏移），连接级重设保证正确
        const tzOffset = localTimezone();
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
