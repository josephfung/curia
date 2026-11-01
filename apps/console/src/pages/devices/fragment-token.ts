/** Read the pairing token from a URL fragment. The fragment is never sent to the server by the browser. */
export function readFragmentToken(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get('c');
  if (!token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  return token;
}
