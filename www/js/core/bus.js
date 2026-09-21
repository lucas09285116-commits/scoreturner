/**
 * core/bus.js
 * 极简事件总线。模块之间不直接互相引用，一律通过总线解耦：
 *   metronome  --tick-->  tracker  --position-->  pageTurn / renderer
 *   input      --command--> app（分发到具体模块）
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  function createBus() {
    var map = new Map();
    function on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return function off() { map.get(evt).delete(fn); };
    }
    function off(evt, fn) { var s = map.get(evt); if (s) s.delete(fn); }
    function emit(evt, payload) {
      var s = map.get(evt);
      if (!s) return;
      s.forEach(function (fn) {
        try { fn(payload, evt); }
        catch (e) { console.error('[bus] ' + evt, e); }
      });
    }
    return { on: on, off: off, emit: emit };
  }

  ST.createBus = createBus;
})(typeof window !== 'undefined' ? window : globalThis);
