// approval-notification.ts — shared body construction for CEO approval alerts.
//
// Used by ApprovalTriggerService and OutboundGateway so the two notification
// paths cannot drift. Detail rendering is gated on the notification recipient
// meeting principal tier (issue #1300).
//
// OutboundGateway may pass incomplete partialPayload at gate time (e.g. send-draft
// before draft_id is linked). Call enrichGatewayApprovalPayload() with the live
// send request so recipient/content fields are available in the notification.

import type { ContactService } from '../contacts/contact-service.js';
import type { Logger } from '../logger.js';
import { meetsMinimumTier, type ContactTier } from '../contacts/types.js';
import { sanitizeOutput } from '../skills/sanitize.js';

// ---------------------------------------------------------------------------
// Constants — exported for tests
// ---------------------------------------------------------------------------

export const MAX_DETAIL_FIELD_LENGTH = 500;
export const MAX_DETAIL_TOTAL_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Field allowlists — extend alongside VERB_RULES in approval-trigger.ts
// ---------------------------------------------------------------------------

type DetailFieldSpec = { key: string; label: string };

const SKILL_DETAIL_FIELDS: Array<{ test: (name: string) => boolean; fields: DetailFieldSpec[] }> = [
  {
    test: (n) => n.startsWith('signal-'),
    fields: [
      { key: 'recipient', label: 'To' },
      { key: 'group_id', label: 'Group' },
      { key: 'message', label: 'Message' },
    ],
  },
  {
    test: (n) => n === 'email-reply',
    fields: [
      { key: 'reply_to_message_id', label: 'Reply to' },
      { key: 'cc', label: 'Cc' },
      { key: 'body', label: 'Message' },
    ],
  },
  {
    test: (n) => n === 'email-draft-save',
    fields: [
      { key: 'to', label: 'To' },
      { key: 'subject', label: 'Subject' },
      { key: 'body', label: 'Body' },
    ],
  },
  {
    test: (n) => n === 'send-draft',
    fields: [
      { key: 'draft_id', label: 'Draft' },
      // partialPayload at gate time may omit draft_id; merge live send fields below.
      { key: 'to', label: 'To' },
      { key: 'subject', label: 'Subject' },
      { key: 'body', label: 'Body' },
    ],
  },
  {
    test: (n) => n.startsWith('calendar-'),
    fields: [
      { key: 'title', label: 'Title' },
      { key: 'start', label: 'Start' },
      { key: 'end', label: 'End' },
      { key: 'attendees', label: 'Attendees' },
      { key: 'description', label: 'Description' },
      { key: 'location', label: 'Location' },
    ],
  },
  {
    test: (n) => n === 'store-fact',
    fields: [
      { key: 'label', label: 'Label' },
      { key: 'value', label: 'Value' },
    ],
  },
  {
    test: (n) => n.startsWith('schedule-'),
    fields: [
      { key: 'name', label: 'Job' },
      { key: 'when', label: 'When' },
      { key: 'description', label: 'Description' },
    ],
  },
];

