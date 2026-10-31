import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';

interface PushNotice {
  id: string;
  kind: 'dead' | 'setup';
  detail: string;
}

function isNotice(value: unknown): value is PushNotice {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['id'] === 'string'
    && (row['kind'] === 'dead' || row['kind'] === 'setup')
    && typeof row['detail'] === 'string';
}

/** Console-wide notice when a phone stops receiving pushes or setup is rejected. */
export function PushNoticesBanner() {
  const [notices, setNotices] = useState<PushNotice[]>([]);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/push/config');
    if (!res.ok) return;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return;
    const rows = (body as { notices?: unknown }).notices;
    if (!Array.isArray(rows)) return;
    setNotices(rows.filter(isNotice));
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => {
      if (!cancelled) setNotices([]);
    });
    return () => { cancelled = true; };
  }, [load]);

  async function dismiss(id: string) {
    const res = await apiFetch(`/api/push/notices/${id}/dismiss`, { method: 'POST' });
    if (!res.ok) return;
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }

  if (notices.length === 0) return null;
  return (
    <div className="push-banner-stack">
      {notices.map((notice) => (
        <div key={notice.id} className="push-banner" role="status">
          <p>{notice.detail}</p>
          <button type="button" className="btn" onClick={() => void dismiss(notice.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
