/**
 * timestamp_boundary.test.js
 * ------------------------------------------------------------------
 * verifyStripeSignature() のタイムスタンプ許容チェック（tolerance=300秒）を、
 * 実際のUnix秒（Date.now()/1000 相当）を使って直接検証する。
 *
 * 注意：test/stripeMock.js の signStripePayload() のデフォルト引数は
 *   Math.floor(Date.now() / 300)
 * という、本番バグ修正前と同じ誤った式のままになっている（本テストでは
 * 使わず、timestampSeconds を毎回明示的に渡すことでこれを回避している）。
 * このデフォルト値自体は今回の修正対象外（テストフィクスチャのみ、
 * production側の挙動には影響しない）だが、今後の別修正候補として
 * 記録しておく。
 * ------------------------------------------------------------------
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyStripeSignature } from '../src/lib/stripe.js';
import { TEST_STRIPE_WEBHOOK_SECRET, signStripePayload } from './stripeMock.js';

const REAL_NOW_MS = 1_790_000_000_000; // 固定した「現在時刻」（ミリ秒）でテストを決定的にする
const REAL_NOW_SEC = Math.floor(REAL_NOW_MS / 1000);

test('期限内（tolerance境界ぴったり 300秒差）は有効と判定される', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const ts = REAL_NOW_SEC - 300; // ちょうど300秒前
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET, ts);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET, REAL_NOW_MS);
  assert.equal(result.valid, true);
});

test('期限内（現在時刻と完全一致 = 差0秒）は有効と判定される', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const ts = REAL_NOW_SEC;
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET, ts);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET, REAL_NOW_MS);
  assert.equal(result.valid, true);
});

test('期限切れ（tolerance境界を1秒超過 = 301秒差）はtimestamp_expiredで無効', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const ts = REAL_NOW_SEC - 301;
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET, ts);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET, REAL_NOW_MS);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'timestamp_expired');
});

test('期限切れ（大幅に古い実タイムスタンプ、例：1時間前）はtimestamp_expiredで無効', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const ts = REAL_NOW_SEC - 3600;
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET, ts);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET, REAL_NOW_MS);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'timestamp_expired');
});

test('実際のUnix秒タイムスタンプ（現在時刻ちょうど）で署名も一致し有効になる（回帰テスト：/300バグ再発防止）', async () => {
  // このテストは、nowSecondsの単位計算が再びミリ秒のまま（/300など）に
  // 戻ってしまった場合に確実に失敗するように、本物のUnix秒レンジの
  // タイムスタンプ（10桁）を使う。
  const body = JSON.stringify({ type: 'checkout.session.completed' });
  const ts = REAL_NOW_SEC - 5; // 5秒前、実運用でよくある遅延を模したケース
  const sig = await signStripePayload(body, TEST_STRIPE_WEBHOOK_SECRET, ts);
  const result = await verifyStripeSignature(body, sig, TEST_STRIPE_WEBHOOK_SECRET, REAL_NOW_MS);
  assert.equal(result.valid, true);
});
