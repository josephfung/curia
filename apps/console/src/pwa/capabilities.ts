// What this browser can do as the installed phone app (#2341, ADR-055).
// Pairing state itself stays in the session cookie. Nothing here is stored.

export interface InstallEnvironment {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
}

const OPEN_ONLY =
  "This phone can open Curia, but it can't install the app or receive notifications from this address. If the home-screen app asks you to sign in again, type the short code shown on your computer.";

const NO_PUSH =
  "This phone can install Curia, but it can't receive notifications. Messages still show in the chat while the app is open.";

export function installCapabilityWarning(env: InstallEnvironment): string | null {
  if (!env.secureContext || !env.serviceWorker) return OPEN_ONLY;
  if (!env.pushManager || !env.notifications) return NO_PUSH;
  return null;
}

export function currentInstallEnvironment(): InstallEnvironment {
  return {
    secureContext: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notifications: typeof Notification !== 'undefined',
  };
}
