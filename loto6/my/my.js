/**
 * my.js — 「マイ予測」ページ。
 *
 * 設計：
 * ・D1が正本。ここで表示する内容は必ず /api/my-predictions への
 *   POSTで都度取得したものであり、ブラウザ側に予測データそのものは
 *   保存しない（保存するのはaccess_token文字列のみ）。
 * ・access_tokenは256bit乱数の秘密値であり、これを知っている本人だけが
 *   その購入内容を見られる（URLを知っているだけでは見えない設計）。
 * ・localStorageは「どの購入が自分のものか」を覚えておくためのポインタ
 *   （access_tokenのリスト）を持つだけで、公開予測履歴や他の購入者の
 *   情報とは完全に役割を分離している。
 */
(function () {
  const MY_TOKENS_KEY = 'loto6_my_access_tokens';
  const listEl = document.getElementById('list');
  const tokenInput = document.getElementById('tokenInput');
  const addBtn = document.getElementById('addBtn');
  const recoverForm = document.getElementById('recoverForm');
  const recoverEmail = document.getElementById('recoverEmail');
  const recoverBtn = document.getElementById('recoverBtn');
  const recoverStatus = document.getElementById('recoverStatus');

  const PLAN_LABELS = {
    single: '1予測（¥300）',
    pack10: '10予測（¥3,000）',
    pack30: '30予測（¥9,000）',
    pack50: '50予測（¥15,000）',
  };

  function loadTokens() {
    try {
      return JSON.parse(localStorage.getItem(MY_TOKENS_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveTokens(list) {
    try {
      localStorage.setItem(MY_TOKENS_KEY, JSON.stringify(list));
    } catch (_) {
      /* noop */
    }
  }

  function removeToken(token) {
    saveTokens(loadTokens().filter((t) => t !== token));
  }

  function addToken(token) {
    const list = loadTokens();
    if (!list.includes(token)) {
      list.unshift(token);
      saveTokens(list);
    }
  }

  function trackingLabel(t) {
    if (!t) return '追跡データなし';
    if (t.best_equivalent_rank) {
      return `最高${t.best_equivalent_rank}等相当（一致${t.best_main_match_count}個）`;
    }
    if (t.checked_draw_count > 0) {
      return `照合${t.checked_draw_count}回・最高一致${t.best_main_match_count}個`;
    }
    return '照合待ち';
  }

  function renderPurchase(token, data) {
    const el = document.createElement('section');
    el.className = 'purchase';
    const planLabel = PLAN_LABELS[data.plan_code] || data.plan_code;
    const purchasedAt = data.purchased_at ? new Date(data.purchased_at).toLocaleString('ja-JP') : '不明';
    el.innerHTML = `
      <div class="purchase__head">
        <div>
          <strong>${planLabel}</strong><br />
          <span>購入日時: ${purchasedAt}　/　購入数: ${data.purchase_count}件</span>
        </div>
        <button class="remove-btn" type="button" data-remove>この端末の一覧から外す</button>
      </div>
      <div class="preds"></div>
    `;
    const predsEl = el.querySelector('.preds');
    data.predictions.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'pred-row';
      row.innerHTML = `
        <div class="balls">${p.numbers.map((n) => `<span class="ball">${String(n).padStart(2, '0')}</span>`).join('')}</div>
        <div class="pid">${p.prediction_id}</div>
        <div class="track">${trackingLabel(p.tracking)}</div>
      `;
      predsEl.appendChild(row);
    });
    el.querySelector('[data-remove]').addEventListener('click', () => {
      removeToken(token);
      el.remove();
    });
    return el;
  }

  async function fetchAndRender(token) {
    const apiBase = window.ApiConfig && window.ApiConfig.BASE_URL;
    try {
      const res = await fetch(`${apiBase}/api/my-predictions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      if (res.status === 404) {
        // 無効・存在しないアクセスキー。この端末の一覧からは静かに外す
        // （他人のトークンを推測して連投しても、区別できる情報は返さない）。
        removeToken(token);
        return null;
      }
      if (!res.ok) throw new Error(`http_${res.status}`);
      return await res.json();
    } catch (err) {
      const box = document.createElement('p');
      box.className = 'error';
      box.textContent = '一部の購入情報を取得できませんでした。時間をおいて再読み込みしてください。';
      listEl.appendChild(box);
      return null;
    }
  }

  async function renderAll() {
    listEl.textContent = '読み込み中…';
    const tokens = loadTokens();
    if (tokens.length === 0) {
      listEl.innerHTML = '<p class="note">この端末にはまだ購入記録がありません。購入後の結果ページから自動的にここへ追加されます。</p>';
      return;
    }
    listEl.textContent = '';
    for (const token of tokens) {
      const data = await fetchAndRender(token);
      if (data) listEl.appendChild(renderPurchase(token, data));
    }
    if (!listEl.children.length) {
      listEl.innerHTML = '<p class="note">表示できる購入情報がありませんでした。</p>';
    }
  }

  addBtn.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (!token) return;
    addBtn.disabled = true;
    addToken(token);
    tokenInput.value = '';
    await renderAll();
    addBtn.disabled = false;
  });

  /**
   * 「アクセスキーが分からなくなった場合」の復旧フロー・その1。
   * メールアドレスを送るだけで、該当する購入があるかどうかを本ページからは
   * 判別できない応答にする（サーバー側のenumeration対策と同じ考え方を
   * フロント側でも壊さない＝常に同じ文言を表示する）。
   */
  if (recoverForm) {
    recoverForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = recoverEmail.value.trim();
      if (!email) return;
      recoverBtn.disabled = true;
      recoverStatus.textContent = '送信中…';
      try {
        const apiBase = window.ApiConfig && window.ApiConfig.BASE_URL;
        const res = await fetch(`${apiBase}/api/my-predictions/recover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const body = await res.json().catch(() => null);
        recoverStatus.textContent =
          (body && (body.message || (body.error && body.error.message))) ||
          '確認リンクをお送りしました（該当する購入がない場合は届きません）。';
      } catch (_) {
        recoverStatus.textContent = '送信に失敗しました。時間をおいて再度お試しください。';
      } finally {
        recoverBtn.disabled = false;
        recoverEmail.value = '';
      }
    });
  }

  /**
   * 復旧フロー・その2。メールのリンクを踏んで ?recover=<token> 付きで
   * 到着した場合、その場でサーバーへ引き換えて新しいaccess_tokenを
   * 受け取り、この端末のlocalStorageへ記録する。
   * recovery_token自体は単回使用・短命であり、引き換え後はURLから
   * 即座に取り除く（画面にもURLにも恒久的には残さない）。
   * D1が正本：ここで新しく発行されるaccess_tokenが「現在有効な」鍵であり、
   * 古い（見えなくなった）access_tokenは復旧により失効する。
   */
  async function redeemRecoveryTokenFromUrl() {
    const params = new URLSearchParams(location.search);
    const recoveryToken = params.get('recover');
    if (!recoveryToken) return;

    // 何が起きてもURLからrecoveryトークンは必ず取り除く（誤って共有・再読み込みされないように）。
    params.delete('recover');
    const cleanUrl = location.pathname + (params.toString() ? `?${params.toString()}` : '');
    history.replaceState(history.state, '', cleanUrl);

    listEl.textContent = '購入履歴を復元しています…';
    try {
      const apiBase = window.ApiConfig && window.ApiConfig.BASE_URL;
      const res = await fetch(`${apiBase}/api/my-predictions/recover/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recovery_token: recoveryToken }),
      });
      if (!res.ok) {
        listEl.innerHTML = '<p class="error">このリンクは無効か、有効期限が切れています。もう一度メールアドレスから確認リンクを送ってください。</p>';
        return;
      }
      const body = await res.json();
      (body.payments || []).forEach((p) => addToken(p.access_token));
      recoverStatus.textContent = `${(body.payments || []).length}件の購入履歴を復元しました。`;
    } catch (_) {
      listEl.innerHTML = '<p class="error">購入履歴の復元に失敗しました。時間をおいて再度お試しください。</p>';
    }
  }

  (async () => {
    await redeemRecoveryTokenFromUrl();
    renderAll();
  })();
})();
