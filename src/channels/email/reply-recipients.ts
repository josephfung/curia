// Shared email-reply recipient derivation.
//
// Gate C must see the same To/CC set the handler will send (#1815). Keep the
// three CC modes in one place: reply-all (cc omitted), sender-only (cc === ""),
// and an explicit comma-separated list.

export interface EmailAddressParticipant {
  email?: string;
}

export interface EmailReplyRecipientSet {
  /** Original sender — always the primary To of the reply. */
  to: string;
  /** CC addresses after mode-specific filtering and dedup. Empty when none. */
  cc: string[];
}

/**
 * Derive the reply's To + CC from the original message and the skill's `cc` input.
 *
 * Returns null when the original has no sender, or when `cc` is present but not a
 * string (unmodeled input → fail closed for Gate C).
 */
export function deriveEmailReplyRecipientSet(opts: {
  originalFrom: string | undefined;
  originalTo?: readonly EmailAddressParticipant[] | null;
  originalCc?: readonly EmailAddressParticipant[] | null;
  ccInput: unknown;
  selfEmail?: string;
}): EmailReplyRecipientSet | null {
  const originalFrom = opts.originalFrom?.trim();
  if (!originalFrom) return null;

  const { ccInput } = opts;
  if (ccInput !== undefined && typeof ccInput !== 'string') {
    return null;
  }

  let cc: string[] = [];

  if (ccInput === undefined) {
    // Reply-all: original To + CC, excluding the primary To (already in `to`)
    // and Curia's own address (must never CC itself).
    const excluded = new Set<string>();
    excluded.add(originalFrom.toLowerCase());
    if (opts.selfEmail && opts.selfEmail.trim().length > 0) {
      excluded.add(opts.selfEmail.trim().toLowerCase());
    }

    const candidates = [
      ...(opts.originalTo ?? []),
      ...(opts.originalCc ?? []),
    ];

    const resolved = candidates
      .map((p) => p.email)
      .filter((addr): addr is string => typeof addr === 'string' && addr.trim().length > 0)
      .map((addr) => addr.trim())
      .filter((addr) => !excluded.has(addr.toLowerCase()));

    const seen = new Set<string>();
    cc = resolved.filter((addr) => {
      const key = addr.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } else if (ccInput === '') {
    cc = [];
  } else {
    cc = ccInput
      .split(',')
      .map((addr) => addr.trim())
      .filter((addr) => addr.length > 0);
  }

  return { to: originalFrom, cc };
}
