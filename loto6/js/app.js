/**
 * LOTO6 NEXUS paid checkout launcher.
 * iPhone CTA layout fix included.
 */
(function () {
  const generateBtn = document.getElementById('generateBtn');
  const errorMsg = document.getElementById('errorMsg');
  const planPicker = document.getElementById('planPicker');
  const priceLabel = document.getElementById('priceLabel');
  const priceValue = document.getElementById('priceValue');
  const ctaTitle = document.getElementById('ctaTitle');
  const ctaAmount = document.getElementById('ctaAmount');
  const ctaCopy = generateBtn && generateBtn.querySelector('.generate-btn__copy');
  const ctaMeta = ctaCopy && ctaCopy.querySelector('em');
  let busy = false;

  /* iPhone幅でまとめ買い文言が重ならないための限定補正。
     PCや結果画面には影響させない。 */
  const fixStyle = document.createElement('style');
  fixStyle.textContent = `
    @media (max-width: 430px) {
      .nexus-stage .nexus-generate-btn {
        grid-template-columns: 42px minmax(0,1fr) 42px;
        gap: 7px;
        padding-left: 10px;
        padding-right: 10px;
      }
      .nexus-stage .nexus-generate-btn .generate-btn__copy {
        min-width: 0;
        width: 100%;
      }
      .nexus-stage .nexus-generate-btn .generate-btn__copy strong {
        display: block;
        width: 100%;
        min-height: 44px;
        font-size: 18px;
        line-height: 1.22;
        letter-spacing: 0;
        text-align: center;
        word-break: keep-all;
        overflow-wrap: normal;
      }
      .nexus-stage .nexus-generate-btn .generate-btn__copy em {
        display: block;
        margin-top: 5px;
        font-size: 10px;
        line-height: 1.2;
        white-space: nowrap;
      }
      .nexus-stage .nexus-generate-btn .generate-btn__copy b {
        font-size: 14px;
        margin-left: 5px;
      }
    }
    @media (max-width: 380px) {
      .nexus-stage .nexus-generate-btn .generate-btn__copy strong {
        font-size: 17px;
      }
    }
  `;
  document.head.appendChild(fixStyle);

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

  function setCtaMeta(count, amountText) {
    if (!ctaMeta) return;
    while (ctaMeta.firstChild && ctaMeta.firstChild !== ctaAmount) {
      ctaMeta.removeChild(ctaMeta.firstChild);
    }
    ctaMeta.insertBefore(
      document.createTextNode(count === 1 ? '1 PREDICTION ' : `${count} PREDICTIONS `),
      ctaAmount
    );
    ctaAmount.textContent = amountText;
  }

  function updatePriceDisplay() {
    const { amount, count } = selectedPlan();
    const amountText = '¥' + amount.toLocaleString('ja-JP');
    if (priceLabel) priceLabel.textContent = count === 1 ? '1 PREDICTION' : `${count} PREDICTIONS`;
    if (priceValue) priceValue.textContent = amountText;
    setCtaMeta(count, amountText);
    if (ctaTitle) {
      ctaTitle.textContent = count === 1 ? 'AI予測を生成' : `AI予測を${count}件まとめて生成`;
    }
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
