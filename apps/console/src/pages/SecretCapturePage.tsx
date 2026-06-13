// SecretCapturePage.tsx — public, unauthenticated form for one-time secret capture (#971).
//
// Reachable WITHOUT a session: it lives under rootRoute (not the authed layout), and the
// backend routes are exempt from bearer auth. The single-use token in the URL is the only
// credential. The value the user types is POSTed straight to the vault server-side; it is
// never echoed back, stored client-side, or sent anywhere but the capture endpoint.

import { useState, useEffect, type FormEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import { CuriaWordmark } from '../components/Icons';
import { apiFetch } from '../api';
import {
  classifyMetadataResponse,
  validateSubmitValue,
  type CaptureView,
  type CaptureMetadataBody,
} from './secret-capture-utils';

export default function SecretCapturePage() {
  const { token } = useParams({ from: '/secret-capture/$token' });
  const [view, setView] = useState<CaptureView>({ kind: 'loading' });
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Load form metadata on mount AND whenever the token changes. We reset to a clean loading
  // state and clear any previously typed value first, so the old form (with an old secret and
  // old token binding) can never be submitted against a newly navigated-to token.
  useEffect(() => {
    let cancelled = false;
    setView({ kind: 'loading' });
    setValue('');
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/secret-capture/${token}`);
        let body: CaptureMetadataBody | null = null;
        if (res.headers.get('content-type')?.includes('application/json')) {
          body = (await res.json()) as CaptureMetadataBody;
        }
        if (!cancelled) setView(classifyMetadataResponse(res.status, body));
      } catch {
        if (!cancelled) setView({ kind: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    // Guard against a double-submit race: a second in-flight POST could otherwise land a 410
    // (token already consumed by the first) and flip the UI away from the success state.
    if (submitting || view.kind !== 'form') return;
    setError(null);

    const check = validateSubmitValue(value, view.valueFormat);
    if (!check.ok) {
      setError(check.error);
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/secret-capture/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (res.ok) {
        setValue(''); // drop the value from memory as soon as it's accepted
        setView({ kind: 'success' });
        return;
      }
      // Terminal failures: the link is no longer usable, so drop the entered secret from
      // component state rather than leaving it sitting in memory behind a dead form.
      if (res.status === 410) { setValue(''); setView({ kind: 'gone' }); return; }
      if (res.status === 404) { setValue(''); setView({ kind: 'notfound' }); return; }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Could not save the value. Please try again.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-root">
      <div className="login-card">
        <div className="login-wordmark" aria-label="Curia">
          <CuriaWordmark />
        </div>
        {renderBody()}
      </div>
    </div>
  );

  function renderBody() {
    switch (view.kind) {
      case 'loading':
        return <p>Loading…</p>;
      case 'gone':
        return <p>This link has expired or has already been used. Ask Curia for a new one.</p>;
      case 'notfound':
        return <p>This link is not valid. Ask Curia for a new one.</p>;
      case 'error':
        return <p className="login-error">Something went wrong loading this form. Please try again later.</p>;
      case 'success':
        return <p>Saved. You can close this window.</p>;
      case 'form':
        return (
          <form onSubmit={handleSubmit} className="login-form">
            <label htmlFor="capture-value">
              Enter value for: <strong>{view.label ?? 'the requested secret'}</strong>
            </label>
            <textarea
              id="capture-value"
              aria-label="Secret value"
              placeholder={view.valueFormat === 'json' ? '{ "key": "value" }' : 'Paste or type the value'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={view.valueFormat === 'json' ? 6 : 3}
              autoFocus
              required
            />
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save securely'}
            </button>
          </form>
        );
    }
  }
}
