// 用真实扫描谱的像素跑真实 detectPage（离线 canvas 打桩），真值：第1页 14 个小节（3+4+4+3）
'use strict';
var fs = require('fs');
var B = 'C:/Users/31777/WorkBuddy/2026-09-20-10-15-19/';
if (!fs.existsSync(B + '_p1.raw') || !fs.existsSync(B + '_p1.json')) {
  console.log('（跳过：缺少真实扫描稿素材 _p1.raw/_p1.json，见 tests/README 说明如何生成）');
  process.exit(0);
}
var meta = JSON.parse(fs.readFileSync(B + '_p1.json', 'utf8'));
var gray = fs.readFileSync(B + '_p1.raw');
var W = meta.w, H = meta.h;

var buf = new Uint8ClampedArray(W * H * 4);
for (var i = 0, p = 0; i < W * H; i++, p += 4) {
  var v = gray[i]; buf[p] = buf[p + 1] = buf[p + 2] = v; buf[p + 3] = 255;
}
var registry = { k: { w: W, h: H, buf: buf } };
global.document = {
  createElement: function () {
    var cv = { width: 0, height: 0, _buf: null };
    cv.getContext = function () {
      return {
        drawImage: function (im) { cv.width = im.naturalWidth; cv.height = im.naturalHeight; cv._buf = registry[im.src].buf; },
        getImageData: function () { return { data: cv._buf }; }
      };
    };
    return cv;
  }
};
global.Image = function () {
  var self = this;
  Object.defineProperty(this, 'src', {
    set: function (v) {
      self._src = v; self.naturalWidth = W; self.naturalHeight = H;
      setTimeout(function () { self.onload && self.onload(); }, 0);
    },
    get: function () { return self._src; }
  });
};
require('../js/modules/barlineDetect.js');
var D = global.ST.BarlineDetect;

D.detectPage({ kind: 'image', render: function () { return Promise.resolve({ dataUrl: 'k', w: W, h: H }); } }, 0, { targetWidth: 1500 })
  .then(function (r) {
    console.log('真实扫描稿《Love Song》第1页  真值=14（系统内 3+4+4+3）');
    console.log('  识别到行数 =', r.rows);
    console.log('  识别到小节数 =', r.measures.length);
    (r.debug && r.debug.rowInfo || []).forEach(function (x) {
      console.log('    行' + x.row + ' 谱高=' + x.bh + ' 边界=' + x.bounds + ' 小节=' + x.measures + ' 跳过窄缝=' + x.skippedNarrow + ' 反复=' + x.repeats + ' 终止=' + x.finals);
    });
    console.log(r.measures.length === 14 ? '\n✅ 与真值一致' : '\n❌ 与真值不符（差 ' + (r.measures.length - 14) + '）');
  });
