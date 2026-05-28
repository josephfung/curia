// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/identity');
    if (!res.ok) return false;
    // Guard against the SPA fallback: when identityRoutes are not registered
    // (e.g. webAppBootstrapSecret missing), /api/identity falls through to the
    // console/* catch-all and returns index.html with a 200. Checking for a
    // JSON content-type ensures we got a real identity response, not HTML.
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json');
  } catch (err) {
    // Network failure, CORS block, DNS error, etc. Log so it shows in devtools.
    console.error('[checkSession] fetch failed, treating as unauthenticated:', err);
    return false;
  }
}
