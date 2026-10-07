/**
 * history.js
 * ------------------------------------------------------------------
 * 履歴一覧の描画。storage.js から読み取るだけで、書き込みは行わない。
 * 抽選結果の自動取得は未実装（仕様§11）。
 * resultStatus が 'matched' のレコードが将来出てきた場合に備え、
 * 当選数字・一致数の表示にも対応させてある。
 * ------------------------------------------------------------------
 */

(function () {
  const totalCountEl = document.getElementById('totalCount');
  const listEl = document.getElementById('historyList');
  const emptyStateEl = document.getElementById('emptyState');

  function formatTimestamp(isoString) {
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  function numbersText(numbers) {
    return numbers.map((n) => String(n).padStart(2, '0')).join('  ');
  }

  function renderItem(record) {
    const el = document.createElement('article');
    el.className = 'history-item';

    const statusPill =
      record.resultStatus === 'matched'
        ? `<span class="status-pill status-pill--matched">${record.matchCount}個一致</span>`
        : `<span class="status-pill">結果待ち</span>`;

    const winningLine =
      record.resultStatus === 'matched' && record.winningNumbers
        ? `<div class="history-item__numbers" style="color:var(--text-dim); font-size:14px;">当選数字　${numbersText(
            record.winningNumbers
          )}</div>`
        : '';

    el.innerHTML = `
      <div class="history-item__top">
        <span>${record.predictionId}</span>
        <span>第${record.drawNumber}回</span>
      </div>
      <div class="history-item__numbers">${numbersText(record.numbers)}</div>
      ${winningLine}
      <div class="history-item__bottom">
        <span>${formatTimestamp(record.generatedAt)}</span>
        ${statusPill}
      </div>
    `;
    return el;
  }

  async function render() {
    const records = await window.LotoStorage.getAllPredictions();
    const count = await window.LotoStorage.getPredictionCount();

    totalCountEl.textContent = String(count);

    if (records.length === 0) {
      emptyStateEl.style.display = 'block';
      return;
    }

    emptyStateEl.style.display = 'none';
    const fragment = document.createDocumentFragment();
    records.forEach((record) => fragment.appendChild(renderItem(record)));
    listEl.appendChild(fragment);
  }

  render();
})();
