import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { currentInstallEnvironment, installCapabilityWarning } from './capabilities';
import { enablePush, syncPushSubscription } from './push-client';
import { isStandaloneDisplay } from './standalone';

interface PushNotice {
  id: string;
  kind: 'dead' | 'setup';
  detail: string;
  createdAt: string;
}

interface PushConfig {
  publicKey: string | null;
  configured: boolean;
  subscribed: boolean;
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
    && typeof row['subscribed'] === 'boolean'
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
    await syncPushSubscription().catch(() => false);
    const res = await apiFetch('/api/push/config');
    if (!res.ok) throw new Error('Could not load notification settings.');
    const body: unknown = await res.json();
    if (!isConfig(body)) throw new Error('Malformed notification settings.');
    setConfig(body);
    setSubscribed(body.subscribed);
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

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        await subscription?.unsubscribe();
      }
      const res = await apiFetch('/api/push/subscriptions', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not turn off notifications.');
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off notifications.');
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
      {config?.configured && !capability && (
        <div className="device-actions">
          {subscribed ? (
            <>
              <p className="device-meta">
                {isStandaloneDisplay()
                  ? 'Notifications are on for this phone.'
                  : 'Notifications are on for this browser.'}
              </p>
              <button type="button" className="btn" disabled={busy} onClick={() => void turnOff()}>
                Turn off notifications
              </button>
            </>
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
