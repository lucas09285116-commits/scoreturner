/**
 * tests/pixelscene.test.js —— 像素路径（扫描件/图片谱）回归测试
 * ---------------------------------------------------------------------------
 * detectPage 原本只能在浏览器里跑（要 canvas/DOM）。这里用极简的"离屏 canvas 打桩"
 * 把真实算法放到 Node 里跑：合成若干真实排版的谱面场景（含六线谱+人声单线谱、
 * 反复圆点、终止线、和弦图、歌词行、琶音箭头、水印），校验小节数与反复/终止语义。
 *
 * 跑法： node tests/pixelscene.test.js
 */
'use strict';

/* ---------------- 极简 canvas / Image 打桩 ---------------- */
var registry = {};            // dataUrl -> {w,h,rgba:Uint8ClampedArray}
var nextKey = 0;

function makeScene(w, h) {
  var buf = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < buf.length; i += 4) { buf[i] = buf[i + 1] = buf[i + 2] = 255; buf[i + 3] = 255; }
  var s = {
    w: w, h: h, buf: buf,
    px: function (x, y, v) {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var p = (y * w + x) * 4;
      buf[p] = buf[p + 1] = buf[p + 2] = v;
    },
    hline: function (x0, x1, y, th, v) {
      for (var t = 0; t < (th || 2); t++) for (var x = x0; x <= x1; x++) s.px(x, y + t, v == null ? 60 : v);
    },
    vline: function (x, y0, y1, th, v) {
      for (var t = 0; t < (th || 2); t++) for (var y = y0; y <= y1; y++) s.px(x + t, y, v == null ? 40 : v);
    },
    dot: function (cx, cy, r, v) {
      for (var y = -r; y <= r; y++) for (var x = -r; x <= r; x++) if (x * x + y * y <= r * r) s.px(cx + x, cy + y, v == null ? 30 : v);
    }
  };
  return s;
}

global.document = {
  createElement: function () {
    var cv = { width: 0, height: 0, _buf: null };
    cv.getContext = function () {
      return {
        drawImage: function (im) {
          cv.width = im.naturalWidth; cv.height = im.naturalHeight;
          var rec = registry[im.src];
          cv._buf = rec ? rec.buf : null;
        },
        getImageData: function (x, y, w, h) { return { data: cv._buf }; }
      };
    };
    return cv;
  }
};
global.Image = function () {
  var self = this;
  Object.defineProperty(this, 'src', {
    set: function (v) {
      self._src = v;
      var rec = registry[v];
      if (!rec) { setTimeout(function () { self.onerror && self.onerror(new Error('no scene')); }, 0); return; }
      self.naturalWidth = rec.w; self.naturalHeight = rec.h;
      setTimeout(function () { self.onload && self.onload(); }, 0);
    },
    get: function () { return self._src; }
  });
};

function sourceOf(scene) {
  var key = 'scene://' + (nextKey++);
  registry[key] = { w: scene.w, h: scene.h, buf: scene.buf };
  return {
    kind: 'image',
    render: function () { return Promise.resolve({ dataUrl: key, w: scene.w, h: scene.h }); }
  };
}

require('../js/modules/barlineDetect.js');
var D = global.ST.BarlineDetect;

