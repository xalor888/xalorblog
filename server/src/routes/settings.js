const express = require('express');
const { ok, fail } = require('../utils/response');
const { getAllSettings } = require('../utils/settings');
const { smtpReady } = require('../utils/notifyMail');
const config = require('../config');

const router = express.Router();

/**
 * 「看起来像密钥」的键名模式。
 *
 * 用后缀匹配而不是精确键名：精确键名漏一个就泄漏，后缀匹配默认安全。
 * 名单覆盖常见的密钥命名（`*_api_key` / `*_secret` / `*_secret_key` / `*_access_key` /
 * `*_private_key` / `*_password` / `*_token`）。
 */
const SECRET_KEY_RE = /(api_key|apikey|secret_key|access_key|private_key|secret|password|passwd|token)$/i;

/** 站点设置（公开，仅读；保存接口在秘钥路径 /api/<adminPath>/settings）
 * server_tz_offset_min：服务器本地时区偏移（分钟，UTC-本地，如中国 -480）。
 * 数据库中时间均为服务器本地时间字符串（无时区后缀），前端相对时间显示
 * 需按此偏移校正 —— 否则非服务器时区访客看到的「x 分钟前」会整体偏移
 * ai_llm_ready：AI 深度复核是否已具备生效条件（配了 key 且 baseUrl 是 https）。
 * 与 mail_notify 同类，只是让后台能显示「这一项配好没」，不含任何密钥。
 *
 * 安全：settings 里现在含 ai_api_key，**必须在展开前剔除** —— 否则密钥会随公开接口下发。 */
router.get('/', async (req, res) => {
  try {
    const settings = await getAllSettings();
    // 模型配置优先级与 aiModeration 保持一致：后台设置 > 服务器 .env
    const aiKey = settings.ai_api_key || config.ai?.apiKey || '';
    const aiBase = settings.ai_base_url || config.ai?.baseUrl || '';
    // 安全：含密钥的键必须在展开前剔除，否则会随公开接口下发。
    //
    // ⚠ 这里从「硬编码两个键名」改成「按名字模式过滤」。原因是硬编码的写法会**静默失效**：
    // 将来往 settings 表里加一个新密钥（`smtp_password`、`github_token`、`s3_secret_key`…）
    // 而忘了同时改这一行，密钥立刻随公开接口下发，而所有现有测试依然全绿
    // —— 「新字段泄漏」不会让任何既有断言变红。
    // 改成正则后默认就是安全的：新增的密钥字段只要名字像密钥就会被自动剔除。
    // 反向成本是「名字像密钥但确实该公开」的字段会被误剔 —— 那种情况请显式白名单，
    // 而不是回到逐键解构（后者漏一个就泄漏）。
    const safe = {};
    for (const [k, v] of Object.entries(settings)) {
      if (SECRET_KEY_RE.test(k)) continue;
      safe[k] = v;
    }
    const webKey = settings.websearch_api_key || config.websearch?.apiKey || '';
    return ok(res, {
      ...safe,
      mail_notify: smtpReady(),
      ai_llm_ready: !!(aiKey && /^https:\/\//i.test(String(aiBase || ''))),
      websearch_ready: !!webKey,
      server_tz_offset_min: new Date().getTimezoneOffset(),
    });
  } catch (e) {
    return fail(res, '获取设置失败', 500);
  }
});

module.exports = router;
