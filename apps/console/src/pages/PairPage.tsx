import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CuriaWordmark } from '../components/Icons';
import { apiFetch } from '../api';
import { currentInstallEnvironment, installCapabilityWarning } from '../pwa/capabilities';
import { readFragmentToken } from './devices/fragment-token';

type Phase =
  | { kind: 'working' }
  | { kind: 'form' }
  | { kind: 'done'; warning: string | null };

export default function PairPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const [shortCode, setShortCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = readFragmentToken(window.location.hash);
    // The token must not linger in the address bar or in storage.
    if (window.location.hash) {
      window.history.replaceState(null, '', '/pair');
    }
    if (!token) {
      setPhase({ kind: 'form' });
      return;
    }
    let cancelled = false;
    void redeem({ token }).then((result) => {
      if (cancelled) return;
      if (result.ok) setPhase({ kind: 'done', warning: result.warning });
      else {
        setError(result.error);
        setPhase({ kind: 'form' });
      }
    });
    return () => { cancelled = true; };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await redeem({ shortCode });
    setBusy(false);
    if (result.ok) setPhase({ kind: 'done', warning: result.warning });
    else setError(result.error);
  }

  const capability = installCapabilityWarning(currentInstallEnvironment());
  const originWarning = phase.kind === 'done' ? phase.warning : null;

  return (
    <div className="login-root">
      <div className="login-card pair-card">
        <div className="login-wordmark" aria-label="Curia">
          <CuriaWordmark />
        </div>
        {phase.kind === 'working' && <p className="settings-muted-hint">Signing this phone in…</p>}
        {phase.kind === 'form' && (
          <form onSubmit={onSubmit} className="login-form">
            <input
              aria-label="Short pairing code"
              placeholder="Short code"
              value={shortCode}
              onChange={(event) => setShortCode(event.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              required
            />
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {phase.kind === 'done' && (
          <div className="pair-done">
            {originWarning && <p className="pair-warning" role="status">{originWarning}</p>}
            {capability && <p className="pair-warning" role="status">{capability}</p>}
            <p className="device-meta">
              To keep Curia on your home screen, use the browser share menu and choose Add to Home Screen.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/chat' })}>
              Open chat
            </button>
          </div>
        )}
        {phase.kind !== 'done' && capability && <p className="pair-warning" role="status">{capability}</p>}
      </div>
    </div>
  );
}

async function redeem(body: { token: string } | { shortCode: string }): Promise<
  { ok: true; warning: string | null } | { ok: false; error: string }
> {
  try {
    const res = await apiFetch('/api/pairing/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message = typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : 'That code is invalid or has expired.';
      return { ok: false, error: message };
    }
    const warning = typeof payload === 'object' && payload !== null && typeof (payload as { warning?: unknown }).warning === 'string'
      ? (payload as { warning: string }).warning
      : null;
    return { ok: true, warning };
  } catch (err) {
    console.error('[pair] redeem failed:', err);
    return { ok: false, error: "Can't reach your Curia. Check the network and try again." };
  }
}
