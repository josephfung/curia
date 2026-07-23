// Email channel contribution: principal identity compare + email-send carve-out.

import type { PrincipalChannelRules } from '../../contacts/principal-channel-rules.js';

function hasPresentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function splitCommaSeparatedAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

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

export const emailPrincipalRules: PrincipalChannelRules = {
  channel: 'email',
  identifiersEqual(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  },
  carveoutSkill: {
    skillName: 'email-send',
    parseRecipients: parseEmailSendRecipients,
  },
};
