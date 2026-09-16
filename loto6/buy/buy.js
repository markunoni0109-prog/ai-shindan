/**
 * buy.js
 * ------------------------------------------------------------------
 * 「購入して5口を生成する」ボタン → Worker(/api/checkout/create) →
 * Stripe Checkoutへリダイレクトするだけの薄い層。
 * 金額・商品はサーバー側固定（ここでは一切扱わない）。
 * ------------------------------------------------------------------
 */
(function () {
  const buyBtn = document.getElementById('buyBtn');
  const errorMsg = document.getElementById('errorMsg');

  buyBtn.addEventListener('click', async () => {
    buyBtn.disabled = true;
    errorMsg.classList.remove('is-visible');
    try {
      const res = await fetch(`${window.ApiConfig.BASE_URL}/api/checkout/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_code: 'five' }),
      });
      if (!res.ok) throw new Error('checkout create failed');
      const body = await res.json();

      // 購入導線中のみの一時保持（正本はサーバー側entitlement）。
      // fragmentでも渡すため必須ではないが、フォールバックとして保存する。
      sessionStorage.setItem('loto6_claim_token', body.claim_token);

      window.location.href = body.checkout_url;
    } catch (err) {
      errorMsg.classList.add('is-visible');
      buyBtn.disabled = false;
    }
  });
})();
