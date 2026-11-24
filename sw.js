// Fluxo do Mercado - service worker
// Não guarda cache: os dados são ao vivo e as atualizações do site entram na hora.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Notificação com o app fechado (Web Push)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { corpo: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      // App aberto e na tela: o próprio app já avisa, com som e aviso na tela
      if (janelas.some((c) => c.visibilityState === "visible")) return;
      // App aberto em segundo plano: notificação sem som (o app toca o som dele)
      const appAberto = janelas.length > 0;
      return self.registration.showNotification(d.titulo || "Fluxo do Mercado", {
        body: d.corpo || "",
        icon: "icones/icone-192.png",
        badge: "icones/icone-192.png",
        tag: d.tag || "fluxo",
        renotify: true,
        silent: appAberto,
        data: { url: "./" },
      });
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((lista) => {
      for (const c of lista) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
