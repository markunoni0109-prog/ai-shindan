/**
 * cors.js
 * ------------------------------------------------------------------
 * env.ALLOWED_ORIGINS（カンマ区切り。例: "https://ai-hunter.jp"）に
 * 一致するOriginにのみCORSを許可する。一致しない場合はCORSヘッダーを
 * 一切付けない（＝ブラウザ側でブロックされる）。
 * ------------------------------------------------------------------
 */
export function resolveAllowedOrigin(env, requestOrigin) {
  const allowList = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!requestOrigin) return null;
  return allowList.includes(requestOrigin) ? requestOrigin : null;
}

export function corsHeaders(env, request) {
  const origin = request.headers.get('origin');
  const allowed = resolveAllowedOrigin(env, origin);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

export function handlePreflight(env, request) {
  if (request.method !== 'OPTIONS') return null;
  const headers = corsHeaders(env, request);
  return new Response(null, { status: 204, headers });
}
