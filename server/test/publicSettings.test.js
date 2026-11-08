const { stripCommentLines } = require('./helpers/sourceText');
/**
 * 公开设置接口的**密钥剔除**（零 DB、零服务）。
 *
 * `GET /api/settings` 是免票公开接口，前台首屏就要用它。而 `settings` 表里现在存着
 * `ai_api_key` 与 `websearch_api_key` —— 一旦它们随响应下发，任何人打开浏览器
 * 开发者工具就能拿到，然后拿去烧你的额度。
 *
 * 这条约束的写法很脆：靠的是 `const { ai_api_key, websearch_api_key, ...safe } = settings`
 * 这一行解构。将来如果有人加一个**新的密钥字段**（比如 `smtp_password`、
 * `s3_secret_key`），只要忘了同时加进这个解构，密钥立刻泄漏，而所有功能测试依然全绿
 * —— 「新字段泄漏」不会让任何现有断言变红。
 *
 * 所以这里除了断言两个已知键被剔除，还要断言「**表里所有看起来像密钥的键**都被剔除」，
 * 用一条按名字模式扫描的规则兜住未来新增的字段。
 *
 * 做法：替换 `utils/settings` 的 `getAllSettings` 后，从 express router 里取出真正的
 * handler 直接调用 —— 不是源码文本断言，是跑真实代码路径。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const path = require('path');
const { readFileSync } = require('fs');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

let fakeSettings = {};
/** 用闭包开关而不是「事后改 exports」：路由顶层 `const { getAllSettings } = require(...)`
 *  是**值拷贝**，改 exports 里的引用不会影响已经解构出去的那个函数。 */
let throwOnRead = false;
const settingsPath = require.resolve('../src/utils/settings');
const realSettings = require(settingsPath);
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    ...realSettings,
    getAllSettings: async () => {
      if (throwOnRead) throw new Error('模拟 DB 故障');
      return fakeSettings;
    },
  },
};

// smtpReady / config 也替换掉，让结果可控
const notifyPath = require.resolve('../src/utils/notifyMail');
require.cache[notifyPath] = { id: notifyPath, filename: notifyPath, loaded: true, exports: { smtpReady: () => false } };

delete require.cache[require.resolve('../src/routes/settings')];
const router = require('../src/routes/settings');
const routeLayer = router.stack.find((l) => l.route && l.route.path === '/');
const handler = routeLayer.route.stack[0].handle;

/** 跑一次 handler，返回 { status, body } */
async function callRoute() {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(payload) { out.body = payload; return res; },
  };
  await handler({ headers: {}, ip: '127.0.0.1' }, res, () => {});
  return out;
}

/** 「看起来像密钥」的键名模式 */
const SECRET_LIKE = /(api_key|secret|password|passwd|token|private_key|access_key)$/i;

