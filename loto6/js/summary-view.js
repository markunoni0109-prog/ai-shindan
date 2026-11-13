/**
 * summary-view.js
 * 全体の追跡成績（集計のみ）を表示する。個別の予測数字は一切扱わない。
 * データ元: GET /api/public/summary
 *   - 全体成績ページ（predictions/）: data-mode="overall"
 *   - 研究データページ（data/）      : data-mode="research"
 */
(function () {
  var root = document.getElementById('summary-root');
  if (!root) return;
  var mode = root.getAttribute('data-mode') || 'overall';
  var base = (window.ApiConfig && window.ApiConfig.BASE_URL) || '';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) {
    return Number(n || 0).toLocaleString('ja-JP');
  }
  function pct(p) {
    return (Number(p) * 100).toFixed(p < 0.001 ? 4 : 2) + '%';
  }

  /** 一致数の分布表。5個はボーナス一致を含めて表示する（基準値の5個と対応させるため） */
  function distTable(dist, probs, totalComparisons, caption) {
    var rows = '';
    for (var k = 0; k <= 6; k++) {
      var actual = k === 5 ? Number(dist['5'] || 0) + Number(dist['5+B'] || 0) : Number(dist[String(k)] || 0);
      var expected = totalComparisons > 0 ? probs[k] * totalComparisons : 0;
      var label = k === 5 ? '5個（ボーナス一致を含む）' : k + '個';
      rows +=
        '<tr><td>' + label + '</td><td>' + num(actual) + '</td><td>' +
        (totalComparisons > 0 ? expected.toFixed(expected < 10 ? 2 : 1) : '-') +
        '</td><td>' + pct(probs[k]) + '</td></tr>';
    }
    return (
      '<table class="sv-table"><caption>' + esc(caption) + '（実績は回数。期待回数は、純ランダムな6数字なら偶然で起こる回数の理論値）</caption>' +
      '<thead><tr><th>一致数</th><th>実績</th><th>期待回数</th><th>確率</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>'
    );
  }

  function render(s) {
    var f = s.forward_tracking || {};
    var h = s.historical_backtest || {};
    var ref = s.reference_random || {};
    var probs = ref.per_comparison_probability || {};
    var fwdTotal = Number(f.comparisons || 0);
    var histTotal = 0;
    Object.keys(h.match_distribution || {}).forEach(function (k) {
      histTotal += Number(h.match_distribution[k] || 0);
    });

    var html = '';
    html +=
      '<section class="panel"><h2>保存の状況</h2>' +
      '<p>保存した予測：<strong>' + num(s.total_predictions) + '</strong>件 ／ 生成後に照合した抽せん：<strong>' +
      num(f.draws_checked) + '</strong>回 ／ 照合の延べ件数：<strong>' + num(fwdTotal) + '</strong></p>' +
      '<p class="note">外れた予測も削除しません。個別の予測数字・個別の照合結果は購入者本人のみが閲覧でき、ここには表示しません。</p></section>';

    html +=
      '<section class="panel"><h2>生成後の追跡成績（全体）</h2>' +
      (fwdTotal > 0
        ? distTable(f.match_distribution || {}, probs, fwdTotal, '生成後の抽せんとの一致数の分布')
        : '<p>生成後に照合した抽せんは、まだありません。</p>') +
      '<p>等級別（○等相当）：' +
      [1, 2, 3, 4, 5]
        .map(function (r) {
          return r + '等 ' + num((f.rank_counts || {})[r]);
        })
        .join('・') +
      '</p>' +
      '<p class="note">当せん確率は、どの6数字でも同じです。右の「期待回数」は、純ランダムな6数字を同じ回数だけ照合した場合の理論値で、実績がこれに近いほど、偶然の範囲と言えます。</p></section>';

    var cg = s.control_group || {};
    html +=
      '<section class="panel"><h2>ランダム対照群との比較</h2>' +
      (cg.status === 'preparing'
        ? '<p>準備中です。AI生成と純ランダムを同じ条件・同じ口数で記録し、差がなければ「差なし」と、そのまま公表します。</p>'
        : '<p>' + esc(JSON.stringify(cg)) + '</p>') +
      '</section>';

    if (mode === 'research') {
      html +=
        '<section class="panel"><h2>過去全抽せんとの照合（全体）</h2>' +
        (histTotal > 0
          ? distTable(h.match_distribution || {}, probs, histTotal, '生成以前の抽せんとの一致数の分布')
          : '<p>まだ集計がありません。</p>') +
        '<p class="note">' + esc(h.note || '') + ' 過去の抽せんとの一致は、純ランダムな数字でも多く起こります。例えば、2,127回と照合すると、どんな6数字でも4個以上の一致が1回以上ある確率は約97%です。一致の多さは、実力の証拠ではありません。</p></section>';
    }

    var c = s.chain || {};
    html +=
      '<section class="panel"><h2>記録の改ざん防止</h2>' +
      '<p>記録件数：' + num(c.length) + '件</p>' +
      '<p class="note">最新のハッシュ：<code>' + esc(c.head_hash || '（まだありません）') + '</code></p></section>';

    root.innerHTML = html;
  }

  if (!base) {
    root.textContent = '設定を読み込めませんでした。';
    return;
  }
  fetch(base + '/api/public/summary')
    .then(function (r) {
      if (!r.ok) throw new Error('http_' + r.status);
      return r.json();
    })
    .then(render)
    .catch(function () {
      root.innerHTML = '<p class="note">集計を取得できませんでした。時間をおいて再読み込みしてください。</p>';
    });
})();
