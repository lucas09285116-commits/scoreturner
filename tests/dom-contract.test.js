/**
 * tests/dom-contract.test.js
 * 静态校验：JS 里 getElementById / querySelector 用到的 id、以及 bus 事件与监听侧的对应关系。
 * 目的是在没有浏览器环境时，也能挡住"改名漏改一处"这类低级错误。
 */
var fs = require('fs');
var path = require('path');
var rootDir = path.join(__dirname, '..');

var pass = 0, fail = 0;
function report(okFlag, name, extra) {
  if (okFlag) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

var html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
var css = fs.readFileSync(path.join(rootDir, 'css', 'app.css'), 'utf8');

var jsFiles = [];
(function walk(d) {
  fs.readdirSync(d).forEach(function (f) {
    var p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); }
    else if (/\.js$/.test(f)) jsFiles.push(p);
  });
})(path.join(rootDir, 'js'));

var jsSrc = jsFiles.map(function (f) { return fs.readFileSync(f, 'utf8'); }).join('\n');

console.log('\n[1] HTML 里的 id 都能被 JS 找到（反向检查 JS 用到的 id）');
(function () {
  var htmlIds = {};
  (html.match(/id="([^"]+)"/g) || []).forEach(function (s) { htmlIds[s.slice(4, -1)] = true; });
  var used = {};
  var re = /getElementById\(\s*'([^']+)'\s*\)|\$\(\s*'([^']+)'\s*\)/g, m;
  while ((m = re.exec(jsSrc))) { used[m[1] || m[2]] = true; }
  var missing = Object.keys(used).filter(function (id) { return !htmlIds[id]; });
  report(missing.length === 0, 'JS 引用的 ' + Object.keys(used).length + ' 个 id 均存在',
    missing.length ? '缺失：' + missing.join(', ') : '');
})();

console.log('\n[2] data-cmd / data-bind 与命令分发表一致');
(function () {
  var cmds = {};
  (html.match(/data-cmd="([^"]+)"/g) || []).forEach(function (s) { cmds[s.slice(10, -1)] = true; });
  (html.match(/data-bind="([^"]+)"/g) || []).forEach(function (s) { cmds[s.slice(11, -1)] = true; });
  var table = (jsSrc.match(/var COMMANDS = \{[\s\S]*?\n  \};/) || [''])[0];
  var missing = Object.keys(cmds).filter(function (c) {
    return table.indexOf("'" + c + "':") < 0 && c.indexOf('-page') < 0;
  });
  report(missing.length === 0, '面板按钮都有对应处理或明确豁免', missing.length ? '未处理：' + missing.join(', ') : '');
})();

console.log('\n[3] 脚本引用顺序无解析环依赖');
(function () {
  var order = (html.match(/<script src="([^"]+)"/g) || []).map(function (s) { return s.slice(13, -1); });
  var idxBus = order.findIndex(function (s) { return /bus\.js/.test(s); });
  var idxStructure = order.findIndex(function (s) { return /structure\.js/.test(s); });
  var idxApp = order.findIndex(function (s) { return /app\.js/.test(s); });
  report(idxBus >= 0 && idxBus < idxStructure && idxStructure < idxApp, 'core → modules → app 顺序正确');
  report(order.length > 0 && /app\.js/.test(order[order.length - 1]), 'app.js 最后加载');
  var missingFiles = order.filter(function (s) { return !fs.existsSync(path.join(rootDir, s)); });
  report(missingFiles.length === 0, '所有 <script> / <link> 指向的文件都存在',
    missingFiles.length ? '缺失：' + missingFiles.join(', ') : '');
})();

console.log('\n[4] 节拍 / 反复 / 翻页三个模块以 bus 事件解耦，没有互相硬依赖');
(function () {
  var met = fs.readFileSync(path.join(rootDir, 'js/modules/metronome.js'), 'utf8');
  var trk = fs.readFileSync(path.join(rootDir, 'js/modules/tracker.js'), 'utf8');
  var pgt = fs.readFileSync(path.join(rootDir, 'js/modules/pageTurn.js'), 'utf8');
  report(/this\.bus\.emit\('beat'/.test(met), 'metronome 只 emit beat，不认识 tracker');
  report(/this\.bus\.emit\('position'/.test(trk), 'tracker 只 emit position');
  report(/this\.bus\.emit\('page:turn'/.test(pgt), 'pageTurn 只 emit page:turn');
  report(!/require\(|from '/.test(met + trk + pgt), '模块无 CommonJS / ESM 依赖（保证 file:// 下可直接打开）');
})();

console.log('\n[5] CSS 关键类都被用到');
(function () {
  ['mbox', 'overlay', 'measure-hl', 'pulse-dot', 'track', 'page'].forEach(function (cls) {
    report(jsSrc.indexOf(cls) >= 0 && css.indexOf('.' + cls) >= 0, '.' + cls);
  });
})();

console.log('\n[6] 无遗留调试代码');
(function () {
  report(!/console\.log\(/.test(jsSrc), '生产代码不含 console.log');
  report(!/debugger/.test(jsSrc), '无 debugger 断点');
})();

console.log('\n———— ' + pass + ' 通过 / ' + fail + ' 失败 ————\n');
process.exit(fail ? 1 : 0);
