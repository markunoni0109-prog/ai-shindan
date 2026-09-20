import { generateClaimToken, hashClaimToken, generatePublicId } from './lib/tokens.js';
import { claimEntitlement, ClaimError } from './lib/db.js';
import { createCheckoutSession, verifyStripeSignature } from './lib/stripe.js';
import { handleCheckoutSessionCompleted, WebhookIgnored } from './lib/webhook.js';
import { checkRateLimit, clientIdentifier } from './lib/ratelimit.js';
import { corsHeaders, handlePreflight } from './lib/cors.js';
import { processDraw, backfillPrediction, researchStats, captureFeatures } from './lib/tracking.js';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

function errorResponse(status, code, message, extraHeaders = {}) {
  // 【重要】内部情報（SQLエラー文・スタックトレース・Stripeの生エラー等）を絶対にそのまま返さない
  return json({ error: { code, message } }, status, extraHeaders);
}

const PLAN_CATALOG = {
  single: { amount: 300, allowed_predictions: 1 },
};
const PREDICTION_SCOPE = 'PERMANENT_TRACKING';

function frontendBase(env) {
  return env.FRONTEND_BASE_URL || 'https://ai-hunter.jp';
}

async function handleCheckoutCreate(request, env, cors) {
  const rl = await checkRateLimit(
    env.DB,
    { key: `checkout:${clientIdentifier(request)}`, limit: 10, windowSeconds: 60 }
  );
  if (!rl.allowed) return errorResponse(429, 'rate_limited', 'しばらくしてから再度お試しください', cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', 'リクエストボディが不正です', cors);
  }
  const planCode = body?.plan_code;
  if (!PLAN_CATALOG[planCode]) {
    return errorResponse(400, 'invalid_plan_code', 'plan_codeが不正です', cors);
  }

  const plainToken = generateClaimToken();
  const tokenHash = await hashClaimToken(plainToken);
  const intentPublicId = generatePublicId('intent');

  await env.DB.prepare(
    `INSERT INTO purchase_intents (intent_public_id, plan_code, claim_token_hash, status)
     VALUES (?, ?, ?, 'pending')`
  )
    .bind(intentPublicId, planCode, tokenHash)
    .run();

  const base = frontendBase(env);
  // claim_tokenはURLのfragmentに埋める（サーバーログ・Referer等に残らないため）。
  // session_idはStripeのプレースホルダーで置換される（クエリ側）。
  const successUrl = `${base}/loto6/result/?session_id={CHECKOUT_SESSION_ID}#claim=${plainToken}`;
  const cancelUrl = `${base}/loto6/?checkout=cancelled`;

  let session;
  try {
    session = await createCheckoutSession(env, { intentPublicId, successUrl, cancelUrl });
  } catch (err) {
    // Stripe側のエラー詳細は外へ出さない
    return errorResponse(502, 'checkout_session_failed', '決済セッションの作成に失敗しました', cors);
  }

  await env.DB.prepare(`UPDATE purchase_intents SET stripe_checkout_session_id = ? WHERE intent_public_id = ?`)
    .bind(session.id, intentPublicId)
    .run();

  return json(
    {
      plan_code: planCode,
      amount: PLAN_CATALOG[planCode].amount,
      currency: 'jpy',
      claim_token: plainToken, // ブラウザへ平文で返すのはこの1回だけ
      checkout_url: session.url,
    },
    200,
    cors
  );
}

async function handlePurchaseStatus(request, env, cors) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return errorResponse(400, 'missing_session_id', 'session_idが必要です', cors);

  const intent = await env.DB.prepare(
    `SELECT status FROM purchase_intents WHERE stripe_checkout_session_id = ?`
  )
    .bind(sessionId)
    .first();

  if (!intent) return json({ status: 'pending' }, 200, cors); // Webhookがまだ届いていない可能性

  const statusMap = { pending: 'pending', fulfilled: 'ready', expired: 'failed' };
  // 【重要】claim_token・予測数字・Stripe内部IDは絶対に含めない
  return json({ status: statusMap[intent.status] || 'pending' }, 200, cors);
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('stripe-signature');
  const verification = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verification.valid) {
    // 署名やbody本文はログに出さない。理由コードのみ。
    console.error('stripe webhook signature rejected:', verification.reason);
    return errorResponse(400, 'invalid_signature', 'signature verification failed');
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, 'invalid_json', 'invalid payload');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutSessionCompleted(env.DB, event);
    }
    // 対応していないイベント種別は無視して200を返す（Stripeの再送を止める）
    return json({ received: true });
  } catch (err) {
    if (err instanceof WebhookIgnored) {
      return json({ received: true, ignored: err.reason });
    }
    console.error('stripe webhook processing error (event id only):', event?.id);
    return errorResponse(500, 'internal_error', 'internal error');
  }
}

