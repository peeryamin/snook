// Clears legacy caches and unregisters this worker.
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))),
      self.registration.unregister(),
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      })
    ])
  );
});

self.addEventListener('fetch', () => {});
