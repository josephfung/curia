// vapid.ts — load or create the web push key pair (#2341).
//
// The keys are generated once and kept in the vault. Regenerating them on
// deploy would silently break every subscription. The subject is APP_ORIGIN
// and must be https — Apple rejects a mailto subject with 403 BadJwtToken.

import { generateVAPIDKeys, sendNotification, setVapidDetails } from 'web-push';
import type { Logger } from '../../logger.js';
import type { SecretsService } from '../../secrets/secrets-service.js';
import type { PushSender, PushSubscriptionRow } from './push-service.js';
import { vapidSubject } from './push-service.js';

const SECRET_NAME = 'web_push_vapid';

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
  const subject = vapidSubject(appOrigin);
  if (!subject) {
    return { configured: false, publicKey: null, sender: disabledSender() };
  }
  let keys = await secrets.getJSON<VapidKeys>(SECRET_NAME);
  if (!keys?.publicKey || !keys.privateKey) {
    const generated = generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    await secrets.setJSON(SECRET_NAME, keys);
    // The private key stays in the vault. This log names the event only.
    logger.info('web push: generated VAPID keys');
  }
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
          }, body);
        } catch (err) {
          const statusCode = statusCodeOf(err);
          const error = new Error(err instanceof Error ? err.message : 'web push failed');
          (error as Error & { statusCode?: number }).statusCode = statusCode;
          throw error;
        }
      },
    },
  };
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
