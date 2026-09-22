/**
 * modules/barlineDetect.js
 * ---------------------------------------------------------------------------
 * 轻量级小节线检测（不引第三方库、不联网、不 OCR）：
 *
 *   ① 行投影：横向数暗像素，横跨整页宽度的行 = 谱线（五线谱 5 条 / 六线谱 6 条）
 *   ② 谱线聚类成"行系统"（notation + tab 双谱表会被并成同一行，正是我们要的）
 *   ③ 在该行的 y 区间内做列投影：贯穿整个谱表高度的窄竖线 = 小节线
 *   ④ 相邻两条小节线之间 = 一个小节；首/尾的双竖线按"行首/行尾"启发式标为反复
 *
 * 只做几何识别，不做音符识别——所以它速度快、离线可用，也足够回答
 * "这一页有几个小节、每一格在哪"这两个决定翻页的关键问题。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function loadImage(dataUrl) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('图像解码失败')); };
      im.src = dataUrl;
    });
  }

  /**
   * 谱线组里可能混进房子括线、连谱号等"不是谱表线"的横线。
   * 谱表的特征是**等间距**，所以保留最长的一段等间距线。
   */
  function keepEvenlySpaced(list) {
    if (list.length < 3) return list;
    var gaps = [];
    for (var i = 1; i < list.length; i++) gaps.push(list[i] - list[i - 1]);
    var modal = gaps.slice().sort(function (a, b) { return a - b; })[Math.floor(gaps.length / 2)] || 1;
    var tol = Math.max(2, modal * 0.35);
    var best = [list[0]], cur = [list[0]];
    for (i = 1; i < list.length; i++) {
      if (Math.abs((list[i] - list[i - 1]) - modal) <= tol) cur.push(list[i]);
      else cur = [list[i]];
      if (cur.length > best.length) best = cur;
    }
    return best;
  }

  function collectBars(maxRun, w, need, maxWd) {
    var bars = [], run = null;
    for (var x = 0; x < w; x++) {
      if (maxRun[x] >= need) { if (!run) run = { a: x, b: x }; else run.b = x; }
      else if (run) {
        var wd = run.b - run.a + 1;
        if (wd <= maxWd) bars.push({ x: Math.round((run.a + run.b) / 2), wd: wd });
        run = null;
      }
    }
    if (run) {
      var wd2 = run.b - run.a + 1;
      if (wd2 <= maxWd) bars.push({ x: Math.round((run.a + run.b) / 2), wd: wd2 });
    }
    return bars;
  }

  /**
   * 像素路径的「反复圆点」检测：在双竖线两根线的缝隙里找近似方形的小实心点。
   * 与矢量路径同一语义（见 detectFromVecPrimitives ⑤）：缝隙里有圆点 → 反复线(|: :|)；
   * 没有 → 段落终止线，绝不标反复。在此修复之前，像素路径把任何双竖线都当反复，
   * 扫描版吉他谱的终止线会导致演奏错误回跳（与《二十二》矢量路径同款 bug）。
   *
   * 实现：在缝隙矩形 [gapX0,gapX1]×[top,bot] 内做 4-连通域标记，
   * 圆点特征 = 宽高都落在 [6%谱表高, 35%谱表高]、宽高比 ≤2.2、且上下不贴谱表带边缘
   * （贴边的是竖线残留/谱线本身，不是圆点）。
   */
  function hasRepeatDot(dark, w, gapX0, gapX1, top, bot, staffH) {
    // 只搜缝隙"内侧"：左右各让出 2px，避开两根竖线本身。
    // 否则抗锯齿会让圆点与竖线连成同一连通域，包围盒被拉成整条竖线 → 判不出来。
    var gx0 = Math.max(0, Math.round(gapX0) + 2), gx1 = Math.min(w - 1, Math.round(gapX1) - 2);
    var gw = gx1 - gx0 + 1, gh = bot - top + 1;
    if (gw <= 0 || gh <= 0) return false;
    var minD = Math.max(2.5, staffH * 0.05);
    var maxD = staffH * 0.35;
    var seen = new Uint8Array(gw * gh);
    var stack = [];
    for (var sy = 0; sy < gh; sy++) {
      for (var sx = 0; sx < gw; sx++) {
        var si = sy * gw + sx;
        if (seen[si] || !dark[(top + sy) * w + gx0 + sx]) continue;
        // 泛洪收集一个连通域，同时记录包围盒
        var minX = sx, maxX = sx, minY = sy, maxY = sy;
        stack.length = 0; stack.push(si); seen[si] = 1;
        while (stack.length) {
          var cur = stack.pop();
          var cx = cur % gw, cy = (cur - cx) / gw;
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          // 四邻居（在缝隙窗口内）
          if (cx > 0 && !seen[cur - 1] && dark[(top + cy) * w + gx0 + cx - 1]) { seen[cur - 1] = 1; stack.push(cur - 1); }
          if (cx < gw - 1 && !seen[cur + 1] && dark[(top + cy) * w + gx0 + cx + 1]) { seen[cur + 1] = 1; stack.push(cur + 1); }
          if (cy > 0 && !seen[cur - gw] && dark[(top + cy - 1) * w + gx0 + cx]) { seen[cur - gw] = 1; stack.push(cur - gw); }
          if (cy < gh - 1 && !seen[cur + gw] && dark[(top + cy + 1) * w + gx0 + cx]) { seen[cur + gw] = 1; stack.push(cur + gw); }
        }
        var bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw >= minD && bh >= minD && bw <= maxD && bh <= maxD &&
            bw / bh <= 2.2 && bh / bw <= 2.2 &&
            minY > 0 && maxY < gh - 1) return true;
      }
    }
    return false;
  }

  /**
   * @returns {Promise<{measures:Array, rows:number, doubles:number}>}
   * measures: [{ x, y, w, h, repeatStart?, repeatEnd? }]，坐标已归一化 0~1
   */
  async function detectPage(source, pageIndex, opts) {
    opts = opts || {};
    var targetW = opts.targetWidth || 1500;
    var out = await source.render(pageIndex, targetW);
    var im = await loadImage(out.dataUrl);
    var w = im.naturalWidth || out.w, h = im.naturalHeight || out.h;
    if (!w || !h) return { measures: [], rows: 0, doubles: 0 };

    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;

    /* 灰度 + 自适应阈值 */
    var n = w * h;
    var lum = new Uint8Array(n);
    var sum = 0;
    for (var k = 0, p = 0; k < n; k++, p += 4) {
      var l = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
      lum[k] = l; sum += l;
    }
    var thr = Math.max(70, Math.min(190, (sum / n) * 0.78));
    var dark = new Uint8Array(n);
    for (k = 0; k < n; k++) dark[k] = lum[k] < thr ? 1 : 0;

    /* ① 行投影 → 谱线 */
    var rowCount = new Int32Array(h);
    for (var y = 0; y < h; y++) {
      var c = 0, base = y * w;
      for (var x = 0; x < w; x++) if (dark[base + x]) c++;
      rowCount[y] = c;
    }
    var minRow = w * 0.35;
    var lines = [], run = null;
    for (y = 0; y < h; y++) {
      if (rowCount[y] >= minRow) { if (!run) run = { a: y, b: y }; else run.b = y; }
      else if (run) { lines.push(Math.round((run.a + run.b) / 2)); run = null; }
    }
    if (run) lines.push(Math.round((run.a + run.b) / 2));

    /* ② 谱线 → 行系统 */
    var systems = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      // 注意：比较对象是"当前这一组的最后一条线"，不是 lines 数组同下标的那个元素
      if (cur && lines[i] - cur[cur.length - 1] <= (opts.maxLineGap || 34)) cur.push(lines[i]);
      else { cur = [lines[i]]; systems.push(cur); }
    }
    systems = systems.filter(function (s) { return s.length >= 3; });

    /* ③ 每行内找"贯穿整条谱表的连续竖线" = 小节线 */
    var measures = [], doubles = 0, rowInfo = [];
    systems.forEach(function (s, rowIdx) {
      /**
       * 系统内先按"间隙 ≤ 1.7×局部中位行距"切成子谱表，每段各自做等间距过滤，
       * 但**保留所有子谱表**（TAB+五线谱 / TAB+人声单线谱 都是多子谱表系统）。
       * 之前直接对整组做 keepEvenlySpaced 会把人声线/另一张谱表砍掉，
       * 谱带只剩 TAB → 符干、琶音箭头（高达 90% 谱高）全被当成小节线。
       */
      var sub = [], csub = null;
      for (var li = 0; li < s.length; li++) {
        if (csub) {
          var lgs = [];
          for (var k2 = 1; k2 < csub.length; k2++) lgs.push(csub[k2] - csub[k2 - 1]);
          var lmed = lgs.slice().sort(function (a, b) { return a - b; })[Math.floor(lgs.length / 2)] || 1;
          if (s[li] - csub[csub.length - 1] <= Math.max(22, lmed * 1.7)) { csub.push(s[li]); continue; }
        }
        csub = [s[li]]; sub.push(csub);
      }
      // 保留 ≥3 线的真谱表；再回贴"紧贴其后的单线谱"（人声线，≤3.2d）
      var kept = sub.map(keepEvenlySpaced).filter(function (x) { return x.length >= 3; });
      var dEst = 14;
      if (kept.length) {
        var dAll = [];
        kept.forEach(function (x) { for (var q = 1; q < x.length; q++) dAll.push(x[q] - x[q - 1]); });
        if (dAll.length) dEst = dAll.slice().sort(function (a, b) { return a - b; })[Math.floor(dAll.length / 2)] || 14;
      }
      sub.forEach(function (x) {
        if (x.length >= 3 || !kept.length) return;
        var lastKept = kept[kept.length - 1];
        if (x[0] > lastKept[lastKept.length - 1] && x[0] - lastKept[lastKept.length - 1] <= Math.max(45, dEst * 3.2)) kept.push(x);
      });
      var lines2 = [];
      kept.forEach(function (x) { lines2 = lines2.concat(x); });
      lines2.sort(function (a, b) { return a - b; });
      if (lines2.length < 3) return;
      var staffTop = lines2[0], staffBot = lines2[lines2.length - 1];
      var staffH = staffBot - staffTop;
      // 过低的行系统（歌词条/横梁拼出来的假谱表）直接丢掉：真谱表至少 4~5 条线高
      if (staffH < Math.max(30, dEst * 3)) return;
      var top = Math.max(0, staffTop - 4);
      var bot = Math.min(h - 1, staffBot + 4);

      // 每列的最长连续暗色纵向游程：小节线是整条不断，符干+符头只是短短一段
      var maxRun = new Int32Array(w);
      for (var xx = 0; xx < w; xx++) {
        var runLen = 0, best = 0;
        for (var yy = top; yy <= bot; yy++) {
          if (dark[yy * w + xx]) { runLen++; if (runLen > best) best = runLen; }
          else runLen = 0;
        }
        maxRun[xx] = best;
      }

      /**
       * 找"谱表间空隙"：谱内相邻线间距的中位数为 d，明显大于它（≥1.7d 且≥8px）的
       * 那个间隙就是双谱表系统里 TAB 与（五线谱/人声线）之间的空隙。
       * 真小节线会穿过这道空隙，而符干、琶音箭头只存在于单个谱表内 —— 这是把
       * 它们区分开的决定性判据（《Love Song》143 个假小节的根因）。
       */
      var gapA = null, gapB = null, bestGapPx = 0;
      if (lines2.length >= 4) {
        var gs = [];
        for (var gi = 1; gi < lines2.length; gi++) gs.push(lines2[gi] - lines2[gi - 1]);
        var gmed = gs.slice().sort(function (a, b) { return a - b; })[Math.floor(gs.length / 2)] || 1;
        for (gi = 1; gi < lines2.length; gi++) {
          var gp = lines2[gi] - lines2[gi - 1];
          if (gp > bestGapPx && gp >= Math.max(8, gmed * 1.7)) {
            bestGapPx = gp; gapA = lines2[gi - 1]; gapB = lines2[gi];
          }
        }
      }

      var maxWd = Math.max(6, staffH * 0.14);
      var bars = [], ratios = [0.9, 0.75, 0.6];
      for (var t = 0; t < ratios.length && bars.length < 2; t++) {
        bars = collectBars(maxRun, w, staffH * ratios[t], maxWd);
        // 穿隙校验：候选竖线必须在谱表间空隙那段也有暗像素，否则是符干/箭头
        if (gapA != null) {
          var ga = Math.max(top, gapA + 3), gb = Math.min(bot, gapB - 3);
          bars = bars.filter(function (b) {
            var n = 0, tot = 0;
            for (var y = ga; y <= gb; y++) {
              for (var xx = b.x - 1; xx <= b.x + 1; xx++) {
                if (xx < 0 || xx >= w) continue;
                tot++; if (dark[y * w + xx]) n++;
              }
            }
            return tot > 0 && (n / tot) >= 0.6;
          });
        }
      }
      if (bars.length < 2) return;

      /* ④ 把间距很近的竖线并成一组（细+细 / 细+粗 = 一条双竖线的两根，同一处边界）。
       *    并组间距不写死 16px：双谱表大谱表（五线谱+六线谱）的反复线两根离得更远，
       *    按谱表高度缩放并钳制到 [8,28]，避免大谱表上同一根双竖线被拆成两个边界
       *    产生"假 1px 小节"，也避免小谱表上相邻两条真小节线被误并。 */
      // 并组间距：要能容纳反复线/终止线两根之间的缝隙（常见 4~16px），
      // 又不能把两条真小节线（间距远大于此）并在一起
      var grpGap = Math.max(14, Math.min(30, staffH * 0.18));
      var groups = [];
      bars.forEach(function (b) {
        var last = groups[groups.length - 1];
        if (last && b.x - last.x1 <= grpGap) {
          last.x1 = b.x; last.n++; last.lastWd = b.wd;
          if (b.wd > last.maxWd) last.maxWd = b.wd;
        } else {
          groups.push({ x0: b.x, firstX: b.x, x1: b.x, n: 1, firstWd: b.wd, lastWd: b.wd, maxWd: b.wd });
        }
      });

      /**
       * 双竖线语义判定（与矢量路径 v4 同一规则）：一组(n>1)的缝隙里有反复圆点
       * 才是反复线(|: :|)；否则是段落终止线（final），绝不触发回溯。
       * 在此修复前，像素路径把任何双竖线都当反复——扫描版吉他谱里的终止线
       * 会让上层按顺序配对出假反复，演奏时错误跳回。
       */
      groups.forEach(function (g) {
        g.repeat = g.n > 1 && hasRepeatDot(dark, w, g.firstX, g.x1, top, bot, staffH);
      });

      var rowMeasures = 0, skippedNarrow = 0;
      var padY = 6;
      for (var j = 0; j < groups.length - 1; j++) {
        var x0 = groups[j].x1, x1 = groups[j + 1].x0;
        // 窄缝不是小节：双竖线两根之间 / 并组残留。阈值随谱高缩放（双谱表更宽）
        if (x1 - x0 < Math.max(20, Math.min(40, staffH * 0.3))) { skippedNarrow++; continue; }
        var gL = groups[j], gR = groups[j + 1];
        var lastIdx = j + 1 === groups.length - 1;   // 行尾的右边界才能算 :│
        var dblLeft = !!gL.repeat;
        var dblRight = !!(lastIdx && gR.repeat);
        if (dblLeft) doubles++;
        measures.push({
          x: x0 / w,
          y: Math.max(0, top - padY) / h,
          w: (x1 - x0) / w,
          h: (staffH + padY * 2) / h,
          doubleLeft: dblLeft,
          doubleRight: dblRight,
          finalLeft: gL.n > 1 && !dblLeft,          // 双竖线但无圆点 = 段落终止
          finalRight: lastIdx && gR.n > 1 && !dblRight,
          row: rowIdx,                              // 页内第几个谱表行（0 起，自上而下）
          index: rowMeasures                        // 页内第几格（0 起，自左向右）
        });
        rowMeasures++;
      }
      rowInfo.push({
        row: rowIdx, top: staffTop, bot: staffBot, bh: staffH,
        bounds: groups.length, measures: rowMeasures, skippedNarrow: skippedNarrow,
        repeats: groups.filter(function (g) { return g.repeat; }).length,
        bars: groups.map(function (g) {
          return g.x0 + (g.n > 1 ? '*' + g.n + (g.repeat ? ':rep' : ':fin') : '');
        })
      });
    });

    return {
      measures: measures,
      rows: systems.length,
      doubles: doubles,
      debug: {
        w: w, h: h, thr: Math.round(thr), lines: lines,
        systems: systems.map(function (s) { return [s[0], s[s.length - 1]]; }),
        rowInfo: rowInfo
      }
    };
  }

  /* ================================================================
   * 矢量小节线检测（PDF 专用）
   * ----------------------------------------------------------------
   * 像素投影会被水印打断、被品格数字干扰（用户真实《二十二》吉他谱
   * 出现过"两小节并成一格"）。而 PDF 的小节线是**真实的矢量图元**：
   *   - 小节线   = 矩形，宽≈2.5（w>=1.8 可排除和弦图的 1.2 宽竖线）
   *   - 系统起始线 = 全长线段，跨度>=200（长符干 <=157 被排除）
   *   - 同一小节线在五线谱段和六线谱段是两个矩形（y 带不重叠 → 合并）
   * 聚类成系统后：**y 范围互相重叠的系统必须合并**（双吉他的大谱表
   * 会被链式聚类拆成多个子簇，它们共享全长起始线所以必然重叠；
   * 相邻系统之间有明确空隙不会被误合并）。
   * 已在三份真实 PDF 上全页验证（伴奏 16,16,16,18,20 / Solo 24,28,26 /
   * 双吉他 12,12,12,12,14,12,12）。
   * ================================================================ */
  function matMul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }
  function applyM(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  // 从 operatorList 提取矩形、线段，以及「反复圆点」候选（跟踪 CTM 变换）
  function extractVecPrimitives(opList) {
    var OPS = root.pdfjsLib && root.pdfjsLib.OPS;
    // constructPath 的子操作码（与 pdf.js OPS 常量一致，含字面量兜底）
    var OP_MOVE = OPS ? OPS.moveTo : 13, OP_LINE = OPS ? OPS.lineTo : 14,
      OP_CURVE = OPS ? OPS.curveTo : 15, OP_CURVE2 = OPS ? OPS.curveTo2 : 16,
      OP_CURVE3 = OPS ? OPS.curveTo3 : 17, OP_RECT = OPS ? OPS.rectangle : 19,
      OP_FILL = OPS ? OPS.fill : 23, OP_EOFILL = OPS ? OPS.eofill : 24;
    var ctm = [1, 0, 0, 1, 0, 0], stack = [];
    var rects = [], segs = [], dots = [];
    // 反复记号圆点：贴近小节线的实心小圆点/小方块。这里只收集候选（小实心图形），
    // 是否真的是「反复」由 detectFromVecPrimitives 结合双竖线位置判定，避免把
    // 音符头（同样是小实心图形）误当成反复圆点。
    var pending = null;   // 当前 constructPath 的包围盒，遇 fill/eofill 时结算
    function accPt(x, y) {
      if (x < pending.x0) pending.x0 = x;
      if (y < pending.y0) pending.y0 = y;
      if (x > pending.x1) pending.x1 = x;
      if (y > pending.y1) pending.y1 = y;
    }
    var fnArray = opList.fnArray, argsArray = opList.argsArray;
    for (var i = 0; i < fnArray.length; i++) {
      var fn = fnArray[i], args = argsArray[i];
      if (OPS) {
        if (fn === OPS.save) { stack.push(ctm.slice()); continue; }
        if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
        if (fn === OPS.transform) { ctm = matMul(ctm, args); continue; }
        if (fn === OP_FILL || fn === OP_EOFILL) {
          if (pending) {
            var dw = pending.x1 - pending.x0, dh = pending.y1 - pending.y0;
            // 反复圆点：宽高都很小（<8）、近似方形、落入线谱带内的实心小图形
            if (dw > 1 && dh > 1 && dw < 8 && dh < 8 && dw / dh < 2.6 && dh / dw < 2.6) {
              dots.push({ x: (pending.x0 + pending.x1) / 2, y: (pending.y0 + pending.y1) / 2, w: dw, h: dh });
            }
            pending = null;
          }
          continue;
        }
        if (fn !== OPS.constructPath) continue;
      } else {
        // 极端兜底：没有 pdfjsLib OPS（理论上浏览器里不会发生）
        continue;
      }
      pending = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      var ops = args[0], pts = args[1];
      var pi = 0, cx = 0, cy = 0;
      for (var oi = 0; oi < ops.length; oi++) {
        var op = ops[oi];
        if (op === OP_RECT) {
          var c1 = applyM(ctm, pts[pi], pts[pi + 1]),
            c2 = applyM(ctm, pts[pi] + pts[pi + 2], pts[pi + 1]),
            c3 = applyM(ctm, pts[pi], pts[pi + 1] + pts[pi + 3]),
            c4 = applyM(ctm, pts[pi] + pts[pi + 2], pts[pi + 1] + pts[pi + 3]);
          var xs = [c1[0], c2[0], c3[0], c4[0]], ys = [c1[1], c2[1], c3[1], c4[1]];
          var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
          var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
          rects.push({ x0: x0, x1: x1, y0: y0, y1: y1, w: x1 - x0, h: y1 - y0 });
          accPt(c1[0], c1[1]); accPt(c2[0], c2[1]); accPt(c3[0], c3[1]); accPt(c4[0], c4[1]);
          pi += 4;
        } else if (op === OP_MOVE) { cx = pts[pi]; cy = pts[pi + 1]; pi += 2; }
        else if (op === OP_LINE) {
          var a = applyM(ctm, cx, cy), b = applyM(ctm, pts[pi], pts[pi + 1]);
          segs.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
          accPt(a[0], a[1]); accPt(b[0], b[1]);
          cx = pts[pi]; cy = pts[pi + 1]; pi += 2;
        }
        else if (op === OP_CURVE) {
          var ca = applyM(ctm, cx, cy), cb = applyM(ctm, pts[pi], pts[pi + 1]),
            cc = applyM(ctm, pts[pi + 2], pts[pi + 3]), cd = applyM(ctm, pts[pi + 4], pts[pi + 5]);
          accPt(ca[0], ca[1]); accPt(cb[0], cb[1]); accPt(cc[0], cc[1]); accPt(cd[0], cd[1]);
          cx = pts[pi + 4]; cy = pts[pi + 5]; pi += 6;
        }
        else if (op === OP_CURVE2) {
          var d2a = applyM(ctm, pts[pi], pts[pi + 1]), d2b = applyM(ctm, pts[pi + 2], pts[pi + 3]);
          accPt(d2a[0], d2a[1]); accPt(d2b[0], d2b[1]);
          cx = pts[pi + 2]; cy = pts[pi + 3]; pi += 4;
        }
        else if (op === OP_CURVE3) {
          var d3a = applyM(ctm, cx, cy), d3b = applyM(ctm, pts[pi], pts[pi + 1]);
          accPt(d3a[0], d3a[1]); accPt(d3b[0], d3b[1]);
          cx = pts[pi]; cy = pts[pi + 1]; pi += 2;
        }
      }
    }
    return { rects: rects, segs: segs, dots: dots };
  }

  // 由矢量图元推导小节（算法与 vec_detect4 验证版一致）
  function detectFromVecPrimitives(vec, W, H) {
    var rects = vec.rects, segs = vec.segs, dots = (vec.dots || []);
    // ① 小节线矩形：h>30 且 1.8<=w<=14（和弦图竖线 w=1.2 被排除；上限放宽到 14 以容纳终止线的粗线）
    var prims = [];
    rects.forEach(function (r) {
      if (r.h > 30 && r.w >= 1.8 && r.w <= 14) prims.push({ x: (r.x0 + r.x1) / 2, y0: r.y0, y1: r.y1, w: r.w });
    });
    // ② 系统起始全长竖线段：|dx|<3 且跨度>=200（长符干<=157 被排除）
    segs.forEach(function (s) {
      if (Math.abs(s.x1 - s.x0) < 3 && Math.abs(s.y1 - s.y0) >= 200) {
        prims.push({ x: (s.x0 + s.x1) / 2, y0: Math.min(s.y0, s.y1), y1: Math.max(s.y0, s.y1), seg: true });
      }
    });
    if (!prims.length) return { measures: [], rows: 0, doubles: 0 };

    // ③ 按中心链式聚类（间距<250 同系统）
    prims.forEach(function (p) { p.yc = (p.y0 + p.y1) / 2; });
    prims.sort(function (a, b) { return a.yc - b.yc; });
    var systems = [];
    prims.forEach(function (p) {
      var cur = systems[systems.length - 1];
      if (cur && Math.abs(p.yc - cur.yc) < 250) {
        cur.items.push(p);
        cur.yc = (cur.yc * (cur.items.length - 1) + p.yc) / cur.items.length;
      } else systems.push({ yc: p.yc, items: [p] });
    });
    // ③b 合并 y 范围互相重叠（或间隙<20）的系统：
    //    同一大谱表的子簇共享全长起始线 → 必然重叠；相邻系统之间有空隙。
    systems.forEach(function (s) {
      s.y0 = Math.min.apply(null, s.items.map(function (p) { return p.y0; }));
      s.y1 = Math.max.apply(null, s.items.map(function (p) { return p.y1; }));
    });
    var merged = true;
    while (merged) {
      merged = false;
      outer: for (var a = 0; a < systems.length; a++) {
        for (var b = a + 1; b < systems.length; b++) {
          var A = systems[a], B = systems[b];
          var gap = Math.max(A.y0 - B.y1, B.y0 - A.y1);   // 负值 = 重叠
          if (gap < 20) {
            A.items = A.items.concat(B.items);
            A.y0 = Math.min(A.y0, B.y0); A.y1 = Math.max(A.y1, B.y1);
            A.yc = (A.y0 + A.y1) / 2;
            systems.splice(b, 1);
            merged = true;
            break outer;
          }
        }
      }
    }

    // ④ 谱线水平段：求系统左右边界
    var hSegs = segs.filter(function (s) {
      return Math.abs(s.y1 - s.y0) < 2 && Math.abs(s.x1 - s.x0) > 100;
    });

    var measures = [], doubles = 0, rowInfo = [];
    systems.sort(function (a, b) { return b.yc - a.yc; }); // PDF y 底向上 → 降序 = 页面从上到下
    systems.forEach(function (sys, rowIdx) {
      var top = Math.max.apply(null, sys.items.map(function (p) { return p.y1; }));
      var bot = Math.min.apply(null, sys.items.map(function (p) { return p.y0; }));
      var edges = hSegs.filter(function (s) {
        var y = (s.y0 + s.y1) / 2;
        return y >= bot - 30 && y <= top + 30;
      });
      var xL = edges.length ? Math.min.apply(null, edges.map(function (s) { return Math.min(s.x0, s.x1); }))
        : Math.min.apply(null, sys.items.map(function (p) { return p.x; }));
      var xR = edges.length ? Math.max.apply(null, edges.map(function (s) { return Math.max(s.x0, s.x1); }))
        : Math.max.apply(null, sys.items.map(function (p) { return p.x; }));

      var xs = sys.items.map(function (p) { return { x: p.x, y0: p.y0, y1: p.y1, edge: false, w: (p.w || 2.5) }; });
      xs.push({ x: xL, y0: bot, y1: top, edge: true, w: 0 }, { x: xR, y0: bot, y1: top, edge: true, w: 0 });
      xs.sort(function (a, b) { return a.x - b.x; });
      var bounds = [];
      xs.forEach(function (p) {
        var last = bounds[bounds.length - 1];
        // 15 单位内：y 带「重叠」= 同一谱表上的两根线 = 双竖线；不重叠 = 同一根线的两个谱表段
        if (last && p.x - last.x <= 15) {
          var overlap = Math.min(p.y1, last.y1) - Math.max(p.y0, last.y0);
          // 同一谱表上、y 带重叠的两根靠得很近的竖线 = 一条「双竖线」(│ │)。
          // 双竖线有两种语义：反复线(|: :|) 与 终止线(段落结束)。唯一的判别依据是
          // 【反复圆点】——只有带圆点的双竖线才是反复，否则（细+细、细+粗都一样）
          // 一律当作段落终止，绝不触发回溯（这是《二十二》吉他谱误判的根因修复）。
          if (overlap > 0 && !p.edge && !last.edge) {
            last.dblCand = true;
            last.gapX0 = last.x;   // 较左那根细线的 x
            last.gapX1 = p.x;      // 较右那根细线的 x（合并后 last.x 会被更新成它）
          }
          if (!p.edge) last.n++;
          last.y1 = Math.max(last.y1, p.y1);
          last.y0 = Math.min(last.y0, p.y0);
          last.x = p.x;
          last.w = p.w;
        } else {
          bounds.push({ x: p.x, y0: p.y0, y1: p.y1, n: p.edge ? 0 : 1, dbl: false, final: false, dblCand: false, gapX0: p.x, gapX1: p.x, edge: p.edge, w: p.w });
        }
      });

      /* ⑤ 反复圆点判定：双竖线候选(dblCand)若缝隙里有反复圆点 → 反复线(|: :|)，
       *    否则一律当作段落终止线（细+细 / 细+粗都算终止，绝不回溯）。
       *    这是《二十二》终止线被误判为反复线、演奏时错误跳回的根因修复：
       *    真实谱全程零反复圆点，所以任何双竖线都不该被当成反复。 */
      var sysDots = dots.filter(function (d) { return d.y >= bot - 20 && d.y <= top + 20; });
      bounds.forEach(function (b) {
        if (!b.dblCand) return;
        // 搜索窗口随缝隙宽度相对化：粗终止线的两根线离得远，固定 ±7 会漏掉贴边的圆点
        var tolX = Math.max(7, (b.gapX1 - b.gapX0) * 0.6);
        var hasDot = sysDots.some(function (d) {
          return d.x >= b.gapX0 - tolX && d.x <= b.gapX1 + tolX && d.y >= b.y0 - 16 && d.y <= b.y1 + 16;
        });
        if (hasDot) { b.dbl = true; b.final = false; }
        else { b.dbl = false; b.final = true; }
      });

      var rowMeasures = 0, skippedNarrow = 0;
      for (var j = 0; j < bounds.length - 1; j++) {
        var x0 = bounds[j].x, x1 = bounds[j + 1].x;
        // <30 的窄缝几乎都是没并干净的双竖线两根之间的残留，不是小节：
        // 跳过但计数——漏切不再无声丢格（那会导致本行小节号整体错位却无人知晓），
        // 而是记进 debug.rowInfo，可按行定位排查。
        if (x1 - x0 < 30) { skippedNarrow++; continue; }
        measures.push({
          x: x0 / W, y: (H - top) / H, w: (x1 - x0) / W, h: (top - bot) / H,
          doubleLeft: bounds[j].dbl, doubleRight: bounds[j + 1].dbl,
          finalLeft: bounds[j].final, finalRight: bounds[j + 1].final,
          row: rowIdx,          // 页内第几个谱表行（0 起，自上而下）
          index: rowMeasures    // 页内第几格（0 起，自左向右）
        });
        rowMeasures++;
      }
      doubles += bounds.filter(function (b) { return b.dbl; }).length; // 每条反复线只计一次（含行尾 :│）
      rowInfo.push({
        row: rowIdx, top: top, bot: bot,
        bounds: bounds.length, measures: rowMeasures, skippedNarrow: skippedNarrow,
        repeats: bounds.filter(function (b) { return b.dbl; }).length,
        finals: bounds.filter(function (b) { return b.final; }).length
      });
    });
    return { measures: measures, rows: systems.length, doubles: doubles, debug: { rowInfo: rowInfo } };
  }

  /**
   * 矢量检测单页。source 需提供 operatorList(pageIndex)（目前只有 PdfSource 有）。
   * 返回与 detectPage 相同的契约；不可用/失败/无矢量图元时返回 null，由调用方回退像素检测。
   */
  async function detectPageVec(source, pageIndex) {
    if (!source || source.kind !== 'pdf' || typeof source.operatorList !== 'function') return null;
    try {
      var sz = await source.size(pageIndex);
      var opList = await source.operatorList(pageIndex);
      if (!opList || !opList.fnArray || !opList.fnArray.length) return null;
      var vec = extractVecPrimitives(opList);
      if (!vec.rects.length && !vec.segs.length) return null;   // 扫描件：只有图片，没有矢量线条
      var r = detectFromVecPrimitives(vec, sz.w, sz.h);
      if (!r.rows) return null;
      return r;
    } catch (e) {
      return null;   // 任何异常都不让上层崩，交给像素检测兜底
    }
  }

  /**
   * 自动选择检测方式：矢量优先（精确、不受水印/抗锯齿影响），
   * PDF 无矢量线条（扫描件）或非 PDF 源时回退像素投影检测。
   */
  async function detectPageAuto(source, pageIndex, opts) {
    try {
      var v = await detectPageVec(source, pageIndex);
      if (v && v.rows > 0) return v;
    } catch (e) { /* 矢量失败 → 回退像素 */ }
    return detectPage(source, pageIndex, opts);
  }

  /**
   * 识别算法版本号。
   * 【重要】每次改动小节线识别算法（尤其会影响识别结果时）都必须 +1。
   * app.js 会把它写进本地存档；版本不一致时旧存档里的小节框视为过期、
   * 自动用新算法重新识别——否则用户重新导入同一份谱子会一直看到旧算法
   * 留下的错误框（例如"一格被切成两格"），误以为修复没生效。
   */
  var DETECT_VERSION = 6;   // 1=像素投影 2=PDF矢量检测 3=矢量检测区分终止线/反复线 4=以"反复圆点"判定是否反复(终止线不再误判为反复)
  // 5=①像素路径补齐同一"圆点判据"(扫描件终止线不再误判为反复) ②并组间距随谱高缩放
  //   ③measures 增加 row/index 字段 ④窄缝跳过计入 debug.rowInfo(漏切可诊断) ⑤圆点搜索窗口随缝隙宽度相对化
  // 6=像素路径重写系统聚类：保留多子谱表(TAB+五线谱/人声线)、"穿隙校验"剔除符干与琶音箭头、
  //   过滤过矮的假系统、窄缝阈值随谱高缩放 —— 《Love Song》扫描稿 143 → 14(真值 14)
  // 5=①像素路径补齐同一"圆点判据"(扫描件终止线不再误判为反复) ②并组间距随谱表高度缩放
  //   ③measures 增加 row/index 字段 ④窄缝跳过计入 debug.rowInfo(漏切可诊断) ⑤圆点搜索窗口随缝隙宽度相对化

  ST.BarlineDetect = {
    detectPage: detectPage,
    detectPageVec: detectPageVec,
    detectPageAuto: detectPageAuto,
    extractVecPrimitives: extractVecPrimitives,
    detectFromVecPrimitives: detectFromVecPrimitives,
    VERSION: DETECT_VERSION
  };
})(typeof window !== 'undefined' ? window : globalThis);
