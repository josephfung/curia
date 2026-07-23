// Slack channel contribution: principal identity compare only.
//
// No carveoutSkill — there is no slack-send skill yet, so Gate C fails closed
// for Slack outbound (intentional; see issue #1510 / ADR-034).

import type { PrincipalChannelRules } from '../../contacts/principal-channel-rules.js';

export const slackPrincipalRules: PrincipalChannelRules = {
  channel: 'slack',
  identifiersEqual(a, b) {
    return a === b;
  },
  // carveoutSkill omitted ⇒ no Gate C principal carve-out for Slack.
};
