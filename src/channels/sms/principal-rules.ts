// SMS channel contribution: principal identity compare, outbound recipient
// projection, and sms-send Gate C carve-out.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import { hasPresentValue } from '../../contacts/principal-carveout-parse.js';
import { isSmsOutboundRequest } from './outbound-request.js';

/**
 * Parse sms-send 1:1 recipient from skill input. Returns null when the input
 * contains recipient-shaped keys this parser does not model (fail closed).
 */
function parseSmsSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = ['to', 'cc', 'bcc', 'recipients', 'group_id', 'groupId'] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const recipient = input['recipient'];
  if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') return null;
  if (!hasPresentValue(recipient)) return null;

  return [(recipient as string).trim()];
}

/**
 * Project an SMS outbound request onto its recipient identifier.
 * The peer E.164 is principal-eligible (1:1 only in v1).
 */
function extractSmsRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isSmsOutboundRequest(request)) return null;
  if (request.recipient.length > 0) {
    return [{ identifier: request.recipient, principalEligible: true }];
  }
  return [];
}

export const smsPrincipalRules: PrincipalChannelRules = {
  channel: 'sms',
  identifiersEqual(a, b) {
    return a === b;
  },
  extractRecipients: extractSmsRecipients,
  carveoutSkill: {
    skillName: 'sms-send',
    parseRecipients: parseSmsSendRecipients,
  },
};
