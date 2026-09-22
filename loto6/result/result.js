/**
 * result.js
 * ------------------------------------------------------------------
 * successページの中核。
 *
 * 重要：「successページへ到着した＝購入権発行」ではない。
 * ここでは必ず /api/purchases/status をpollしてreadyを確認してから
 * claimへ進む。サーバー保存成功前（claim成功前）に数字を演出表示しない。
 *
 * 演出タイミングはPhase 1と同一（1〜5球目0.4秒間隔、5→6球目のみ1.0秒）。
 * 1件購入時はこの演出のみ（現行仕様を完全維持）。
 *
 * 【まとめ買い（10/30/50予測）対応】
 * 1件目だけ従来どおりのフル演出（ボヨーン×6→ズン）で「AIが考えている」
 * 雰囲気を出し、2件目以降は待ち時間が異常に長くならないよう、6球を
 * 一度に軽くポップ表示する簡易演出（QUICK_REVEAL_STEP_MS間隔）に切り替える。
 * どちらの場合も最終的に全件がresultsListに一覧表示され、8秒
 * （まとめ買いはBULK_RESULT_HOLD_MS）保持後に/loto6/へ自動遷移する。
 * 演出後は「マイ予測」からいつでも同じ内容を再確認できる
 * （access_tokenをlocalStorageへ登録する。D1が正本で、localStorageは
 * 「どの購入が自分のものか」を覚えておくためのポインタに過ぎない）。
 *
 * Stripe/Webhook/DB/生成/保存/Permanent Trackingのロジックには一切
 * 手を入れていない（claimPredictions/pollPurchaseStatusは変更なし）。
 *
 * 【無料QAモード（実決済不要）】
 * URLに ?qa=1 を付けて開くと、pollPurchaseStatus/claimPredictionsの
 * fetchを一切実行せず（＝Stripe/Webhook/D1へは何も通信しない）、
 * その場で作ったダミーの予測だけを使い、実際の演出コードをそのまま
 * 通しで実行する。?qa=1&count=10 のように件数を指定すると、まとめ買い
 * 演出（簡易演出＋一覧）も実決済なしで確認できる。QAモードでは
 * 「保存されました」等、実際には行っていない保存を示す文言は一切
 * 表示しない（QA専用の文言に分離する）。
 * 例：https://ai-hunter.jp/loto6/result/index.html?qa=1
 *     https://ai-hunter.jp/loto6/result/index.html?qa=1&count=30
 * ------------------------------------------------------------------
 */
