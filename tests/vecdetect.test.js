/**
 * tests/vecdetect.test.js
 * 验证「矢量小节线检测」(ST.BarlineDetect.detectPageVec / extractVecPrimitives / detectFromVecPrimitives)。
 * 用合成的 operatorList 直接测（不需要 pdf.js、不需要 DOM）：
 *   - 小节线矩形（w>=1.8）与和弦图竖线（w=1.2）的区分
 *   - 系统起始全长线段（>=200）与长符干（<200）的区分
 *   - 双吉他大谱表被链式聚类拆成多个子簇后，按 y 重叠合并
 *   - 【核心】双竖线语义判定：反复线(|: :|) 必须带「反复圆点」才是反复；
 *     终止线（细+细 / 细+粗，无圆点）一律当段落结束(final)，绝不生成 repeat、绝不回溯。
 *     —— 这是《二十二》吉他谱"终止线被误判为反复线导致跳回"的根因修复。
 *   - CTM 变换跟踪、扫描件（无矢量图元）返回 null、非 PDF 源返回 null
 *
 * 用 Node 直接跑： node tests/vecdetect.test.js
 */
// 先注入 mock pdfjsLib（只提供 OPS 常量表；constructPath 用 99 与真实值无关，测试自洽即可）
globalThis.pdfjsLib = {
  OPS: { save: 10, restore: 11, transform: 12, constructPath: 99, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, rectangle: 19, fill: 23, eofill: 24 }
};
require('../js/modules/barlineDetect.js');
var D = globalThis.ST.BarlineDetect;

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

/* ---------- 合成 operatorList 的工具 ---------- */
var OP = globalThis.pdfjsLib.OPS;
function opList(items) {
  return { fnArray: items.map(function (i) { return i[0]; }), argsArray: items.map(function (i) { return i[1]; }) };
}
// constructPath/rectangle：小节线等矩形图元
function rect(x, y, w, h) { return [OP.constructPath, [[19], [x, y, w, h]]]; }
// constructPath/moveTo+lineTo：线段图元
function line(x1, y1, x2, y2) { return [OP.constructPath, [[13, 14], [x1, y1, x2, y2]]]; }
function transform(a, b, c, d, e, f) { return [OP.transform, [a, b, c, d, e, f]]; }
// 反复圆点：一个 4×4 实心方块（rectangle + fill），落在双竖线缝隙里
function dot(x, y) { return [OP.constructPath, [[19], [x - 2, y - 2, 4, 4]]]; }
function fill() { return [OP.fill, []]; }

// 伪 PDF 源：size + operatorList
function fakeSource(pages) {
  return {
    kind: 'pdf',
    size: function (i) { return Promise.resolve(pages[i].size); },
    operatorList: function (i) { return Promise.resolve(pages[i].opList); }
  };
}

// 一个标准单谱表系统：谱线 + 小节线 + 起始竖线
// top/bot 是 PDF 用户空间 y（自底向上）；xs 是小节线 x 列表
function stdSystem(top, bot, xs) {
  var items = [
    line(40, top, 560, top),           // 上谱线（水平段，供左右边界）
    line(40, bot, 560, bot)             // 下谱线
  ];
  xs.forEach(function (x) { items.push(rect(x, bot, 2.5, top - bot)); });   // 小节线
  items.push(line(40, bot, 40, top));   // 系统起始全长竖线（跨度=top-bot）
  return items;
}

