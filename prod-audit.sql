-- 本番D1 読み取り専用監査（SELECTのみ・1文）。migration 0007/0008 の適用前後の両方で同じものを実行して比較する。
-- 使い方: bash scripts/prod-audit.sh   （内部で wrangler d1 execute --remote --command にこのファイルを渡す）
SELECT 'A1_applied_migrations' AS check_name,
       COALESCE((SELECT group_concat(name, ' | ') FROM d1_migrations), '(none)') AS value,
       '適用前: 0001〜0006 / 適用後: 0001〜0008' AS expected
UNION ALL SELECT 'A2_partial_leftover_count',
       (SELECT COUNT(*) FROM sqlite_master WHERE instr(name,'_old_00')>0 OR instr(name,'_bk00')>0 OR instr(name,'_mig00')>0 OR instr(sql,'_old_00')>0),
       '0（0以外＝途中適用の痕跡。migrationを実行せず結果を共有）'
UNION ALL SELECT 'A3_partial_leftover_names',
       COALESCE((SELECT group_concat(name, ',') FROM sqlite_master WHERE instr(name,'_old_00')>0 OR instr(name,'_bk00')>0 OR instr(name,'_mig00')>0 OR instr(sql,'_old_00')>0), '-'),
       '-'
UNION ALL SELECT 'B1_free_tables_present',
       (SELECT COUNT(*) FROM sqlite_master WHERE name IN ('free_generation_locks','free_generation_log')),
       '適用前: 0 / 0007後: 2'
UNION ALL SELECT 'B2_entitlements_has_anon_id',
       (SELECT COUNT(*) FROM sqlite_master WHERE name='purchase_entitlements' AND instr(sql,'anon_id')>0),
       '適用前: 0 / 0007後: 1'
UNION ALL SELECT 'B3_payments_check_allows_free',
       (SELECT COUNT(*) FROM sqlite_master WHERE name='payments' AND instr(sql,'''free''')>0),
       '適用前: 0 / 0007後: 1'
UNION ALL SELECT 'B4_payments_check_allows_pack5',
       (SELECT COUNT(*) FROM sqlite_master WHERE name='payments' AND instr(sql,'''pack5''')>0),
       '適用前/0007後: 0 / 0008後: 1'
UNION ALL SELECT 'B5_entitlements_allows_5',
       (SELECT COUNT(*) FROM sqlite_master WHERE name='purchase_entitlements' AND instr(sql,'(1,5,10,30,50)')>0),
       '適用前/0007後: 0 / 0008後: 1'
UNION ALL SELECT 'B6_trigger_names',
       (SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name)),
       'trg_predictions_no_update/delete, trg_prediction_matches_no_update/delete, trg_lottery_draws_no_update/delete（0007後は + trg_free_lock_24h, trg_free_generation_log_no_update/delete）'
UNION ALL SELECT 'C_count_payments', (SELECT COUNT(*) FROM payments), '適用前後で一致'
UNION ALL SELECT 'C_count_purchase_intents', (SELECT COUNT(*) FROM purchase_intents), '適用前後で一致'
UNION ALL SELECT 'C_count_purchase_entitlements', (SELECT COUNT(*) FROM purchase_entitlements), '適用前後で一致'
UNION ALL SELECT 'C_count_predictions', (SELECT COUNT(*) FROM predictions), '適用前後で一致'
UNION ALL SELECT 'C_count_prediction_results', (SELECT COUNT(*) FROM prediction_results), '適用前後で一致'
UNION ALL SELECT 'C_count_prediction_matches', (SELECT COUNT(*) FROM prediction_matches), '適用前後で一致'
UNION ALL SELECT 'C_count_prediction_tracking_summary', (SELECT COUNT(*) FROM prediction_tracking_summary), '適用前後で一致'
UNION ALL SELECT 'C_count_prediction_generation_features', (SELECT COUNT(*) FROM prediction_generation_features), '適用前後で一致'
UNION ALL SELECT 'C_count_lottery_draws', (SELECT COUNT(*) FROM lottery_draws), '適用前後で一致'
UNION ALL SELECT 'C_count_recovery_requests', (SELECT COUNT(*) FROM recovery_requests), '適用前後で一致'
UNION ALL SELECT 'D1_plan_code_distribution',
       COALESCE((SELECT group_concat(plan_code || ':' || n, ', ') FROM (SELECT plan_code, COUNT(*) AS n FROM payments GROUP BY plan_code ORDER BY plan_code)), '-'),
       '適用前後で一致（legacy singleの有無を確認）'
