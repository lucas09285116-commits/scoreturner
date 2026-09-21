/**
 * tests/barnumber.test.js
 * 验证「软件内部顺序号」与「谱面印刷号」对齐模型（pageStarts / computeBarNumbers）。
 * 这是修复「跳到 70 却落到 72」的根因：gotoBar 按 e.bar 寻址，而 e.bar 现在等于印刷号。
 *
 * 用 Node 直接跑： node tests/barnumber.test.js
 */
require('../js/modules/structure.js');
var S = globalThis.ST.Structure;

var pass = 0, fail = 0;
function eq(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + a + '\n      期望: ' + e); }
}
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// 造一页小节，按列顺序铺开，y 用来分不同行
function page(defs, pageNo) {
  return defs.map(function (d) {
    return Object.assign({ id: 'm' + pageNo + '-' + (d.c), page: pageNo, x: d.c * 0.1, y: d.y || 0.1, w: 0.09, h: 0.2 }, d);
  });
}

// 模拟 tracker.gotoBar：在时间线上找 e.bar === n 的所有出现位置
function gotoBar(timeline, n) {
  var hits = [];
  timeline.forEach(function (e, i) { if (e.bar === n) hits.push(i); });
  return hits;
}

console.log('\n[A] computeBarNumbers：单页对齐');
(function () {
  var list = page([{ c: 0 }, { c: 1 }, { c: 2 }], 0);
  S.computeBarNumbers(list, [5]);               // 本页第一格 = 谱面 5
  eq('本页编号 5,6,7', list.map(function (m) { return m.bar; }), [5, 6, 7]);
})();

console.log('\n[B] 跨页自动顺延');
(function () {
  var list = []
    .concat(page([{ c: 0 }, { c: 1 }, { c: 2 }], 0))   // 3 个
    .concat(page([{ c: 0 }, { c: 1 }, { c: 2 }], 1));  // 3 个
  S.computeBarNumbers(list, [3]);               // 只对齐第 1 页 = 谱面 3
  eq('第1页 3,4,5', list.slice(0, 3).map(function (m) { return m.bar; }), [3, 4, 5]);
  eq('第2页自动顺延 6,7,8', list.slice(3, 6).map(function (m) { return m.bar; }), [6, 7, 8]);
})();

console.log('\n[C] 只对齐靠后的页，前面仍顺序');
(function () {
  var list = []
    .concat(page([{ c: 0 }, { c: 1 }, { c: 2 }], 0))   // 3 个
    .concat(page([{ c: 0 }, { c: 1 }, { c: 2 }], 1));  // 3 个
  S.computeBarNumbers(list, [null, 13]);       // 第2页显式 = 13
  eq('第1页顺序 1,2,3', list.slice(0, 3).map(function (m) { return m.bar; }), [1, 2, 3]);
  eq('第2页 13,14,15', list.slice(3, 6).map(function (m) { return m.bar; }), [13, 14, 15]);
})();

console.log('\n[D] 无对齐时退化为本页顺序号 1..N（低层契约）');
(function () {
  var list = page([{ c: 0 }, { c: 1 }], 0);
  S.computeBarNumbers(list, []);               // 没有任何 pageStarts 覆盖
  eq('本页顺序 1,2', list.map(function (m) { return m.bar; }), [1, 2]);
})();

console.log('\n[E] 复现并修复「跳到 70 落到 72」');
(function () {
  // 模拟用户谱：开头有 2 小节弱起/前奏，谱面印刷号比软件顺序号大 2
  // 用 3 页、每页 30 小节，共 90 小节；对齐第 1 页起始 = 3（即弱起占 1、2）
  var list = [];
  for (var p = 0; p < 3; p++) {
    for (var c = 0; c < 30; c++) list.push({ id: 'm' + p + '-' + c, page: p, x: c * 0.03, y: 0.1, w: 0.02, h: 0.2 });
  }
  S.computeBarNumbers(list, [3]);               // 对齐：第1页第一格 = 谱面 3

  // 期望：谱面第 70 小节 = 全局第 67 个小节（因为 1、2 是弱起）
  var tl = S.buildTimeline(list, { timeSig: { num: 4, den: 4 }, compound: true }).entries;
  var hits = gotoBar(tl, 70);
  ok('gotoBar(70) 能找到', hits.length >= 1, 'hits=' + JSON.stringify(hits));
  var idx = hits[0];
  eq('谱面70落在全局第67小节', tl[idx].seq, 67);
  eq('该格的 bar 字段确为 70', tl[idx].bar, 70);

  // 反证旧模型：若不对齐（顺序号），gotoBar(70) 会落在全局第 69 小节，
  // 而那一格的"谱面印刷号"在真实谱上是 72 —— 这就是"跳到 70 落到 72"的来源
  var list2 = list.map(function (m) { return Object.assign({}, m); });
  S.computeBarNumbers(list2, []);               // 不覆盖 → 顺序号 1..90
  var tl2 = S.buildTimeline(list2, { timeSig: { num: 4, den: 4 }, compound: true }).entries;
  var hits2 = gotoBar(tl2, 70);
  eq('旧模型 gotoBar(70) 落在全局第69小节', tl2[hits2[0]].seq, 69);   // 差 2，正是 off-by-2
  eq('该格顺序号=70（与印刷号不等）', tl2[hits2[0]].bar, 70);
})();

console.log('\n[F] 对齐后重复段落里 gotoBar 仍能定位到正确出现位置');
(function () {
  // |: A B C :| D E F （C 处反复一次），反复段放在第二行避免 x 坐标重叠
  var list = [
    { id: 'a', page: 0, x: 0.0, y: 0.1, w: 0.09, h: 0.2, repeatStart: true },
    { id: 'b', page: 0, x: 0.1, y: 0.1, w: 0.09, h: 0.2 },
    { id: 'c', page: 0, x: 0.2, y: 0.1, w: 0.09, h: 0.2, repeatEnd: true },
    { id: 'd', page: 0, x: 0.0, y: 0.3, w: 0.09, h: 0.2 },
    { id: 'e', page: 0, x: 0.1, y: 0.3, w: 0.09, h: 0.2 },
    { id: 'f', page: 0, x: 0.2, y: 0.3, w: 0.09, h: 0.2 }
  ];
  S.computeBarNumbers(list, [11]);             // 第一格 = 谱面 11
  var tl = S.buildTimeline(list, { timeSig: { num: 4, den: 4 }, compound: true }).entries;
  // 谱面 11（即小节 a）在反复里出现两次（第1遍、第2遍），都能被找到
  var hits = gotoBar(tl, 11);
  ok('谱面11出现两次（反复）', hits.length === 2, 'hits=' + JSON.stringify(hits));
  // 第一次出现的 seq 应是 0
  eq('第1次出现在序列开头', tl[hits[0]].seq, 0);
})();

console.log('\n=== 统计 ===');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
