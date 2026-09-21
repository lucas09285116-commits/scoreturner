/**
 * tests/barnumberread.test.js
 * 验证「从 PDF 文字层自动读谱面印刷号」(ST.BarNumberRead.readPageBarNumbers)。
 * 这是把「跳到 70 落到 72」彻底自动化的关键——数字版 PDF 导入即对齐，免手动。
 *
 * 用 Node 直接跑： node tests/barnumberread.test.js
 */
require('../js/modules/barNumberRead.js');
var R = globalThis.ST.BarNumberRead;

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

// 造一个伪 PdfSource：kind=pdf，size 返回画布尺寸，textContent 返回文字层 items
function fakeSource(pages) {
  return {
    kind: 'pdf',
    size: function (i) { return Promise.resolve(pages[i].size); },
    textContent: function (i) { return Promise.resolve({ items: pages[i].items }); }
  };
}
// str 落在归一化坐标 (nx, ny) —— ny 越大越靠上（pdf.js transform 的 y 自底向上）
function item(str, nx, ny, W, H) {
  return { str: str, transform: [1, 0, 0, 1, nx * W, ny * H] };
}
var W = 1000, H = 1400;

(async function () {
  console.log('\n[G] 数字版 PDF：取上半页左侧栏最靠上的整数');
  var srcG = fakeSource([{ size: { w: W, h: H }, items: [
    item('Andante', 0.05, 0.95, W, H), // 速度记号，非数字
    item('3', 0.05, 0.92, W, H),       // 第一格
    item('4', 0.12, 0.92, W, H),
    item('5', 0.20, 0.92, W, H)
  ] }]);
  eq('取最靠左的整数 3', await R.readPageBarNumbers(srcG, 0), 3);

  console.log('\n[H] 扫描件无文字层 → null（回退手动）');
  var srcH = fakeSource([{ size: { w: W, h: H }, items: [] }]);
  ok('无文字层返回 null', (await R.readPageBarNumbers(srcH, 0)) === null);

  console.log('\n[I] 页脚页码（下半页）与文字被排除，只留上半页左侧');
  var srcI = fakeSource([{ size: { w: W, h: H }, items: [
    item('5', 0.05, 0.90, W, H),       // 上半页左侧小节号
    item('9', 0.50, 0.10, W, H),       // 下半页中间的页码，ny<0.5 排除
    item('Allegro', 0.40, 0.30, W, H)  // 普通文字，非数字
  ] }]);
  eq('→ 5', await R.readPageBarNumbers(srcI, 0), 5);

  console.log('\n[J] 带尾点的 "1." 解析为 1');
  var srcJ = fakeSource([{ size: { w: W, h: H }, items: [ item('1.', 0.05, 0.90, W, H) ] }]);
  eq('"1." → 1', await R.readPageBarNumbers(srcJ, 0), 1);

  console.log('\n[K] 非 pdf 源（如扫描图片）直接返回 null');
  var srcK = { kind: 'image', size: function () { return Promise.resolve({}); }, textContent: function () { return Promise.resolve({ items: [] }); } };
  ok('非 pdf 返回 null', (await R.readPageBarNumbers(srcK, 0)) === null);

  console.log('\n[L] 一页多套谱表：只取最靠上的那套，忽略下方谱表');
  var srcL = fakeSource([{ size: { w: W, h: H }, items: [
    item('11', 0.05, 0.92, W, H),  // 第一套谱表（最靠上）最左
    item('12', 0.12, 0.92, W, H),
    item('19', 0.05, 0.55, W, H)   // 第二套谱表（仍在上半页，但偏低）
  ] }]);
  eq('取最靠上的 11，而非偏下的 19', await R.readPageBarNumbers(srcL, 0), 11);

  console.log('\n[M] 数字过大/非合理小节号 → null（不瞎填）');
  var srcM = fakeSource([{ size: { w: W, h: H }, items: [ item('9999', 0.05, 0.92, W, H) ] }]);
  ok('9999 超界返回 null', (await R.readPageBarNumbers(srcM, 0)) === null);

  var S = R.solveStarts;
  console.log('\n[N] solveStarts：吉他谱品格数字噪声下，多页互相印证出正确起始号');
  (function () {
    // 6 页、每页 16 格；每页候选里混着品格数字噪声，正确页起始号只在真值处多页一致
    var counts = [16, 16, 16, 16, 16, 16];
    var cand = [
      [1, 3, 5, 0],          // P1 真起始 1 + 噪声
      [17, 2, 7],            // P2 真起始 17 + 噪声
      [33, 5],               // P3 真起始 33
      [49, 0, 8],            // P4 真起始 49
      [65, 3],               // P5 真起始 65
      [81, 6]                // P6 真起始 81
    ];
    var r = S(cand, counts);
    ok('能解出', !!r);
    eq('P1=1', r.starts[0], 1);
    eq('P2=17', r.starts[1], 17);
    eq('P6=81', r.starts[5], 81);
    eq('6 页互相印证', r.votes, 6);
  })();

  console.log('\n[O] solveStarts：噪声巧合投票不过半，真值胜出');
  (function () {
    var r = S([[1, 3, 7], [17, 5]], [16, 16]);
    // s0=1 被两页印证（1 和 17-16）；3、7、5-16(-11) 各 1 票
    ok('解出 s0=1', !!r && r.starts[0] === 1);
    eq('两页印证', r.votes, 2);
  })();

  console.log('\n[P] solveStarts：只有一页有候选 → 拒绝下结论（票数<2）');
  (function () {
    var r = S([[1, 3], []], [16, 16]);
    ok('返回 null', r === null);
  })();

  console.log('\n[Q] solveStarts：页间印刷号对不上格数链（如识别格数有出入）→ 拒绝瞎猜');
  (function () {
    // P1 印 1、每页 16 格则 P2 应印 17；实际读到 20 → 两页各 1 票、互不印证
    var r = S([[1], [20]], [16, 16]);
    ok('返回 null', r === null, JSON.stringify(r));
  })();

  console.log('\n[R] readPageBarCandidates：含下方谱表、去重、排除页脚');
  var srcR = fakeSource([{ size: { w: W, h: H }, items: [
    item('17', 0.05, 0.90, W, H),   // 行首小节号
    item('17', 0.06, 0.55, W, H),   // 同号重复 → 去重
    item('21', 0.05, 0.40, W, H),   // 下方谱表的小节号（ny≥0.30 应保留）
    item('9', 0.50, 0.10, W, H),    // 页脚页码（排除）
    item('3', 0.05, 0.20, W, H)     // 页脚附近（排除）
  ] }]);
  eq('候选 = [17, 21]', await R.readPageBarCandidates(srcR, 0), [17, 21]);

  console.log('\n[S] 复现用户场景：六线谱噪声 + 旧值 72 → 投票覆盖为真值');
  (function () {
    // 用户旧对齐值可能是 72（错），重读后投票解出真值 70 起始 → 整体覆盖
    var counts = [16, 16, 16];
    var cand = [[70, 3, 5], [86, 2], [102, 7]];
    var r = S(cand, counts);
    ok('解出 s0=70', !!r && r.starts[0] === 70, JSON.stringify(r));
    eq('P3=102', r.starts[2], 102);
  })();

  console.log('\n[T] readPageRuler：吉他谱「顶部小节号标尺」识别（核心修复）');
  // 真实吉他六线谱：小节号印在页面顶端一条横跨整页的水平标尺上（同高度、连续递增），
  // 而六线谱品格数字散布在下方各弦线，且偶尔形成更长的连续串——但标尺在「更高」的位置。
  // 真实失败样本：标尺 33-36 @0.8904，下方品格数字串 1-6 @0.86~0.88（更长但更低）
    var srcT1 = fakeSource([{ size: { w: W, h: H }, items: [
      item('33', 0.05, 0.8904, W, H), item('34', 0.20, 0.8904, W, H),
      item('35', 0.35, 0.8904, W, H), item('36', 0.50, 0.8904, W, H),
      item('1', 0.10, 0.8712, W, H), item('2', 0.12, 0.8642, W, H),
      item('3', 0.14, 0.8712, W, H), item('4', 0.16, 0.8642, W, H),
      item('5', 0.18, 0.8783, W, H), item('6', 0.20, 0.8642, W, H),
      item('7', 0.05, 0.9411, W, H), item('4', 0.05, 0.926, W, H)  // 更高散点，非连续
    ] }]);
    var r1 = await R.readPageRuler(srcT1, 0);
    ok('品格噪声下取到标尺首号 33（而非更长的 1）', r1 && r1.start === 33, JSON.stringify(r1));
    eq('标尺长度 4', r1 && r1.count, 4);

    // 干净标尺
    var srcT2 = fakeSource([{ size: { w: W, h: H }, items: [
      item('17', 0.05, 0.8904, W, H), item('18', 0.20, 0.8904, W, H),
      item('19', 0.35, 0.8904, W, H), item('20', 0.50, 0.8904, W, H)
    ] }]);
    eq('clean ruler start=17', (await R.readPageRuler(srcT2, 0)).start, 17);

    // 标题页：顶部无整数 → null
    var srcT3 = fakeSource([{ size: { w: W, h: H }, items: [
      item('5', 0.10, 0.50, W, H), item('8', 0.10, 0.40, W, H)  // 都在 ny<0.86
    ] }]);
    ok('无顶部标尺 → null', (await R.readPageRuler(srcT3, 0)) === null);

    // 更高的散点若连不成 ≥3 的连续串，不应盖过标尺
    var srcT4 = fakeSource([{ size: { w: W, h: H }, items: [
      item('90', 0.05, 0.95, W, H), item('91', 0.10, 0.95, W, H),  // 高但仅 2 连，不算标尺
      item('13', 0.05, 0.8904, W, H), item('14', 0.20, 0.8904, W, H),
      item('15', 0.35, 0.8904, W, H), item('16', 0.50, 0.8904, W, H)
    ] }]);
    eq('高但短的散点不算，取 13', (await R.readPageRuler(srcT4, 0)).start, 13);

  console.log('\n[U] solveStartsFromStarts：标尺直读 + 跨页投票补全标题页/漏读页');
  var F = R.solveStartsFromStarts;
  {
    var starts = [null, 17, 33, 49, 67, 87];   // 伴奏-like：P1 标题页无标尺
    var counts = [0, 16, 16, 18, 20, 16];
    var r = F(starts, counts);
    ok('解出', !!r);
    eq('P2=17', r.starts[1], 17); eq('P3=33', r.starts[2], 33);
    eq('P6=87', r.starts[5], 87); eq('印证 5 页', r.votes, 5);
    // 漏读一页标尺仍能补出
    var r2 = F([null, 17, null, 49, 67, 87], counts);
    eq('漏读 P3 补全=33', r2.starts[2], 33);
  }

  console.log('\n=== 统计 ===');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
