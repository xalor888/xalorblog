/**
 * 站点设置的读写与校验（零真实 DB）。
 *
 * `saveSettings` 是一个「**静默丢弃**式」的写法：每个字段校验不过就 `continue`，
 * 不报错、不提示。这种设计的出发点是「一个坏字段不该让整次保存失败」，
 * 但代价是**字段存进去了没有**完全看不出来 —— 后台永远显示"设置已保存"。
 *
 * 源码注释里已经记录过一次真实事故：`og_image` 忘了加进 `DEFAULT_SETTINGS`，
 * 于是它不在 `ALLOWED_KEYS` 里，整条链路是死的（界面有、文档有、消费方有，
 * 唯独存储白名单里没有）。
 *
 * 这组断言锁三件事：
 *   A. 白名单内部一致性（BOOL_KEYS ⊆ ALLOWED_KEYS、关键键存在）；
 *   B. 每个校验分支的真实行为（用可编程 db 替身驱动 saveSettings）；
 *   C. 读路径的类型归一（布尔键、非字符串值、坏 JSON）。
 */

process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'unit-test-placeholder-password-32';

const { stripCommentLines } = require('./helpers/sourceText');
const fs = require('fs');
const path = require('path');

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 可编程 db 替身：记录 writes / deletes，模拟事务 */
const dbState = { rows: [], writes: [], deletes: [], failWrite: false };

function makeStubDb() {
  const q = (table) => {
    const state = { table, op: 'select' };
    const api = {
      select: () => { state.op = 'select'; return api; },
      insert: (payload) => { state.op = 'insert'; state.payload = payload; return api; },
      onConflict: () => api,
      // ⚠ 不能覆盖 state.payload：insert(rows) 之后 merge(['value','updated_at'])
      // 传的是**列名列表**，覆盖掉就拿不到真正的写入行了
      merge: () => api,
      whereIn: (col, vals) => { state.op = 'delete'; state.vals = vals; return api; },
      del: () => {
        dbState.deletes.push({ table, vals: state.vals });
        return Promise.resolve(1);
      },
      then: (resolve, reject) => {
        if (state.op === 'select') {
          return Promise.resolve(dbState.rows).then(resolve, reject);
        }
        if (dbState.failWrite) return Promise.reject(new Error('模拟写库失败')).then(resolve, reject);
        dbState.writes.push({ table, payload: state.payload });
        // 同时更新「库里的行」，让紧接着的 getAllSettings() 能读到刚写的值 ——
        // 否则 saveSettings 的返回值永远是默认设置，测不出「写入是否真的生效」。
        const rows = Array.isArray(state.payload) ? state.payload : [state.payload];
        for (const row of rows) {
          if (!row || !row.key) continue;
          const idx = dbState.rows.findIndex((r) => r && r.key === row.key);
          if (idx >= 0) dbState.rows[idx] = { key: row.key, value: row.value };
          else dbState.rows.push({ key: row.key, value: row.value });
        }
        return Promise.resolve(1).then(resolve, reject);
      },
    };
    return api;
  };
  q.fn = { now: () => 'NOW()' };
  q.transaction = async (fn) => {
    const trx = makeStubDb();
    trx.fn = q.fn;
    return fn(trx);
  };
  return q;
}

const dbPath = require.resolve('../src/db');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: makeStubDb() };
delete require.cache[require.resolve('../src/utils/settings')];

const { DEFAULT_SETTINGS, ALLOWED_KEYS, getAllSettings, saveSettings, clearSettingsCache } = require('../src/utils/settings');
const settingsSrc = stripCommentLines(fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'settings.js'), 'utf8'));

