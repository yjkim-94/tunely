const CACHE="tunely-1794897755389";
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(["/","/_next/static/P80vw5veJ5lZpZSuxcjbu/_buildManifest.js","/_next/static/P80vw5veJ5lZpZSuxcjbu/_clientMiddlewareManifest.js","/_next/static/P80vw5veJ5lZpZSuxcjbu/_ssgManifest.js","/_next/static/chunks/0916qinhpo_re.js","/_next/static/chunks/0cz1d0mv5g_q7.js","/_next/static/chunks/0j1we3cwg31qe.js","/_next/static/chunks/1cuyxw6v18rxx.js","/_next/static/chunks/1xo-6c37416a2.css","/_next/static/chunks/39_j1bdzreq0m.js","/_next/static/chunks/3qfy96eoyh-ek.js","/_next/static/chunks/turbopack-2u1d16houkiyo.js","/icon-192.png","/icon-512.png","/manifest.webmanifest"] || ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]),
      ),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    u.origin !== location.origin ||
    u.pathname.startsWith("/api/") ||
    e.request.method !== "GET"
  )
    return;
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return r;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (c) =>
        c ||
        fetch(e.request).then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        }),
    ),
  );
});
