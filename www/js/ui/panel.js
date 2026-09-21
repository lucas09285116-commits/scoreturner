/**
 * ui/panel.js
 * 控制面板：把 DOM 事件翻译成状态变更 / 语义命令，并把状态反映到控件上。
 * 所有跨模块的动作都通过 bus 发出，不直接调用别的模块内部方法
 * （tracker/metro 作为"受控对象"直接注入，但只调它们的公开 API）。
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function $(id) { return document.getElementById(id); }

  function Panel(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.api = opts.api;
    this.tracker = opts.tracker;
    this.metro = opts.metro;
    this.input = opts.input;
    this.el = {
      pageReadout: $('pageReadout'), npBar: $('npBar'), npPass: $('npPass'),
      rdBeat: $('rdBeat'), rdIndex: $('rdIndex'), rdTotal: $('rdTotal'),
      leadNote: $('leadNote'), animNote: $('animNote'),
      selMeasure: $('selMeasure'), fields: document.querySelector('.fields'),
      pulseBar: $('pulseBar'), jumpPass: $('jumpPass'), saveTip: $('saveTip'),
      structTip: $('structTip'), bpm: $('bpm'), bpmRange: $('bpmRange'),
      btnPlay: $('btnPlay'), btnMode: $('btnMode'), btnPanel: $('btnPanel')
    };
    this.tapReset = null;
    this.bind();
    this.refresh();
  }

  Panel.prototype.cmd = function (action) { this.bus.emit('command', { action: action, from: 'ui' }); };

  Panel.prototype.bind = function () {
    var self = this, st = this.store;

    $('fileInput').addEventListener('change', function (e) {
      self.api.loadFiles(e.target.files);
      e.target.value = '';
    });
    $('btnDemo').addEventListener('click', function () { self.api.loadDemo(); });
    $('btnPrevPage').addEventListener('click', function () { self.cmd('prev-page'); });
    $('btnNextPage').addEventListener('click', function () { self.cmd('next-page'); });

    $('zoomMode').addEventListener('change', function (e) {
      st.set({ view: { zoomMode: e.target.value, zoomValue: parseInt($('zoomRange').value, 10) / 100 } });
      self.bus.emit('relayout');
    });
    $('zoomRange').addEventListener('input', function (e) {
      $('zoomMode').value = 'manual';
      st.set({ view: { zoomMode: 'manual', zoomValue: parseInt(e.target.value, 10) / 100 } });
      self.bus.emit('relayout');
    });

    $('btnMode').addEventListener('click', function () { self.cmd('toggle-mode'); });
    $('btnAuto').addEventListener('click', function () { self.cmd('toggle-auto'); });
    $('btnBoxes').addEventListener('click', function () { self.cmd('toggle-boxes'); });
    $('btnDark').addEventListener('click', function () { self.cmd('toggle-dark'); });
    $('btnSound').addEventListener('click', function () { self.cmd('toggle-sound'); });
    $('btnWake').addEventListener('click', function () { self.cmd('toggle-wake'); });
    $('btnFull').addEventListener('click', function () { self.cmd('toggle-fullscreen'); });
    $('btnPanel').addEventListener('click', function () { self.cmd('toggle-panel'); });

    $('btnPlay').addEventListener('click', function () { self.cmd('toggle-play'); });
    $('btnReset').addEventListener('click', function () { self.cmd('reset'); });

    $('bpm').addEventListener('change', function (e) {
      st.set({ transport: { bpm: Math.max(20, Math.min(300, parseInt(e.target.value, 10) || 96)) } });
      self.refresh();
    });
    $('bpmRange').addEventListener('input', function (e) {
      st.set({ transport: { bpm: parseInt(e.target.value, 10) } });
      self.refresh();
    });
    $('btnTap').addEventListener('click', function () {
      var v = self.metro.tap();
      if (v) { st.set({ transport: { bpm: v } }); self.refresh(); }
    });

    $('sigNum').addEventListener('change', sigChange);
    $('sigDen').addEventListener('change', sigChange);
    $('compound').addEventListener('change', function (e) {
      st.set({ transport: { compound: e.target.checked } });
      self.bus.emit('recompute');
    });
    function sigChange() {
      st.set({ transport: { timeSig: { num: parseInt($('sigNum').value, 10), den: parseInt($('sigDen').value, 10) } } });
      self.bus.emit('recompute');
    }

    $('vol').addEventListener('input', function (e) {
      var v = parseInt(e.target.value, 10) / 100;
      st.set({ audio: { volume: v } });
      self.metro.setVolume(v);
    });
    $('cbSub').addEventListener('change', function (e) { st.set({ audio: { subdivision: e.target.checked } }); });
    $('cbAccent').addEventListener('change', function (e) { st.set({ audio: { accent: e.target.checked } }); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-cmd]'), function (b) {
      b.addEventListener('click', function () { self.cmd(b.dataset.cmd); });
    });

    $('btnJump').addEventListener('click', function () {
      var bar = parseInt($('jumpBar').value, 10);
      var pass = parseInt($('jumpPass').value, 10) || 0;
      self.tracker.gotoBar(bar, pass);
    });
    $('selMeasure').addEventListener('change', function () { self.syncMeasureForm(); });

    ['mRepStart', 'mRepEnd'].forEach(function (id) {
      $(id).addEventListener('change', function (e) {
        var mid = $('selMeasure').value;
        if (!mid) return;
        var patch = {};
        patch[id === 'mRepStart' ? 'repeatStart' : 'repeatEnd'] = e.target.checked;
        self.bus.emit('measure:patch', { id: mid, patch: patch });
      });
    });
    $('mRepCount').addEventListener('change', function (e) {
      self.patchSel({ repeatCount: parseInt(e.target.value, 10) || 2 });
    });
    $('mVolta').addEventListener('change', function (e) {
      var nums = String(e.target.value).split(/[^\d]+/).filter(Boolean).map(Number);
      self.patchSel({ volta: nums.length ? nums : null });
    });
    $('mBeats').addEventListener('change', function (e) {
      var v = parseInt(e.target.value, 10);
      self.patchSel({ beats: v > 0 ? v : null });
    });
    $('mSig').addEventListener('change', function (e) {
      var m = String(e.target.value).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
      self.patchSel({ timeSig: m ? { num: +m[1], den: +m[2] } : null });
    });
    $('btnDelMeasure').addEventListener('click', function () {
      var mid = $('selMeasure').value;
      if (mid) self.bus.emit('measure:delete', { id: mid });
    });
    $('btnSplitRow').addEventListener('click', function () { self.bus.emit('measures:resort'); });
    $('btnPageBars').addEventListener('click', function () {
      self.bus.emit('page:bars', { start: parseInt($('pageBarStart').value, 10) });
    });
    $('btnAutoBars').addEventListener('click', function () { self.bus.emit('measures:autoBar', {}); });

    $('repCount').addEventListener('change', function (e) {
      st.set({ repeat: { defaultCount: Math.max(2, parseInt(e.target.value, 10) || 2) } });
      self.bus.emit('recompute');
    });
    $('btnAutoLayout').addEventListener('click', function () {
      self.bus.emit('measure:grid', {
        cols: parseInt($('gridCols').value, 10) || 4,
        rows: parseInt($('gridRows').value, 10) || 4
      });
    });
    $('btnDetect').addEventListener('click', function () { self.bus.emit('measures:autoDetect', {}); });
    $('btnGridAll').addEventListener('click', function () {
      self.bus.emit('measure:grid', {
        all: true,
        cols: parseInt($('gridCols').value, 10) || 4,
        rows: parseInt($('gridRows').value, 10) || 4
      });
    });
    $('btnClearMeasures').addEventListener('click', function () {
      if (root.confirm('清空当前乐谱的所有小节标记？')) self.bus.emit('measures:clear');
    });

    $('leadVal').addEventListener('change', function (e) { st.set({ turn: { leadValue: parseInt(e.target.value, 10) || 0 } }); self.refresh(); });
    $('leadUnit').addEventListener('change', function (e) { st.set({ turn: { leadUnit: e.target.value } }); self.refresh(); });
    $('animMs').addEventListener('input', function (e) {
      st.set({ turn: { animateMs: parseInt(e.target.value, 10) } });
      this.el.animNote.textContent = e.target.value + 'ms';
    }.bind(this));
    $('cbSpread').addEventListener('change', function (e) { self.bus.emit('view:spread', { on: e.target.checked }); });

    Array.prototype.forEach.call(document.querySelectorAll('.bind'), function (b) {
      b.addEventListener('click', function () {
        var others = Array.prototype.filter.call(document.querySelectorAll('.bind'), function (x) { return x !== b; });
        others.forEach(function (x) { x.classList.remove('recording'); x.textContent = self.labelFor(x); });
        b.classList.add('recording');
        b.textContent = '按下按键…';
        self.input.startRecording(b.dataset.bind);
      });
    });
    this.bus.on('bind:recorded', function () { self.refreshBinds(); self.refresh(); });
    $('btnDefaultBinds').addEventListener('click', function () {
      st.set({ input: { binds: ST.defaultState().input.binds } });
      self.refreshBinds();
    });
    $('btnMidi').addEventListener('click', function () {
      self.input.enableMidi().then(function (names) {
        self.el.saveTip.textContent = '已接入 MIDI：' + (names.join('、') || '（无可用设备）');
      }).catch(function (e) { self.el.saveTip.textContent = String(e.message || e); });
    });

    $('btnExport').addEventListener('click', function () { ST.Persistence.download(st.get()); });
    $('importJson').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try { self.api.applyProject(JSON.parse(fr.result)); }
        catch (err) { self.el.saveTip.textContent = 'JSON 解析失败：' + err.message; }
      };
      fr.readAsText(f);
      e.target.value = '';
    });
    $('btnResetAll').addEventListener('click', function () {
      if (root.confirm('清空全部本地数据与项目？')) self.api.resetAll();
    });
  };

  Panel.prototype.patchSel = function (patch) {
    var mid = this.el.selMeasure.value;
    if (!mid) return;
    this.bus.emit('measure:patch', { id: mid, patch: patch });
  };

  Panel.prototype.labelFor = function (btn) {
    var binds = this.store.get().input.binds;
    var list = binds[btn.dataset.bind] || [];
    return list.length ? list.join(' / ') : '—';
  };

  /* ---------------- 刷新 ---------------- */
  Panel.prototype.refresh = function () {
    var st = this.store.get();
    var e = this.el;
    e.bpm.value = st.transport.bpm;
    e.bpmRange.value = st.transport.bpm;
    this.el.btnPlay.textContent = st.transport.playing ? '❚❚ 暂停' : '▶ 开始';
    $('btnAuto').classList.toggle('is-on', st.turn.auto);
    $('btnSound').classList.toggle('is-on', !st.audio.muted);
    $('btnSound').textContent = st.audio.muted ? '静音' : '声音';
    $('btnBoxes').classList.toggle('is-on', st.view.showBoxes);
    $('btnDark').classList.toggle('is-on', st.view.dark);
    $('btnMode').textContent = st.edit.mode === 'edit' ? '编辑模式' : '演奏模式';
    $('btnMode').classList.toggle('is-on', st.edit.mode === 'edit');
    $('btnPanel').classList.toggle('is-on', st.view.panels);
    $('leadVal').value = st.turn.leadValue;
    $('leadUnit').value = st.turn.leadUnit;
    e.leadNote.textContent = '≈ ' + (st.turn.leadValue >= 0 ? '提前 ' : '延后 ') + Math.abs(st.turn.leadValue) + (st.turn.leadUnit === 'bar' ? ' 小节' : ' 拍');
    e.animNote.textContent = st.turn.animateMs + 'ms';
    $('animMs').value = st.turn.animateMs;
    $('cbSpread').checked = st.view.spread;
    e.pageReadout.textContent = st.score ? ((st.view.page + 1) + ' / ' + st.score.pages.length) : '0 / 0';
    e.rdBeat.textContent = st.transport.beat;
    e.rdIndex.textContent = st.transport.tlIndex + 1;
    e.rdTotal.textContent = st.timeline.length;
    var entry = st.timeline[st.transport.tlIndex];
    e.npBar.textContent = entry ? ('第 ' + entry.bar + ' 小节' + (entry.take ? ' （' + entry.take + ' 房子）' : '')) : '第 — 小节';
    e.npPass.textContent = entry && entry.pass > 1 ? ('第 ' + entry.pass + ' 遍') : '';
    // 「本页起始小节号」预填为当前页对齐到的谱面印刷号（若有对齐），翻页时跟着走
    var barInput = document.getElementById('pageBarStart');
    if (st.score && document.activeElement !== barInput) {
      var ps = st.pageStarts || [];
      barInput.value = (typeof ps[st.view.page] === 'number' && ps[st.view.page] > 0) ? ps[st.view.page] : 1;
    }
    this.syncMeasureForm();
  };

  Panel.prototype.refreshTransport = function () { this.refresh(); };

  Panel.prototype.refreshBinds = function () {
    var self = this;
    Array.prototype.forEach.call(document.querySelectorAll('.bind'), function (b) {
      b.classList.remove('recording');
      b.textContent = self.labelFor(b);
    });
  };

  Panel.prototype.syncMeasureForm = function () {
    var st = this.store.get();
    var sel = this.el.selMeasure;
    var measures = st.score ? st.score.measures : [];
    var ordered = ST.Structure.sortMeasures(measures);
    var prev = sel.value;
    sel.innerHTML = '<option value="">— 未选中小节 —</option>' + ordered.map(function (m, i) {
      return '<option value="' + m.id + '">第 ' + (m.page + 1) + ' 页 · ' + (m.bar || i + 1) + (m.repeatStart ? ' │:' : '') + (m.repeatEnd ? ' :│' : '') + (m.volta ? ' ' + m.volta.join('.') + '.' : '') + '</option>';
    }).join('');
    sel.value = prev || (st.edit.selectedId || '');
    var cur = measures.filter(function (m) { return m.id === sel.value; })[0];
    this.el.fields.classList.toggle('show', !!cur);
    if (!cur) return;
    $('mRepStart').checked = !!cur.repeatStart;
    $('mRepEnd').checked = !!cur.repeatEnd;
    $('mRepCount').value = cur.repeatCount || 2;
    $('mVolta').value = (cur.volta || []).join(',');
    $('mBeats').value = cur.beats || 0;
    $('mSig').value = cur.timeSig ? (cur.timeSig.num + '/' + cur.timeSig.den) : '';
  };

  /* ---------------- 小节 through N 次下拉 ---------------- */
  Panel.prototype.syncPassOptions = function () {
    var st = this.store.get();
    var bar = parseInt(this.el.jumpPass.value, 10) || 0;
    var max = 0;
    st.timeline.forEach(function (e) { if (e.pass > max) max = e.pass; });
    var opts = '';
    for (var i = 0; i < Math.max(1, max); i++) opts += '<option value="' + i + '">第 ' + (i + 1) + ' 次</option>';
    this.el.jumpPass.innerHTML = opts;
    this.el.jumpPass.value = String(Math.min(bar, Math.max(0, max - 1)));
  };

  ST.Panel = Panel;
})(typeof window !== 'undefined' ? window : globalThis);
