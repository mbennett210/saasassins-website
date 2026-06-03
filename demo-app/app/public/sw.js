// PolishPoint service worker.
//
// Scope: '/' — registered from main.jsx with `{ scope: '/' }`. The only
// behaviors here are push handling and notification click-through. There is
// no offline precaching and no Workbox; we hand-roll because the surface is
// tiny and we don't want a runtime caching layer that could mask bugs.

const ICON = '/icon-192.png';
const BADGE = '/icon-192.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// `push` is fired by the browser/OS when the push service receives a payload
// from our backend. Payload shape: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'PolishPoint', body: event.data?.text?.() || '' };
  }
  const title = data.title || 'PolishPoint';
  const options = {
    body: data.body || '',
    icon: data.icon || ICON,
    badge: data.badge || BADGE,
    tag: data.tag,             // collapses repeats from the same source
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Click handler: focus an existing app window if one is open, otherwise open
// a fresh client at the URL the push payload provided.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) {
          await client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return null;
    })()
  );
});
