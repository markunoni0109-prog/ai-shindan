/**
 * email.js
 * ------------------------------------------------------------------
 * 「端末変更・localStorage消失時の購入履歴復旧」用のメール関連ユーティリティ。
 *
 * ・hashEmail: 生のメールアドレスは絶対にDBへ保存しない。HMAC-SHA256で
 *   ハッシュ化した値だけを照合キーとして使う（秘密鍵はenv.EMAIL_HASH_SECRET。
 *   claim_token/access_tokenのハッシュ化と同じ考え方）。
 * ・sendRecoveryEmail: 実際のメール送信はCloudflareアカウント側の設定
 *   （Email Routing有効化・ai-hunter.jpドメインの検証・send_emailバインディング）
 *   に依存する。本セッションでは実アカウントを確認できないため、
 *   「設定されていれば送る／されていなければ明示的に失敗させる」実装とし、
 *   黙って成功したふりはしない（README「本番反映に必要な作業」参照）。
 *   テスト・ローカルではenv.__testEmailSenderに差し替える。
 * ------------------------------------------------------------------
 */

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export class EmailConfigError extends Error {}
export class EmailSendError extends Error {}

/** メールアドレスをHMAC-SHA256でハッシュ化する。秘密鍵未設定なら明示的に失敗する。 */
export async function hashEmail(env, email) {
  const secret = env.EMAIL_HASH_SECRET;
  if (!secret) throw new EmailConfigError('EMAIL_HASH_SECRET_not_configured');
  return hmacHex(secret, normalizeEmail(email));
}

/**
 * 復旧リンクをメールで送る。
 * env.__testEmailSender があれば最優先でそれを使う（テスト・ローカル用）。
 * 無ければ env.EMAIL_SENDER（Cloudflare Email Workersのsend_emailバインディング）
 * を使う。どちらも無ければ「送信できない」ことを明示的にthrowする。
 */
export async function sendRecoveryEmail(env, { to, recoveryUrl }) {
  const subject = 'LOTO6 NEXUS｜購入履歴の復元リンク';
  const text = [
    'これまでに購入したLOTO6 AI予測の一覧（マイ予測）へアクセスできるリンクです。',
    '',
    recoveryUrl,
    '',
    'このリンクは発行から30分間のみ有効で、1回使用すると無効になります。',
    '心当たりがない場合は、このメールを無視してください（操作は行われません）。',
  ].join('\n');

  if (env.__testEmailSender) {
    return env.__testEmailSender({ to, subject, text });
  }

  if (env.EMAIL_SENDER && typeof env.EMAIL_SENDER.send === 'function') {
    // Cloudflare Email Workers（send_emailバインディング）。実際に届くかは
    // ai-hunter.jpドメインのCloudflare Email Routing設定に依存するため、
    // 本セッションでは動作を確認できていない（README「未解決事項」参照）。
    const { EmailMessage } = await import('cloudflare:email');
    const mime = [
      'From: LOTO6 NEXUS <no-reply@ai-hunter.jp>',
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n');
    const msg = new EmailMessage('no-reply@ai-hunter.jp', to, mime);
    await env.EMAIL_SENDER.send(msg);
    return { sent: true, via: 'cloudflare_email_workers' };
  }

  throw new EmailSendError('email_sender_not_configured');
}
