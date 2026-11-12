import type { Logger } from '../../logger.js';
import { NylasClient } from './nylas-client.js';
import { MissingNylasApiKeyError } from '../../principal-mailboxes/types.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';

/**
 * Resolves a Nylas client bound to the named principal mailbox (#2474, #2475), or null when it
 * is not available. An unknown or removed id is null, never the default mailbox.
 */
export type PrincipalMailboxResolver = (mailboxId: string) => Promise<NylasClient | null>;

/**
 * Build a resolver that reads a mailbox's grant from the registry on every call, so a grant
 * rotated in the vault takes effect without a restart. The client is cached per mailbox and
 * only rebuilt when its grant changes.
 */
export function createPrincipalMailboxResolver(deps: {
  mailboxes: Pick<PrincipalMailboxes, 'credentials'>;
  logger: Logger;
  createClient?: (apiKey: string, grantId: string) => NylasClient;
}): PrincipalMailboxResolver {
  const { mailboxes, logger } = deps;
  const createClient = deps.createClient ?? ((key: string, grant: string) => new NylasClient(key, grant, logger));
  const cached = new Map<string, { key: string; grantId: string; client: NylasClient }>();

  return async (mailboxId) => {
    let creds: { apiKey: string; grantId: string };
    try {
      // Throws for an unknown or removed id: fail closed below, never another mailbox.
      creds = await mailboxes.credentials(mailboxId);
    } catch (err) {
      if (err instanceof MissingNylasApiKeyError) {
        logger.warn('Principal mailbox is registered but the Nylas API key (channel.email.nylas_api_key) is missing; treating mailbox as unavailable');
        return null;
      }
      // Fail closed: a registry/vault failure, a missing grant or a missing API key yields no
      // client, so no send is attempted from a mailbox we could not positively identify.
      logger.error({ err }, 'Principal mailbox credentials could not be read; treating mailbox as unavailable');
      return null;
    }
    const { apiKey: key, grantId } = creds;
    if (!grantId.trim() || !key) {
      // credentials() refuses a missing grant or key, so this is a blank value in the vault.
      logger.warn({ hasGrant: grantId.trim() !== '', hasApiKey: !!key }, 'Principal mailbox grant or Nylas API key is blank; treating mailbox as unavailable');
      return null;
    }

    const hit = cached.get(mailboxId);
    if (hit && hit.grantId === grantId && hit.key === key) return hit.client;
    const client = createClient(key, grantId);
    cached.set(mailboxId, { key, grantId, client });
    return client;
  };
}
