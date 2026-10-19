(function(){
  const list=document.getElementById('historyList'), status=document.getElementById('statusLabel'), err=document.getElementById('errorMsg'), more=document.getElementById('moreBtn');
  let cursor=null, loading=false;
  const esc=(v)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function card(p){const el=document.createElement('div');el.className='result is-visible';el.innerHTML=`<div class="result__row"><span>${esc(p.display_id)}</span><span>${p.numbers.map(n=>String(n).padStart(2,'0')).join(' ')}</span></div><div class="result__locked">第${esc(p.draw_number)}回 ・ ${esc(p.generated_at)}</div>`;list.appendChild(el)}
  async function load(){if(loading)return;loading=true;more.disabled=true;try{const q=cursor?`?limit=20&before=${encodeURIComponent(cursor)}`:'?limit=20';const r=await fetch(`${window.ApiConfig.BASE_URL}/api/history${q}`);if(!r.ok)throw new Error();const b=await r.json();b.predictions.forEach(card);cursor=b.next_cursor;status.classList.remove('is-active');status.textContent=list.children.length?`公開済み ${list.children.length}件を表示`:'公開済み予測はまだありません';more.hidden=!cursor;}catch(e){status.classList.remove('is-active');err.textContent='履歴を取得できませんでした。時間をおいて再読み込みしてください。';err.classList.add('is-visible')}finally{loading=false;more.disabled=false}}
  more.addEventListener('click',load);load();
})();
