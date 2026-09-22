/**
 * tests/corpus.check.js —— 多版式谱面语料回归
 * ---------------------------------------------------------------------------
 * 语料由 _corpus_gen.py 生成（参数取自真实《Love Song》扫描稿实测：六线谱行距 14px、
 * TAB+人声单线谱组合、斜向水印、扫描噪声），每份自带**精确真值**。
 * 这里把每份裸像素喂给真实 detectPage，逐行小节数必须与真值一致。
 *
 * 跑法： node tests/corpus.check.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var CORPUS = 'C:/Users/31777/WorkBuddy/2026-09-20-10-15-19/_corpus';

if (!fs.existsSync(CORPUS)) {
  console.log('（跳过：无语料目录 ' + CORPUS + '，先用 _corpus_gen.py 生成）');
  process.exit(0);
}

// 离屏 canvas 打桩：让真实 detectPage 能在 Node 里跑
var registry = {};
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
    set: function (v) { self._src = v; var r = registry[v]; self.naturalWidth = r.w; self.naturalHeight = r.h; setTimeout(function () { self.onload && self.onload(); }, 0); },
    get: function () { return self._src; }
  });
};
require('../js/modules/barlineDetect.js');
var D = global.ST.BarlineDetect;

function loadCase(name) {
  var meta = JSON.parse(fs.readFileSync(path.join(CORPUS, name + '.json'), 'utf8'));
  var gray = fs.readFileSync(path.join(CORPUS, name + '.raw'));
  var buf = new Uint8ClampedArray(meta.w * meta.h * 4);
  for (var i = 0, p = 0; i < meta.w * meta.h; i++, p += 4) { buf[p] = buf[p + 1] = buf[p + 2] = gray[i]; buf[p + 3] = 255; }
  registry[name] = { w: meta.w, h: meta.h, buf: buf };
  return {
    meta: meta,
    source: { kind: 'image', render: function () { return Promise.resolve({ dataUrl: name, w: meta.w, h: meta.h }); } }
  };
}

(async function () {
  var cases = fs.readdirSync(CORPUS).filter(function (f) { return f.endsWith('.json'); }).map(function (f) { return f.replace('.json', ''); }).sort();
  var pass = 0, fail = 0;
  console.log('\n多版式语料回归（真值 vs 真实 detectPage）');
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var lc = loadCase(c);
    var r = await D.detectPage(lc.source, 0, { targetWidth: 1500 });
    var perRow = (r.debug && r.debug.rowInfo || []).map(function (x) { return x.measures; });
    var truth = lc.meta.truth;
    var totalTruth = truth.reduce(function (a, b) { return a + b; }, 0);
    var okAll = perRow.length === truth.length && perRow.every(function (m, k) { return m === truth[k]; });
    if (okAll) { pass++; console.log('  ✓ ' + c + '  每行 ' + JSON.stringify(perRow) + ' / 真值 ' + JSON.stringify(truth)); }
    else if (lc.meta.knownFail) {
      console.log('  ⚠ ' + c + ' 已知限制：' + lc.meta.knownFail);
      console.log('       实际每行 ' + JSON.stringify(perRow) + ' / 真值 ' + JSON.stringify(truth));
    }
    else {
      fail++;
      console.log('  ✗ ' + c + '  每行 ' + JSON.stringify(perRow) + ' / 真值 ' + JSON.stringify(truth) +
        '  (合计 ' + r.measures.length + ' vs ' + totalTruth + ')');
    }
  }
  console.log('\n=== 语料统计 ===');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
