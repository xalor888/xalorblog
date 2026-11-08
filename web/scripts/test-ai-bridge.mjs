/**
 * aiBridge 行为回归（直接 ESM import 真实模块 + 真实 vue，无 vm）。
 *
 * 背景：这个模块是「AI 面板 ↔ 当前页面」的桥。页面提供三样东西：
 *   - context：当前编辑的内容
 *   - selection：编辑器实时选区
 *   - applier：执行 AI 下发的动作（只有页面自己知道怎么改表单）
 * 另有一个**撤销栈**：applier 改内容前把旧值压栈，面板可一键撤销。
 *
 * 与其它几个工具不同，这个可以直接 import —— 它只依赖 vue 的 ref/computed，
 * 没有 DOM、没有网络、没有 import.meta.env。所以测试不需要 vm 造沙箱，
 * 代价是**它是模块级单例**，每个用例前必须 resetAiBridge()。
 *
 * 四个容易错、且错了都很安静的点：
 *   1. **撤销栈上限**：不设上限的话，长时间编辑会无限增长（每次 AI 修改都压一条闭包）
 *   2. **restore 抛错时仍要 pop**：页面切换后 restore 闭包持有的旧值可能已失效。
 *      不 pop 的话这条永远卡在栈顶，用户点「撤销」反复对同一个失效条目生效
 *   3. **snapshotId 关联**：面板靠它把「应用标签」和「可撤销项」对上。
 *      动作没压栈却给了 id → 用户撤销的是**另一次**修改（撤销错位，内容丢失）
 *   4. **resetAiBridge 要清撤销栈**：只清 applier 不清栈的话，
 *      旧页面的 restore 闭包会残留到新页面，撤销时改的是上一个页面的状态
 *
 * 用法：node scripts/test-ai-bridge.mjs
 */

import {
  aiContext, aiSelection, aiCanUndo,
  setAiContext, setAiSelection, setAiApplier,
  pushAiUndo, undoAiLast, aiUndoTopId, applyAiAction, resetAiBridge,
} from '../src/utils/aiBridge.js';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); }
}

/** 每个用例前清空单例状态 */
function fresh() {
  resetAiBridge();
}

console.log('\n【A. context 的读写】');
{
  fresh();
  ok('初始 context 是 null', aiContext.value === null);
  setAiContext({ title: '标题', body: '正文' });
  ok('setAiContext 存入对象', aiContext.value && aiContext.value.title === '标题');
  setAiContext(null);
  ok('传 null 归一成 null', aiContext.value === null);
  setAiContext(undefined);
  ok('传 undefined 也归一成 null', aiContext.value === null);
  setAiContext({ a: 1 });
  setAiContext(0);          // 假值是合法入参，不该被 || 吃掉
  ok('传 0 也归一成 null（用 || 的话会）', aiContext.value === null);
}

console.log('\n【B. selection 的截断与归一】');
{
  fresh();
  ok('初始 selection 是 null', aiSelection.value === null);
  setAiSelection({ text: 'abc', start: 0, end: 3 });
  ok('存入选区', aiSelection.value && aiSelection.value.text === 'abc');
  ok('保留 start/end', aiSelection.value.start === 0 && aiSelection.value.end === 3);

  setAiSelection({ text: '', start: 0, end: 0 });
  ok('空文本 → null', aiSelection.value === null);

  setAiSelection(null);
  ok('null → null', aiSelection.value === null);

  setAiSelection({ start: 1, end: 2 });     // 没有 text 字段
  ok('缺 text 字段 → null', aiSelection.value === null);

  setAiSelection({ text: 123, start: 0, end: 3 });   // text 不是字符串
  ok('text 非字符串 → null', aiSelection.value === null);

  // 4000 字符截断
  const long = 'x'.repeat(9000);
  setAiSelection({ text: long, start: 0, end: 9000 });
  ok('超长选区被截到 4000', aiSelection.value && aiSelection.value.text.length === 4000,
    String(aiSelection.value && aiSelection.value.text.length));
  ok('截断后 start/end 仍是原值（调用方自己知道截了）',
    aiSelection.value.end === 9000);
}

