import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Shim } from './d1shim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 毎テストごとに完全に新しいDBを作る（:memory:）。migrationsを実ファイルから適用。 */
export function createTestDb() {
  const rawDb = new DatabaseSync(':memory:');
  rawDb.exec('PRAGMA foreign_keys = ON');

  const migrationsDir = path.join(ROOT, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    rawDb.exec(sql);
  }

  return new D1Shim(rawDb);
}

import { TEST_STRIPE_SECRET_KEY, TEST_STRIPE_WEBHOOK_SECRET, makeFakeStripeFetch } from './stripeMock.js';

/** WorkerのfetchハンドラへPOSTするための標準テスト用env */
export function createTestEnv(db, overrides = {}) {
  return {
    DB: db,
    STRIPE_SECRET_KEY: TEST_STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: TEST_STRIPE_WEBHOOK_SECRET,
    FRONTEND_BASE_URL: 'https://ai-hunter.jp',
    ALLOWED_ORIGINS: 'https://ai-hunter.jp',
    __testFetch: makeFakeStripeFetch(),
    ...overrides,
  };
}

