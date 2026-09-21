/**
 * core/store.js
 * ---------------------------------------------------------------------------
 * 单一数据源。所有模块只做两件事：读 state、提交 patch；不允许模块之间互相
 * 改写状态。UI 通过 subscribe + 细粒度选择器刷新，保证演奏过程中
 * 「时钟推进」和「界面重绘」解耦，避免 60fps 全量重排影响节奏稳定性。
 *
 * State 分片：
 *   score      乐谱静态数据（页、小节矩形、反复记号）
 *   timeline   派生数据（把反复/跳房子展开后的线性演奏序列）——不属于"输入"
 *   transport  时钟与当前位置（拍号、BPM、是否播放、绝对拍号、时间线序号）
 *   view       显示（当前页、缩放、深色、双页、是否显示小节框、全屏）
 *   turn       自动翻页参数（提前量、单位、动画时长）
 *   edit       编辑态（模式、选中的小节）
 *   audio      节拍器音色参数
 *   input      快捷键/踏板绑定
 *   repeat     反复展开策略
 * ---------------------------------------------------------------------------
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function defaultState() {
    return {
      score: null,            // { id, name, sourceType, pages:[{w,h}], measures:[...], rev }
      pageStarts: [],         // 每页第一格的「谱面印刷号」；[] 表示未对齐（按 1..N 顺序）
      timeline: [],           // [{ seq, measureId, page, x,y,w,h, firstBeat, beats, bar, pass }]
      timelineTotalBeats: 0,
      warnings: [],
      transport: {
        playing: false,
        bpm: 96,
        timeSig: { num: 4, den: 4 },
        compound: true,
        beat: 0,             // 绝对拍号（0 起）
        tlIndex: 0,          // 当前所处的演奏时间线序号
        startedBeat: 0       // 本次播放起点，用于重置
      },
      view: {
        page: 0,
        spread: false,
        preview: false,
        zoomMode: 'fit',     // fit | width | manual
        zoomValue: 1,
        dark: true,
        showBoxes: false,
        fullscreen: false,
        panels: true,
        autoTurnPending: false,   // 已提前翻页、但进度还没走到目标页
        pendingTarget: null
      },
      turn: {
        auto: true,
        leadValue: 2,        // 提前量（正数=提前，负数=延后）
        leadUnit: 'beat',    // beat | bar
        animateMs: 320,
        lastTurnKey: null
      },
      edit: {
        mode: 'play',        // play | edit
        selectedId: null
      },
      audio: { volume: 0.8, accent: true, subdivision: false, muted: false },
      repeat: { defaultCount: 2, maxPasses: 8 },
      input: {
        binds: {
          'next-page': ['PageDown'],
          'prev-page': ['PageUp'],
          'toggle-play': ['Space'],
          'next-measure': ['ArrowRight'],
          'prev-measure': ['ArrowLeft'],
          'next-page-alt': ['ArrowDown'],
          'prev-page-alt': ['ArrowUp']
        },
        midi: false
      }
    };
  }

  /**
   * patch 语义：顶层 key 一一替换；若 value 是普通对象则与旧 slice 浅合并
   * （方便 this.store.set({ transport: { bpm: 120 } }) 这种局部更新），
   * 数组一律整体替换。
   */
  function applyPatch(state, patch) {
    var next = Object.assign({}, state);
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        next[k] = Object.assign({}, state[k] || {}, v);
      } else {
        next[k] = v;
      }
    });
    return next;
  }

  function createStore(initial) {
    var state = initial || defaultState();
    var subs = new Set();

    return {
      get: function () { return state; },
      set: function (patch, meta) {
        state = applyPatch(state, patch);
        subs.forEach(function (fn) { fn(state, Object.keys(patch), meta || {}); });
        return state;
      },
      subscribe: function (fn) {
        subs.add(fn);
        return function () { subs.delete(fn); };
      }
    };
  }

  ST.defaultState = defaultState;
  ST.createStore = createStore;
})(typeof window !== 'undefined' ? window : globalThis);
