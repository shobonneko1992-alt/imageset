// 最小構成のService Worker（PWAインストール要件を満たすための土台）
// 必要に応じてキャッシュ戦略を拡張してください。

const CACHE_NAME = "image-text-editor-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// シンプルなネットワークファースト戦略
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
