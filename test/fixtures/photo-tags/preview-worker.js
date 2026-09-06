// Scoped to the synthetic QA page. Serve its fake HTTPS photo identity from
// the checked-in local SVG so manual testing never needs an external server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname === "photo-tags.example.test" && url.pathname === "/group.png") {
    event.respondWith(fetch(new URL("./group.svg", self.location.href)));
  }
});
