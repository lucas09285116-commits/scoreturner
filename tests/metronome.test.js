/**
 * tests/metronome.test.js
 * 用假 AudioContext 把节拍器跑起来（不依赖真实音频时钟），校验两件事：
 *   1) 每次发声携带的 indexInBar，必须等于"这一声响完之后"真正所在的小节内第几拍
 *   2) 第 1 拍（重音）响起的瞬间，高亮必须正好进入新的一小节
 * 这是用户反馈"橙灯亮了但没进下一小节"的回归测试。
 */
require('../js/core/bus.js');
require('../js/core/store.js');
require('../js/modules/structure.js');
require('../js/modules/tracker.js');
require('../js/modules/metronome.js');
var ST = globalThis.ST;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

/* ---- 造一份 8 小节 4/4 的乐谱 ---- */
var store = ST.createStore(ST.defaultState());
var measures = [];
for (var i = 0; i < 8; i++) {
  measures.push({ id: 'm' + i, page: 0, bar: i + 1, x: i * 0.1, y: 0.2, w: 0.09, h: 0.2 });
}
var tl = ST.Structure.buildTimeline(ST.Structure.sortMeasures(measures), { timeSig: { num: 4, den: 4 } });
store.set({ timeline: tl.entries, timelineTotalBeats: tl.totalBeats });
store.set({ score: { id: 'x', name: 't', pages: [{ w: 1, h: 1 }], measures: measures, rev: 0 }, transport: { bpm: 120 } });

var bus = ST.createBus();
var tracker = new ST.Tracker({ store: store, bus: bus });
var metro = new ST.Metronome({ store: store, bus: bus, ctxProvider: function (o) { return tracker.peekAhead(o); } });

/* ---- 假音频上下文：时间由我们手动推进 ---- */
var fakeCtx = {
  currentTime: 0,
  destination: {},
  createGain: function () {
    return {
      gain: { value: 0, setValueAtTime: function () { }, exponentialRampToValueAtTime: function () { }, linearRampToValueAtTime: function () { } },
      connect: function () { }
    };
  },
  createOscillator: function () {
    return { type: '', frequency: { setValueAtTime: function () { } }, connect: function () { }, start: function () { }, stop: function () { } };
  }
};
metro.ctx = fakeCtx;
metro.master = fakeCtx.createGain();
metro.playing = true;
metro.nextTime = 0.05;

/* ---- 记录：发声时的载荷 vs 发声后真实位置 ---- */
var rec = [];
bus.on('beat', function (q) {
  if (typeof q.beatIndex === 'number') tracker.setBeat(q.beatIndex);   // 与 app.js 一致
  else tracker.onBeat();
  var st = store.get();
  var e = st.timeline[st.transport.tlIndex];
  rec.push({
    shown: q.indexInBar,
    real: st.transport.beat - e.firstBeat,
    beatsPerBar: q.beatsPerBar,
    bar: e.bar
  });
});

var secPerBeat = 60 / store.get().transport.bpm;
for (var step = 0; step < 400; step++) {
  fakeCtx.currentTime += 0.02;
  metro.schedule();
  metro.pump();
}

console.log('\n[1] 拍点载荷与实际位置一致');
(function () {
  var bad = rec.filter(function (r) { return r.shown !== r.real; });
  ok('共 ' + rec.length + ' 拍，载荷与真实拍位完全对齐',
    bad.length === 0,
    '前几个错配：' + JSON.stringify(bad.slice(0, 4)));
})();

console.log('\n[2] 小节内拍序循环正确');
(function () {
  var seq = rec.slice(0, 12).map(function (r) { return r.shown; }).join(',');
  ok('拍序 = 0,1,2,3 循环（第一声就是小节第 1 拍）', /^0,1,2,3,0,1,2,3,0/.test(seq), '实际：' + seq);
})();

console.log('\n[3] 第 1 拍响起的瞬间正好进入新小节');
(function () {
  var wrong = [];
  for (var i = 1; i < rec.length; i++) {
    if (rec[i].shown === 0 && rec[i].bar === rec[i - 1].bar) wrong.push(i);   // 橙灯亮了却还在同一小节
  }
  ok('没有"橙灯亮但小节没变"的情况', wrong.length === 0, '出现在序号：' + wrong.slice(0, 5).join(','));
  var okCount = rec.filter(function (r, i) { return r.shown === 0 && i > 0 && rec[i - 1].bar !== r.bar; }).length;
  ok('第 1 拍与换小节同步出现 ' + okCount + ' 次', okCount >= 2);
})();

console.log('\n[4] 拍数随拍号');
(function () {
  var all4 = rec.every(function (r) { return r.beatsPerBar === 4; });
  ok('4/4 下每格 4 拍', all4);
  // 换成 3/4
  var tl2 = ST.Structure.buildTimeline(ST.Structure.sortMeasures(measures), { timeSig: { num: 3, den: 4 } });
  store.set({ timeline: tl2.entries, timelineTotalBeats: tl2.totalBeats });
  tracker.reset();
  metro.consumed = 0; metro.schedIndex = 0; metro.queue.length = 0;
  var rec2 = [];
  var savedRec = rec; rec = rec2;
  for (var s = 0; s < 120; s++) { fakeCtx.currentTime += 0.02; metro.schedule(); metro.pump(); }
  rec = savedRec;
  var bad2 = rec2.filter(function (r) { return r.shown !== r.real; });
  ok('3/4 下同样对齐（共 ' + rec2.length + ' 拍）', bad2.length === 0, JSON.stringify(bad2.slice(0, 3)));
  ok('3/4 下 beatsPerBar=3', rec2.every(function (r) { return r.beatsPerBar === 3; }));
})();

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n');
process.exit(fail ? 1 : 0);
