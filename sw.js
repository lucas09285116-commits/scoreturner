/**
 * sw.js —— ScoreTurner 极简 Service Worker
 * ---------------------------------------------------------------------------
 * 目的只有一个：让 PWA 可安装（Chrome 要求注册过 service worker）。
 * 刻意**不做任何缓存**（fetch 事件直接放行）——保证发布更新后所有端
 * 立刻拿到最新版，绝无"改了代码用户还是旧版"的问题。
 * ---------------------------------------------------------------------------
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

// 纯放行：不拦截、不缓存
self.addEventListener('fetch', function () {});
