// Keeps the app working offline. The list itself never goes through here: it lives on
// the phone and syncs through /api/.
//
// Each release has its own cache, filled all at once when the new version installs, so
// a phone never mixes files from two versions. The deploy step stamps VERSION; the app
// reloads into a new version as soon as it takes over, unless you're in the middle of
// something. "dev" (a local copy) always fetches fresh files and uses the cache only offline.

const VERSION = "dev";
const CACHE = "panier-" + VERSION;
const FILES = [
  "./", "app.css", "app.js", "store.js", "vendor/qrcode.js", "manifest.webmanifest",
  "icon.svg", "icon-192.png", "fonts/atkinson-hyperlegible-400.woff2", "fonts/atkinson-hyperlegible-700.woff2",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("panier-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = e.request.mode === "navigate" ? "./" : e.request;
  e.respondWith(caches.open(CACHE).then(async cache => {
    if (VERSION === "dev") {
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(key, res.clone());
        return res;
      } catch (_) {
        return (await cache.match(key, { ignoreSearch: true })) || Response.error();
      }
    }
    return (await cache.match(key, { ignoreSearch: true })) || fetch(e.request);
  }));
});
