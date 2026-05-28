// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export async function checkSession(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/identity');
    // res.ok = 200-299. 401 = unauthenticated. 500 or non-JSON (e.g. SPA
    // index.html served when the API surface is disabled) both return false.
    return res.ok;
  } catch (err) {
    // Network failure, CORS block, DNS error, etc. Log so it shows in devtools.
    console.error('[checkSession] fetch failed, treating as unauthenticated:', err);
    return false;
  }
}