const GENERIC_DETAIL_FIELDS: DetailFieldSpec[] = [
  { key: 'to', label: 'To' },
  { key: 'recipient', label: 'To' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'subject', label: 'Subject' },
  { key: 'title', label: 'Title' },
  { key: 'body', label: 'Body' },
  { key: 'message', label: 'Message' },
  { key: 'text', label: 'Text' },
  { key: 'content', label: 'Content' },
  { key: 'description', label: 'Description' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End' },
  { key: 'when', label: 'When' },
  { key: 'attendees', label: 'Attendees' },
  { key: 'name', label: 'Name' },
  { key: 'query', label: 'Query' },
  { key: 'label', label: 'Label' },
];

/** Representative payloads for allowlisted skills — used by tests to catch silent misses. */
export const SKILL_DETAIL_FIXTURES: Array<{
  skillName: string;
  payload: Record<string, unknown>;
}> = [
  {
    skillName: 'signal-send',
    payload: { recipient: '+15550142', message: 'Confirming Thursday at 3pm.' },
  },
  {
    skillName: 'email-reply',
    payload: { reply_to_message_id: 'msg-abc', body: 'Thanks — Thursday works.' },
  },
  {
    skillName: 'email-draft-save',
    payload: { to: 'dana@example.com', subject: 'Re: Budget', body: 'Draft body text.' },
  },
  {
    skillName: 'send-draft',
    payload: { to: 'dana@example.com', subject: 'Re: Budget', body: 'Approved send body.' },
  },
  {
    skillName: 'calendar-create-event',
    payload: {
      title: 'Board sync',
      start: '2026-07-02T15:00:00Z',
      end: '2026-07-02T16:00:00Z',
    },
  },
  {
    skillName: 'store-fact',
    payload: { label: 'Dana prefers mornings', value: 'true' },
  },
  {
    skillName: 'scheduler-create',
    payload: { name: 'nightly-sweep', when: '2026-07-03T02:00:00Z' },
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const parts = value
      .map((item) => {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          return trimmed || null;
        }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const email = typeof obj.email === 'string' ? obj.email : undefined;
          const name =
            typeof obj.name === 'string'
              ? obj.name
              : typeof obj.displayName === 'string'
                ? obj.displayName
                : undefined;
          if (name && email) return `${name} (${email})`;
          if (email) return email;
          if (name) return name;
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(', ') : null;
  }
  // Skip plain objects — avoid leaking internal JSON shape into CEO notifications.
  return null;
}

function fieldSpecsForSkill(skillName: string): DetailFieldSpec[] {
  for (const rule of SKILL_DETAIL_FIELDS) {
    if (rule.test(skillName)) return rule.fields;
  }
  return GENERIC_DETAIL_FIELDS;
}

/**
 * Merge live outbound-send fields into a partial gate-time payload.
 * partialPayload wins when a key is already set (e.g. draft_id linked later).
 */
export function enrichGatewayApprovalPayload(
  partialPayload: Record<string, unknown>,
  sendFields: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...partialPayload };
  for (const [key, value] of Object.entries(sendFields)) {
    if (merged[key] !== undefined) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim().length === 0) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Render a labeled detail block from a pending-action payload.
 * Values pass through sanitizeOutput; per-field and total length caps apply.
 */
export function buildApprovalDetails(
  skillName: string,
  payload: Record<string, unknown>,
): string {
  const specs = fieldSpecsForSkill(skillName);
  const seenLabels = new Set<string>();
  const lines: string[] = [];
  let totalLength = 0;

  for (const { key, label } of specs) {
    if (seenLabels.has(label)) continue;
    const raw = formatFieldValue(payload[key]);
    if (!raw) continue;

    const sanitized = sanitizeOutput(raw, { maxLength: MAX_DETAIL_FIELD_LENGTH });
    const line = `${label}: ${sanitized}`;
    if (totalLength + line.length > MAX_DETAIL_TOTAL_LENGTH) {
      const remaining = MAX_DETAIL_TOTAL_LENGTH - totalLength;
      if (remaining <= label.length + 2) break;
      lines.push(sanitizeOutput(line, { maxLength: remaining }));
      break;
    }
    lines.push(line);
    totalLength += line.length + 1;
    seenLabels.add(label);
  }

  return lines.join('\n');
}

export interface BuildApprovalNotificationBodyOpts {
  /** Opening paragraph — gate reason or short description. */
  preamble: string;
  shortRef: string;
  expiresAt: Date;
  skillName: string;
  payload: Record<string, unknown>;
  /** When absent or below principal tier, detail block is omitted. */
  recipientTier: ContactTier | null;
  /** Optional lines between preamble and reference block (e.g. autonomy score). */
  extraLines?: string[];
  callToAction?: string;
  /** When set, logs a warn if the detail block is omitted or empty. */
  logger?: Logger;
  /** Included in omission warnings for correlation. */
  ceoEmail?: string;
}

function logDetailOmission(
  logger: Logger | undefined,
  reason: string,
  context: Record<string, unknown>,
): void {
  logger?.warn(context, `approval notification: detail block omitted — ${reason}`);
}

/**
 * Build the full CEO approval notification body. Detail is included only when
 * the recipient meets principal tier — defense-in-depth if the channel is repointed.
 */
export function buildApprovalNotificationBody(opts: BuildApprovalNotificationBodyOpts): string {
  const lines: string[] = [opts.preamble, ''];

  if (opts.extraLines && opts.extraLines.length > 0) {
    lines.push(...opts.extraLines, '');
  }

  const includeDetail = Boolean(
    opts.recipientTier && meetsMinimumTier(opts.recipientTier, 'principal'),
  );

  if (includeDetail) {
    const details = buildApprovalDetails(opts.skillName, opts.payload);
    if (details) {
      lines.push(details, '');
    } else {
      logDetailOmission(opts.logger, 'no renderable fields in payload', {
        skillName: opts.skillName,
        ceoEmail: opts.ceoEmail,
        payloadKeys: Object.keys(opts.payload),
      });
    }
  } else if (opts.ceoEmail) {
    logDetailOmission(opts.logger, 'recipient tier below principal or unresolved', {
      skillName: opts.skillName,
      ceoEmail: opts.ceoEmail,
      recipientTier: opts.recipientTier,
    });
  }

  lines.push(
    `Reference: ${opts.shortRef}`,
    `Expires: ${opts.expiresAt.toISOString()}`,
    '',
    opts.callToAction ?? 'Reply to approve, deny, or dismiss this request.',
  );

  return lines.join('\n');
}

/**
 * Resolve the notification recipient's tier via the contacts service.
 * Returns null when lookup is unavailable — callers treat that as "omit detail".
 */
export async function resolveNotificationRecipientTier(
  contactService: ContactService | undefined,
  ceoEmail: string,
  logger?: Logger,
): Promise<ContactTier | null> {
  if (!ceoEmail) return null;
  if (!contactService) {
    logDetailOmission(logger, 'contactService not configured', { ceoEmail });
    return null;
  }
  try {
    const resolved = await contactService.resolveByChannelIdentity('email', ceoEmail);
    if (!resolved?.tier) {
      logDetailOmission(logger, 'recipient not found in contacts', { ceoEmail });
      return null;
    }
    return resolved.tier;
  } catch (err) {
    logDetailOmission(logger, 'tier lookup failed', { err, ceoEmail });
    return null;
  }
}
