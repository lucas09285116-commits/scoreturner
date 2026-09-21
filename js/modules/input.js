/**
 * modules/input.js
 * ---------------------------------------------------------------------------
 * 输入抽象层。键盘 / MIDI 踏板 / 游戏手柄 / 外部串口都只是"信号源"，
 * 它们统一翻译成语义化 **command**（toggle-play、next-page …）交给总线，
 * 上层不关心信号来自哪个设备。
 *
 * · 按键绑定可录制：点面板上的按钮 → 按下踏板或任意键 → 写入 state.input.binds
 * · MIDI：默认监听 CC64/66/67（延音、sostenuto、una corda 踏板常映射到这三个）
 * · 自定义协议：外部程序可以直接调用 window.ScoreTurner.trigger('next-page')
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function token(e) {
    if (e.code === 'Space') return 'Space';
    if (!e.key) return '';
    if (e.key.length === 1) return e.key.toUpperCase();
    return e.key;
  }
  function tokenWithMods(e) {
    var t = token(e);
    if (!t || t === 'Control' || t === 'Shift' || t === 'Alt') return t;
    if (e.ctrlKey) t = 'Ctrl+' + t;
    else if (e.altKey) t = 'Alt+' + t;
    else if (e.shiftKey && (e.key || '').length === 1) t = 'Shift+' + t;
    return t;
  }

  function Input(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.recording = null;
    this.midi = null;
    this.staticMap = {
      'Space': 'toggle-play',
      'ArrowRight': 'next-measure',
      'ArrowLeft': 'prev-measure',
      'Ctrl+ArrowRight': 'next-page',
      'Ctrl+ArrowLeft': 'prev-page',
      'PageDown': 'next-page',
      'PageUp': 'prev-page',
      'R': 'reset',
      'F': 'toggle-fullscreen',
      'B': 'toggle-dark',
      'D': 'toggle-boxes',
      'M': 'toggle-sound',
      'A': 'toggle-auto',
      'E': 'toggle-mode',
      'Tab': 'toggle-panel',
      'Escape': 'exit',
      '+': 'bpm-up', '=': 'bpm-up',
      '-': 'bpm-down', '_': 'bpm-down',
      'Shift+ArrowRight': 'bpm-up',
      'Shift+ArrowLeft': 'bpm-down',
      '[': 'prev-page', ']': 'next-page'
    };
  }

  Input.prototype.bind = function (target) {
    var self = this;
    target.addEventListener('keydown', function (e) {
      if (isTypingTarget(e.target)) return;
      var t = tokenWithMods(e);

      if (self.recording) {
        e.preventDefault();
        var action = self.recording;
        self.recording = null;
        if (t && self.store) {
          var binds = Object.assign({}, self.store.get().input.binds);
          binds[action] = [t];
          self.store.set({ input: { binds: binds } });
        }
        self.bus.emit('bind:recorded', { action: action, key: t });
        return;
      }

      var action = self.resolve(t);
      if (action) {
        if (t === 'Space' || t === 'Tab' || t.indexOf('Ctrl+') === 0) e.preventDefault();
        self.bus.emit('command', { action: action, from: 'key' });
      }
    });
  };

  Input.prototype.resolve = function (t) {
    var binds = this.store ? this.store.get().input.binds : {};
    for (var action in binds) {
      if (binds[action].indexOf(t) >= 0) return action;
    }
    return this.staticMap[t] || null;
  };

  Input.prototype.startRecording = function (action) { this.recording = action; };

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  /* ---------------- MIDI 踏板 ---------------- */
  Input.prototype.enableMidi = function () {
    var self = this;
    if (!root.navigator || !root.navigator.requestMIDIAccess) return Promise.reject(new Error('当前浏览器不支持 Web MIDI（Chrome / Edge 可用）'));
    return root.navigator.requestMIDIAccess().then(function (acc) {
      self.midi = acc;
      acc.inputs.forEach(function (port) {
        if (port.state === 'connected') {
          port.onmidimessage = function (ev) { self.onMidi(ev); };
        }
      });
      return Array.from(acc.inputs.values()).map(function (p) { return p.name; });
    });
  };

  Input.prototype.onMidi = function (ev) {
    var status = ev.data[0] & 0xf0;
    var ctl = ev.data[1];
    var val = ev.data.length > 2 ? ev.data[2] : 0;
    if (status === 0xb0 && [64, 66, 67].indexOf(ctl) >= 0) {
      if (val >= 64) this.bus.emit('command', { action: 'next-page', from: 'midi', ctl: ctl });
      return;
    }
    // 踏板型 MIDI 控制器常把踏板做成音符/程序变更，一并兜住
    if (status === 0x90 && val > 0) this.bus.emit('command', { action: 'next-page', from: 'midi', note: ctl });
    if (status === 0xc0) this.bus.emit('command', { action: 'prev-page', from: 'midi' });
  };

  ST.Input = Input;
  ST.keyToken = token;
})(typeof window !== 'undefined' ? window : globalThis);
