import { useEffect, useRef, useState } from 'react';

/**
 * Registers /sw.js and offers "Updated · Reload" when a new build is waiting.
 * The first install does not reload the page.
 */
export function PwaChrome() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloadRequested = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return;
    const onController = () => {
      if (!reloadRequested.current) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onController);

    const ready = navigator.serviceWorker.register('/sw.js').then((registration) => {
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          setWaiting(worker);
          return;
        }
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
        });
      };
      watch(registration.waiting);
      registration.addEventListener('updatefound', () => watch(registration.installing));
    }).catch((err: unknown) => {
      console.error('[pwa] service worker registration failed:', err);
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
      void ready;
    };
  }, []);

  if (!waiting) return null;

  return (
    <div className="pwa-update" role="status">
      <span>Updated ·</span>
      <button
        type="button"
        onClick={() => {
          reloadRequested.current = true;
          waiting.postMessage({ type: 'SKIP_WAITING' });
        }}
      >
        Reload
      </button>
    </div>
  );
}
