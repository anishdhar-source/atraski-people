// Atraski People is a web portal, not an installable app. This worker exists only to clean up
// browsers that installed the earlier offline version: it clears its caches, unregisters itself
// and reloads open tabs so they get the live portal.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
  })());
});
