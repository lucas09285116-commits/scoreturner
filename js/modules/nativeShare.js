/**
 * modules/nativeShare.js —— 原生 App 的"分享/打开方式"接收
 * ---------------------------------------------------------------------------
 * 只在被打包进原生壳（Capacitor，window.Capacitor 存在）时生效。
 * 安卓 MainActivity 收到系统分享后会把文件 base64 存入 ShareReceiver 插件，
 * 这里在 app 就绪后调用 getPending()，取回并交给现有的 api.loadFiles 导入。
 *
 * 线上网页版（window.Capacitor 不存在）里本模块自动空转，不影响原逻辑。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function init(api) {
    if (!root.Capacitor || !root.Capacitor.Plugins || !root.Capacitor.Plugins.ShareReceiver) return;
    if (!api || !api.loadFiles) return;

    function pull() {
      root.Capacitor.Plugins.ShareReceiver.getPending().then(function (res) {
        var files = [];
        try { files = JSON.parse((res && res.files) || '[]'); } catch (e) { files = []; }
        if (!files.length) return;
        files.forEach(function (f) {
          if (!f || !f.data) return;
          fetch(f.data).then(function (blob) {
            var file = new File([blob], f.name || 'shared-score', { type: f.mime || blob.type || 'application/octet-stream' });
            return api.loadFiles([file]).then(function () { return file; });
          }).then(function (file) {
            // 主诉求：谱子要传到电脑上翻谱 —— 顺手上传进电脑端的收件箱
            var Net = root.ST && root.ST.Net;
            if (Net && Net.uploadFile) {
              return Net.uploadFile(file).then(function () {
                if (api && api.toast) api.toast('已打开，并已发到电脑收件箱 —— 电脑上点「手机传谱」即可打开', 6000);
              }).catch(function () {
                if (api && api.toast) api.toast('已在手机上打开，但发到电脑失败 —— 请检查手机网络', 5500);
              });
            }
            if (api && api.toast) api.toast('已打开「' + (f.name || '谱子') + '」', 3500);
          }).catch(function () {});
        });
      }).catch(function () {});
    }

    // 供原生层在 App 已运行时主动调用（onNewIntent 场景）
    root.__scoreTurnerNativeShare = pull;

    // 启动后主动拉一次（冷启动场景）
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(pull, 800);
    } else {
      window.addEventListener('DOMContentLoaded', function () { setTimeout(pull, 800); });
    }
  }

    // App 已在后台运行、被分享唤醒的场景：回到前台时再拉一次待处理文件
    var onResume = function () { if (!document.hidden) pull(); };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);

    ST.NativeShare = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
