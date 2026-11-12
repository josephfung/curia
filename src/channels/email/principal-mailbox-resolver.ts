import type { Logger } from '../../logger.js';
import { NylasClient } from './nylas-client.js';
import { MissingNylasApiKeyError } from '../../principal-mailboxes/types.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';

/**
 * Resolves a Nylas client bound to the principal's default mailbox (#2474, #2475),
 * or null when it is not available.
 */
export type PrincipalMailboxResolver = () => Promise<NylasClient | null>;

/**
 * Build a resolver that reads the default mailbox's grant from the registry on every call,
 * so a grant rotated in the vault takes effect without a restart. The client is cached per
 * grant id and only rebuilt when the grant changes.
 */
export function createPrincipalMailboxResolver(deps: {
  mailboxes: Pick<PrincipalMailboxes, 'defaultMailbox' | 'credentials'>;
  logger: Logger;
  createClient?: (apiKey: string, grantId: string) => NylasClient;
}): PrincipalMailboxResolver {
  const { mailboxes, logger } = deps;
  const createClient = deps.createClient ?? ((key: string, grant: string) => new NylasClient(key, grant, logger));
  let cached: { key: string; grantId: string; client: NylasClient } | null = null;

  return async () => {
    let creds: { apiKey: string; grantId: string };
    try {
      const mailbox = await mailboxes.defaultMailbox();
      // Fail closed: no mailbox registered means no principal mailbox.
      if (!mailbox) return null;
      creds = await mailboxes.credentials(mailbox.id);
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
    if (!grantId.trim() || !key) return null;

    if (cached && cached.grantId === grantId && cached.key === key) return cached.client;
    const client = createClient(key, grantId);
    cached = { key, grantId, client };
    return client;
  };
}
