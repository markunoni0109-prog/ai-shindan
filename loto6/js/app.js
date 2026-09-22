/**
 * LOTO6 NEXUS paid checkout launcher.
 * The home CTA never generates numbers locally. It creates a server-side
 * Checkout Session for the selected plan (single/pack10/pack30/pack50) and
 * redirects to Stripe. Prediction generation happens only after a paid
 * webhook has fulfilled the entitlement.
 *
 * 【プラン選択】画面上部の.plan-pickerで選んだプランのplan_codeをそのまま
 * checkout/create へ送る。金額はサーバー側(PLAN_CATALOG)で決まるため、
 * ここで送るamount/countは表示更新にしか使わない（サーバーは信用しない）。
 *
 * 【QAモードの安全設計】
 * URLに ?qa=1 が付いている間は、CTAを押しても本番Stripeへは絶対に
 * 進ませない（/api/checkout/createを一切呼ばない）。QAモードは
 * 「実決済なしで演出を確認する」ためのものであり、実際にCTAを押すと
 * 本番決済に進んでしまっていたのは事故のもとだったため、ここで
 * 明示的に遮断し、代わりに無料QA用の結果演出プレビューへ誘導する。
 */
(function () {
  const generateBtn = document.getElementById('generateBtn');
  const errorMsg = document.getElementById('errorMsg');
  const planPicker = document.getElementById('planPicker');
  const priceLabel = document.getElementById('priceLabel');
  const priceValue = document.getElementById('priceValue');
  const ctaTitle = document.getElementById('ctaTitle');
  const ctaAmount = document.getElementById('ctaAmount');
  let busy = false;

  function isQaMode() {
    return new URLSearchParams(location.search).get('qa') === '1';
  }

  function selectedPlan() {
    const active = planPicker && planPicker.querySelector('.plan-chip.is-selected');
    return {
      planCode: (active && active.dataset.plan) || 'single',
      amount: Number((active && active.dataset.amount) || 300),
      count: Number((active && active.dataset.count) || 1),
    };
  }

  function updatePriceDisplay() {
    const { amount, count } = selectedPlan();
    const amountText = '¥' + amount.toLocaleString('ja-JP');
    if (priceLabel) priceLabel.textContent = count === 1 ? '1 PREDICTION' : `${count} PREDICTIONS`;
    if (priceValue) priceValue.textContent = amountText;
    if (ctaAmount) ctaAmount.textContent = amountText;
    if (ctaTitle) ctaTitle.textContent = count === 1 ? 'AI予測を生成' : `AI予測を${count}件まとめて生成`;
    if (generateBtn) generateBtn.setAttribute('aria-label', `${amountText}でAI予測を${count}件生成`);
  }

  if (planPicker) {
    planPicker.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.plan-chip');
      if (!btn || busy) return;
      planPicker.querySelectorAll('.plan-chip').forEach((el) => {
        el.classList.remove('is-selected');
        el.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('is-selected');
      btn.setAttribute('aria-checked', 'true');
      updatePriceDisplay();
    });
  }
  updatePriceDisplay();

  async function startCheckout() {
    if (busy) return;

    if (isQaMode()) {
      // 【安全設計】QAモード中はCTAを押しても本番Stripeには一切進まない。
      // 実決済なしで確認できる無料QA（結果演出プレビュー）へ誘導する。
      const { count } = selectedPlan();
      location.href = `result/index.html?qa=1&count=${count}`;
      return;
    }

    busy = true;
    generateBtn.disabled = true;
    errorMsg.classList.remove('is-visible');

    try {
      const apiBase = window.ApiConfig && window.ApiConfig.BASE_URL;
      if (!apiBase || apiBase.includes('REPLACE_WITH_WORKER_URL')) {
        throw new Error('api_not_configured');
      }
      const { planCode } = selectedPlan();
      const res = await fetch(`${apiBase}/api/checkout/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_code: planCode }),
      });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (!res.ok) {
        const code = body && body.error && body.error.code ? body.error.code : `http_${res.status}`;
        throw new Error(code);
      }
      if (!body.checkout_url || !body.claim_token) throw new Error('invalid_checkout_response');

      // Temporary browser fallback only. The authoritative entitlement is server-side.
      sessionStorage.setItem('loto6_claim_token', body.claim_token);
      if (body.access_token) sessionStorage.setItem('loto6_access_token', body.access_token);
      location.assign(body.checkout_url);
    } catch (err) {
      console.error('Checkout start failed', err);
      const safeCode = String(err && err.message || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
      errorMsg.textContent = `決済ページを開けませんでした（${safeCode}）。`;
      errorMsg.classList.add('is-visible');
      generateBtn.disabled = false;
      busy = false;
    }
  }

  generateBtn.addEventListener('click', startCheckout);
})();
