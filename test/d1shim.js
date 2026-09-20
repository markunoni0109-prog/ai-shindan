/**
 * d1shim.js
 * ------------------------------------------------------------------
 * D1DatabaseのWorker API（prepare/bind/first/all/run/batch/exec）を
 * Node.js組み込みの node:sqlite （DatabaseSync）の上に実装したテスト用アダプタ。
 *
 * 【why node:sqlite】以前はネイティブアドオン型のSQLiteドライバを使っていたが、
 * クリーンな `npm ci` 環境ではプリビルドバイナリが解決できず
 * node-gyp によるソースビルドにフォールバックし、Node.jsヘッダー取得先
 * （nodejs.org）へのネットワークアクセスが許可されていない環境では
 * ビルドに失敗して `npm test` 自体が実行できなくなる問題があった。
 * node:sqliteはNode.js本体に同梱されており、追加の依存パッケージも
 * ネイティブビルドも一切不要なため、この問題を構造的に解消できる。
 * Node.js 22.5+ で利用可能（実験的機能。stderrに警告が出るが動作に影響なし）。
 *
 * D1公式ドキュメントによれば、batch()に渡した文は「順番に・非並行に
 * 実行・コミットされ、途中の文が失敗すればシーケンス全体を中断・
 * ロールバックする」。D1自体がSQLiteベースであるため、本シムでは
 * DatabaseSyncのトランザクション（BEGIN/COMMIT/ROLLBACK）でbatchを包み、
 * この挙動を忠実に再現する。
 *
 * 【重要な限界】これはあくまでSQLiteレベルの挙動の忠実な再現であり、
 * D1固有の分散環境（プライマリ／read replica間のレイテンシ、
 * Sessions APIのbookmark機構、実際のネットワーク層でのbatch分割上限等）
 * までは再現しない。したがって本テストで確認できるのは「SQLの原子性・
 * 制約・トリガーのロジックが設計どおりに機能するか」であり、
 * 「Cloudflareの本番D1環境で同一挙動になるか」は別途、実際のremote D1
 * での確認が必要（README「既知の問題」に明記）。
 * ------------------------------------------------------------------
 */

class D1PreparedStatement {
  constructor(rawDb, sql) {
    this.rawDb = rawDb;
    this.sql = sql;
    this.params = [];
  }
  bind(...args) {
    this.params = args;
    return this;
  }
  _stmt() {
    return this.rawDb.prepare(this.sql);
  }
  async first() {
    const row = this._stmt().get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    const rows = this._stmt().all(...this.params);
    return { results: rows, success: true, meta: {} };
  }
  async run() {
    const info = this._stmt().run(...this.params);
    return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
}

export class D1Shim {
  constructor(rawDb) {
    this.rawDb = rawDb;
  }
  prepare(sql) {
    return new D1PreparedStatement(this.rawDb, sql);
  }
  async exec(sql) {
    this.rawDb.exec(sql);
    return { count: 0, duration: 0 };
  }
  /** D1のbatch()：全成功 or 全ロールバック。順序どおり非並行に実行。 */
  async batch(stmts) {
    const results = [];
    this.rawDb.exec('BEGIN');
    try {
      for (const s of stmts) {
        const info = s._stmt().run(...s.params);
        results.push({ success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } });
      }
      this.rawDb.exec('COMMIT');
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
    return results;
  }
}

