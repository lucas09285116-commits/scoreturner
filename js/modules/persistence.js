/**
 * modules/persistence.js
 * 乐谱的"页面的像素"来自用户本地文件（不入库），入库的只有**标记出来的结构**：
 * 小节坐标、反复/跳房子、拍号、BPM、翻页参数。
 * 这样重新导入同一份文件时能自动恢复，也不会把几十 MB 塞进 localStorage。
 */
(function (root) {
  var ST = (root.ST = root.ST || {});
  var KEY = 'scoreturner:projects';

  function readAll() {
    try { return JSON.parse(root.localStorage.getItem(KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function writeAll(o) {
    try { root.localStorage.setItem(KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }

  /**
   * 决定"这次导入能否沿用上次保存的小节框"（纯函数，便于单测）。
   *
   * 三条规则：
   *  ① 自带小节坐标的示例乐谱优先；
   *  ② 识别算法升级过（存档 detectVer ≠ 当前版本）→ 旧框一律作废，必须重新识别。
   *     否则用户重新导入同一份谱子会永远看到旧算法的错误框（"一格被切成两格"），
   *     以为修复没生效——这正是"改好了却还看见老问题"的根因；
   *  ③ 上次只随手划了几个框（平均每页不足 4 个）→ 视为半截标记，重新识别。
   *
   * @param saved     Persistence.load() 的结果（可为 null）
   * @param currentVer 当前识别算法版本 ST.BarlineDetect.VERSION
   * @param builtin   乐谱自带的小节（示例乐谱）
   * @param pageCount 页数
   * @returns {{use:Array, stale:number|null, verStale:boolean}}
   */
  function measuresUsable(saved, currentVer, builtin, pageCount) {
    if (builtin && builtin.length) return { use: builtin, stale: null, verStale: false };
    var list = (saved && saved.measures) || [];
    if (!list.length) return { use: [], stale: null, verStale: false };
    if (saved.detectVer !== currentVer) return { use: [], stale: null, verStale: true };
    var minSane = Math.min(8, (pageCount || 0) * 4);
    if (list.length < minSane) return { use: [], stale: list.length, verStale: false };
    return { use: list, stale: null, verStale: false };
  }

  ST.Persistence = {
    measuresUsable: measuresUsable,
    save: function (state) {
      if (!state.score) return false;
      var all = readAll();
      all[state.score.id] = {
        v: 1,
        // 小节线识别算法版本：升级后旧框作废（见 barlineDetect.js 的 DETECT_VERSION）
        detectVer: (ST.BarlineDetect && ST.BarlineDetect.VERSION) || 0,
        at: Date.now(),
        name: state.score.name,
        pages: state.score.pages,
        measures: state.score.measures,
        pageStarts: state.pageStarts || [],
        transport: { bpm: state.transport.bpm, timeSig: state.transport.timeSig, compound: state.transport.compound },
        turn: state.turn,
        repeat: state.repeat,
        input: state.input
      };
      return writeAll(all);
    },
    load: function (scoreId) {
      var all = readAll();
      return all[scoreId] || null;
    },
    forget: function (scoreId) {
      var all = readAll();
      delete all[scoreId];
      writeAll(all);
    },
    clear: function () { writeAll({}); },
    download: function (state) {
      var data = JSON.stringify({
        v: 1,
        detectVer: (ST.BarlineDetect && ST.BarlineDetect.VERSION) || 0,
        name: state.score ? state.score.name : '未命名',
        pages: state.score ? state.score.pages : [],
        measures: state.score ? state.score.measures : [],
        pageStarts: state.pageStarts || [],
        transport: { bpm: state.transport.bpm, timeSig: state.transport.timeSig, compound: state.transport.compound },
        turn: state.turn,
        repeat: state.repeat,
        input: state.input
      }, null, 2);
      var blob = new Blob([data], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.score ? state.score.name.replace(/\.[^.]+$/, '') : 'score') + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