(async function () {
  var W = 595, H = 1600;

  console.log('\n[V] 矢量检测：单系统 4 小节');
  var v1 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(stdSystem(1500, 1300, [200, 360, 520])) }]), 0);
  eq('4 小节', v1.measures.length, 4);
  eq('1 系统', v1.rows, 1);
  ok('小节宽 ≈ (360-200)/595', Math.abs(v1.measures[0].w - 160 / 595) < 0.01);
  ok('y 为顶部归一（上小下大）', Math.abs(v1.measures[0].y - (H - 1500) / H) < 0.001);

  console.log('\n[V2] 小节线分成五线谱/六线谱两段（y 不重叠 → 合并为一条边界，不是双竖线）');
  var items2 = [
    line(40, 1500, 560, 1500), line(40, 1300, 560, 1300),
    rect(200, 1440, 2.5, 60),          // 五线谱段
    rect(200, 1300, 2.5, 116),         // 六线谱段（同 x、y 带不重叠）
    rect(360, 1440, 2.5, 60), rect(360, 1300, 2.5, 116),
    rect(520, 1440, 2.5, 60), rect(520, 1300, 2.5, 116),
    line(40, 1300, 40, 1500)
  ];
  var v2 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items2) }]), 0);
  eq('仍是 4 小节（两段合一）', v2.measures.length, 4);
  eq('无双竖线', v2.doubles, 0);

  console.log('\n[V3] 双竖线（细+细）但无反复圆点 → 段落终止(final)，绝不生成 repeat');
  var items3 = stdSystem(1500, 1300, [200, 360, 520]);
  items3.push(rect(205, 1350, 2.5, 140));   // 与 x=200 的线 y 带重叠 → 双竖线（无圆点）
  var v3 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items3) }]), 0);
  eq('4 小节', v3.measures.length, 4);
  ok('双竖线无圆点 → 不生成 repeat（doubles=0）', v3.doubles === 0, 'doubles=' + v3.doubles);
  var rep3 = v3.measures.filter(function (m) { return m.doubleLeft || m.doubleRight; });
  ok('双竖线无圆点 → 无 doubleLeft/doubleRight（不回溯）', rep3.length === 0, '假反复=' + rep3.length);
  var fin3 = v3.measures.filter(function (m) { return m.finalLeft || m.finalRight; });
  ok('双竖线无圆点 → 标记为 final（段落终止）', fin3.length >= 1);

  console.log('\n[V4] 和弦图竖线（w=1.2）不产生小节边界');
  var items4 = stdSystem(1500, 1300, [200, 360, 520]);
  items4.push(rect(250, 1520, 1.2, 100));   // 和弦图竖线插在 200~360 之间
  var v4 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items4) }]), 0);
  eq('仍是 4 小节', v4.measures.length, 4);

  console.log('\n[V5] 长符干线段（h=157 < 200）不算系统起始线');
  var items5 = stdSystem(1500, 1300, [200, 360, 520]);
  items5.push(line(250, 1343, 250, 1500));  // 157 高的竖线段
  var v5 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items5) }]), 0);
  eq('仍是 4 小节', v5.measures.length, 4);

  console.log('\n[V6] 双吉他回归：大谱表被链式聚类拆成 3 个子簇（yc 间隔>250），y 重叠必须合并');
  // 全长起始竖线 y900~1500（yc=1200），上谱表矩形 yc=1470，下谱表矩形 yc=930：
  // 链式聚类 yc 间隔 270>250 → 拆成 3 簇；但三簇 y 范围互相重叠（900~960 / 900~1500 / 1440~1500）
  var items6 = [
    line(40, 900, 560, 900), line(40, 1500, 560, 1500),
    rect(200, 1440, 2.5, 60), rect(360, 1440, 2.5, 60), rect(520, 1440, 2.5, 60),   // 上吉他
    rect(200, 900, 2.5, 60), rect(360, 900, 2.5, 60), rect(520, 900, 2.5, 60),      // 下吉他
    line(40, 900, 40, 1500)                                                          // 全长起始线
  ];
  var v6 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items6) }]), 0);
  eq('合并后 1 系统（不修复时会是 3）', v6.rows, 1);
  eq('合并后 4 小节（不修复时会翻倍成 12）', v6.measures.length, 4);

  console.log('\n[V7] CTM 变换跟踪：scale=2 + 平移');
  var items7 = [
    transform(2, 0, 0, 2, 10, 20),
    line(15, 740, 275, 740), line(15, 640, 275, 640),
    rect(95, 640, 1.25, 100), rect(175, 640, 1.25, 100), rect(255, 640, 1.25, 100),
    line(15, 640, 15, 740)
  ];
  // 变换后：x'=2x+10, y'=2y+20 → 谱线 40~560、小节线 x=200/360/520、y 660~760…（与 V 同构）
  var v7 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items7) }]), 0);
  eq('CTM 后 4 小节', v7.measures.length, 4);
  eq('CTM 后 1 系统', v7.rows, 1);

  console.log('\n[V8] 回退语义：扫描件（无矢量线条）/ 非 PDF 源 / 异常 → null');
  var v8a = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList([[OP.transform, [1, 0, 0, 1, 0, 0]]]) }]), 0);
  eq('无图元 → null', v8a, null);
  var v8b = await D.detectPageVec({ kind: 'images' }, 0);
  eq('图片源 → null', v8b, null);
  var v8c = await D.detectPageVec({ kind: 'pdf', size: function () { return Promise.reject(new Error('x')); }, operatorList: function () { return Promise.reject(new Error('x')); } }, 0);
  eq('异常 → null', v8c, null);

  console.log('\n[V9] 多系统页面：系统自上而下输出（y 递增）');
  var items9 = stdSystem(1500, 1300, [200, 360, 520]).concat(stdSystem(1100, 900, [200, 360, 520]));
  var v9 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items9) }]), 0);
  eq('2 系统 8 小节', v9.measures.length, 8);
  eq('系统数 2', v9.rows, 2);
  ok('第一行在上（y 更小）', v9.measures[0].y < v9.measures[4].y);

  console.log('\n[V10] 终止线（细+粗，无圆点）≠ 反复线：不生成 repeat、且标记 final');
  // 系统右端是 终止线：细线 w=2.5 紧贴粗线 w=8（细粗，宽度比≫1 → 终止线）
  var items10 = [
    line(40, 1500, 600, 1500), line(40, 1300, 600, 1300),
    rect(200, 1300, 2.5, 200), rect(360, 1300, 2.5, 200), rect(520, 1300, 2.5, 200),
    rect(560, 1300, 2.5, 200),          // 终止线：细
    rect(564, 1300, 8, 200),            // 终止线：粗（明显更宽）
    line(40, 1300, 40, 1500)
  ];
  var v10 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items10) }]), 0);
  ok('无 repeat（doubles=0）', v10.doubles === 0, 'doubles=' + v10.doubles);
  var adj = v10.measures.filter(function (m) { return m.finalLeft || m.finalRight; });
  ok('终止线被标记为 final', adj.length >= 1);
  var falseRep = v10.measures.filter(function (m) { return m.doubleLeft || m.doubleRight; });
  ok('终止线未误标为反复线', falseRep.length === 0, '假反复=' + falseRep.length);

  console.log('\n[V11] 同一页混有 反复线(|: 带圆点) 与 终止线(细粗 无圆点)：互不打扰');
  var items11 = [
    line(40, 1500, 700, 1500), line(40, 1300, 700, 1300),
    rect(200, 1300, 2.5, 200), rect(205, 1300, 2.5, 200),   // 反复线：细+细（等宽）
    dot(201, 1400), fill(), dot(201, 1470), fill(),          // 反复圆点：落在两根细线之间的缝隙里
    rect(400, 1300, 2.5, 200), rect(560, 1300, 2.5, 200),   // 普通小节线
    rect(600, 1300, 2.5, 200), rect(604, 1300, 8, 200),     // 终止线：细+粗（无圆点）
    line(40, 1300, 40, 1500)
  ];
  var v11 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items11) }]), 0);
  ok('带圆点的反复线被识别为 repeat', v11.doubles === 1, 'doubles=' + v11.doubles);
  var rep = v11.measures.filter(function (m) { return m.doubleLeft || m.doubleRight; });
  ok('反复线有 repeat 标记', rep.length >= 1);
  ok('反复线不是 final', rep.every(function (m) { return !m.finalLeft && !m.finalRight; }));
  var fin = v11.measures.filter(function (m) { return m.finalLeft || m.finalRight; });
  ok('终止线(无圆点) 仍是 final 且无 repeat', fin.length >= 1 && fin.every(function (m) { return !m.doubleLeft && !m.doubleRight; }));

  console.log('\n[V12] 用户真实场景：细+细双竖线但无反复圆点 → 段落终止，绝不回溯');
  var items12 = [
    line(40, 1500, 700, 1500), line(40, 1300, 700, 1300),
    rect(200, 1300, 2.5, 200), rect(205, 1300, 2.5, 200),   // 细+细 双竖线，但没有任何圆点
    rect(400, 1300, 2.5, 200), rect(560, 1300, 2.5, 200),
    line(40, 1300, 40, 1500)
  ];
  var v12 = await D.detectPageVec(fakeSource([{ size: { w: W, h: H }, opList: opList(items12) }]), 0);
  ok('无反复圆点 → 不生成 repeat（doubles=0）', v12.doubles === 0, 'doubles=' + v12.doubles);
  var rep12 = v12.measures.filter(function (m) { return m.doubleLeft || m.doubleRight; });
  ok('无反复圆点 → 无任何 doubleLeft/doubleRight', rep12.length === 0, '假反复=' + rep12.length);
  var fin12 = v12.measures.filter(function (m) { return m.finalLeft || m.finalRight; });
  ok('无反复圆点 → 标记为 final（段落终止）', fin12.length >= 1);

  console.log('\n[V13] 单元：extractVecPrimitives 提取反复圆点（小实心方块→dot；过大→忽略）');
  var ol13 = opList([
    dot(201, 1400), fill(),
    dot(201, 1470), fill(),
    rect(300, 1300, 20, 20), fill()     // 20×20 实心块，远大于圆点 → 不算
  ]);
  var vec13 = D.extractVecPrimitives(ol13);
  eq('提取到 2 个圆点', vec13.dots.length, 2);
  ok('圆点坐标接近 (201,1400)/(201,1470)',
    Math.abs(vec13.dots[0].x - 201) < 1 && Math.abs(vec13.dots[0].y - 1400) < 1 &&
    Math.abs(vec13.dots[1].x - 201) < 1 && Math.abs(vec13.dots[1].y - 1470) < 1);

  console.log('\n=== 统计 ===');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
