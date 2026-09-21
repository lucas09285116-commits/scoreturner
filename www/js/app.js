/**
 * app.js —— 装配层
 * ---------------------------------------------------------------------------
 * 这里不做任何"计算"，只做三件事：
 *   1) 把各模块按依赖顺序接起来（含总线上的订阅顺序）
 *   2) 派生数据（timeSig / 反复策略 → 演奏时间线）的重算时机管理
 *   3) 把 command 翻译成对模块的状态迁移
 *
 * 订阅顺序有意为之：metronome 发出 beat → tracker 先更新位置 → 再由 position
 * 触发高亮与翻页评估。若把翻页放在 tracker 之前，翻页会用到"上一拍"的位置。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  var store = ST.createStore(ST.defaultState());
  var bus = ST.createBus();

  var tracker = new ST.Tracker({ store: store, bus: bus });
  var metro = new ST.Metronome({
    store: store,
    bus: bus,
    ctxProvider: function (offset) { return tracker.peekAhead(offset); }
  });
  var pageTurn = new ST.PageTurn({ store: store, bus: bus });
  var renderer = new ST.Renderer({ store: store, bus: bus });
  var input = new ST.Input({ store: store, bus: bus });

  var api = {
    loadFiles: loadFiles,
    loadDemo: loadDemo,
    applyProject: applyProject,
    resetAll: resetAll,
    toast: toast
  };

  var panel = new ST.Panel({
    store: store, bus: bus, api: api, tracker: tracker, metro: metro, input: input
  });

  input.bind(document);
  bindGlobalImport();

  /* 手机传谱：仅在线版（非 file://）启用；离线双击 index.html 时隐藏按钮。*/
  if (ST.Net && ST.Net.isOnline()) {
    ST.Net.mount(api);
  } else {
    var netBtn = document.getElementById('btnNet');
    if (netBtn) netBtn.style.display = 'none';
  }

  /* 原生 App：系统分享/打开方式送来的文件，直接导入（无后端、无需上传）*/
  if (ST.NativeShare && ST.NativeShare.init) {
    ST.NativeShare.init(api);
  }

  /* ================= 派生：演奏时间线 ================= */
  function recompute() {
    var st = store.get();
    if (!st.score || !st.score.measures.length) {
      store.set({ timeline: [], timelineTotalBeats: 0, warnings: ['尚未标记小节：切到编辑模式，在页面上拖动框出小节，或用「按网格生成小节」。'] });
      return;
    }
    var ordered = ST.Structure.sortMeasures(st.score.measures);
    var r = ST.Structure.buildTimeline(ordered, {
      timeSig: st.transport.timeSig,
      compound: st.transport.compound,
      defaultRepeatCount: st.repeat.defaultCount,
      maxPasses: st.repeat.maxPasses
    });
    store.set({ timeline: r.entries, timelineTotalBeats: r.totalBeats, warnings: r.warnings });
    var b = st.transport.beat;
    tracker.setBeat(Math.min(b, Math.max(0, r.totalBeats - 1)));
    pageTurn.invalidate();
    panel.syncPassOptions();
    panel.refresh();
    renderer.paintHighlight();
  }

  var STRUCT_KEYS = ['repeatStart', 'repeatEnd', 'repeatCount', 'volta', 'timeSig', 'beats'];

  function patchHasStructure(patch) {
    return Object.keys(patch).some(function (k) { return STRUCT_KEYS.indexOf(k) >= 0; });
  }

  /* ================= 乐谱加载 ================= */
  function useSource(source) {
    var saved = ST.Persistence.load(source.id);
    var pages = [];
    for (var i = 0; i < source.pageCount; i++) pages.push({ w: 0, h: 0 });

    // 示例乐谱自带小节坐标；普通文件优先用上次保存的结构——
    // 但若识别算法升级过、或上次只划了半截标记，则作废重识别（见 persistence.measuresUsable）
    var detectVer = (ST.BarlineDetect && ST.BarlineDetect.VERSION) || 0;
    var usable = ST.Persistence.measuresUsable(saved, detectVer, source.measures, source.pageCount);
    var restored = usable.use;
    var stale = usable.stale;
    var verStale = usable.verStale;

    // 上次对齐过的"谱面起始小节号"一并恢复——这是让跳转等于印刷号的关键
    var savedPS = (saved && Array.isArray(saved.pageStarts)) ? saved.pageStarts.slice() : [];

    var score = {
      id: source.id,
      name: source.name,
      pages: pages,
      measures: restored,
      rev: 0
    };

    store.set({ score: score, pageStarts: savedPS });
    if (saved && !source.measures) {
      store.set({
        transport: { bpm: (saved.transport || {}).bpm || 96, timeSig: (saved.transport || {}).timeSig || { num: 4, den: 4 }, compound: (saved.transport || {}).compound !== false },
        turn: Object.assign({}, ST.defaultState().turn, saved.turn || {}, { lastTurnKey: null }),
        repeat: Object.assign({}, ST.defaultState().repeat, saved.repeat || {}),
        input: { binds: Object.assign({}, ST.defaultState().input.binds, (saved.input || {}).binds || {}) }
      });
    }

    renderer.load(source, score.measures);
    metro.stop();
    store.set({ transport: { playing: false, beat: 0, tlIndex: 0 }, view: { page: 0, displayStart: 0 } });

    if (score.measures.length) {
      applyBarNumbers(score.measures);   // 已对齐则套用印刷号；否则保留原有的顺序号
      recompute();
      renderer.drawBoxes();
      panel.el.saveTip.textContent = saved
        ? '已从本地恢复上次标记的结构（' + score.measures.length + ' 个小节）'
        : '结构会自动存到本地，重新导入同一份乐谱时自动恢复。';
    } else {
      // 没有可用的标记 → 先按 4×4 兜一层网格，保证"导入完就能按空格跑"
      var n = autoGridAll(AUTO_COLS, AUTO_ROWS);
      panel.el.saveTip.textContent = '先用 ' + AUTO_COLS + '×' + AUTO_ROWS + ' 网格垫了 ' + n + ' 个小节，正在识别真实小节线…';
      toast(verStale
        ? '小节线识别算法已升级，正在用新算法重新识别（旧标记已作废）…'
        : (stale !== null
          ? '原来的标记只有 ' + stale + ' 个小节（不完整），正在重新识别小节线…'
          : '已垫好临时网格，正在识别真实小节线…'), 5000);
      // 先垫一层保证能立刻播放，再在后台用"识别小节线"替换掉它
      setTimeout(autoDetectAll, 60);
    }

    renderer.goto(0, false);
    panel.syncPassOptions();
    panel.refreshBinds();
    panel.refresh();
  }

  function loadFiles(fileList) {
    return ST.ScoreLoader.fromFiles(fileList).then(useSource).catch(function (e) {
      panel.el.saveTip.textContent = '导入失败：' + (e && e.message ? e.message : e);
    });
  }

  /* 全局导入：拖拽文件 + 粘贴文件（与「导入乐谱」按钮共用 loadFiles，行为完全一致）。
   * 这样文件发到电脑后，从资源管理器/电脑版微信/邮件直接拖进窗口（或复制后 Ctrl+V）即可，
   * 不必再点按钮、翻文件夹、也不用"另存到桌面"。 */
  function bindGlobalImport() {
    var overlay = document.getElementById('dropOverlay');
    var depth = 0;
    function hasFiles(e) {
      if (!e.dataTransfer) return false;
      var t = e.dataTransfer.types;
      if (!t) return false;
      for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
      return false;
    }
    function show() { if (overlay) overlay.classList.add('is-active'); }
    function hide() { if (overlay) overlay.classList.remove('is-active'); }

    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++; show();
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) hide();
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; hide();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) api.loadFiles(files);
    });
    window.addEventListener('paste', function (e) {
      var cd = e.clipboardData || window.clipboardData;
      if (!cd || !cd.files || !cd.files.length) return;
      api.loadFiles(cd.files);
    });
  }

  function loadDemo() {
    useSource(ST.DemoScore.build());
  }

  function applyProject(json) {
    var st = store.get();
    if (!st.score) { panel.el.saveTip.textContent = '请先导入乐谱，再导入结构 JSON'; return; }
    var measures = json.measures || [];
    var ps = Array.isArray(json.pageStarts) ? json.pageStarts : [];
    store.set({ pageStarts: ps });
    applyBarNumbers(measures);
    store.set({ score: { measures: measures, rev: (st.score.rev || 0) + 1 } });
    if (json.transport) store.set({ transport: { bpm: json.transport.bpm || 96, timeSig: json.transport.timeSig || { num: 4, den: 4 }, compound: json.transport.compound !== false } });
    if (json.turn) store.set({ turn: Object.assign({}, json.turn, { lastTurnKey: null }) });
    if (json.repeat) store.set({ repeat: json.repeat });
    recompute();
    panel.refresh();
    // 若这份 JSON 是旧版识别算法导出的，提醒用户可一键用新算法重识别
    var curVer = (ST.BarlineDetect && ST.BarlineDetect.VERSION) || 0;
    panel.el.saveTip.textContent = (typeof json.detectVer === 'number' && json.detectVer !== curVer)
      ? '已导入 ' + measures.length + ' 个小节（这份 JSON 由旧版识别算法导出，如需最新识别结果请点「自动识别小节线」）'
      : '已导入 ' + measures.length + ' 个小节';
  }

  function resetAll() {
    ST.Persistence.clear();
    root.location.reload();
  }

  /* ================= 提示条 ================= */
  var toastTimer = null;
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 3200);
  }

  /* ================= 小节编辑 ================= */
  var AUTO_COLS = 4, AUTO_ROWS = 4;

  function bumpScore(measures) {
    store.set({ score: { measures: measures, rev: (store.get().score.rev || 0) + 1 } });
  }

  /** 按网格给某一页生成小节（不会动其它页）。小节号由 pageStarts 统一推导，这里只给几何 */
  function makePageGrid(page, cols, rows) {
    var arr = [];
    var padX = 0.06, padTop = 0.10, padBottom = 0.05;
    var usableW = 1 - padX * 2, usableH = 1 - padTop - padBottom;
    var rowH = usableH / rows, colW = usableW / cols;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        arr.push({
          id: 'g' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5) + '-' + r + '-' + c,
          page: page,
          x: padX + c * colW, y: padTop + r * rowH,
          w: colW * 0.96, h: rowH * 0.82
        });
      }
    }
    return arr;
  }

  /** 小节号一律由 pageStarts 推导；没有显式对齐时保持原有的顺序号（不强制重排） */
  function applyBarNumbers(measures) {
    var ps = store.get().pageStarts || [];
    if (ps.some(function (x) { return typeof x === 'number' && x > 0; })) {
      ST.Structure.computeBarNumbers(measures, ps);
    }
    return measures;
  }

  /** 整份乐谱按同一套网格重新标记 */
  function autoGridAll(cols, rows) {
    var st = store.get();
    if (!st.score) return 0;
    var list = [];
    st.score.pages.forEach(function (_, p) {
      list = list.concat(makePageGrid(p, cols, rows));
    });
    applyBarNumbers(list);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
    return list.length;
  }

  /* ================= 自动识别小节线 ================= */
  var detecting = false;

  function measuresFromDetection(results) {
    var list = [], total = 0;
    results.forEach(function (r, p) {
      r.measures.forEach(function (m, i) {
        list.push({
          id: 'd' + Date.now().toString(36) + '-' + p + '-' + i,
          page: p,
          bar: total + i + 1,                 // 兜底顺序号；真正的印刷号由 pageStarts 推导
          x: m.x, y: m.y, w: m.w, h: m.h,
          repeatStart: false, repeatEnd: false,
          _dblL: !!m.doubleLeft, _dblR: !!m.doubleRight
        });
      });
      total += r.measures.length;
    });

    /**
     * 反复记号配对：检测层只报"哪里有双竖线"，方向在这里按顺序两两配对——
     * 先出现的那一处是 │: ，后出现的那一处是 :│。
     * 这样比在 1px 图像上分辨"粗线在哪一侧"稳得多。
     */
    // 同一条双竖线会被"左边小节的右边界"和"右边小节左边界"各报一次，这里去重
    var bounds = [];
    list.forEach(function (m, i) {
      if (m._dblL) {
        bounds.push({ left: i - 1, right: i });
      } else if (m._dblR && !(list[i + 1] && list[i + 1]._dblL)) {
        // 同一条线也会由右边小节的 _dblL 报到，避免重复
        bounds.push({ left: i, right: i + 1 < list.length ? i + 1 : -1 });
      }
    });
    bounds.sort(function (a, b) {
      return (a.right >= 0 ? a.right : a.left + 0.5) - (b.right >= 0 ? b.right : b.left + 0.5);
    });
    var pairs = 0;
    for (var k = 0; k + 1 < bounds.length; k += 2) {
      var s = bounds[k], e = bounds[k + 1];
      if (s.right >= 0) list[s.right].repeatStart = true;
      if (e.left >= 0) list[e.left].repeatEnd = true;
      pairs++;
    }
    return { list: list, doubles: pairs * 2 };
  }

  function autoDetectAll() {
    var st = store.get();
    if (!st.score || !renderer.source || detecting) return;
    detecting = true;
    var pageCount = st.score.pages.length;
    var results = [];
    var rulerByPage = [];        // 每页读到的「顶部小节号标尺」起始号（真实印刷号），读不到为 null
    var p = 0;

    function next() {
      if (p >= pageCount) return finish();
      var idx = p++;
      toast('正在识别小节线… 第 ' + (idx + 1) + ' / ' + pageCount + ' 页', 60000);
      var detectP = ST.BarlineDetect.detectPageAuto(renderer.source, idx, { targetWidth: 1500 });
      var barP = ST.BarNumberRead && ST.BarNumberRead.readPageRuler
        ? ST.BarNumberRead.readPageRuler(renderer.source, idx)
        : Promise.resolve(null);
      return Promise.all([detectP, barP])
        .then(function (res) {
          results[idx] = res[0];
          var rr = res[1];
          rulerByPage[idx] = (rr && typeof rr.start === 'number') ? rr.start : null;
          return next();
        })
        .catch(function () { results[idx] = { measures: [], rows: 0, doubles: 0 }; rulerByPage[idx] = null; return next(); });
    }

    function finish() {
      detecting = false;
      var got = measuresFromDetection(results);
      if (!got.list.length) {
        var n = autoGridAll(AUTO_COLS, AUTO_ROWS);   // autoGridAll 内部会按 pageStarts 套用印刷号
        toast('没能在页面里找到小节线，已退回 ' + AUTO_COLS + '×' + AUTO_ROWS + ' 网格（' + n + ' 个小节），请手动校准', 5000);
        return;
      }
      // 用真实网格的「每页小节数」作约束，跨页投票求解起始号；
      // 标尺直接给出各内容页的印刷首格号，标题页/读不到的页由投票按格数顺延补全。
      // 仍只补空、不覆盖用户已对齐的页（导入时尚未对齐，于是整体填入）。
      var ps = (store.get().pageStarts || []).slice();
      var byPage = {}, counts = [];
      got.list.forEach(function (m) { byPage[m.page] = (byPage[m.page] || 0) + 1; });
      for (var i = 0; i < pageCount; i++) counts.push(byPage[i] || 0);
      var solved = ST.BarNumberRead && ST.BarNumberRead.solveStartsFromStarts
        ? ST.BarNumberRead.solveStartsFromStarts(rulerByPage, counts) : null;
      if (solved) {
        for (var k = 0; k < pageCount; k++) {
          if (!(typeof ps[k] === 'number' && ps[k] > 0)) ps[k] = solved.starts[k];
        }
        store.set({ pageStarts: ps });
      }
      // 关键：识别只给几何，小节号必须按用户已对齐的 pageStarts 推导，
      // 否则每次识别都会把编号重置成 1、2、3，把你手动对齐的印刷号冲掉
      applyBarNumbers(got.list);
      bumpScore(got.list);
      recompute();
      renderer.drawBoxes();
      panel.refresh();
      toast('识别出 ' + got.list.length + ' 个小节' + (got.doubles ? '（' + got.doubles + ' 处双竖线已按反复记号标记，可在编辑模式取消）' : ''), 6000);
    }

    return next();
  }

  bus.on('measures:autoDetect', function () { autoDetectAll(); });

  // 「自动读谱面小节号」：显式让软件重读对齐——跨页投票求解后**整体覆盖** pageStarts
  //（这是用户主动点的按钮，旧的/填错的对齐值就该被替换）。不重跑小节线识别。
  bus.on('measures:autoBar', function () {
    var st = store.get();
    if (!st.score || !renderer.source) { toast('请先导入乐谱'); return; }
    if (!ST.BarNumberRead || !ST.BarNumberRead.readPageRuler) { toast('缺少读号模块，请用「对齐谱面小节号」手动填'); return; }
    var pages = st.score.pages.length;
    var measures = st.score.measures || [];
    if (!measures.length) { toast('请先「自动识别小节线」或手动标记小节，再来对齐编号'); return; }
    toast('正在读取谱面印刷的小节号…', 10000);

    function readAll(fn) {
      var arr = [], js = [];
      for (var i = 0; i < pages; i++) {
        (function (pg) {
          js.push(fn(pg).then(function (v) { arr[pg] = v; }));
        })(i);
      }
      return Promise.all(js).then(function () { return arr; });
    }

    // 主路径：直接读每页「顶部小节号标尺」→ 跨页投票（按真实格数约束）整体对齐。
    // 主路径失败（如 PDF 是扫描图片、文字层为空）再退回旧候选投票。
    readAll(function (pg) {
      return ST.BarNumberRead.readPageRuler(renderer.source, pg)
        .then(function (r) { return (r && typeof r.start === 'number') ? r.start : null; });
    })
      .then(function (rulerByPage) {
        // 每页格数（按现有小节标记统计）
        var byPage = {}, counts = [];
        measures.forEach(function (m) { byPage[m.page] = (byPage[m.page] || 0) + 1; });
        for (var p = 0; p < pages; p++) counts.push(byPage[p] || 0);
        var solved = ST.BarNumberRead.solveStartsFromStarts(rulerByPage, counts);
        if (solved) {
          var desc = [];
          for (var q = 0; q < pages; q++) desc.push('P' + (q + 1) + '=' + solved.starts[q]);
          applyAutoBar(solved.starts,
            '已按谱面印刷号整体对齐（' + solved.votes + ' 页互相印证）：' + desc.join('，'));
          return null;
        }
        // 主路径失败 → 退回旧候选投票
        return readAll(function (pg) { return ST.BarNumberRead.readPageBarCandidates(renderer.source, pg); })
          .then(function (candByPage) {
            var solved2 = ST.BarNumberRead.solveStarts(candByPage, counts);
            if (solved2) {
              var desc2 = [];
              for (var q = 0; q < pages; q++) desc2.push('P' + (q + 1) + '=' + solved2.starts[q]);
              applyAutoBar(solved2.starts,
                '已按谱面印刷号整体对齐（候选投票 ' + solved2.votes + ' 页印证）：' + desc2.join('，'));
              return null;
            }
            var totallyEmpty = candByPage.every(function (c) { return !c || !c.length; });
            if (totallyEmpty) {
              toast('这份 PDF 读不到任何文字层数字（多半是扫描图片版），无法自动读号——请在「本页第1格谱面小节号」手动填，或把 PDF 文件发给开发者分析', 8000);
              return null;
            }
            return readAll(function (pg) { return ST.BarNumberRead.readPageBarNumbers(renderer.source, pg); })
              .then(function (singles) {
                var base = (store.get().pageStarts || []).slice();
                var touched = 0;
                singles.forEach(function (v, pg) {
                  if (typeof v === 'number' && v > 0 && !(typeof base[pg] === 'number' && base[pg] > 0)) { base[pg] = v; touched++; }
                });
                if (!touched) {
                  toast('各页印刷号没能互相印证（可能是识别的格数有出入），未做改动。可手动填一次，或把 PDF 发给开发者分析', 8000);
                  return null;
                }
                applyAutoBar(base, '只有 ' + touched + '/' + pages + ' 页读到可信印刷号（已补空、未覆盖手动值）');
                return null;
              });
          });
      })
      .catch(function () {
        toast('读取谱面小节号失败，请改用「对齐谱面小节号」手动填写', 5000);
      });

    function applyAutoBar(ps, msg) {
      store.set({ pageStarts: ps });
      var list = (store.get().score.measures || []).slice();
      if (list.length) {
        applyBarNumbers(list);
        bumpScore(list);
        recompute();
        renderer.drawBoxes();
      }
      panel.refresh();
      toast(msg, 8000);
    }
  });

  bus.on('measure:create', function (d) {
    var st = store.get();
    if (!st.score) return;
    var list = st.score.measures.slice();
    list.push({
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      page: d.page,
      x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h
    });
    applyBarNumbers(list);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
  });

  bus.on('measure:patch', function (d) {
    var st = store.get();
    if (!st.score) return;
    var list = st.score.measures.map(function (m) {
      return m.id === d.id ? Object.assign({}, m, d.patch) : m;
    });
    applyBarNumbers(list);
    bumpScore(list);
    if (patchHasStructure(d.patch)) recompute();
    else { renderer.drawBoxes(); renderer.paintHighlight(); }
  });

  bus.on('measure:delete', function (d) {
    var st = store.get();
    if (!st.score) return;
    var list = st.score.measures.filter(function (m) { return m.id !== d.id; });
    applyBarNumbers(list);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
    panel.syncMeasureForm();
  });

  bus.on('measures:clear', function () {
    store.set({ pageStarts: [] });
    bumpScore([]);
    recompute();
    renderer.drawBoxes();
  });

  bus.on('measures:resort', function () {
    var st = store.get();
    if (!st.score) return;
    var list = st.score.measures.slice();
    applyBarNumbers(list);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
  });

  /**
   * 对齐谱面上印的小节号：告诉软件"这一页第一格（谱面）是第几小节"。
   * 这是让「输入 70 → 跳到谱面第 70 格」成立的唯一可靠办法。
   * 当前页用你填的号开头，后面整页自动顺延（pageStarts 模型，见 structure.computeBarNumbers）。
   * 对齐结果会存盘，重新导入同一份乐谱时自动恢复，不会被自动识别冲掉。
   */
  bus.on('page:bars', function (d) {
    var st = store.get();
    if (!st.score) return;
    var page = (typeof d.page === 'number') ? d.page : st.view.page;
    var start = parseInt(d.start, 10);
    if (!(start > 0)) { toast('请输入正整数小节号'); return; }
    var ps = (st.pageStarts || []).slice();
    ps[page] = start;
    store.set({ pageStarts: ps });
    var list = st.score.measures.slice();
    ST.Structure.computeBarNumbers(list, ps);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
    panel.refresh();
    toast('第 ' + (page + 1) + ' 页起已按谱面 ' + start + ' 编号，后续页自动顺延（已保存，重新导入仍生效）');
  });

  bus.on('measure:grid', function (d) {
    var st = store.get();
    if (!st.score) return;
    var cols = Math.max(1, d.cols || AUTO_COLS), rows = Math.max(1, d.rows || AUTO_ROWS);
    if (d.all) { toast('已按 ' + cols + ' × ' + rows + ' 重新标记全部 ' + autoGridAll(cols, rows) + ' 个小节'); return; }
    var page = (typeof d.page === 'number') ? d.page : st.view.page;
    var others = st.score.measures.filter(function (m) { return m.page !== page; });
    var list = others.concat(makePageGrid(page, cols, rows));
    applyBarNumbers(list);
    bumpScore(list);
    recompute();
    renderer.drawBoxes();
    toast('第 ' + (page + 1) + ' 页已按 ' + cols + ' × ' + rows + ' 重画');
  });

  bus.on('measure:selected', function (d) {
    store.set({ edit: { selectedId: d.id } });
    renderer.drawBoxes();
    panel.syncMeasureForm();
  });

  // 演奏态点击小节框 → 跳到离当前时间最近的那一次出现
  bus.on('measure:click', function (d) {
    var tl = store.get().timeline;
    var cur = store.get().transport.beat;
    var best = -1, bestDiff = Infinity;
    tl.forEach(function (e, i) {
      if (e.measureId !== d.id) return;
      var diff = Math.abs(e.firstBeat - cur);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    if (best >= 0) { clearPending(); tracker.setIndex(best); }
  });

  bus.on('relayout', function () { renderer.sync(); });
  bus.on('recompute', function () { recompute(); });
  bus.on('view:spread', function (d) {
    store.set({ view: { spread: !!d.on, displayStart: d.on ? Math.floor(store.get().view.page / 2) * 2 : store.get().view.page } });
    renderer.sync();
  });

  /* ================= 播放与命令 ================= */
  bus.on('beat', function (q) {
    // 节拍器现在告诉我们的不是"又走了一拍"，而是"这一声就是第几拍"，直接对齐
    if (typeof q.beatIndex === 'number') {
      if (q.beatIndex >= store.get().timelineTotalBeats) { bus.emit('ended'); return; }
      tracker.setBeat(q.beatIndex, { from: 'metro' });
    } else {
      tracker.onBeat();
    }
    pulseBeat(q);
  });

  bus.on('position', function (pos) {
    panel.refreshTransport();
    renderer.paintHighlight();
    pageTurn.evaluate();
    ensureVisible(pos.entry);
    // 手动改动进度时，让节拍器的排期基准跟着走（否则会拉回去）
    var from = (pos.meta || {}).from;
    if (from && from !== 'metro' && store.get().transport.playing) metro.resync();
  });

  bus.on('page:turn', function (d) {
    // 记下"这是自动提前翻过去的"，在真正走到目标页之前不要被 ensureVisible 拉回来
    store.set({ view: { autoTurnPending: true, pendingTarget: d.page } });
    renderer.goto(d.page, true);
    panel.refresh();
  });

  function clearPending() {
    if (store.get().view.autoTurnPending) store.set({ view: { autoTurnPending: false, pendingTarget: null } });
  }

  /**
   * 自动提前翻页会造成"当前小节还在上一页、但屏幕已经翻到下一页"的正常窗口期，
   * 所以这里只在确实跑出视野时才纠正 **线性推进** 的场景；
   * · 刚自动翻过页（等到当前进度走到目标页为止）→ 不动
   * · 手动跳转（点击小节、踏板、方向键）→ 允许跟随
   */
  function ensureVisible(entry) {
    if (!entry) return;
    var v = store.get().view;
    if (v.autoTurnPending) {
      if (entry.page !== v.pendingTarget) return;
      clearPending();
      return;
    }
    var lo = v.displayStart || 0;
    var hi = lo + (v.spread ? 1 : 0);
    if (entry.page < lo || entry.page > hi) renderer.goto(entry.page, true);
  }

  bus.on('ended', function () {
    stopPlay();
    toast('演奏到曲末，已停止。再按一次「开始」会从头来');
  });

  /**
   * 顶部 4 个点 = 当前小节里第几拍。
   * 点数按拍号自动收窄（3/4 只亮 3 个），第 1 拍用重音色，严格跟随 'beat' 事件。
   */
  function pulseBeat(q) {
    var bar = document.getElementById('pulseBar');
    var dots = document.querySelectorAll('#pulseBar .pulse-dot');
    if (!dots.length) return;
    var per = Math.max(1, Math.min(dots.length, q.beatsPerBar || dots.length));
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.remove('on', 'sub');
      dots[i].style.display = i < per ? '' : 'none';
    }
    var idx = Math.max(0, Math.min(per - 1, (q.indexInBar || 0)));
    dots[idx].classList.add('on');
    if (idx === 0) dots[idx].classList.add('first');
    bar.classList.add('lit');
  }

  function startPlay() {
    var st = store.get();
    if (!st.score) { toast('先点顶栏「导入乐谱」或「示例乐谱」'); return; }
    if (!st.timeline.length) { toast('这份谱子还没有小节 —— 按 E 进编辑模式，或点「按此网格重画」'); return; }
    // 上次停在了曲末：再按开始应该从头来，而不是"一开始就结束"（看起来像按钮失灵）
    if (st.transport.beat >= st.timelineTotalBeats - 1) {
      tracker.reset();
      pageTurn.invalidate();
      toast('上一遍已经到曲末，这次从头开始');
    }
    store.set({ transport: { playing: true } });
    ensureVisible(tracker.entry());
    metro.start();
    panel.refresh();
  }
  function stopPlay() {
    store.set({ transport: { playing: false } });
    metro.stop();
    panel.refresh();
  }

  function pageStep(dir) {
    var tl = store.get().timeline;
    var idx = store.get().transport.tlIndex;
    var curPage = tl[idx] ? tl[idx].page : store.get().view.page;
    var target = -1;
    if (dir > 0) {
      for (var i = idx + 1; i < tl.length; i++) if (tl[i].page !== curPage) { target = i; break; }
    } else {
      for (var j = idx - 1; j >= 0; j--) if (tl[j].page !== curPage) { target = j; break; }
    }
    if (target >= 0) tracker.setIndex(target);
    else {
      var p = Math.max(0, Math.min(store.get().score.pages.length - 1, store.get().view.page + dir));
      renderer.goto(p, true);
    }
    pageTurn.invalidate();
  }

  function toggleDark() {
    var dark = !store.get().view.dark;
    store.set({ view: { dark: dark } });
    document.body.dataset.theme = dark ? 'dark' : 'light';
    panel.refresh();
  }

  function toggleFullscreen() {
    var fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (fs) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      var t = document.documentElement;
      (t.requestFullscreen || t.webkitRequestFullscreen).call(t);
    }
    store.set({ view: { fullscreen: !fs } });
    document.body.classList.toggle('fullscreen', !fs);
  }

  var wakeLock = null;
  function toggleWake() {
    var btn = document.getElementById('btnWake');
    if (wakeLock) {
      try { wakeLock.release(); } catch (e) { }
      wakeLock = null;
      btn.classList.remove('is-on');
      panel.el.saveTip.textContent = '已取消屏幕常亮';
      return;
    }
    if (!root.navigator || !root.navigator.wakeLock) {
      panel.el.saveTip.textContent = '当前环境不支持 Wake Lock（建议用 Chrome，并避免长时间息屏设置）';
      return;
    }
    root.navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      btn.classList.add('is-on');
      lock.addEventListener && lock.addEventListener('release', function () {
        wakeLock = null; btn.classList.remove('is-on');
      });
      panel.el.saveTip.textContent = '屏幕已锁定常亮';
    }).catch(function (e) {
      panel.el.saveTip.textContent = '无法保持常亮：' + (e && e.message ? e.message : e);
    });
  }

  function bpmDelta(d) {
    var bpm = Math.max(20, Math.min(300, store.get().transport.bpm + d));
    store.set({ transport: { bpm: bpm } });
    panel.refresh();
  }

  var COMMANDS = {
    'toggle-play': function () { store.get().transport.playing ? stopPlay() : startPlay(); },
    'reset': function () { stopPlay(); clearPending(); tracker.reset(); pageTurn.invalidate(); ensureVisible(tracker.entry()); panel.refresh(); },
    'next-page': function () { clearPending(); pageStep(1); },
    'prev-page': function () { clearPending(); pageStep(-1); },
    'next-measure': function () { clearPending(); tracker.stepBars(1); pageTurn.invalidate(); },
    'prev-measure': function () { clearPending(); tracker.stepBars(-1); pageTurn.invalidate(); },
    'next-bar': function () { clearPending(); tracker.stepBars(1); pageTurn.invalidate(); },
    'prev-bar': function () { clearPending(); tracker.stepBars(-1); pageTurn.invalidate(); },
    'next-beat': function () { clearPending(); tracker.stepBeats(1); pageTurn.invalidate(); },
    'prev-beat': function () { clearPending(); tracker.stepBeats(-1); pageTurn.invalidate(); },
    'toggle-mode': function () {
      var mode = store.get().edit.mode === 'edit' ? 'play' : 'edit';
      store.set({ edit: { mode: mode }, view: { showBoxes: mode === 'edit' || store.get().view.showBoxes } });
      renderer.setMode(mode);
      panel.refresh();
    },
    'toggle-boxes': function () { store.set({ view: { showBoxes: !store.get().view.showBoxes } }); renderer.drawBoxes(); panel.refresh(); },
    'toggle-auto': function () { store.set({ turn: { auto: !store.get().turn.auto } }); pageTurn.invalidate(); panel.refresh(); },
    'toggle-dark': toggleDark,
    'toggle-sound': function () {
      var muted = !store.get().audio.muted;
      store.set({ audio: { muted: muted } });
      panel.refresh();
      toast(muted ? '节拍器已静音（顶部拍点仍在走）' : '节拍器声音已开');
    },
    'toggle-fullscreen': toggleFullscreen,
    'toggle-wake': toggleWake,
    'toggle-panel': function () {
      var on = !store.get().view.panels;
      store.set({ view: { panels: on } });
      document.getElementById('app').classList.toggle('panel-hidden', !on);
      setTimeout(function () { renderer.sync(); }, 220);
      panel.refresh();
    },
    'exit': function () {
      if (document.fullscreenElement) (document.exitFullscreen || function () { }).call(document);
    },
    'bpm-up': function () { bpmDelta(1); },
    'bpm-down': function () { bpmDelta(-1); }
  };

  bus.on('command', function (c) {
    var fn = COMMANDS[c.action];
    if (fn) fn(c);
  });

  /* ================= 自动保存 ================= */
  var saveTimer = null;
  store.subscribe(function (state, keys) {
    if (keys.indexOf('score') >= 0 || keys.indexOf('turn') >= 0 || keys.indexOf('repeat') >= 0 || keys.indexOf('input') >= 0) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        if (ST.Persistence.save(store.get())) {
          // 静默保存
        }
      }, 700);
    }
    if (keys.indexOf('transport') >= 0) {
      var ts = state.transport;
      document.getElementById('sigNum').value = String(ts.timeSig.num);
      document.getElementById('sigDen').value = String(ts.timeSig.den);
      document.getElementById('compound').checked = ts.compound;
    }
  });

  /* ================= 对外 API（外部踏板 / 程序调用） ================= */
  root.ScoreTurner = {
    store: store, bus: bus, tracker: tracker, metro: metro, renderer: renderer, panel: panel,
    /** 外部设备直接调用：ScoreTurner.trigger('next-page') */
    trigger: function (action, payload) { bus.emit('command', { action: action, from: 'external', payload: payload }); },
    gotoBar: function (bar, pass) { return tracker.gotoBar(bar, pass || 0); },
    gotoPage: function (p) { renderer.goto(p, true); },
    play: startPlay,
    pause: stopPlay,
    toast: toast,
    /** 注入自定义乐谱源（用于集成：只要实现 pageCount / render(i,w) / size(i) 即可） */
    loadSource: function (source) { useSource(source); },
    /** 按网格重标小节：ScoreTurner.autoGrid(每行小节数, 行数) */
    autoGrid: function (cols, rows) { return autoGridAll(cols || AUTO_COLS, rows || AUTO_ROWS); },
    /** 只读：下一次自动翻页的计划（目标页 / 触发拍 / 还有几拍） */
    plan: function () { return pageTurn.plan(); }
  };

  // 初始化主题
  document.body.dataset.theme = store.get().view.dark ? 'dark' : 'light';
  ST.app = { store: store, bus: bus, panel: panel };
  recompute();
})(typeof window !== 'undefined' ? window : globalThis);
