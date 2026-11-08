/**
 * AI 配置解析与参数钳制（零网络、零 DB）。
 *
 * `getAiConfig()` 是**所有** AI 调用的唯一入口（写作助手、读者问答、内容审核、网页搜索摘要），
 * 它把后台设置表 + env 合成一份最终参数。这里有几类错误后果不对称：
 *
 * - `temperature` / `maxTokens` 越界不会被上游拒绝，只会**表现异常**
 *   （温度过高答非所问、max_tokens 过大被账单打脸），排查时会怀疑模型而不是这里；
 * - `ctxChars` / `ctxTurns` 决定塞多少上下文，错了是「AI 变笨/变贵」，同样不报错；
 * - `ready` 是唯一开关：它算错，要么功能不可用（key 有、地址好却显示未配置），
 *   要么允许一次必然 401 的调用。
 *
 * 做法：替换 `utils/settings` 的 `getAllSettings` 后再 require `aiClient`，
 * 让它拿到的是替身 —— 这样能真跑 `getAiConfig` 的每条分支，而不是源码文本断言。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const path = require('path');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 替身：settings 里返回什么由这个变量控制 */
let fakeSettings = {};
const settingsPath = require.resolve('../src/utils/settings');
const realSettings = require(settingsPath);
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    ...realSettings,
    getAllSettings: async () => fakeSettings,
  },
};
delete require.cache[require.resolve('../src/utils/aiClient')];
const { getAiConfig } = require('../src/utils/aiClient');

const withSettings = async (s) => { fakeSettings = s; return getAiConfig(); };

