// Keeps the app working offline. The list itself never goes through here: it lives on
// the phone and syncs through /api/.
//
// Each release has its own cache for the app's files, filled all at once when the new
// version installs, so a phone never mixes files from two versions. Files that rarely
// change (fonts, the QR code library, icons) live in a cache of their own that outlasts
// updates, so an update only downloads the app. The deploy step stamps VERSION, and
// STATIC with a fingerprint of those files, so a change to one of them is fetched again.
// The app reloads into a new version as soon as it takes over, unless you're in the
// middle of something. "dev" (a local copy) always fetches fresh files and uses the
// caches only offline.

const VERSION = "dev";
const STATIC = "panier-static-dev";
const CACHE = "panier-" + VERSION;
const FILES = ["./", "app.css", "app.js", "store.js", "i18n.js", "theme.js", "manifest.webmanifest"];
const STATIC_FILES = ["vendor/qrcode.js", "icon.svg", "icon-192.png", "fonts/atkinson-hyperlegible-400.woff2", "fonts/atkinson-hyperlegible-700.woff2"];
const fresh = f => new Request(f, { cache: "reload" });

self.addEventListener("install", e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(FILES.map(fresh))),
    caches.open(STATIC).then(async c => {
      const missing = [];
      for (const f of STATIC_FILES) if (!(await c.match(f))) missing.push(fresh(f));
      return c.addAll(missing);
    }),
  ]));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("panier-") && k !== CACHE && k !== STATIC).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = e.request.mode === "navigate" ? "./" : e.request;
  e.respondWith(caches.open(STATIC_FILES.includes(url.pathname.slice(1)) ? STATIC : CACHE).then(async cache => {
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
