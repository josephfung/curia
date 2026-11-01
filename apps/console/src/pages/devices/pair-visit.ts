import { readFragmentToken } from './fragment-token.js';

let heldToken: string | null | undefined;
const inflight = new Map<string, Promise<unknown>>();

/**
 * The fragment is cleared with a replace navigation. StrictMode runs the
 * effect twice, and the second run no longer sees the hash, so the token
 * read on the first run is kept for that visit.
 */
export function rememberFragmentToken(hash: string): string | null {
  if (hash.length > 0) {
    heldToken = readFragmentToken(hash);
    return heldToken;
  }
  return heldToken ?? null;
}

/** One in-flight redeem per token. A second call shares the first request. */
export function redeemFragmentOnce<T>(token: string, run: (token: string) => Promise<T>): Promise<T> {
  const existing = inflight.get(token);
  if (existing) return existing as Promise<T>;
  const pending = run(token).finally(() => {
    inflight.delete(token);
    if (heldToken === token) heldToken = null;
  });
  inflight.set(token, pending);
  return pending;
}

export function resetPairVisitForTests(): void {
  heldToken = undefined;
  inflight.clear();
}
