// GoogleWorkspaceSignIn.tsx — "Sign in as Curia" for Google Workspace (#2683).
//
// Used under the three vault fields on the Setup page's Google Workspace step, and in the
// google-workspace drawer on the MCP tools page (Settings). Shows the callback URL to add to the OAuth
// client, the live sign-in state from GET /api/google-workspace/status (signed in, not signed in,
// token rejected), and the button. The button asks the server for Google's consent URL and
// opens it in this tab; Google sends the browser to the server's callback, which redirects to
// /google-workspace/done.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { apiFetch } from '../api.js';

type SignInState = 'not_configured' | 'not_signed_in' | 'token_rejected' | 'signed_in' | 'unknown';

interface Status {
  state: SignInState;
  detail?: string;
  missing?: string[];
  callbackUrl: string | null;
}

/** Only Google's consent screen may be opened from the server's answer. */
export const GOOGLE_CONSENT_ORIGIN = 'https://accounts.google.com';

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch (err) {
    console.error('[GoogleWorkspaceSignIn] failed to parse the error body:', err);
  }
  return `HTTP ${res.status}`;
}

/** The one line under the button for each state. */
export function statusLine(s: Status): { text: string; ok: boolean } {
  switch (s.state) {
    case 'signed_in': return { ok: true, text: 'Signed in as Curia. Google accepts the saved sign-in.' };
    case 'not_signed_in': return { ok: false, text: 'Not signed in yet.' };
    case 'token_rejected': return { ok: false, text: s.detail ?? 'Google rejected the saved sign-in. Sign in as Curia again.' };
    case 'not_configured': return { ok: false, text: `Save ${(s.missing ?? []).join(', ') || 'the fields above'} first.` };
    case 'unknown': return { ok: false, text: s.detail ?? 'Could not check the sign-in right now.' };
  }
}

export function GoogleWorkspaceSignIn({ refreshKey, onStatus }: {
  /** Change to re-check, e.g. after the fields above were saved. */
  refreshKey?: number | string;
  /** Told each state read, so a parent step can refresh its checklist. */
  onStatus?: (state: SignInState) => void;
}): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Only the newest check may set state, and none after unmount.
  const seq = useRef(0);
  const live = useRef(true);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const check = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await apiFetch('/api/google-workspace/status');
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as Status;
      if (!live.current || mine !== seq.current) return;
      setStatus(d);
      onStatusRef.current?.(d.state);
    } catch (e) {
      console.error('[GoogleWorkspaceSignIn] failed to read the sign-in status:', e);
      if (!live.current || mine !== seq.current) return;
      setStatus((prev) => ({ state: 'unknown', detail: 'Could not check the sign-in right now.', callbackUrl: prev?.callbackUrl ?? null }));
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void check();
    return () => { live.current = false; };
  }, [check, refreshKey]);

  async function signIn(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch('/api/google-workspace/signin', { method: 'POST' });
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as { url?: string };
      let google = false;
      try { google = !!d.url && new URL(d.url).origin === GOOGLE_CONSENT_ORIGIN; } catch { /* malformed: refused below */ }
      if (!google) throw new Error('The server did not return a Google sign-in address.');
      window.location.assign(d.url!);
    } catch (e) {
      console.error('[GoogleWorkspaceSignIn] could not start the sign-in:', e);
      setErr(e instanceof Error ? e.message : 'Could not start the sign-in.');
      setBusy(false);
    }
  }

  async function copyCallback(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      // Clipboard access can be refused (insecure origin, permissions); the URL is on screen to copy by hand.
      console.error('[GoogleWorkspaceSignIn] could not copy the callback URL:', e);
    }
  }

  const callbackUrl = status?.callbackUrl ?? null;
  const line = status ? statusLine(status) : null;
  const signedIn = status?.state === 'signed_in';
  const canStart = status !== null && status.state !== 'not_configured' && callbackUrl !== null;

  return (
    <div className="gws-signin">
      <div className="setup-section">
        <span className="setup-section-label">Callback URL</span>
        <span className="setup-hint">Add this to the OAuth client’s authorized redirect URIs (a Web application client).</span>
      </div>
      {callbackUrl ? (
        <div className="gws-callback">
          <code>{callbackUrl}</code>
          <button type="button" className="btn btn-sm" onClick={() => void copyCallback(callbackUrl)}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      ) : status && (
        <p className="setup-hint">Set APP_ORIGIN to this console’s public https:// address and restart Curia to get the callback URL.</p>
      )}
      <div className="setup-actions">
        <button type="button" className={signedIn ? 'btn' : 'btn btn-primary'} disabled={busy || !canStart} onClick={() => void signIn()}>
          {busy ? 'Opening Google…' : signedIn ? 'Sign in as Curia again' : 'Sign in as Curia'}
        </button>
      </div>
      {line && <p className={`setup-status ${line.ok ? 'ok' : 'attention'}`} role="status">{line.text}</p>}
      {err && <p className="setup-status attention" role="alert">{err}</p>}
      <p className="setup-hint">
        Sign in with Curia’s own Google account, not yours, and leave every permission ticked. Curia restarts once afterwards.
      </p>
    </div>
  );
}
