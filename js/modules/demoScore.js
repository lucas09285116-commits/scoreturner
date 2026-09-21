/**
 * modules/demoScore.js
 * 生成一份「合成乐谱」用于零成本体验全流程：2 页 × 4 行 × 4 小节，
 * 第 2 行自带一个反复 + 一对跳房子，并且**同时产出配套的小节坐标**，
 * 所以点「示例乐谱」之后不用做任何标记就能直接播放、自动翻页，
 * 也能顺带看到反复段落是怎么被展开的。
 */
(function (root) {
  var ST = (root.ST = root.ST || {});

  var PW = 1190, PH = 1684;            // A4 @150dpi
  var MARGIN = 90;
  var COLS = 4, ROWS = 4;
  var HEADER = 150;
  var SYSTEM_GAP = 46;
  var STAFF_LINES = 5, STAFF_GAP = 13;

  function buildPage(pageIndex, measures, startBar) {
    var cv = document.createElement('canvas');
    cv.width = PW; cv.height = PH;
    var c = cv.getContext('2d');

    c.fillStyle = '#fff';
    c.fillRect(0, 0, PW, PH);

    c.fillStyle = '#222';
    c.font = '600 30px "Segoe UI", "Microsoft YaHei", sans-serif';
    c.fillText('Demo Score · 数说中国主题变奏', MARGIN, 76);
    c.font = '16px "Segoe UI", sans-serif';
    c.fillStyle = '#888';
    c.fillText('第 ' + (pageIndex + 1) + ' 页  —  合成示例（含反复记号与跳房子）', MARGIN, 104);

    var sysTop = HEADER;
    for (var r = 0; r < ROWS; r++) {
      var sysH = 120;
      drawSystem(c, MARGIN, sysTop, PW - MARGIN * 2, sysH, r, startBar + r * COLS, measures);
      sysTop += sysH + SYSTEM_GAP;
    }
    return cv.toDataURL('image/jpeg', 0.9);
  }

  function drawSystem(c, x, y, w, h, rowIndex, firstBar, measures) {
    var staffH = STAFF_GAP * (STAFF_LINES - 1);
    var top = y + 18;
    var colW = w / COLS;

    // 谱线
    c.strokeStyle = '#333';
    c.lineWidth = 1;
    for (var l = 0; l < STAFF_LINES; l++) {
      c.beginPath();
      c.moveTo(x, top + l * STAFF_GAP);
      c.lineTo(x + w, top + l * STAFF_GAP);
      c.stroke();
    }
    // 竖线（小节线）
    for (var col = 0; col <= COLS; col++) {
      var bx = x + col * colW;
      c.beginPath();
      c.moveTo(bx, top);
      c.lineTo(bx, top + staffH);
      c.stroke();
    }

    for (var i = 0; i < COLS; i++) {
      var m = measures[i + rowIndex * COLS];
      var mx = x + i * colW;

      // 音符
      for (var n = 0; n < 4; n++) {
        var nx = mx + 26 + n * ((colW - 52) / 4);
        var step = 1 + Math.floor(Math.random() * 5);
        var ny = top + staffH - step * (STAFF_GAP / 2);
        c.fillStyle = '#1b1b1b';
        c.beginPath();
        c.ellipse(nx, ny, 6, 4.4, -0.35, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#1b1b1b';
        c.lineWidth = 1.4;
        c.beginPath();
        c.moveTo(nx + 5.5, ny);
        c.lineTo(nx + 5.5, ny - 24);
        c.stroke();
      }

      // 小节号
      c.fillStyle = '#9aa';
      c.font = '11px sans-serif';
      c.fillText(String(firstBar + i), mx + 6, top - 6);

      if (m.repeatStart) {
        c.strokeStyle = '#111'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(mx + 6, top); c.lineTo(mx + 6, top + staffH); c.stroke();
        c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(mx + 13, top); c.lineTo(mx + 13, top + staffH); c.stroke();
        dots(c, mx + 20, top + staffH);
        c.fillStyle = '#c0392b'; c.font = '11px sans-serif';
        c.fillText('|:', mx + 6, top - 6);
      }
      if (m.repeatEnd) {
        var ex = mx + colW;
        c.strokeStyle = '#111'; c.lineWidth = 1.6;
        c.beginPath(); c.moveTo(ex - 13, top); c.lineTo(ex - 13, top + staffH); c.stroke();
        c.lineWidth = 4;
        c.beginPath(); c.moveTo(ex - 6, top); c.lineTo(ex - 6, top + staffH); c.stroke();
        dots(c, ex - 20, top + staffH);
      }
      if (m.volta && m.volta.length) {
        var vx = mx, vw = colW;
        c.strokeStyle = '#c0392b'; c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(vx, top - 16); c.lineTo(vx + vw, top - 16);
        c.stroke();
        c.beginPath(); c.moveTo(vx, top - 16); c.lineTo(vx, top - 22); c.stroke();
        c.fillStyle = '#c0392b'; c.font = 'bold 12px sans-serif';
        c.fillText(m.volta.map(function (n) { return n + '.'; }).join(' '), vx + 8, top - 22);
      }
    }
  }

  function dots(c, x, staffBottom) {
    c.fillStyle = '#111';
    var y = staffBottom - STAFF_GAP;
    [y, y + STAFF_GAP].forEach(function (yy) {
      c.beginPath(); c.arc(x, yy, 2.6, 0, Math.PI * 2); c.fill();
    });
  }

  var Loader = {
    build: function () {
      var measures = [];
      var perPage = ROWS * COLS;
      var totalPages = 2;
      for (var p = 0; p < totalPages; p++) {
        for (var i = 0; i < perPage; i++) {
          var gi = p * perPage + i;
          measures.push({
            id: 'demo-m' + gi,
            page: p,
            bar: gi + 1,
            x: (MARGIN + (i % COLS) * ((PW - MARGIN * 2) / COLS)) / PW,
            y: (HEADER + Math.floor(i / COLS) * (120 + SYSTEM_GAP) + 10) / PH,
            w: ((PW - MARGIN * 2) / COLS) / PW,
            h: (STAFF_GAP * (STAFF_LINES - 1) + 22) / PH
          });
        }
      }
      // 第 4 小节开始反复，第 7 小节是 1 房子 + :|，第 8 小节是 2 房子
      measures[3].repeatStart = true;
      measures[6].volta = [1];
      measures[6].repeatEnd = true;
      measures[6].repeatCount = 2;
      measures[7].volta = [2];

      return {
        kind: 'demo',
        name: '示例乐谱（合成）',
        id: 'demo:' + perPage * totalPages,
        pageCount: totalPages,
        measures: measures,
        render: function (i) {
          return Promise.resolve({ dataUrl: buildPage(i, measures.slice(i * perPage, (i + 1) * perPage), i * perPage + 1), w: PW, h: PH });
        },
        size: function () { return Promise.resolve({ w: PW, h: PH }); }
      };
    }
  };

  ST.DemoScore = Loader;
})(typeof window !== 'undefined' ? window : globalThis);
