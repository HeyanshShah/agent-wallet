// Shows push notifications for purchase requests and opens the app when tapped.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Agent Wallet", body: "Something needs your attention." };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      tag: data.requestId || "agent-wallet",
      requireInteraction: true,
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const open = clients.find((c) => "focus" in c);
      return open ? open.focus() : self.clients.openWindow("/");
    }),
  );
});
