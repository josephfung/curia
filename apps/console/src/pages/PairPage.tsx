import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CuriaWordmark } from '../components/Icons';
import { apiFetch } from '../api';
import { PAIRING_LIMIT_MESSAGE } from '../../../../src/phone/phone-docs.js';
import {
  currentInstallEnvironment,
  installCapabilityWarning,
  pairPageNotice,
} from '../pwa/capabilities';
import {
  BROWSER_INSTALL_HINT,
  IOS_SHARE_STEPS,
  installGuidance,
  type InstallGuidance,
} from '../pwa/install-guidance';
import { NotificationsPanel } from '../pwa/NotificationsPanel';
import { PhoneNotice } from '../pwa/PhoneNotice';
import { rememberFragmentToken, redeemFragmentOnce } from './devices/pair-visit';

type Phase =
  | { kind: 'working' }
  | { kind: 'form' }
  | { kind: 'done'; warning: string | null };

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export default function PairPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const [shortCode, setShortCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    const token = rememberFragmentToken(window.location.hash);
    if (window.location.hash.length > 0) {
      void navigate({ to: '/pair', replace: true });
    }
    if (!token) {
      setPhase({ kind: 'form' });
      return;
    }
    let cancelled = false;
    void redeemFragmentOnce(token, () => redeem({ token })).then((result) => {
      if (cancelled) return;
      if (result.ok) setPhase({ kind: 'done', warning: result.warning });
      else {
        setError(result.error);
        setPhase({ kind: 'form' });
      }
    });
    return () => { cancelled = true; };
  }, [navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await redeem({ shortCode });
    setBusy(false);
    if (result.ok) setPhase({ kind: 'done', warning: result.warning });
    else setError(result.error);
  }

  const environment = currentInstallEnvironment();
  const capability = installCapabilityWarning(environment);
  const originWarning = phase.kind === 'done' ? phase.warning : null;
  const notice = pairPageNotice(originWarning, capability);
  const guidance = installGuidance({
    ios: environment.ios,
    standalone: environment.standalone,
    promptAvailable: installPrompt !== null,
  });

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
            {error && <p className="login-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {phase.kind === 'done' && (
          <div className="pair-done">
            {notice && <PhoneNotice text={notice} />}
            {originWarning === null && (
              <InstallHelp
                guidance={guidance}
                onInstall={() => { void runInstall(installPrompt, setInstallPrompt); }}
              />
            )}
            <NotificationsPanel />
            <button type="button" className="btn btn-primary" onClick={() => void navigate({ to: '/chat' })}>
              Open chat
            </button>
          </div>
        )}
        {phase.kind !== 'done' && notice && <PhoneNotice text={notice} />}
        {phase.kind !== 'done' && (
          <a className="device-meta" href="/login?key=1">Sign in with an access key</a>
        )}
      </div>
    </div>
  );
}

async function runInstall(
  prompt: InstallPromptEvent | null,
  setPrompt: (next: InstallPromptEvent | null) => void,
): Promise<void> {
  if (!prompt) return;
  setPrompt(null);
  try {
    await prompt.prompt();
    await prompt.userChoice;
  } catch (err) {
    console.error('[pair] install prompt failed:', err);
  } finally {
    setPrompt(null);
  }
}

function InstallHelp({ guidance, onInstall }: { guidance: InstallGuidance; onInstall: () => void }) {
  if (guidance.kind === 'installed') return null;
  if (guidance.kind === 'prompt') {
    return (
      <button type="button" className="btn" onClick={onInstall}>
        Install Curia
      </button>
    );
  }
  if (guidance.kind === 'ios-share') {
    return (
      <ol className="pair-steps">
        {IOS_SHARE_STEPS.map((step) => <li key={step}>{step}</li>)}
      </ol>
    );
  }
  return <p className="device-meta">{BROWSER_INSTALL_HINT}</p>;
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
    if (res.status === 429) return { ok: false, error: PAIRING_LIMIT_MESSAGE };
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
