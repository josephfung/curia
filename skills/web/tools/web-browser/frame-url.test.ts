import { describe, it, expect } from 'vitest';
import { isBlockedFrameUrl, isPrivateHost } from './frame-url.js';

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

  it('blocks redirect/frame URLs on service names', () => {
    expect(isBlockedFrameUrl('http://curia:3000/api')).toBe(true);
    expect(isBlockedFrameUrl('https://example.com/')).toBe(false);
  });
});
