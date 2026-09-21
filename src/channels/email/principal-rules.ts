// Email channel contribution: principal identity compare, outbound recipient
// projection, and email-send / email-reply Gate C carve-out.

import type {
  PrincipalChannelRules,
  ProjectedRecipient,
  SkillRecipientResolveDeps,
} from '../../contacts/principal-channel-rules.js';
import {
  hasPresentValue,
  splitCommaSeparatedAddresses,
} from '../../contacts/principal-carveout-parse.js';
import { isEmailSendRequest } from './outbound-request.js';
import { emailAccountIdFromInput } from './account-id.js';
import { deriveEmailReplyRecipientSet } from './reply-recipients.js';
import {
  looksLikeOutboundContextEntryId,
  replyToMessageIdLooksLikeEntryIdError,
} from './nylas-message-id.js';

/** Thrown when reply_to_message_id is an outbound_context entry UUID (#1817). */
export class ReplyToMessageIdShapeError extends Error {
  constructor(message = replyToMessageIdLooksLikeEntryIdError()) {
    super(message);
    this.name = 'ReplyToMessageIdShapeError';
  }
}

const EMAIL_REPLY_UNPARSED_RECIPIENT_KEYS = [
  'to',
  'bcc',
  'recipients',
  'recipient',
  'group_id',
  'groupId',
] as const;

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

/**
 * Sync parser for email-reply. Recipients live on the original message, not in
 * the skill input, so this always returns null. Unmodeled recipient-shaped keys
 * also fail closed. Gate C must call `resolveEmailReplyRecipients`.
 */
function parseEmailReplyRecipients(input: Record<string, unknown>): string[] | null {
  for (const key of EMAIL_REPLY_UNPARSED_RECIPIENT_KEYS) {
    if (hasPresentValue(input[key])) return null;
  }
  return null;
}

/**
 * Fetch the original message and derive To+CC the same way the email-reply
 * handler will send. Returns null on missing id, gateway error, or unmodeled
 * input (fail closed).
 */
export async function resolveEmailReplyRecipients(
  input: Record<string, unknown>,
  deps: SkillRecipientResolveDeps,
): Promise<string[] | null> {
  for (const key of EMAIL_REPLY_UNPARSED_RECIPIENT_KEYS) {
    if (hasPresentValue(input[key])) return null;
  }

  const messageId = input['reply_to_message_id'];
  if (typeof messageId !== 'string' || messageId.trim().length === 0) return null;
  // Reject before any Nylas fetch (#1817): an outbound_context entry_id UUID is
  // not a message id. Throw so Gate C can surface the actionable error instead
  // of a generic escalate-after-404.
  if (looksLikeOutboundContextEntryId(messageId)) {
    throw new ReplyToMessageIdShapeError();
  }
  const ccInput = input['cc'];
  if (ccInput !== undefined && typeof ccInput !== 'string') {
    return null;
  }
  if (!deps.fetchMessage) return null;

  // Same account the email-reply handler will pass to getEmailMessage.
  // Passing a different id (or omitting one the handler sends) splits the
  // per-invoke fetch cache (#1832).
  const accountId = emailAccountIdFromInput(input);
  const original = accountId === undefined
    ? await deps.fetchMessage(messageId.trim())
    : await deps.fetchMessage(messageId.trim(), accountId);

  const set = deriveEmailReplyRecipientSet({
    originalFrom: original.from[0]?.email,
    originalTo: original.to,
    originalCc: original.cc,
    ccInput,
    selfEmails: deps.selfEmails,
  });
  if (!set) return null;
  return [set.to, ...set.cc];
}

/**
 * Project an email outbound request onto To + CC identifiers.
 * Every address is principal-eligible (there is no email group-id analogue).
 */
function extractEmailRecipients(request: unknown): ProjectedRecipient[] | null {
  if (!isEmailSendRequest(request)) return null;
  // `isEmailSendRequest` only guards `to`/`body`; `cc` is unchecked. Reject any
  // malformed `cc` (non-array throws at the spread; a string spreads into
  // char-sized "recipients") so projection stays fail-closed (ADR-035).
  const cc = request.cc;
  if (cc !== undefined && (!Array.isArray(cc) || cc.some((r) => typeof r !== 'string'))) {
    return null;
  }
  return [request.to, ...(cc ?? [])]
    .filter((e) => e.length > 0)
    .map((identifier) => ({ identifier, principalEligible: true }));
}

export const emailPrincipalRules: PrincipalChannelRules = {
  channel: 'email',
  identifiersEqual(a, b) {
    return a.toLowerCase() === b.toLowerCase();
  },
  extractRecipients: extractEmailRecipients,
  carveoutSkill: {
    skillName: 'email-send',
    parseRecipients: parseEmailSendRecipients,
  },
  carveoutSkills: [
    {
      skillName: 'email-reply',
      parseRecipients: parseEmailReplyRecipients,
      resolveRecipients: resolveEmailReplyRecipients,
    },
  ],
};
