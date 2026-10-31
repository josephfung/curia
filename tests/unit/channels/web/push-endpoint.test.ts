import { describe, expect, it } from 'vitest';
import { isDeliverablePushEndpoint, pushKeyLengths } from '../../../../src/channels/web/push-endpoint.js';

function key(bytes: number): string {
  return Buffer.alloc(bytes, 7).toString('base64url');
}

describe('push endpoint', () => {
  it('accepts a public https endpoint on port 443', () => {
    expect(isDeliverablePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isDeliverablePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
  });

  it('rejects http, a non-443 port, an IP, and a private name', () => {
    expect(isDeliverablePushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isDeliverablePushEndpoint('https://fcm.googleapis.com:8443/fcm/send/abc')).toBe(false);
    expect(isDeliverablePushEndpoint('https://127.0.0.1/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://10.1.2.3/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://192.168.1.9/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://[::1]/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://[fc00::1]/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://[fd12::1]/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://printer.local/push')).toBe(false);
    expect(isDeliverablePushEndpoint('https://my.example/push')).toBe(false);
  });

  it('requires a 65-byte p256dh and a 16-byte auth secret', () => {
    expect(pushKeyLengths(key(65), key(16))).toBe(true);
    expect(pushKeyLengths(key(64), key(16))).toBe(false);
    expect(pushKeyLengths(key(65), key(15))).toBe(false);
    expect(pushKeyLengths('not a key', key(16))).toBe(false);
  });
});
