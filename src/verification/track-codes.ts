// Shared registration of sign-in code values (#2017, design §1 and §5). Every source that
// registers a value (web-browser typing, a principal relaying a code, ceo-inbox reading
// one out of an email, on the live or the late-delegation path) goes through here, so the
// rules are the same everywhere:
//
//   - A value registers only against a `pending`, `expired` or `abandoned` verification.
//     Expired and abandoned rows stay "recent" (a late code can still work); a satisfied
//     one is finished, so a new code-shaped value is not its code.
//   - Registering against a row that is no longer pending starts its TTL clock at once,
//     or the value would never age out.
//
// Never logs a value.

import type { Logger } from '../logger.js';
import { extractCodeCandidates } from './code-shape.js';
import type { VerificationRuntime } from './index.js';
import type { Verification, VerificationStatus } from './types.js';

/** The specialist that reads the principal's inbox, where an emailed sign-in code lands. */
export const CEO_INBOX_AGENT = 'ceo-inbox';

const REGISTRABLE_STATUSES: ReadonlySet<VerificationStatus> = new Set(['pending', 'expired', 'abandoned']);

/** True when code values may still be registered against this verification. */
export function acceptsCodes(v: Verification): boolean {
  return REGISTRABLE_STATUSES.has(v.status);
}

/**
 * Register each value against every row that still accepts codes, starting the TTL clock
 * for the ones no longer pending. Returns the rows registered against (empty when there
 * were no values or no such row).
 */
export function registerCodes(
  runtime: Pick<VerificationRuntime, 'tracker'>,
  rows: readonly Verification[],
  values: readonly string[],
): Verification[] {
  if (values.length === 0) return [];
  const targets = rows.filter(acceptsCodes);
  for (const v of targets) {
    for (const value of values) runtime.tracker.register(v.id, v.pageDomain, value);
    if (v.status !== 'pending') runtime.tracker.closed(v.id);
  }
  return targets;
}

/**
 * Track every 6-8 character code in an inbox specialist's result against each pending or
 * recent `email` verification (design §5, source 3). 4-5 character codes are tracked only
 * when typed by web-browser, so they are not looked for here. The text itself is not
 * changed: the coordinator needs the code to type it. Best-effort: a failed lookup is
 * logged without content and never thrown.
 */
export async function trackInboxCodes(
  runtime: Pick<VerificationRuntime, 'tracker' | 'listActive'>,
  resultText: string,
  log: Pick<Logger, 'info' | 'warn'>,
  logContext: Record<string, unknown> = {},
): Promise<void> {
  const candidates = extractCodeCandidates(resultText);
  if (candidates.length === 0) return;
  try {
    const emailRows = (await runtime.listActive()).filter((v) => v.delivery === 'email');
    const registered = registerCodes(runtime, emailRows, candidates);
    if (registered.length === 0) return;
    log.info(
      { ...logContext, verificationIds: registered.map((v) => v.id), candidateCount: candidates.length },
      'Sign-in code(s) from the inbox specialist tracked for the pending or recent email verification(s)',
    );
  } catch (err) {
    // The err message could in principle echo a value; log the error name only.
    log.warn(
      { ...logContext, errName: err instanceof Error ? err.name : typeof err },
      'Could not list verifications; a code in the inbox specialist result was not tracked',
    );
  }
}
