// Signal channel contribution: principal identity compare, outbound recipient
// projection, and signal-send Gate C carve-out.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import { hasPresentValue } from '../../contacts/principal-carveout-parse.js';
import { isSignalOutboundRequest } from './outbound-request.js';

/**
 * Parse signal-send 1:1 recipient from skill input. Returns null for group sends or
 * when the input contains recipient-shaped keys this parser does not model.
 */
function parseSignalSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = ['to', 'cc', 'bcc', 'recipients'] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const recipient = input['recipient'];
  const groupId = input['group_id'] ?? input['groupId'];
  if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') return null;
  if (hasPresentValue(groupId)) return null;
  if (!hasPresentValue(recipient)) return null;

  return [(recipient as string).trim()];
}

/**
 * Project a Signal outbound request onto its recipient identifier.
 * 1:1 `recipient` is principal-eligible; `groupId` is never (other members present).
 */
function extractSignalRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isSignalOutboundRequest(request)) return null;
  if (request.recipient && request.recipient.length > 0) {
    return [{ identifier: request.recipient, principalEligible: true }];
  }
  if (request.groupId && request.groupId.length > 0) {
    return [{ identifier: request.groupId, principalEligible: false }];
  }
  return [];
}

export const signalPrincipalRules: PrincipalChannelRules = {
  channel: 'signal',
  identifiersEqual(a, b) {
    return a === b;
  },
  extractRecipients: extractSignalRecipients,
  carveoutSkill: {
    skillName: 'signal-send',
    parseRecipients: parseSignalSendRecipients,
  },
};
