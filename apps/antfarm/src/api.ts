// Thin fetch wrapper — always sends credentials so the session cookie is included.

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { credentials: 'include', ...init });
}

export interface SessionInfo {
  valid: boolean;
  configured: boolean;
}

export async function getSessionInfo(): Promise<SessionInfo> {
  try {
    const res = await apiFetch('/api/identity');
    if (res.status === 401 || res.status === 403) return { valid: false, configured: false };
    if (!res.ok) return { valid: true, configured: true };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { valid: false, configured: false };
    const data = await res.json() as { configured?: boolean };
    return { valid: true, configured: data.configured !== false };
  } catch {
    return { valid: true, configured: true };
  }
}

export async function checkSession(): Promise<boolean> {
  return (await getSessionInfo()).valid;
}
