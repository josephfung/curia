// A push endpoint Curia will store and send to (#2341).
//
// https on port 443, a host on the push-service allowlist, and the key sizes
// the push protocol requires: an uncompressed P-256 point (65 bytes) and a
// 16-byte auth secret.

const EXACT_PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
]);

function isAllowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (EXACT_PUSH_HOSTS.has(host)) return true;
  if (host === 'push.apple.com' || host.endsWith('.push.apple.com')) return true;
  return host.endsWith('.notify.windows.com');
}

/** True when Curia may store this endpoint and send a notification to it. */
export function isDeliverablePushEndpoint(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (url.username || url.password) return false;
  return isAllowedPushHost(url.hostname);
}

function decodedLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, 'base64url').length;
  } catch {
    return null;
  }
}

/** p256dh is 65 bytes and auth is 16. Anything else is not a push key. */
export function pushKeyLengths(p256dh: string, auth: string): boolean {
  return decodedLength(p256dh) === 65 && decodedLength(auth) === 16;
}
