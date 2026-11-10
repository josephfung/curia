import type { Logger } from '../../logger.js';
import { resolvePrincipalCalendarGrant } from '../calendar/resolve-calendar-grant.js';
import { NylasClient } from './nylas-client.js';

/**
 * Resolves a Nylas client bound to the principal's own mailbox (the `ceo-inbox`
 * grant, `ceo_nylas_grant_id`), or null when it is not available (#2474).
 */
export type PrincipalMailboxResolver = () => Promise<NylasClient | null>;

/**
 * Build a resolver that reads the grant on every call, so a grant rotated in the
 * vault takes effect without a restart. The client is cached per grant id and only
 * rebuilt when the grant changes.
 */
export function createPrincipalMailboxResolver(deps: {
  secrets: { get(name: string): Promise<string | null> };
  apiKey: () => string | undefined;
  logger: Logger;
  createClient?: (apiKey: string, grantId: string) => NylasClient;
}): PrincipalMailboxResolver {
  const { secrets, apiKey, logger } = deps;
  const createClient = deps.createClient ?? ((key: string, grant: string) => new NylasClient(key, grant, logger));
  let cached: { key: string; grantId: string; client: NylasClient } | null = null;

  return async () => {
    let grantId: string | undefined;
    try {
      grantId = await resolvePrincipalCalendarGrant(secrets);
    } catch (err) {
      // Fail closed: a vault read/decrypt failure yields no client, so no send is
      // attempted from a mailbox we could not positively identify.
      logger.error({ err }, 'Principal mailbox grant could not be read; treating mailbox as unavailable');
      return null;
    }
    // Fail closed: no grant configured means no principal mailbox.
    if (!grantId) return null;

    const key = apiKey();
    // Fail closed: without an API key we cannot build a client. Warned, because the refusal
    // then says the mailbox isn't connected while the grant is set (final review M1).
    if (!key) {
      logger.warn('Principal mailbox grant is set but the Nylas API key is missing; treating mailbox as unavailable');
      return null;
    }

    if (cached && cached.grantId === grantId && cached.key === key) return cached.client;
    const client = createClient(key, grantId);
    cached = { key, grantId, client };
    return client;
  };
}