var pass = 0, fail = 0;
function eq(name, a, e) {
  var A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      实际: ' + A + '\n      期望: ' + E); }
}
function ok(name, c, extra) {
  if (c) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------------- 场景构造工具 ---------------- */
var W = 1500, H = 1100;
var LEFT = 70, RIGHT = 1430;

// 六线谱（TAB）谱表：6 条线，行距 d
function tabStaff(s, y, d) {
  for (var i = 0; i < 6; i++) s.hline(LEFT, RIGHT, y + i * d, 2, 60);
  return { top: y, bot: y + 5 * d, d: d };
}
// 人声单线谱（Love Song 同款）：TAB 下方约 2.2d 处一条线
function vocalLine(s, y, d) { s.hline(LEFT, RIGHT, y, 2, 60); return y; }
// 小节线：贯穿整个系统（谱表+人声线）
function barline(s, x, top, bot) { s.vline(x, top, bot, 3, 40); }
// 双竖线（两根细线，间距 g）
function doubleBar(s, x, top, bot, g) { s.vline(x, top, bot, 2, 40); s.vline(x + g, top, bot, 2, 40); }
// 反复圆点：双竖线缝隙内上下各一个
function repeatDots(s, x, g, top, bot) {
  var cy1 = top + (bot - top) * 0.35, cy2 = top + (bot - top) * 0.65;
  s.dot(Math.round(x + g / 2), Math.round(cy1), 3, 30);
  s.dot(Math.round(x + g / 2), Math.round(cy2), 3, 30);
}
// 符干：只覆盖谱表内（不穿谱表间空隙）
function stem(s, x, top, bot, shrink) { s.vline(x, top, bot - (shrink || 6), 2, 40); }
// 琶音箭头：高大、贯穿谱表但不穿空隙（Love Song 的误判元凶）
function arpArrow(s, x, top, bot) { s.vline(x, top, bot, 3, 40); }
// 和弦图（谱表上方）：细竖线 w≈1.2 → 不应被当小节线
function chordBox(s, cx, cy) {
  for (var i = 0; i < 6; i++) s.vline(cx + i * 8, cy, cy + 40, 1, 90);
  for (var j = 0; j < 5; j++) s.hline(cx, cx + 40, cy + j * 10, 1, 90);
}
// 歌词行（系统下方）
function lyricRow(s, y) { s.hline(LEFT, RIGHT, y, 3, 120); }
// 斜向水印（压淡局部谱线）
function watermark(s) {
  for (var k = 0; k < s.h; k += 3) s.px(200 + k * 0.6, k, 235);
}

(async function () {
  /* [P1] 纯六线谱，4 小节 */
  console.log('\n[P1] 六线谱单行：4 小节');
  var s1 = makeScene(W, H);
  var st1 = tabStaff(s1, 300, 14);              // 谱表 300~370
  // 真实谱每个系统首尾都有小节线
  [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s1, x, st1.top, st1.bot); });
  var r1 = await D.detectPage(sourceOf(s1), 0, { targetWidth: 1500 });
  eq('4 小节', r1.measures.length, 4);
  eq('1 行', r1.rows, 1);

  /* [P2] TAB + 人声单线谱（Love Song 排版），含琶音箭头 → 箭头不得被当小节线 */
  console.log('\n[P2] TAB+人声单线谱：箭头/符干不得误判成小节线');
  var s2 = makeScene(W, H);
  var st2 = tabStaff(s2, 300, 14);
  var voc2 = vocalLine(s2, 300 + 5 * 14 + 32);   // 人声线
  var sysTop = st2.top, sysBot = voc2;
  [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s2, x, sysTop, sysBot); });
  arpArrow(s2, 470, sysTop, st2.bot);            // 只到谱表底，未穿空隙
  stem(s2, 810, sysTop, st2.bot);
  var r2 = await D.detectPage(sourceOf(s2), 0, { targetWidth: 1500 });
  eq('仍是 4 小节（箭头/符干不算）', r2.measures.length, 4);

  /* [P3] 反复线（带圆点） + 终止线（无圆点）：语义不得混淆 */
  console.log('\n[P3] 反复线带圆点 / 终止线无圆点');
  var s3 = makeScene(W, H);
  var st3 = tabStaff(s3, 300, 14);
  var rep3 = doubleBar(s3, 640, st3.top, st3.bot, 10); repeatDots(s3, 640, 10, st3.top, st3.bot);
  doubleBar(s3, 1320, st3.top, st3.bot, 10);     // 终止线：无圆点
  barline(s3, LEFT, st3.top, st3.bot); barline(s3, 300, st3.top, st3.bot); barline(s3, 980, st3.top, st3.bot); barline(s3, RIGHT, st3.top, st3.bot);
  var r3 = await D.detectPage(sourceOf(s3), 0, { targetWidth: 1500 });
  var rep = r3.measures.filter(function (m) { return m.doubleLeft || m.doubleRight; });
  var fin = r3.measures.filter(function (m) { return m.finalLeft || m.finalRight; });
  ok('带圆点的双竖线 → 反复', rep.length >= 1, 'rep=' + rep.length);
  ok('无圆点的双竖线 → 终止(final)，不是反复', fin.length >= 1);
  ok('反复与终止互不混淆', rep.every(function (m) { return !m.finalLeft && !m.finalRight; }));

  /* [P4] 和弦图 + 歌词行干扰：不得多出小节 */
  console.log('\n[P4] 和弦图/歌词行干扰');
  var s4 = makeScene(W, H);
  var st4 = tabStaff(s4, 300, 14);
  [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s4, x, st4.top, st4.bot); });
  chordBox(s4, 420, 180); chordBox(s4, 760, 180);
  lyricRow(s4, 430);
  var r4 = await D.detectPage(sourceOf(s4), 0, { targetWidth: 1500 });
  eq('仍是 4 小节', r4.measures.length, 4);

  /* [P5] 水印压淡部分谱线：仍能识别出行（漏行是《Love Song》的痛点） */
  console.log('\n[P5] 斜向水印压淡谱线');
  var s5 = makeScene(W, H);
  var st5 = tabStaff(s5, 300, 14);
  [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s5, x, st5.top, st5.bot); });
  watermark(s5);
  var r5 = await D.detectPage(sourceOf(s5), 0, { targetWidth: 1500 });
  eq('水印下仍找到 1 行', r5.rows, 1);
  eq('水印下仍是 4 小节', r5.measures.length, 4);

  /* [P6] 两行系统：行序自上而下、每小节带 row/index */
  console.log('\n[P6] 双行系统：编号与顺序');
  var s6 = makeScene(W, H);
  var a6 = tabStaff(s6, 250, 14); [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s6, x, a6.top, a6.bot); });
  var b6 = tabStaff(s6, 700, 14); [LEFT, 300, 640, 980, RIGHT].forEach(function (x) { barline(s6, x, b6.top, b6.bot); });
  var r6 = await D.detectPage(sourceOf(s6), 0, { targetWidth: 1500 });
  eq('2 行 8 小节', r6.measures.length, 8);
  eq('第一行 row=0', r6.measures.slice(0, 4).map(function (m) { return m.row; }), [0, 0, 0, 0]);
  eq('第二行 row=1', r6.measures.slice(4).map(function (m) { return m.row; }), [1, 1, 1, 1]);
  ok('行间自上而下', r6.measures[0].y < r6.measures[4].y);

  console.log('\n=== 统计 ===');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
