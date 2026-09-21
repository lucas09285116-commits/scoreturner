/**
 * tests/timeline.test.js
 * 用 Node 直接跑： node tests/timeline.test.js
 * 无第三方依赖——structure.js 是纯逻辑、不碰 DOM，所以可以离线验证反复与跳房子展开。
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

// 辅助：造小节
function mks(defs) {
  return defs.map(function (d, i) {
    return Object.assign({
      id: 'm' + (i + 1), page: 0, x: i * 0.1, y: 0.1, w: 0.09, h: 0.2,
      bar: i + 1
    }, d);
  });
}
function seqOf(list, opts) {
  var r = S.buildTimeline(list, opts);
  return { ids: r.entries.map(function (e) { return e.measureId; }), res: r };
}

console.log('\n[1] 基础线性：4 小节 4/4');
(function () {
  var list = mks([{}, {}, {}, {}]);
  var r = seqOf(list);
  eq('小节顺序', r.ids, ['m1', 'm2', 'm3', 'm4']);
  eq('总拍数', r.res.totalBeats, 16);
  eq('每小节起点拍', r.res.entries.map(function (e) { return e.firstBeat; }), [0, 4, 8, 12]);
})();

console.log('\n[2] 简单反复 │: m2 … m4 :│ 演奏两遍');
(function () {
  var list = mks([{}, { repeatStart: true }, {}, { repeatEnd: true }, {}, {}]);
  var r = seqOf(list, { defaultRepeatCount: 2 });
  eq('展开顺序', r.ids, ['m1', 'm2', 'm3', 'm4', 'm2', 'm3', 'm4', 'm5', 'm6']);
  eq('m3 出现两次', r.res.occurrences.get('m3').length, 2);
  eq('总拍数', r.res.totalBeats, 36);
})();

console.log('\n[3] 跳房子 │: A B 1. C :│ 2. D │ E');
(function () {
  var list = mks([
    { repeatStart: true },
    {},
    { volta: [1], repeatEnd: true, repeatCount: 2 },
    { volta: [2] },
    {}
  ]);
  var r = seqOf(list, { defaultRepeatCount: 2 });
  eq('展开顺序', r.ids, ['m1', 'm2', 'm3', 'm1', 'm2', 'm4', 'm5']);
  eq('第二遍走第 2 房子', r.res.entries[5].take, 2);
  eq('总拍数', r.res.totalBeats, 28);
})();

console.log('\n[4] 三房子 + 第 3 房子覆盖 2 遍');
(function () {
  var list = mks([
    { repeatStart: true },
    { volta: [1], repeatEnd: true, repeatCount: 3 },
    { volta: [2] },
    { volta: [3] },
    {}
  ]);
  var r = seqOf(list, { defaultRepeatCount: 3 });
  eq('展开顺序', r.ids, ['m1', 'm2', 'm1', 'm3', 'm1', 'm4', 'm5']);
})();

console.log('\n[5] 嵌套反复 │: A B │: C D :│ E :│');
(function () {
  var list = mks([
    { repeatStart: true }, {},
    { repeatStart: true }, { repeatEnd: true },
    { repeatEnd: true }
  ]);
  var r = seqOf(list, { defaultRepeatCount: 2 });
  eq('展开顺序', r.ids, ['m1', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5', 'm1', 'm2', 'm3', 'm4', 'm3', 'm4', 'm5']);
  eq('总拍数', r.res.totalBeats, 56);
})();

console.log('\n[6] D.C. 跳转');
(function () {
  var list = mks([{}, {}, {}, { jump: { targetIndex: 0, times: 1 } }]);
  var r = seqOf(list);
  eq('展开顺序', r.ids, ['m1', 'm2', 'm3', 'm4', 'm1', 'm2', 'm3', 'm4']);
})();

console.log('\n[7] 拍号解析');
(function () {
  eq('6/8 复合 = 2 拍', S.beatsOfTimeSig({ num: 6, den: 8 }, true), 2);
  eq('6/8 单位拍 = 6 拍', S.beatsOfTimeSig({ num: 6, den: 8 }, false), 6);
  eq('9/8 复合 = 3 拍', S.beatsOfTimeSig({ num: 9, den: 8 }, true), 3);
  eq('3/4 = 3 拍', S.beatsOfTimeSig({ num: 3, den: 4 }, true), 3);
  var list = mks([{}, {}]);
  eq('复合拍下总拍数', seqOf(list, { timeSig: { num: 6, den: 8 }, compound: true }).res.totalBeats, 4);
})();

console.log('\n[8] 弱起小节（手动覆盖拍数）');
(function () {
  var list = mks([{ beats: 1 }, {}, {}]);
  var r = seqOf(list, { timeSig: { num: 4, den: 4 } });
  eq('起点拍', r.res.entries.map(function (e) { return e.firstBeat; }), [0, 1, 5]);
  eq('总拍数', r.res.totalBeats, 9);
})();

console.log('\n[9] 翻页边界（反复会让页面来回到第 1 页）');
(function () {
  var list = mks([
    { page: 0 }, { page: 0, repeatStart: true },
    { page: 0 }, { page: 0, repeatEnd: true },
    { page: 1 }, { page: 1 }
  ]);
  var r = seqOf(list, { defaultRepeatCount: 2 });
  var pages = r.res.entries.map(function (e) { return e.page; });
  eq('页面序列', pages, [0, 0, 0, 0, 0, 0, 0, 1, 1]);
  var b = S.nextPageBoundary(r.res.entries, 0);
  ok('从开头看下一个换页点是序号 7', b && b.index === 7, JSON.stringify(b));
  var b2 = S.nextPageBoundary(r.res.entries, 7);
  ok('第 1 页之后不再换页', b2 === null);
})();

console.log('\n[10] 拍号 → 时间线查询');
(function () {
  var list = mks([{}, {}, {}, {}]);
  var r = seqOf(list, { timeSig: { num: 3, den: 4 } });
  eq('第 4 拍在第 2 小节', S.entryAtBeat(r.res.entries, 4), 1);
  eq('第 3 拍在第 2 小节首拍', S.entryAtBeat(r.res.entries, 3), 1);
  eq('第 2 拍仍在第 1 小节', S.entryAtBeat(r.res.entries, 2), 0);
})();

console.log('\n[11] 阅读顺序还原（乱序输入 → 页/行/列）');
(function () {
  var list = mks([
    { id: 'c', page: 1, x: 0.1, y: 0.1 },
    { id: 'a', page: 0, x: 0.5, y: 0.1 },
    { id: 'b', page: 0, x: 0.2, y: 0.1 },
    { id: 'd', page: 0, x: 0.2, y: 0.6 }
  ]);
  eq('排序结果', S.sortMeasures(list).map(function (m) { return m.id; }), ['b', 'a', 'd', 'c']);
})();

console.log('\n[12] 死循环防护');
(function () {
  var list = mks([{ repeatStart: true }, {}, { repeatEnd: true, repeatCount: 6 }]);
  var r = seqOf(list, { maxPasses: 3 });
  ok('受 maxPasses 限制', r.res.entries.length === 9 || r.res.entries.length === 6, '实际 ' + r.res.entries.length + ' 条');
})();

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n');
process.exit(fail ? 1 : 0);
