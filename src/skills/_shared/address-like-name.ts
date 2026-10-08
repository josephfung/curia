// address-like-name.ts — whether a contact's display name is safe to quote to an agent (#2041).
//
// Display names come from inbound headers, and a contact the gateway or an inbound
// channel created is named after its identifier. An error that quotes such a name
// hands the model a stored address or number, which it will retype. Every agent-facing
// message that names a contact checks the name here first and falls back to the
// contact's ID.
//
// Stored names have been through sanitizeDisplayName, which strips the "@" and the "+":
// `sam.rivera@vendor.example` is stored as `sam.riveravendor.example`, and
// `+14165550100` as `14165550100`. So the rules match those shapes too. Over-matching
// only costs the name: the contact is still named by its ID, which is the safe form.

/** Separators a typed phone number carries: `+1 (416) 555-0100`. */
const PHONE_SEPARATORS = /[\s().\-+]/g;

/** A Slack user id (`U012ABCDEF`) or Enterprise Grid id (`W012ABCDEF`). */
const SLACK_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * True when `name` looks like an address or a number rather than a person's name:
 *   - it contains `@`;
 *   - it has a run of 7 or more digits once spaces, parentheses, dots, hyphens and `+`
 *     are removed;
 *   - it is a single token with no whitespace and a dot inside it;
 *   - it has the shape of a Slack user id.
 */
export function isAddressLikeName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.includes('@')) return true;
  if (/\d{7,}/.test(trimmed.replace(PHONE_SEPARATORS, ''))) return true;
  if (!/\s/.test(trimmed) && /\S\.\S/.test(trimmed)) return true;
  return SLACK_ID.test(trimmed);
}