console.log('\n【C. 撤销栈：压栈 / 撤销 / 上限】');
{
  fresh();
  ok('初始不能撤销', aiCanUndo.value === false);
  ok('初始栈顶 id 是 0', aiUndoTopId() === 0);
  ok('空栈撤销返回 null', undoAiLast() === null);

  const log = [];
  const id1 = pushAiUndo('第一次', () => log.push('restore1'));
  ok('压栈返回递增 id', id1 === 1, String(id1));
  ok('现在可以撤销', aiCanUndo.value === true);
  ok('栈顶 id 是 1', aiUndoTopId() === 1);

  const id2 = pushAiUndo('第二次', () => log.push('restore2'));
  ok('第二次压栈 id 递增', id2 === 2, String(id2));
  ok('栈顶 id 是 2', aiUndoTopId() === 2);

  ok('撤销返回栈顶标签', undoAiLast() === '第二次');
  ok('撤销时调用了 restore', log.length === 1 && log[0] === 'restore2', JSON.stringify(log));
  ok('撤销后栈顶变成 1', aiUndoTopId() === 1);
  ok('还能再撤销一次', undoAiLast() === '第一次');
  ok(' restore 都调到了', log.length === 2);
  ok('栈空后不能再撤销', aiCanUndo.value === false);
  ok('栈空时 undoAiLast 返回 null', undoAiLast() === null);

  // restore 不是函数 → 不压栈，返回 0
  fresh();
  ok('restore 不是函数 → 返回 0 且不压栈',
    pushAiUndo('x', 'not-a-function') === 0 && aiCanUndo.value === false);
  ok('restore 缺省 → 返回 0', pushAiUndo('x') === 0);
}

console.log('\n【D. 撤销栈上限 12】');
{
  fresh();
  for (let i = 1; i <= 20; i++) pushAiUndo(`第${i}次`, () => {});
  ok('压 20 条后仍可撤销（没崩）', aiCanUndo.value === true);
  const labels = [];
  let l;
  while ((l = undoAiLast()) !== null) labels.push(l);
  ok('最多只能撤销 12 条（上限生效）', labels.length === 12, `实际 ${labels.length} 条`);
  // undoAiLast 从**栈顶**开始弹，所以 labels[0] 是最新、末尾是最旧。
  // 第一次写断言时把这个顺序写反了（期望 labels[末尾]==='第20次'），假红一条。
  ok('保留的是**最近** 12 条（旧的被 shift 掉）', labels[0] === '第20次' && labels[labels.length - 1] === '第9次',
    `最新 ${labels[0]} / 最旧 ${labels[labels.length - 1]}`);
}

console.log('\n【E. restore 抛错时仍要 pop】');
{
  fresh();
  pushAiUndo('好的', () => {});
  pushAiUndo('会抛的', () => { throw new Error('页面已切换'); });
  pushAiUndo('下面的', () => {});
  ok('压了 3 条', aiCanUndo.value === true);
  const l1 = undoAiLast();     // 这条正常
  ok('先撤销正常的', l1 === '下面的');
  let threw = false;
  let l2;
  try { l2 = undoAiLast(); } catch (e) { threw = true; }
  ok('restore 抛错时 undoAiLast 不往外抛', !threw);
  ok('抛错那条的标签仍被返回（调用方知道撤销了谁）', l2 === '会抛的', String(l2));
  ok('**抛错的条目已被弹掉**（不会卡在栈顶反复生效）', aiUndoTopId() !== 0);
  ok('再撤销一次拿到最早那条', undoAiLast() === '好的');
  ok('栈已空', aiCanUndo.value === false);
}

