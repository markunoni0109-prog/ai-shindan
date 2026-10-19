/**
 * LOTO6 NEXUS 無料公開ベータ(FREE PUBLIC BETA) 生成ランチャー。
 *
 * 【重要：FREE PUBLIC BETA中の挙動】
 * 現在、有料Stripe決済の公開導線は休止中（サーバー側もPAID_CHECKOUT_DISABLED
 * フラグで /api/checkout/create 自体を休眠させている）。ホームのCTAは
 * 数字をローカル生成せず、サーバー側の /api/free/generate を呼んで
 * 無料entitlement(claim_token)を受け取り、result ページで
 * /api/predictions/claim（変更なし）から実際の6数字を取得する。
 * 24時間に1回という制限はサーバー側(D1)で原子的に強制される
 * （このJSはUIの案内を出すだけで、制限そのものの防衛線ではない）。
 *
 * Stripe/決済関連のコードは削除せず、このファイル内にコメントアウトの
 * 形で温存する。有料再開時は、この無料生成ブロックをコメントアウトし、
 * 下の「有料Stripe決済（休止中・削除せず温存）」ブロックを戻すだけでよい。
 * サーバー側もPAID_CHECKOUT_DISABLEDフラグを外すだけで即座に有効化できる
 * （Stripe/Webhook/D1購入系のコード自体は無変更。現行の販売プランは5予測¥300（pack5）のみ。）
 *
 * 【匿名ユーザー識別(anon_id)】
 * ブラウザのlocalStorageにcrypto.randomUUID()を1つだけ保存し、
 * 以後は同じ端末・同じブラウザである限りこのIDを使い続ける（cookieは
 * 使わない。既存のclaim_token/access_token等と同じ「明示的トークンを
 * リクエストボディで送る」設計に揃えている）。
 *
 * 【QAモードの安全設計】
 * URLに ?qa=1 が付いている間は、CTAを押しても実際のAPI呼び出しは一切
 * 行わない（/api/free/generateも/api/checkout/createも呼ばない）。
 * QAモードは「実際の生成・保存なしで演出を確認する」ためのものであり、
 * 代わりに無料QA用の結果演出プレビューへ誘導する。
 */
(function () {
  const generateBtn = document.getElementById('generateBtn');
  const errorMsg = document.getElementById('errorMsg');
  let busy = false;

  function isQaMode() {
    return new URLSearchParams(location.search).get('qa') === '1';
  }

  const ANON_ID_KEY = 'loto6_anon_id';
  function getOrCreateAnonId() {
    try {
      let id = localStorage.getItem(ANON_ID_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(ANON_ID_KEY, id);
      }
      return id;
    } catch (_) {
      // localStorageが使えない環境（プライベートブラウズ等）向けの
      // フォールバック。永続はしないが、その場のリクエストは動作する。
      return crypto.randomUUID();
    }
  }

  async function startFreeGenerate() {
    if (busy) return;

    if (isQaMode()) {
      // 【安全設計】QAモード中はCTAを押しても実際のAPIには一切進まない。
      // 実際の生成・保存なしで確認できる無料QA（結果演出プレビュー）へ誘導する。
      location.href = `/loto6/result/index.html?qa=1&count=1`;
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

      const anonId = getOrCreateAnonId();
      const res = await fetch(`${apiBase}/api/free/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anon_id: anonId }),
      });
      let body = null;
      try { body = await res.json(); } catch (_) {}
      if (!res.ok) {
        const code = body && body.error && body.error.code ? body.error.code : `http_${res.status}`;
        if (code === 'free_limit_not_elapsed') {
          const nextAt = body && body.error && body.error.next_available_at;
          const err = new Error('free_limit_not_elapsed');
          err.nextAvailableAt = nextAt;
          throw err;
        }
        throw new Error(code);
      }
      if (!body.claim_token) throw new Error('invalid_free_generate_response');

      // claim_tokenだけをsessionStorageへ一時保存し、resultページで
      // /api/predictions/claim（変更なし）に渡す。無料枠には
      // 「マイ予測」(access_token)は無い（有料購入者専用の機能のため）。
      sessionStorage.setItem('loto6_claim_token', body.claim_token);
      sessionStorage.removeItem('loto6_access_token');
      location.assign('/loto6/result/index.html');
    } catch (err) {
      console.error('Free generate start failed', err);
      if (err && err.message === 'free_limit_not_elapsed') {
        let when = 'しばらく時間をおいて';
        if (err.nextAvailableAt) {
          try {
            when = new Date(err.nextAvailableAt).toLocaleString('ja-JP') + '以降に';
          } catch (_) {}
        }
        errorMsg.textContent = `無料枠は24時間に1回までです。${when}再度お試しください。`;
      } else {
        const safeCode = String((err && err.message) || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
        errorMsg.textContent = `AI数字分析を生成できませんでした（${safeCode}）。`;
      }
      errorMsg.classList.add('is-visible');
      generateBtn.disabled = false;
      busy = false;
    }
  }

  // 有料化に伴い、無料生成のクリック登録は外した（startFreeGenerateは温存）。
  // generateBtn.addEventListener('click', startFreeGenerate);

  /* ============================================================
   * 【有料Stripe決済（稼働）】プラン選択→/api/checkout/create→Stripe Checkout。
   * 無料生成(startFreeGenerate)は削除せず温存（FREE BETA再開時用）。
   * ============================================================ */
  // 販売プランは5予測・300円（pack5）のみ。金額・件数はサーバー側(plans.js)が正本。
  const PLAN_CODE = 'pack5';
  const PLAN_COUNT = 5;

  async function startCheckout() {
    if (busy) return;
    if (isQaMode()) {
      location.href = `/loto6/result/index.html?qa=1&count=${PLAN_COUNT}`;
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
            const res = await fetch(`${apiBase}/api/checkout/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_code: PLAN_CODE }),
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
