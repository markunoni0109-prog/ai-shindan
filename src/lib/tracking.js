function isoDay(s){ return String(s).slice(0,10); }
function dayDiff(a,b){ return Math.max(0, Math.floor((Date.parse(isoDay(b)+'T00:00:00Z')-Date.parse(isoDay(a)+'T00:00:00Z'))/86400000)); }
export function equivalentRank(main, bonus){ if(main===6)return'1'; if(main===5&&bonus)return'2'; if(main===5)return'3'; if(main===4)return'4'; if(main===3)return'5'; return null; }
export function compareNumbers(pred, draw, bonus){ const set=new Set(draw); const main=pred.filter(n=>set.has(n)).length; const b=pred.includes(bonus)?1:0; return {main_match_count:main,bonus_match:b,equivalent_rank:equivalentRank(main,b)}; }
export function trackingType(generatedAt, drawDate){ return isoDay(drawDate) <= isoDay(generatedAt) ? 'historical_backtest' : 'forward_tracking'; } // 日付しかない回は同日を保守的にhistorical扱い（未来実績の誤認防止）
async function all(db,sql,...binds){ return (await db.prepare(sql).bind(...binds).all()).results; }
export async function rebuildSummary(db,predictionId,now=new Date().toISOString()){
 const rows=await all(db,`SELECT pm.*,d.draw_number,d.draw_date FROM prediction_matches pm JOIN lottery_draws d ON d.draw_id=pm.draw_id WHERE pm.prediction_id=? AND pm.tracking_type='forward_tracking' ORDER BY d.draw_date,d.draw_number`,predictionId);
 let best=null, first=null;
 for(const r of rows){ if(!first&&r.main_match_count>=3)first=r; if(!best||r.main_match_count>best.main_match_count||(r.main_match_count===best.main_match_count&&r.bonus_match>best.bonus_match))best=r; }
 await db.prepare(`INSERT INTO prediction_tracking_summary(prediction_id,checked_draw_count,best_main_match_count,best_bonus_match,best_equivalent_rank,best_draw_id,days_to_best,draws_to_best,first_3plus_draw_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(prediction_id) DO UPDATE SET checked_draw_count=excluded.checked_draw_count,best_main_match_count=excluded.best_main_match_count,best_bonus_match=excluded.best_bonus_match,best_equivalent_rank=excluded.best_equivalent_rank,best_draw_id=excluded.best_draw_id,days_to_best=excluded.days_to_best,draws_to_best=excluded.draws_to_best,first_3plus_draw_id=excluded.first_3plus_draw_id,updated_at=excluded.updated_at`).bind(predictionId,rows.length,best?.main_match_count||0,best?.bonus_match||0,best?.equivalent_rank||null,best?.draw_id||null,best?.elapsed_days??null,best?.elapsed_draws??null,first?.draw_id||null,now).run();
}
export async function matchPredictionToDraw(db,pred,draw,now=new Date().toISOString()){
 const type=trackingType(pred.generated_at,draw.draw_date); const nums=[pred.number_1,pred.number_2,pred.number_3,pred.number_4,pred.number_5,pred.number_6]; const dn=[draw.n1,draw.n2,draw.n3,draw.n4,draw.n5,draw.n6]; const m=compareNumbers(nums,dn,draw.bonus_number);
 let elapsedDays=null, elapsedDraws=null;
 if(type==='forward_tracking'){ elapsedDays=dayDiff(pred.generated_at,draw.draw_date); const c=await db.prepare(`SELECT COUNT(*) c FROM lottery_draws WHERE draw_date>=substr(?,1,10) AND draw_date<=?`).bind(pred.generated_at,draw.draw_date).first(); elapsedDraws=c.c; }
 await db.prepare(`INSERT OR IGNORE INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws,checked_at) VALUES(?,?,?,?,?,?,?,?,?)`).bind(pred.prediction_id,draw.draw_id,type,m.main_match_count,m.bonus_match,m.equivalent_rank,elapsedDays,elapsedDraws,now).run();
 await rebuildSummary(db,pred.prediction_id,now); return {...m,tracking_type:type,elapsed_days:elapsedDays,elapsed_draws:elapsedDraws};
}
export async function processDraw(db,drawId){ const draw=await db.prepare(`SELECT * FROM lottery_draws WHERE draw_id=?`).bind(drawId).first(); if(!draw)throw new Error('draw_not_found'); const preds=await all(db,`SELECT prediction_id,generated_at,number_1,number_2,number_3,number_4,number_5,number_6 FROM predictions`); for(const p of preds)await matchPredictionToDraw(db,p,draw); return {processed:preds.length}; }
const BACKFILL_BATCH_SIZE=50;
/**
 * 【性能修正・最小変更】1予測をclaim時に全過去抽選と照合する経路。
 * 元実装はmatchPredictionToDraw(=INSERT 1件 + rebuildSummary 1回=SELECT+UPSERT)を
 * 抽選回数ぶん逐次awaitしており、まとめ買い(最大50予測)×本番相当の抽選回数
 * (LOTO6は2000年開始・週2回転開ですでに2000回超)では
 * 「予測数 × 抽選回数 × 複数回のawait」が直列に発生し、Workersのリクエスト
 * タイムアウトに抵触し得た。matchPredictionToDraw自体(processDraw経路で
 * 新規抽選1回を全予測に配る際に使われる、既存の正常動作)は一切変更せず、
 * backfillPredictionだけ「判定はJSで計算し、prediction_matchesへのINSERTは
 * batch()でまとめて1〜数回のD1往復に圧縮し、summaryの再計算は全件挿入後に
 * 1回だけ行う」実装に置き換える。書き込む行の内容・件数は
 * matchPredictionToDrawをdraws.length回呼んだ場合と完全に同一になるよう、
 * 同じ判定関数(trackingType/compareNumbers/dayDiff)をそのまま使う。
 */
