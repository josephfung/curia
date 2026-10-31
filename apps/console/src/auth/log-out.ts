import { apiFetch } from '../api.js';

export type LogoutResult = { ok: true } | { ok: false; error: string };

/** Ends the current console session. Stays put when the server refuses. */
export async function endConsoleSession(): Promise<LogoutResult> {
  try {
    const res = await apiFetch('/auth/logout', { method: 'POST' });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => null) as { error?: string } | null;
    return { ok: false, error: body?.error ?? 'Could not sign out. Please try again.' };
  } catch (err) {
    console.error('[logout] request failed:', err);
    return { ok: false, error: 'Could not sign out. Please try again.' };
  }
}
