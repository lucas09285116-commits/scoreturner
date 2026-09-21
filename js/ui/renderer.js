/**
 * ui/renderer.js
 * ---------------------------------------------------------------------------
 * 只负责"把状态画出来"和"把指针事件翻译成结构编辑"。它不含任何业务判断。
 *
 * 绘制策略：
 *   · 每一页一张 <figure>，横向排成一排，翻页 = 整排平移（GPU 合成，不重排）
 *   · 小节框与高亮都是绝对定位在「图像显示区」上的覆盖层，坐标用归一化的 0~1，
 *     缩放/窗口变化时按实际显示尺寸换算，所以在任何缩放下都贴得准
 *   · 图片按视口宽度按需渲染 + 缓存，避免一次性把整本 PDF 解码进内存
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function Renderer(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.source = null;
    this.imgCache = new Map();
    this.pages = [];          // [{ fig, img, overlay, hl }]
    this.drag = null;
    this.raf = null;
    this.el = {
      viewport: document.getElementById('viewport'),
      track: document.getElementById('track'),
      empty: document.getElementById('emptyHint'),
      stage: document.getElementById('stage'),
      turnFlash: document.getElementById('turnFlash')
    };
    this.bindResize();
  }

  Renderer.prototype.bindResize = function () {
    var self = this;
    var schedule = function () {
      if (self.raf) cancelAnimationFrame(self.raf);
      self.raf = requestAnimationFrame(function () { self.raf = null; self.sync(); });
    };
    root.addEventListener('resize', schedule);
    this._schedule = schedule;
  };

  /* ---------------- 载入乐谱 ---------------- */
  Renderer.prototype.load = function (source, measures) {
    this.source = source;
    this.imgCache.clear();
    this.el.empty.classList.add('hide');
    this.build();
    this.renderAround(0);
    return this;
  };

  Renderer.prototype.build = function () {
    var self = this;
    var count = this.source.pageCount;
    this.el.track.innerHTML = '';
    this.pages = [];
    for (var i = 0; i < count; i++) {
      var fig = document.createElement('figure');
      fig.className = 'page';
      fig.dataset.index = i;
      var img = document.createElement('img');
      img.alt = '第 ' + (i + 1) + ' 页';
      var ov = document.createElement('div');
      ov.className = 'overlay';
      var hl = document.createElement('div');
      hl.className = 'measure-hl';
      hl.style.display = 'none';
      ov.appendChild(hl);
      fig.appendChild(img);
      fig.appendChild(ov);
      this.el.track.appendChild(fig);
      /* eslint-disable no-loop-func */
      (function (index) {
        ov.addEventListener('pointerdown', function (e) { self.onDown(e, index); });
      })(i);
      this.pages.push({ fig: fig, img: img, overlay: ov, hl: hl, rendered: false });
    }
    this.sync();
  };

  Renderer.prototype.renderedWidth = function () {
    var w = this.el.viewport.clientWidth;
    var per = this.store.get().view.spread ? w / 2 : w;
    var dpr = root.devicePixelRatio || 1;
    return Math.min(2200, Math.max(700, Math.round(per * dpr * 1.25)));
  };

  Renderer.prototype.renderAround = function (center) {
    var self = this;
    var count = this.pages.length;
    var order = [];
    for (var d = 0; d < count; d++) {
      var a = center - d, b = center + d;
      if (a >= 0) order.push(a);
      if (b < count && d > 0) order.push(b);
    }
    order.forEach(function (idx, rank) {
      setTimeout(function () { self.renderPage(idx); }, Math.min(rank, 4) * 60);
    });
  };

  Renderer.prototype.renderPage = function (i) {
    var self = this;
    var p = this.pages[i];
    if (!p || p.rendered || p.busy) return;
    p.busy = true;
    if (this.imgCache.has(i)) { this.applyImage(i, this.imgCache.get(i)); return; }
    this.source.render(i, this.renderedWidth()).then(function (out) {
      self.imgCache.set(i, out);
      self.applyImage(i, out);
    }).catch(function (e) {
      p.busy = false;
      console.error('渲染第 ' + (i + 1) + ' 页失败', e);
    });
  };

  Renderer.prototype.applyImage = function (i, out) {
    var p = this.pages[i];
    if (!p) return;
    p.img.src = out.dataUrl;
    p.natural = { w: out.w, h: out.h };
    p.rendered = true;
    p.busy = false;
    this.sync();
  };

  /* ---------------- 布局与缩放 ---------------- */
  Renderer.prototype.sync = function () {
    var st = this.store.get();
    var spread = st.view.spread;
    var vw = this.el.viewport.clientWidth, vh = this.el.viewport.clientHeight;
    var availW = spread ? vw / 2 : vw;
    var availH = vh;

    this.pages.forEach(function (p, i) {
      p.fig.dataset.width = String(availW);
      if (!p.natural) return;
      var s;
      if (st.view.zoomMode === 'width') s = availW / p.natural.w;
      else if (st.view.zoomMode === 'manual') s = st.view.zoomValue * Math.min(availW / p.natural.w, availH / p.natural.h) / 1;
      else s = Math.min(availW / p.natural.w, availH / p.natural.h);
      var dw = p.natural.w * s, dh = p.natural.h * s;
      p.img.style.width = dw + 'px';
      p.img.style.height = dh + 'px';
      p.overlay.style.left = ((availW - dw) / 2) + 'px';
      p.overlay.style.top = ((availH - dh) / 2) + 'px';
      p.overlay.style.width = dw + 'px';
      p.overlay.style.height = dh + 'px';
      p.disp = { w: dw, h: dh };
    });

    document.body.classList.toggle('spread', spread);
    this.applyTransform(false);
    this.drawBoxes();
    this.paintHighlight();
  };

  Renderer.prototype.applyTransform = function (animate) {
    var st = this.store.get();
    var pageW = this.el.viewport.clientWidth / (st.view.spread ? 2 : 1);
    var start = st.view.displayStart || 0;
    this.el.track.classList.toggle('no-anim', !animate);
    this.el.track.style.transitionDuration = (st.turn.animateMs || 0) + 'ms';
    this.el.track.style.transform = 'translate3d(' + (-start * pageW) + 'px,0,0)';
  };

  /* ---------------- 翻页 ---------------- */
  Renderer.prototype.goto = function (pageIndex, animate) {
    var st = this.store.get();
    var spread = st.view.spread;
    var count = this.pages.length;
    var target = Math.max(0, Math.min(pageIndex, count - 1));
    var start = spread ? Math.floor(target / 2) * 2 : target;
    if (st.view.page === target && (st.view.displayStart || 0) === start) return;
    this.store.set({ view: { page: target, displayStart: start } });
    this.renderAround(target);
    this.applyTransform(animate !== false);
    if (animate) {
      var f = this.el.turnFlash;
      f.classList.remove('go');
      void f.offsetWidth;
      f.classList.add('go');
    }
    this.drawBoxes();
    this.paintHighlight();
  };

  /* ---------------- 小节框 & 高亮 ---------------- */
  Renderer.prototype.boxClassName = function (m) {
    var cls = 'mbox';
    if (this.store.get().edit.selectedId === m.id) cls += ' sel';
    return cls;
  };

  Renderer.prototype.drawBoxes = function () {
    var st = this.store.get();
    if (!st.score) return;
    var show = st.view.showBoxes || st.edit.mode === 'edit';
    this.pages.forEach(function (p, i) {
      Array.prototype.slice.call(p.overlay.querySelectorAll('.mbox')).forEach(function (n) { n.remove(); });
    });
    if (!show) return;
    var self = this;
    st.score.measures.forEach(function (m) {
      var p = self.pages[m.page];
      if (!p || !p.disp) return;
      var d = document.createElement('div');
      d.className = self.boxClassName(m);
      d.dataset.id = m.id;
      d.style.left = (m.x * p.disp.w) + 'px';
      d.style.top = (m.y * p.disp.h) + 'px';
      d.style.width = (m.w * p.disp.w) + 'px';
      d.style.height = (m.h * p.disp.h) + 'px';
      var tags = [];
      if (m.repeatStart) tags.push('|:');
      if (m.repeatEnd) tags.push(':|');
      if (m.volta && m.volta.length) tags.push(m.volta.join('.') + '.');
      if (tags.length) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = tags.join(' ');
        d.appendChild(tag);
      }
      var handle = document.createElement('span');
      handle.className = 'handle';
      d.appendChild(handle);
      p.overlay.appendChild(d);
    });
    this.pages.forEach(function (p) { p.overlay.classList.toggle('edit', st.edit.mode === 'edit'); });
  };

  Renderer.prototype.paintHighlight = function () {
    var st = this.store.get();
    this.pages.forEach(function (p) { p.hl.style.display = 'none'; });
    var e = st.timeline[st.transport.tlIndex];
    if (!e) return;
    var p = this.pages[e.page];
    if (!p || !p.disp) return;
    p.hl.style.display = 'block';
    p.hl.style.left = (e.rect.x * p.disp.w) + 'px';
    p.hl.style.top = (e.rect.y * p.disp.h) + 'px';
    p.hl.style.width = (e.rect.w * p.disp.w) + 'px';
    p.hl.style.height = (e.rect.h * p.disp.h) + 'px';
    // 目标页不在视野时，把当前页也带过去由 app 决定；这里只负责画
  };

  /* ---------------- 编辑交互 ---------------- */
  Renderer.prototype.norm = function (e, pageIndex) {
    var p = this.pages[pageIndex];
    if (!p || !p.disp) return null;
    var r = p.overlay.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    };
  };

  Renderer.prototype.onDown = function (ev, pageIndex) {
    var st = this.store.get();
    if (st.edit.mode !== 'edit' || !this.source) {
      // 演奏态：点一下就把进度跳到最近的那次出现
      var target = ev.target.closest ? ev.target.closest('.mbox') : null;
      if (!target) return;
      this.bus.emit('measure:click', { id: target.dataset.id });
      return;
    }
    ev.preventDefault();
    var boxEl = ev.target.closest ? ev.target.closest('.mbox') : null;
    var self = this;
    var start = this.norm(ev, pageIndex);
    if (!start) return;

    if (boxEl) {
      var id = boxEl.dataset.id;
      this.store.set({ edit: { selectedId: id } });
      this.bus.emit('measure:selected', { id: id });
      var m = st.score.measures.filter(function (x) { return x.id === id; })[0];
      this.drag = {
        mode: ev.target.classList.contains('handle') ? 'resize' : 'move',
        id: id, page: pageIndex, start: start, base: { x: m.x, y: m.y, w: m.w, h: m.h }
      };
    } else {
      this.store.set({ edit: { selectedId: null } });
      this.bus.emit('measure:selected', { id: null });
      this.drag = { mode: 'create', page: pageIndex, start: start, ghost: this.makeGhost(pageIndex) };
    }

    var move = function (e2) { self.onMove(e2); };
    var up = function (e2) {
      self.onUp(e2);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerup', up);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerup', up);
  };

  Renderer.prototype.makeGhost = function (pageIndex) {
    var p = this.pages[pageIndex];
    var d = document.createElement('div');
    d.className = 'mbox sel';
    d.style.borderStyle = 'solid';
    d.style.display = 'none';
    p.overlay.appendChild(d);
    return d;
  };

  Renderer.prototype.onMove = function (ev) {
    var d = this.drag;
    if (!d) return;
    var cur = this.norm(ev, d.page);
    if (!cur) return;
    if (d.mode === 'create') {
      var x = Math.min(d.start.x, cur.x), y = Math.min(d.start.y, cur.y);
      var w = Math.abs(cur.x - d.start.x), h = Math.abs(cur.y - d.start.y);
      d.rect = { x: x, y: y, w: w, h: h };
      var ow = this.pages[d.page].disp.w, oh = this.pages[d.page].disp.h;
      d.ghost.style.display = (w * ow > 8 && h * oh > 8) ? 'block' : 'none';
      d.ghost.style.left = (x * ow) + 'px';
      d.ghost.style.top = (y * oh) + 'px';
      d.ghost.style.width = (w * ow) + 'px';
      d.ghost.style.height = (h * oh) + 'px';
      return;
    }
    var dx = cur.x - d.start.x, dy = cur.y - d.start.y;
    var patch = { x: d.base.x + dx, y: d.base.y + dy };
    if (d.mode === 'resize') {
      patch.w = Math.max(0.01, d.base.w + dx);
      patch.h = Math.max(0.01, d.base.h + dy);
      delete patch.x; delete patch.y;
    }
    this.bus.emit('measure:patch', { id: d.id, patch: patch });
  };

  Renderer.prototype.onUp = function () {
    var d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.mode === 'create') {
      if (d.ghost) d.ghost.remove();
      if (d.rect && d.rect.w > 0.008 && d.rect.h > 0.008) {
        this.bus.emit('measure:create', { page: d.page, rect: d.rect });
      }
    }
  };

  Renderer.prototype.setMode = function (mode) {
    this.pages.forEach(function (p) { p.overlay.classList.toggle('edit', mode === 'edit'); });
    this.drawBoxes();
  };

  ST.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
