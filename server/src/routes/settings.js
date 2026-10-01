const express = require('express');
const { ok, fail } = require('../utils/response');
const { getAllSettings } = require('../utils/settings');
const { smtpReady } = require('../utils/notifyMail');
const config = require('../config');

const router = express.Router();

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
    const { ai_api_key: _key, ...safe } = settings;
    return ok(res, {
      ...safe,
      mail_notify: smtpReady(),
      ai_llm_ready: !!(aiKey && /^https:\/\//i.test(String(aiBase || ''))),
      server_tz_offset_min: new Date().getTimezoneOffset(),
    });
  } catch (e) {
    return fail(res, '获取设置失败', 500);
  }
});

module.exports = router;
