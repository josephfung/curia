import { useCallback, useState } from 'react';
import type { ActivityScript } from '@curia/shared-types';
import { apiFetch } from '../api.js';

export interface TimelineQuery {
  from?: string;
  to?: string;
  conversationId?: string;
  taskId?: string;
  limit?: number;
}

export function useTimeline() {
  const [script, setScript] = useState<ActivityScript | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTimeline = useCallback(async (query: TimelineQuery) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.from) params.set('from', query.from);
      if (query.to) params.set('to', query.to);
      if (query.conversationId) params.set('conversationId', query.conversationId);
      if (query.taskId) params.set('taskId', query.taskId);
      if (query.limit) params.set('limit', String(query.limit));

      const res = await apiFetch(`/api/antfarm/timeline?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Timeline fetch failed (${res.status})`);
      }
      const data = await res.json() as ActivityScript;
      setScript(data);
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Timeline fetch failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { script, loading, error, fetchTimeline, setScript };
}
