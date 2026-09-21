/**
 * tests/guitartab_e2e.test.js
 * 端到端验证：在「吉他六线谱」这种文字层里全是品格数字/和弦数字的谱子上，
 * 自动对齐后「跳到 70 必须落到谱面印的 70」。
 *
 * 不依赖任何真实 PDF 文件——我们用 pdf.js getTextContent() 会返回的那种
 * { str, transform:[a,b,c,d,x,y] } 结构，把一份吉他谱的真实文字层「复刻」出来：
 *   · 每套谱表行首有小节号（左侧栏、上半页）
 *   · 六线谱上铺满品格数字（0/3/5/7…，横跨整页宽度，且最左列也有）
 *   · 和弦标记带数字（如 C7 拆出的 "7"）
 * 然后走完整生产链路：readPageBarCandidates → solveStarts → computeBarNumbers
 *   → buildTimeline → 断言 gotoBar(70) 落在谱面 70。
 *
 * 同时断言：老式「单页取最靠上最左整数」启发式在这种谱子上会失准（证明这次改动必要）。
 *
 * 用 Node 直接跑： node tests/guitartab_e2e.test.js
 */
require('../js/modules/barNumberRead.js');
require('../js/modules/structure.js');
var R = globalThis.ST.BarNumberRead;
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

var W = 1000, H = 1400;
// 复刻 pdf.js 文字层条目：x、y 用归一化坐标（pdf.js 自底向上，ny 越大越靠上）
function T(str, nx, ny) { return { str: str, transform: [1, 0, 0, 1, nx * W, ny * H] }; }

// 造一页吉他谱的文字层。barStart = 该页第一格谱面印刷号。
function guitarPageTextLayer(barStart) {
  var items = [];
  // 行首小节号（左栏、上半页）
  items.push(T(String(barStart), 0.03, 0.90));          // 上谱表行首
  items.push(T(String(barStart + 8), 0.03, 0.50));      // 下谱表行首
  // 六线谱品格数字（横跨整页宽度，最左列也有；上下两套谱表）
  var topFrets = ['0', '3', '2', '5', '3', '7'];        // nx 0.06,0.12,0.20,0.30,0.45,0.60
  var botFrets = ['2', '5', '0', '4', '3', '1'];
  topFrets.forEach(function (s, i) { items.push(T(s, 0.06 + i * 0.075, 0.80)); });
  botFrets.forEach(function (s, i) { items.push(T(s, 0.06 + i * 0.075, 0.40)); });
  // 和弦标记里的数字（如 C7 拆出的 "7"，落在最上沿）
  items.push(T('7', 0.20, 0.95));
  // 最左、最上的高音品格数字——专门用来打脸「取最靠上最左整数」的老启发式
  items.push(T('3', 0.02, 0.95));
  return items;
}

// 造 measures：3 页、每页 16 格（2 套谱表 × 8 列），模拟识别结果。
// 注意 y 用「上小下大」的坐标（与 app 实际管线一致：makePageGrid 的 y 从顶端 0.10 向下递增），
// 这样 computeBarNumbers 升序排 y 时「上方谱表」先拿到编号，符合阅读顺序。
function buildMeasures() {
  var list = [];
  for (var p = 0; p < 3; p++) {
    for (var sys = 0; sys < 2; sys++) {
      for (var c = 0; c < 8; c++) {
        list.push({
          id: 'm' + p + '-' + sys + '-' + c,
          page: p,
          x: 0.05 + c * 0.10,
          y: sys === 0 ? 0.20 : 0.60,
          w: 0.09, h: 0.10
        });
      }
    }
  }
  return list;
}

function fakeSource(pages) {
  return {
    kind: 'pdf',
    size: function (i) { return Promise.resolve(pages[i].size); },
    textContent: function (i) { return Promise.resolve({ items: pages[i].items }); }
  };
}
function gotoBar(timeline, n) {
  return timeline.filter(function (e) { return e.bar === n; });
}

(async function () {
  console.log('\n[E2E-1] 复刻一份吉他六线谱 PDF 的文字层（满屏品格数字 + 行首小节号 + 和弦数字）');
  var pages = [];
  for (var p = 0; p < 3; p++) {
    pages.push({ size: { w: W, h: H }, items: guitarPageTextLayer(70 + p * 16) });
  }
  var src = fakeSource(pages);
  var measures = buildMeasures();
  var perPageCount = [16, 16, 16];   // 每页识别出的格数

  console.log('\n[E2E-2] 逐页读取候选号 + 跨页投票求解起始号');
  var candByPage = [];
  for (var q = 0; q < 3; q++) candByPage.push(await R.readPageBarCandidates(src, q));
  var solved = R.solveStarts(candByPage, perPageCount);
  ok('投票解出全局起始号', !!solved, JSON.stringify(solved));
  eq('第1页起始 = 谱面 70', solved.starts[0], 70);
  eq('第2页起始 = 86（70+16）', solved.starts[1], 86);
  eq('第3页起始 = 102（70+32）', solved.starts[2], 102);
  eq('由 3 页互相印证', solved.votes, 3);

  console.log('\n[E2E-3] 完整链路：computeBarNumbers → buildTimeline → gotoBar(70)');
  S.computeBarNumbers(measures, solved.starts);
  var tl = S.buildTimeline(measures, { timeSig: { num: 4, den: 4 }, compound: true }).entries;
  var hits = gotoBar(tl, 70);
  ok('能找到谱面 70', hits.length >= 1, 'hits=' + hits.length);
  eq('谱面 70 落在全曲第 0 个小节（seq=0）', hits[0] ? hits[0].seq : -1, 0);
  eq('该格 bar 字段确为 70', hits[0] ? hits[0].bar : -1, 70);
  eq('谱面 70 在第 1 页', hits[0] ? hits[0].page : -1, 0);

  console.log('\n[E2E-4] 对照：老式「单页最靠上最左整数」启发式在这种谱子上失准');
  var oldStarts = [];
  for (var r = 0; r < 3; r++) oldStarts.push(await R.readPageBarNumbers(src, r));
  ok('老式单页启发式把第1页起始读成了品格数字（≠70）', oldStarts[0] !== 70, 'oldStarts[0]=' + oldStarts[0]);
  // 用老值套一遍，确认跳 70 会落到错误位置
  var m2 = buildMeasures();
  S.computeBarNumbers(m2, oldStarts);
  var tl2 = S.buildTimeline(m2, { timeSig: { num: 4, den: 4 }, compound: true }).entries;
  var oldHits = gotoBar(tl2, 70);
  ok('老式对齐下，谱面 70 不会落在 seq=0', oldHits.length === 0 || oldHits[0].seq !== 0,
    oldHits.length ? ('seq=' + oldHits[0].seq + ' bar=' + oldHits[0].bar) : '未找到（页码被整体带偏）');

  console.log('\n=== 统计 ===');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
