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

/**
 * The parts of a task's metadata that isOneToOneAudience reads (emailReplyAudienceIsPrivate:
 * `curiaRole`, `primaryRecipientEmails`, and each participant's `email` and `role`), copied, or
 * null when none is present. A task re-run for a root (a hand-off recovery, #2588) carries this
 * so its audience is judged by the same rule on the same inputs as the root's. A copy, not the
 * channel's objects: nothing else in the metadata rides along. A field of a shape the rule
 * rejects (a non-string role, a non-array list) is left out, which the rule rejects the same way.
 */
export function audienceMetadataOf(metadata: Readonly<Record<string, unknown>> | null | undefined): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  const role = metadata['curiaRole'];
  if (typeof role === 'string') out['curiaRole'] = role;
  const recipients = metadata['primaryRecipientEmails'];
  // The rule reads only the list's length; strings are kept, anything else as null.
  if (Array.isArray(recipients)) out['primaryRecipientEmails'] = (recipients as unknown[]).map((r) => (typeof r === 'string' ? r : null));
  const participants = metadata['participants'];
  if (Array.isArray(participants)) {
    out['participants'] = (participants as unknown[]).map((p) => {
      // Only email and role are read. A primitive is kept as is: the rule rejects it.
      if (p === null || p === undefined || typeof p !== 'object') return p;
      const { email, role: participantRole } = p as { email?: unknown; role?: unknown };
      return { email, role: participantRole };
    });
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** audienceMetadataOf, frozen all the way down, for a registry snapshot. */
export function frozenAudienceMetadataOf(metadata: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | null {
  const copy = audienceMetadataOf(metadata);
  if (!copy) return null;
  for (const value of Object.values(copy)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && typeof item === 'object') Object.freeze(item);
      Object.freeze(value);
    }
  }
  return Object.freeze(copy);
}