async function run() {
  console.log('=== A. 密钥绝不能随公开接口下发 ===');
  {
    fakeSettings = {
      site_name: 'Xalor 的小站',
      site_desc: '描述',
      ai_api_key: 'sk-very-secret-should-not-leak',
      websearch_api_key: 'tvly-very-secret-should-not-leak',
    };
    const { body } = await callRoute();
    const data = body && body.data;
    check('接口成功返回', body && body.code === 0, JSON.stringify(body && body.code));
    check('data 是对象', data && typeof data === 'object');

    const json = JSON.stringify(data);
    check('ai_api_key 不在响应里', !('ai_api_key' in data));
    check('websearch_api_key 不在响应里', !('websearch_api_key' in data));
    // 双保险：连字符串化后也不许出现密钥原文（防止被包进别的字段里）
    check('响应里搜不到 ai 密钥原文', !json.includes('sk-very-secret-should-not-leak'));
    check('响应里搜不到搜索密钥原文', !json.includes('tvly-very-secret-should-not-leak'));

    check('普通字段正常透传', data.site_name === 'Xalor 的小站' && data.site_desc === '描述');
  }

  console.log('\n=== B. 未来新增的密钥字段也要被剔除（按名字模式兜底） ===');
  {
    // 这条断言的价值：现有实现只显式剔除两个已知键。
    // 加一个新的密钥字段却忘了加进解构 → 泄漏，且没有任何现有断言会红。
    fakeSettings = {
      site_name: 'X',
      smtp_password: 'smtp-secret',
      s3_secret_key: 's3-secret',
      github_token: 'gh-secret',
      r2_access_key: 'r2-secret',
      some_private_key: 'priv-secret',
    };
    const { body } = await callRoute();
    const data = body.data;
    const leaked = Object.keys(data).filter((k) => SECRET_LIKE.test(k));
    check('没有「看起来像密钥」的键被透传出去', leaked.length === 0, leaked.join(', '));

    const json = JSON.stringify(data);
    for (const v of ['smtp-secret', 's3-secret', 'gh-secret', 'r2-secret', 'priv-secret']) {
      if (json.includes(v)) leaked.push(`值泄漏:${v}`);
    }
    check('这些字段的值也都没出现在响应里', leaked.length === 0, leaked.join(', '));

    // 这道防线这次做过一次结构性加固：原来只显式剔除 `ai_api_key` / `websearch_api_key`
    // 两个已知键（逐键解构），新增密钥字段漏改一行就泄漏且无任何断言会红。
    // 现在改成按名字模式过滤，默认安全。若以下断言变红，说明有人改回了逐键解构。
  }

  console.log('\n=== B2. 正则不许误伤合法设置键 ===');
{
  // 过滤改成模式匹配的**代价**是可能误剔「名字像密钥但确实该公开」的字段。
  // 当前 DEFAULT_SETTINGS 的 39 个键里，应该恰好只有那两个密钥被剔 —— 多一个就是误伤。
  const { DEFAULT_SETTINGS } = realSettings;
  // 剥注释：下面有一条否定断言（不许出现逐键解构），如果注释里写了反例会假红
  const src = stripCommentLines(readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings.js'), 'utf8'));
  const m = src.match(/const SECRET_KEY_RE = \/(.+)\/i;/);
  check('路由里有 SECRET_KEY_RE 常量', !!m);
  const re = new RegExp(m[1], 'i');
  const filtered = Object.keys(DEFAULT_SETTINGS).filter((k) => re.test(k)).sort();
  check('默认设置里恰好只有 ai_api_key 与 websearch_api_key 被过滤（零误伤）',
    JSON.stringify(filtered) === JSON.stringify(['ai_api_key', 'websearch_api_key']),
    filtered.join(', '));
  check('且确实是按模式过滤而不是逐键解构（防回退）',
    /SECRET_KEY_RE\.test\(k\)/.test(src) && !/ai_api_key: _k1/.test(src));
}

console.log('\n=== C. 就绪标记：只表达"配好没"，不含密钥 ===');
  {
    fakeSettings = {
      ai_api_key: 'sk-x',
      ai_base_url: 'https://api.example.com/v1',
      websearch_api_key: 'tvly-x',
    };
    const { body } = await callRoute();
    const data = body.data;
    check('key + https 地址 → ai_llm_ready 为 true', data.ai_llm_ready === true);
    check('有搜索 key → websearch_ready 为 true', data.websearch_ready === true);
    check('就绪标记是布尔值', typeof data.ai_llm_ready === 'boolean' && typeof data.websearch_ready === 'boolean');

    fakeSettings = { ai_api_key: 'sk-x', ai_base_url: 'http://insecure.example.com/v1' };
    const d2 = (await callRoute()).body.data;
    check('key 有但地址是 http → ai_llm_ready 为 false（必须 https）', d2.ai_llm_ready === false);

    fakeSettings = { ai_base_url: 'https://api.example.com/v1' };
    const d3 = (await callRoute()).body.data;
    check('地址合规但没 key → ai_llm_ready 为 false', d3.ai_llm_ready === false);

    fakeSettings = {};
    const d4 = (await callRoute()).body.data;
    check('什么都没配 → 两个 ready 都是 false',
      d4.ai_llm_ready === false && d4.websearch_ready === false);
  }

  console.log('\n=== D. 其他系统字段 ===');
  {
    fakeSettings = { site_name: 'S' };
    const { body } = await callRoute();
    const data = body.data;
    check('mail_notify 来自 smtpReady()', data.mail_notify === false);
    // 前端相对时间显示要按这个偏移校正，否则非服务器时区的访客看到的"x 分钟前"整体偏移
    check('server_tz_offset_min 是数字', typeof data.server_tz_offset_min === 'number',
      typeof data.server_tz_offset_min);
    check('server_tz_offset_min 在合理范围（-840 ~ 840 分钟）',
      Math.abs(data.server_tz_offset_min) <= 840);
  }

  console.log('\n=== E. 失败路径 ===');
  {
    throwOnRead = true;
    const { status, body } = await callRoute();
    check('读设置抛错 → 500', status === 500, String(status));
    check('错误响应是统一的 {code:1, message}', body && body.code === 1 && typeof body.message === 'string');
    check('错误信息不泄漏内部细节', !/模拟 DB 故障/.test(body.message || ''), body.message);
    // 恢复
    throwOnRead = false;
  }

  console.log(`\npublicSettings 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
