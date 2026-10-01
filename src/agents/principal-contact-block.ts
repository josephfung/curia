// principal-contact-block.ts — prompt blocks for who the agent is and who it serves.
//
// The principal block is the closed set of verified addresses (#1950). Models
// treated an open-ended sample as a category and invented a plausible extra
// address. The rendered text has to say the list is complete, mark the primary
// email when contacts.primary_email matches a listed identity, and show labels.
// ChannelIdentity satisfies PrincipalContactBlockIdentity.

/** Fields the block reads. */
export interface PrincipalContactBlockIdentity {
  channel: string;
  channelIdentifier: string;
  label?: string | null;
}

/** Stored channel identifiers and labels are attacker-controlled. Newlines would open a new prompt line. */
function stripNewlines(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/** A label is a short note. Longer than this, it stops being a label. */
const LABEL_MAX_CHARS = 40;

/**
 * Render a parenthetical label, or '' when the label must not appear.
 * An `@` or a run of 7+ digits is an address or phone stuffed into the note.
 * Leaving it in the closed list would teach the model that the address is verified.
 */
function renderLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = stripNewlines(raw).trim();
  if (!cleaned) return '';
  if (cleaned.includes('@') || /\d{7,}/.test(cleaned)) return '';
  const capped = cleaned.slice(0, LABEL_MAX_CHARS);
  const quoted = capped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return ` (label: "${quoted}")`;
}

/**
 * Render `## Principal Contact Details`, or null when there is nothing to list.
 * An empty list must not become a block: that would claim a complete set of
 * zero addresses, and the runtime omits the block instead (#1950).
 *
 * Primary is marked only when `primaryEmail` matches a listed email identity.
 * A marker with no matching line, or a sentence about a marker that is not
 * there, is worse than leaving the list unmarked.
 */
export function formatPrincipalContactDetailsBlock(
  identities: readonly PrincipalContactBlockIdentity[],
  primaryEmail: string | null | undefined,
): string | null {
  if (identities.length === 0) return null;

  const primary = stripNewlines(primaryEmail ?? '').trim().toLowerCase();
  const itemLines: string[] = [];
  let markedPrimary = false;

  for (const identity of identities) {
    const channel = stripNewlines(identity.channel);
    const identifier = stripNewlines(identity.channelIdentifier);
    const isPrimary =
      channel.trim().toLowerCase() === 'email'
      && primary !== ''
      && identifier.trim().toLowerCase() === primary;
    if (isPrimary) markedPrimary = true;

    // Leading [primary] is the marker. The label is a quoted note after the
    // identifier so it cannot occupy the marker's position or read as an address.
    const marker = isPrimary ? '[primary] ' : '';
    itemLines.push(`- ${marker}${channel}: ${identifier}${renderLabel(identity.label)}`);
  }

  const lines = [
    '## Principal Contact Details',
    'These are all of the verified channel addresses for the principal. This list is complete.',
    'Any identifier that does not appear in this list is not the principal\'s and must not be used.',
    'Do not infer, invent, or substitute an address.',
    'Only the identifier after the channel name is an address. A parenthetical label note is not an address and must not be used as one.',
  ];
  if (markedPrimary) {
    lines.push(
      'The line that starts with [primary] is the principal\'s primary email. Use that address when one email address is required.',
    );
  }
  lines.push('');
  lines.push(...itemLines);
  return lines.join('\n');
}

/** Intro lines for `## Your Contact Details`. Shared so the debug renderer cannot drift. */
export const OWN_CONTACT_DETAILS_INTRO: readonly string[] = [
  'These are your own accounts. Use them when tools require an email address, phone number,',
  'or similar "acting as" identifier — never substitute the principal\'s details.',
];
