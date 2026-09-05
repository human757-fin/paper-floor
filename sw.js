const CACHE = "paperfloor-v3";
const ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./examples/qwen3-agent.js",
  "./examples/ollama-proxy.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return;
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
