import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { currentInstallEnvironment, installCapabilityWarning } from './capabilities';
import { enablePush, thisBrowserIsSubscribed } from './push-client';

interface PushNotice {
  id: string;
  kind: 'dead' | 'setup';
  detail: string;
  createdAt: string;
}

interface PushConfig {
  publicKey: string | null;
  configured: boolean;
  hidePreviews: boolean;
  notices: PushNotice[];
}

function isNotice(value: unknown): value is PushNotice {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && (row['kind'] === 'dead' || row['kind'] === 'setup')
    && typeof row['detail'] === 'string'
    && typeof row['createdAt'] === 'string';
}

function isConfig(value: unknown): value is PushConfig {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (row['publicKey'] === null || typeof row['publicKey'] === 'string')
    && typeof row['configured'] === 'boolean'
    && typeof row['hidePreviews'] === 'boolean'
    && Array.isArray(row['notices'])
    && row['notices'].every(isNotice);
}

export function NotificationsPanel() {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const capability = installCapabilityWarning(currentInstallEnvironment());

  const load = useCallback(async () => {
    const res = await apiFetch('/api/push/config');
    if (!res.ok) throw new Error('Could not load notification settings.');
    const body: unknown = await res.json();
    if (!isConfig(body)) throw new Error('Malformed notification settings.');
    setConfig(body);
    setSubscribed(await thisBrowserIsSubscribed());
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Could not load notification settings.');
    });
    return () => { cancelled = true; };
  }, [load]);

  async function turnOn() {
    if (!config?.publicKey) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush(config.publicKey);
      setSubscribed(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn on notifications.');
    } finally {
      setBusy(false);
    }
  }

  async function setHidePreviews(hidePreviews: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/push/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidePreviews }),
      });
      if (!res.ok) throw new Error('Could not save the notification setting.');
      setConfig((current) => current ? { ...current, hidePreviews } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the notification setting.');
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(id: string) {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/push/notices/${id}/dismiss`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not dismiss the notice.');
      setConfig((current) => current
        ? { ...current, notices: current.notices.filter((notice) => notice.id !== id) }
        : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dismiss the notice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pair-panel" aria-label="Notifications">
      <h3 className="settings-section-title">Notifications</h3>
      <p className="device-meta">
        The phone app alerts you when nobody has the chat open. Turning this on asks the browser for permission.
      </p>
      {capability && <p className="pair-warning" role="status">{capability}</p>}
      {config && !config.configured && (
        <p className="pair-warning" role="status">Notifications need an HTTPS address for this Curia.</p>
      )}
      {error && <p className="autonomy-error">{error}</p>}
      {config?.notices.map((notice) => (
        <div key={notice.id} className="pair-warning" role="status">
          <p>{notice.detail}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void dismiss(notice.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {config?.configured && !capability && (
        <div className="device-actions">
          {subscribed ? (
            <p className="device-meta">Notifications are on for this phone.</p>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void turnOn()}>
              {busy ? 'Turning on…' : 'Turn on notifications'}
            </button>
          )}
          <label className="push-toggle">
            <input
              type="checkbox"
              checked={config.hidePreviews}
              disabled={busy}
              onChange={(event) => void setHidePreviews(event.target.checked)}
            />
            Hide message previews
          </label>
        </div>
      )}
    </section>
  );
}
