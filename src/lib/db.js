/**
 * db.js
 * ------------------------------------------------------------------
 * D1に対する実際のクエリ・batch()呼び出しをまとめる層。
 *
 * 設計方針（Phase 2技術監査報告を踏まえた実装）：
 *   - entitlement消費 + 1件INSERT を「1回のD1 batch()」に必ずまとめる。
 *     batch()はD1公式仕様上、シーケンス内の一部が失敗すれば全体を
 *     中断・ロールバックする（部分保存は起きない）。
 *   - 真の排他制御は purchase_entitlements.status の事前チェックではなく、
 *     UNIQUE(entitlement_id, prediction_index) 制約（衝突A）に委ねる。
 *   - hash chainの分岐はUNIQUE(previous_hash)制約（衝突B）で検出する。
 *   - 数字重複はUNIQUE(combination_key)制約（衝突C）で検出する。
 *   - display_sequenceの競合はUNIQUE(display_sequence)制約（衝突D。
 *     Open承認済み。canonical payload／record_hashには含めない）で検出する。
 *   - 衝突が起きた場合、自分のentitlementが既にconsumedになっていれば
 *     「衝突A＝自分自身の重複claim」と判定し、既存5件を取得して返す
 *     （再生成しない）。まだactiveのままなら「衝突B/C/D＝他の購入との
 *     競合」と判定し、チェーン全体を読み直して再生成し、batchを再送する。
 * ------------------------------------------------------------------
 */
import { buildPredictionChain, GENESIS_HASH } from './engine.js';

export const MAX_CLAIM_RETRIES = 10;

export class ClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'invalid_token' | 'retry_exhausted' | 'internal'
  }
}

async function getEntitlementByTokenHash(db, tokenHash) {
  return db
    .prepare(
      `SELECT e.*, p.payment_public_id, p.plan_code AS payment_plan_code
       FROM purchase_entitlements e
       JOIN payments p ON p.id = e.payment_id
       WHERE e.claim_token_hash = ?`
    )
    .bind(tokenHash)
    .first();
}

async function getChainTip(db) {
  return db
    .prepare(`SELECT record_hash, display_sequence FROM predictions ORDER BY id DESC LIMIT 1`)
    .first();
}

async function getPredictionsByEntitlement(db, entitlementId) {
  const { results } = await db
    .prepare(
      `SELECT prediction_id, display_sequence, draw_number,
              number_1, number_2, number_3, number_4, number_5, number_6,
              generated_at, algorithm_version, record_hash, prediction_index
       FROM predictions
       WHERE entitlement_id = ?
       ORDER BY prediction_index ASC`
    )
    .bind(entitlementId)
    .all();
  return results.map(toPublicPrediction);
}

function toPublicPrediction(row) {
  return {
    prediction_id: row.prediction_id,
    display_id: '#' + String(row.display_sequence).padStart(6, '0'),
    draw_number: row.draw_number,
    numbers: [row.number_1, row.number_2, row.number_3, row.number_4, row.number_5, row.number_6],
    generated_at: row.generated_at,
    algorithm_version: row.algorithm_version,
    record_hash: row.record_hash,
    prediction_index: row.prediction_index,
  };
}

function classifyConflict(message) {
  if (!message) return 'unknown';
  if (message.includes('predictions.combination_key')) return 'C_combination_key';
  if (message.includes('predictions.previous_hash')) return 'B_previous_hash';
  if (message.includes('predictions.display_sequence')) return 'D_display_sequence';
  if (message.includes('entitlement_id') && message.includes('prediction_index')) return 'A_entitlement_index';
  if (message.includes('predictions.prediction_id')) return 'other_prediction_id';
  return 'unknown';
}

/**
 * claim_token（平文）を受け取り、1予測の予測を確定・返却する。
 * 冪等：同じtokenで再度呼んでも新しい予測は生成されず、既存の5件が返る。
 */
