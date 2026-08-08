-- ============================================
-- Xalor的小站 - MySQL 数据库初始化脚本
-- 作用: 建库 + 建用户（与 server 配置一致）
-- 执行: mysql -u root < blog.sql
-- 提示: 表结构由 server/src/migrate.js 自动创建，
--       种子数据由 server/src/seed.js 写入，无需手动建表
-- ============================================

CREATE DATABASE IF NOT EXISTS xalor_blog
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 应用专用账号（本地开发用，密码可自行修改）
-- ⚠ 生产部署必须修改密码（默认值公开于仓库）：CREATE USER 后立即执行
--   ALTER USER 'xalor'@'localhost' IDENTIFIED BY '<强随机密码>';
--   并同步 server/.env 的 DB_PASSWORD
CREATE USER IF NOT EXISTS 'xalor'@'localhost' IDENTIFIED BY 'xalor2026';
-- 最小权限：应用运行所需的 DML + 迁移所需的 DDL（应用不含 DROP 表操作，
-- 无需 DROP 权限；备份恢复/表结构重建由 root 或运维账号执行）
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON xalor_blog.* TO 'xalor'@'localhost';
FLUSH PRIVILEGES;
