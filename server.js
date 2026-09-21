/**
 * server.js —— ScoreTurner 在线版后端（单端口 HTTP 服务）
 * ---------------------------------------------------------------------------
 * 同时做两件事：
 *   1) 托管前端静态文件（只暴露 vendor / js / css / index.html / README.md，
 *      绝不暴露 server.js、package.json、uploads/ 等内部文件）
 *   2) 提供「手机传谱」用的极简上传/收件箱 API（无外部依赖，纯 Node 内置模块）
 *
 * 存储：上传的文件落在 uploads/ 目录，每个文件两件套
 *      <id>.bin  原始字节
 *      <id>.meta 元数据 JSON（name / type / size / ts）
 * 整个目录随应用一起部署，属"应用内部存储"，可正常发布。
 *
 * 部署要求：监听 process.env.PORT 并绑定 0.0.0.0（见末尾 listen）。
 * ---------------------------------------------------------------------------
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = __dirname;
var UPLOAD_DIR = path.join(ROOT, 'uploads');
var PORT = parseInt(process.env.PORT, 10) || 3000;
var MAX_UPLOAD = 80 * 1024 * 1024; // 单文件上限 80MB（乐谱足够）

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

var ALLOWED_DIRS = ['vendor', 'js', 'css'];

// PWA / 图标等根目录白名单文件（manifest、service worker、应用图标）
var ROOT_FILES = ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png'];

function sendJson(res, code, obj) {
  var b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store'
  });
  res.end(b);
}

function safeId(id) {
  // 只允许十六进制 id（由服务器生成），杜绝路径穿越
  return /^[a-f0-9]{1,64}$/.test(id);
}

function listMeta() {
  var out;
  try {
    out = fs.readdirSync(UPLOAD_DIR).filter(function (f) { return f.endsWith('.meta'); });
  } catch (e) {
    return [];
  }
  return out
    .map(function (f) {
      try { return JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8')); }
      catch (e) { return null; }
    })
    .filter(Boolean)
    .sort(function (a, b) { return b.ts - a.ts; });
}

function staticAllowed(rel) {
  if (rel === '/' || rel === '/index.html' || rel === '/README.md') return true;
  if (ROOT_FILES.indexOf(rel.replace(/^\/+/, '')) >= 0) return true;
  if (rel.indexOf('/icon-') === 0) return true; // 应用图标
  var parts = rel.replace(/^\/+/, '').split('/');
  return ALLOWED_DIRS.indexOf(parts[0]) >= 0;
}

/* ---------------- 上保存：把一段 Buffer 存进收件箱 ---------------- */
function saveInbox(name, ctype, buf) {
  var clean = String(name || 'score')
    .replace(/[^\w.\-\u4e00-\u9fa5 ()\[\]]{1,200}/g, '')
    .slice(0, 200) || 'score';
  var id = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, id + '.bin'), buf);
  var m = { id: id, name: clean, type: ctype || 'application/octet-stream', size: buf.length, ts: Date.now() };
  fs.writeFileSync(path.join(UPLOAD_DIR, id + '.meta'), JSON.stringify(m));
  return m;
}

/* ---------------- 极简 multipart/form-data 解析（零依赖） ----------------
 * 只为 Web Share Target 服务：安卓系统「分享」过来的文件以
 * multipart 形式 POST 到 /share-target。这里按 boundary 切块，
 * 抽出每个带 filename 的部分（即文件本身）。
 * ---------------------------------------------------------------------- */
function parseMultipart(buf, contentType) {
  var m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return [];
  var bBuf = Buffer.from('--' + (m[1] || m[2]).trim());
  var parts = [];
  var start = buf.indexOf(bBuf);
  while (start !== -1) {
    var next = buf.indexOf(bBuf, start + bBuf.length);
    if (next === -1) break;
    // 一块 = \r\n + headers + \r\n\r\n + data + \r\n
    var part = buf.slice(start + bBuf.length, next);
    var sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      parts.push({
        head: part.slice(2, sep).toString('utf8'),   // 去掉开头 \r\n
        data: part.slice(sep + 4, part.length - 2)  // 去掉结尾 \r\n
      });
    }
    start = next;
  }
  return parts;
}

