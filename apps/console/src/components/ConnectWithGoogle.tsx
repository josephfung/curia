import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { apiFetch } from '../api.js';

// "Connect with Google" (#2361): mints a single-use sign-in link through the console route and
// sends the browser to it (same tab; Nylas hosted auth then returns to /mailbox-signin/done).
// Readiness is read from GET /api/registry/nylas/signin; while it is not ready the button is
// disabled and the reason is shown under it. No token is stored: the URL is navigated to and dropped.

interface Readiness { ready: boolean; detail?: string; failed?: boolean }

/** Fired on `window` by the Nylas setup panel after a readiness check; `detail` is the result. */
export const SIGNIN_READINESS_EVENT = 'curia:nylas-signin-readiness';

async function errorText(res: Response): Promise<string> {
  try {
    const d = await res.json() as { error?: string };
    if (d.error) return d.error;
  } catch (err) {
    console.error('[ConnectWithGoogle] failed to parse the error body:', err);
  }
  return `HTTP ${res.status}`;
}

export function ConnectWithGoogle({ target, label, address, disabled = false, buttonText = 'Connect with Google', hideUnlessReady = false }: {
  target: 'principal' | 'curia';
  label?: string;
  address?: string;
  /** Read-only views turn the button off without explaining it themselves. */
  disabled?: boolean;
  buttonText?: string;
  /** Per-row use: render nothing until sign-in is ready (the main button explains why not). */
  hideUnlessReady?: boolean;
}) {
  const reasonId = useId();
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Aborts the link POST when the view unmounts, so a late answer cannot navigate away from
  // whatever page the operator moved on to.
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const checkSeq = useRef(0);

  const check = useCallback(async () => {
    const seq = ++checkSeq.current;
    try {
      const res = await apiFetch('/api/registry/nylas/signin');
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as Readiness;
      if (mounted.current && seq === checkSeq.current) setReadiness(d);
    } catch (e) {
      console.error('[ConnectWithGoogle] failed to read sign-in readiness:', e);
      if (mounted.current && seq === checkSeq.current) {
        setReadiness({ ready: false, failed: true, detail: 'Could not check whether Google sign-in is set up.' });
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void check();
    // The Nylas setup panel (same page) announces its result so this button follows it.
    const onChange = (ev: Event) => {
      const d = (ev as CustomEvent<Readiness | undefined>).detail;
      if (!d || typeof d.ready !== 'boolean') return;
      checkSeq.current++; // supersede any check still in flight
      setReadiness({ ready: d.ready, detail: d.detail });
    };
    window.addEventListener(SIGNIN_READINESS_EVENT, onChange);
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
      window.removeEventListener(SIGNIN_READINESS_EVENT, onChange);
    };
  }, [check]);

  async function connect() {
    setBusy(true);
    setErr(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const body: Record<string, string> = { target };
      if (label?.trim()) body['label'] = label.trim();
      if (address?.trim()) body['address'] = address.trim();
      const res = await apiFetch('/api/registry/nylas/signin-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(await errorText(res));
      const d = await res.json() as { url?: string };
      if (!d.url) throw new Error('The server did not return a sign-in link.');
      // The start route lives on Curia's own origin; never navigate anywhere else.
      let sameOrigin = false;
      try { sameOrigin = new URL(d.url, window.location.origin).origin === window.location.origin; } catch { /* malformed: refused below */ }
      // Usually the console was opened at another address than APP_ORIGIN, which the link is built from.
      if (!sameOrigin) throw new Error('The sign-in link is for a different address than this page, so it was not opened; open the console at its APP_ORIGIN address and try again.');
      if (ctrl.signal.aborted) return;
      window.location.assign(d.url);
    } catch (e) {
      if (ctrl.signal.aborted) return; // the view was left; nothing to report to
      console.error('[ConnectWithGoogle] could not start sign-in:', e);
      setErr(e instanceof Error ? e.message : 'Could not start sign-in.');
      setBusy(false);
    }
  }

  const ready = readiness?.ready === true;
  const reason = readiness && !readiness.ready
    ? (readiness.detail || 'Google sign-in is not set up yet (Settings → Email & Calendar).')
    : null;
  if (hideUnlessReady && !ready) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <button type="button" className="btn btn-primary" disabled={disabled || busy || !ready}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => void connect()}>{buttonText}</button>
      {reason && <p id={reasonId} className="settings-page-sub mailbox-id-help">{reason}</p>}
      {readiness?.failed && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()}>Check again</button>
      )}
      {err && <p className="autonomy-error" role="alert" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}
