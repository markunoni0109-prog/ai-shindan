/**
 * LOTO6 NEXUS paid checkout launcher.
 * The home CTA never generates numbers locally. It creates a server-side
 * Checkout Session for the fixed "single" plan (JPY 300) and redirects to Stripe.
 * Prediction generation happens only after a paid webhook has fulfilled the entitlement.
 */
(function () {
  const generateBtn = document.getElementById('generateBtn');
  const errorMsg = document.getElementById('errorMsg');
  let busy = false;

  async function startCheckout() {
    if (busy) return;
    busy = true;
    generateBtn.disabled = true;
    errorMsg.classList.remove('is-visible');

    try {
      const apiBase = window.ApiConfig && window.ApiConfig.BASE_URL;
      if (!apiBase || apiBase.includes('REPLACE_WITH_WORKER_URL')) {
        throw new Error('api_not_configured');
      }
      const res = await fetch(`${apiBase}/api/checkout/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_code: 'single' }),
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