export async function claimEntitlement(
  db,
  tokenHash,
  { drawNumber, rng, _afterTipRead = async () => {} } = {}
) {
  // _afterTipRead はテストが競合ウィンドウを決定的に再現するためだけに使う
  // フック（本番では常にno-op）。read replicaやSessions APIとは無関係。
  const entitlement = await getEntitlementByTokenHash(db, tokenHash);
  if (!entitlement) {
    throw new ClaimError('invalid_token', 'claim_token に一致するentitlementが見つかりません');
  }

  if (entitlement.status === 'consumed') {
    const predictions = await getPredictionsByEntitlement(db, entitlement.id);
    return { outcome: 'existing', predictions, attempts: 0 };
  }

  let lastConflict = 'none';
  for (let attempt = 1; attempt <= MAX_CLAIM_RETRIES; attempt++) {
    const tip = await getChainTip(db);
    const previousHash0 = tip ? tip.record_hash : GENESIS_HASH;
    const startSeq = tip ? tip.display_sequence + 1 : 1;
    const generatedAt = new Date().toISOString();

    await _afterTipRead({ attempt, previousHash0, startSeq });

    const chain = await buildPredictionChain({
      count: entitlement.allowed_predictions,
      drawNumber,
      paymentPublicId: entitlement.payment_public_id,
      entitlementPublicId: entitlement.entitlement_public_id,
      planCode: entitlement.payment_plan_code,
      previousHash0,
      generatedAt,
      rng,
    });

    const updateStmt = db
      .prepare(
        `UPDATE purchase_entitlements
         SET status = 'consumed', consumed_predictions = ?, consumed_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .bind(entitlement.allowed_predictions, generatedAt, entitlement.id);

    const insertStmts = chain.map((rec, i) =>
      db
        .prepare(
          `INSERT INTO predictions
             (prediction_id, display_sequence, draw_number,
              number_1, number_2, number_3, number_4, number_5, number_6,
              combination_key, generated_at, payment_id, entitlement_id,
              prediction_index, plan_code, algorithm_version, previous_hash, record_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          rec.predictionId,
          startSeq + i,
          rec.drawNumber,
          rec.numbers[0], rec.numbers[1], rec.numbers[2], rec.numbers[3], rec.numbers[4], rec.numbers[5],
          rec.combinationKey,
          rec.generatedAt,
          entitlement.payment_id,
          entitlement.id,
          rec.predictionIndex,
          rec.planCode,
          rec.algorithmVersion,
          rec.previousHash,
          rec.recordHash
        )
    );

    try {
      const results = await db.batch([updateStmt, ...insertStmts]);
      const updateMeta = results[0].meta ?? results[0];
      return {
        outcome: 'created',
        attempts: attempt,
        entitlementRowsAffected: updateMeta.changes ?? null,
        predictions: chain.map((rec, i) =>
          toPublicPrediction({
            prediction_id: rec.predictionId,
            display_sequence: startSeq + i,
            draw_number: rec.drawNumber,
            number_1: rec.numbers[0], number_2: rec.numbers[1], number_3: rec.numbers[2],
            number_4: rec.numbers[3], number_5: rec.numbers[4], number_6: rec.numbers[5],
            generated_at: rec.generatedAt,
            algorithm_version: rec.algorithmVersion,
            record_hash: rec.recordHash,
            prediction_index: rec.predictionIndex,
          })
        ),
      };
    } catch (err) {
      lastConflict = classifyConflict(err.message);
      const reread = await db
        .prepare('SELECT status FROM purchase_entitlements WHERE id = ?')
        .bind(entitlement.id)
        .first();
      if (reread && reread.status === 'consumed') {
        // 衝突A相当：自分自身が既に別リクエストで確定済み。再生成せず既存を返す。
        const predictions = await getPredictionsByEntitlement(db, entitlement.id);
        return { outcome: 'existing', predictions, attempts: attempt, resolvedVia: lastConflict };
      }
      // 衝突B/C/D相当：他購入との競合。チェーンを読み直して再試行する。
      if (attempt === MAX_CLAIM_RETRIES) {
        throw new ClaimError(
          'retry_exhausted',
          `retry上限(${MAX_CLAIM_RETRIES}回)に到達。entitlementは未消費のまま(fail-close)。最終衝突種別=${lastConflict}`
        );
      }
      // ループ継続（次のattemptでtipを読み直す）
    }
  }
  // 理論上到達しないが念のため
  throw new ClaimError('internal', 'unreachable state in claimEntitlement');
}
