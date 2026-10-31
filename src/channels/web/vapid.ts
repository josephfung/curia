// vapid.ts — load or create the web push key pair (#2341).
//
// The keys are generated once and kept in the vault. Regenerating them on
// deploy would silently break every subscription. The subject is APP_ORIGIN
// and must be https — Apple rejects a mailto subject with 403 BadJwtToken.

import { generateVAPIDKeys, sendNotification, setVapidDetails, WebPushError } from 'web-push';
import type { Logger } from '../../logger.js';
import type { SecretsService } from '../../secrets/secrets-service.js';
import type { PushSender, PushSubscriptionRow } from './push-service.js';
import { vapidSubject } from './push-service.js';
import { retryAfterMs } from './push-preview.js';

const SECRET_NAME = 'web_push_vapid';
const PUSH_TIMEOUT_MS = 10_000;
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
}

export async function loadVapidSetup(
  secrets: SecretsService,
  appOrigin: string | undefined,
  logger: Logger,
): Promise<VapidSetup> {
  const subject = vapidSubject(appOrigin, logger);
  if (!subject) {
    return { configured: false, publicKey: null, sender: disabledSender() };
  }
  const keys = await loadOrCreateKeys(secrets, logger);
  setVapidDetails(subject, keys.publicKey, keys.privateKey);
  const publicKey = keys.publicKey;
  return {
    configured: true,
    publicKey,
    sender: {
      async send(sub: PushSubscriptionRow, body: string): Promise<void> {
        try {
          await sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.authSecret },
          }, body, { TTL: PUSH_TTL_SECONDS, urgency: 'high', timeout: PUSH_TIMEOUT_MS });
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

/** Boot log. An origin that is set but not https is an error; an unset origin is not. */
export function logVapidReadiness(logger: Logger, appOrigin: string | undefined, configured: boolean): void {
  if (configured) {
    logger.info('web push: VAPID ready');
    return;
  }
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
