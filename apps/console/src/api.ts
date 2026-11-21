// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export interface SessionInfo {
  valid: boolean;
  configured: boolean;
  /** True on a new install until Setup is finished (#2358). Null when the server didn't say. */
  inSetup: boolean | null;
}

// Returns full session status including whether the instance is configured.
// Treats non-auth errors (5xx, network) as "valid but unknown configured state"
// to avoid forced logouts on transient backend hiccups.
export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await apiFetch('/api/identity');
    if (res.status === 401 || res.status === 403) return { valid: false, configured: false, inSetup: null };
    if (!res.ok) return { valid: true, configured: true, inSetup: null };
    // Guard against the SPA fallback: /api/identity can return index.html (200, text/html)
    // when identity routes are not registered. Treat that as unauthenticated.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { valid: false, configured: false, inSetup: null };
    const data = await res.json() as { configured?: boolean; inSetup?: unknown };
    return {
      valid: true,
      configured: data.configured !== false,
      inSetup: typeof data.inSetup === 'boolean' ? data.inSetup : null,
    };
  } catch {
    // Network failure — keep the user where they are rather than forcing a /login redirect.
    // We can't distinguish a transient blip from a genuine auth drop, so assume still valid.
    return { valid: true, configured: true, inSetup: null };
  }
}

export async function checkSession(): Promise<boolean> {
  return (await getSessionInfo()).valid;
}
