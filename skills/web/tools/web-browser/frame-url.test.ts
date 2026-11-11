import { describe, it, expect } from 'vitest';
import { isBlockedFrameUrl, isBlockedFrameUrlResolved, isPrivateHost, resolvesPrivate } from './frame-url.js';
import type { HostLookup } from '../../../../src/browser/egress-proxy.js';

describe('isPrivateHost — names that resolve privately', () => {
  it('blocks single-label hosts (compose service names)', () => {
    expect(isPrivateHost('curia')).toBe(true);
    expect(isPrivateHost('postgres')).toBe(true);
  });

  it('blocks internal suffixes', () => {
    expect(isPrivateHost('db.internal')).toBe(true);
    expect(isPrivateHost('printer.local')).toBe(true);
    expect(isPrivateHost('app.localhost')).toBe(true);
  });

  it('still allows public dotted hosts and IPv6 literals are judged by range', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('[2606:4700::1111]')).toBe(false);
  });

  it('treats a trailing-dot (absolute) name like the name without it', () => {
    for (const host of ['curia.', 'localhost.', 'metadata.google.internal.', 'db.internal.', '127.0.0.1.', 'curia..']) {
      expect(isPrivateHost(host)).toBe(true);
    }
    expect(isPrivateHost('example.com.')).toBe(false);
    expect(isBlockedFrameUrl('http://localhost.:3000/')).toBe(true);
    expect(isBlockedFrameUrl('http://curia./api')).toBe(true);
  });

  it('blocks redirect/frame URLs on service names', () => {
    expect(isBlockedFrameUrl('http://curia:3000/api')).toBe(true);
    expect(isBlockedFrameUrl('https://example.com/')).toBe(false);
  });
});

describe('resolved-address checks (#2521)', () => {
  const stub = (answers: Record<string, string[]>): HostLookup => async (hostname) => {
    const addresses = answers[hostname];
    if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return addresses.map((address) => ({ address }));
  };
  const lookup = stub({
    'public.example': ['93.184.215.14'],
    'loopback.example': ['127.0.0.1'],
    'lan.example': ['192.168.1.10'],
    'metadata.example': ['169.254.169.254'],
    'ula.example': ['fd00::5'],
    'mixed.example': ['93.184.215.14', '10.0.0.1'],
  });

  it('refuses a public name that resolves to a private, loopback or link-local address', async () => {
    for (const host of ['loopback.example', 'lan.example', 'metadata.example', 'ula.example']) {
      expect(await resolvesPrivate(host, lookup)).toBe(true);
    }
  });

  it('refuses a name when any of its addresses is private', async () => {
    expect(await resolvesPrivate('mixed.example', lookup)).toBe(true);
  });

  it('refuses a name that does not resolve', async () => {
    expect(await resolvesPrivate('missing.example', lookup)).toBe(true);
  });

  it('allows a name that resolves only to public addresses', async () => {
    expect(await resolvesPrivate('public.example', lookup)).toBe(false);
  });

  it('still refuses private names without asking the resolver', async () => {
    const never: HostLookup = async () => { throw new Error('should not be asked'); };
    expect(await resolvesPrivate('curia', never)).toBe(true);
  });

  it('blocks a frame by its resolved address and leaves inline frames alone', async () => {
    expect(await isBlockedFrameUrlResolved('https://lan.example/router', lookup)).toBe(true);
    expect(await isBlockedFrameUrlResolved('https://public.example/', lookup)).toBe(false);
    expect(await isBlockedFrameUrlResolved('about:blank', lookup)).toBe(false);
    expect(await isBlockedFrameUrlResolved('file:///etc/passwd', lookup)).toBe(true);
  });
});
