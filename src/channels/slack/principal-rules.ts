// Slack channel contribution: principal identity compare, outbound recipient
// projection, and slack-send Gate C carve-out.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import { hasPresentValue } from '../../contacts/principal-carveout-parse.js';
import { isSlackOutboundRequest } from './outbound-request.js';

/**
 * Parse slack-send 1:1 recipient from skill input. Returns null when the input
 * contains recipient-shaped keys this parser does not model (fail closed).
 */
function parseSlackSendRecipients(input: Record<string, unknown>): string[] | null {
  const unparsedRecipientKeys = [
    'to',
    'cc',
    'bcc',
    'recipients',
    'group_id',
    'groupId',
    'slackChannelId',
    'channel_id',
  ] as const;
  for (const key of unparsedRecipientKeys) {
    if (hasPresentValue(input[key])) return null;
  }

  const recipient = input['recipient'];
  if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') return null;
  if (!hasPresentValue(recipient)) return null;

  return [(recipient as string).trim()];
}

/**
 * Project a Slack outbound request onto its recipient identifier.
 * Trust the peer U… only — never the D…/C… conversation id.
 */
function extractSlackRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isSlackOutboundRequest(request)) return null;
  if (request.slackUserId && request.slackUserId.length > 0) {
    return [{ identifier: request.slackUserId, principalEligible: true }];
  }
  if (request.slackChannelId.length > 0) {
    return [{ identifier: request.slackChannelId, principalEligible: false }];
  }
  return [];
}

export const slackPrincipalRules: PrincipalChannelRules = {
  channel: 'slack',
  identifiersEqual(a, b) {
    return a === b;
  },
  extractRecipients: extractSlackRecipients,
  carveoutSkill: {
    skillName: 'slack-send',
    parseRecipients: parseSlackSendRecipients,
  },
};
