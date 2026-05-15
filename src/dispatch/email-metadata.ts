// src/dispatch/email-metadata.ts
//
// Pure functions for parsing email-channel metadata and building the preamble
// blocks that the dispatcher prepends to inbound task content.
//
// No dependencies on the bus, runtime, database, or logger — all functions
// are pure and unit-testable in isolation. The dispatcher calls
// parseEmailMetadata once at the top of its email-handling section, then
// passes the typed struct to the preamble builders rather than repeating the
// raw Record<string, unknown> cast.

// Maximum participants to include in the thread-participants block.
// Prevents runaway loops on unusually large mailing-list threads.
const MAX_PARTICIPANTS = 15;

// Maximum recipient addresses to show in the CC preamble before truncating.
// RFC 5321 allows long To-fields; this cap keeps the preamble readable.
const MAX_RECIPIENTS_IN_PREAMBLE = 10;

/**
 * Typed view of email-specific fields inside InboundMessagePayload.metadata.
 *
 * Fields are typed to reflect what parseEmailMetadata can safely infer from
 * the raw Record<string, unknown> boundary. Array elements remain `unknown`
 * until individually validated inside the consumer functions, since casting
 * them as a typed array at the boundary would be a silent lie.
 */
export interface EmailMetadata {
  /** 'cc' when Curia was CC'd rather than directly addressed; undefined otherwise. */
  curiaRole: string | undefined;
  /** Validated array of primary recipient addresses; empty if absent or non-array in raw metadata. */
  primaryRecipientEmails: unknown[];
  /** Raw Nylas message ID — validate and sanitize via sanitizeNylasMessageId before use. */
  nylasMessageId: unknown;
  /** Validated array of raw participant entries; empty if absent or non-array. Elements
   *  are unknown — structural validation happens inside buildThreadParticipantsBlock. */
  participants: unknown[];
}

/**
 * Parse email-specific fields from the raw InboundMessagePayload.metadata bag.
 *
 * Validates presence and type at the collection level (string check for
 * curiaRole, Array.isArray guards for the array fields). Individual element
 * validation happens inside the consumer functions where the values are used.
 */
export function parseEmailMetadata(metadata: Record<string, unknown> | undefined): EmailMetadata {
  const raw = metadata;
  return {
    curiaRole: typeof raw?.curiaRole === 'string' ? raw.curiaRole : undefined,
    primaryRecipientEmails: Array.isArray(raw?.primaryRecipientEmails)
      ? (raw.primaryRecipientEmails as unknown[])
      : [],
    nylasMessageId: raw?.nylasMessageId,
    participants: Array.isArray(raw?.participants)
      ? (raw.participants as unknown[])
      : [],
  };
}

/** Result of sanitizeNylasMessageId — discriminated so callers can log the
 *  specific failure reason without adding a logger dependency to this module. */
export type NylasMessageIdResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'empty-after-sanitize' | 'absent-or-invalid' };

/**
 * Sanitize a raw Nylas message ID for safe interpolation into preamble content.
 *
 * Strips characters that could enable prompt injection (`\n`, `\r`, `[`, `]`,
 * `<`, `>`), trims whitespace, and caps the result at 200 characters (Nylas
 * IDs are short; anything longer is structurally suspicious).
 *
 * Returns a discriminated result so the caller (the dispatcher) can emit the
 * correct log message for each failure case without logging side effects here.
 */
export function sanitizeNylasMessageId(raw: unknown): NylasMessageIdResult {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const sanitized = raw.replace(/[\n\r\[\]<>]/g, '').trim().slice(0, 200);
    if (sanitized.length === 0) {
      // Non-empty raw value collapsed to empty after sanitization — structurally
      // suspicious (e.g. composed entirely of stripped characters).
      return { ok: false, reason: 'empty-after-sanitize' };
    }
    return { ok: true, value: sanitized };
  }
  return { ok: false, reason: 'absent-or-invalid' };
}

/**
 * Sanitize a single email field value before interpolation into preamble content.
 *
 * Strips the same prompt-injection characters as sanitizeNylasMessageId and
 * enforces a maximum length. RFC 5321 caps email addresses at 254 characters.
 * Returns an empty string for null/undefined so callers' downstream empty-string
 * filters discard the value rather than interpolating the literal "null".
 */
function sanitizeEmailField(raw: unknown, maxLen = 254): string {
  if (raw == null) return '';
  return String(raw).replace(/[\n\r\[\]<>]/g, '').trim().slice(0, maxLen);
}

