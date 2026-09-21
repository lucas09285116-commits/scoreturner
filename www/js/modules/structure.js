/**
 * modules/structure.js
 * ---------------------------------------------------------------------------
 * 乐谱结构引擎 —— 整个软件的算法核心，且刻意做成无 DOM 依赖的纯逻辑，
 * 可以在 Node 里直接单测（见 tests/timeline.test.js）。
 *
 * 设计要点
 * --------
 * 1) 乐谱的**物理顺序**（页 → 行 → 小节，从左到右）与**演奏顺序**（反复、跳房子、
 *    D.C./D.S. 造成的跳转）不是一回事。真实用以驱动翻页的必须是后者。
 * 2) 因此本模块把带有跳转结构的乐谱**展开（flatten）成一条线性「演奏时间线」**：
 *      timeline = [{ seq, measureId, page, rect, firstBeat, beats, bar, pass, take }]
 *    展开之后，小节计数、当前位置、翻页判断全部退化成「在这条数组上走一格」，
 *    反复段落、回头跳 Notation 自然被吞掉——这是这个类设计能成立的关键。
 * 3) 时间的基本单位是「拍」，且**拍 = 节拍器的一次点击**。这样"提前 2 拍翻页"
 *    不需要任何时值换算（八分音符/附点音符的差异被拍号解析吸收掉）。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  /* ---------------- 拍号解析 ---------------- */
  // 把一个拍号换算成"每小节多少拍（点击）"
  //  compound=true 时，6/8 → 2 拍（附点四分），9/8 → 3，12/8 → 4
  function beatsOfTimeSig(ts, compound) {
    ts = ts || { num: 4, den: 4 };
    var num = ts.num, den = ts.den;
    if (compound && den === 8 && num % 3 === 0) return num / 3;
    return num;
  }

  function beatsForMeasure(m, ctx) {
    if (typeof m.beats === 'number' && m.beats > 0) return m.beats;   // 手动覆盖（弱起小节等）
    return Math.max(1, beatsOfTimeSig(m.timeSig || ctx.timeSig, ctx.compound));
  }

  /* ---------------- 印刷小节号推导 ---------------- */
  // 软件内部按"页 → 行 → 列"给小节顺序编号，但用户脑子里想的是"谱面上印着的小节号"。
  // 两者只在「谱子从 1 开始、每页连续、无弱起」时才相等。其余情况都必须用对齐：
  //   pageStarts[p] = 第 p 页第一格的「谱面印刷号」
  // 未对齐的页自动顺延上一页的末号 +1；这样只要把第一页（或第一处错位页）对齐，
  // 后面整页自动跟上。这是让「输入 70 → 跳到谱面第 70 格」成立的唯一可靠办法。
  function computeBarNumbers(measures, pageStarts) {
    pageStarts = pageStarts || [];
    var byPage = {};
    measures.forEach(function (m) { (byPage[m.page] = byPage[m.page] || []).push(m); });
    var nextStart = 1;
    Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      var list = byPage[p];
      // 阅读顺序：先按行（y）再按列（x），保证编号与视觉一致
      list.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
      var hasOverride = typeof pageStarts[p] === 'number' && pageStarts[p] > 0;
      var start = hasOverride ? pageStarts[p] : nextStart;
      list.forEach(function (m, i) { m.bar = start + i; });
      nextStart = start + list.length;
    });
    return measures;
  }

  /* ---------------- 阅读顺序还原 ---------------- */
  // 输入：任意顺序的小节（含 page/x/y/w/h 归一化坐标）
  // 输出：按 页 → 行 → 列 排序的新数组（不修改入参）
  function sortMeasures(measures) {
    var byPage = {};
    measures.forEach(function (m) {
      var k = m.page || 0;
      (byPage[k] = byPage[k] || []).push(m);
    });
    var out = [];
    Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      var list = byPage[p].slice().sort(function (a, b) { return a.y - b.y; });
      var h = list.reduce(function (s, m) { return s + (m.h || 0.05); }, 0) / (list.length || 1);
      var row = [], rows = [], top = null;
      list.forEach(function (m) {
        if (top === null || m.y < top + h * 0.6) { row.push(m); if (top === null) top = m.y; }
        else { rows.push(row); row = [m]; top = m.y; }
      });
      if (row.length) rows.push(row);
      rows.forEach(function (r) {
        r.sort(function (a, b) { return a.x - b.x; }).forEach(function (m) { out.push(m); });
      });
    });
    return out;
  }

  /* ---------------- 跳房子索引 ---------------- */
  // 连续的、带 volta 标记的小节构成一个组；组内再按 numbers 切成员
  function indexVolta(ordered) {
    var groups = [], cur = null, index = new Map();
    ordered.forEach(function (m, i) {
      if (m.volta && m.volta.length) {
        if (cur && cur.endIdx === i - 1) cur.endIdx = i; else cur = null;
        if (!cur) {
          cur = { id: 'v' + i, startIdx: i, endIdx: i, members: [], maxNumber: 0 };
          groups.push(cur);
        }
        index.set(i, cur);
        var key = m.volta.join(',');
        var last = cur.members[cur.members.length - 1];
        if (last && last.key === key && last.endIdx === i - 1) last.endIdx = i;
        else cur.members.push({ key: key, numbers: m.volta.slice(), startIdx: i, endIdx: i });
        m.volta.forEach(function (n) { if (n > cur.maxNumber) cur.maxNumber = n; });
      } else {
        cur = null;
      }
    });
    return { groups: groups, index: index };
  }

  /* ---------------- 时间线展开 ---------------- */
  /**
   * @param {Array} measures 小节（建议先 sortMeasures）
   * @param {Object} opts    { timeSig, compound, defaultRepeatCount, maxPasses }
   * @returns {{entries:Array, totalBeats:number, warnings:string[], occurrences:Map}}
   */
  function buildTimeline(measures, opts) {
    opts = opts || {};
    var ctx = {
      timeSig: opts.timeSig || { num: 4, den: 4 },
      compound: opts.compound !== false
    };
    var list = measures;
    var n = list.length;
    var defaultCount = opts.defaultRepeatCount || 2;
    var maxPasses = opts.maxPasses || 8;

    var volta = indexVolta(list);
    var repeatOpen = [];          // 尚未闭合的反复起点索引（栈）
    var repeatPass = new Map();   // "起点|终点" -> 已通过次数
    var voltaPass = new Map();    // 组 id      -> 已回头覆盖次数
    var visits = new Map();       // measureId  -> 已出现次数
    var warnings = [];

    var entries = [];
    var beat = 0, i = 0, guard = 0;
    var guardLimit = Math.max(2000, n * maxPasses * 4);

    // 跳回 [lo,hi] 区间意味着这一段要再来一遍：凡是"第一支"落在区间内的
    // 跳房子组，下一遍就该走"下一支"。用 startIdx 判定而非整体包含，
    // 因为第 2 房子通常写在结束反复的外侧。
    // 一段被重新经过时，清掉段内部的通过计数（"j" 前缀是 D.C./D.S. 的计数器，不参与）
    function resetRepeatsInside(lo, hi, exceptKey) {
      Array.from(repeatPass.keys()).forEach(function (k) {
        if (k === exceptKey || k.charAt(0) === 'j') return;
        var p = k.split('|');
        if (p.length === 2 && +p[0] >= lo && +p[1] <= hi) repeatPass.delete(k);
      });
    }

    // 房子组自带的反复：因为 " :| " 通常画在第 1 房子的末尾那一小节上，
    // 后面几遍根本不会走到那一小节，所以反复必须挂在"组"上判定，而不是那一小节。
    function groupRepeatJump(g) {
      var info = null;
      for (var k = g.startIdx; k <= g.endIdx; k++) {
        if (list[k].repeatEnd) { info = { idx: k, count: list[k].repeatCount || defaultCount }; break; }
      }
      if (!info) return -1;
      var startIdx = repeatOpen.length ? repeatOpen[repeatOpen.length - 1] : 0;
      var key = 'g' + g.id + '|' + startIdx;
      var done = repeatPass.get(key) || 0;
      if (done + 1 >= info.count || done >= maxPasses) {
        if (repeatOpen.length && repeatOpen[repeatOpen.length - 1] === startIdx) repeatOpen.pop();
        return null;
      }
      repeatPass.set(key, done + 1);
      return { to: startIdx, key: key };
    }

    function bumpVoltaBetween(lo, hi) {
      volta.groups.forEach(function (g) {
        if (g.startIdx >= lo && g.startIdx <= hi) voltaPass.set(g.id, (voltaPass.get(g.id) || 0) + 1);
      });
    }

    /**
     * 所有"回头"动作的唯一出口：任何跳转都必须经过这里，
     * 这样「清理段内层计数」+「跳房子推进到下一支」两件事不会被漏掉。
     */
    function jumpBack(to, from, exceptKey) {
      var lo = Math.min(to, from), hi = Math.max(to, from);
      resetRepeatsInside(lo, hi, exceptKey);
      bumpVoltaBetween(lo, hi);
    }

    while (i < n) {
      if (guard++ > guardLimit) { warnings.push('展开步数超限，可能存在无法闭合的反复，已截断'); break; }

      var m = list[i];

      /* —— 跳房子：按当前通过次数选择要演奏的那一支 —— */
      var g = volta.index.get(i);
      var take = 0;
      if (g) {
        var pass = voltaPass.get(g.id) || 0;                 // 0 表示第 1 遍
        take = Math.min(pass + 1, g.maxNumber);
        var member = g.members.filter(function (mm) { return mm.numbers.indexOf(take) >= 0; })[0]
          || g.members[g.members.length - 1];
        if (i < member.startIdx) { i = member.startIdx; continue; }
        if (i > member.endIdx) {                             // 走出这一支，准备离开整组
          var gj = groupRepeatJump(g);                       // 房子组自带的 :| 在这里判定
          if (gj) { jumpBack(gj.to, i, gj.key); i = gj.to; }
          else { i = g.endIdx + 1; }
          continue;
        }
      }

      /* —— 记入时间线 —— */
      var beats = beatsForMeasure(m, ctx);
      var visitCount = (visits.get(m.id) || 0) + 1;
      visits.set(m.id, visitCount);
      entries.push({
        seq: entries.length,
        measureId: m.id,
        page: m.page || 0,
        rect: { x: m.x, y: m.y, w: m.w, h: m.h },
        firstBeat: beat,
        beats: beats,
        bar: (typeof m.bar === 'number' ? m.bar : i + 1),
        pass: visitCount,
        take: take || 0,
        timeSig: m.timeSig || ctx.timeSig
      });
      beat += beats;

      /* —— D.C. / D.S. 类跳转 —— */
      var jump = null;
      if (m.jump && typeof m.jump === 'object') {
        var times = m.jump.times || 1;
        var jkey = 'j' + i;
        var jdone = repeatPass.get(jkey) || 0;
        if (jdone < times) {
          repeatPass.set(jkey, jdone + 1);
          var to = (typeof m.jump.targetIndex === 'number')
            ? m.jump.targetIndex
            : list.findIndex(function (x) { return x.id === m.jump.target; });
          if (to >= 0) jump = { to: to, key: jkey };
        }
      }

      /* —— 小节上的结束反复 :| （房子组里的 :| 在 groupRepeatJump 中处理） —— */
      if (!jump && !g && m.repeatEnd && repeatOpen.length) {
        var startIdx = repeatOpen[repeatOpen.length - 1];
        var cnt = m.repeatCount || defaultCount;
        var rkey = startIdx + '|' + i;
        var rdone = repeatPass.get(rkey) || 1;
        if (rdone < cnt && rdone < maxPasses) {
          repeatPass.set(rkey, rdone + 1);
          jump = { to: startIdx, key: rkey };
        } else {
          repeatOpen.pop();
        }
      }

      if (jump) {
        jumpBack(jump.to, i, jump.key);
        i = jump.to;
        continue;
      }

      if (m.repeatStart && repeatOpen.indexOf(i) === -1) repeatOpen.push(i);
      i++;
    }

    if (list.some(function (m) { return m.repeatEnd; }) && !list.some(function (m) { return m.repeatStart; })) {
      warnings.push('存在结束反复但没有对应的开始反复，该段落只会演奏一遍');
    }

    // measureId → 该小节在时间线上出现的所有位置（供"跳到第 N 次出现"使用）
    var occurrences = new Map();
    entries.forEach(function (e, idx) {
      if (!occurrences.has(e.measureId)) occurrences.set(e.measureId, []);
      occurrences.get(e.measureId).push(idx);
    });

    return { entries: entries, totalBeats: beat, warnings: warnings, occurrences: occurrences, volta: volta };
  }

  /* ---------------- 派生查询 ---------------- */
  function entryAtBeat(timeline, beat) {
    if (!timeline.length) return -1;
    var lo = 0, hi = timeline.length - 1, ans = timeline.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var e = timeline[mid];
      if (beat >= e.firstBeat && beat < e.firstBeat + e.beats) return mid;
      if (beat < e.firstBeat) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  // 找到「下一个页面会发生变化的入口」，返回 null 表示后面不会再换页
  function nextPageBoundary(timeline, fromIndex) {
    if (!timeline.length) return null;
    var curPage = timeline[fromIndex].page;
    for (var j = fromIndex + 1; j < timeline.length; j++) {
      if (timeline[j].page !== curPage) return { index: j, page: timeline[j].page };
    }
    return null;
  }

  ST.Structure = {
    beatsOfTimeSig: beatsOfTimeSig,
    beatsForMeasure: beatsForMeasure,
    sortMeasures: sortMeasures,
    computeBarNumbers: computeBarNumbers,
    indexVolta: indexVolta,
    buildTimeline: buildTimeline,
    entryAtBeat: entryAtBeat,
    nextPageBoundary: nextPageBoundary
  };
})(typeof window !== 'undefined' ? window : globalThis);
