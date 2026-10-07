// principal-contact-block.ts — prompt blocks for who the agent is and who it serves.
//
// The principal block is the closed set of verified addresses (#1950). Models
// treated an open-ended sample as a category and invented a plausible extra
// address. The rendered text has to say the list is complete, set the primary
// email apart when contacts.primary_email matches a listed identity, and show
// labels. It sits under `## Who you serve`, near the top of the system string
// (trim plan PR 11). ChannelIdentity satisfies PrincipalContactBlockIdentity.

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

/** A label is a short note. Longer than this, the principal block cuts it. */
const LABEL_MAX_CHARS = 40;

/**
 * The label with newlines stripped, or null when it must not be used.
 *
 * An `@` or a run of 7+ digits is an address or phone stuffed into the note.
 * No length cap: send-by-reference matches this form, so a label copied from
 * contact-lookup still selects the address (#2047). The principal block shows
 * the shorter `visibleIdentityLabel`.
 */
export function cleanedIdentityLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripNewlines(raw).trim();
  if (!cleaned) return null;
  if (cleaned.includes('@') || /\d{7,}/.test(cleaned)) return null;
  return cleaned;
}

/**
 * The label the principal block shows, or null when it must not appear.
 *
 * Leaving an address-shaped note in the closed list would teach the model that
 * the address is verified. Send-by-reference treats a hidden label as unlabelled
 * and also accepts an exact match on this 40-character form, so a hint copied
 * from the block still works (#2047).
 */
export function visibleIdentityLabel(raw: string | null | undefined): string | null {
  const cleaned = cleanedIdentityLabel(raw);
  return cleaned ? cleaned.slice(0, LABEL_MAX_CHARS) : null;
}

/** Render a parenthetical label, or '' when the label must not appear. */
function renderLabel(raw: string | null | undefined): string {
  const visible = visibleIdentityLabel(raw);
  if (!visible) return '';
  const quoted = visible.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return ` (label: "${quoted}")`;
}

/**
 * The listed identity that `primaryEmail` (contacts.primary_email) designates, or
 * null. Only a verified, listed email identity counts: the raw column may point at
 * an unverified address, and the block must never render one (#1950). Exported so
 * the identity refresh can warn when the column is set but matches nothing.
 */
export function findPrimaryEmailIdentity<T extends PrincipalContactBlockIdentity>(
  identities: readonly T[],
  primaryEmail: string | null | undefined,
): T | null {
  const primary = stripNewlines(primaryEmail ?? '').trim().toLowerCase();
  if (primary === '') return null;
  return identities.find((identity) =>
    stripNewlines(identity.channel).trim().toLowerCase() === 'email'
    && stripNewlines(identity.channelIdentifier).trim().toLowerCase() === primary,
  ) ?? null;
}

function renderIdentityLine(identity: PrincipalContactBlockIdentity): string {
  // The label is a quoted note after the identifier, so it cannot read as an address.
  return `- ${stripNewlines(identity.channel)}: ${stripNewlines(identity.channelIdentifier)}${renderLabel(identity.label)}`;
}

/**
 * Render `### Principal Contact Details`, or null when there is nothing to list.
 * An empty list must not become a block: that would claim a complete set of
 * zero addresses, and the runtime omits the block instead (#1950).
 *
 * The designated primary email gets a list of its own, so it never sits directly
 * above a similar address: the address invented in #2033 read as the primary line
 * blended with the line below it. A list item, not a sentence, so no trailing
 * period sits against the address. With no listed match (null column, unverified
 * address, Signal-only principal) the list renders without a primary.
 */
export function formatPrincipalContactDetailsBlock(
  identities: readonly PrincipalContactBlockIdentity[],
  primaryEmail: string | null | undefined,
): string | null {
  if (identities.length === 0) return null;

  const primaryIdentity = findPrimaryEmailIdentity(identities, primaryEmail);
  const others = identities.filter((identity) => identity !== primaryIdentity);

  const lines = [
    '### Principal Contact Details',
    'These are all of the principal\'s verified addresses, and the list is complete: an address that is not listed here is not theirs.',
    // The send skills resolve the alias server-side (#2033), so a send to the
    // principal never needs an address typed from this list.
    'To send to the principal with email-send, signal-send, sms-send or slack-send, pass "principal" as the recipient. To pick a labelled address, add its label as a hint, as in principal#personal.',
    'When a tool needs a literal address, copy one exactly as it is written here. A label in parentheses is a note, not an address.',
  ];
  if (primaryIdentity) {
    lines.push('', 'Primary email:', renderIdentityLine(primaryIdentity));
  }
  if (others.length > 0) {
    lines.push('', primaryIdentity ? 'Other addresses:' : 'Addresses:', ...others.map(renderIdentityLine));
  }
  return lines.join('\n');
}

/**
 * Render `## Who you serve`: who "the principal" is, then their contact details.
 * Null when there are no verified identities. The section has no facts to state
 * without them, and an empty details block would claim a complete set of zero
 * addresses (#1950). It carries no contact ID: spec 09 keeps that handle opt-in.
 */
export function formatWhoYouServeBlock(
  identities: readonly PrincipalContactBlockIdentity[],
  primaryEmail: string | null | undefined,
): string | null {
  const details = formatPrincipalContactDetailsBlock(identities, primaryEmail);
  if (!details) return null;
  return [
    '## Who you serve',
    'You work for the principal. In these instructions, in tool descriptions and in messages from other agents, "the principal" means them.',
    '',
    details,
  ].join('\n');
}

/** Intro lines for `## Your Contact Details`. Shared so the debug renderer cannot drift. */
export const OWN_CONTACT_DETAILS_INTRO: readonly string[] = [
  'These are your own accounts. Use them when tools require an email address, phone number,',
  'or similar "acting as" identifier — never substitute the principal\'s details.',
];