async function handleClaim(request, env, cors) {
  const rl = await checkRateLimit(
    env.DB,
    { key: `claim:${clientIdentifier(request)}`, limit: 20, windowSeconds: 60 }
  );
  if (!rl.allowed) return errorResponse(429, 'rate_limited', 'しばらくしてから再度お試しください', cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', 'リクエストボディが不正です', cors);
  }
  const token = body?.claim_token;
  if (!token || typeof token !== 'string') {
    return errorResponse(400, 'missing_token', 'claim_tokenが必要です', cors);
  }

  const tokenHash = await hashClaimToken(token);

  try {
    const result = await claimEntitlement(env.DB, tokenHash, { drawNumber: PREDICTION_SCOPE });
    if (result.outcome === 'created') { for (const p of result.predictions) { await captureFeatures(env.DB, p); await backfillPrediction(env.DB, p.prediction_id); } }
    return json({ outcome: result.outcome, predictions: result.predictions }, 200, cors);
  } catch (err) {
    if (err instanceof ClaimError) {
      if (err.code === 'invalid_token') return errorResponse(404, 'invalid_token', '無効なclaim_tokenです', cors);
      if (err.code === 'retry_exhausted')
        return errorResponse(503, 'retry_exhausted', '現在混み合っています。しばらくしてから再度お試しください', cors);
    }
    return errorResponse(500, 'internal_error', '内部エラーが発生しました', cors);
  }
}

async function handleHistory(request, env, cors) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || '20'), 100);
  const before = url.searchParams.get('before');

  let query = `SELECT prediction_id, display_sequence, draw_number,
                      number_1, number_2, number_3, number_4, number_5, number_6,
                      generated_at, algorithm_version, record_hash, prediction_index
               FROM predictions`;
  const binds = [];
  if (before) {
    query += ` WHERE display_sequence < ?`;
    binds.push(Number(before));
  }
  query += ` ORDER BY display_sequence DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  const predictions = results.map((row) => ({
    prediction_id: row.prediction_id,
    display_id: '#' + String(row.display_sequence).padStart(6, '0'),
    draw_number: row.draw_number,
    numbers: [row.number_1, row.number_2, row.number_3, row.number_4, row.number_5, row.number_6],
    generated_at: row.generated_at,
    algorithm_version: row.algorithm_version,
    record_hash: row.record_hash,
  }));
  const nextCursor = results.length === limit ? results[results.length - 1].display_sequence : null;
  return json({ predictions, next_cursor: nextCursor }, 200, cors);
}

async function handleHistoryDetail(request, env, predictionId, cors) {
  const row = await env.DB.prepare(
    `SELECT prediction_id, display_sequence, draw_number,
            number_1, number_2, number_3, number_4, number_5, number_6,
            generated_at, algorithm_version, record_hash, prediction_index
     FROM predictions WHERE prediction_id = ?`
  )
    .bind(predictionId)
    .first();
  if (!row) return errorResponse(404, 'not_found', '予測が見つかりません', cors);
  return json(
    {
      prediction_id: row.prediction_id,
      display_id: '#' + String(row.display_sequence).padStart(6, '0'),
      draw_number: row.draw_number,
      numbers: [row.number_1, row.number_2, row.number_3, row.number_4, row.number_5, row.number_6],
      generated_at: row.generated_at,
      algorithm_version: row.algorithm_version,
      record_hash: row.record_hash,
    },
    200,
    cors
  );
}

async function handleStats(request, env, cors) {
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM predictions`).first();
  return json(
    {
      total_predictions: total.c,
      match_0: 0, match_1: 0, match_2: 0, match_3: 0,
      rank_5: 0, rank_4: 0, rank_3: 0, rank_2: 0, rank_1: 0,
    },
    200,
    cors
  );
}


