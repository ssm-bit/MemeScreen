// MemeScreen service worker — exists so alerts can be shown as real system notifications on phones.
// (Android Chrome and installed iOS web apps refuse `new Notification()`; they only allow
// registration.showNotification(), which needs a service worker.)  No caching here on purpose:
// prices must always be live and the dev server must never serve stale files.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Tapping a notification focuses the app and tells it which token to open.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = all.find(x => 'focus' in x);
    if (c) { try { await c.focus(); } catch {} for (const x of all) x.postMessage({ type: 'ms-open-token', addr: data.addr }); }
    else if (self.clients.openWindow) await self.clients.openWindow(data.url || './');
  })());
});

// Ready for real server push later: if the backend ever sends a Web Push message, show it.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MemeScreen', { body: d.body || '', icon: 'icon.svg', badge: 'icon.svg', tag: d.tag, data: d }));
});
