// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/identity');
    // Only 401/403 means the session is definitely gone — redirect to login.
    // Transient errors (429, 500, etc.) keep the user on the current page to
    // avoid a forced logout every time the backend hiccups.
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true;
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
