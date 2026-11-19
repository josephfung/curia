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

/** Which kind of Nylas application the key belongs to. Anything Nylas does not call 'sandbox'
 *  reads as 'production'. A sandbox ships with Nylas's own Google connector and allows 5 grants. */
export type NylasEnvironment = 'sandbox' | 'production';

/** Per-step results, each set once that step was evaluated, so the console can show every step. */
export interface NylasSignInChecks {
  callbackRegistered?: boolean;
  googleConnector?: boolean;
}

/** Filled on either branch whenever the check got far enough to learn them. */
interface NylasSignInFacts {
  environment?: NylasEnvironment;
  checks?: NylasSignInChecks;
}

export type NylasSignInReadiness =
  | ({ ready: true; applicationId: string; region: NylasRegion } & NylasSignInFacts)
  | ({
      ready: false;
      reason:
        | 'no_api_key'
        | 'restart_required'
        | 'bad_api_key'
        | 'origin_not_https'
        | 'callback_unregistered'
        | 'no_google_connector'
        | 'nylas_unreachable'
        | 'settings_unreadable';
      detail: string;
    } & NylasSignInFacts);

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
  facts: NylasSignInFacts = {},
): NylasSignInReadiness {
  return { ready: false, reason, detail, ...facts };
}

/** Nylas's `environment` field as the two kinds Curia tells apart. */
export function nylasEnvironmentOf(raw: string | null | undefined): NylasEnvironment {
  return (raw ?? '').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
}

export async function checkNylasSignIn(deps: CheckNylasSignInDeps): Promise<NylasSignInReadiness> {
  let apiKey: string | undefined;
  let region: NylasRegion;
  try {
    apiKey = (await deps.readApiKey())?.trim();
    if (apiKey === undefined || apiKey === '') {
      return notReady('no_api_key', 'Save the Nylas API key first (Channels → Email).');
    }
    region = await deps.readRegion();
  } catch (err) {
    // The reader already logged the key name; the environment's key is not tried in its place.
    if (err instanceof NylasSettingsReadError) return notReady('settings_unreadable', SETTINGS_UNREADABLE_DETAIL);
    throw err;
  }
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

  // The callback and the connector are checked independently once the key works, so the console
  // can show every step's status; `reason` is still the first failing one, in this order.
  let step: 'get_application' | 'list_connectors' = 'get_application';
  const facts: NylasSignInFacts = {};
  const checks: NylasSignInChecks = {};
  try {
    const app = await client.getApplication();
    // A sandbox is fine: it ships with Nylas's own Google connector (up to 5 connected accounts).
    facts.environment = nylasEnvironmentOf(app.environment);
    checks.callbackRegistered = app.callbackUris.includes(mailboxSignInCallbackUrl(origin));
    facts.checks = checks;
    step = 'list_connectors';
    let connectorErr: unknown;
    try {
      const connectors = await client.listConnectors();
      checks.googleConnector = connectors.some((c) => c.provider === 'google');
    } catch (err) {
      connectorErr = err;
    }
    if (!checks.callbackRegistered) {
      if (connectorErr !== undefined) logConnectorFailure(deps.logger, connectorErr);
      return notReady('callback_unregistered', 'Register the sign-in callback URL with Nylas.', facts);
    }
    if (connectorErr !== undefined) throw connectorErr;
    if (!checks.googleConnector) {
      return notReady('no_google_connector', 'Create the Google connector in Nylas.', facts);
    }
    return { ready: true, applicationId: app.applicationId, region, ...facts };
  } catch (err) {
    // Only the HTTP status decides; the error text is never copied into the detail or the log.
    if (!(err instanceof NylasAppError)) {
      // Not a Nylas answer: a bug. Reported as unreachable, but loudly.
      deps.logger.error({ ...grantSafeErrorFields(err), step }, 'mailbox sign-in readiness check failed unexpectedly');
      return notReady('nylas_unreachable', 'Nylas did not answer; try again in a moment.', facts);
    }
    deps.logger.warn({ ...grantSafeErrorFields(err), step }, 'mailbox sign-in readiness: a Nylas call failed');
    const status = err.status;
    if (status === 401 || status === 403) {
      return notReady('bad_api_key', 'Nylas rejected the API key. Check the key and the region.', facts);
    }
    return notReady('nylas_unreachable', 'Nylas did not answer; try again in a moment.', facts);
  }
}

