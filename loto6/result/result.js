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

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

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
      el.classList.remove('is-shown');
      el.textContent = '';
    });
    ballRow.classList.remove('is-complete');
  }

  async function revealOne(prediction) {
    resetBalls();
    const delays = [0, 400, 400, 400, 400, 1000]; // Phase 1と同一タイミング
    for (let i = 0; i < 6; i++) {
      await sleep(delays[i]);
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown');
    }
    ballRow.classList.add('is-complete');
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

    const predictions = claimResult.predictions;
    stripClaimFragment();

    const replayKey = `loto6_result_shown:${sessionId}`;
    const alreadyShown = sessionStorage.getItem(replayKey) === '1';
    if (alreadyShown) {
      predictions.forEach(appendResultCard);
    } else {
      for (let i = 0; i < predictions.length; i++) {
        progressLabel.textContent = `${i + 1} / ${predictions.length} 口目`;
        await revealOne(predictions[i]);
        appendResultCard(predictions[i]);
      }
      sessionStorage.setItem(replayKey, '1');
    }

    stageDim.classList.remove('is-active');
    progressLabel.textContent = `全${predictions.length}口 保存が完了しました`;
    resetBalls();
  }

  main();
})();
