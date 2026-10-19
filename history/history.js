(function () {
  const totalCountEl = document.getElementById('totalCount');
  const listEl = document.getElementById('historyList');
  const emptyStateEl = document.getElementById('emptyState');

  function formatTimestamp(isoString) {
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function numbersText(numbers) { return numbers.map(n => String(n).padStart(2,'0')).join('  '); }
  function renderItem(record) {
    const el = document.createElement('article');
    el.className = 'history-item';
    const tracking = record.resultStatus === 'matched'
      ? `<span class="status-pill status-pill--matched">最高 ${record.matchCount}個一致</span>`
      : `<span class="status-pill">永久追跡中</span>`;
    el.innerHTML = `
      <div class="history-item__top"><span>${record.predictionId}</span><span>PERMANENT TRACKING</span></div>
      <div class="history-item__numbers">${numbersText(record.numbers)}</div>
      <div class="history-item__bottom"><span>${formatTimestamp(record.generatedAt)}</span>${tracking}</div>`;
    return el;
  }
  async function render() {
    const records = await window.LotoStorage.getAllPredictions();
    const count = await window.LotoStorage.getPredictionCount();
    totalCountEl.textContent = String(count);
    if (!records.length) { emptyStateEl.style.display='block'; return; }
    emptyStateEl.style.display='none';
    const fragment=document.createDocumentFragment();
    records.forEach(r=>fragment.appendChild(renderItem(r)));
    listEl.replaceChildren(fragment);
  }
  render();
})();
