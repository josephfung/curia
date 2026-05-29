// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export interface SessionInfo {
  valid: boolean;
  configured: boolean;
}

// Returns full session status including whether the instance is configured.
// Treats non-auth errors (5xx, network) as "valid but unknown configured state"
// to avoid forced logouts on transient backend hiccups.
export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await apiFetch('/api/identity');
    if (res.status === 401 || res.status === 403) return { valid: false, configured: false };
    if (!res.ok) return { valid: true, configured: true };
    // Guard against the SPA fallback: /api/identity can return index.html (200, text/html)
    // when identity routes are not registered. Treat that as unauthenticated.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { valid: false, configured: false };
    const data = await res.json() as { configured?: boolean };
    return { valid: true, configured: data.configured !== false };
  } catch {
    // Network failure — treat as unauthenticated rather than crashing the app.
    return { valid: false, configured: false };
  }
}

export async function checkSession(): Promise<boolean> {
  return (await getSessionInfo()).valid;
}
