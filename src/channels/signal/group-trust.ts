// src/channels/signal/group-trust.ts
//
// Shared trust-checking logic for Signal group conversations.
//
// Signal's identity anchor is the phone number — cryptographically bound via SIM
// + E2E encryption. Display names are entirely user-defined and carry no trust weight.
//
// A group is trusted iff every member's phone number resolves to a verified
// (non-provisional, non-blocked) contact. A single unknown or blocked member renders
// the entire group untrusted. This is intentionally conservative: a CEO assistant
// participating in a group with unknown parties risks leaking context or being
// manipulated by social engineering.
//
// Callers are responsible for excluding Curia's own phone number from the list
// before calling — the gateway does this (getSignalGroupMembers) and the adapter
// does it inline.
//
// Used by:
//   - SignalAdapter (inbound): gates whether a group message is published to the bus
//   - signal-send handler (outbound): gates whether a proactive group send proceeds

import type { ContactService } from '../../contacts/contact-service.js';

export interface GroupTrustResult {
  /** True iff all members are verified (non-provisional, non-blocked) contacts. */
  trusted: boolean;
  /** E.164 numbers with no contact record or with provisional status. */
  unknownMembers: string[];
  /** E.164 numbers of explicitly blocked contacts. */
  blockedMembers: string[];
}

/**
 * Check the trust level of a set of Signal group member phone numbers.
 *
 * Each phone is resolved against the contact system:
 *   - null contact or status 'provisional' → unknownMember
 *   - status 'blocked'                     → blockedMember
 *   - status 'confirmed' (any non-provisional, non-blocked status) → trusted
 *
 * @param memberPhones - E.164 numbers of group members (own account already excluded)
 * @param contactService - ContactService for resolving phone numbers to contacts
 */
export async function checkGroupMemberTrust(
  memberPhones: string[],
  contactService: ContactService,
): Promise<GroupTrustResult> {
  const unknownMembers: string[] = [];
  const blockedMembers: string[] = [];

  for (const phone of memberPhones) {
    const contact = await contactService.resolveByChannelIdentity('signal', phone);
    if (!contact || contact.status === 'provisional') {
      unknownMembers.push(phone);
    } else if (contact.status === 'blocked') {
      blockedMembers.push(phone);
    }
    // confirmed / any other non-provisional, non-blocked status → trusted
  }

  return {
    trusted: unknownMembers.length === 0 && blockedMembers.length === 0,
    unknownMembers,
    blockedMembers,
  };
}
