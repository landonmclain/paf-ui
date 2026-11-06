// paf-ui service worker.
//
// Installability + Web Push display. Deliberately NO fetch handler and NO
// caching: every request goes straight to the network, so the live SSE streams
// and API calls behave exactly as without a service worker. Offline caching is
// out of scope.
//
// Push payload (JSON, sent by paf):
//   { title, body, tag?, url?, agent?, cid?, outcome? }
// `agent` + `cid` identify the conversation; a tap opens it (deep link).
//
// Bump when changing this file so installed clients take the new worker.
const VERSION = "3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function parsePayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const data = parsePayload(event);
  // Always show what arrives. Whether to notify a device that is already looking
  // at the conversation is decided by the SERVER (presence heartbeats, see
  // app/page.tsx): a push that is never sent can't be a silent one, and iOS
  // revokes subscriptions whose pushes don't display a notification. Decided
  // here from window focus/URL it was unreliable on iOS.
  event.waitUntil(
    self.registration.showNotification(data.title || "paf", {
      body: data.body || "",
      icon: "/icon-192.png",
      // One notification per conversation: a newer push replaces the older one
      // (and re-alerts) instead of stacking.
      tag: data.tag || data.cid || undefined,
      renotify: true,
      data: { url: data.url || "/", agent: data.agent, cid: data.cid },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = "/", agent, cid } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const win = wins[0];
      if (win) {
        try {
          await win.focus();
          // The page switches conversation in place (no reload, no lost state).
          win.postMessage({ type: "paf-open", agent, cid });
          return;
        } catch {
          /* focus refused — fall through to opening a window */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
