/**
 * secureStorage 行为回归（node:vm + 记录型存储，无浏览器）。
 *
 * 背景：这个模块管的是「敏感数据只在当前标签页存活」。
 * 消费者包括 fingerprint（设备指纹）、authSession（票据）、CommentSection（草稿）。
 * 它的安全承诺是三条：
 *   1. 写的时候**先删 localStorage 旧值**（不然敏感数据会长期留在磁盘上）
 *   2. 读到旧 localStorage 值时**迁移后立即删除持久副本**
 *   3. sessionStorage 被禁用时降级为「本次返回旧值」，但绝不为了兼容而长期保留
 *
 * 为什么值得测：这三条任何一条失效都不会报错 ——
 * 表现只是「 localStorage 里多了一个键」，而那个键可能就是票据或指纹。
 * 而且这是**隐私语义**，错了用户永远不知道。
 *
 * 用法：node scripts/test-secure-storage.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src/utils/secureStorage.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 造一对记录型存储，支持 enabled:false 模拟「存储被禁用」 */
function makeStorage(enabled = true) {
  const map = new Map();
  return {
    enabled,
    get length() { return map.size; },
    getItem(k) { if (!enabled) throw new Error('SecurityError'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (!enabled) throw new Error('SecurityError'); map.set(k, String(v)); },
    removeItem(k) { if (!enabled) throw new Error('SecurityError'); map.delete(k); },
    key(i) { if (!enabled) throw new Error('SecurityError'); return [...map.keys()][i] ?? null; },
    dump() { return [...map.entries()]; },
  };
}

function load({ sessionEnabled = true, localEnabled = true, seed = {} } = {}) {
  const session = makeStorage(sessionEnabled);
  const local = makeStorage(localEnabled);
  for (const [k, v] of Object.entries(seed)) local.setItem(k, v);
  const sandbox = { globalThis: { sessionStorage: session, localStorage: local }, console };
  vm.createContext(sandbox);
  const src = readFileSync(SRC, 'utf8').replace(/export function/g, 'function');
  vm.runInContext(`${src}\n;({ readSessionValue, writeSessionValue, removeStoredValue, migrateLegacyKeys, migrateLegacyPrefix, clearStoredPrefix })`, sandbox);
  const api = vm.runInContext('({ readSessionValue, writeSessionValue, removeStoredValue, migrateLegacyKeys, migrateLegacyPrefix, clearStoredPrefix })', sandbox);
  return { api, session, local };
}

console.log('\n【A. 写入必须先清掉 localStorage 旧值】');
{
  const { api, session, local } = load({ seed: { tok: 'old-persistent-value' } });
  ok('前提：localStorage 里已有旧值', local.dump().some(([k]) => k === 'tok'));
  api.writeSessionValue('tok', 'fresh');
  ok('写入后 sessionStorage 有新值', session.getItem('tok') === 'fresh');
  ok('**localStorage 的旧值被删掉**（安全承诺 1）', local.getItem('tok') === null,
    `localStorage 仍有 ${local.getItem('tok')}`);
}

console.log('\n【B. 读旧值：迁移后必须删掉持久副本】');
{
  const { api, session, local } = load({ seed: { tok: 'legacy' } });
  const v = api.readSessionValue('tok');
  ok('返回旧值', v === 'legacy');
  ok('迁入了 sessionStorage', session.getItem('tok') === 'legacy');
  ok('**localStorage 的持久副本已删**（安全承诺 2）', local.getItem('tok') === null,
    `localStorage 仍有 ${local.getItem('tok')}`);
}

console.log('\n【C. sessionStorage 已有值时，localStorage 旧值仍要清】');
{
  const { api, session, local } = load({ seed: { tok: 'stale-in-local' } });
  session.setItem('tok', 'current');
  const v = api.readSessionValue('tok');
  ok('返回 sessionStorage 的当前值', v === 'current');
  ok('localStorage 的陈旧副本也删了', local.getItem('tok') === null);
}

console.log('\n【D. 空值语义：写空串等于删除，不是写一个空串进去】');
{
  const { api, session, local } = load({ seed: { tok: 'x' } });
  api.writeSessionValue('tok', '');
  ok('写空串 → sessionStorage 里没有这个键', session.getItem('tok') === null,
    `实际 ${JSON.stringify(session.getItem('tok'))}`);
  ok('写空串 → localStorage 也清掉', local.getItem('tok') === null);
  api.writeSessionValue('tok', 'v');
  api.writeSessionValue('tok', null);
  ok('写 null → 删除', session.getItem('tok') === null);
  api.writeSessionValue('tok', 'v');
  api.writeSessionValue('tok', undefined);
  ok('写 undefined → 删除', session.getItem('tok') === null);
}

console.log('\n【E. sessionStorage 被禁用时降级但不留痕】');
{
  const { api, session, local } = load({ sessionEnabled: false, seed: { tok: 'legacy' } });
  let v;
  try { v = api.readSessionValue('tok'); } catch (e) { v = 'THREW:' + e.message; }
  ok('不抛异常（隐私模式下也要能跑）', typeof v === 'string' && !v.startsWith('THREW'), String(v));
  ok('仍然返回旧值（调用方可继续在内存里用）', v === 'legacy');
  ok('**但 localStorage 的持久副本仍被删掉**（安全承诺 3：不为兼容而长期保留）',
    local.getItem('tok') === null, `localStorage 仍有 ${local.getItem('tok')}`);
}

console.log('\n【F. 前缀迁移与清理（边收集边删会漏）】');
{
  const { api, session, local } = load({
    seed: { 'draft:a': '1', 'draft:b': '2', 'draft:c': '3', other: 'keep' },
  });
  api.migrateLegacyPrefix('draft:');
  ok('三个前缀键都迁到 sessionStorage',
    ['draft:a', 'draft:b', 'draft:c'].every((k) => session.getItem(k) !== null),
    JSON.stringify(session.dump()));
  ok('迁移后 localStorage 里前缀键全清',
    local.dump().filter(([k]) => k.startsWith('draft:')).length === 0,
    JSON.stringify(local.dump()));
  ok('非前缀键不受影响', local.getItem('other') === 'keep');

  // 清理：两个存储都要清
  session.setItem('draft:z', '9');
  local.setItem('draft:y', '8');
  api.clearStoredPrefix('draft:');
  ok('clearStoredPrefix 清掉 sessionStorage 里的',
    session.dump().filter(([k]) => k.startsWith('draft:')).length === 0, JSON.stringify(session.dump()));
  ok('clearStoredPrefix 清掉 localStorage 里的',
    local.dump().filter(([k]) => k.startsWith('draft:')).length === 0, JSON.stringify(local.dump()));
  ok('clearStoredPrefix 不动其它键', local.getItem('other') === 'keep');
}

console.log('\n【G. removeStoredValue 两个存储都删】');
{
  const { api, session, local } = load({ seed: { tok: 'a' } });
  session.setItem('tok', 'b');
  api.removeStoredValue('tok');
  ok('sessionStorage 删掉', session.getItem('tok') === null);
  ok('localStorage 也删掉', local.getItem('tok') === null);
}

console.log('\n【H. migrateLegacyKeys（逐个键迁移）】');
{
  const { api, session, local } = load({ seed: { k1: 'v1', k2: 'v2', keep: 'v3' } });
  api.migrateLegacyKeys(['k1', 'k2']);
  ok('列出的键都迁过去', session.getItem('k1') === 'v1' && session.getItem('k2') === 'v2');
  ok('列出的键从 localStorage 删除', local.getItem('k1') === null && local.getItem('k2') === null);
  ok('没列出的键不动', local.getItem('keep') === 'v3');
}

console.log('\n【I. 自检：判据真的能区分】');
{
  // 破坏样本：把 writeSessionValue 里的 remove(local, key) 去掉
  const broken = readFileSync(SRC, 'utf8')
    .replace(/export function/g, 'function')
    .replace(/(function writeSessionValue[\s\S]*?)\n  remove\(local, key\);/, '$1');
  ok('自检准备：确实剥掉了写入前的 localStorage 清理', !/writeSessionValue[\s\S]{0,200}remove\(local, key\)/.test(broken));
  const dom = { session: makeStorage(), local: makeStorage() };
  dom.local.setItem('tok', 'old');
  const sb = { globalThis: { sessionStorage: dom.session, localStorage: dom.local }, console };
  vm.createContext(sb);
  vm.runInContext(`${broken}\n;({ writeSessionValue })`, sb);
  const b = vm.runInContext('({ writeSessionValue })', sb);
  b.writeSessionValue('tok', 'fresh');
  ok('自检：去掉清理的版本会被判为「localStorage 仍有旧值」',
    dom.local.getItem('tok') === 'old', `实际 ${dom.local.getItem('tok')}`);
  ok('自检：真实版本不会',
    (() => { const g = load({ seed: { tok: 'old' } }); g.api.writeSessionValue('tok', 'fresh'); return g.local.getItem('tok') === null; })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
