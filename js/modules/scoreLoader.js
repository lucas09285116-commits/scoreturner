/**
 * modules/scoreLoader.js
 * ---------------------------------------------------------------------------
 * 乐谱源适配层：把「PDF」和「一堆图片」统一成一个抽象：
 *     source.render(pageIndex, targetWidth) → { dataUrl, w, h }
 * 上层渲染器完全不用知道底层是 PDF 还是 JPG。
 *
 * 关于 file:// 下的 PDF：浏览器禁止用 file: 协议创建 Worker，
 * 所以本项目把 pdf.worker.min.js 当作普通脚本引入，pdf.js 会自动
 * 检测到 window.pdfjsWorker 并退回"同线程假 Worker"模式——
 * 代价是大 PDF 渲染时会短暂占住主线程，换来的是双击 index.html 即可用。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function imgFromUrl(url) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = rej;
      im.src = url;
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsArrayBuffer(file);
    });
  }

  function canvasToDataUrl(cv) {
    return cv.toDataURL('image/jpeg', 0.86);
  }

  /* ---------------- 图片源 ---------------- */
  function ImageSource(files) {
    this.kind = 'images';
    this.files = files;
    this.pageCount = files.length;
    this.cache = new Map();
    this.sizes = [];
  }
  ImageSource.prototype.size = function (i) {
    var self = this;
    if (this.sizes[i]) return Promise.resolve(this.sizes[i]);
    var f = this.files[i];
    var url = URL.createObjectURL(f);
    return imgFromUrl(url).then(function (im) {
      self.sizes[i] = { w: im.naturalWidth, h: im.naturalHeight };
      self.cache.set(i, { url: url, w: im.naturalWidth, h: im.naturalHeight });
      return self.sizes[i];
    });
  };
  ImageSource.prototype.render = function (i) {
    var c = this.cache.get(i);
    if (c) return Promise.resolve({ dataUrl: c.url, w: c.w, h: c.h });
    var f = this.files[i];
    var url = URL.createObjectURL(f);
    var self = this;
    return imgFromUrl(url).then(function (im) {
      self.cache.set(i, { url: url, w: im.naturalWidth, h: im.naturalHeight });
      return { dataUrl: url, w: im.naturalWidth, h: im.naturalHeight };
    });
  };

  /* ---------------- PDF 源 ---------------- */
  function PdfSource(doc) {
    this.kind = 'pdf';
    this.doc = doc;
    this.pageCount = doc.numPages;
    this.pages = new Map();
    this.cache = new Map();
  }
  PdfSource.prototype.page = function (i) {
    if (this.pages.has(i)) return this.pages.get(i);
    var p = this.doc.getPage(i + 1);
    this.pages.set(i, p);
    return p;
  };
  PdfSource.prototype.size = function (i) {
    return this.page(i).then(function (p) {
      var v = p.getViewport({ scale: 1 });
      return { w: v.width, h: v.height };
    });
  };
  PdfSource.prototype.render = function (i, targetWidth) {
    var key = i + '|' + Math.round(targetWidth || 1200);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    var self = this;
    return this.page(i).then(function (p) {
      var base = p.getViewport({ scale: 1 });
      var scale = (targetWidth || 1200) / base.width;
      var vp = p.getViewport({ scale: scale });
      var cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      return p.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.then(function () {
        var out = { dataUrl: canvasToDataUrl(cv), w: cv.width, h: cv.height };
        self.cache.set(key, out);
        return out;
      });
    });
  };
  // 文字层：供 barNumberRead 读取谱面印刷号（扫描件无文字层时内容为空，由上层回退手动对齐）
  PdfSource.prototype.textContent = function (i) {
    return this.page(i).then(function (p) { return p.getTextContent(); });
  };
  // 矢量操作列表：供 barlineDetect 做「矢量小节线检测」（比像素检测精确：
  // 小节线在 PDF 里是真实矩形/线段，不受水印、抗锯齿、品格数字干扰）
  PdfSource.prototype.operatorList = function (i) {
    return this.page(i).then(function (p) { return p.getOperatorList(); });
  };

  /* ---------------- 入口 ---------------- */
  function hashName(files) {
    return files.map(function (f) { return f.name + ':' + f.size + ':' + (f.lastModified || 0); }).join('|');
  }

  var Loader = {
    fromFiles: function (fileList) {
      var files = Array.prototype.slice.call(fileList);
      if (!files.length) return Promise.reject(new Error('没有选择文件'));
      var pdf = files.filter(function (f) { return /\.pdf$/i.test(f.name); });
      var imgs = files.filter(function (f) { return /^image\//i.test(f.type) || /\.(jpe?g|png|webp|bmp)$/i.test(f.name); })
        .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });

      var name = pdf.length ? pdf[0].name : (imgs[0] ? imgs[0].name + ' 等 ' + imgs.length + ' 张' : '未命名');

      if (pdf.length) {
        if (!root.pdfjsLib) return Promise.reject(new Error('pdf.js 未加载'));
        if (root.pdfjsLib.GlobalWorkerOptions) root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
        return readAsArrayBuffer(pdf[0]).then(function (buf) {
          return root.pdfjsLib.getDocument({ data: buf }).promise;
        }).then(function (doc) {
          var s = new PdfSource(doc);
          s.name = name;
          s.id = 'pdf:' + hashName([pdf[0]]);
          return s;
        }).catch(function (e) {
          if (pdf.length === 1 && !imgs.length) throw e;
          return makeImageSource();
        });
      }

      return Promise.resolve(makeImageSource());

      function makeImageSource() {
        if (!imgs.length) throw new Error('没有可用的 PDF 或图片');
        var s = new ImageSource(imgs);
        s.name = name;
        s.id = 'img:' + hashName(imgs);
        return s;
      }
    }
  };

  ST.ScoreLoader = Loader;
})(typeof window !== 'undefined' ? window : globalThis);
