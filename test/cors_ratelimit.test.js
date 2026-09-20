import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';

function req(method, path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('CORS: 許可originにはAccess-Control-Allow-Originが返る', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(
    req('GET', '/api/stats', null, { origin: 'https://ai-hunter.jp' }),
    env
  );
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://ai-hunter.jp');
});

test('CORS: 許可されていないoriginにはCORSヘッダーを一切付けない（ブラウザ側でブロックされる）', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(
    req('GET', '/api/stats', null, { origin: 'https://evil.example.com' }),
    env
  );
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS: OPTIONSプリフライトに204で応答する', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const res = await worker.fetch(
    req('OPTIONS', '/api/predictions/claim', null, { origin: 'https://ai-hunter.jp' }),
    env
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://ai-hunter.jp');
});

test('rate limit: claim APIへの大量リクエスト（token総当たり想定）は途中から429になる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const results = [];
  for (let i = 0; i < 25; i++) {
    const res = await worker.fetch(
      req('POST', '/api/predictions/claim', { claim_token: `guess-${i}` }),
      env
    );
    results.push(res.status);
  }
  assert.ok(results.includes(429), '20回/分の上限を超えたリクエストが429になっている');
  assert.ok(results.slice(0, 20).every((s) => s === 404), '上限内は通常どおり404（token不正）として処理される');
});

test('rate limit: checkout/create連打も一定回数で429になる', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  const results = [];
  for (let i = 0; i < 15; i++) {
    const res = await worker.fetch(req('POST', '/api/checkout/create', { plan_code: 'single' }), env);
    results.push(res.status);
  }
  assert.ok(results.includes(429), '10回/分の上限を超えたら429になっている');
});

test('rate limitはIPごとに独立している', async () => {
  const db = createTestDb();
  const env = createTestEnv(db);
  for (let i = 0; i < 20; i++) {
    await worker.fetch(
      req('POST', '/api/predictions/claim', { claim_token: 'x' }, { 'cf-connecting-ip': '1.1.1.1' }),
      env
    );
  }
  // 別IPからは制限に引っかからず通常応答（404）になる
  const res = await worker.fetch(
    req('POST', '/api/predictions/claim', { claim_token: 'y' }, { 'cf-connecting-ip': '2.2.2.2' }),
    env
  );
  assert.equal(res.status, 404);
});
