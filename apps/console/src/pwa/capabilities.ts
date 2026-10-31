// What this browser can do as the installed phone app (#2341, ADR-055).
// Pairing state itself stays in the session cookie. Nothing here is stored.

import { PHONE_DOCS_URL } from '../../../../src/phone/phone-docs.js';
import { isIosBrowser, isStandaloneDisplay } from './standalone.js';

export interface InstallEnvironment {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
  ios: boolean;
  standalone: boolean;
}

const OPEN_ONLY =
  "This phone can open Curia, but it can't install the app or receive notifications from this address. "
  + PHONE_DOCS_URL;

const IOS_ADD_HOME = 'Add Curia to your Home Screen to get notifications.';

const NO_PUSH =
  "This phone can install Curia, but it can't receive notifications. Messages still show in the chat while the app is open.";

export function installCapabilityWarning(env: InstallEnvironment): string | null {
  if (!env.secureContext || !env.serviceWorker) return OPEN_ONLY;
  if (env.ios && !env.standalone) return IOS_ADD_HOME;
  if (!env.pushManager || !env.notifications) return NO_PUSH;
  return null;
}

/** One notice. An origin that cannot host the app already says so. */
export function pairPageNotice(originWarning: string | null, capability: string | null): string | null {
  return originWarning ?? capability;
}

export function currentInstallEnvironment(): InstallEnvironment {
  return {
    secureContext: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notifications: typeof Notification !== 'undefined',
    ios: isIosBrowser(navigator.userAgent),
    standalone: isStandaloneDisplay(),
  };
}
