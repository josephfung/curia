// approval-ref.ts — read the `short_ref` input of approve-, deny- and dismiss-action (#2159 Phase 3).
//
// One parser for all three tools, because each re-runs or resolves an action with principal
// authority and must agree on which approval a reply names. The rule is fail-closed:
//
//   - absent (undefined / null)          → no ref: the repo may pick the SOLE pending approval
//   - a non-negative integer (3)         → '3': a model may relay "approve 3" as a JSON number
//   - a non-empty string (' 3 ', 'a3f…') → trimmed and passed through
//   - anything else ('', '  ', {}, true, -1, 2.5, NaN, Infinity) → an error, never a fallback
//
// The sole-pending fallback is only for "approve" with no reference at all. A reference that is
// present but unreadable must never become "no reference", or "approve 3" (with 3 mangled or
// expired) would act on whatever other approval happens to be pending alone.

export type ApprovalRefInput =
  | { ok: true; ref: string | undefined }
  | { ok: false; error: string };

export function parseApprovalRefInput(raw: unknown): ApprovalRefInput {
  if (raw === undefined || raw === null) return { ok: true, ref: undefined };
  // Number.isInteger is false for NaN and ±Infinity, so this also rejects non-finite values.
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return { ok: true, ref: String(raw) };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { ok: true, ref: raw.trim() };
  }
  return {
    ok: false,
    error:
      'short_ref must be the approval number from the notification (e.g. 3) or its 8-character reference. ' +
      'Nothing was resolved. Omit short_ref only when exactly one approval is pending.',
  };
}
