/**
 * plans.js
 * ------------------------------------------------------------------
 * 商品カタログ（1予測300円 / 10予測3,000円 / 30予測9,000円 / 50予測15,000円）。
 * 金額・発行予測数はサーバー側のこの1箇所だけで定義し、クライアントからの
 * 指定値は一切信用しない（checkout/create・webhook双方でここを参照する）。
 * ------------------------------------------------------------------
 */
export const PLAN_CATALOG = Object.freeze({
  single: Object.freeze({ amount: 300, allowed_predictions: 1, label: '1予測' }),
  pack10: Object.freeze({ amount: 3000, allowed_predictions: 10, label: '10予測' }),
  pack30: Object.freeze({ amount: 9000, allowed_predictions: 30, label: '30予測' }),
  pack50: Object.freeze({ amount: 15000, allowed_predictions: 50, label: '50予測' }),
});

export function isValidPlanCode(planCode) {
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, planCode);
}
