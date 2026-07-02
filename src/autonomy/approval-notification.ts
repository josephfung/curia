// approval-notification.ts — shared body construction for CEO approval alerts.
//
// Used by ApprovalTriggerService and OutboundGateway so the two notification
// paths cannot drift. Detail rendering is gated on the notification recipient
// meeting principal tier (issue #1300).

import type { ContactService } from '../contacts/contact-service.js';
import { meetsMinimumTier, type ContactTier } from '../contacts/types.js';
import { sanitizeOutput } from '../skills/sanitize.js';

// ---------------------------------------------------------------------------
// Constants — exported for tests
// ---------------------------------------------------------------------------

export const MAX_DETAIL_FIELD_LENGTH = 500;
export const MAX_DETAIL_TOTAL_LENGTH = 2000;

const INTERNAL_PAYLOAD_KEYS = new Set([
  'context_bridge',
  'attachments',
  'account',
  'calendarId',
  'colorId',
  'reminders',
  'conferencing',
]);

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

// ---------------------------------------------------------------------------
// Pure helpers — exported for testing
// ---------------------------------------------------------------------------

function truncateDetailField(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

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
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function fieldSpecsForSkill(skillName: string): DetailFieldSpec[] {
  for (const rule of SKILL_DETAIL_FIELDS) {
    if (rule.test(skillName)) return rule.fields;
  }
  return GENERIC_DETAIL_FIELDS;
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
    if (INTERNAL_PAYLOAD_KEYS.has(key)) continue;
    if (seenLabels.has(label)) continue;
    const raw = formatFieldValue(payload[key]);
    if (!raw) continue;

    const sanitized = sanitizeOutput(raw, { maxLength: MAX_DETAIL_FIELD_LENGTH });
    const line = `${label}: ${sanitized}`;
    if (totalLength + line.length > MAX_DETAIL_TOTAL_LENGTH) {
      const remaining = MAX_DETAIL_TOTAL_LENGTH - totalLength;
      if (remaining <= label.length + 2) break;
      lines.push(truncateDetailField(line, remaining));
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

  if (opts.recipientTier && meetsMinimumTier(opts.recipientTier, 'principal')) {
    const details = buildApprovalDetails(opts.skillName, opts.payload);
    if (details) {
      lines.push(details, '');
    }
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
): Promise<ContactTier | null> {
  if (!contactService || !ceoEmail) return null;
  try {
    const resolved = await contactService.resolveByChannelIdentity('email', ceoEmail);
    return resolved?.tier ?? null;
  } catch {
    return null;
  }
}
