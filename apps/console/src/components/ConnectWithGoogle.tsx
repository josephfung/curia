import { useState, useEffect } from 'react';
import { apiFetch } from '../api.js';

// "Connect with Google" (#2361): mints a single-use sign-in link through the console route and
// sends the browser to it (same tab; Nylas hosted auth then returns to /mailbox-signin/done).
// Readiness is read from GET /api/registry/nylas/signin; while it is not ready the button is
// disabled and the reason is shown under it. No token is stored: the URL is navigated to and dropped.

interface Readiness { ready: boolean; detail?: string }

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch (err) {
    console.error('[ConnectWithGoogle] failed to parse the error body:', err);
  }
  return `HTTP ${res.status}`;
}

export function ConnectWithGoogle({ target, label, address, disabled = false }: {
  target: 'principal' | 'curia';
  label?: string;
  address?: string;
  /** Read-only views turn the button off without explaining it themselves. */
  disabled?: boolean;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/registry/nylas/signin');
        if (!res.ok) throw new Error(await errorText(res));
        const d = await res.json() as Readiness;
        if (!cancelled) setReadiness(d);
      } catch (e) {
        console.error('[ConnectWithGoogle] failed to read sign-in readiness:', e);
        if (!cancelled) setReadiness({ ready: false, detail: 'Could not check whether Google sign-in is set up.' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string> = { target };
      if (label?.trim()) body['label'] = label.trim();
      if (address?.trim()) body['address'] = address.trim();
      const res = await apiFetch('/api/registry/nylas/signin-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as { url?: string };
      if (!d.url) throw new Error('The server did not return a sign-in link.');
      // The start route lives on Curia's own origin; never navigate anywhere else.
      let sameOrigin = false;
      try { sameOrigin = new URL(d.url, window.location.origin).origin === window.location.origin; } catch { /* malformed: refused below */ }
      if (!sameOrigin) throw new Error('The sign-in link pointed somewhere unexpected, so it was not opened.');
      window.location.assign(d.url);
    } catch (e) {
      console.error('[ConnectWithGoogle] could not start sign-in:', e);
      setErr(e instanceof Error ? e.message : 'Could not start sign-in.');
      setBusy(false);
    }
  }

  const ready = readiness?.ready === true;
  const reason = readiness && !readiness.ready
    ? (readiness.detail || 'Google sign-in is not set up yet (Settings → Email & Calendar).')
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <button type="button" className="btn btn-primary" disabled={disabled || busy || !ready}
        aria-describedby={reason ? 'connect-google-reason' : undefined}
        onClick={() => void connect()}>Connect with Google</button>
      {reason && <p id="connect-google-reason" className="settings-page-sub mailbox-id-help">{reason}</p>}
      {err && <p className="autonomy-error" role="alert" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}