async function handleTrackingHistory(request, env, cors) {
  const url=new URL(request.url); const limit=Math.min(Number(url.searchParams.get('limit')||'20'),100);
  const {results}=await env.DB.prepare(`SELECT p.prediction_id,p.display_sequence,p.number_1,p.number_2,p.number_3,p.number_4,p.number_5,p.number_6,p.generated_at,p.algorithm_version,p.record_hash,s.checked_draw_count,s.best_main_match_count,s.best_bonus_match,s.best_equivalent_rank,s.days_to_best,s.draws_to_best,d.draw_number AS best_draw_number,(SELECT MAX(h.main_match_count) FROM prediction_matches h WHERE h.prediction_id=p.prediction_id AND h.tracking_type='historical_backtest') AS historical_best_main_match_count,(SELECT hd.draw_number FROM prediction_matches hm JOIN lottery_draws hd ON hd.draw_id=hm.draw_id WHERE hm.prediction_id=p.prediction_id AND hm.tracking_type='historical_backtest' ORDER BY hm.main_match_count DESC,hm.bonus_match DESC,hd.draw_date DESC LIMIT 1) AS historical_best_draw_number FROM predictions p LEFT JOIN prediction_tracking_summary s ON s.prediction_id=p.prediction_id LEFT JOIN lottery_draws d ON d.draw_id=s.best_draw_id ORDER BY p.display_sequence DESC LIMIT ?`).bind(limit).all();
  return json({predictions:results.map(r=>({prediction_id:r.prediction_id,display_id:'#'+String(r.display_sequence).padStart(6,'0'),numbers:[r.number_1,r.number_2,r.number_3,r.number_4,r.number_5,r.number_6],generated_at:r.generated_at,algorithm_version:r.algorithm_version,record_hash:r.record_hash,forward:{checked_draw_count:r.checked_draw_count||0,best_main_match_count:r.best_main_match_count||0,best_bonus_match:!!r.best_bonus_match,best_equivalent_rank:r.best_equivalent_rank,best_draw_number:r.best_draw_number,days_to_best:r.days_to_best,draws_to_best:r.draws_to_best},historical_backtest:{best_main_match_count:r.historical_best_main_match_count,best_draw_number:r.historical_best_draw_number}}))},200,cors);
}
async function handleTrackingDetail(env,predictionId,cors){
 const p=await env.DB.prepare(`SELECT prediction_id,display_sequence,number_1,number_2,number_3,number_4,number_5,number_6,generated_at,algorithm_version,record_hash FROM predictions WHERE prediction_id=?`).bind(predictionId).first(); if(!p)return errorResponse(404,'not_found','予測が見つかりません',cors);
 const {results}=await env.DB.prepare(`SELECT pm.tracking_type,pm.main_match_count,pm.bonus_match,pm.equivalent_rank,pm.elapsed_days,pm.elapsed_draws,d.draw_number,d.draw_date FROM prediction_matches pm JOIN lottery_draws d ON d.draw_id=pm.draw_id WHERE pm.prediction_id=? ORDER BY d.draw_date DESC,d.draw_number DESC`).bind(predictionId).all();
 return json({prediction_id:p.prediction_id,display_id:'#'+String(p.display_sequence).padStart(6,'0'),numbers:[p.number_1,p.number_2,p.number_3,p.number_4,p.number_5,p.number_6],generated_at:p.generated_at,algorithm_version:p.algorithm_version,record_hash:p.record_hash,forward:results.filter(x=>x.tracking_type==='forward_tracking'),historical_backtest:results.filter(x=>x.tracking_type==='historical_backtest')},200,cors);
}
async function handleDrawIngest(request,env){
 const auth=request.headers.get('authorization'); if(!env.DRAW_INGEST_SECRET||auth!==`Bearer ${env.DRAW_INGEST_SECRET}`)return errorResponse(401,'unauthorized','unauthorized'); let b;try{b=await request.json()}catch{return errorResponse(400,'invalid_body','invalid body')}
 const nums=[...(b.numbers||[])].map(Number).sort((a,b)=>a-b); if(nums.length!==6||new Set(nums).size!==6||nums[0]<1||nums[5]>43||!Number.isInteger(Number(b.bonus_number))||nums.includes(Number(b.bonus_number)))return errorResponse(400,'invalid_draw','invalid draw');
 const drawId=b.draw_id||`loto6-${b.draw_number}`; await env.DB.prepare(`INSERT OR IGNORE INTO lottery_draws(draw_id,draw_number,draw_date,n1,n2,n3,n4,n5,n6,bonus_number,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(drawId,Number(b.draw_number),b.draw_date,...nums,Number(b.bonus_number),b.source).run(); const out=await processDraw(env.DB,drawId); return json({draw_id:drawId,...out});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    const preflight = handlePreflight(env, request);
    if (preflight) return preflight;
    const cors = corsHeaders(env, request);

    try {
      // Stripe webhookはCORS対象外（Stripeサーバーからのサーバー間通信のため）
      if (request.method === 'POST' && pathname === '/api/stripe/webhook') {
        return await handleStripeWebhook(request, env);
      }
      if (request.method === 'POST' && pathname === '/api/checkout/create') {
        return await handleCheckoutCreate(request, env, cors);
      }
      if (request.method === 'GET' && pathname === '/api/purchases/status') {
        return await handlePurchaseStatus(request, env, cors);
      }
      if (request.method === 'POST' && pathname === '/api/predictions/claim') {
        return await handleClaim(request, env, cors);
      }
      if (request.method === 'GET' && pathname === '/api/history') {
        return await handleHistory(request, env, cors);
      }
      if (request.method === 'GET' && pathname.startsWith('/api/history/')) {
        const id = decodeURIComponent(pathname.slice('/api/history/'.length));
        return await handleHistoryDetail(request, env, id, cors);
      }
      if (request.method === 'GET' && pathname === '/api/stats') { return await handleStats(request, env, cors); }
      if (request.method === 'GET' && pathname === '/api/tracking') { return await handleTrackingHistory(request, env, cors); }
      if (request.method === 'GET' && pathname.startsWith('/api/tracking/')) { return await handleTrackingDetail(env, decodeURIComponent(pathname.slice('/api/tracking/'.length)), cors); }
      if (request.method === 'GET' && pathname === '/api/research/stats') { return json(await researchStats(env.DB),200,cors); }
      if (request.method === 'POST' && pathname === '/api/admin/draws') { return await handleDrawIngest(request,env); }
      return errorResponse(404, 'not_found', 'not found', cors);
    } catch (err) {
      return errorResponse(500, 'internal_error', '内部エラーが発生しました', cors);
    }
  },
};
