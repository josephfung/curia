// Is mailbox sign-in (Nylas v3 hosted auth) usable right now? (#2361)
//
// Checked live on every call: the API key, region and APP_ORIGIN are read through the supplied
// readers, never cached, so a key saved from the console is picked up without a restart. The
// detail strings are operator-facing and never carry the key or any Nylas response text.

import type { Logger } from '../logger.js';
import { NylasAppClient, NylasAppError } from './app-client.js';
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

export interface CheckNylasSignInDeps {
  readApiKey: () => Promise<string | undefined>;
  readRegion: () => Promise<NylasRegion>;
  appOrigin: string | undefined;
  /** Test seam. The default builds a real client; `logger` is only used by that default. */
  makeClient?: (apiKey: string, apiUri: string) => NylasAppClient;
  logger?: Logger;
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
  const origin = deps.appOrigin;
  if (origin === undefined || !origin.startsWith('https://')) {
    return notReady('origin_not_https', 'Sign-in needs APP_ORIGIN set to this console\'s public https:// address.');
  }

  const region = await deps.readRegion();
  const apiUri = nylasApiUri(region);
  const make = deps.makeClient;
  if (make === undefined && deps.logger === undefined) {
    throw new Error('checkNylasSignIn needs a logger or a makeClient');
  }
  const client = make !== undefined ? make(apiKey, apiUri) : new NylasAppClient({ apiKey, apiUri, logger: deps.logger! });

  try {
    const app = await client.getApplication();
    if ((app.environment ?? '').toLowerCase() === 'sandbox') {
      return notReady('sandbox', 'This Nylas application is a sandbox; sign-in needs a production application.');
    }
    if (!app.callbackUris.includes(mailboxSignInCallbackUrl(origin))) {
      return notReady('callback_unregistered', 'Register the sign-in callback URL with Nylas.');
    }
    const connectors = await client.listConnectors();
    if (!connectors.some((c) => c.provider === 'google')) {
      return notReady('no_google_connector', 'Create the Google connector in Nylas.');
    }
    return { ready: true, applicationId: app.applicationId, region };
  } catch (err) {
    // Only the HTTP status decides; the error text is never copied into the detail.
    const status = err instanceof NylasAppError ? err.status : 0;
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
