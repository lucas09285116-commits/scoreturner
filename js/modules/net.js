/**
 * modules/net.js —— 手机传谱（在线专属功能）
 * ---------------------------------------------------------------------------
 * 只在「非 file:// 协议」下启用（即部署后的在线版）。离线双击 index.html 时
 * 整个模块自动停用，顶栏的「手机传谱」按钮也会被隐藏，不影响本地使用。
 *
 * 它做两件事：
 *   · 手机端：选 PDF/图片 → 上传到后端（POST /api/upload，裸二进制 + 进度）
 *   · 电脑端：收件箱列出已上传文件 → 点「打开」把后端文件取回、就地导入、
 *            或点「删除」清理（DELETE /api/files/:id）
 *
 * 打开已上传文件时，把后端返回的 Blob 包成 File 再交给 api.loadFiles，
 * 于是完整复用现有的导入管线（小节识别、自动保存、演奏全都不用改）。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function isOnline() {
    // 被打包进原生壳（Capacitor）时虽然协议不是 file:，但并没有后端服务，
    // 必须按"离线"处理，隐藏在线专属的「手机传谱」按钮与收件箱逻辑。
    if (typeof window !== 'undefined' && window.Capacitor) return false;
    return typeof location !== 'undefined' && location.protocol !== 'file:';
  }

  function uploadFile(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name || 'score'));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error('后端返回无法解析')); }
        } else {
          var msg = '上传失败（' + xhr.status + '）';
          try { var j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch (e) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = function () { reject(new Error('网络错误，上传未完成')); };
      xhr.send(file);
    });
  }

  function listFiles() {
    return fetch('/api/files').then(function (r) { return r.json(); }).then(function (j) {
      return (j && j.files) || [];
    });
  }

  function deleteFile(id) {
    return fetch('/api/files/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) { return r.json(); });
  }

  function fetchFile(id) {
    return fetch('/api/files/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error('下载失败（' + r.status + '）');
      return r.blob();
    });
  }

  function humanSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      var p = function (x) { return (x < 10 ? '0' : '') + x; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  /* ---------------- 弹窗接管（由 app.js 在 api 就绪后调用 mount） ---------------- */
  function mount(api) {
    var btn = document.getElementById('btnNet');
    var modal = document.getElementById('netModal');
    if (!btn || !modal) return;

    var closeBtn = document.getElementById('netClose');
    var fileInput = document.getElementById('netFile');
    var drop = document.getElementById('netDrop');
    var progress = document.getElementById('netProgress');
    var bar = document.getElementById('netBar');
    var pct = document.getElementById('netPct');
    var listEl = document.getElementById('netList');
    var refreshBtn = document.getElementById('netRefresh');
    var linkEl = document.getElementById('netLink');
    var copyBtn = document.getElementById('netCopy');
    var installBtn = document.getElementById('netInstall');
    var installStatus = document.getElementById('netInstallStatus');
    var urlInput = document.getElementById('netUrl');
    var urlGo = document.getElementById('netUrlGo');

    // 把本页地址显示出来——这就是手机要打开的链接
    var shareUrl = '';
    try { shareUrl = location.origin + location.pathname; } catch (e) {}
    if (linkEl && shareUrl && shareUrl.indexOf('http') === 0) {
      linkEl.textContent = shareUrl;
      linkEl.href = shareUrl;
    } else if (linkEl) {
      linkEl.textContent = '（当前是本地离线模式，无链接）';
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (!shareUrl) return;
        function toast(msg) { if (api && api.toast) api.toast(msg, 2600); }
        function ok() {
          copyBtn.textContent = '已复制 ✓';
          toast('链接已复制：' + shareUrl);
          setTimeout(function () { copyBtn.textContent = '复制链接'; }, 2000);
        }
        function failSelect() {
          // 兜底：把链接文字选中，提示用户手动复制
          if (linkEl) {
            try {
              var range = document.createRange();
              range.selectNodeContents(linkEl);
              var sel = window.getSelection();
              sel.removeAllRanges(); sel.addRange(range);
            } catch (e) {}
          }
          copyBtn.textContent = '没复制成，已帮你选中链接';
          toast('没自动复制成功，已把链接文字选中 —— 请按 Ctrl+C（手机长按）复制');
          setTimeout(function () { copyBtn.textContent = '复制链接'; }, 3000);
        }
        function legacyCopy() {
          try {
            var ta = document.createElement('textarea');
            ta.value = shareUrl;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            var res = document.execCommand('copy');
            document.body.removeChild(ta);
            return res;
          } catch (e) { return false; }
        }
        copyBtn.textContent = '复制中…';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareUrl).then(ok).catch(function () {
            legacyCopy() ? ok() : failSelect();
          });
        } else {
          legacyCopy() ? ok() : failSelect();
        }
      });
    }

    var isLocalPreview = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

    /* ---------------- PWA：注册 service worker + 安装到主屏幕 ----------------
     * 装成应用后，安卓系统「分享」面板里才会出现 ScoreTurner，
     * B站/微信的谱子即可不下载直接分享进来（share_target → /share-target）。
     * ---------------------------------------------------------------------- */
    if ('serviceWorker' in navigator && !isLocalPreview) {
      try { navigator.serviceWorker.register('/sw.js'); } catch (e) {}
    }
    var deferredInstall = null;
    var iOSLike = /iphone|ipad|ipod/i.test(navigator.userAgent);
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      if (installBtn) installBtn.hidden = false;
    });
    if (installBtn) {
      if (!iOSLike) installBtn.hidden = false; // 安卓上常驻显示，点了没就绪会给出指引
      // 已以「已安装应用」形态打开时，给出确认态，避免用户怀疑没装
      var isStandalone = false;
      try { isStandalone = window.matchMedia('(display-mode: standalone)').matches; } catch (e) {}
      if (isStandalone && installStatus) {
        installStatus.textContent = '✅ 已作为应用运行，可从 B站/微信/文件管理直接选 ScoreTurner';
        installStatus.className = 'net-install-status ok';
        installBtn.hidden = true;
      }
      installBtn.addEventListener('click', function () {
        function toast(msg) { if (api && api.toast) api.toast(msg, 6000); }
        if (deferredInstall) {
          deferredInstall.prompt();
          deferredInstall.userChoice.then(function (choice) {
            if (choice && choice.outcome === 'accepted') {
              toast('安装成功！到手机桌面打开 ScoreTurner，以后在 B站/微信点「分享」就能直接传谱', 7000);
              installBtn.hidden = true;
            }
            deferredInstall = null;
          });
        } else if (iOSLike) {
          toast('iPhone：用 Safari 打开本页 → 点「分享」→「添加到主屏幕」即可（但 iPhone 不支持分享文件进来，传谱仍需选择文件/粘贴链接）');
        } else {
          toast('浏览器暂时没弹出安装入口：请用 Chrome 打开本页 → 右上角菜单「添加到主屏幕 / 安装应用」');
        }
      });
    }

    /* ---------------- file_handlers：「用其他应用打开」直达 ----------------
     * 安卓装成应用后，系统「打开方式」里可把 PDF/图片直接交给 ScoreTurner。
     * Chrome 通过 launchQueue 把 FileSystemFileHandle 交给页面，这里取出并导入。
     * 仅安卓 Chrome、且已安装为应用时可用；iPhone 不支持。
     * -------------------------------------------------------------------- */
    if ('launchQueue' in window && window.launchQueue && window.launchQueue.setConsumer) {
      window.launchQueue.setConsumer(function (params) {
        var files = (params && params.files) || [];
        var i = 0;
        function next() {
          if (i >= files.length) return;
          var handle = files[i++];
          Promise.resolve(handle && handle.getFile ? handle.getFile() : handle)
            .then(function (file) {
              if (!file) return;
              return api.loadFiles([file]).then(function () {
                if (api && api.toast) api.toast('已打开「' + file.name + '」', 4000);
                if (modal) modal.hidden = true;
              });
            })
            .catch(function () { next(); })
            .then(next);
        }
        next();
        if (api && api.toast) api.toast('正在打开你选择的乐谱…', 4000);
      });
    }

    /* ---------------- 安卓分享直达：/?shared=<id> 自动导入 ----------------
     * 系统分享 → POST /share-target → 303 跳回 /?shared=<id>，
     * 这里检测到参数就把文件取回、走 loadFiles 就地导入，然后清掉参数。
     * -------------------------------------------------------------------- */
    (function handleShared() {
      var ids = '';
      try { ids = new URLSearchParams(location.search).get('shared') || ''; } catch (e) {}
      if (!ids) return;
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
      var list = ids.split(',').filter(Boolean);
      listFiles().then(function (files) {
        var byId = {};
        files.forEach(function (m) { byId[m.id] = m; });
        var i = 0;
        function next() {
          if (i >= list.length) return;
          var meta = byId[list[i++]] || {};
          fetchFile(meta.id || '').then(function (blob) {
            var file = new File([blob], meta.name || 'shared-score', { type: meta.type || blob.type || 'application/octet-stream' });
            return api.loadFiles([file]);
          }).then(next).catch(function () { next(); });
        }
        next();
      }).catch(function () {});
      if (api && api.toast) api.toast('收到分享的谱子，正在导入…', 4000);
    })();

    /* ---------------- 粘贴链接代抓：手机不落盘，服务器去下载 ---------------- */
    if (urlGo) {
      urlGo.addEventListener('click', function () {
        var url = (urlInput && urlInput.value || '').trim();
        function toast(msg) { if (api && api.toast) api.toast(msg, 6000); }
        if (!url) { toast('请先粘贴谱子链接'); return; }
        urlGo.disabled = true;
        urlGo.textContent = '抓取中…';
        fetch('/api/fetch-url?url=' + encodeURIComponent(url), { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.error) { toast('抓取失败：' + j.error); return; }
            urlInput.value = '';
            toast('已抓到「' + (j.name || '文件') + '」，进了收件箱');
            refresh();
          })
          .catch(function () { toast('抓取失败：网络错误'); })
          .then(function () {
            urlGo.disabled = false;
            urlGo.textContent = '抓取';
          });
      });
    }

    var refreshTimer = null;

    function open() {
      modal.hidden = false;
      document.getElementById('app').classList.add('modal-open');
      refresh();
      // 弹窗开着时每 4 秒自动刷新一次，手机刚传完电脑就能看到
      refreshTimer = setInterval(refresh, 4000);
    }
    function close() {
      modal.hidden = true;
      document.getElementById('app').classList.remove('modal-open');
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }

    btn.addEventListener('click', open);
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });

    /* 上传：点选 + 拖拽到上传区 */
    fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) doUpload(e.target.files);
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    // 点击上传区直接唤起文件选择（用显式 click 而非 <label>，移动端更稳，且避免双击触发两次）
    drop.addEventListener('click', function (e) {
      if (e.target !== fileInput) fileInput.click();
    });
    drop.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) doUpload(files);
    });

    refreshBtn.addEventListener('click', refresh);

    function doUpload(fileList) {
      var files = Array.prototype.slice.call(fileList);
      if (!files.length) return;
      progress.hidden = false;
      bar.style.setProperty('--w', '0%'); pct.textContent = '0%';
      // 逐个上传（乐谱一般不批量，逐个更稳也更好看进度）
      var i = 0;
      function next() {
        if (i >= files.length) {
          progress.hidden = true;
          refresh();
          if (api && api.toast) api.toast('已上传 ' + files.length + ' 个文件，电脑端收件箱可点开', 4000);
          return;
        }
        var f = files[i++];
        uploadFile(f, function (ratio) {
          var p = Math.round((ratio || 0) * 100);
          bar.style.setProperty('--w', p + '%'); pct.textContent = p + '%';
        }).then(function () { next(); }).catch(function (err) {
          progress.hidden = true;
          if (api && api.toast) api.toast('上传出错：' + (err && err.message ? err.message : err), 5000);
        });
      }
      next();
    }

    function refresh() {
      listFiles().then(function (files) {
        if (!files.length) {
          listEl.innerHTML = '<li class="net-empty">还没有收到文件 —— 手机上传后会出现在这里</li>';
          return;
        }
        listEl.innerHTML = files.map(function (m) {
          var safe = (m.name || 'score').replace(/"/g, '&quot;');
          return '<li class="net-item" data-id="' + m.id + '">' +
            '<span class="net-name" title="' + safe + '">' + safe + '</span>' +
            '<span class="net-meta">' + humanSize(m.size) + ' · ' + fmtTime(m.ts) + '</span>' +
            '<span class="net-acts">' +
            '<button class="btn btn-slim net-open" data-id="' + m.id + '">打开</button>' +
            '<button class="btn btn-slim net-del" data-id="' + m.id + '">删除</button>' +
            '</span></li>';
        }).join('');
      }).catch(function () {
        listEl.innerHTML = isLocalPreview
          ? '<li class="net-empty">当前打开的是<b>本地预览</b>，没有上传后台。<br>请改用发布链接打开（见上方），手机传谱功能在发布版上可用</li>'
          : '<li class="net-empty">无法连接收件箱（后端未启动或网络异常）</li>';
      });
    }

    // 收件箱里「打开 / 删除」用事件委托
    listEl.addEventListener('click', function (e) {
      var t = e.target;
      var id = t.getAttribute && t.getAttribute('data-id');
      if (!id) return;
      if (t.classList.contains('net-open')) {
        t.textContent = '取回中…';
        t.disabled = true;
        fetchFile(id).then(function (blob) {
          // 取回的 Blob 包成 File，复用现有导入管线
          var meta = { name: t.closest('.net-item').querySelector('.net-name').textContent };
          var file = new File([blob], meta.name, { type: blob.type || 'application/octet-stream' });
          return api.loadFiles([file]).then(function () {
            close();
            if (api && api.toast) api.toast('已导入「' + meta.name + '」，开始你的演奏吧', 4000);
          });
        }).catch(function (err) {
          t.textContent = '打开'; t.disabled = false;
          if (api && api.toast) api.toast('打开失败：' + (err && err.message ? err.message : err), 5000);
        });
      } else if (t.classList.contains('net-del')) {
        deleteFile(id).then(function () { refresh(); });
      }
    });
  }

  ST.Net = {
    isOnline: isOnline,
    uploadFile: uploadFile,
    listFiles: listFiles,
    deleteFile: deleteFile,
    fetchFile: fetchFile,
    mount: mount
  };
})(typeof window !== 'undefined' ? window : globalThis);
