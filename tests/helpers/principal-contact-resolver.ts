/**
 * Shared ContactResolver stub that resolves every sender as the principal.
 * Used by integration harnesses that exercise the CLI/HTTP happy path and need
 * Gate C on the dispatcher relay (#1733) to allow delivery.
 *
 * Default contactId is `primary-user` so the dispatcher skips contact.resolved
 * audit noise (same synthetic-id carve-out as CLI/smoke tests).
 */

import type { ContactResolver } from '../../src/contacts/contact-resolver.js';
import type { ContactTier, ContactKind } from '../../src/contacts/types.js';

export function makePrincipalContactResolver(
  opts: { contactId?: string; contactConfidence?: number } = {},
): ContactResolver {
  return {
    resolve: async (_channel: string, _senderId: string) => ({
      resolved: true,
      contactId: opts.contactId ?? 'primary-user',
      displayName: 'Principal',
      role: null,
      systemRole: 'principal' as const,
      tier: 'principal' as ContactTier,
      kind: 'principal' as ContactKind,
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: opts.contactConfidence ?? 1,
    }),
  } as unknown as ContactResolver;
}
