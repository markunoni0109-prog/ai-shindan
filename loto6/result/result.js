/**
 * result.js
 * ------------------------------------------------------------------
 * successページの中核。
 *
 * 重要：「successページへ到着した＝購入権発行」ではない。
 * ここでは必ず /api/purchases/status をpollしてreadyを確認してから
 * claimへ進む。サーバー保存成功前（claim成功前）に数字を演出表示しない。
 *
 * 【演出V2（10/30/50予測でも全件フル演出）】
 * V1では2件目以降を簡易演出(quickRevealOne)に切り替えていたが、本番で
 * 「6数字が高速で切り替わるだけ」に見えてしまい演出として機能していなかった
 * ため、件数に関わらず全件で同じフル演出(revealOne)を使う設計に変更する。
 * 演出速度：1〜5球目は[700,900,900,900,900]ms間隔、6球目のみ1600ms。
 * 6球完成後は2500ms保持してから次の予測へ進む。各口の完成後、数字は
 * resultsListへ追加して画面に残す（消えない）。
 * 大量購入(最大50件)でも待ちきれない場合のため、スキップボタンで
 * 現在演出中の口を即座に完成させ、残り全件を一覧へまとめて表示できる。
 * 自動的にトップへ戻る処理は行わない（結果は「マイ予測」からいつでも
 * 再確認できるため、ページに留まって手動で次の操作をしてもらう）。
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
 * 通しで実行する。?qa=1&count=30 のように件数を指定すると、まとめ買い
 * 演出（全件フル演出＋一覧＋スキップ）も実決済なしで確認できる。QAモードでは
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
  const skipBtn = document.getElementById('skipBtn');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 決済確認のポーリング間隔待ち等、演出とは無関係な待機に使う（既存仕様のまま）。
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

  // スキップボタンが押されたら即座に解決する、中断可能なsleep。
  // 演出中の待ちをその場で打ち切って「残り全件を即時一覧表示」できるようにする。
  let skipRequested = false;
  let pendingSkipResolvers = [];
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      pendingSkipResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  function requestSkip() {
    if (skipRequested) return;
    skipRequested = true;
    pendingSkipResolvers.forEach((r) => r());
    pendingSkipResolvers = [];
    if (skipBtn) skipBtn.classList.remove('is-visible');
  }
  if (skipBtn) skipBtn.addEventListener('click', requestSkip);

  // 演出用の待ち時間はreduced-motion環境では即時にする。
  const animDelay = (ms) => interruptibleSleep(reduceMotion ? 0 : ms);
  // 完成後の「見せる」保持時間は、動きではないのでreduced-motionでも短縮しない
  // （スキップボタンでは中断できる）。
  const holdDelay = (ms) => interruptibleSleep(ms);

  const REVEAL_DELAYS = [700, 900, 900, 900, 900, 1600]; // 正式演出速度（1〜5球目・6球目）
  const COMPLETE_HOLD_MS = 2500; // 6球完成後の保持時間

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

  function showAllBallsInstant(prediction) {
    for (let i = 0; i < 6; i++) {
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown');
    }
    ballEls[5].classList.add('is-impact');
    ballRow.classList.add('is-complete');
  }

  /**
   * 全予測共通のフル演出（ボヨーン×6→ズン→保持）。件数(1/10/30/50)に関わらず
   * 常にこれを使う。REVEAL_DELAYSの間隔で1球ずつ表示し、6球完成後は
   * COMPLETE_HOLD_MSだけ保持してから次の予測へ進む。
   * スキップボタンが押された場合は、現在演出中の口も含めて6球すべてを
   * 即座に表示し、保持もせずに即返る（呼び出し側のループが残り全件を
   * 続けて即時表示できるようにするため）。
   */
  async function revealOne(prediction) {
    resetBalls();
    for (let i = 0; i < 6; i++) {
      if (skipRequested) break;
      await animDelay(REVEAL_DELAYS[i]);
      if (skipRequested) break;
      ballEls[i].textContent = String(prediction.numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown'); // 1球ずつnexusBounce（ボヨーン）演出
      if (i === 5) {
        // 6球目だけは既存のnexusImpact（is-impact）を重ねて、他の5球より
        // 明確に強い着地にする。
        ballEls[i].classList.add('is-impact');
      }
    }

    // スキップされた場合も含め、必ず6球とも数字が表示された状態で終える。
    showAllBallsInstant(prediction);

    if (skipRequested) return; // スキップ時は保持もせず即座に一覧へ

    // 6球目着地の瞬間、6球全体を一度だけ強く「ズンッ」と強調する。
    if (!reduceMotion) {
      ballRow.classList.add('zun-once');
      await animDelay(500);
      ballRow.classList.remove('zun-once');
    }
    if (skipRequested) return;
    await holdDelay(COMPLETE_HOLD_MS);
  }

  function appendResultCard(prediction, { qaMode = false } = {}) {
    const el = document.createElement('div');
    el.className = 'result is-visible';
    // QAモードでは実際には何も保存していないため、「保存されました」等
    // 誤解を招く文言は絶対に表示しない。QA専用の文言に分離する。
    const statusLine = qaMode
      ? '（QA表示のみ・実際の保存は行われていません）'
      : '✓ この予測は保存されました';
    // 履歴件数が増えても何口目のカードか一目で分かるよう連番を振る
    // （resultsListに既に積まれているカード数から算出。表示専用の
    // 連番であり、prediction_idそのものは書き換えない）。
    // このカードは決済直後の一覧のみを目的とし、display_id等のID表示は
    // 出さない方針（正本では内部ID・技術情報を通常表示しない）。
    // 該当予測を後から特定したい場合は「予測履歴」「マイ予測」を使う。
    const cardNo = resultsList.children.length + 1;
    const ballsHtml = prediction.numbers
      .map((n) => `<span class="result-ball">${String(n).padStart(2, '0')}</span>`)
      .join('');
    el.innerHTML = `
      <div class="result__head">
        <span class="result__no">No.${cardNo}</span>
      </div>
      <div class="result__balls">${ballsHtml}</div>
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

    // 件数に関わらず、常に全件で同じフル演出（revealOne）を使う。
    if (skipBtn && predictions.length > 0) skipBtn.classList.add('is-visible');
    for (let i = 0; i < predictions.length; i++) {
      if (!qaMode) progressLabel.textContent = `${i + 1} / ${predictions.length} 口目`;
      await revealOne(predictions[i]);
      appendResultCard(predictions[i], { qaMode });
    }
    if (skipBtn) skipBtn.classList.remove('is-visible');
    if (!qaMode) {
      sessionStorage.setItem(`loto6_result_shown:${getSessionId()}`, '1');
    }

    stageDim.classList.remove('is-active');
    progressLabel.textContent = qaMode
      ? `【QAモード】演出テスト表示中・${predictions.length}件（実際の保存・決済は行われていません）`
      : `全${predictions.length}口 保存が完了しました`;

    // 完成した数字は消さずにそのまま画面に残す。自動的にトップへは
    // 戻らない（結果は「マイ予測」からいつでも再確認できるため、
    // このページに留まって手動で次の操作（履歴・マイ予測・トップへ）を
    // 選んでもらう）。
    if (redirectNote) redirectNote.textContent = '';
  }

  main();
})();
