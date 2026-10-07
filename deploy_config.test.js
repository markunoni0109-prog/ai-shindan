import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, createTestEnv } from './harness.js';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 【本番404事故の再発防止】
 * 本番で「FREE生成が not_found」になった原因は、フロントが呼ぶWorker(ai-shindan)に
 * FREE route入りのコードが載っていなかったこと（wrangler.tomlのnameが本番Worker名と
 * 食い違っていた）。ここでは (1) wrangler.tomlのnameがフロントの呼び先Workerと一致し、
 * (2) フロントが叩くendpointをWorkerが実際に提供していることを機械的に守る。
 */
test('wrangler.tomlのnameは、フロント(api-config.js)が呼ぶ本番Workerの名前と一致する', () => {
  const base = read('loto6/js/api-config.js').match(/BASE_URL:\s*'https:\/\/([^.]+)\./);
  assert.ok(base, 'api-config.jsのBASE_URLを読めること');
  const name = read('wrangler.toml').match(/^name\s*=\s*"([^"]+)"/m);
  assert.ok(name, 'wrangler.tomlにnameがあること');
  assert.equal(name[1], base[1]);
});

test('FREE画面(app.js)が呼ぶAPI pathを、Workerが404にせず処理する（route存在確認）', async () => {
  const m = read('loto6/js/app.js').match(/\$\{apiBase\}(\/api\/[a-z/_-]+)/);
  assert.ok(m, 'app.jsのAPI pathを読めること');
  assert.equal(m[1], '/api/free/generate');
  const env = createTestEnv(createTestDb());
  const res = await worker.fetch(
    new Request(`https://x.test${m[1]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://ai-hunter.jp' },
      body: JSON.stringify({ anon_id: 'x' }), // 不正値: routeがあれば400、無ければ404
    }),
    env
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_anon_id');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://ai-hunter.jp');
});
