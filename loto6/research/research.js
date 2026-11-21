(function () {
  'use strict';
  var BASE = (window.ApiConfig && window.ApiConfig.BASE_URL) || '';
  var root = document.getElementById('root');
  var COLORS = { analysis: '#7aa7ff', control: '#f0b35a', ref: '#9aa4b8' };
  var NAMES = { analysis: '分析版', control: '対照群（無作為）' };
  var SERIES = { auto: '自動（サーバー記録）', pilot_manual: '試行（手動・ファイル指紋のみ）' };
  var SCOPE = { target: '対象回（正式な実績）', follow_up: '長期追跡（生成後の、対象回以外の抽せん）' };
  var EVID = { server_recorded: 'サーバーが生成時刻を記録', file_hash_only: 'ファイルの指紋のみ（時刻はサーバー記録なし）' };
  var STATUS = { generating: '生成中', committed_waiting_draw: '指紋公開済み・抽せん待ち', scored: '採点済み' };
  var charts = [];
  var state = { series: 'auto', scope: 'target' };
  var data = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function fmt(x, d) { return x == null || !isFinite(x) ? '-' : Number(x).toFixed(d == null ? 3 : d); }
  function pct(x) { return x == null ? '-' : (x * 100).toFixed(2) + '%'; }
  function jdate(iso) { return iso ? String(iso).replace('T', ' ').slice(0, 19) : '-'; }
  function nonNull(a) { return a.filter(function (x) { return x != null; }); }

  // 理論値：43個から6個選び、当せん6個との一致数の確率（超幾何分布）
  function comb(n, k) { var r = 1; for (var i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }
  function hyper(k) { return comb(6, k) * comb(37, 6 - k) / comb(43, 6); }

  function scroll(t) { var d = el('div', { style: 'overflow-x:auto' }); d.appendChild(t); return d; }
  function panel(title, kids) { var p = el('div', { class: 'panel' }); if (title) p.appendChild(el('h2', { text: title })); (kids || []).forEach(function (k) { p.appendChild(k); }); return p; }
  function emptyBox() { return el('div', { class: 'empty', text: 'データ蓄積中' }); }
  function chartBox(build) {
    var box = el('div', { class: 'chart' }); var cv = el('canvas'); box.appendChild(cv);
    var c = build(cv); if (!c) return emptyBox(); charts.push(c); return box;
  }
  function baseOpts(yTitle, xTitle) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: '#eef2ff', usePointStyle: false, boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#aeb7ca', maxRotation: 0, autoSkip: true }, grid: { color: '#1b2438' }, title: { display: !!xTitle, text: xTitle, color: '#aeb7ca' } },
        y: { ticks: { color: '#aeb7ca' }, grid: { color: '#1b2438' }, beginAtZero: true, title: { display: !!yTitle, text: yTitle, color: '#aeb7ca' } }
      }
    };
  }

  function rowsFor(list) { return list.filter(function (r) { return r.series === state.series && r.scope === state.scope; }); }
  function perDraw(grp) {
    return data.per_draw.filter(function (r) { return r.series === state.series && r.scope === state.scope && r.grp === grp; });
  }

  function summaryTable() {
    var rows = rowsFor(data.totals);
    if (!rows.length) return emptyBox();
    var t = el('table'); t.appendChild(el('caption', { text: '集計（照合した口数あたり）。基準：無作為なら平均一致数は ' + fmt(data.reference_random.mean_matches) }));
    var head = el('tr'); ['群', 'バッチ', '抽せん回', '照合口数', '平均一致数', '3個以上', '4個以上', '5個以上'].forEach(function (h, i) { head.appendChild(el('th', { text: h, class: i ? '' : 'l' })); });
    t.appendChild(head);
    ['analysis', 'control'].forEach(function (g) {
      var r = rows.filter(function (x) { return x.grp === g; })[0]; if (!r) return;
      var n = r.tickets_checked, m3 = r.m3 + r.m4 + r.m5 + r.m5b + r.m6, m4 = r.m4 + r.m5 + r.m5b + r.m6, m5 = r.m5 + r.m5b + r.m6;
      var tr = el('tr'); var th = el('td'); th.appendChild(el('span', { class: 'sw', style: 'background:' + COLORS[g] })); th.appendChild(document.createTextNode(NAMES[g])); tr.appendChild(th);
      [r.batches, r.draws, n, fmt(r.sum_main_match / n), m3 + '（' + pct(m3 / n) + '）', m4 + '（' + pct(m4 / n) + '）', m5].forEach(function (v) { tr.appendChild(el('td', { text: String(v) })); });
      t.appendChild(tr);
    });
    return scroll(t);
  }

  function lineChart(cumulative) {
    var a = perDraw('analysis'), c = perDraw('control');
    if (!a.length && !c.length) return emptyBox();
    var one = (a.length ? a : c).length < 2;
    var labels = (a.length ? a : c).map(function (r) { return '第' + r.draw_number + '回'; });
    function series(rows) {
      var s = 0, n = 0;
      return rows.map(function (r) { if (!cumulative) return r.tickets ? r.sum_main_match / r.tickets : null; s += r.sum_main_match; n += r.tickets; return n ? s / n : null; });
    }
    return chartBox(function (cv) {
      var ref = labels.map(function () { return data.reference_random.mean_matches; });
      return new Chart(cv, { type: 'line', data: { labels: labels, datasets: [
        { label: NAMES.analysis, data: series(a), borderColor: COLORS.analysis, backgroundColor: COLORS.analysis, tension: 0, pointRadius: 3 },
        { label: NAMES.control, data: series(c), borderColor: COLORS.control, backgroundColor: COLORS.control, borderDash: [6, 4], tension: 0, pointRadius: 3 },
        { label: '無作為の期待値 ' + fmt(data.reference_random.mean_matches), data: ref, borderColor: COLORS.ref, borderDash: [2, 3], pointRadius: 0 }
      ] }, options: baseOpts('平均一致数（1口あたり）') });
    });
  }

  function distChart() {
    var rows = rowsFor(data.totals); if (!rows.length) return emptyBox();
    var labels = ['0個', '1個', '2個', '3個', '4個', '5個以上'];
    function dist(r) { var n = r.tickets_checked; return [r.m0, r.m1, r.m2, r.m3, r.m4, r.m5 + r.m5b + r.m6].map(function (v) { return v / n * 100; }); }
    var th = [0, 1, 2, 3, 4].map(function (k) { return hyper(k) * 100; }); th.push((1 - [0, 1, 2, 3, 4].reduce(function (s, k) { return s + hyper(k); }, 0)) * 100);
    var ds = [];
    ['analysis', 'control'].forEach(function (g) { var r = rows.filter(function (x) { return x.grp === g; })[0]; if (r) ds.push({ label: NAMES[g], data: dist(r), backgroundColor: COLORS[g] }); });
    ds.push({ label: '無作為の理論値', data: th, backgroundColor: COLORS.ref });
    return chartBox(function (cv) {
      var o = baseOpts('口の割合（%）', '当せん数字との一致数'); o.scales.y.type = 'logarithmic'; o.scales.y.beginAtZero = false; o.scales.y.min = 0.0001;
      return new Chart(cv, { type: 'bar', data: { labels: labels, datasets: ds }, options: o });
    });
  }

  function elapsedChart() {
    if (state.scope !== 'follow_up') return el('p', { class: 'note', text: '「長期追跡」を選ぶと表示されます（生成後の、対象回以外の抽せんとの照合を、経過月ごとに見ます）。' });
    var rows = data.by_elapsed_30d.filter(function (r) { return r.series === state.series && r.scope === 'follow_up'; });
    if (!rows.length) return emptyBox();
    var months = {}; rows.forEach(function (r) { months[r.month_bucket] = 1; });
    var keys = Object.keys(months).map(Number).sort(function (a, b) { return a - b; });
    function s(g) { return keys.map(function (k) { var r = rows.filter(function (x) { return x.grp === g && x.month_bucket === k; })[0]; return r && r.tickets ? r.sum_main_match / r.tickets : null; }); }
    return chartBox(function (cv) {
      return new Chart(cv, { type: 'line', data: { labels: keys.map(function (k) { return k * 30 + '〜' + (k * 30 + 29) + '日'; }), datasets: [
        { label: NAMES.analysis, data: s('analysis'), borderColor: COLORS.analysis, backgroundColor: COLORS.analysis, pointRadius: 3 },
        { label: NAMES.control, data: s('control'), borderColor: COLORS.control, backgroundColor: COLORS.control, borderDash: [6, 4], pointRadius: 3 },
        { label: '無作為の期待値', data: keys.map(function () { return data.reference_random.mean_matches; }), borderColor: COLORS.ref, borderDash: [2, 3], pointRadius: 0 }
      ] }, options: baseOpts('平均一致数（1口あたり）', '生成からの経過') });
    });
  }

  function exposureChart() {
    var rows = data.exposure_4plus.filter(function (r) { return r.series === state.series; });
    if (!rows.length) return emptyBox();
    var ds = [
      { label: '実際（4個以上を1回以上経験した口）', data: rows.map(function (r) { return r.actual_tickets_with_4plus; }), backgroundColor: '#7aa7ff' },
      { label: '偶然での期待数', data: rows.map(function (r) { return r.expected_tickets_with_4plus; }), backgroundColor: COLORS.ref }
    ];
    return chartBox(function (cv) {
      return new Chart(cv, { type: 'bar', data: { labels: rows.map(function (r) { return NAMES[r.grp] + '（' + r.tickets + '口）'; }), datasets: ds }, options: baseOpts('口数') });
    });
  }

  function batchTable() {
    var rows = data.batches.filter(function (b) { return b.series === state.series; });
    if (!rows.length) return emptyBox();
    var t = el('table'); var head = el('tr');
    ['対象回', '生成日時', '状態', '指紋（SHA-256）', '証拠'].forEach(function (h, i) { head.appendChild(el('th', { text: h, class: i ? 'l' : 'l' })); });
    t.appendChild(head);
    rows.forEach(function (b) {
      var tr = el('tr');
      var a = el('a', { href: '?batch=' + encodeURIComponent(b.batch_id), text: '第' + b.target_draw_number + '回（' + b.target_draw_date + '）' });
      var c0 = el('td', { class: 'l' }); c0.appendChild(a); tr.appendChild(c0);
      tr.appendChild(el('td', { class: 'l', text: jdate(b.generated_at) }));
      tr.appendChild(el('td', { class: 'l', text: STATUS[b.status] || b.status }));
      var c3 = el('td', { class: 'l' }); c3.appendChild(b.commit_hash ? el('code', { text: b.commit_hash }) : document.createTextNode('-')); tr.appendChild(c3);
      tr.appendChild(el('td', { class: 'l', text: EVID[b.evidence_level] || b.evidence_level }));
      t.appendChild(tr);
    });
    return scroll(t);
  }

  function select(id, label, opts, key) {
    var s = el('select', { id: id });
    Object.keys(opts).forEach(function (k) { var o = el('option', { value: k, text: opts[k] }); if (state[key] === k) o.selected = true; s.appendChild(o); });
    s.addEventListener('change', function () { state[key] = s.value; render(); });
    return el('label', { text: label + '：' }, [s]);
  }

  function render() {
    charts.forEach(function (c) { c.destroy(); }); charts = [];
    root.textContent = '';
    var ctrl = el('div', { class: 'ctrl' }, [select('sel-series', '系列', SERIES, 'series'), select('sel-scope', '範囲', SCOPE, 'scope')]);
    root.appendChild(panel('表示の切り替え', [ctrl, el('p', { class: 'note', text: '対象回：予測が指定した抽せんとの照合（正式な実績）。長期追跡：生成後に行われた、対象回以外の抽せんとの照合（別記録）。両者は混ぜません。' })]));
    root.appendChild(panel('概要', [summaryTable()]));
    root.appendChild(panel('抽せん回ごとの平均一致数', [lineChart(false)]));
    root.appendChild(panel('累積の平均一致数', [lineChart(true)]));
    root.appendChild(panel('一致数の分布（縦軸は対数）', [distChart(), el('p', { class: 'note', text: '灰色は、無作為に選んだ場合の理論上の割合です。' })]));
    root.appendChild(panel('生成からの経過と平均一致数', [elapsedChart()]));
    root.appendChild(panel('4個以上の一致：実際と偶然の期待', [exposureChart(), el('p', { class: 'note', text: '同じ口を何回の抽せんと照合したかを考慮した、偶然での期待数です。' })]));
    root.appendChild(panel('記録一覧', [batchTable(), el('p', { class: 'note', text: '指紋は、抽せん前に公開される唯一の情報です。抽せん後に全口を公開し、誰でも指紋を再計算して確かめられます。' })]));
  }

  function sha256Hex(text) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); });
  }

  function renderBatch(id) {
    root.textContent = '';
    root.appendChild(el('p', {}, [el('a', { href: './', text: '← 研究記録の一覧へ' })]));
    fetch(BASE + '/api/public/research/batch/' + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) throw new Error('not found'); return r.json();
    }).then(function (b) {
      var meta = el('div', { class: 'panel' });
      meta.appendChild(el('h2', { text: '第' + b.target_draw_number + '回（' + b.target_draw_date + '）' }));
      [['系列', SERIES[b.series] || b.series], ['生成日時', jdate(b.generated_at)], ['状態', STATUS[b.status] || b.status], ['証拠', EVID[b.evidence_level] || b.evidence_level]].forEach(function (kv) { meta.appendChild(el('div', { text: kv[0] + '：' + kv[1] })); });
      meta.appendChild(el('div', { text: '指紋（SHA-256）：' }, [el('code', { text: b.commit_hash || '-' })]));
      root.appendChild(meta);
      if (!b.tickets) { root.appendChild(panel(null, [el('p', { class: 'note', text: '抽せん前のため、数字は公開していません。抽せん・採点の後に、全口の数字と結果を公開します。' })])); return; }
      var res = el('p', { class: 'note' });
      var btn = el('button', { text: 'ブラウザで指紋を再計算する' });
      btn.addEventListener('click', function () {
        var sorted = b.tickets.slice().sort(function (x, y) { return x.grp === y.grp ? x.ticket_no - y.ticket_no : (x.grp === 'analysis' ? -1 : 1); });
        var text = sorted.map(function (t) { return t.grp + ',' + t.ticket_no + ',' + t.numbers.join('-'); }).join('\n') + '\n';
        sha256Hex(text).then(function (h) { res.textContent = h === b.commit_hash ? '一致しました（' + h + '）。公開された全口は、抽せん前に固定された記録と同じです。' : '一致しません。計算値：' + h; });
      });
      root.appendChild(panel('指紋の確認', [el('p', { class: 'note', text: b.verify || '' }), btn, res]));
      ['analysis', 'control'].forEach(function (g) {
        var list = b.tickets.filter(function (t) { return t.grp === g; });
        var t = el('table'); var head = el('tr');
        ['口', '数字', '一致数', 'ボーナス', '等級相当'].forEach(function (h, i) { head.appendChild(el('th', { text: h, class: i === 1 ? 'l' : '' })); }); t.appendChild(head);
        list.forEach(function (x) {
          var tr = el('tr'); tr.appendChild(el('td', { text: String(x.ticket_no) }));
          var td = el('td', { class: 'l nums' }); x.numbers.forEach(function (n) { td.appendChild(el('span', { text: String(n) })); }); tr.appendChild(td);
          var r = x.target_result || {};
          tr.appendChild(el('td', { text: r.main_match_count == null ? '-' : String(r.main_match_count) }));
          tr.appendChild(el('td', { text: r.bonus_match ? '一致' : '-' }));
          tr.appendChild(el('td', { text: r.equivalent_rank ? r.equivalent_rank + '等相当' : '-' }));
          t.appendChild(tr);
        });
        root.appendChild(panel(NAMES[g] + '（' + list.length + '口）', [scroll(t)]));
      });
    }).catch(function () { root.appendChild(panel(null, [el('p', { text: 'この記録は見つかりません。' })])); });
  }

  var q = new URLSearchParams(location.search).get('batch');
  if (q) { renderBatch(q); return; }
  fetch(BASE + '/api/public/research').then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); }).then(function (d) {
    data = d;
    if (!d.batches.length) { root.textContent = ''; root.appendChild(panel('研究記録', [emptyBox(), el('p', { class: 'note', text: d.notice })])); return; }
    // 既定：データのある系列を選ぶ
    var has = d.batches.some(function (b) { return b.series === 'auto'; }); if (!has) state.series = 'pilot_manual';
    render();
  }).catch(function () { root.textContent = ''; root.appendChild(panel('研究記録', [el('p', { text: '読み込めませんでした。時間をおいて、もう一度お試しください。' })])); });
})();
