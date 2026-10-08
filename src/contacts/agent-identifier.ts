// agent-identifier.ts — validate and normalize an identifier an agent typed into
// contact-create or contact-link-identity (#2041).
//
// Normalizing before the duplicate check means `+1 (416) 555-0100` finds the stored
// `+14165550100`. It also stores the identifier in the shape the send skills
// address: a number kept as `(416) 555-0100` would be skipped as unsendable at the
// first send.

import { normalizePhone } from './canonical-attribute-guard.js';
import { PHONE_CHANNELS } from './identifier-near-miss.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;
/** Slack user ids: U… (standard) or W… (Enterprise Grid). Case-sensitive, as Slack issues them. */
const SLACK_USER_ID_REGEX = /^[UW][A-Z0-9]+$/;

export type NormalizedIdentifier =
  | { ok: true; identifier: string }
  | { ok: false; error: string };

/**
 * The stored form of `raw` on `channel`, or an agent-facing error. The error names
 * the input and the expected shape, never the value.
 */
export function normalizeAgentIdentifier(channel: string, raw: string): NormalizedIdentifier {
  const value = raw.trim();
  if (!value) return { ok: false, error: `${channel} is empty.` };

  if (channel === 'email') {
    const lower = value.toLowerCase();
    return EMAIL_REGEX.test(lower)
      ? { ok: true, identifier: lower }
      : { ok: false, error: 'email must be an email address (name@domain).' };
  }

  if (PHONE_CHANNELS.has(channel)) {
    // A valid E.164 number the phone library does not recognise (a new range, a
    // fictional 555 area code) is kept rather than refused. The fallback ignores
    // formatting (spaces, parentheses, dots, hyphens), so `+1 (555) 123-4567` is
    // stored compact as `+15551234567`.
    const compact = value.replace(/[\s().-]/g, '');
    const normalized = normalizePhone(value) ?? (E164_REGEX.test(compact) ? compact : null);
    return normalized
      ? { ok: true, identifier: normalized }
      : { ok: false, error: `${channel} must be a phone number in international form, such as +14155552671.` };
  }

  if (channel === 'slack') {
    return SLACK_USER_ID_REGEX.test(value)
      ? { ok: true, identifier: value }
      : { ok: false, error: 'slack must be a Slack user id (U… or W…), not a name or handle.' };
  }

  return { ok: true, identifier: value };
}
