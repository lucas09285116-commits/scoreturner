/**
 * modules/barNumberRead.js
 * ---------------------------------------------------------------------------
 * 从 PDF 的「文字层」读取谱面上印的小节号，自动完成编号对齐——
 * 这是让「跳到 70 就落到谱面第 70 格」彻底免手动的关键一步。
 *
 * 真实吉他六线谱（Guitar Pro 导出）的小节号特征：
 *   · 印在页面顶部一条横跨整页宽度的「标尺」上，每个小节一个数字（如 17,18,19,20…）；
 *   · 标尺所有数字落在「同一条水平线」（同一 ny）上、连续递增；
 *   · 六线谱品格数字（0/1/2/4/5…）散布在各谱表的六根弦线上，高度各不相同，
 *     且很难连成 ≥4 的连续串；顶部偶尔还有反复记号的 "1."/"2." 标签。
 * 做法：在顶部区域（ny≥0.86）收集整数，沿「值+1」方向延伸，要求每个后继数字都落在
 * 与起点「同一水平线（ny 相差 ≤0.02）」上——这就是标尺；多个候选取「最长且最高的一条线」。
 *
 * 不做 OCR、不碰像素：图片（扫描件）没有文字层，直接返回 null，回退到手动对齐。
 * 任何不确定都返回 null，绝不乱填——宁可让用户手填，也不把整首曲子带偏。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  /* ======================= 旧启发式（退化 / 兜底） ======================= */
  // 左栏最靠上最左的整数——只适用于小节号印在左侧栏的乐谱；六线谱会因品格数字而失效。
  async function readPageBarNumbers(source, pageIndex) {
    if (!source || source.kind !== 'pdf' || typeof source.textContent !== 'function') return null;
    try {
      var sz = await source.size(pageIndex);
      var tc = await source.textContent(pageIndex);
      var items = (tc && tc.items) || [];
      var W = (sz && sz.w) || 1, H = (sz && sz.h) || 1;
      var cand = [];
      items.forEach(function (it) {
        var s = (it.str || '').trim();
        if (!/^\d{1,3}(\.)?$/.test(s)) return;
        var t = it.transform;
        if (!t || t.length < 6) return;
        var nx = t[4] / W, ny = t[5] / H;
        if (nx > 0.35) return;
        if (ny < 0.5) return;
        cand.push({ x: nx, y: ny, v: parseInt(s.replace(/\.$/, ''), 10) });
      });
      if (!cand.length) return null;
      var topY = Math.max.apply(null, cand.map(function (c) { return c.y; }));
      var top = cand.filter(function (c) { return c.y >= topY - 0.06; });
      top.sort(function (a, b) { return a.x - b.x; });
      var v = top[0].v;
      if (!(v > 0 && v < 1000)) return null;
      return v;
    } catch (e) {
      return null;
    }
  }

  /* ======================= 顶部标尺（主算法） ======================= */
  /**
   * 读「本页顶部的小节号标尺」：返回 { start, count } 或 null。
   *  - start：标尺最小号 = 本页第一格谱面印刷号
   *  - count：标尺连续整数个数 = 本页小节数（标尺每格标一个小节号）
   * 找不到连续 ≥4 格的标尺（如页面顶部无标尺、或只有 1~3 格）时返回 null，
   * 交给跨页投票或手动补——绝不把品格号/反复记号误当成小节号。
   */
  async function readPageRuler(source, pageIndex) {
    if (!source || source.kind !== 'pdf' || typeof source.textContent !== 'function') return null;
    try {
      var sz = await source.size(pageIndex);
      var tc = await source.textContent(pageIndex);
      var items = (tc && tc.items) || [];
      var W = (sz && sz.w) || 1, H = (sz && sz.h) || 1;
      // 收集顶部区域整数：value -> 出现过的所有高度（ny 自底向上，越大越靠上）
      var nyList = {};
      items.forEach(function (it) {
        var s = (it.str || '').trim();
        if (!/^\d{1,3}(\.)?$/.test(s)) return;          // 纯整数（可带尾点 "1."）
        var t = it.transform;
        if (!t || t.length < 6) return;
        var ny = t[5] / H;
        if (ny < 0.86) return;                          // 只要顶部区域（小节号标尺所在高度）
        var v = parseInt(s.replace(/\.$/, ''), 10);
        if (!(v > 0 && v < 1000)) return;
        (nyList[v] = nyList[v] || []).push(ny);
      });
      var vals = Object.keys(nyList).map(Number).sort(function (a, b) { return a - b; });
      if (!vals.length) return null;

      // 对每个整数 v 作为起点，沿 +1 方向延伸，要求每个后继整数都存在一条
      // 与起点「同一水平线（高度差 ≤ 0.02）」的数字——这就是标尺。
      // 标尺永远是页面「最高」的那条水平数字线：高度优先，其次长度。
      var best = null, bestLen = 0, bestY = -1;
      vals.forEach(function (v) {
        var y0 = Math.max.apply(null, nyList[v]);        // 锚定到该值出现的最高高度
        var cur = v, len = 0;
        while (nyList[cur] && nyList[cur].some(function (y) { return Math.abs(y - y0) <= 0.02; })) {
          len++; cur++;
        }
        if (len < 3) return;                            // 太短，不像标尺（多半是品格号串）
        if (y0 > bestY || (y0 === bestY && len > bestLen)) { bestY = y0; bestLen = len; best = v; }
      });
      if (best === null) return null;
      return { start: best, count: bestLen };
    } catch (e) {
      return null;
    }
  }

  /**
   * 读「本页第一格谱面印刷号」的置信值（即顶部标尺的最小号）。
   * 找不到连续 ≥4 格的标尺时返回 null，交给跨页投票或手动补。
   */
  async function readPageBarStart(source, pageIndex) {
    var r = await readPageRuler(source, pageIndex);
    return r ? r.start : null;
  }

  /* ======================= 跨页投票求解 ======================= */
  // 单页"最靠上的整数"极可能抓到品格号。硬约束：若全曲起始号是 s0，则第 p 页起始 = s0 + 前面各页格数之和。
  // 对每个 (页, 候选号) 投票 s0，正确起始号会得到多页一致印证，噪声各投各的散票。

  /** 读一页所有"可能是小节号"的整数（放宽：左栏、排除页脚，含下方谱表；去重） */
  async function readPageBarCandidates(source, pageIndex) {
    if (!source || source.kind !== 'pdf' || typeof source.textContent !== 'function') return [];
    try {
      var sz = await source.size(pageIndex);
      var tc = await source.textContent(pageIndex);
      var items = (tc && tc.items) || [];
      var W = (sz && sz.w) || 1, H = (sz && sz.h) || 1;
      var seen = {}, out = [];
      items.forEach(function (it) {
        var s = (it.str || '').trim();
        if (!/^\d{1,3}(\.)?$/.test(s)) return;
        var t = it.transform;
        if (!t || t.length < 6) return;
        var nx = t[4] / W, ny = t[5] / H;
        if (nx > 0.35) return;
        if (ny < 0.30 || ny > 0.98) return;
        var v = parseInt(s.replace(/\.$/, ''), 10);
        if (!(v > 0 && v < 1000)) return;
        if (seen[v]) return;
        seen[v] = 1;
        out.push(v);
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  /** 投票解全局起始号（配合 readPageBarCandidates）。candidates[p]=第p页候选号数组 */
  function solveStarts(candidates, counts) {
    counts = counts || [];
    var prefix = [0], i;
    for (i = 0; i < counts.length; i++) prefix.push(prefix[i] + (counts[i] || 0));
    var votes = {}, order = [];
    (candidates || []).forEach(function (cand, p) {
      (cand || []).forEach(function (c) {
        var s0 = c - prefix[p];
        if (!(s0 > 0)) return;
        if (!votes[s0]) { votes[s0] = 0; order.push(s0); }
        votes[s0]++;
      });
    });
    var best = null, bestN = 0;
    order.forEach(function (s0) { if (votes[s0] > bestN) { best = s0; bestN = votes[s0]; } });
    if (!best || bestN < 2) return null;
    var starts = [];
    for (i = 0; i < counts.length; i++) starts.push(best + prefix[i]);
    return { starts: starts, votes: bestN };
  }

  /** 投票解全局起始号（配合 readPageBarStart）：starts[p]=第p页起始号（下标=页码，null=读不到） */
  function solveStartsFromStarts(starts, counts) {
    counts = counts || [];
    var prefix = [0], i;
    for (i = 0; i < counts.length; i++) prefix.push(prefix[i] + (counts[i] || 0));
    var votes = {}, order = [];
    (starts || []).forEach(function (s, p) {
      if (typeof s !== 'number' || !(s > 0)) return;
      var s0 = s - prefix[p];
      if (!(s0 > 0)) return;
      if (!votes[s0]) { votes[s0] = 0; order.push(s0); }
      votes[s0]++;
    });
    var best = null, bestN = 0;
    order.forEach(function (s0) { if (votes[s0] > bestN) { best = s0; bestN = votes[s0]; } });
    if (!best || bestN < 2) return null;
    var out = [];
    for (i = 0; i < counts.length; i++) out.push(best + prefix[i]);
    return { starts: out, votes: bestN };
  }

  /* ======================= 单一合并导出 ======================= */
  ST.BarNumberRead = {
    readPageBarNumbers: readPageBarNumbers,
    readPageBarCandidates: readPageBarCandidates,
    solveStarts: solveStarts,
    readPageRuler: readPageRuler,
    readPageBarStart: readPageBarStart,
    solveStartsFromStarts: solveStartsFromStarts
  };
})(typeof window !== 'undefined' ? window : globalThis);