async function run() {
  console.log('=== A. temperature 钳制在 0–2 ===');
  {
    const cases = [
      ['留空 → 默认 0.7', {}, 0.7],
      ['0 → 0', { ai_temperature: 0 }, 0],
      ['2 → 2', { ai_temperature: 2 }, 2],
      ['字符串 "1.5" → 1.5', { ai_temperature: '1.5' }, 1.5],
      ['超上界 2.1 → 默认', { ai_temperature: 2.1 }, 0.7],
      ['负值 -0.1 → 默认', { ai_temperature: -0.1 }, 0.7],
      ['垃圾值 → 默认', { ai_temperature: 'hot' }, 0.7],
      ['null → 默认', { ai_temperature: null }, 0.7],
    ];
    for (const [name, s, want] of cases) {
      const c = await withSettings(s);
      check(`temperature ${name}`, c.temperature === want, `got ${c.temperature}`);
    }
  }

  console.log('\n=== B. maxTokens 钳制在 256–8192 ===');
  {
    const cases = [
      ['留空 → 4096', {}, 4096],
      ['256 → 256（下界含）', { ai_max_tokens: 256 }, 256],
      ['8192 → 8192（上界含）', { ai_max_tokens: 8192 }, 8192],
      ['255 → 默认（下界外）', { ai_max_tokens: 255 }, 4096],
      ['8193 → 默认（上界外）', { ai_max_tokens: 8193 }, 4096],
      ['负数 → 默认', { ai_max_tokens: -100 }, 4096],
      ['小数被 parseInt 截断', { ai_max_tokens: '1024.9' }, 1024],
    ];
    for (const [name, s, want] of cases) {
      const c = await withSettings(s);
      check(`maxTokens ${name}`, c.maxTokens === want, `got ${c.maxTokens}`);
    }
  }

  console.log('\n=== C. 上下文参数 ===');
  {
    const ctxCases = [
      ['ctxChars 留空 → 20000', {}, 'ctxChars', 20000],
      ['ctxChars 1000（下界）', { ai_ctx_chars: 1000 }, 'ctxChars', 1000],
      ['ctxChars 100000（上界）', { ai_ctx_chars: 100000 }, 'ctxChars', 100000],
      ['ctxChars 999 → 默认', { ai_ctx_chars: 999 }, 'ctxChars', 20000],
      ['ctxChars 100001 → 默认', { ai_ctx_chars: 100001 }, 'ctxChars', 20000],
      ['ctxTurns 留空 → 48', {}, 'ctxTurns', 48],
      ['ctxTurns 6（下界）', { ai_ctx_turns: 6 }, 'ctxTurns', 6],
      ['ctxTurns 200（上界）', { ai_ctx_turns: 200 }, 'ctxTurns', 200],
      ['ctxTurns 5 → 默认', { ai_ctx_turns: 5 }, 'ctxTurns', 48],
      ['ctxTurns 201 → 默认', { ai_ctx_turns: 201 }, 'ctxTurns', 48],
    ];
    for (const [name, s, field, want] of ctxCases) {
      const c = await withSettings(s);
      check(name, c[field] === want, `got ${c[field]}`);
    }

    // ctxCompress 默认开：只认显式 false
    check('ctxCompress 默认 true', (await withSettings({})).ctxCompress === true);
    check('显式 false 才关', (await withSettings({ ai_ctx_compress: false })).ctxCompress === false);
    check('字符串 "false" **不**关（只认布尔，避免存成字符串后意外关掉）',
      (await withSettings({ ai_ctx_compress: 'false' })).ctxCompress === true);
  }

  console.log('\n=== D. baseUrl 归一 ===');
  {
    check('去掉末尾斜杠', (await withSettings({ ai_base_url: 'https://a.com/v1///' })).baseUrl === 'https://a.com/v1');
    check('去掉前后空白', (await withSettings({ ai_base_url: '  https://a.com/v1  ' })).baseUrl === 'https://a.com/v1');
    check('留空回落到 config.ai.baseUrl',
      (await withSettings({})).baseUrl === require('../src/config').ai.baseUrl);
    check('设置优先于 config',
      (await withSettings({ ai_base_url: 'https://mine.com/v1' })).baseUrl === 'https://mine.com/v1');
  }

  console.log('\n=== E. ready 是唯一开关：key 与地址必须同时成立 ===');
  {
    check('有 key + https 地址 → ready',
      (await withSettings({ ai_api_key: 'sk-test-123', ai_base_url: 'https://a.com/v1' })).ready === true);
    check('有 key 但地址是 http（生产）→ not ready',
      (await (async () => {
        const orig = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try { return withSettings({ ai_api_key: 'sk-test-123', ai_base_url: 'http://a.com/v1' }); }
        finally { process.env.NODE_ENV = orig; }
      })()).ready === false);
    check('地址好但没 key → not ready',
      (await withSettings({ ai_base_url: 'https://a.com/v1' })).ready === false);
    check('key 只有空白 → not ready',
      (await withSettings({ ai_api_key: '   ' })).ready === false);
    check('两者都没有 → not ready 且 apiKey 为空串',
      (await (async () => {
        const c = await withSettings({});
        return c.apiKey === '' && c.ready === false;
      })()));
  }

  console.log('\n=== F. apiKey / model / systemPrompt 的清洗 ===');
  {
    check('apiKey 去前后空白', (await withSettings({ ai_api_key: '  sk-abc  ' })).apiKey === 'sk-abc');
    check('model 去前后空白', (await withSettings({ ai_model: '  gpt-4o  ' })).model === 'gpt-4o');
    check('model 留空回落 config', (await withSettings({})).model === require('../src/config').ai.model);
    check('systemPrompt 去前后空白',
      (await withSettings({ ai_system_prompt: '  你是助手  ' })).systemPrompt === '你是助手');
    // 人设过长会挤掉上下文，且它每次请求都发 —— 3000 字上限是成本保护
    check('systemPrompt 截断到 3000 字',
      (await withSettings({ ai_system_prompt: 'x'.repeat(5000) })).systemPrompt.length === 3000);
    check('systemPrompt 留空是空串（不是 undefined）',
      (await withSettings({})).systemPrompt === '');
  }

  console.log('\n=== G. 返回值形状稳定（消费方靠解构） ===');
  {
    const c = await withSettings({});
    const want = ['apiKey', 'baseUrl', 'model', 'temperature', 'maxTokens',
      'systemPrompt', 'ctxChars', 'ctxTurns', 'ctxCompress', 'ready'];
    check('包含全部 10 个字段', want.every((k) => Object.prototype.hasOwnProperty.call(c, k)),
      want.filter((k) => !(k in c)).join(', '));
    check('没有多余字段泄漏（尤其不该带出 api_key 原文）',
      Object.keys(c).length === want.length, Object.keys(c).join(','));
    check('temperature/maxTokens/ctxChars/ctxTurns 都是 number',
      ['temperature', 'maxTokens', 'ctxChars', 'ctxTurns'].every((k) => typeof c[k] === 'number'));
    check('ready 是 boolean', typeof c.ready === 'boolean');
  }

  console.log(`\naiConfig 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
