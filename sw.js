const CACHE_NAME = "ttf-cache-v3";
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "i18n.js",
  "manifest.json",
  "icon.svg",
  "data_master.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
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

// Cache-first for app shell, stale-while-revalidate for data_master.json (and legacy per-city files)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (/\/data_(master|[a-z]+)\.json$/.test(url.pathname)) {
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
