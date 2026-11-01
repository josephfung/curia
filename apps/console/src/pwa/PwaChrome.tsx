import { useEffect, useRef, useState } from 'react';

/**
 * Registers /sw.js and offers a reload when a new build is waiting.
 * The first install does not reload the page. Becoming visible checks
 * for a new worker. Reload runs once that worker activates.
 */
export function PwaChrome() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // The banner sits over the top bar, so the operator can put it away without reloading
  // (a reload would drop an unsent chat draft). The next launch offers the update again.
  const [dismissed, setDismissed] = useState(false);
  const reloadRequested = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || typeof navigator.serviceWorker?.register !== 'function') return;
    let registration: ServiceWorkerRegistration | undefined;
    const onController = () => {
      if (!reloadRequested.current) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onController);

    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return;
      void registration?.update().catch((err: unknown) => {
        console.error('[pwa] service worker update check failed:', err);
      });
    };
    document.addEventListener('visibilitychange', checkForUpdate);

    const watch = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const note = () => {
        if (worker.state === 'activated' && reloadRequested.current) {
          window.location.reload();
          return;
        }
        if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker);
      };
      note();
      worker.addEventListener('statechange', note);
    };

    void navigator.serviceWorker.register('/sw.js').then((registered) => {
      registration = registered;
      watch(registered.waiting);
      registered.addEventListener('updatefound', () => watch(registered.installing));
      checkForUpdate();
    }).catch((err: unknown) => {
      console.error('[pwa] service worker registration failed:', err);
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, []);

  if (!waiting || dismissed) return null;

  return (
    <div className="pwa-update" role="status">
      <span>Curia was updated ·</span>
      <button
        type="button"
        onClick={() => {
          reloadRequested.current = true;
          if (waiting.state === 'activated') {
            window.location.reload();
            return;
          }
          waiting.postMessage({ type: 'SKIP_WAITING' });
        }}
      >
        Reload
      </button>
      <button type="button" onClick={() => setDismissed(true)}>
        Later
      </button>
    </div>
  );
}
