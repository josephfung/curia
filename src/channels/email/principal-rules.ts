// Email channel contribution: principal identity compare, outbound recipient
// projection, and email-send Gate C carve-out.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import {
  hasPresentValue,
  splitCommaSeparatedAddresses,
} from '../../contacts/principal-carveout-parse.js';
import { isEmailSendRequest } from './outbound-request.js';

/**
 * Parse email-send recipients from skill input. Returns null when the input contains
 * recipient-shaped keys this parser does not model (fail closed).
 */
function parseEmailSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = ['bcc', 'recipients', 'recipient', 'group_id', 'groupId'] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const to = input['to'];
  const cc = input['cc'];
  if (to !== undefined && to !== null && typeof to !== 'string') return null;
  if (cc !== undefined && cc !== null && typeof cc !== 'string') return null;
  if (!hasPresentValue(to) || typeof to !== 'string') return null;

  const emails = splitCommaSeparatedAddresses(to);
  if (typeof cc === 'string' && cc.trim().length > 0) {
    emails.push(...splitCommaSeparatedAddresses(cc));
  }
  return emails;
}

/**
 * Project an email outbound request onto To + CC identifiers.
 * Every address is principal-eligible (there is no email group-id analogue).
 */
function extractEmailRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isEmailSendRequest(request)) return null;
  // `isEmailSendRequest` only guards `to`/`body`; `cc` is unchecked. Reject any
  // malformed `cc` (non-array throws at the spread; a string spreads into
  // char-sized "recipients") so projection stays fail-closed (ADR-035).
  const cc = request.cc;
  if (cc !== undefined && (!Array.isArray(cc) || cc.some((r) => typeof r !== 'string'))) {
    return null;
  }
  return [request.to, ...(cc ?? [])]
    .filter((e) => e.length > 0)
    .map((identifier) => ({ identifier, principalEligible: true }));
}

export const emailPrincipalRules: PrincipalChannelRules = {
  channel: 'email',
  identifiersEqual(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  },
  extractRecipients: extractEmailRecipients,
  carveoutSkill: {
    skillName: 'email-send',
    parseRecipients: parseEmailSendRecipients,
  },
};
