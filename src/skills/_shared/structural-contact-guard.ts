// structural-contact-guard.ts — the one rule every agent skill that changes a contact's
// addresses applies first (#2041): a structural contact's addresses are not an agent's
// to change.
//
// The principal's verified identities are trusted as the principal by Gate C and by the
// "principal" send alias. An address an agent could add to the principal, move onto
// them with a merge, re-activate or remove would let it impersonate the principal or
// cut them off. Agent and system contacts are fixed parts of the topology. The
// principal manages their own addresses in the console, whose HTTP routes do not go
// through these skills.
//
// Used by contact-link-identity, contact-merge (the primary; ContactService already
// refuses a structural secondary), contact-unlink-identity and
// contact-set-identity-status.

import { isStructuralContact } from '../../contacts/contact-service.js';
import type { Contact } from '../../contacts/types.js';
import type { Logger } from '../../logger.js';

/**
 * The agent-facing refusal when `contact` is structural (isStructuralContact: a system
 * role, kind principal or agent, or tier principal), or null when it is not. `outcome`
 * says what did not happen, e.g. "Nothing was changed.".
 *
 * The message never names a contact ID. The log never carries the principal's: their
 * contact ID stays out of the model's context (spec 09), and a row that only looks like
 * the principal (kind or tier principal) is treated the same way.
 */
export function structuralContactRefusal(
  contact: Contact,
  outcome: string,
  log: Logger,
  skill: string,
): string | null {
  if (!isStructuralContact(contact)) return null;
  if (contact.systemRole === 'principal') {
    log.info({ skill }, `${skill}: refused — principal addresses are not agent-managed (#2041)`);
    return `The principal's addresses are managed by the principal, in the console. ${outcome}`;
  }
  const principalLike = contact.kind === 'principal' || contact.tier === 'principal';
  log.info(
    {
      skill,
      ...(principalLike ? {} : { contactId: contact.id }),
      systemRole: contact.systemRole,
      kind: contact.kind,
    },
    `${skill}: refused — system contact addresses are not agent-managed (#2041)`,
  );
  return `This is a system contact; its addresses are not managed by agents. ${outcome}`;
}
