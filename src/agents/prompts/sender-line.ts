// The head of the sender-context block: who is talking, and whether they are the
// principal (prompt trim PR 4, docs/wip/2026-10-06-coordinator-prompt-trim.md).
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

/** First line of the LOW-TRUST block for a sender with no contact record. */
export const UNRESOLVED_SENDER_HEAD = `Unknown sender (no contact record). ${NOT_PRINCIPAL_LINE}`;

export interface SenderLineInput {
  /** Already sanitized: display names are self-claimed by external senders. */
  displayName: string;
  systemRole: string | null | undefined;
  /** Descriptive role (e.g. "board member"), already sanitized. */
  role: string | null;
  verified: boolean;
}

/** `Current sender: …` plus, for anyone but the principal, NOT_PRINCIPAL_LINE. */
export function renderSenderLine(input: SenderLineInput): string {
  let line = `Current sender: ${input.displayName}`;
  // The system role first: it is the deterministic designation. A descriptive role is
  // labelled so it can never read as one.
  if (input.systemRole) line += ` (${input.systemRole})`;
  else if (input.role) line += ` (role: ${input.role})`;
  line += input.verified ? ' [verified]' : ' [unverified]';
  if (input.systemRole !== 'principal') line += `\n${NOT_PRINCIPAL_LINE}`;
  return line;
}
