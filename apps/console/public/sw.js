// sw.js — console service worker (#2341, ADR-055).
//
// Hand-written. The console build replaces __BUILD_ID__ so the cache name
// changes and browsers treat the file as a new worker. Served with
// Cache-Control: no-cache.
// Documents are network-first. A 502, 503, or 504, or a failed fetch, shows
// the offline page. Precached offline files are cache-first. Hashed /assets/
// are cache-first, except text/html.
// /api and /auth are never intercepted. A new build waits for Reload.

const BUILD_ID = '__BUILD_ID__';
const SHELL_CACHE = 'curia-shell-' + BUILD_ID;
const PRECACHE = [
  '/offline.html',
  '/offline.css',
  '/offline.js',
  '/icons/curia-192.png',
  '/icons/curia-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
    ),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let title = 'Curia';
  let body = 'New message from Curia';
  let url = '/chat';
  try {
    if (event.data) {
      const payload = event.data.json();
      if (payload && typeof payload.title === 'string' && payload.title) title = payload.title;
      if (payload && typeof payload.body === 'string' && payload.body) body = payload.body;
      if (payload && typeof payload.url === 'string' && payload.url.startsWith('/')) url = payload.url;
    }
  } catch {
    // A malformed payload still shows the generic Curia alert.
  }
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/curia-192.png',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = data && typeof data.url === 'string' ? data.url : '/chat';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    for (const client of windowClients) {
      const path = new URL(client.url).pathname;
      if (path === '/chat' || path.startsWith('/chat/')) return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiOrAuth(url.pathname)) return;

  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then((cache) => cache.match(url.pathname)).then((hit) => hit || fetch(request)),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request));
  }
});

function isApiOrAuth(pathname) {
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/auth'
    || pathname.startsWith('/auth/');
}

async function networkFirstDocument(request) {
  try {
    const response = await fetch(request);
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      const offline = await offlineDocument();
      if (offline) return offline;
    }
    return response;
  } catch {
    const offline = await offlineDocument();
    if (offline) return offline;
    return new Response("Can't reach your Curia", {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function offlineDocument() {
  const cache = await caches.open(SHELL_CACHE);
  return cache.match('/offline.html');
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  const type = fresh.headers.get('content-type') ?? '';
  if (fresh.ok && !type.includes('text/html')) {
    try {
      await cache.put(request, fresh.clone());
    } catch {
      // Quota exceeded, or an uncacheable 206. Serve the fetched response uncached.
    }
  }
  return fresh;
}
