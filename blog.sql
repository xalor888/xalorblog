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
USE xalor_blog;

-- 应用专用账号：纯 SQL 无法安全地从环境变量读取密码，因此必须先在本地副本中
-- 替换下面的显式占位值。占位值或弱值会触发 SIGNAL，绝不会创建可用的固定凭据。
-- 请勿把替换后的本地副本提交到 Git。
SET @xalor_db_password = '__REPLACE_WITH_A_STRONG_RANDOM_PASSWORD__';

DELIMITER //
DROP PROCEDURE IF EXISTS provision_xalor_app_user//
CREATE PROCEDURE provision_xalor_app_user(IN requested_password VARCHAR(255))
SQL SECURITY INVOKER
BEGIN
  IF requested_password IS NULL
     OR LEFT(requested_password, 15) = '__REPLACE_WITH_'
     OR CHAR_LENGTH(requested_password) < 20
     OR requested_password REGEXP '^[[:alnum:]]{1,19}$' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '先替换 blog.sql 中的数据库密码占位值（至少 20 位强随机密码）';
  END IF;

  SET @account_sql = CONCAT(
    'CREATE USER IF NOT EXISTS ''xalor''@''localhost'' IDENTIFIED BY ',
    QUOTE(requested_password)
  );
  PREPARE account_stmt FROM @account_sql;
  EXECUTE account_stmt;
  DEALLOCATE PREPARE account_stmt;

  SET @account_sql = CONCAT(
    'ALTER USER ''xalor''@''localhost'' IDENTIFIED BY ',
    QUOTE(requested_password)
  );
  PREPARE account_stmt FROM @account_sql;
  EXECUTE account_stmt;
  DEALLOCATE PREPARE account_stmt;

  SET @account_sql =
    'GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON xalor_blog.* TO ''xalor''@''localhost''';
  PREPARE account_stmt FROM @account_sql;
  EXECUTE account_stmt;
  DEALLOCATE PREPARE account_stmt;
END//

CALL provision_xalor_app_user(@xalor_db_password)//
DROP PROCEDURE provision_xalor_app_user//
DELIMITER ;

SET @account_sql = NULL;
SET @xalor_db_password = NULL;
