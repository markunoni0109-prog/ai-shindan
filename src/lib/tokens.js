/**
 * tokens.js
 * ------------------------------------------------------------------
 * claim_token（256bit以上の暗号学的乱数）の発行とハッシュ化。
 * 平文tokenはDBに保存しない。DBにはSHA-256ハッシュのみ保存する。
 * ------------------------------------------------------------------
 */
import { sha256Hex } from './engine.js';

/** 256bit(32byte)の暗号学的乱数を base64url で返す（URLやJSONに安全に入る） */
export function generateClaimToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256bit
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashClaimToken(plainToken) {
  return sha256Hex(plainToken);
}

/** payment_public_id / entitlement_public_id / intent_public_id 用の公開ID（UUID） */
export function generatePublicId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
