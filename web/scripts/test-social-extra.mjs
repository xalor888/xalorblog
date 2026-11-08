/**
 * 主页社交链接的读写归一：**前端规则必须与服务端一致**。
 *
 * 这条门禁存在的理由是一个具体的体验缺陷：前端 `HomeSettings.vue` 原本只过滤空值，
 * 而服务端 `saveSettings` 还会因协议不在白名单（`safeUrl`）而丢弃。
 * 结果是「保存后列表还在，刷新就没了」—— 用户以为自己成功了。
 *
 * 所以这里不只测前端函数的正确性，还要**反向读服务端源码确认规则没漂移**：
 * 服务端的上限/协议判据一旦改了而前端没跟，这条门禁会红。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSocialExtra,
  normalizeSocialExtra,
  serializeSocialExtra,
  SOCIAL_MAX_ITEMS,
  SOCIAL_LABEL_MAX,
  SOCIAL_URL_MAX,
} from '../src/utils/socialExtra.js';
import { stripCommentLines } from './lib/sourceText.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(here, '../src');
const SERVER_SRC = resolve(here, '../../server/src');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n【读：兼容数组与双编码字符串】');
{
  ok('数组形态直接用', JSON.stringify(parseSocialExtra([{ label: 'A', url: 'https://a.com' }]))
    === '[{"label":"A","url":"https://a.com"}]');
  // 历史数据曾被双重序列化：解析一次得到字符串，还要再 parse
  ok('双编码字符串能再解析一次',
    parseSocialExtra(JSON.stringify([{ label: 'B', url: 'https://b.com' }])).length === 1);
  ok('null → 空数组', parseSocialExtra(null).length === 0);
  ok('undefined → 空数组', parseSocialExtra(undefined).length === 0);
  ok('坏 JSON → 空数组（不抛错）', parseSocialExtra('not json{{').length === 0);
  ok('对象（非数组）→ 空数组', parseSocialExtra({ a: 1 }).length === 0);
  ok('数组里的非对象项被丢掉', parseSocialExtra([1, 'x', null, { label: 'A', url: 'u' }]).length === 1);
  ok('缺字段补成空串（不是 undefined）',
    parseSocialExtra([{ label: 'A' }])[0].url === '');
}

console.log('\n【写：规则必须与服务端一致】');
{
  const r1 = normalizeSocialExtra([
    { label: '  GitHub  ', url: '  https://github.com/x  ' },
  ]);
  ok('label / url 都 trim', r1.list[0].label === 'GitHub' && r1.list[0].url === 'https://github.com/x');

  // 这一条是核心：协议白名单。服务端 safeUrl 会丢掉非 http(s)，前端必须同规则，
  // 否则用户保存后列表还在、刷新就消失。
  const r2 = normalizeSocialExtra([
    { label: 'js', url: 'javascript:alert(1)' },
    { label: 'data', url: 'data:text/html,x' },
    { label: 'file', url: 'file:///etc/passwd' },
    { label: 'protocol-relative', url: '//evil.com' },
    { label: 'no-protocol', url: 'evil.com' },
    { label: 'ok', url: 'https://ok.com' },
    { label: 'http ok', url: 'http://ok.com' },
  ]);
  ok('非 http(s) 协议被丢弃', r2.list.every((it) => /^https?:\/\//i.test(it.url)),
    JSON.stringify(r2.list.map((it) => it.url)));
  ok('http 也放行（不只是 https）', r2.list.some((it) => it.url === 'http://ok.com'));
  ok('丢弃条数正确报告', r2.dropped === 5, String(r2.dropped));

  ok('空 label 被丢弃',
    normalizeSocialExtra([{ label: '   ', url: 'https://a.com' }]).list.length === 0);
  ok('空 url 被丢弃',
    normalizeSocialExtra([{ label: 'A', url: '  ' }]).list.length === 0);

  const longLabel = 'x'.repeat(100);
  const longUrl = 'https://a.com/' + 'y'.repeat(400);
  const r3 = normalizeSocialExtra([{ label: longLabel, url: longUrl }]);
  ok(`label 截断到 ${SOCIAL_LABEL_MAX}`, r3.list[0].label.length === SOCIAL_LABEL_MAX);
  ok(`url 截断到 ${SOCIAL_URL_MAX}`, r3.list[0].url.length === SOCIAL_URL_MAX);

  const many = Array.from({ length: 12 }, (_, i) => ({ label: `L${i}`, url: `https://a${i}.com` }));
  const r4 = normalizeSocialExtra(many);
  ok(`最多保留 ${SOCIAL_MAX_ITEMS} 条`, r4.list.length === SOCIAL_MAX_ITEMS, String(r4.list.length));
  ok('超上限的条数计入 dropped', r4.dropped === 12 - SOCIAL_MAX_ITEMS, String(r4.dropped));

  ok('非数组输入 → 空结果', normalizeSocialExtra(null).list.length === 0);
  ok('数组里的 null 项被跳过',
    normalizeSocialExtra([null, { label: 'A', url: 'https://a.com' }]).list.length === 1);
}

console.log('\n【序列化：单编码，落库形态正确】');
{
  const s = serializeSocialExtra([{ label: 'A', url: 'https://a.com' }]);
  ok('结果是字符串', typeof s === 'string');
  ok('解析一次就是数组（不是双编码）', Array.isArray(JSON.parse(s)), typeof JSON.parse(s));
  ok('解析后的内容正确', JSON.parse(s)[0].label === 'A');
  ok('空列表序列化成 "[]"', serializeSocialExtra([]) === '[]');
  ok('非法项不进入序列化结果',
    JSON.parse(serializeSocialExtra([{ label: 'x', url: 'javascript:1' }])).length === 0);
}

console.log('\n【服务端规则没漂移（反向读源码）】');
{
  const settingsSrc = stripCommentLines(readFileSync(resolve(SERVER_SRC, 'utils/settings.js'), 'utf8'));
  const homeSrc = stripCommentLines(readFileSync(resolve(SERVER_SRC, 'routes/home.js'), 'utf8'));

  ok('服务端仍然有 8 条上限', /length > 8/.test(settingsSrc), '服务端上限变了，前端 SOCIAL_MAX_ITEMS 要跟着改');
  ok('服务端 label 仍截 30', /slice\(0, 30\)/.test(settingsSrc));
  // 用 [\s\S]{0,80} 而不是 [^)]*：实际写法是 safeUrl(String(item.url ?? ''), 300)，
  // 中间含一对括号，[^)]* 会在这里断掉。
  ok('服务端 url 仍截 300', /safeUrl\([\s\S]{0,80}?300\)/.test(settingsSrc));
  ok('服务端仍用 safeUrl 做协议白名单', /safeUrl\(/.test(settingsSrc));
  ok('服务端读路径仍有 parseSocialExtra', /function parseSocialExtra/.test(homeSrc));
  ok('服务端 parseSocialExtra 兼容数组与字符串两种形态',
    /typeof list === 'string'/.test(homeSrc) && /Array\.isArray\(list\)/.test(homeSrc));

  ok('前端已改用共享模块（不再自己写一份 parseExtra）',
    !/function parseExtra/.test(readFileSync(resolve(WEB_SRC, 'views/admin/HomeSettings.vue'), 'utf8')));
  ok('前端保存时用的是 normalizeSocialExtra',
    /normalizeSocialExtra\(socialExtra\.value\)/.test(
      readFileSync(resolve(WEB_SRC, 'views/admin/HomeSettings.vue'), 'utf8')));
  ok(`前端上限常量与服务端一致（${SOCIAL_MAX_ITEMS}）`, SOCIAL_MAX_ITEMS === 8, String(SOCIAL_MAX_ITEMS));
}

console.log('\n【门禁自检：规则能抓到真问题】');
{
  // 反例：如果 normalize 只检查「非空」（改动前的行为），这条会命中
  const onlyNonEmpty = (items) => items.filter((it) => it.label && it.url);
  const sample = [{ label: 'js', url: 'javascript:alert(1)' }];
  ok('改动前的「只过滤空值」会放过 javascript: 协议',
    onlyNonEmpty(sample).length === 1);
  ok('当前实现会丢弃它（这是修好的证据）',
    normalizeSocialExtra(sample).list.length === 0);

  // 反例：如果读路径只做 JSON.parse(String(raw))，数组会被拼成 [object Object]
  const bad = String([{ label: 'A', url: 'https://a.com' }]);
  ok('朴素 String(数组) 会产出 [object Object]（说明为什么必须分支处理）',
    bad.includes('[object Object]'));
  ok('当前实现对数组直接可用', parseSocialExtra([{ label: 'A', url: 'https://a.com' }]).length === 1);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error('\n失败项:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
