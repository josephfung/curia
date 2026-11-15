// One-to-one audience check (#2588). A hand-off may only pass a person's words into a
// conversation that is one-to-one with that same person, so a privately sent correction is
// never quoted into a thread with others. Fail-closed: anything unrecognised is not one-to-one.

import { parseSlackConversationId } from '../channels/slack/message-converter.js';
import { emailReplyAudienceIsPrivate } from '../memory/contact-recent-history.js';

const SIGNAL_GROUP_PREFIX = 'signal:group=';

export function isOneToOneAudience(
  channelId: string,
  conversationId: string,
  metadata: Record<string, unknown> | undefined,
  selfEmails: readonly string[],
): boolean {
  switch (channelId) {
    case 'signal':
      return conversationId.startsWith('signal:') && !conversationId.startsWith(SIGNAL_GROUP_PREFIX);
    case 'slack':
      return parseSlackConversationId(conversationId)?.isDm === true;
    case 'sms':
      return true;
    // Principal-only surfaces: the web app needs the principal's bootstrap secret or session
    // (routes/chat.ts), the CLI is a local shell, and contact-resolver.ts resolves both to the
    // principal whatever the sender. No one else can be in these conversations.
    case 'web':
    case 'cli':
      return true;
    case 'email':
      // Same strict rule as contact recall: a two-party from/to thread with an owned mailbox.
      return emailReplyAudienceIsPrivate(metadata, selfEmails);
    default:
      return false;
  }
}
