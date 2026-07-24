// useAsyncData — per-card fetch/error/retry, so one dead endpoint degrades a
// single card instead of the whole page. Follows the Sidebar AbortController
// idiom (abort on unmount / retry), with a retry() that re-runs the fetcher.

import { useState, useEffect, useCallback } from 'react';

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

// `fetcher` must be a stable reference (the module-level fetch* functions from
// dashboard-utils are). It receives an AbortSignal so an in-flight request is
// cancelled on unmount or retry.
export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
): Loadable<T> & { retry: () => void } {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState(s => ({ ...s, loading: true, error: null }));
    fetcher(controller.signal)
      .then(data => setState({ data, error: null, loading: false }))
      .catch((err: unknown) => {
        // Ignore the abort we triggered on cleanup — it isn't a real failure.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('[dashboard] card load failed:', err);
        setState({ data: null, error: err instanceof Error ? err.message : 'Failed to load', loading: false });
      });
    return () => controller.abort();
  }, [fetcher, nonce]);

  const retry = useCallback(() => setNonce(n => n + 1), []);
  return { ...state, retry };
}

// Tone → CSS token colour, shared by the status dots across cards.
export const TONE_COLOR: Record<'ok' | 'warn' | 'danger', string> = {
  ok:     'var(--app-green)',
  warn:   'var(--app-amber)',
  danger: 'var(--app-destructive)',
};
