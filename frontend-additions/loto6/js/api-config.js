/**
 * api-config.js
 * ------------------------------------------------------------------
 * STEP 2B/2C 新規追加ファイル。Phase 1の既存ファイル（config.js等）は
 * 一切変更していない。
 *
 * 【人間が設定する項目】BASE_URLは実際にデプロイしたCloudflare Worker
 * のURL（カスタムドメインを割り当てる場合はそのドメイン）に置き換える。
 * ------------------------------------------------------------------
 */
window.ApiConfig = {
  BASE_URL: 'https://REPLACE_WITH_WORKER_URL', // 例: https://api.ai-hunter.jp
};