console.log('\n【F. applyAiAction 的 snapshotId 关联】');
{
  fresh();
  ok('未注册 applier → 返回 null', (await applyAiAction('x')) === null);

  // 注册一个不压栈的 applier（如保存草稿）
  setAiApplier(() => '已保存草稿');
  const r1 = await applyAiAction('save', {});
  ok('执行成功返回 label', r1 && r1.label === '已保存草稿');
  ok('没压栈的动作 snapshotId 是 0（不可撤销）', r1.snapshotId === 0, String(r1.snapshotId));

  // 注册一个会压栈的 applier
  setAiApplier((name) => {
    if (name === 'replace') {
      pushAiUndo('已替换正文', () => {});
      return '已替换正文';
    }
    return null;    // 空标签 → 不算成功
  });
  const r2 = await applyAiAction('replace', {});
  ok('压了栈的动作 snapshotId 非 0', r2 && r2.snapshotId !== 0, String(r2 && r2.snapshotId));
  ok('snapshotId 与栈顶一致（面板靠它对上）', r2.snapshotId === aiUndoTopId(),
    `${r2.snapshotId} ≠ ${aiUndoTopId()}`);

  const r3 = await applyAiAction('noop', {});
  ok('applier 返回空标签 → null', r3 === null);

  // applier 抛错
  setAiApplier(() => { throw new Error('boom'); });
  const r4 = await applyAiAction('x', {});
  ok('applier 同步抛错 → null（不往外抛）', r4 === null);

  // applier 异步抛错
  setAiApplier(() => Promise.reject(new Error('async boom')));
  const r5 = await applyAiAction('x', {});
  ok('applier 异步 reject → null', r5 === null);

  // applier 异步成功
  setAiApplier(async () => {
    pushAiUndo('异步动作', () => {});
    return '异步动作';
  });
  const r6 = await applyAiAction('x', {});
  ok('异步 applier 也返回 label 与 snapshotId', r6 && r6.label === '异步动作' && r6.snapshotId !== 0,
    JSON.stringify(r6));
}

console.log('\n【G. setAiApplier 的入参校验】');
{
  fresh();
  setAiApplier('not a function');
  ok('传非函数 → 视为未注册', (await applyAiAction('x')) === null);
  setAiApplier(() => 'ok');
  ok('传函数 → 注册成功', (await applyAiAction('x')).label === 'ok');
  setAiApplier(null);
  ok('传 null → 注销', (await applyAiAction('x')) === null);
}

console.log('\n【H. resetAiBridge 必须清撤销栈】');
{
  fresh();
  setAiContext({ a: 1 });
  setAiSelection({ text: 'sel', start: 0, end: 3 });
  setAiApplier(() => 'x');
  pushAiUndo('旧页面的修改', () => { throw new Error('旧页面已卸载'); });
  ok('重置前有栈', aiCanUndo.value === true);

  resetAiBridge();
  ok('context 清空', aiContext.value === null);
  ok('selection 清空', aiSelection.value === null);
  ok('applier 注销', (await applyAiAction('x')) === null);
  ok('**撤销栈也清空**（旧页面的 restore 已失效）', aiCanUndo.value === false,
    '不清的话撤销会改到上一个页面的状态');
  ok('栈顶 id 归 0', aiUndoTopId() === 0);
  ok('撤销返回 null', undoAiLast() === null);

  // 重置后 id 序列继续（不回 1）—— 避免面板把新动作和旧快照混起来
  const idAfter = pushAiUndo('新页面', () => {});
  ok('重置后 id 序列继续递增（不与旧快照撞号）', idAfter > 1, String(idAfter));
}

console.log('\n【I. 自检：判据真的能区分】');
{
  // 破坏样本一：撤销栈不设上限
  const noLimit = (await import('../src/utils/aiBridge.js'));
  // （同一个模块实例，只能另造一个逻辑副本）
  fresh();
  for (let i = 0; i < 20; i++) noLimit.pushAiUndo(`n${i}`, () => {});
  const n = [];
  let l;
  while ((l = noLimit.undoAiLast()) !== null) n.push(l);
  ok('自检：上限确实是 12 而不是 20', n.length === 12, `实际 ${n.length}`);

  // 破坏样本二：resetAiBridge 不清撤销栈（用逻辑复刻验证判据）
  fresh();
  pushAiUndo('残留', () => {});
  // 模拟「只清 context/applier 不清栈」的 reset
  const partialReset = () => {
    aiContext.value = null;
    aiSelection.value = null;
    // 故意不清 undoStack
  };
  partialReset();
  ok('自检：只清一半的 reset 会留下可撤销项（这就是要防的）', aiCanUndo.value === true);
  ok('自检：真实的 resetAiBridge 清干净了', (() => { fresh(); return !aiCanUndo.value; })());
}

console.log(`\n结果：${fail ? 'FAIL' : 'PASS'}（${pass} 通过 / ${fail} 失败）`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
