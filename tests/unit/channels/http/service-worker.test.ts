import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const BUILD = 'testbuild';
const workerSource = readFileSync(new URL('../../../../apps/console/public/sw.js', import.meta.url), 'utf8')
  .replaceAll('__BUILD_ID__', BUILD);
const offline = readFileSync(new URL('../../../../apps/console/public/offline.html', import.meta.url), 'utf8');
const offlineJs = readFileSync(new URL('../../../../apps/console/public/offline.js', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../../../../apps/console/public/manifest.webmanifest', import.meta.url), 'utf8');
const SHELL = `curia-shell-${BUILD}`;
const ORIGIN = 'https://curia.example.com';

interface FetchEvent {
  request: { method: string; url: string; mode: string };
  respondWith: (value: Promise<Response>) => void;
  waitUntil: (value: Promise<unknown>) => void;
}

function loadWorker(fetchImpl: (input: unknown) => Promise<Response>) {
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const stores = new Map<string, Map<string, Response>>();
  function pathOf(request: Request | string): string {
    const key = typeof request === 'string' ? request : request.url;
    return key.startsWith('http') ? new URL(key).pathname : key;
  }
  const caches = {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      const bucket = store;
      return {
        async match(request: Request | string) {
          return bucket.get(pathOf(request));
        },
        async put(request: Request | string, response: Response) {
          bucket.set(pathOf(request), response);
        },
        async addAll(urls: string[]) {
          await Promise.all(urls.map(async (url) => {
            bucket.set(url, await fetchImpl(url));
          }));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
  };
  const self = {
    location: { origin: ORIGIN },
    skipWaiting() { /* unused */ },
    addEventListener(type: string, fn: (event: FetchEvent) => void) {
      listeners.set(type, fn);
    },
  };
  vm.runInContext(workerSource, vm.createContext({ self, caches, fetch: fetchImpl, Response, URL }), { filename: 'sw.js' });
  return { listeners, caches, stores };
}

function dispatch(
  listeners: Map<string, (event: FetchEvent) => void>,
  request: { method: string; url: string; mode: string },
): Promise<Response> | undefined {
  let responded: Promise<Response> | undefined;
  listeners.get('fetch')?.({
    request,
    respondWith(value) { responded = value; },
    waitUntil() { /* unused */ },
  });
  return responded;
}

describe('console service worker', () => {
  it('names the shell cache from the build id', () => {
    const raw = readFileSync(new URL('../../../../apps/console/public/sw.js', import.meta.url), 'utf8');
    expect(raw).toContain("const BUILD_ID = '__BUILD_ID__'");
    expect(raw).toContain("const SHELL_CACHE = 'curia-shell-' + BUILD_ID");
    expect(workerSource).toContain("const BUILD_ID = 'testbuild'");
    expect(workerSource).not.toContain('__BUILD_ID__');
  });

  it('does not intercept /api or /auth, and does intercept /apis and /assets', async () => {
    let fetches = 0;
    const { listeners } = loadWorker(async () => {
      fetches += 1;
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/javascript' } });
    });
    const untouched = [
      `${ORIGIN}/api/x`,
      `${ORIGIN}/api`,
      `${ORIGIN}/auth`,
      `${ORIGIN}/auth/session`,
    ];
    for (const url of untouched) {
      const handled = dispatch(listeners, { method: 'GET', url, mode: 'navigate' });
      expect(handled, url).toBeUndefined();
    }
    const apis = dispatch(listeners, { method: 'GET', url: `${ORIGIN}/apis`, mode: 'navigate' });
    const asset = dispatch(listeners, { method: 'GET', url: `${ORIGIN}/assets/x`, mode: 'same-origin' });
    expect(apis).toBeDefined();
    expect(asset).toBeDefined();
    await apis;
    await asset;
    expect(fetches).toBe(2);
  });

  it('serves the offline page when navigation fails or the server returns 502, 503, or 504', async () => {
    for (const status of [502, 503, 504]) {
      const { listeners, caches } = loadWorker(async () => new Response('down', { status }));
      const cache = await caches.open(SHELL);
      await cache.put('/offline.html', new Response(`OFFLINE_${status}`));
      const handled = dispatch(listeners, { method: 'GET', url: `${ORIGIN}/chat`, mode: 'navigate' });
      const response = await handled;
      expect(response?.status, String(status)).toBe(200);
      expect(await response?.text()).toBe(`OFFLINE_${status}`);
    }
    const failing = loadWorker(async () => {
      throw new Error('offline');
    });
    const failedCache = await failing.caches.open(SHELL);
    await failedCache.put('/offline.html', new Response('OFFLINE_PAGE'));
    const failed = dispatch(failing.listeners, { method: 'GET', url: `${ORIGIN}/chat`, mode: 'navigate' });
    expect(await (await failed)?.text()).toBe('OFFLINE_PAGE');
  });

  it('does not cache a text/html response under /assets, and does cache script', async () => {
    let htmlFetches = 0;
    const htmlWorker = loadWorker(async () => {
      htmlFetches += 1;
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    const asset = { method: 'GET', url: `${ORIGIN}/assets/index.html`, mode: 'same-origin' };
    await dispatch(htmlWorker.listeners, asset);
    await dispatch(htmlWorker.listeners, asset);
    expect(htmlFetches).toBe(2);

    let scriptFetches = 0;
    const scriptWorker = loadWorker(async () => {
      scriptFetches += 1;
      return new Response('var x = 1;', { status: 200, headers: { 'content-type': 'text/javascript' } });
    });
    const script = { method: 'GET', url: `${ORIGIN}/assets/app.js`, mode: 'same-origin' };
    await dispatch(scriptWorker.listeners, script);
    await dispatch(scriptWorker.listeners, script);
    expect(scriptFetches).toBe(1);
  });

  it('drops caches from older builds on activate', async () => {
    const { listeners, caches } = loadWorker(async () => new Response('ok'));
    await caches.open('curia-shell-old');
    await caches.open(SHELL);
    const activate = listeners.get('activate');
    expect(activate).toBeTypeOf('function');
    await new Promise<void>((resolve, reject) => {
      try {
        activate?.({
          request: { method: 'GET', url: ORIGIN, mode: 'navigate' },
          respondWith() { /* unused */ },
          waitUntil(value) { resolve(value.then(() => undefined)); },
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    expect(await caches.keys()).toEqual([SHELL]);
  });

  it('points a failed navigation at a page with no inline style or script', () => {
    expect(workerSource).toContain("cache.match('/offline.html')");
    expect(offline).toContain("Can't reach your Curia");
    expect(offline).toContain('id="offline-host"');
    expect(offline).toContain('href="/offline.css"');
    expect(offline).toContain('src="/offline.js"');
    expect(offline).not.toMatch(/<style[\s>]/i);
    expect(offline).not.toMatch(/\son[a-z]+\s*=/i);
    const scripts = offline.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\ssrc=/);
    expect(offlineJs).toContain('location.host');
    expect(offlineJs).toContain("addEventListener('click'");
  });
});

describe('web manifest', () => {
  it('names Curia and lists the home-screen icons', () => {
    const parsed = JSON.parse(manifest) as {
      name: string;
      display: string;
      icons: Array<{ src: string; sizes: string; purpose: string }>;
    };
    expect(parsed.name).toBe('Curia');
    expect(parsed.display).toBe('standalone');
    const icons = parsed.icons.map((icon) => `${icon.purpose} ${icon.sizes} ${icon.src}`);
    expect(icons).toContain('any 192x192 /icons/curia-192.png');
    expect(icons).toContain('any 512x512 /icons/curia-512.png');
    expect(icons).toContain('maskable 512x512 /icons/curia-maskable-512.png');
  });
});