/**
 * Build the CC role preamble prepended to inbound task content when Curia was
 * CC'd (not directly addressed) on an email.
 *
 * The preamble tells the coordinator which account it was CC'd on and provides
 * the Nylas message ID so it can call email-reply to thread a response from
 * Curia's own account. Without the message ID the coordinator falls back to
 * email-draft-save, where it has historically chosen the wrong account (CEO's).
 *
 * @param meta            Parsed email metadata from parseEmailMetadata.
 * @param accountId       The named Nylas account (e.g. "curia"); falls back to 'curia'.
 * @param nylasMessageId  Pre-sanitized message ID from sanitizeNylasMessageId,
 *                        or undefined if absent/sanitized-to-empty.
 */
export function buildCcPreamble(
  meta: EmailMetadata,
  accountId: string | undefined,
  nylasMessageId: string | undefined,
): string {
  // Sanitize each address before interpolation — primaryRecipientEmails comes
  // from the Nylas To-field (attacker-controlled) and is injected into
  // taskContent after the injection scanner has already run on payload.content.
  // Without sanitization a crafted address could bypass Layer 1.
  const sanitizedRecipients = meta.primaryRecipientEmails
    .map((addr) => sanitizeEmailField(addr))
    .filter((addr) => addr.length > 0)
    .slice(0, MAX_RECIPIENTS_IN_PREAMBLE);

  // Count items dropped by the empty-string filter or by the 10-item cap.
  const omittedCount = Math.max(0, meta.primaryRecipientEmails.length - sanitizedRecipients.length);

  // Only append "+N more" when there are named recipients to precede it —
  // "unknown recipients, +3 more" is misleading when every address was stripped.
  const recipientList = sanitizedRecipients.length > 0
    ? (omittedCount > 0
        ? `${sanitizedRecipients.join(', ')}, +${omittedCount} more`
        : sanitizedRecipients.join(', '))
    : 'unknown recipients';

  // Include Message ID and Account so the coordinator can call email-reply
  // with the correct thread context. Without these identifiers it cannot use
  // email-reply and falls back to email-draft-save.
  const identifierBlock = nylasMessageId
    ? `Message ID: ${nylasMessageId}\nAccount: ${accountId ?? 'curia'}\n\n`
    : `Account: ${accountId ?? 'curia'}\n\n`;

  return (
    `[OWNER CC — this email was addressed to ${recipientList}; you were CC'd, not the primary recipient]\n` +
    identifierBlock
  );
}

/**
 * Build the thread-participants block prepended to inbound task content for
 * every inbound email so the coordinator can reason about who is on the thread.
 *
 * Returns null when the participants list is absent, empty, or all entries are
 * invalid (null email, empty after sanitization, or unknown role) — the caller
 * should skip prepending in that case.
 *
 * @param meta       Parsed email metadata from parseEmailMetadata.
 * @param selfEmail  Curia's own email address for the receiving account, if
 *                   known. Matching participants are displayed as "you".
 */
export function buildThreadParticipantsBlock(
  meta: EmailMetadata,
  selfEmail: string | undefined,
): string | null {
  if (meta.participants.length === 0) return null;

  const selfLower = selfEmail?.toLowerCase();
  const froms: string[] = [];
  const tos: string[] = [];
  const ccs: string[] = [];

  for (const raw of meta.participants.slice(0, MAX_PARTICIPANTS)) {
    // Guard against null/undefined elements and non-object entries — Nylas
    // API responses can include nulls during partial failures or schema drift.
    if (raw == null || typeof raw !== 'object') continue;
    const p = raw as { email: unknown; role: unknown };
    if (p.email == null) continue; // guard: skip participants with missing email field
    // Sanitize participant email addresses — they come from Nylas (attacker-controlled)
    // and are injected into taskContent after the injection scanner has run on
    // payload.content. Strip characters that could enable prompt injection.
    const addr = sanitizeEmailField(p.email);
    if (!addr) continue;
    // Replace Curia's own address with "you" for readability.
    const display = selfLower && addr.toLowerCase() === selfLower ? 'you' : addr;
    const role = typeof p.role === 'string' ? p.role : '';
    if (role === 'from') froms.push(display);
    else if (role === 'to') tos.push(display);
    else if (role === 'cc') ccs.push(display);
  }

  const parts: string[] = [];
  if (froms.length > 0) parts.push(`From: ${froms.join(', ')}`);
  if (tos.length > 0) parts.push(`To: ${tos.join(', ')}`);
  if (ccs.length > 0) parts.push(`CC: ${ccs.join(', ')}`);

  if (parts.length === 0) return null;

  return `[Thread participants — ${parts.join('; ')}]\n`;
}
