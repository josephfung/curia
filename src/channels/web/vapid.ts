// vapid.ts — load or create the web push key pair (#2341).
//
// The keys are generated once and kept in the vault. Regenerating them on
// deploy would silently break every subscription. The subject is APP_ORIGIN
// and must be https — Apple rejects a mailto subject with 403 BadJwtToken.

// web-push is CommonJS. Under Node's ESM loader only WebPushError is a named
// export, so a named import of the functions crashes the built app at startup.
// Use the default export (the module object) for all of them.
import webpush from 'web-push';

const { generateVAPIDKeys, sendNotification, setVapidDetails, WebPushError } = webpush;
import type { Logger } from '../../logger.js';
import type { SecretsService } from '../../secrets/secrets-service.js';
import type { PushSender, PushSendOptions, PushSubscriptionRow } from './push-service.js';
import { vapidSubject } from './push-service.js';
import { retryAfterMs } from './push-preview.js';

const SECRET_NAME = 'web_push_vapid';
const PUSH_TTL_SECONDS = 86_400;

/** One in-process generation at a time, so two boots do not each mint a key. */
let generation: Promise<VapidKeys> | null = null;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidSetup {
  configured: boolean;
  publicKey: string | null;
  sender: PushSender;
  /** Why push is off: no https APP_ORIGIN, or the vault's key pair could not be used. */
  disabledReason: 'origin' | 'keys' | null;
}

export async function loadVapidSetup(
  secrets: SecretsService,
  appOrigin: string | undefined,
  logger: Logger,
): Promise<VapidSetup> {
  const subject = vapidSubject(appOrigin, logger);
  if (!subject) {
    return { configured: false, publicKey: null, sender: disabledSender(), disabledReason: 'origin' };
  }
  // Push is optional. A vault read that fails, or a stored pair web-push rejects,
  // turns push off instead of stopping Curia from starting.
  let keys: VapidKeys;
  try {
    keys = await loadOrCreateKeys(secrets, logger);
    setVapidDetails(subject, keys.publicKey, keys.privateKey);
  } catch (err) {
    logger.error({ err }, 'web push: the VAPID keys could not be loaded or used, so push stays off');
    return { configured: false, publicKey: null, sender: disabledSender(), disabledReason: 'keys' };
  }
  const publicKey = keys.publicKey;
  return {
    configured: true,
    disabledReason: null,
    publicKey,
    sender: {
      // The timeout comes from the push phase, which shrinks it to the time it has left.
      async send(sub: PushSubscriptionRow, body: string, options: PushSendOptions): Promise<void> {
        try {
          await sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.authSecret },
          }, body, { TTL: PUSH_TTL_SECONDS, urgency: 'high', timeout: options.timeoutMs });
        } catch (err) {
          const statusCode = err instanceof WebPushError ? err.statusCode : statusCodeOf(err);
          const error = new Error(err instanceof Error ? err.message : 'web push failed');
          const extra: { statusCode?: number; body?: string; retryAfterMs?: number } = { statusCode };
          if (err instanceof WebPushError && err.body) extra.body = err.body;
          if (err instanceof WebPushError) {
            const retry = retryAfterHeader(err.headers);
            if (retry !== undefined) extra.retryAfterMs = retry;
          }
          throw Object.assign(error, extra);
        }
      },
    },
  };
}

async function loadOrCreateKeys(secrets: SecretsService, logger: Logger): Promise<VapidKeys> {
  const existing = await secrets.getJSON<VapidKeys>(SECRET_NAME);
  if (existing?.publicKey && existing.privateKey) return existing;
  if (!generation) {
    generation = createKeys(secrets, logger).finally(() => {
      generation = null;
    });
  }
  return generation;
}

async function createKeys(secrets: SecretsService, logger: Logger): Promise<VapidKeys> {
  const again = await secrets.getJSON<VapidKeys>(SECRET_NAME);
  if (again?.publicKey && again.privateKey) return again;
  const generated = generateVAPIDKeys();
  const keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  await secrets.setJSON(SECRET_NAME, keys);
  // Another process may have written first. Use whatever the vault holds now.
  const stored = await secrets.getJSON<VapidKeys>(SECRET_NAME);
  if (stored?.publicKey && stored.privateKey) {
    logger.info(stored.publicKey === keys.publicKey
      ? 'web push: generated VAPID keys'
      : 'web push: adopted VAPID keys already in the vault');
    return stored;
  }
  logger.info('web push: generated VAPID keys');
  return keys;
}

function retryAfterHeader(headers: Record<string, string> | undefined): number | undefined {
  return retryAfterMs(headers);
}

/**
 * Boot log. An origin that is set but not https is an error; an unset origin is not.
 * A key failure was already logged by loadVapidSetup, so it is not blamed on the origin.
 */
export function logVapidReadiness(
  logger: Logger,
  appOrigin: string | undefined,
  setup: Pick<VapidSetup, 'configured' | 'disabledReason'>,
): void {
  if (setup.configured) {
    logger.info('web push: VAPID ready');
    return;
  }
  if (setup.disabledReason === 'keys') return;
  if (appOrigin) {
    logger.error(
      { appOrigin },
      'web push: APP_ORIGIN is set but is not https, so the phone cannot receive notifications',
    );
    return;
  }
  logger.info('web push: not configured (APP_ORIGIN is unset)');
}

function disabledSender(): PushSender {
  return {
    async send() {
      throw Object.assign(new Error('web push is not configured'), { statusCode: 0 });
    },
  };
}

function statusCodeOf(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return 0;
}