(function () {
  const API_BASE = window.ApiConfig.BASE_URL;

  const stageDim = document.getElementById('stageDim');
  const statusLabel = document.getElementById('statusLabel');
  const statusDots = document.getElementById('statusDots');
  const ballRow = document.getElementById('ballRow');
  const ballEls = Array.from(ballRow.querySelectorAll('.ball'));
  const progressLabel = document.getElementById('progressLabel');
  const errorMsg = document.getElementById('errorMsg');
  const resultsList = document.getElementById('resultsList');
  const redirectNote = document.getElementById('redirectNote');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));
  // 表示保持だけは「動き」ではないので、reduced-motionでも短縮しない。
  const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const RESULT_HOLD_MS = 8000; // 1件購入時：完成数字を大きく保持する時間（約8秒、現行仕様を維持）
  const BULK_RESULT_HOLD_MS = 4000; // まとめ買い時：一覧はマイ予測からいつでも再確認できるため短縮
  const QUICK_REVEAL_STEP_MS = 220; // まとめ買い2件目以降の1件あたりの表示間隔

  const MY_TOKENS_KEY = 'loto6_my_access_tokens';

  function getClaimToken() {
    const hashMatch = location.hash.match(/claim=([^&]+)/);
    if (hashMatch) {
      const token = decodeURIComponent(hashMatch[1]);
      sessionStorage.setItem('loto6_claim_token', token);
      return token;
    }
    return sessionStorage.getItem('loto6_claim_token');
  }

  function getAccessToken() {
    const hashMatch = location.hash.match(/access=([^&]+)/);
    if (hashMatch) {
      const token = decodeURIComponent(hashMatch[1]);
      sessionStorage.setItem('loto6_access_token', token);
      return token;
    }
    return sessionStorage.getItem('loto6_access_token');
  }

  /**
   * 「マイ予測」で後日再閲覧できるよう、access_token（購入の鍵）だけを
   * ブラウザに覚えさせておく。保存するのはトークン文字列のみで、
   * 予測データそのものは保存しない（表示のたびに必ずD1から取得し直す）。
   */
  function rememberAccessToken(token) {
    if (!token) return;
    try {
      const list = JSON.parse(localStorage.getItem(MY_TOKENS_KEY) || '[]');
      if (!list.includes(token)) {
        list.unshift(token);
        localStorage.setItem(MY_TOKENS_KEY, JSON.stringify(list.slice(0, 50)));
      }
    } catch (_) {
      /* localStorage不可でも致命的ではない（マイ予測はaccess_tokenを直接貼ってもよい） */
    }
  }

  function stripClaimFragment() {
    if (!location.hash) return;
    history.replaceState(history.state, '', location.pathname + location.search);
  }

  function getSessionId() {
    return new URLSearchParams(location.search).get('session_id');
  }

  function isQaMode() {
    return new URLSearchParams(location.search).get('qa') === '1';
  }

  // QA専用のダミーデータ。実APIには一切触れない。?count=Nでまとめ買い演出も確認できる。
  function buildQaPredictions() {
    const count = Math.max(1, Math.min(50, Number(new URLSearchParams(location.search).get('count')) || 1));
    const base = [7, 13, 18, 24, 35, 42];
    const preds = [];
    for (let i = 0; i < count; i++) {
      const numbers = base.map((n) => (((n - 1 + i * 3) % 43) + 1)).sort((a, b) => a - b);
      preds.push({ display_id: `#QA${String(i + 1).padStart(4, '0')}`, numbers, prediction_id: `qa-${i}` });
    }
    return preds;
  }

  function showError(message) {
    stageDim.classList.remove('is-active');
    statusLabel.classList.remove('is-active');
    errorMsg.textContent = message;
    errorMsg.classList.add('is-visible');
  }

  let dotsTimer = null;
  function startDots() {
    const frames = ['', '.', '..', '...'];
    let i = 0;
    dotsTimer = setInterval(() => {
      i = (i + 1) % frames.length;
      statusDots.textContent = frames[i];
    }, 400);
  }
  function stopDots() {
    if (dotsTimer) clearInterval(dotsTimer);
    statusDots.textContent = '';
  }

  async function pollPurchaseStatus(sessionId, { intervalMs = 1500, maxTries = 20 } = {}) {
    for (let i = 0; i < maxTries; i++) {
      const res = await fetch(`${API_BASE}/api/purchases/status?session_id=${encodeURIComponent(sessionId)}`);
      const body = await res.json();
      if (body.status === 'ready') return true;
      if (body.status === 'failed') return false;
      await sleep(intervalMs);
    }
    return null; // timeout（pendingのまま）
  }

  async function claimPredictions(claimToken) {
    const res = await fetch(`${API_BASE}/api/predictions/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim_token: claimToken }),
    });
    if (!res.ok) throw new Error('claim failed');
    return res.json();
  }

  function resetBalls() {
    ballEls.forEach((el) => {
      el.classList.remove('is-shown', 'is-impact');
      el.textContent = '';
    });
    ballRow.classList.remove('is-complete', 'zun-once');
  }

  async function revealOne(prediction) {
    resetBalls();
    const delays = [0, 400, 400, 400, 400, 1000]; // Phase 1と同一タイミング（1〜5球目0.4秒、5→6球目のみ1.0秒）
    for (let i = 0; i < 6; i++) {
      await sleep(delays[i]);
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown'); // 1球ずつnexusBounce（ボヨーン）演出
      if (i === 5) {
        // 6球目だけは既存のnexusImpact（is-impact）を重ねて、他の5球より
        // 明確に強い着地にする（is-shownのnexusBounceより後に定義されている
        // is-impactのnexusImpactが同スコア優先度で上書きするため、クラスを
        // 両方付けるだけで済む＝新しいアニメーションを追加していない）。
        ballEls[i].classList.add('is-impact');
      }
    }
    ballRow.classList.add('is-complete');
    // 6球目着地の瞬間、6球全体を一度だけ強く「ズンッ」と強調する。
    // 個々の「ボヨーン」（nexusBounce）とは別レイヤーのアニメーションなので、
    // ここではballRow自体にzun-onceを付け外しするだけで済む。
    if (!reduceMotion) {
      ballRow.classList.add('zun-once');
      await sleep(500);
      ballRow.classList.remove('zun-once');
    }
    await sleep(600);
  }

  /**
   * まとめ買い（10/30/50予測）の2件目以降用の簡易演出。
   * 既に完成しているボヨーン演出（revealOne）そのものは再設計せず、
   * 6球を一度に表示してis-shownを付けるだけ（1球ずつの間隔は挟まない）
   * ことで、1件あたりの所要時間をQUICK_REVEAL_STEP_MS程度に抑える。
   * 大量購入でも待ち時間が異常に長くならないようにするための専用演出。
   */
  async function quickRevealOne(prediction) {
    resetBalls();
    for (let i = 0; i < 6; i++) {
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown');
    }
    ballRow.classList.add('is-complete');
    await sleep(QUICK_REVEAL_STEP_MS);
  }

  function appendResultCard(prediction, { qaMode = false } = {}) {
    const el = document.createElement('div');
    el.className = 'result is-visible';
    // QAモードでは実際には何も保存していないため、「保存されました」等
    // 誤解を招く文言は絶対に表示しない。QA専用の文言に分離する。
    const statusLine = qaMode
      ? '（QA表示のみ・実際の保存は行われていません）'
      : '✓ この予測は保存されました';
    el.innerHTML = `
      <div class="result__row">
        <span>${prediction.display_id}</span>
        <span>${prediction.numbers.map((n) => String(n).padStart(2, '0')).join(' ')}</span>
      </div>
      <div class="result__locked">${statusLine}</div>
    `;
    resultsList.appendChild(el);
  }

  async function main() {
    const qaMode = isQaMode();

    let predictions;
    if (qaMode) {
      // QAモード：ネットワーク通信を一切行わない（fetchを1回も呼ばない）。
      // Stripe/Webhook/D1/生成/保存/Permanent Trackingには何の影響もない。
      predictions = buildQaPredictions();
      progressLabel.textContent = '';
    } else {
      const sessionId = getSessionId();
      const claimToken = getClaimToken();

      if (!sessionId || !claimToken) {
        showError('購入情報を確認できませんでした。購入ページからやり直してください。');
        return;
      }

      stageDim.classList.add('is-active');
      startDots();

      let ready;
      try {
        ready = await pollPurchaseStatus(sessionId);
      } catch {
        ready = null;
      }

      if (ready === false) {
        stopDots();
        showError('決済が完了しませんでした。購入ページからやり直してください。');
        return;
      }
      if (ready === null) {
        stopDots();
        showError('決済確認に時間がかかっています。少し待ってからこのページを再読み込みしてください。');
        return;
      }

      statusLabel.textContent = 'AI解析中';
      let claimResult;
      try {
        claimResult = await claimPredictions(claimToken);
      } catch {
        stopDots();
        showError('予測の取得に失敗しました。時間をおいてもう一度お試しください。');
        return;
      }

      stopDots();
      statusLabel.classList.remove('is-active');

      predictions = claimResult.predictions;
      stripClaimFragment();

      // マイ予測（購入者専用の後日再閲覧）用に、access_tokenだけを覚えておく。
      // D1が正本であり、ここではポインタ（トークン文字列）を保存するのみ。
      rememberAccessToken(getAccessToken());

      const replayKey = `loto6_result_shown:${sessionId}`;
      const alreadyShown = sessionStorage.getItem(replayKey) === '1';
      if (alreadyShown) {
        // リロード時は既存仕様どおり即座に復元するだけで、演出も自動遷移もしない。
        predictions.forEach((p) => appendResultCard(p, { qaMode: false }));
        stageDim.classList.remove('is-active');
        progressLabel.textContent = `全${predictions.length}口 保存が完了しました`;
        resetBalls();
        return;
      }
    }

    const isBulk = predictions.length > 1;
    for (let i = 0; i < predictions.length; i++) {
      if (!qaMode) progressLabel.textContent = `${i + 1} / ${predictions.length} 口目`;
      // 1件目は必ずフル演出（現行のボヨーン演出を維持）。まとめ買いの
      // 2件目以降だけ簡易演出に切り替え、待ち時間が異常に長くならないようにする。
      if (i === 0 || !isBulk) {
        await revealOne(predictions[i]);
      } else {
        await quickRevealOne(predictions[i]);
      }
      appendResultCard(predictions[i], { qaMode });
    }
    if (!qaMode) {
      sessionStorage.setItem(`loto6_result_shown:${getSessionId()}`, '1');
    }

    stageDim.classList.remove('is-active');
    progressLabel.textContent = qaMode
      ? `【QAモード】演出テスト表示中・${predictions.length}件（実際の保存・決済は行われていません）`
      : `全${predictions.length}口 保存が完了しました`;

    // 完成した数字を保持したままにする。1件購入時は現行どおり約8秒、
    // まとめ買い（マイ予測からいつでも再確認できる）は約4秒に短縮する。
    if (redirectNote) redirectNote.textContent = 'まもなくトップへ戻ります…';
    await realSleep(isBulk ? BULK_RESULT_HOLD_MS : RESULT_HOLD_MS);
    location.href = '/loto6/';
  }

  main();
})();
