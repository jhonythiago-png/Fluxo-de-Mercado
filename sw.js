// Fluxo do Mercado - service worker
// Não guarda cache: os dados são ao vivo e as atualizações do site entram na hora.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const c of lista) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