export async function backfillPrediction(db,predictionId){
 const p=await db.prepare(`SELECT prediction_id,generated_at,number_1,number_2,number_3,number_4,number_5,number_6 FROM predictions WHERE prediction_id=?`).bind(predictionId).first();
 if(!p)throw new Error('prediction_not_found');
 const draws=await all(db,`SELECT * FROM lottery_draws ORDER BY draw_date,draw_number`);
 const nums=[p.number_1,p.number_2,p.number_3,p.number_4,p.number_5,p.number_6];
 const now=new Date().toISOString();
 const stmts=draws.map((d)=>{
  const type=trackingType(p.generated_at,d.draw_date);
  const dn=[d.n1,d.n2,d.n3,d.n4,d.n5,d.n6];
  const m=compareNumbers(nums,dn,d.bonus_number);
  let elapsedDays=null, elapsedDraws=null;
  if(type==='forward_tracking'){
   elapsedDays=dayDiff(p.generated_at,d.draw_date);
   // 元のCOUNT(*) FROM lottery_draws WHERE draw_date>=substr(generated_at,1,10) AND draw_date<=draw.draw_date
   // と完全に同じ集合を、既に取得済みのdraws配列から数えることで置き換える（D1往復を増やさない）。
   const gte=isoDay(p.generated_at);
   elapsedDraws=draws.filter((dd)=>dd.draw_date>=gte && dd.draw_date<=d.draw_date).length;
  }
  return db.prepare(`INSERT OR IGNORE INTO prediction_matches(prediction_id,draw_id,tracking_type,main_match_count,bonus_match,equivalent_rank,elapsed_days,elapsed_draws,checked_at) VALUES(?,?,?,?,?,?,?,?,?)`)
   .bind(p.prediction_id,d.draw_id,type,m.main_match_count,m.bonus_match,m.equivalent_rank,elapsedDays,elapsedDraws,now);
 });
 for(let i=0;i<stmts.length;i+=BACKFILL_BATCH_SIZE){
  const chunk=stmts.slice(i,i+BACKFILL_BATCH_SIZE);
  if(chunk.length)await db.batch(chunk);
 }
 await rebuildSummary(db,predictionId,now);
 return {processed:draws.length};
}
export async function researchStats(db){
 const total=(await db.prepare(`SELECT COUNT(*) c FROM predictions`).first()).c; const matches=(await db.prepare(`SELECT COUNT(*) c FROM prediction_matches`).first()).c; const f=await db.prepare(`SELECT SUM(main_match_count=3 AND bonus_match=0) m3,SUM(main_match_count=4) m4,SUM(main_match_count=5 AND bonus_match=0) m5,SUM(main_match_count=5 AND bonus_match=1) m5b,SUM(main_match_count=6) m6 FROM prediction_matches WHERE tracking_type='forward_tracking'`).first(); const a=await db.prepare(`SELECT AVG(days_to_best) avg_days,AVG(draws_to_best) avg_draws FROM prediction_tracking_summary WHERE best_draw_id IS NOT NULL`).first();
 return {total_predictions:total,total_comparisons:matches,forward:{match_3:Number(f.m3||0),match_4:Number(f.m4||0),match_5:Number(f.m5||0),match_5_bonus:Number(f.m5b||0),match_6:Number(f.m6||0),avg_days_to_best:a.avg_days??null,avg_draws_to_best:a.avg_draws??null}};
}
export function deriveFeatures(numbers, algorithmVersion){ const sum=numbers.reduce((a,b)=>a+b,0); const odd=numbers.filter(n=>n%2).length; const low=numbers.filter(n=>n<=14).length, mid=numbers.filter(n=>n>=15&&n<=29).length, high=numbers.filter(n=>n>=30).length; let consecutive=0,gap2=0; const gaps=[]; for(let i=1;i<numbers.length;i++){const g=numbers[i]-numbers[i-1];gaps.push(g);if(g===1)consecutive++;if(g===2)gap2++;} return {sum,odd,even:6-odd,low,mid,high,consecutive_pairs:consecutive,gap2_pairs:gap2,gaps,algorithm_version:algorithmVersion}; }
export async function captureFeatures(db,prediction){ const features=deriveFeatures(prediction.numbers,prediction.algorithm_version); await db.prepare(`INSERT OR IGNORE INTO prediction_generation_features(prediction_id,features_json,captured_at) VALUES(?,?,?)`).bind(prediction.prediction_id,JSON.stringify(features),prediction.generated_at).run(); return features; }
