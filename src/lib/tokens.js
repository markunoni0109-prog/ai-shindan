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

/**
 * 「マイ予測」用アクセストークン。claim_tokenと同じ256bit乱数・SHA-256ハッシュの
 * 仕組みをそのまま再利用する（実装を分ける理由が無いため関数を共有する）。
 * claim_tokenが「1回きりの受け取り権」であるのに対し、access_tokenは
 * 「その決済の予測を何度でも再閲覧できる鍵」という別の用途で使う。
 */
export const generateAccessToken = generateClaimToken;
export const hashAccessToken = hashClaimToken;

/**
 * 「購入履歴の端末変更復旧」用のワンタイム・短命な復旧トークン。
 * 仕組み（256bit乱数・SHA-256ハッシュ化してDB保存）はclaim_token/access_token
 * と同じだが、用途が異なる（単回使用・短い有効期限つき）ため名前を分ける。
 */
export const generateRecoveryToken = generateClaimToken;
export const hashRecoveryToken = hashClaimToken;

/** payment_public_id / entitlement_public_id / intent_public_id 用の公開ID（UUID） */
export function generatePublicId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
