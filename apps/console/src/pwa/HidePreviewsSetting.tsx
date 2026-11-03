import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

/**
 * Hide message text in notifications. One setting for every device, so it
 * sits with the device list rather than with "this device".
 */
export function HidePreviewsSetting() {
  const [hidePreviews, setHidePreviews] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/push/config')
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load the notification setting.');
        const body: unknown = await res.json();
        const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
        // Without push configured there's nothing to hide, so the setting stays out of the way.
        if (cancelled || record['configured'] !== true) return;
        if (typeof record['hidePreviews'] !== 'boolean') throw new Error('Malformed notification settings.');
        setHidePreviews(record['hidePreviews']);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the notification setting.');
      });
    return () => { cancelled = true; };
  }, []);

  async function save(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/push/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidePreviews: next }),
      });
      if (!res.ok) throw new Error('Could not save the notification setting.');
      setHidePreviews(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the notification setting.');
    } finally {
      setBusy(false);
    }
  }

  if (hidePreviews === null && !error) return null;
  return (
    <div className="hide-previews">
      {hidePreviews !== null && (
        <label className="push-toggle">
          <input
            type="checkbox"
            checked={hidePreviews}
            disabled={busy}
            onChange={(event) => void save(event.target.checked)}
          />
          Hide message text in notifications (all devices)
        </label>
      )}
      {error && <p className="autonomy-error">{error}</p>}
    </div>
  );
}
