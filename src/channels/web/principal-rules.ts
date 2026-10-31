// Web channel contribution. The phone app reaches only the principal.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import { hasPresentValue, parseOneRecipient } from '../../contacts/principal-carveout-parse.js';
import { isWebOutboundRequest } from './outbound-request.js';

function parseWebSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsed = ['to', 'cc', 'bcc', 'recipients', 'group_id', 'groupId', 'recipient_number'] as const;
  for (const key of unparsed) {
    if (hasPresentValue(input[key])) return null;
  }
  const parsed = parseOneRecipient(input);
  if (!parsed) return null;
  if (parsed.some((recipient) => recipient !== 'principal')) return null;
  return parsed;
}

function extractWebRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isWebOutboundRequest(request)) return null;
  return [{ identifier: 'principal', principalEligible: true }];
}

export const webPrincipalRules: PrincipalChannelRules = {
  channel: 'web',
  identifiersEqual(a, b) {
    return a === 'principal' && b === 'principal';
  },
  extractRecipients: extractWebRecipients,
  carveoutSkill: {
    skillName: 'web-send',
    parseRecipients: parseWebSendRecipients,
  },
};
