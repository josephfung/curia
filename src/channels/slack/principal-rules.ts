// Slack channel contribution: principal identity compare + outbound recipient
// projection.
//
// No carveoutSkill — there is no slack-send skill yet, so Gate C fails closed
// for Slack outbound (intentional; see issue #1510 / ADR-034).

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
} from '../../contacts/principal-channel-rules.js';
import { isSlackOutboundRequest } from './outbound-request.js';

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
  // carveoutSkill omitted ⇒ no Gate C principal carve-out for Slack.
};
