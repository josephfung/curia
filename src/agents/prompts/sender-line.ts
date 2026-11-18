// The head of the sender-context block: who is talking, and whether they are the
// principal (prompt trim PR 4, #1954).
//
// The coordinator used to work the audience out from a "How to determine the audience"
// paragraph in agents/coordinator.yaml: look for "(principal)" on this line, treat cli as
// the principal, and treat everyone else as external. The runtime already knows the
// answer (systemRole, and the contact resolver maps cli/smoke-test/web to the
// principal), so it states it.
//
// Two cases the old line left ambiguous:
//   - A non-principal's descriptive role sat in the same parentheses as "(principal)", so
//     a contact whose job title is "Principal" rendered exactly like the principal. The
//     role is now labelled, and every non-principal line carries NOT_PRINCIPAL_LINE.
//   - An unresolved sender gets no "Current sender" line at all, only the LOW-TRUST
//     block; UNRESOLVED_SENDER_HEAD states the audience there.

/** Stated for every sender who is not the principal, resolved or not. */
export const NOT_PRINCIPAL_LINE = 'This sender is not the principal.';

/**
 * Stated when the message matches the principal's SMS number or email address but its channel
 * did not prove they sent it (GHSA-p49r-jqh2-v668): identity yes, authority no. Only on that turn.
 */
export const UNAUTHENTICATED_PRINCIPAL_LINE =
  'This message matches the principal\'s address, but its channel did not prove they sent it. Help as usual. '
  + 'Actions that need the principal\'s authority are sent to them for confirmation on a verified channel. '
  + 'When that happens, tell them a confirmation is waiting; don\'t ask them to repeat the request.';

/** First line of the LOW-TRUST block for a sender with no contact record. */
export const UNRESOLVED_SENDER_HEAD = `Unknown sender (no contact record). ${NOT_PRINCIPAL_LINE}`;

export interface SenderLineInput {
  /** Already sanitized: display names are self-claimed by external senders. */
  displayName: string;
  systemRole: string | null | undefined;
  /** Descriptive role (e.g. "board member"), already sanitized. */
  role: string | null;
}

/** `Current sender: …` plus, for anyone but the principal, NOT_PRINCIPAL_LINE. */
export function renderSenderLine(input: SenderLineInput): string {
  let line = `Current sender: ${input.displayName}`;
  // The system role first: it is the deterministic designation. A descriptive role is
  // labelled so it can never read as one.
  if (input.systemRole) line += ` (${input.systemRole})`;
  else if (input.role) line += ` (role: ${input.role})`;
  if (input.systemRole !== 'principal') line += `\n${NOT_PRINCIPAL_LINE}`;
  return line;
}

/**
 * Two separate facts about a sender (#2312). "Verified" used to cover both, and a report
 * called a verified contact an "unverified sender" because the message failed SPF/DKIM/DMARC.
 *   - Contact identity: the address is confirmed as belonging to this contact.
 *   - Message authentication: this message passed SPF/DKIM/DMARC (email only; the email
 *     adapter sets `metadata.senderVerified`, and `metadata.senderAuthentication` to tell
 *     an explicit failure from a message with no result).
 */
export function renderSenderFacts(input: {
  identityVerified: boolean;
  messageAuthenticated: unknown;
  messageAuthentication?: unknown;
  /** The turn matched the principal without the channel proving it (GHSA-p49r-jqh2-v668). */
  principalUnauthenticated?: boolean;
}): string {
  const identity = input.identityVerified ? 'verified' : 'not verified';
  // The adapter's status when present: a message with no Authentication-Results is "not
  // confirmed", not "failed". Otherwise the boolean, as before.
  const status = input.messageAuthentication;
  const auth = status === 'passed' || status === 'failed' || status === 'not confirmed'
    ? status
    : typeof input.messageAuthenticated !== 'boolean'
      ? 'not available'
      : input.messageAuthenticated ? 'passed' : 'failed';
  return `Contact identity: ${identity} (whether this address is confirmed as belonging to this contact)\n`
    + `Message authentication: ${auth} (SPF/DKIM/DMARC for this message)`
    + (input.principalUnauthenticated === true ? `\n${UNAUTHENTICATED_PRINCIPAL_LINE}` : '');
}
