/**
 * LOTO6 NEXUS result page
 * Bulk UX: every prediction gets the full 6-ball reveal.
 * Results remain on screen; no automatic redirect.
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
  const skipBtn = document.getElementById('skipBulkAnimation');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));
  const MY_TOKENS_KEY = 'loto6_my_access_tokens';

  let skipRemaining = false;

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

  function rememberAccessToken(token) {
    if (!token) return;
    try {
      const list = JSON.parse(localStorage.getItem(MY_TOKENS_KEY) || '[]');
      if (!list.includes(token)) {
        list.unshift(token);
        localStorage.setItem(MY_TOKENS_KEY, JSON.stringify(list.slice(0, 50)));
      }
    } catch (_) {}
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

  function buildQaPredictions() {
    const count = Math.max(1, Math.min(50, Number(new URLSearchParams(location.search).get('count')) || 1));
    const base = [7, 13, 18, 24, 35, 42];
    const preds = [];
    for (let i = 0; i < count; i++) {
      const numbers = base.map((n) => (((n - 1 + i * 3) % 43) + 1)).sort((a, b) => a - b);
      preds.push({
        display_id: `#QA${String(i + 1).padStart(4, '0')}`,
        numbers,
        prediction_id: `qa-${i}`
      });
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
    return null;
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
    const delays = [0, 400, 400, 400, 400, 1000];
    for (let i = 0; i < 6; i++) {
      if (skipRemaining) return;
      await sleep(delays[i]);
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown');
      if (i === 5) ballEls[i].classList.add('is-impact');
    }
    ballRow.classList.add('is-complete');
    if (!reduceMotion) {
      ballRow.classList.add('zun-once');
      await sleep(500);
      ballRow.classList.remove('zun-once');
    }
    await sleep(600);
  }

  function appendResultCard(prediction, { qaMode = false } = {}) {
    const el = document.createElement('div');
    el.className = 'result is-visible';
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

  function showAllRemaining(predictions, startIndex, qaMode) {
    for (let i = startIndex; i < predictions.length; i++) {
      appendResultCard(predictions[i], { qaMode });
    }
  }

  async function main() {
    const qaMode = isQaMode();
    let predictions;

    if (qaMode) {
      predictions = buildQaPredictions();
      progressLabel.textContent = '';
      statusLabel.classList.remove('is-active');
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
      rememberAccessToken(getAccessToken());

      const replayKey = `loto6_result_shown:${sessionId}`;
      const alreadyShown = sessionStorage.getItem(replayKey) === '1';
      if (alreadyShown) {
        predictions.forEach((p) => appendResultCard(p, { qaMode: false }));
        stageDim.classList.remove('is-active');
        progressLabel.textContent = `全${predictions.length}口 保存済み`;
        resetBalls();
        if (redirectNote) redirectNote.textContent = 'この結果はこの画面に残ります。下の「マイ予測」から後日再確認できます。';
        return;
      }
    }

    if (skipBtn && predictions.length > 1) {
      skipBtn.hidden = false;
      skipBtn.addEventListener('click', () => {
        skipRemaining = true;
        skipBtn.disabled = true;
        skipBtn.textContent = '全件を表示します…';
      }, { once: true });
    }

    let nextIndex = 0;
    for (let i = 0; i < predictions.length; i++) {
      nextIndex = i;
      progressLabel.textContent = qaMode
        ? `【QA】${i + 1} / ${predictions.length} 口目`
        : `${i + 1} / ${predictions.length} 口目`;

      if (skipRemaining) break;

      // まとめ買いでも全件、同じ6球フル「ボヨーン」演出を行う。
      await revealOne(predictions[i]);
      if (skipRemaining) break;

      appendResultCard(predictions[i], { qaMode });
      nextIndex = i + 1;
    }

    if (skipRemaining && nextIndex < predictions.length) {
      showAllRemaining(predictions, nextIndex, qaMode);
    }

    if (!qaMode) {
      sessionStorage.setItem(`loto6_result_shown:${getSessionId()}`, '1');
    }

    stageDim.classList.remove('is-active');
    resetBalls();

    progressLabel.textContent = qaMode
      ? `【QAモード】全${predictions.length}件を表示中（実際の保存・決済は行われていません）`
      : `全${predictions.length}口 保存が完了しました`;

    if (skipBtn) skipBtn.hidden = true;

    // 重要：結果を自動で消さない／トップへ自動遷移しない。
    if (redirectNote) {
      redirectNote.textContent = qaMode
        ? 'QA結果はこの画面に残ります。'
        : '結果はこの画面に残ります。下の「マイ予測」から後日再確認できます。';
    }
  }

  main();
})();
