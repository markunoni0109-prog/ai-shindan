(() => {
  'use strict';

  const DATA_URL = 'data_master.json';
  const TOKYO_CENTER = [35.681236, 139.767125];

  const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const validCoord = (r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && Number(r.lat) >= 20 && Number(r.lat) <= 50 && Number(r.lng) >= 120 && Number(r.lng) <= 155;

  function toiletIcon(isGod) {
    return L.divIcon({
      className: 'ths-map-marker-wrap',
      html: isGod
        ? '<div style="width:40px;height:40px;border-radius:50%;background:#111;border:3px solid #c79b2b;box-shadow:0 2px 7px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-size:22px">👑</div>'
        : '<div style="width:34px;height:34px;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:#fff;border:3px solid #ff6b42;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center"><span style="transform:rotate(45deg);font-size:17px">🚻</span></div>',
      iconSize: isGod ? [40,40] : [34,34],
      iconAnchor: isGod ? [20,20] : [17,30],
      popupAnchor: [0,-30]
    });
  }

  function detailHtml(r) {
    const name = esc(r.name_ja || r.name_en || 'トイレ');
    const address = esc(r.address || '住所情報なし');
    const hours = esc(r.open_hours || '営業時間未確認');
    const memo = esc(r.ai_hunter_memo || r.user_field_note || '');
    const walk = r.google_maps_walk || (validCoord(r) ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(r.lat)},${encodeURIComponent(r.lng)}&travelmode=walking` : '');
    return `<div style="min-width:210px;max-width:300px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="font-weight:800;font-size:16px;margin-bottom:6px">${r.isGodToilet ? '👑 ' : ''}${name}</div>
      <div style="font-size:12px;line-height:1.55;color:#333">${address}</div>
      <div style="font-size:12px;line-height:1.55;color:#555;margin-top:4px">${hours}</div>
      ${memo ? `<div style="font-size:11px;line-height:1.5;color:#666;margin-top:6px">${memo}</div>` : ''}
      ${walk ? `<a href="${esc(walk)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:9px;font-weight:700;text-decoration:none">徒歩ルートを開く →</a>` : ''}
    </div>`;
  }

  function showFatal(message) {
    document.body.innerHTML = `<div style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><h2>TOILET SOS</h2><p>${esc(message)}</p></div>`;
  }

  async function start() {
    if (!window.L) throw new Error('地図ライブラリを読み込めませんでした');
    const node = document.getElementById('leafletMap');
    if (!node) throw new Error('地図表示領域がありません');

    const map = L.map(node, { zoomControl: true, preferCanvas: true }).setView(TOKYO_CENTER, 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    const resp = await fetch(`${DATA_URL}?v=20260919`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`トイレデータ取得エラー (${resp.status})`);
    const rows = await resp.json();
    if (!Array.isArray(rows)) throw new Error('トイレデータ形式エラー');

    const points = rows.filter(validCoord);
    const layer = (typeof L.markerClusterGroup === 'function')
      ? L.markerClusterGroup({
          chunkedLoading: true,
          chunkInterval: 100,
          chunkDelay: 30,
          maxClusterRadius: 45,
          iconCreateFunction(cluster) {
            const count = cluster.getChildCount();
            const size = count >= 100 ? 48 : count >= 10 ? 44 : 40;
            return L.divIcon({
              className: 'ths-cluster-marker-wrap',
              html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 10%;transform:rotate(-45deg);background:#fff;border:3px solid #ff6b42;box-shadow:0 2px 7px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;position:relative"><span style="transform:rotate(45deg);font-size:${count >= 100 ? 14 : 16}px;font-weight:900;color:#0b5d5d;line-height:1">${count}</span><span style="position:absolute;right:-7px;top:-7px;width:20px;height:20px;border-radius:50%;background:#1a73e8;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;transform:rotate(45deg);border:2px solid #fff">🚻</span></div>`,
              iconSize: [size, size],
              iconAnchor: [Math.round(size / 2), Math.round(size * 0.88)]
            });
          }
        })
      : L.layerGroup();

    for (const r of points) {
      const marker = L.marker([Number(r.lat), Number(r.lng)], { icon: toiletIcon(Boolean(r.isGodToilet)), title: r.name_ja || '' });
      marker.bindPopup(detailHtml(r), { maxWidth: 320 });
      layer.addLayer(marker);
    }
    map.addLayer(layer);

    // Keep Tokyo overview on first load, matching the existing PC experience.
    map.setView(TOKYO_CENTER, 12);
    setTimeout(() => map.invalidateSize(true), 50);
    window.addEventListener('resize', () => map.invalidateSize(false));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  start().catch((err) => {
    console.error('[TOILET SOS]', err);
    showFatal(err && err.message ? err.message : '起動に失敗しました');
  });
})();
