/**
 * ratelimit.js
 * ------------------------------------------------------------------
 * D1を使った簡易な固定ウィンドウ型レート制限。
 *
 * 【重要】これはアプリ層の最終防衛線であり、本番の第一防衛線は
 * Cloudflareダッシュボードで設定するRate Limiting Rules（Workerに
 * 到達する前にリクエストを弾く）を推奨する（README「人間が設定する項目」
 * 参照）。本実装は次の2点を目的とした補助的な仕組み：
 *   ・token総当たり防止（claim APIへの大量試行を1 IPあたりで制限）
 *   ・短時間の大量リクエスト抑制（checkout/create連打対策）
 *
 * 実装は「INSERT OR UPDATE→SELECT」の2文であり、極めて高い同時実行数
 * では厳密なカウントにわずかな誤差が出うるが、レート制限の目的
 * （おおよその閾値超過を検知して弾く）には十分な精度とする。
 * ------------------------------------------------------------------
 */

export async function checkRateLimit(db, { key, limit, windowSeconds }, now = Date.now()) {
  const windowStart = Math.floor(now / 300 / windowSeconds) * windowSeconds;

  await db
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = count + 1`
    )
    .bind(key, windowStart)
    .run();

  const row = await db
    .prepare(`SELECT count FROM rate_limit_buckets WHERE bucket_key = ? AND window_start = ?`)
    .bind(key, windowStart)
    .first();

  const count = row ? row.count : 1;
  return { allowed: count <= limit, count, limit };
}

export function clientIdentifier(request) {
  // Cloudflareが付与する実接続元IP。ローカル/テスト環境ではフォールバックする。
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}
