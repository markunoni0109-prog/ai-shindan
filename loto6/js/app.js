/**
 * app.js
 * ------------------------------------------------------------------
 * トップ画面のUI制御。
 * 数字生成(engine.js)と保存(storage.js)には一切ロジックを持たず、
 * ここでは「呼び出し順序」と「演出」だけを担当する。
 *
 * 重要：演出は保存確定（Phase 1ではlocalStorageへの書き込み成功）後にのみ開始する。
 * ※Phase 1のlocalStorageはあくまでブラウザ内プロトタイプ保存であり、
 *   サーバー側DBではない（storage.js冒頭コメント参照）。
 * ------------------------------------------------------------------
 */

(function () {
  const generateBtn = document.getElementById('generateBtn');
  const stageDim = document.getElementById('stageDim');
  const analysingLabel = document.getElementById('analysingLabel');
  const analysingDots = document.getElementById('analysingDots');
  const ballRow = document.getElementById('ballRow');
  const ballEls = Array.from(ballRow.querySelectorAll('.ball'));
  const errorMsg = document.getElementById('errorMsg');
  const result = document.getElementById('result');
  const resultDraw = document.getElementById('resultDraw');
  const resultId = document.getElementById('resultId');
  const resultTime = document.getElementById('resultTime');
  const impactWord = document.getElementById('impactWord');
  const drawNumberLabel = document.getElementById('drawNumberLabel');

  const drawNumber = window.LotoConfig.PREDICTION_SCOPE || 'PERMANENT_TRACKING';
  drawNumberLabel.textContent = 'PERMANENT TRACKING';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : ms));

  // 二重生成防止（UI側）。storage.js 側にも保存処理の排他ガードあり
  // （Phase 1はlocalStorageベースの簡易ガードで、本番相当の排他制御ではない）。
  let isGenerating = false;

  // 「AI解析中」のドット表示（. → .. → ... → を自然に繰り返す。派手な点滅にはしない）
  let dotsTimer = null;
  function startAnalysingDots() {
    const frames = ['', '.', '..', '...'];
    let i = 0;
    analysingDots.textContent = frames[0];
    dotsTimer = setInterval(() => {
      i = (i + 1) % frames.length;
      analysingDots.textContent = frames[i];
    }, 260);
  }
  function stopAnalysingDots() {
    if (dotsTimer) {
      clearInterval(dotsTimer);
      dotsTimer = null;
    }
    analysingDots.textContent = '';
  }

  function resetStageVisuals() {
    ballEls.forEach((el) => {
      el.classList.remove('is-shown');
      el.textContent = '';
    });
    ballRow.classList.remove('is-complete');
    result.classList.remove('is-visible');
    errorMsg.classList.remove('is-visible');
  }

  function formatTimestamp(isoString) {
    const d = new Date(isoString);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  async function revealBalls(numbers) {
    const delays = [0, 1000, 1000, 1000, 1000, 1800]; // 6球目を焦らして全体約8〜10秒
    for (let i = 0; i < numbers.length; i++) {
      await sleep(delays[i]);
      ballEls[i].textContent = String(numbers[i]).padStart(2, '0');
      ballEls[i].classList.add('is-shown');
      ballEls[i].classList.toggle('is-impact', i === numbers.length - 1);
      if (impactWord) {
        impactWord.classList.remove('pop');
        void impactWord.offsetWidth;
        impactWord.classList.add('pop');
      }
    }
    ballRow.classList.add('is-complete');
  }

  async function handleGenerate() {
    if (isGenerating) return; // 連打対策
    isGenerating = true;
    generateBtn.disabled = true;
    resetStageVisuals();

    stageDim.classList.add('is-active');
    analysingLabel.classList.add('is-active');
    startAnalysingDots();

    let record;
    try {
      const payload = window.LotoEngine.generatePrediction(drawNumber);
      // 演出開始前にDB保存を完了させる（数字を見せる前に確定させる）
      record = await window.LotoStorage.savePrediction(payload);
    } catch (err) {
      console.error('Prediction save failed', err);
      stopAnalysingDots();
      stageDim.classList.remove('is-active');
      analysingLabel.classList.remove('is-active');
      errorMsg.classList.add('is-visible');
      generateBtn.disabled = false;
      isGenerating = false;
      return;
    }

    // ここから先は保存成功が確定している → 演出開始してよい
    // 「AI解析中」は短い待機の間も表示したままにする（仕様§6の順序どおり）
    await sleep(1800); // 解析の溜めを作る
    stopAnalysingDots();
    analysingLabel.classList.remove('is-active');

    await revealBalls(record.numbers);

    stageDim.classList.remove('is-active');

    resultDraw.textContent = 'PERMANENT TRACKING';
    resultId.textContent = `予測ID ${record.predictionId}`;
    resultTime.textContent = `生成日時 ${formatTimestamp(record.generatedAt)}`;
    result.classList.add('is-visible');

    generateBtn.disabled = false;
    isGenerating = false;
  }

  generateBtn.addEventListener('click', handleGenerate);
})();
