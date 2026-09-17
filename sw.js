const CACHE_NAME = "ttf-cache-v17";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Temporary recovery mode: always use the network.
  // This prevents an old cached index/app.js from keeping iPhone Safari on a broken build.
  if (event.request.method === "GET") {
    event.respondWith(fetch(event.request));
  }
});
