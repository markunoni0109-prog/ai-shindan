/**
 * storage.js
 * ------------------------------------------------------------------
 * 永続化レイヤー（Phase 1限定：ブラウザ内プロトタイプ保存）。
 *
 * 【重要・位置付けの明記】
 * ここで使っているlocalStorageは「サーバー側DB」ではない。
 * あくまでこの端末・このブラウザだけに保存される一時的なプロトタイプ用
 * ストレージであり、以下は一切保証しない：
 *   ・改ざん不能である ×（ユーザーが開発者ツール等から書き換え可能）
 *   ・永久保存である ×（ブラウザのデータ削除で消える）
 *   ・全ユーザーに公開される ×（保存したブラウザの中でしか見えない）
 * 「生成 → 確定 → 保存 → 画面へ返す」「リロードしても残る」
 * 「生成済みの数字はUPDATEしない」という“挙動”だけをPhase 1として
 * ブラウザ内で再現するためのものであり、本番相当の保証はしていない。
 *
 * 本番では、ユーザーが変更・削除できないサーバー側の永続DBへ移行する
 * 必要がある（今回のPhase 1ではバックエンド自体は未実装）。
 * その移行時は、この4関数（save / getAllPredictions / getPredictionCount）
 * の中身をfetch()等のAPI呼び出しに差し替えるだけでよく、
 * engine.js・app.js・history.jsは変更不要な設計にしてある。
 * ------------------------------------------------------------------
 */

const DB_KEY = 'aihunter_loto6_predictions_v1';
const COUNTER_KEY = 'aihunter_loto6_counter_v1';

function readAll() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    // 破損データは読めないものとして扱う（黙って上書きはしない）
    console.error('Storage read error', e);
    throw new Error('STORAGE_READ_FAILED');
  }
}

function writeAll(records) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(records));
  } catch (e) {
    console.error('Storage write error', e);
    throw new Error('STORAGE_WRITE_FAILED');
  }
}

function nextSequence() {
  const current = Number(localStorage.getItem(COUNTER_KEY) || '0');
  const next = current + 1;
  localStorage.setItem(COUNTER_KEY, String(next));
  return next;
}

function formatPredictionId(seq) {
  return '#' + String(seq).padStart(6, '0');
}

// 二重保存ガード（連打・多重リクエスト対策の最終防衛ライン）
let saveInFlight = false;

/**
 * 予測を確定・保存する。UIのアニメーションはこのPromiseがresolveした後にのみ開始してよい。
 *
 * 注意：ここで言う「保存」はPhase 1のlocalStorageへの書き込みであり、
 * UI上の「✓ この予測は保存されました」表示はそのまま維持するが、
 * 技術的な意味での改ざん不能（真のLOCKED保証）ではない。
 * 真のLOCKED保証（ユーザー自身も変更・削除できない状態）は、
 * 本番のサーバー側永続DBを導入した後に実現するものとする。
 *
 * @param {{numbers:number[], drawNumber:number, algorithmVersion:string, generatedAt:string}} payload
 * @returns {Promise<object>} 保存済みレコード（predictionId, dbId等を含む）
 */
async function savePrediction(payload) {
  if (saveInFlight) {
    throw new Error('SAVE_ALREADY_IN_PROGRESS');
  }
  saveInFlight = true;
  try {
    // 将来的な本番API呼び出しを想定した非同期境界（今はローカル処理のみ）
    await new Promise((resolve) => setTimeout(resolve, 150));

    const records = readAll();
    const seq = nextSequence();
    const record = {
      id: seq, // 内部DB ID
      predictionId: formatPredictionId(seq), // ユーザー表示用ID
      drawNumber: payload.drawNumber,
      numbers: payload.numbers,
      generatedAt: payload.generatedAt,
      algorithmVersion: payload.algorithmVersion,
      resultStatus: 'pending', // pending / matched
      matchCount: null,
      prizeRank: null,
    };

    records.push(record);
    writeAll(records);
    return record;
  } finally {
    saveInFlight = false;
  }
}

/** 新しい順（predictionId降順）で全件返す */
async function getAllPredictions() {
  return readAll().slice().sort((a, b) => b.id - a.id);
}

async function getPredictionCount() {
  return readAll().length;
}

window.LotoStorage = {
  savePrediction,
  getAllPredictions,
  getPredictionCount,
};
