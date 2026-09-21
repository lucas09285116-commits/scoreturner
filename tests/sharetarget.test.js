/**
 * tests/sharetarget.test.js —— PWA 分享目标 + 链接代抓 端到端测试
 * 纯 Node 运行（无需浏览器）：
 *   PORT=0 node tests/sharetarget.test.js
 * 覆盖：
 *   1) 静态白名单新增文件可访问（manifest / sw.js / 图标）
 *   2) POST /share-target（multipart，模拟安卓系统分享）→ 303 → /?shared=id
 *      → 收件箱可列出、可下载，内容一致
 *   3) POST /api/fetch-url 非法链接 → 400
 */
'use strict';
var path = require('path');
var http = require('http');
var crypto = require('crypto');

process.env.PORT = '0'; // 随机端口
var server = require(path.join(__dirname, '..', 'server.js'));

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

server.on('listening', function () {
  var PORT = server.address().port;
  console.log('test server on ' + PORT);
  run(PORT).then(function () {
    server.close();
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  });
});

function request(method, urlPath, body, headers) {
  return new Promise(function (resolve, reject) {
    var req = http.request({
      host: '127.0.0.1', port: PORT_SENTINEL.p, method: method, path: urlPath,
      headers: headers || {}
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
var PORT_SENTINEL = { p: 0 };

async function run(port) {
  PORT_SENTINEL.p = port;

  /* 1. 静态白名单 */
  var m = await request('GET', '/manifest.webmanifest');
  ok(m.status === 200 && /share_target/.test(m.buf.toString('utf8')), 'manifest.webmanifest 可访问且含 share_target');
  var sw = await request('GET', '/sw.js');
  ok(sw.status === 200 && /serviceWorker|addEventListener/.test(sw.buf.toString('utf8')), 'sw.js 可访问');
  var ic = await request('GET', '/icon-192.png');
  ok(ic.status === 200 && ic.buf.length > 1000, 'icon-192.png 可访问 (' + ic.buf.length + 'B)');
  var secret = await request('GET', '/package.json');
  ok(secret.status === 404, 'package.json 仍被屏蔽（404）');

  /* 2. 模拟安卓系统分享：multipart POST /share-target */
  var boundary = '----STTestBoundary' + crypto.randomBytes(4).toString('hex');
  var fileBytes = crypto.randomBytes(2048); // 假装是一份 PDF
  var part = Buffer.concat([
    Buffer.from('--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="scores"; filename="二十二 吉他谱.pdf"\r\n' +
      'Content-Type: application/pdf\r\n\r\n'),
    fileBytes,
    Buffer.from('\r\n--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="title"\r\n\r\nB站买的谱子\r\n' +
      '--' + boundary + '--\r\n')
  ]);
  var st = await request('POST', '/share-target', part, {
    'Content-Type': 'multipart/form-data; boundary=' + boundary
  });
  var loc = st.headers.location || '';
  ok(st.status === 303 && /^\/\?shared=[a-f0-9]+$/.test(loc), 'share-target 返回 303 且 Location=/ ?shared=<id>（实际: ' + st.status + ' ' + loc + '）');

  var list = JSON.parse((await request('GET', '/api/files')).buf.toString('utf8'));
  var hit = (list.files || []).find(function (f) { return f.name === '二十二 吉他谱.pdf'; });
  ok(!!hit, '收件箱里出现分享的文件（中文名完好）');
  if (hit) {
    var dl = await request('GET', '/api/files/' + hit.id);
    ok(dl.status === 200 && dl.buf.length === fileBytes.length && dl.buf.equals(fileBytes), '下载回的字节与分享的完全一致');
    var del = await request('DELETE', '/api/files/' + hit.id);
    ok(del.status === 200, '清理测试文件');
  }

  /* 3. 链接代抓：非法输入 */
  var bad = await request('POST', '/api/fetch-url?url=' + encodeURIComponent('ftp://x'));
  ok(bad.status === 400, 'fetch-url 拒绝非 http(s) 链接（400）');
  var noUrl = await request('POST', '/api/fetch-url');
  ok(noUrl.status === 400, 'fetch-url 拒绝空链接（400）');
}