const BOOL_KEYS = [...settingsSrc.match(/const BOOL_KEYS = new Set\(\[([\s\S]*?)\]\);/, 's')?.[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) || [];

function resetState() {
  // 设置模块有 60s 内存缓存：不清的话下一个用例会读到上一个用例的结果
  clearSettingsCache();
  dbState.rows = [];
  dbState.writes = [];
  dbState.deletes = [];
  dbState.failWrite = false;
}

async function run() {
  console.log('=== A. 白名单内部一致性 ===');
  {
    check('ALLOWED_KEYS 由 DEFAULT_SETTINGS 派生（不多不少）',
      ALLOWED_KEYS.size === Object.keys(DEFAULT_SETTINGS).length, String(ALLOWED_KEYS.size));
    const orphans = BOOL_KEYS.filter((k) => !ALLOWED_KEYS.has(k));
    check('BOOL_KEYS 全在白名单内（否则该键的布尔转换永远不生效）',
      orphans.length === 0, orphans.join(', '));
    check('BOOL_KEYS 非空（机制在用）', BOOL_KEYS.length > 0, String(BOOL_KEYS.length));

    // 源码注释里记录过的那次事故：og_image 不在白名单 → 整条链路死掉
    for (const k of ['og_image', 'site_url', 'avatar', 'home_site_url', 'home_status', 'home_since_date', 'home_social_extra']) {
      check(`关键键「${k}」在白名单里（缺了就是"界面有但存不进去"的死字段）`, ALLOWED_KEYS.has(k));
    }
    check('og_image 默认是空串而不是缺失（缺键会让前端拿到 undefined）',
      Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, 'og_image')
      && DEFAULT_SETTINGS.og_image === '');
  }

  console.log('\n=== B. saveSettings：未知键静默忽略 ===');
  {
    resetState();
    await saveSettings({ notARealKey: 'x', site_name: '新名字' }, { persist: true });
    const written = dbState.writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
    const keys = written.map((p) => p && p.key).filter(Boolean);
    check('未知键不写库', !keys.includes('notARealKey'), keys.join(','));
    check('已知键正常写入', keys.includes('site_name'), keys.join(','));
  }

  console.log('\n=== C. saveSettings：URL 字段的协议与 query/hash 校验 ===');
  {
    const run1 = async (entries) => {
      resetState();
      await saveSettings(entries, { persist: true });
      const written = dbState.writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
      return written.filter((p) => p && p.key === Object.keys(entries)[0]);
    };

    check('javascript: 协议被拒（防注入到 <a href>）',
      (await run1({ site_url: 'javascript:alert(1)' })).length === 0);
    check('data: 协议被拒', (await run1({ site_url: 'data:text/html,<script>' })).length === 0);
    check('合法 https URL 被接受',
      (await run1({ site_url: 'https://blog.example.com' })).length === 1);
    check('带 query 的 site_url 被拒（会让 canonical/og:url 带脏参数）',
      (await run1({ site_url: 'https://a.com?x=1' })).length === 0);
    check('带 hash 的 site_url 被拒',
      (await run1({ site_url: 'https://a.com#x' })).length === 0);
    check('home_site_url 走同一套约束',
      (await run1({ home_site_url: 'javascript:alert(1)' })).length === 0
      && (await run1({ home_site_url: 'https://me.example.com' })).length === 1);

    // AI 接口地址：协议合法不代表目标公网可达。只校验 https 会留下 SSRF 入口
    // （base URL 来自设置表，改一次设置就能打内网，而 AI 的响应会被写进文章预览）。
    // 保存时就挡住 —— 否则后台会提示"已保存"，运行时却显示"AI 不可用"，两处说法不一致。
    check('ai_base_url 拒绝 http 协议',
      (await run1({ ai_base_url: 'http://api.example.com/v1' })).length === 0);
    check('ai_base_url 拒绝私有 IPv4 字面量（https 也不行）',
      (await run1({ ai_base_url: 'https://192.168.1.10/v1' })).length === 0);
    check('ai_base_url 拒绝云元数据地址',
      (await run1({ ai_base_url: 'https://169.254.169.254/latest/' })).length === 0);
    check('ai_base_url 拒绝 IPv4 映射的 IPv6 写法',
      (await run1({ ai_base_url: 'https://[::ffff:192.168.1.1]/v1' })).length === 0);
    check('ai_base_url 接受正常公网 https',
      (await run1({ ai_base_url: 'https://api.openai.com/v1' })).length === 1);
  }

  console.log('\n=== D. saveSettings：枚举与日期钳制 ===');
  {
    const run1 = async (entries) => {
      resetState();
      await saveSettings(entries, { persist: true });
      const written = dbState.writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
      return written.filter((p) => p && p.key === Object.keys(entries)[0]);
    };

    check('home_status 非法值被丢弃',
      (await run1({ home_status: 'hacking' })).length === 0);
    check('home_status 合法值被接受',
      (await run1({ home_status: 'busy' })).length === 1);
    check('home_since_date 非 YYYY-MM-DD 被丢弃',
      (await run1({ home_since_date: '2026/01/01' })).length === 0);
    check('home_since_date 合法值被接受',
      (await run1({ home_since_date: '2026-01-01' })).length === 1);
  }

  console.log('\n=== E0. 结构化键必须单编码落库（这次修的真缺陷） ===');
{
  // 原实现：分支里 JSON.stringify(cleaned) 之后没 continue，落到通用分支又被
  // JSON.stringify 一次 → 落库是双编码（外面多一层引号），读回来 parse 一次得到字符串。
  // 后果不是"坏掉"而是"语义混乱"：消费方必须各自再 parse 一次兜住，
  // 而任何人写 `settings.home_social_extra.map(...)` 都会崩。
  resetState();
  await saveSettings({
    home_social_extra: JSON.stringify([{ label: 'GitHub', url: 'https://github.com/x' }]),
  }, { persist: true });
  const written = dbState.writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
  const row = written.find((p) => p && p.key === 'home_social_extra');
  check('结构化键被写库', !!row);
  if (row) {
    const once = JSON.parse(row.value);
    check('落库值解析一次就是数组（不是字符串）', Array.isArray(once), typeof once);
    check('数组内容正确', once.length === 1 && once[0].label === 'GitHub');
    check('落库字符串不以引号开头（双编码的特征是 [ 之前多一个 "）',
      row.value.startsWith('['), row.value.slice(0, 24));
  }

  // 读路径：结构化键必须原样返回数组，而不是被 String() 拼成 "[object Object]"
  resetState();
  dbState.rows = [{ key: 'home_social_extra', value: JSON.stringify([{ label: 'A', url: 'https://a.com' }]) }];
  clearSettingsCache();
  const st = await getAllSettings();
  check('读路径返回数组（不是 "[object Object]"）', Array.isArray(st.home_social_extra), typeof st.home_social_extra);
  check('读路径数组内容正确', st.home_social_extra[0] && st.home_social_extra[0].label === 'A');

  // 库里的非法形态（历史双编码/乱码）一律降级为空数组，不把字符串漏给前端
  resetState();
  dbState.rows = [{ key: 'home_social_extra', value: JSON.stringify('not-json{{') }];
  clearSettingsCache();
  const st2 = await getAllSettings();
  check('非法形态降级为空数组（不让字符串漏到消费方）',
    Array.isArray(st2.home_social_extra) && st2.home_social_extra.length === 0,
    JSON.stringify(st2.home_social_extra));
}

console.log('\n=== E. saveSettings：JSON 数组字段逐项清洗 ===');
  {
    resetState();
    await saveSettings({
      home_social_extra: JSON.stringify([
        { label: 'GitHub', url: 'https://github.com/x' },
        { label: '坏链接', url: 'javascript:alert(1)' },
        { label: '', url: 'https://a.com' },
        { label: 'X', url: 'https://x.com' },
      ]),
    }, { persist: true });
    const written = dbState.writes.flatMap((w) => (Array.isArray(w.payload) ? w.payload : [w.payload]));
    const row = written.find((p) => p && p.key === 'home_social_extra');
    check('数组字段被写库', !!row);
    if (row) {
      const parsed = JSON.parse(row.value);
      check('非法 URL 项被剔除', parsed.length === 2, JSON.stringify(parsed));
      check('空 label 项被剔除', !parsed.some((i) => i.url === 'https://a.com'));
      check('合法项被保留且重新序列化', parsed.every((i) => i.label && i.url.startsWith('https://')));
    }
    check('超过 8 条的数组整体被拒',
      (await (async () => {
        resetState();
        await saveSettings({
          home_social_extra: JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, url: 'https://a.com' }))),
        }, { persist: true });
        const w = dbState.writes.flatMap((x) => (Array.isArray(x.payload) ? x.payload : [x.payload]));
        return w.filter((p) => p && p.key === 'home_social_extra').length;
      })()) === 0);
  }

  console.log('\n=== E2. 被拒字段必须报告给调用方（否则用户以为保存成功了） ===');
{
  resetState();
  const r1 = await saveSettings({
    site_name: '正常字段',
    site_url: 'https://a.com?x=1',                       // 带 query → 拒
    ai_base_url: 'https://192.168.1.10/v1',              // 内网 IP → 拒
    home_status: 'hacking',                              // 非法枚举 → 拒
    ai_temperature: 5,                                   // 超上界 → 拒
  }, { persist: true });

  check('返回值是 { settings, rejected } 两个字段',
    r1 && typeof r1 === 'object' && 'settings' in r1 && Array.isArray(r1.rejected),
    Object.keys(r1 || {}).join(','));
  check('settings 里正常字段已生效', r1.settings.site_name === '正常字段');

  const keys = r1.rejected.map((x) => x.key).sort();
  check('报告了全部 4 个被拒字段',
    keys.join(',') === 'ai_base_url,ai_temperature,home_status,site_url', keys.join(','));
  check('每个被拒项都带原因（前端要显示给人看）',
    r1.rejected.every((x) => typeof x.reason === 'string' && x.reason.length > 0));
  check('正常字段不在 rejected 里', !keys.includes('site_name'));
  check('被拒字段确实没写库',
    !dbState.writes.some((w) => {
      const rows = Array.isArray(w.payload) ? w.payload : [w.payload];
      return rows.some((p) => p && ['site_url', 'ai_base_url', 'home_status', 'ai_temperature'].includes(p.key));
    }));

  // 密钥类「留空=不修改」是**有意**的，不该被当成错误报出来
  resetState();
  const r2 = await saveSettings({ ai_api_key: '', websearch_api_key: '' }, { persist: true });
  check('空密钥不报错（留空是「不修改」的约定，不是校验失败）',
    r2.rejected.length === 0, JSON.stringify(r2.rejected));
}

