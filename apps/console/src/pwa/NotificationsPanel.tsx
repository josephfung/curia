import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { currentInstallEnvironment, installCapabilityWarning } from './capabilities';
import { enablePush, syncPushSubscription } from './push-client';
import { isNotice, type PushNotice } from './push-notice';
import { notificationCopy } from './notification-copy';
import { isStandaloneDisplay } from './standalone';

interface PushConfig {
  publicKey: string | null;
  configured: boolean;
  subscribed: boolean;
  hidePreviews: boolean;
  notices: PushNotice[];
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

/**
 * Notifications for the device this is open on. Turning them on subscribes
 * this browser or installed app, never another device, so the copy names it.
 * Hiding previews applies to every device and lives with the device list.
 */
export function NotificationsPanel({ onChange }: { onChange?: () => void } = {}) {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const capability = installCapabilityWarning(currentInstallEnvironment());
  const copy = notificationCopy({
    standalone: isStandaloneDisplay(),
    touch: typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true,
  });

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
      onChange?.();
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
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn off notifications.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pair-panel" aria-label="Notifications on this device">
      <h3 className="settings-section-title">Notifications on this device</h3>
      <p className="device-meta">
        {copy.intro}
        {copy.phoneHint && <> {copy.phoneHint}</>}
      </p>
      {capability && <p className="pair-warning" role="status">{capability}</p>}
      {config && !config.configured && (
        <p className="pair-warning" role="status">Notifications need an HTTPS address for this Curia.</p>
      )}
      {error && <p className="autonomy-error">{error}</p>}
      {config?.configured && !capability && (
        <div className="device-actions">
          {subscribed ? (
            <p className="notify-status" role="status">
              <span className="device-badge device-badge-on">{copy.onStatus}</span>
              <button type="button" className="link-button" disabled={busy} onClick={() => void turnOff()}>
                Turn off
              </button>
            </p>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void turnOn()}>
              {busy ? 'Turning on…' : copy.turnOn}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
