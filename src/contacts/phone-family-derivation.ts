// phone-family-derivation.ts — use a contact's verified number on one phone-family
// channel for another (#2447, ADR-047).
//
// A number verified as a contact's `phone` is the same number on `sms` and `signal`.
// When an agent needs it on a sibling channel, the provenance check (#2061) has
// nothing to protect: the number exactly matches a verified identity already on the
// contact, so it cannot be mistyped or invented. The rule here writes a real identity
// row for the sibling channel, recorded as `derived` with the id of the row it came
// from. A real row matters: inbound matching is exact-channel, so a reply from the
// number resolves to this contact only if the row exists.
//
// Two entry points share this rule: contact-link-identity (an unsourced number that
// matches one on the contact) and the send skills' recipient resolver (no usable
// identity on the skill's channel).
//
// Structural contacts never derive, the principal included: the principal's sms and
// signal identities feed Gate C and principal recognition on spoofable SMS (ADR-036),
// so they stay explicit, principal-managed links.

import { isStructuralContact, type ContactService } from './contact-service.js';
import { PHONE_CHANNELS, phoneDigits, sameIdentifier } from './identifier-near-miss.js';
import type { ChannelIdentity, Contact, DuplicateCheck } from './types.js';

/** The identity source a derived row is recorded with. */
export const DERIVED_IDENTITY_SOURCE = 'derived' as const;

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The identities on `contact` that `channel` may derive from, oldest first, one per
 * number. Empty when the rule does not apply:
 * - `channel` is not a phone-family channel;
 * - the contact is structural (the principal, an agent, a system contact);
 * - no sibling-channel identity is verified, active and E.164 (a Signal ACI-UUID row
 *   has no number; sms_participant and self_claimed rows are unverified).
 *
 * A number that already has a row on `channel` is skipped whatever that row's state:
 * a verified active row is used directly, and an unverified or inactive one is a
 * decision someone else made, not one a derivation overrides.
 *
 * `identifier`, when given, keeps only sources holding that number.
 */
export function derivationSources(
  contact: Contact,
  identities: readonly ChannelIdentity[],
  channel: string,
  identifier?: string,
): ChannelIdentity[] {
  if (!PHONE_CHANNELS.has(channel) || isStructuralContact(contact)) return [];
  const onChannel = identities.filter((identity) => identity.channel === channel);
  const seen = new Set<string>();
  return identities
    .filter((identity) =>
      identity.channel !== channel
      && PHONE_CHANNELS.has(identity.channel)
      && identity.verified
      && identity.status === 'active'
      && E164.test(identity.channelIdentifier)
      && (identifier === undefined || sameIdentifier(channel, identity.channelIdentifier, identifier))
      && !onChannel.some((held) => sameIdentifier(channel, held.channelIdentifier, identity.channelIdentifier)))
    // Stable sort: rows with the same timestamp keep the backend's order.
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .filter((identity) => {
      const digits = phoneDigits(identity.channelIdentifier);
      if (seen.has(digits)) return false;
      seen.add(digits);
      return true;
    });
}

export type DerivationResult =
  | { ok: true; identity: ChannelIdentity }
  /**
   * The duplicate check stopped the write. `check` holds what stopped it: another
   * contact with the number on this channel (`taken`), or with it on a sibling
   * channel and not accepted by `isDistinct` (`candidates`).
   */
  | { ok: false; check: DuplicateCheck };

/**
 * Write the derived row for `source` on `channel`. The caller has chosen `source` from
 * derivationSources. The duplicate check still runs: another contact holding the number
 * on this channel refuses the write, and one holding it on a sibling channel is a
 * candidate until `isDistinct` accepts it (the agent named it in distinct_from). A similar number
 * on another contact is not a candidate here: this number is an exact copy of a
 * verified one, so it cannot be a typo of theirs.
 *
 * The row is verified (the number belongs to this contact, whatever the channel) and
 * keeps the source's label unless `label` is given. Errors propagate: callers refuse rather than skip the check.
 */
export async function deriveIdentity(
  contactService: Pick<ContactService, 'findLikelyDuplicates' | 'linkIdentity'>,
  target: {
    contact: Contact;
    channel: string;
    source: ChannelIdentity;
    isDistinct?: (candidate: Contact) => boolean;
    /** Stored instead of the source's label (contact-link-identity's `label`). */
    label?: string;
  },
): Promise<DerivationResult> {
  const { contact, channel, source } = target;
  const check = await contactService.findLikelyDuplicates({
    identities: [{ channel, identifier: source.channelIdentifier }],
    excludeContactId: contact.id,
  });
  const isDistinct = target.isDistinct ?? ((): boolean => false);
  const candidates = check.candidates
    .map((candidate) => ({
      ...candidate,
      reasons: candidate.reasons.filter((reason) => reason.kind === 'same_number'),
    }))
    .filter((candidate) => candidate.reasons.length > 0 && !isDistinct(candidate.contact));
  if (check.taken.length > 0 || candidates.length > 0) {
    return { ok: false, check: { taken: check.taken, candidates } };
  }

  const label = target.label ?? source.label ?? undefined;
  const identity = await contactService.linkIdentity({
    contactId: contact.id,
    channel,
    channelIdentifier: source.channelIdentifier,
    ...(label ? { label } : {}),
    source: DERIVED_IDENTITY_SOURCE,
    verified: true,
    derivedFromIdentityId: source.id,
  });
  return { ok: true, identity };
}
