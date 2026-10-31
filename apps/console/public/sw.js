// sw.js — console service worker (#2341, ADR-055).
//
// Hand-written and served from /sw.js with Cache-Control: no-cache.
// Documents are network-first. Hashed /assets/ are cache-first.
// /api and /auth are never cached. A failed navigation shows the
// "Can't reach your Curia" page instead of a blank screen.
// A new build waits until the operator taps Reload.

const SHELL_CACHE = 'curia-shell-v1';
const PRECACHE = ['/offline.html', '/icons/curia-192.png', '/icons/curia-512.png'];

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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/auth')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request));
  }
});

async function networkFirstDocument(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offline = await cache.match('/offline.html');
    if (offline) return offline;
    return new Response("Can't reach your Curia", {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok) await cache.put(request, fresh.clone());
  return fresh;
}
