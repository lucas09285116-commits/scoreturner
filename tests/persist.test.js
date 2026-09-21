/**
 * tests/persist.test.js
 * 验证「上次保存的小节框能否沿用」的判定（ST.Persistence.measuresUsable）。
 *
 * 回归的正是用户报的现象："明明算法改好了，重新导入还是看到一格被切成两格"——
 * 因为旧存档里的小节框被原样恢复，新算法根本没跑。修复：识别算法版本号
 * （ST.BarlineDetect.VERSION）写进存档，版本不一致即作废重识别。
 *
 * 用 Node 直接跑： node tests/persist.test.js
 */
globalThis.pdfjsLib = { OPS: {} };
// localStorage 最小 mock（persistence 的 save/load 需要）
var mem = {};
globalThis.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
  setItem: function (k, v) { mem[k] = String(v); },
  removeItem: function (k) { delete mem[k]; }
};
require('../js/modules/barlineDetect.js');
require('../js/modules/persistence.js');
var P = globalThis.ST.Persistence;
var VER = globalThis.ST.BarlineDetect.VERSION;

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

function mk(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push({ id: 'm' + i, page: 0, x: i * 0.1, y: 0.1, w: 0.09, h: 0.05 });
  return a;
}

console.log('\n[P1] 示例乐谱自带小节 → 永远优先，与版本无关');
var r1 = P.measuresUsable({ detectVer: 0, measures: mk(3) }, VER, mk(5), 3);
eq('用自带小节', r1.use.length, 5);
eq('无过期标记', [r1.stale, r1.verStale], [null, false]);

console.log('\n[P2] 同版本 + 框够多 → 沿用存档');
var r2 = P.measuresUsable({ detectVer: VER, measures: mk(60) }, VER, null, 6);
eq('沿用 60 个', r2.use.length, 60);
eq('无过期标记', [r2.stale, r2.verStale], [null, false]);

console.log('\n[P3] 算法升级（存档 detectVer 旧）→ 旧框作废、必须重新识别【本次 bug 回归】');
var r3 = P.measuresUsable({ detectVer: VER - 1, measures: mk(60) }, VER, null, 6);
eq('作废（返回空）', r3.use.length, 0);
eq('verStale=true', r3.verStale, true);

console.log('\n[P4] 老存档没有 detectVer 字段（undefined）→ 同样视为过期');
var r4 = P.measuresUsable({ measures: mk(60) }, VER, null, 6);
eq('作废', r4.use.length, 0);
eq('verStale=true', r4.verStale, true);

console.log('\n[P5] 半截标记（平均每页不足 4 个）→ 作废重识别');
var r5 = P.measuresUsable({ detectVer: VER, measures: mk(3) }, VER, null, 6);
eq('作废', r5.use.length, 0);
eq('stale=3', r5.stale, 3);
eq('verStale=false', r5.verStale, false);

console.log('\n[P6] 没有存档 → 空，且不报过期');
var r6 = P.measuresUsable(null, VER, null, 6);
eq('空', r6.use.length, 0);
eq('无过期', [r6.stale, r6.verStale], [null, false]);

console.log('\n[P7] save() 把当前算法版本写进存档，load() 能读回');
var state = {
  score: { id: 'pdf:test', name: 't.pdf', pages: [{}], measures: mk(20) },
  pageStarts: [1, 17], transport: { bpm: 96, timeSig: { num: 4, den: 4 }, compound: true },
  turn: {}, repeat: {}, input: { binds: {} }
};
ok('save 成功', P.save(state) === true);
var back = P.load('pdf:test');
eq('读出 detectVer = 当前版本', back.detectVer, VER);
eq('读出 pageStarts 保留对齐', back.pageStarts, [1, 17]);
// 存档读回后再次判定 → 应当沿用（版本一致）
var r7 = P.measuresUsable(back, VER, null, 1);
eq('版本一致后可沿用', r7.use.length, 20);

console.log('\n=== 统计 ===');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
