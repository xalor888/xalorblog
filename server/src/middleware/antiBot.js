/**
 * 反爬虫中间件：
 * 1. 拦截已知爬虫/脚本 UA（浏览器 UA 放行，搜索引擎爬虫白名单放行）
 * 2. 前台高频抓取接口的 IP 限流
 * 3. honeypot 隐藏字段校验（配合表单）
 */

const rateLimit = require('express-rate-limit');
const { isSearchBot } = require('./gate');

/** 已知爬虫/脚本 UA 特征（小写匹配） */
const BOT_PATTERNS = [
  // 通用爬虫框架
  'python-requests', 'python-urllib', 'python-httpx', 'aiohttp', 'scrapy',
  'curl/', 'wget/', 'libwww-perl', 'http-client', 'okhttp', 'java/',
  'go-http-client', 'node-fetch', 'axios/', 'httpie', 'apachebench', 'ab/',
  'postman', 'insomnia', 'playwright', 'puppeteer', 'phantomjs', 'selenium',
  'headless', 'lighthouse', 'webdriver',
  // 采集/恶意
  'spider', 'crawler', 'semrush', 'ahrefs', 'mj12bot', 'dotbot',
  'dataforseo', 'claudebot', 'gptbot', 'ccbot',
  'anthropic-ai', 'facebookexternalhit',
];

const BROWSER_HINTS = ['mozilla', 'chrome', 'safari', 'edge', 'firefox', 'opera'];

/**
 * UA 判断：像浏览器的放行；明确的爬虫 UA 拦截；搜索引擎爬虫放行（利于收录）
 */
function isBotUserAgent(ua) {
  if (!ua) return true; // 无 UA 一律视为异常
  const lower = ua.toLowerCase();
  // 搜索引擎爬虫白名单优先放行
  if (isSearchBot(lower)) return false;
  if (BOT_PATTERNS.some((p) => lower.includes(p))) return true;
  // 声明是浏览器才放行
  return !BROWSER_HINTS.some((h) => lower.includes(h));
}

/** 反爬中间件（挂在前台公开接口上） */
function antiBot(req, res, next) {
  // 仅保护公开的读请求；写请求由认证 + 严格限流 + honeypot 保护
  if (req.method !== 'GET') return next();
  const ua = req.headers['user-agent'] || '';
  if (isBotUserAgent(ua)) {
    return res.status(403).json({ code: 1, message: '访问被拒绝' });
  }
  next();
}

/** 前台高频读取接口限流（每 IP 每 30 秒 40 次，防止批量抓取） */
const readLimiter = rateLimit({
  windowMs: 30 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 1, message: '读取过于频繁，请稍后再试' },
});

/** 表单 honeypot 校验：真实用户看不到该字段，机器人会填写 */
const HONEYPOT_FIELD = 'website_url';

function honeypotCheck(req, res, next) {
  if (req.body && req.body[HONEYPOT_FIELD]) {
    return res.status(403).json({ code: 1, message: '提交被拒绝' });
  }
  next();
}

module.exports = { antiBot, readLimiter, honeypotCheck, HONEYPOT_FIELD, isBotUserAgent };
