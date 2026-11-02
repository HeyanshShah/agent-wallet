// Shows push notifications for purchase requests. On phones that support
// notification buttons (Android, desktop Chrome), you can approve or deny right there.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Agent Wallet", body: "Something needs your attention." };
  const actions = data.quickToken
    ? [
        { action: "approve", title: "Approve" },
        { action: "deny", title: "Deny" },
      ]
    : [];
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.svg",
      tag: data.requestId || "agent-wallet",
      requireInteraction: true,
      actions,
      data,
    }),
  );
});

async function decide(data, decision) {
  const res = await fetch(`/quick/${data.requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, token: data.quickToken }),
  });
  const body = await res.json().catch(() => ({}));
  const status = body.request?.status;
  const message = !res.ok
    ? body.error || "Couldn't do that. Open the app."
    : status === "approved"
      ? "Approved. The agent got a one-time card."
      : status === "denied"
        ? "Denied."
        : `This one was ${status}: ${body.request?.decisionReason ?? ""}`;
  await self.registration.showNotification("Agent Wallet", { body: message, icon: "/icon.svg", tag: data.requestId });
}

async function openApp() {
  const clients = await self.clients.matchAll({ type: "window" });
  const open = clients.find((c) => "focus" in c);
  return open ? open.focus() : self.clients.openWindow("/");
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if ((event.action === "approve" || event.action === "deny") && data.quickToken) {
    event.waitUntil(decide(data, event.action));
  } else {
    event.waitUntil(openApp());
  }
});
