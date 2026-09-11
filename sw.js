const CACHE_NAME = "ttf-cache-v10";
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "i18n.js",
  "manifest.json",
  "icon.svg",
  "icon-32.png",
  "icon-96.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "god-toilet-visual.jpg",
  "icon-1024.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Precache the app shell one-by-one so a single missing/renamed asset
      // (e.g. an icon file not yet deployed) can't fail the whole install.
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {
            /* skip assets that aren't deployed yet */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first for app shell, stale-while-revalidate for data_*.json
// (matches both the /data/ subfolder and the legacy repo-root location).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Matches data_master.json etc. whether served from /data/ or the repo root.
  if (/\/data_[a-z]+\.json$/.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then((cached) => {
          const fetchPromise = fetch(event.request)
            .then((networkResp) => {
              cache.put(event.request, networkResp.clone());
              return networkResp;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
