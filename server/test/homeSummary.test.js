/**
 * 主页首屏摘要白名单（无 DB / 无服务）
 * /api/home/summary 是本站唯一有意放宽的免票读接口，暴露面必须被锁死：
 * 这里直接驱动组装函数 buildSummary，断言「只有白名单字段」且密钥/正文一概不出。
 */
const { buildSummary, parseSocialExtra, runningDays, SUMMARY_FIELDS } = require('../src/routes/home');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ' | ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

// 假装成 getAllSettings() 的输出：故意塞进所有敏感键，验证「不会跟着 spread 漏出去」
const settings = {
  site_name: 'Xalor的小站',
  site_desc: '记录生活',
  avatar: '/logo.png',
  announcement: '欢迎',
  site_url: 'https://blog.xalor.cn',
  home_site_url: 'https://xalor.cn',
  about_content: '# 关于我\n\n这里是关于页内容。',
  home_about_excerpt: '',
  home_hero_greeting: "Hi, I'm",
  home_hero_role: '全栈',
  home_hero_quote: '保持好奇',
  home_status: 'online',
  home_since_date: '2026-01-01',
  social_github: 'https://github.com/xalor888',
  social_weibo: '',
  social_email: 'xalor888@gmail.com',
  home_social_extra: '[]',
  // 以下键绝不允许出现在免票接口里
  ai_api_key: 'sk-should-never-leak',
  websearch_api_key: 'tvly-should-never-leak',
  ai_system_prompt: 'secret prompt',
  icp: '京ICP备00000000号',
};

const summary = buildSummary({
  settings,
  links: [{ id: 1, name: 'Vue', url: 'https://cn.vuejs.org/', avatar: '', description: '渐进式框架' }],
  articleCount: 42,
  noteCount: 7,
  posts: [{ id: 9, title: '标题', slug: 'hello', summary: '摘要', cover: '', published_at: '2026-10-01 10:00:00' }],
});

assert('顶层字段与白名单完全一致', JSON.stringify(Object.keys(summary).sort()) === JSON.stringify([...SUMMARY_FIELDS].sort()),
  `实际: ${Object.keys(summary).join(',')}`);
assert('不含 site_url', !('site_url' in summary));
assert('备案号可用（页脚展示）', summary.icp === settings.icp);

// 深扫：任何层级出现密钥名或密钥值都算失败
const serialized = JSON.stringify(summary);
for (const forbidden of ['ai_api_key', 'websearch_api_key', 'ai_system_prompt', 'sk-should-never-leak', 'tvly-should-never-leak', 'secret prompt']) {
  assert(`深扫不含 ${forbidden}`, !serialized.includes(forbidden));
}
// 手记正文不在这个接口里（手记走闸门 + AES-GCM）
assert('不含手记正文字段', !('notes' in summary) && !('content' in summary));
assert('手记只以计数形式出现', summary.stats.note_count === 7);

assert('统计数值已归一化', summary.stats.article_count === 42 && typeof summary.stats.article_count === 'number');
assert('最近文章只带展示字段',
  JSON.stringify(Object.keys(summary.recent_posts[0]).sort()) === JSON.stringify(['cover', 'id', 'published_at', 'slug', 'summary', 'title']));
assert('友链只带展示字段',
  JSON.stringify(Object.keys(summary.links[0]).sort()) === JSON.stringify(['avatar', 'description', 'id', 'name', 'url']));
assert('hero 四个字段齐全', JSON.stringify(Object.keys(summary.hero).sort()) === JSON.stringify(['greeting', 'quote', 'role', 'status']));
assert('社交仅四项', JSON.stringify(Object.keys(summary.social).sort()) === JSON.stringify(['email', 'extra', 'github', 'weibo']));

console.log('\n=== 关于摘要回落 ===');
assert('留空时截取 about_content', summary.about_excerpt.includes('这里是关于页内容'));
const overridden = buildSummary({ settings: { ...settings, home_about_excerpt: '自定义摘要' }, links: [], posts: [] });
assert('显式覆盖优先生效', overridden.about_excerpt === '自定义摘要');

console.log('\n=== 社交扩展链接清洗 ===');
assert('非数组降级为空', parseSocialExtra('{"a":1}').length === 0);
assert('坏 JSON 降级为空', parseSocialExtra('{oops').length === 0);
assert('缺 label/url 的项被丢弃', parseSocialExtra('[{"label":"A"},{"url":"https://a.com"},{"label":"B","url":"https://b.com"}]').length === 1);
assert('超过 8 条被截断', parseSocialExtra(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ label: `L${i}`, url: `https://e${i}.com` })))).length === 8);
// 这些 URL 会直接进客户端 <a href>：只靠「保存时清洗」不够（设置表可能被直接改写）
assert('javascript: 被丢弃', parseSocialExtra('[{"label":"X","url":"javascript:alert(1)"}]').length === 0);
assert('data: 被丢弃', parseSocialExtra('[{"label":"X","url":"data:text/html,x"}]').length === 0);
assert('协议相对 //evil.com 被丢弃', parseSocialExtra('[{"label":"X","url":"//evil.com"}]').length === 0);
assert('http/https 正常保留', parseSocialExtra('[{"label":"A","url":"http://a.com"},{"label":"B","url":"https://b.com"}]').length === 2);

console.log('\n=== 运行天数 ===');
assert('非法值回落到 2024-01-01', runningDays('not-a-date') === runningDays(''));
assert('永远 >= 1', runningDays('2999-01-01') === 1);
assert('今天之前为正值', runningDays('2020-01-01') > 1000);

console.log(`\nhomeSummary 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
