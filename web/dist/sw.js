// Offline shell for Green Timber Jobs. Data always comes live from Supabase.
const CACHE = "gt-shell-mv5c8pf6";
const SHELL = ["/", "/index.html", "/assets/app.js?v=mv5c8pf6", "/assets/app.css?v=mv5c8pf6", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/index.html")));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