function dispositionParam(head, param) {
  // 从 Content-Disposition 里抠 name="xxx" / filename="xxx"（含 filename*=UTF-8''xx）
  var re = new RegExp(param + '\\*="?([^";]+)"?', 'i');
  var m = re.exec(head);
  if (m && param === 'filename') {
    // RFC5987: filename*=UTF-8''%e5%..  → 解码
    var mm = /^([^']*)'[^']*'(.*)$/.exec(m[1]);
    if (mm) { try { return decodeURIComponent(mm[2]); } catch (e) { return mm[2]; } }
  }
  if (m) return m[1];
  re = new RegExp(param + '="([^"]*)"', 'i');
  m = re.exec(head);
  return m ? m[1] : '';
}

/* ---------------- 链接代抓：服务端下载 URL 并存进收件箱 ---------------- */
function fetchUrlToInbox(url, redirects, done) {
  if (redirects > 5) return done({ status: 508, message: '重定向次数太多' });
  var u;
  try { u = new URL(url); } catch (e) { return done({ status: 400, message: '链接格式不对' }); }
  var mod = u.protocol === 'https:' ? require('https') : http;
  var req = mod.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 ScoreTurnerBot/1.0', 'Accept': '*/*' } }, function (res) {
    var sc = res.statusCode || 0;
    if (sc >= 300 && sc < 400 && res.headers.location) {
      res.resume(); // 丢弃当前响应体
      var next;
      try { next = new URL(res.headers.location, url).toString(); } catch (e) {
        return done({ status: 502, message: '重定向地址无效' });
      }
      return fetchUrlToInbox(next, redirects + 1, done);
    }
    if (sc !== 200) {
      res.resume();
      return done({ status: 502, message: '对方服务器返回 ' + sc + '（链接可能需要登录或已失效）' });
    }
    var ctype = (res.headers['content-type'] || '').split(';')[0].trim();
    if (/^text\/html/i.test(ctype)) {
      res.resume();
      return done({ status: 415, message: '该链接打开的是网页而不是文件（很可能需要登录）。请先把文件下载/保存，再走「选择文件上传」' });
    }
    var chunks = [];
    var size = 0;
    res.on('data', function (c) {
      size += c.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        return done({ status: 413, message: '文件超过 80MB 上限' });
      }
      chunks.push(c);
    });
    res.on('end', function () {
      // 文件名优先级：Content-Disposition → URL 路径最后一段 → 默认
      var name = dispositionParam('content-disposition: ' + (res.headers['content-disposition'] || ''), 'filename');
      if (!name) {
        try {
          var last = u.pathname.split('/').filter(Boolean).pop() || '';
          name = decodeURIComponent(last);
        } catch (e) { name = ''; }
      }
      if (!name || name.indexOf('?') >= 0) name = 'score-from-link';
      if (!path.extname(name)) {
        var extMap = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
        name += extMap[ctype] || '';
      }
      done(null, saveInbox(name, ctype || 'application/octet-stream', Buffer.concat(chunks)));
    });
    res.on('error', function () { done({ status: 502, message: '下载中断' }); });
  });
  req.on('timeout', function () { req.destroy(); done({ status: 504, message: '对方服务器超时' }); });
  req.on('error', function () { done({ status: 502, message: '无法访问该链接（网络错误或地址不存在）' }); });
}

var server = http.createServer(function (req, res) {
  var parsed;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400); return res.end('bad request');
  }
  var p = parsed.pathname;

  /* ---------------- 跨域（CORS）----------------
   * 原生安卓 App 的页面 origin 是 http://localhost（Capacitor WebView），
   * 它要把收到的谱子上传到本服务，必须放开跨域，否则浏览器直接拦截。
   * 仅用于自用的上传/收件箱接口，故允许任意来源。
   * --------------------------------------------------------------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* ---------------- API：列表 ---------------- */
  if (req.method === 'GET' && p === '/api/files') {
    return sendJson(res, 200, { files: listMeta() });
  }

  /* ---------------- API：下载 ---------------- */
  if (req.method === 'GET' && p.indexOf('/api/files/') === 0) {
    var id = p.slice('/api/files/'.length);
    if (!safeId(id)) return sendJson(res, 400, { error: 'bad id' });
    var metaPath = path.join(UPLOAD_DIR, id + '.meta');
    var dataPath = path.join(UPLOAD_DIR, id + '.bin');
    if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    var meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (e) { return sendJson(res, 500, { error: 'meta broken' }); }
    var ext = path.extname(meta.name || '').toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || meta.type || 'application/octet-stream',
      'Content-Disposition': 'inline; filename="' + encodeURIComponent(meta.name || 'score') + '"',
      'Cache-Control': 'no-store'
    });
    return fs.createReadStream(dataPath).pipe(res);
  }

  /* ---------------- API：删除 ---------------- */
  if (req.method === 'DELETE' && p.indexOf('/api/files/') === 0) {
    var delId = p.slice('/api/files/'.length);
    if (!safeId(delId)) return sendJson(res, 400, { error: 'bad id' });
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, delId + '.bin'));
      fs.unlinkSync(path.join(UPLOAD_DIR, delId + '.meta'));
    } catch (e) { /* 已不存在也算成功 */ }
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- API：上传（裸二进制主体） ---------------- */
  if (req.method === 'POST' && p === '/api/upload') {
    var rawName = parsed.searchParams.get('name') || 'score';
    // 仅保留可打印字符，避免文件名里塞路径/控制字符
    var name = String(rawName).replace(/[^\w.\-\u4e00-\u9fa5 ()\[\]]{1,200}/g, '').slice(0, 200) || 'score';
    var ctype = (req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    var newId = crypto.randomBytes(12).toString('hex');
    var chunks = [];
    var size = 0;
    var aborted = false;

    req.on('data', function (c) {
      if (aborted) return;
      size += c.length;
      if (size > MAX_UPLOAD) {
        aborted = true;
        req.destroy();
        try { fs.unlinkSync(path.join(UPLOAD_DIR, newId + '.bin')); } catch (e) {}
        try { fs.unlinkSync(path.join(UPLOAD_DIR, newId + '.meta')); } catch (e) {}
        sendJson(res, 413, { error: '文件超过 80MB 上限' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (aborted) return;
      var buf = Buffer.concat(chunks);
      fs.writeFileSync(path.join(UPLOAD_DIR, newId + '.bin'), buf);
      var m = { id: newId, name: name, type: ctype, size: size, ts: Date.now() };
      fs.writeFileSync(path.join(UPLOAD_DIR, newId + '.meta'), JSON.stringify(m));
      sendJson(res, 200, m);
    });
    req.on('error', function () {
      if (aborted) return;
      try { fs.unlinkSync(path.join(UPLOAD_DIR, newId + '.bin')); } catch (e) {}
      try { fs.unlinkSync(path.join(UPLOAD_DIR, newId + '.meta')); } catch (e) {}
      res.destroy();
    });
    return;
  }

  /* ---------------- PWA 分享目标：安卓系统「分享」直接发文件过来 ----------------
   * 手机上在 B站/微信/文件管理器里点「分享」→ 选已安装的 ScoreTurner，
   * 系统以 multipart/form-data POST 到这里；服务器收下文件后 303 跳回
   * /?shared=<id>，前端看到参数就地导入 —— 全程不落地到相册/下载。
   * ---------------------------------------------------------------------- */
  if (req.method === 'POST' && p === '/share-target') {
    var stChunks = [];
    var stSize = 0;
    var stAborted = false;
    req.on('data', function (c) {
      if (stAborted) return;
      stSize += c.length;
      if (stSize > MAX_UPLOAD) {
        stAborted = true;
        req.destroy();
        res.writeHead(413); return res.end('too large');
      }
      stChunks.push(c);
    });
    req.on('end', function () {
      if (stAborted) return;
      var buf = Buffer.concat(stChunks);
      var ctype = req.headers['content-type'] || '';
      var saved = [];
      if (/multipart\/form-data/i.test(ctype)) {
        parseMultipart(buf, ctype).forEach(function (part) {
          var fname = dispositionParam(part.head, 'filename');
          if (!fname) return; // 没有 filename 的部分不是文件（title/text/url 等字段）
          var ptype = (/content-type:\s*([^\r\n]+)/i.exec(part.head) || [])[1];
          saved.push(saveInbox(fname, (ptype || '').trim() || 'application/octet-stream', part.data));
        });
      } else {
        // 某些分享者直接给裸文件流
        saved.push(saveInbox('shared-score', ctype.split(';')[0] || 'application/octet-stream', buf));
      }
      if (!saved.length) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('没有收到文件');
      }
      // 跳回应用首页并带上 id，前端自动导入
      res.writeHead(303, { Location: '/?shared=' + saved.map(function (m) { return m.id; }).join(',') });
      res.end();
    });
    req.on('error', function () { if (!stAborted) res.destroy(); });
    return;
  }

  /* ---------------- API：粘贴链接代抓（后端去下载，手机不落盘） ---------------- */
  if (req.method === 'POST' && p === '/api/fetch-url') {
    var target = parsed.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) {
      return sendJson(res, 400, { error: '链接必须以 http:// 或 https:// 开头' });
    }
    fetchUrlToInbox(target, 0, function (err, meta) {
      if (err) return sendJson(res, err.status || 500, { error: err.message });
      sendJson(res, 200, meta);
    });
    return;
  }

  /* ---------------- file_handlers：「用其他应用打开」通道 ----------------
   * 安卓装成应用后，系统「打开方式」里会列出 ScoreTurner。
   * 这里只负责把页面交给前端（index.html），真正的文件由前端的
   * launchQueue 接管，无需后端参与。
   * ---------------------------------------------------------------------- */
  if (req.method === 'GET' && p === '/open-file') {
    return fs.readFile(path.join(ROOT, 'index.html'), function (err, buf) {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  }

  /* ---------------- 静态托管（白名单，禁止穿越/泄露内部文件） ---------------- */
  if (p.indexOf('/api/') === 0 || p.indexOf('/uploads') === 0) {
    res.writeHead(403); return res.end('forbidden');
  }
  var rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!staticAllowed(rel)) {
    res.writeHead(404); return res.end('not found');
  }
  var filePath = path.normalize(path.join(ROOT, rel));
  // 双重保险：解析后必须仍落在 ROOT 内，且不能是 ROOT 自身（防止 /.bin 之类）
  if (filePath !== ROOT && filePath.indexOf(ROOT + path.sep) !== 0) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('ScoreTurner server listening on ' + PORT);
});

// 供测试 require（tests/sharetarget.test.js）；直接 node server.js 行为不变
module.exports = server;
