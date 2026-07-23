// Signal channel contribution: principal identity compare + signal-send carve-out.

import type { PrincipalChannelRules } from '../../contacts/principal-channel-rules.js';
import { hasPresentValue } from '../../contacts/principal-carveout-parse.js';

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

export const signalPrincipalRules: PrincipalChannelRules = {
  channel: 'signal',
  identifiersEqual(a, b) {
    return a === b;
  },
  carveoutSkill: {
    skillName: 'signal-send',
    parseRecipients: parseSignalSendRecipients,
  },
};