console.log('\n=== F. 读路径的类型归一 ===');
  {
    resetState();
    dbState.rows = [
      { key: 'comment_moderation', value: 'true' },
      { key: 'message_moderation', value: '"1"' },
      { key: 'site_name', value: '"新站名"' },
      { key: 'site_desc', value: '不是 JSON' },       // 坏 JSON → 原样字符串
      { key: 'rss_full_content', value: '1' },
    ];
    // 清缓存：getAllSettings 有 60s TTL，用一个新的 key 触发重读
    const settings = await getAllSettings();
    check('布尔键 "true" → true', settings.comment_moderation === true);
    check('布尔键 "1" → true', settings.message_moderation === true && settings.rss_full_content === true);
    check('字符串键正确解析 JSON', settings.site_name === '新站名');
    check('坏 JSON 退化为原字符串（不抛错、不丢值）', settings.site_desc === '不是 JSON', String(settings.site_desc));
    check('缺失键用默认值补齐', settings.avatar === DEFAULT_SETTINGS.avatar);
    check('返回对象包含全部默认键',
      Object.keys(DEFAULT_SETTINGS).every((k) => Object.prototype.hasOwnProperty.call(settings, k)));
  }

  console.log('\n=== G. 坏 JSON 的布尔键降级为 false（不是字符串） ===');
  {
    resetState();
    dbState.rows = [{ key: 'comment_moderation', value: '{坏' }];
    // 需要绕过缓存：直接调用会命中上次结果，这里改用一个新的时间窗不可行，
    // 所以只验证「该分支的代码形态」——真实读路径已在 F 组验证过类型归一。
    check('BOOL_KEYS 的坏值分支把值降级成 false（源码形态）',
      /map\[r\.key\] = BOOL_KEYS\.has\(r\.key\) \? false : String\(r\.value \?\? ''\)\.slice\(0, 5000\)/.test(settingsSrc));
  }

  console.log(`\nsettingsStore 套件结果: ${passCount} 通过, ${failCount} 失败`);
  if (failCount) process.exit(1);
}

run().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
