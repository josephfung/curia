import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../../../../apps/console/public/sw.js', import.meta.url), 'utf8');
const offline = readFileSync(new URL('../../../../apps/console/public/offline.html', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../../../../apps/console/public/manifest.webmanifest', import.meta.url), 'utf8');

describe('console service worker', () => {
  it('keeps documents fresh, caches hashed assets, and never caches the API', () => {
    expect(worker).toContain("request.mode === 'navigate'");
    expect(worker).toContain("url.pathname.startsWith('/assets/')");
    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).toContain("url.pathname.startsWith('/auth')");
    expect(worker).toContain("data.type === 'SKIP_WAITING'");
    expect(worker).toContain('cache.put(request, fresh.clone())');
    const cacheWrite = worker.indexOf('cache.put');
    const apiGuard = worker.indexOf("url.pathname.startsWith('/api/')");
    expect(apiGuard).toBeGreaterThan(-1);
    expect(cacheWrite).toBeGreaterThan(apiGuard);
  });

  it('points a failed navigation at the unreachable screen', () => {
    expect(worker).toContain("cache.match('/offline.html')");
    expect(offline).toContain("Can't reach your Curia");
    expect(offline).toContain('/icons/curia-192.png');
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
