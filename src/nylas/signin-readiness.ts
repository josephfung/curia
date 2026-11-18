// Is mailbox sign-in (Nylas v3 hosted auth) usable right now? (#2361)
//
// Checked live on every call: the API key and region are read through the supplied readers, never
// cached. The email adapters and principal mailboxes take the key and region at boot, though, so
// a key or region saved (or changed) after boot reads `restart_required` until Curia restarts
// once (R11). The detail strings are operator-facing and never carry the key or any Nylas
// response text.

import type { Logger } from '../logger.js';
import { NylasAppClient, NylasAppError } from './app-client.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';
import { nylasApiUri, parseNylasRegion, type NylasRegion } from './region.js';

/** The Google scopes sign-in requests and the grant must hold. */
export const MAILBOX_SIGNIN_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar',
];

export type NylasSignInReadiness =
  | { ready: true; applicationId: string; region: NylasRegion }
  | {
      ready: false;
      reason:
        | 'no_api_key'
        | 'restart_required'
        | 'bad_api_key'
        | 'sandbox'
        | 'origin_not_https'
        | 'callback_unregistered'
        | 'no_google_connector'
        | 'nylas_unreachable';
      detail: string;
    };

/** The URL Nylas redirects back to after sign-in. Byte-identical in the auth and token calls. */
export function mailboxSignInCallbackUrl(appOrigin: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/api/mailbox-signin/callback`;
}

/** The Nylas key and region the process booted with (config.nylasApiKey / config.nylasRegion). */
export interface NylasBootConfig {
  apiKey: string | undefined;
  region: NylasRegion;
}

/**
 * True when the live key or region is not what the process booted with: the email adapters and
 * principal mailboxes still use the boot values, so sign-in waits for a restart (R11).
 */
export function nylasRestartRequired(liveApiKey: string, liveRegion: NylasRegion, boot: NylasBootConfig): boolean {
  const bootKey = boot.apiKey?.trim() || undefined;
  return bootKey !== liveApiKey.trim() || boot.region !== liveRegion;
}

export const RESTART_REQUIRED_DETAIL = 'Restart Curia to finish setting up sign-in.';

/** Per-request timeout for readiness's Nylas calls: two in a row must fit in setup-status's 15 s. */
export const READINESS_TIMEOUT_MS = 5000;

export interface CheckNylasSignInDeps {
  readApiKey: () => Promise<string | undefined>;
  readRegion: () => Promise<NylasRegion>;
  appOrigin: string | undefined;
  /** The boot-time key and region. Absent: no boot values to compare (tests), so no restart check. */
  boot?: NylasBootConfig;
  /** Test seam. The default builds a real client with READINESS_TIMEOUT_MS. */
  makeClient?: (apiKey: string, apiUri: string) => NylasAppClient;
  logger: Logger;
}

function notReady(
  reason: Extract<NylasSignInReadiness, { ready: false }>['reason'],
  detail: string,
): NylasSignInReadiness {
  return { ready: false, reason, detail };
}

export async function checkNylasSignIn(deps: CheckNylasSignInDeps): Promise<NylasSignInReadiness> {
  const apiKey = (await deps.readApiKey())?.trim();
  if (apiKey === undefined || apiKey === '') {
    return notReady('no_api_key', 'Save the Nylas API key first (Channels → Email).');
  }
  const region = await deps.readRegion();
  if (deps.boot !== undefined && nylasRestartRequired(apiKey, region, deps.boot)) {
    return notReady('restart_required', RESTART_REQUIRED_DETAIL);
  }
  const origin = deps.appOrigin;
  if (origin === undefined || !origin.startsWith('https://')) {
    return notReady('origin_not_https', 'Sign-in needs APP_ORIGIN set to this console\'s public https:// address.');
  }

  const apiUri = nylasApiUri(region);
  const client = deps.makeClient !== undefined
    ? deps.makeClient(apiKey, apiUri)
    : new NylasAppClient({ apiKey, apiUri, logger: deps.logger, timeoutMs: READINESS_TIMEOUT_MS });

  let step: 'get_application' | 'list_connectors' = 'get_application';
  try {
    const app = await client.getApplication();
    if ((app.environment ?? '').toLowerCase() === 'sandbox') {
      return notReady('sandbox', 'This Nylas application is a sandbox; sign-in needs a production application.');
    }
    if (!app.callbackUris.includes(mailboxSignInCallbackUrl(origin))) {
      return notReady('callback_unregistered', 'Register the sign-in callback URL with Nylas.');
    }
    step = 'list_connectors';
    const connectors = await client.listConnectors();
    if (!connectors.some((c) => c.provider === 'google')) {
      return notReady('no_google_connector', 'Create the Google connector in Nylas.');
    }
    return { ready: true, applicationId: app.applicationId, region };
  } catch (err) {
    // Only the HTTP status decides; the error text is never copied into the detail or the log.
    if (!(err instanceof NylasAppError)) {
      // Not a Nylas answer: a bug. Reported as unreachable, but loudly.
      deps.logger.error({ ...grantSafeErrorFields(err), step }, 'mailbox sign-in readiness check failed unexpectedly');
      return notReady('nylas_unreachable', 'Nylas did not answer; try again in a moment.');
    }
    deps.logger.warn({ ...grantSafeErrorFields(err), step }, 'mailbox sign-in readiness: a Nylas call failed');
    const status = err.status;
    if (status === 401 || status === 403) {
      return notReady('bad_api_key', 'Nylas rejected the API key. Check the key and the region.');
    }
    return notReady('nylas_unreachable', 'Nylas did not answer; try again in a moment.');
  }
}

/** The vault key holding the Nylas API key. */
export const NYLAS_API_KEY_SECRET = 'channel.email.nylas_api_key';
/** The vault key holding the (non-secret) region. */
export const NYLAS_REGION_SECRET = 'channel.email.nylas_region';

/**
 * Readers for the live key and region: vault first, then the environment, then the default.
 * A vault read that throws is logged and treated as absent, so a blip reads as "not ready"
 * rather than crashing the caller.
 */
export function createNylasSignInReaders(deps: {
  secrets: { get(name: string): Promise<string | null> };
  env: NodeJS.ProcessEnv;
  logger: Logger;
}): { readApiKey: () => Promise<string | undefined>; readRegion: () => Promise<NylasRegion> } {
  const { secrets, env, logger } = deps;
  async function fromVault(name: string): Promise<string | undefined> {
    try {
      const v = (await secrets.get(name))?.trim();
      return v !== undefined && v !== '' ? v : undefined;
    } catch (err) {
      logger.warn({ name, errName: err instanceof Error ? err.name : typeof err }, 'Nylas sign-in: vault read failed; treating as unset');
      return undefined;
    }
  }
  return {
    readApiKey: async () => (await fromVault(NYLAS_API_KEY_SECRET)) ?? (env['NYLAS_API_KEY']?.trim() || undefined),
    readRegion: async () => {
      const raw = (await fromVault(NYLAS_REGION_SECRET)) ?? env['NYLAS_REGION'];
      const parsed = parseNylasRegion(raw);
      if (parsed === null) {
        logger.warn({ value: raw }, "Unknown Nylas region (expected 'us' or 'eu'); using 'us'");
        return 'us';
      }
      return parsed;
    },
  };
}