/** The connector listing failed while an earlier step already decides the reason: logged, and
 *  the connector's status is left unknown (absent from `checks`). */
function logConnectorFailure(logger: Logger, err: unknown): void {
  if (err instanceof NylasAppError) {
    logger.warn({ ...grantSafeErrorFields(err), step: 'list_connectors' }, 'mailbox sign-in readiness: a Nylas call failed');
  } else {
    logger.error({ ...grantSafeErrorFields(err), step: 'list_connectors' }, 'mailbox sign-in readiness check failed unexpectedly');
  }
}

/** The vault key holding the Nylas API key. */
export const NYLAS_API_KEY_SECRET = 'channel.email.nylas_api_key';
/** The vault key holding the (non-secret) region. */
export const NYLAS_REGION_SECRET = 'channel.email.nylas_region';

/**
 * A vault read of the Nylas key or region failed, so whether the vault overrides the environment
 * is unknown. Callers must not fall back to the environment's key: it may belong to a different
 * Nylas application. Carries the key name only, never a value.
 */
export class NylasSettingsReadError extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`Could not read ${secretName} from the vault`);
    this.name = 'NylasSettingsReadError';
    this.secretName = secretName;
  }
}

export const SETTINGS_UNREADABLE_DETAIL = 'Curia could not read its saved Nylas settings; try again in a moment.';

/**
 * Readers for the live key and region: vault first, then the environment, then the default.
 * The environment is used only when the vault confirms it holds no value. A vault read that
 * throws is logged (key name and error class only) and rethrown as NylasSettingsReadError.
 */
export function createNylasSignInReaders(deps: {
  secrets: { get(name: string): Promise<string | null> };
  env: NodeJS.ProcessEnv;
  logger: Logger;
}): { readApiKey: () => Promise<string | undefined>; readRegion: () => Promise<NylasRegion> } {
  const { secrets, env, logger } = deps;
  async function fromVault(name: string): Promise<string | undefined> {
    let raw: string | null;
    try {
      raw = await secrets.get(name);
    } catch (err) {
      logger.error({ name, errName: err instanceof Error ? err.name : typeof err }, 'Nylas sign-in: vault read failed; not falling back to the environment');
      throw new NylasSettingsReadError(name);
    }
    const v = raw?.trim();
    return v !== undefined && v !== '' ? v : undefined;
  }
  return {
    readApiKey: async () => (await fromVault(NYLAS_API_KEY_SECRET)) ?? (env['NYLAS_API_KEY']?.trim() || undefined),
    // The first valid value of vault ▸ env, else 'us': the same choice the boot overlay
    // (applyChannelVaultSecrets) makes, so an ignored invalid value does not read as a change.
    readRegion: async () => {
      const candidates: Array<[source: string, raw: string | undefined]> = [
        ['vault', await fromVault(NYLAS_REGION_SECRET)],
        ['env', env['NYLAS_REGION']?.trim() || undefined],
      ];
      const rejectedSources: string[] = [];
      let region: NylasRegion = 'us';
      for (const [source, raw] of candidates) {
        if (raw === undefined) continue;
        const parsed = parseNylasRegion(raw);
        if (parsed !== null) {
          region = parsed;
          break;
        }
        rejectedSources.push(source);
      }
      if (rejectedSources.length > 0) {
        // Never the value: an operator may have pasted the API key into the field.
        logger.warn({ setting: NYLAS_REGION_SECRET, rejectedSources, using: region }, "Ignored an unknown Nylas region setting (expected 'us' or 'eu')");
      }
      return region;
    },
  };
}
