/**
 * modules/tracker.js
 * ---------------------------------------------------------------------------
 * 演奏进度的唯一权威。时钟不在这里——这里只回答两个问题：
 *   「我现在在第几拍」「这一拍落在时间线的哪一格」。
 *
 * 之所以能用这么薄的实现，是因为跳转结构已经被 structure.js 展开掉了：
 * 反复回头在时间线上表现为"序号变小"，对追踪逻辑完全透明。
 *
 * 手动校正全部收敛到一个入口 `setBeat`，这样无论来自点击、快捷键还是踏板，
 * 之后都会触发同一套「重算时间线序号 → 广播位置 → 重新评估翻页」流程。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function Tracker(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
  }

  Tracker.prototype.timeline = function () { return this.store.get().timeline || []; };
  Tracker.prototype.total = function () { return this.store.get().timelineTotalBeats || 0; };
  Tracker.prototype.entry = function () {
    var tl = this.timeline();
    return tl[this.store.get().transport.tlIndex] || null;
  };

  function indexForBeat(tl, beat) {
    var idx = ST.Structure.entryAtBeat(tl, beat);
    return clamp(idx, 0, Math.max(0, tl.length - 1));
  }

  Tracker.prototype.setBeat = function (beat, meta) {
    var tl = this.timeline();
    if (!tl.length) return;
    var maxBeat = Math.max(0, tl[tl.length - 1].firstBeat + tl[tl.length - 1].beats - 1);
    var b = clamp(Math.round(beat), 0, maxBeat);
    var idx = indexForBeat(tl, b);
    var prev = this.store.get().transport;
    if (prev.beat === b && prev.tlIndex === idx) return;
    this.store.set({ transport: { beat: b, tlIndex: idx } }, { source: 'tracker' });
    this.bus.emit('position', { beat: b, index: idx, entry: tl[idx], meta: meta || {} });
  };

  Tracker.prototype.setIndex = function (idx) {
    var tl = this.timeline();
    if (!tl.length) return;
    idx = clamp(idx, 0, tl.length - 1);
    this.setBeat(tl[idx].firstBeat, { from: 'index' });
  };

  Tracker.prototype.stepBeats = function (n) {
    this.setBeat(this.store.get().transport.beat + n, { from: 'nudge' });
  };

  // ±1 小节 = 在时间线上前进/后退一格（注意：不是谱面小节号，回头反复因此天然正确）
  Tracker.prototype.stepBars = function (n) {
    this.setIndex(this.store.get().transport.tlIndex + n);
  };

  Tracker.prototype.gotoMeasure = function (measureId, occurrence) {
    var tl = this.timeline();
    var hits = [];
    tl.forEach(function (e, i) { if (e.measureId === measureId) hits.push(i); });
    if (!hits.length) return false;
    var n = clamp(occurrence || 0, 0, hits.length - 1);
    this.setIndex(hits[n]);
    return true;
  };

  Tracker.prototype.gotoBar = function (barNumber, occurrence) {
    var tl = this.timeline();
    var hits = [];
    tl.forEach(function (e, i) { if (e.bar === barNumber) hits.push(i); });
    if (!hits.length) return false;
    var n = clamp(occurrence || 0, 0, hits.length - 1);
    this.setIndex(hits[n]);
    return true;
  };

  Tracker.prototype.reset = function () {
    this.store.set({ transport: { beat: 0, tlIndex: 0 } });
    this.bus.emit('position', { beat: 0, index: 0, entry: this.timeline()[0], meta: { from: 'reset' } });
  };

  Tracker.prototype.onBeat = function () {
    var tl = this.timeline();
    if (!tl.length) return;
    var b = this.store.get().transport.beat + 1;
    var total = this.total();
    if (b >= total) {
      this.setBeat(Math.max(0, total - 1));
      this.bus.emit('ended');
      return;
    }
    this.setBeat(b, { from: 'metro' });
  };

  /**
   * 给节拍器用：问"再过 n 拍"时的乐句上下文，用于决定重音与细分方式。
   * 有了它，6/8 的附点拍、中途变拍号都能在正拍上给出正确重音。
   */
  Tracker.prototype.peekAhead = function (offset) {
    var tl = this.timeline();
    if (!tl.length) return null;
    var b = this.store.get().transport.beat + (offset || 0);
    var idx = indexForBeat(tl, b);
    var e = tl[idx];
    if (!e) return null;
    var ts = e.timeSig || this.store.get().transport.timeSig;
    var compound = ts.den === 8 && ts.num % 3 === 0;
    return {
      beatsPerBar: e.beats,
      indexInBar: b - e.firstBeat,
      subdivisions: compound ? 3 : 2
    };
  };

  ST.Tracker = Tracker;
})(typeof window !== 'undefined' ? window : globalThis);
