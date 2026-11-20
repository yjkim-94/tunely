const CACHE = "tunely-v4";
const FONT_CACHE = "tunely-fonts-v1";
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        c.addAll(self.__TUNELY_PRECACHE__ || ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/favicon.svg"]),
      ),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // Title/body fonts (Google Fonts, Pretendard on jsDelivr): cache-first so they work offline.
  if (
    e.request.method === "GET" &&
    (u.hostname === "fonts.googleapis.com" ||
      u.hostname === "fonts.gstatic.com" ||
      (u.hostname === "cdn.jsdelivr.net" && u.pathname.startsWith("/npm/pretendard@")))
  ) {
    e.respondWith(
      caches.open(FONT_CACHE).then((c) =>
        c.match(e.request).then(
          (hit) =>
            hit ||
            fetch(e.request).then((r) => {
              if (r.ok || r.type === "opaque") c.put(e.request, r.clone());
              return r;
            }),
        ),
      ),
    );
    return;
  }
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

// Web Push: "저장 준비 완료" etc. iOS requires every push to show a notification.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || "Tunely", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icon-192.png",
      badge: "/favicon-32.png",
      data: { url: "/" },
    }),
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        const open = list.find((c) => new URL(c.url).origin === location.origin);
        return open ? open.focus() : self.clients.openWindow("/");
      }),
  );
});
