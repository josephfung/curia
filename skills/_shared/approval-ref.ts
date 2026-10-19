// approval-ref.ts — read the `short_ref` input of approve-, deny- and dismiss-action (#2159 Phase 3).
//
// One parser for all three tools, because each re-runs or resolves an action with principal
// authority and must agree on which approval a reply names. The rule is fail-closed:
//
//   - absent (undefined / null)          → no ref: the repo may pick the SOLE pending approval
//   - a non-negative integer (3)         → '3': a model may relay "approve 3" as a JSON number
//   - '#3', 'Approval 3', 'approval 3'   → '3': the notification's own wording, whole string only
//   - a non-empty string (' 3 ', 'a3f…') → trimmed and passed through
//   - anything else ('', '  ', {}, true, -1, 2.5, NaN, Infinity) → an error, never a fallback
//   - a reference under another key (number, ref, id, ...) → an error, even beside short_ref
//
// The sole-pending fallback is only for "approve" with no reference at all. A reference that is
// present but unreadable must never become "no reference", or "approve 3" (with 3 mangled,
// mis-keyed or expired) would act on whatever other approval happens to be pending alone.

import { NO_REF_RETRY_GUIDANCE } from '../../src/autonomy/action-log-repo.js';

export type ApprovalRefInput =
  | { ok: true; ref: string | undefined }
  | { ok: false; error: string };

/**
 * Keys a model might put the reference under instead of short_ref. Read as absent, any of them
 * would turn "approve 3" into "approve whatever is pending alone", so their presence fails closed.
 */
const MISKEYED_REF_KEYS = ['number', 'shortRef', 'ref', 'reference', 'approval', 'approval_number', 'id'] as const;

/** "#3", "Approval 3", "approval 3": the whole string, so no number is pulled out of a sentence. */
const LABELLED_NUMBER = /^(?:#|approval\s+)(\d+)$/i;

/** Read the approval reference from a tool's whole input. */
export function parseApprovalRefInput(input: Record<string, unknown>): ApprovalRefInput {
  const miskeyed = MISKEYED_REF_KEYS.filter((k) => input[k] !== undefined && input[k] !== null);
  if (miskeyed.length > 0) {
    return {
      ok: false,
      error:
        `The approval reference must be passed as short_ref, not ${miskeyed.join(', ')}. ` +
        `Nothing was resolved. ${NO_REF_RETRY_GUIDANCE}`,
    };
  }

  const raw = input['short_ref'];
  if (raw === undefined || raw === null) return { ok: true, ref: undefined };
  // Number.isInteger is false for NaN and ±Infinity, so this also rejects non-finite values.
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { ok: true, ref: String(raw) };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    const labelled = LABELLED_NUMBER.exec(trimmed);
    return { ok: true, ref: labelled ? labelled[1]! : trimmed };
  }
  return {
    ok: false,
    error:
      'short_ref must be the approval number from the notification (e.g. 3) or its 8-character reference. ' +
      `Nothing was resolved. ${NO_REF_RETRY_GUIDANCE}`,
  };
}
