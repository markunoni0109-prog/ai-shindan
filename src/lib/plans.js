/**
 * plans.js
 * ------------------------------------------------------------------
 * 商品カタログ（正式仕様：5予測300円 / 10予測500円 / 30予測1,000円 / 50予測1,500円）。
 * 商品思想：少額でAI予測を遊び、その予測をPermanent Trackingで継続研究する。
 * 金額・発行予測数はサーバー側のこの1箇所だけで定義し、クライアントからの
 * 指定値は一切信用しない（checkout/create・webhook双方でここを参照する）。
 *
 * 【購入可能プラン】pack5 / pack10 / pack30 / pack50（purchasable: true）
 *   1決済につき、必ず allowed_predictions 件を「全件成功か全体失敗」で生成する
 *   （claimEntitlement()が1トランザクションで原子的に保存する。部分生成なし）。
 *
 * 【free】FREE PUBLIC BETA専用の無料枠（1予測／24時間）。Stripe対象外。
 *
 * 【single（レガシー・購入不可）】
 *   旧仕様「1予測300円」は販売終了。ただしDB(payments.plan_code等のCHECK制約)と
 *   claimEntitlement()は過去に発行済みのentitlementを検証するため、
 *   既存行の整合性維持の目的に限り、カタログに読み取り専用の1エントリを残す。
 *   purchasable:false のため checkout/create は受け付けず、UIにも出さない。
 *   本番D1に single の行が0件と確認できた場合は、このエントリを削除してよい
 *   （確認SQL: SELECT COUNT(*) FROM payments WHERE plan_code='single';）。
 * ------------------------------------------------------------------
 */
export const PLAN_CATALOG = Object.freeze({
  pack5: Object.freeze({ amount: 300, allowed_predictions: 5, label: '5予測', purchasable: true }),
  pack10: Object.freeze({ amount: 500, allowed_predictions: 10, label: '10予測', purchasable: true }),
  pack30: Object.freeze({ amount: 1000, allowed_predictions: 30, label: '30予測', purchasable: true }),
  pack50: Object.freeze({ amount: 1500, allowed_predictions: 50, label: '50予測', purchasable: true }),
  // FREE PUBLIC BETA（新プランの追加のみ。claimEntitlement()が
  // PLAN_CATALOG[payment_plan_code]で整合性検証するため必要）。
  free: Object.freeze({ amount: 0, allowed_predictions: 1, label: '無料AI数字分析（24時間に1回）', purchasable: false }),
  // レガシー（上記コメント参照）。販売不可・読み取り専用。
  single: Object.freeze({ amount: 300, allowed_predictions: 1, label: 'レガシー（販売終了）', purchasable: false }),
});

export function isValidPlanCode(planCode) {
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, planCode);
}

/** Stripe Checkoutで販売してよいプランか（free / レガシーsingle は false）。 */
export function isPurchasablePlan(planCode) {
  return isValidPlanCode(planCode) && PLAN_CATALOG[planCode].purchasable === true;
}

/** FREE PUBLIC BETA用のプラン定義への読みやすいエイリアス（PLAN_CATALOG.freeそのもの）。 */
export const FREE_PLAN = PLAN_CATALOG.free;
