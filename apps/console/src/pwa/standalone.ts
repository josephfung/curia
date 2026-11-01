/** `?key=1` keeps the access-key form available inside an installed desktop app. */
export function accessKeyLoginRequested(search: string): boolean {
  return new URLSearchParams(search).get('key') === '1';
}

/** Where a signed-out visit should land. The installed app pairs; a browser signs in. */
export function signedOutPath(standalone: boolean): '/login' | '/pair' {
  return standalone ? '/pair' : '/login';
}

export function isIosBrowser(userAgent: string): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && /Mobile/.test(userAgent);
}

/** True when this page is the installed home-screen app. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}