UNION ALL SELECT 'D2_predictions_fingerprint',
       (SELECT COUNT(*) || '|id:' || COALESCE(MIN(id),'-') || '-' || COALESCE(MAX(id),'-') || '|seq_sum:' || COALESCE(SUM(display_sequence),0) || '|id_sum:' || COALESCE(SUM(id),0) || '|num_sum:' || COALESCE(SUM(number_1+number_2+number_3+number_4+number_5+number_6),0) FROM predictions),
       '適用前後で完全一致'
UNION ALL SELECT 'D3_chain_head_hash', COALESCE((SELECT record_hash FROM predictions ORDER BY display_sequence ASC LIMIT 1), '-'), '適用前後で完全一致'
UNION ALL SELECT 'D4_chain_tail_hash', COALESCE((SELECT record_hash FROM predictions ORDER BY display_sequence DESC LIMIT 1), '-'), '適用前後で完全一致'
UNION ALL SELECT 'D5_first_previous_hash', COALESCE((SELECT previous_hash FROM predictions ORDER BY display_sequence ASC LIMIT 1), '-'), 'AIHUNTER_LOTO6_GENESIS_V1'
UNION ALL SELECT 'D6_hash_chain_breaks',
       (SELECT COUNT(*) FROM predictions p JOIN predictions q ON q.display_sequence = p.display_sequence - 1 WHERE p.previous_hash <> q.record_hash),
       '0'
UNION ALL SELECT 'D7_payment_fingerprint',
       (SELECT COUNT(*) || '|amount_sum:' || COALESCE(SUM(amount),0) || '|paid:' || COALESCE(SUM(payment_status='paid'),0) FROM payments),
       '適用前後で完全一致'
UNION ALL SELECT 'D8_entitlement_fingerprint',
       (SELECT COUNT(*) || '|allowed_sum:' || COALESCE(SUM(allowed_predictions),0) || '|consumed_sum:' || COALESCE(SUM(consumed_predictions),0) FROM purchase_entitlements),
       '適用前後で完全一致'
UNION ALL SELECT 'E1_orphan_intents_payment', (SELECT COUNT(*) FROM purchase_intents i LEFT JOIN payments p ON p.id=i.payment_id WHERE i.payment_id IS NOT NULL AND p.id IS NULL), '0（0以外＝既存データに外部キー違反。migrationを実行せず結果を共有）'
UNION ALL SELECT 'E2_orphan_entitlements_payment', (SELECT COUNT(*) FROM purchase_entitlements e LEFT JOIN payments p ON p.id=e.payment_id WHERE e.payment_id IS NOT NULL AND p.id IS NULL), '0'
UNION ALL SELECT 'E3_orphan_entitlements_intent', (SELECT COUNT(*) FROM purchase_entitlements e LEFT JOIN purchase_intents i ON i.id=e.purchase_intent_id WHERE e.purchase_intent_id IS NOT NULL AND i.id IS NULL), '0'
UNION ALL SELECT 'E4_orphan_predictions_payment', (SELECT COUNT(*) FROM predictions x LEFT JOIN payments p ON p.id=x.payment_id WHERE p.id IS NULL), '0'
UNION ALL SELECT 'E5_orphan_predictions_entitlement', (SELECT COUNT(*) FROM predictions x LEFT JOIN purchase_entitlements e ON e.id=x.entitlement_id WHERE e.id IS NULL), '0'
UNION ALL SELECT 'E6_orphan_results', (SELECT COUNT(*) FROM prediction_results r LEFT JOIN predictions x ON x.prediction_id=r.prediction_id WHERE x.id IS NULL), '0'
UNION ALL SELECT 'E7_orphan_matches', (SELECT COUNT(*) FROM prediction_matches m LEFT JOIN predictions x ON x.prediction_id=m.prediction_id LEFT JOIN lottery_draws d ON d.draw_id=m.draw_id WHERE x.id IS NULL OR d.id IS NULL), '0'
UNION ALL SELECT 'E8_orphan_summary', (SELECT COUNT(*) FROM prediction_tracking_summary s LEFT JOIN predictions x ON x.prediction_id=s.prediction_id WHERE x.id IS NULL), '0'
UNION ALL SELECT 'E9_orphan_features', (SELECT COUNT(*) FROM prediction_generation_features f LEFT JOIN predictions x ON x.prediction_id=f.prediction_id WHERE x.id IS NULL), '0'
UNION ALL SELECT 'F1_consumed_entitlement_mismatch',
       (SELECT COUNT(*) FROM purchase_entitlements e WHERE e.status='consumed' AND e.consumed_predictions <> (SELECT COUNT(*) FROM predictions x WHERE x.entitlement_id=e.id)),
       '0（0以外は既存データの不整合。変更せず報告）'
UNION ALL SELECT 'F2_predictions_without_tracking_features', (SELECT COUNT(*) FROM predictions x LEFT JOIN prediction_generation_features f ON f.prediction_id=x.prediction_id WHERE f.prediction_id IS NULL), '参考値（適用前後で一致）';
