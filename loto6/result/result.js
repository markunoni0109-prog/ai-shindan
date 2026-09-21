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
 * 5通りぶん、1口目から5口目まで順番に同じ演出を繰り返す。
 *
 * 【LOTO6 NEXUS 最終仕上げ】
 * 全口の演出が終わった後、完成した数字を約8秒間大きく保持してから
 * /loto6/ へ自動遷移する。保持時間はprefers-reduced-motionの影響を
 * 受けない（演出のスキップ対象は「動き」であって「表示時間」では
 * ないため）。Stripe/Webhook/DB/生成/保存/Permanent Trackingの
 * ロジックには一切手を入れていない（claimPredictions/pollPurchaseStatus
 * は変更なし）。
 *
 * 【無料QAモード（実決済不要）】
 * URLに ?qa=1 を付けて開くと、pollPurchaseStatus/claimPredictionsの
 * fetchを一切実行せず（＝Stripe/Webhook/D1へは何も通信しない）、
 * その場で作ったダミーの1口ぶんの数字だけを使い、実際の演出コード
 * （revealOne〜8秒保持〜/loto6/への自動遷移）をそのまま通しで実行する。
 * 実際の予測データ・決済状態には一切触れないため、本番のStripe/Webhook/
 * D1/生成/保存/Permanent Trackingに影響しない。
 * 例：https://ai-hunter.jp/loto6/result/index.html?qa=1
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

  const RESULT_HOLD_MS = 8000; // 完成数字を大きく保持する時間（約8秒）

  function getClaimToken() {
    const hashMatch = location.hash.match(/claim=([^&]+)/);
    if (hashMatch) {
      const token = decodeURIComponent(hashMatch[1]);
      sessionStorage.setItem('loto6_claim_token', token);
      return token;
    }
    return sessionStorage.getItem('loto6_claim_token');
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

  // QA専用のダミーデータ。実APIには一切触れない。
  function buildQaPredictions() {
    return [{ display_id: '#QA0001', numbers: [7, 13, 18, 24, 35, 42] }];
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

  function appendResultCard(prediction) {
    const el = document.createElement('div');
    el.className = 'result is-visible';
    el.innerHTML = `
      <div class="result__row">
        <span>${prediction.display_id}</span>
        <span>${prediction.numbers.map((n) => String(n).padStart(2, '0')).join(' ')}</span>
      </div>
      <div class="result__locked">✓ この予測は保存されました</div>
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

      const replayKey = `loto6_result_shown:${sessionId}`;
      const alreadyShown = sessionStorage.getItem(replayKey) === '1';
      if (alreadyShown) {
        // リロード時は既存仕様どおり即座に復元するだけで、演出も自動遷移もしない。
        predictions.forEach(appendResultCard);
        stageDim.classList.remove('is-active');
        progressLabel.textContent = `全${predictions.length}口 保存が完了しました`;
        resetBalls();
        return;
      }
    }

    for (let i = 0; i < predictions.length; i++) {
      if (!qaMode) progressLabel.textContent = `${i + 1} / ${predictions.length} 口目`;
      await revealOne(predictions[i]);
      appendResultCard(predictions[i]);
    }
    if (!qaMode) {
      sessionStorage.setItem(`loto6_result_shown:${getSessionId()}`, '1');
    }

    stageDim.classList.remove('is-active');
    progressLabel.textContent = qaMode
      ? '【QAモード】演出テスト表示中（実際の保存・決済は行われていません）'
      : `全${predictions.length}口 保存が完了しました`;

    // 完成した数字を約8秒間、大きく保持したままにする（初回演出時のみ）。
    if (redirectNote) redirectNote.textContent = 'まもなくトップへ戻ります…';
    await realSleep(RESULT_HOLD_MS);
    location.href = '/loto6/';
  }

  main();
})();
