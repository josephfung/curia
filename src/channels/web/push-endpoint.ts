// A push endpoint Curia will store and send to (#2341).
//
// https on port 443, a public hostname, and the key sizes the push protocol
// requires: an uncompressed P-256 point (65 bytes) and a 16-byte auth secret.

const PRIVATE_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.intranet',
  '.corp',
  '.localdomain',
  '.localhost',
  '.test',
  '.example',
  '.invalid',
];

function isPrivateName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

function isIp(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isPrivateIp(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // fc/fd are IPv6 unique-local prefixes. A hostname such as
  // fcm.googleapis.com starts with "fc" and is not an address.
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((part) => part > 255)) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
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
  const host = url.hostname;
  if (!host || isPrivateName(host) || isIp(host) || isPrivateIp(host)) return false;
  return true;
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
