/**
 * modules/pageTurn.js
 * ---------------------------------------------------------------------------
 * 翻页决策。这里刻意**不"看"页码**，而是看演奏时间线：
 *
 *   从当前格子往后找，第一个「所在页 ≠ 当前页」的格子就是翻页点。
 *
 * 的好处：
 *   · 反复回头时，目标可能是"翻回上一页"——逻辑不用改，边界自己会算出来；
 *   · 跳房子导致第二遍跳过某页的一部分时，翻页点也随之改变；
 *   · 手动跳转（点击小节、踏板）之后，下一处边界自动重算，不会重复触发。
 *
 * 触发时机 = 目标格的起始拍 − 提前量（单位可为拍或小节）。
 * 用 `lastTurnKey`（当前格序号 → 边界序号）去重，保证一次边界只翻一次。
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function PageTurn(opts) {
    this.store = opts.store;
    this.bus = opts.bus;
  }

  PageTurn.prototype.leadBeats = function (entry) {
    var t = this.store.get().turn;
    if (t.leadUnit === 'bar') return Math.round((t.leadValue || 0) * (entry ? entry.beats : 4));
    return Math.round(t.leadValue || 0);
  };

  /** 计算下一处翻页（不改变状态） */
  PageTurn.prototype.plan = function () {
    var st = this.store.get();
    var tl = st.timeline || [];
    var idx = st.transport.tlIndex;
    if (!tl.length || !tl[idx]) return null;
    var b = ST.Structure.nextPageBoundary(tl, idx);
    if (!b) return null;
    var lead = this.leadBeats(tl[idx]);
    return {
      key: idx + '>' + b.index,
      targetPage: b.page,
      boundaryIndex: b.index,
      triggerBeat: tl[b.index].firstBeat - lead,
      leadBeats: lead,
      beatsAway: tl[b.index].firstBeat - st.transport.beat
    };
  };

  /** 每拍调用：到点就翻 */
  PageTurn.prototype.evaluate = function (force) {
    var st = this.store.get();
    if (!st.turn.auto && !force) return null;
    var p = this.plan();
    if (!p) return null;
    if (st.turn.lastTurnKey === p.key && !force) return null;
    if (st.transport.beat < p.triggerBeat && !force) return null;

    this.store.set({ turn: { lastTurnKey: p.key } });
    this.bus.emit('page:turn', { page: p.targetPage, plan: p });
    return p;
  };

  /** 手动跳转后要把去重标记清掉，否则"回到上次翻页点附近"不会重新触发 */
  PageTurn.prototype.invalidate = function () {
    if (this.store.get().turn.lastTurnKey !== null) this.store.set({ turn: { lastTurnKey: null } });
  };

  ST.PageTurn = PageTurn;
})(typeof window !== 'undefined' ? window : globalThis);
