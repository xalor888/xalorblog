/**
 * 反垃圾内容过滤：高置信敏感词硬拒 + 链接数量限制
 * 原则：硬拒只保留广告/违法/欺诈特征明确的词；
 * 歧义词（兼职/刷单/返利/代购/信用卡/中奖等正常讨论也可能出现）不在此硬拒，
 * 交由 AI 审核评分层（aiModeration）按上下文判 pending 人工复核，避免误伤真实访客。
 * 拉丁词（vx/weixin 等）一律词边界匹配：vxworks 不命中 vx。
 * 安全中心可追加自定义敏感词与豁免词（securitySettings）。
 */

const securitySettings = require('./securitySettings');

// 高置信敏感词（命中即拒）
const SENSITIVE_WORDS = [
  // 广告类（联系方式引流）
  '加微信', '加qq', '加Q', 'vx', '薇信', '威信号', '微信号', 'weixin', 'wechat',
  '私聊我', '私信我', '联系客服',
  // 博彩违法
  '博彩', '赌博', '六合彩', '电竞下注', '开奖', '走势图',
  // 灰色服务
  '套现', '办证', '代开发票',
  // 色情
  '色情', '裸聊', '约炮', '一夜情', '迷药', '催情', '援交', '包养',
  // 垃圾外链服务
  'seo优化', '百度推广', '排名优化',
];

/** 拉丁词表：词边界匹配，避免子串误伤（method 不命中 eth） */
const LATIN_WORD_RE = /^[a-z0-9+]+$/i;

/** 检测内容是否含敏感词，返回命中的词列表 */
function checkSensitive(text) {
  if (typeof text !== 'string' || !text.length) return [];
  const lower = text.toLowerCase();
  const words = SENSITIVE_WORDS.concat(securitySettings.getCustomWords());
  const hits = [];
  for (const w of words) {
    const word = String(w || '').toLowerCase();
    if (!word) continue;
    const matched = LATIN_WORD_RE.test(word)
      ? new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`, 'i').test(lower)
      : lower.includes(word);
    // 豁免词：文本同时包含豁免词时跳过该敏感词判定（如「回收」豁免「垃圾回收」）
    if (matched && !securitySettings.isAllowedText(text, word)) hits.push(w);
  }
  return hits;
}

/** 统计内容中的 URL 链接数量（http/https 或裸 www. 域名）
 * 裸域名是经典绕过变体（「看看 www.spam.com」无协议）—— 不计入则
 * 2 个 www 链接逃过硬拒层，且审核层裸域计分（10 分/个）不足 pending
 * 阈值 → 与 http 链接行为不一致的垃圾通道 */
function countLinks(text) {
  if (typeof text !== 'string') return 0;
  const matches = text.match(/https?:\/\/[^\s]+|www\.[a-z0-9-]+(\.[a-z0-9-]+)+[^\s]*/gi);
  return matches ? matches.length : 0;
}

/** 反垃圾校验：返回 { ok, reason } */
function antiSpam(text, maxLinks = 3) {
  const hits = checkSensitive(text);
  if (hits.length) {
    return { ok: false, reason: `内容包含不当关键词：${hits[0]}` };
  }
  const links = countLinks(text);
  if (links > maxLinks) {
    return { ok: false, reason: `内容中链接过多（${links} 个，最多 ${maxLinks} 个）` };
  }
  return { ok: true };
}

module.exports = { checkSensitive, countLinks, antiSpam, SENSITIVE_WORDS };
