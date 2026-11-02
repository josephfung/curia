import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { isNotice, type PushNotice } from './push-notice';

/**
 * Console-wide notice when a phone stops receiving pushes, setup is rejected,
 * or a phone signed in with an invitation link.
 */
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
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      load().catch(() => {
        if (!cancelled) setNotices([]);
      });
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refresh);
    };
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
