/**
 * modules/metronome.js
 * ---------------------------------------------------------------------------
 * 基于 Web Audio 的**预调度（lookahead scheduling）**节拍器。
 * setInterval 在不同负载下都会抖动甚至被节流到 1s，直接用它发声必定抖；
 * 正确做法是：定时器只负责把未来 100~200ms 内的点击"挂"到音频时钟上，
 * 真正的时刻由 AudioContext.currentTime 决定，因此 BPM 精度与主线程无关。
 * 视觉提示同样不等定时器：把排队的拍点放进队列，用 rAF 对齐音频时钟弹出。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function Metronome(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.ctxProvider = opts.ctxProvider || function () { return { beatsPerBar: 4, indexInBar: 0, subdivisions: 2 }; };
    this.ctx = null;
    this.master = null;
    this.timer = null;
    this.raf = null;
    this.queue = [];
    this.beatCount = 0;
    this.schedIndex = 0;      // 已排入队列的正拍序号
    this.consumed = 0;        // 已经真正响过的正拍序号
    this.startBeat = 0;       // 本次播放的起点拍号
    this.nextTime = 0;
    this.lookahead = 0.12;
    this.tickMs = 25;
    this.playing = false;
    this.lastTap = 0;
    this.tapTimes = [];
  }

  Metronome.prototype.ensureCtx = function () {
    if (!this.ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.store.get().audio.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  };

  Metronome.prototype.setVolume = function (v) {
    if (this.master) this.master.gain.value = v;
  };

  Metronome.prototype.start = function () {
    if (this.playing) return;
    var ctx = this.ensureCtx();
    this.playing = true;
    this.beatCount = 0;
    this.schedIndex = 0;
    this.consumed = 0;
    this.startBeat = this.store.get().transport.beat;   // 第一声就落在"当前这一拍"上
    this.queue.length = 0;
    this.nextTime = ctx.currentTime + 0.08;
    var self = this;
    this.timer = setInterval(function () { self.schedule(); }, this.tickMs);
    var loop = function () { if (!self.playing) return; self.pump(); self.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    this.bus.emit('metro:state', { playing: true });
  };

  /**
   * 手动校正（跳小节、拖进度）后调用：让后续排期从新位置接着走，
   * 否则已经排进队列的"绝对拍号"会拉着进度跳回原处。
   */
  Metronome.prototype.resync = function () {
    this.queue.length = 0;
    this.schedIndex = 0;
    this.consumed = 0;
    this.startBeat = this.store.get().transport.beat;
    if (this.ctx) this.nextTime = this.ctx.currentTime + 0.05;
  };

  Metronome.prototype.stop = function () {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    this.queue.length = 0;
    this.bus.emit('metro:state', { playing: false });
  };

  Metronome.prototype.toggle = function () { this.playing ? this.stop() : this.start(); };

  Metronome.prototype.schedule = function () {
    if (!this.playing) return;
    var st = this.store.get();
    var secPerBeat = 60 / st.transport.bpm;
    while (this.nextTime < this.ctx.currentTime + this.lookahead) {
      /**
       * 每一声都明确知道自己代表"第几拍"：targetBeat = 起点 + 本次排期序号。
       * 用绝对拍号而不是"相对当前进度的偏移"，可以彻底避免
       * 「第 1 拍的橙灯亮了、却还停在上一小节最后一拍」这类整拍错位。
       */
      var targetBeat = this.startBeat + this.schedIndex;
      var ahead = Math.max(0, targetBeat - st.transport.beat);
      var info = this.ctxProvider(ahead) || {};
      var sub = st.audio.subdivision ? (info.subdivisions || 1) : 1;
      var isFirst = (info.indexInBar || 0) === 0;

      this.queue.push({
        time: this.nextTime, kind: 'beat',
        beatIndex: targetBeat,
        beatsPerBar: info.beatsPerBar || 4,
        indexInBar: info.indexInBar || 0
      });
      this.schedIndex++;
      this.click(this.nextTime, this.freq(isFirst), this.gainFor(isFirst ? 1 : 0.7), 0.045);

      for (var s = 1; s < sub; s++) {
        var t = this.nextTime + (secPerBeat * s) / sub;
        this.queue.push({ time: t, kind: 'sub', sub: s, of: sub });
        this.click(t, this.freq(false) * 0.75, this.gainFor(0.28), 0.03);
      }

      this.nextTime += secPerBeat;
      this.beatCount++;
    }
  };

  // 把已经"响过"的拍点从队列里弹出来给界面用 —— 视觉与声音在同一个时钟上
  Metronome.prototype.pump = function () {
    var now = this.ctx ? this.ctx.currentTime : 0;
    while (this.queue.length && this.queue[0].time <= now) {
      var q = this.queue.shift();
      if (q.kind === 'beat') {
        this.consumed++;
        this.bus.emit('beat', q);
      } else {
        this.bus.emit('subbeat', q);
      }
    }
  };

  Metronome.prototype.freq = function (isFirst) {
    if (!this.store.get().audio.accent) return isFirst ? 900 : 900;
    return isFirst ? 1600 : 1050;
  };

  Metronome.prototype.gainFor = function (scale) {
    return 0.9 * scale;
  };

  Metronome.prototype.click = function (time, freq, gain, dur) {
    // 静音只掐掉发声，队列照常推进 —— 顶部的拍点、小节高亮继续保持同步
    if (this.store.get().audio.muted) return;
    var ctx = this.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, time);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), time + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  };

  // 击拍定速
  Metronome.prototype.tap = function () {
    var now = Date.now();
    if (this.lastTap && now - this.lastTap > 2500) this.tapTimes = [];
    this.lastTap = now;
    this.tapTimes.push(now);
    if (this.tapTimes.length > 6) this.tapTimes.shift();
    if (this.tapTimes.length < 3) return null;
    var sum = 0;
    for (var i = 1; i < this.tapTimes.length; i++) sum += this.tapTimes[i] - this.tapTimes[i - 1];
    var avg = sum / (this.tapTimes.length - 1);
    return Math.max(20, Math.min(300, Math.round(60000 / avg)));
  };

  ST.Metronome = Metronome;
})(typeof window !== 'undefined' ? window : globalThis);
