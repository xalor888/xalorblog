const express = require('express');
const { ok, fail } = require('../utils/response');
const { getAllSettings } = require('../utils/settings');

const router = express.Router();

/** 站点设置（公开，仅读；保存接口在秘钥路径 /api/<adminPath>/settings）
 * server_tz_offset_min：服务器本地时区偏移（分钟，UTC-本地，如中国 -480）。
 * 数据库中时间均为服务器本地时间字符串（无时区后缀），前端相对时间显示
 * 需按此偏移校正 —— 否则非服务器时区访客看到的「x 分钟前」会整体偏移 */
router.get('/', async (req, res) => {
  try {
    const settings = await getAllSettings();
    return ok(res, {
      ...settings,
      server_tz_offset_min: new Date().getTimezoneOffset(),
    });
  } catch (e) {
    return fail(res, '获取设置失败', 500);
  }
});

module.exports = router;
