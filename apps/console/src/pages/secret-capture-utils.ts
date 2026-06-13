// secret-capture-utils.ts — pure view/validation logic for the public SecretCapturePage.
//
// Extracted from the component so it can be unit-tested under the project's node test env
// (the console has no jsdom render harness; logic lives in *-utils.ts, mirroring wizard-utils).

export type CaptureValueFormat = 'string' | 'json';

/** Metadata returned by GET /api/secret-capture/:token for a live token. */
export interface CaptureMetadataBody {
  label?: string | null;
  value_format?: string;
}

/** The form's top-level view state, derived from the metadata fetch. */
export type CaptureView =
  | { kind: 'loading' }
  | { kind: 'form'; label: string | null; valueFormat: CaptureValueFormat }
  | { kind: 'gone' }       // 410 — expired or already used
  | { kind: 'notfound' }   // 404 — never valid
  | { kind: 'error' }      // network / 5xx
  | { kind: 'success' };   // value submitted

/** Map a metadata-fetch result to a view state. 200 → form, 410 → gone, 404 → notfound,
 *  anything else → a generic error (so a 5xx doesn't masquerade as a usable form). */
export function classifyMetadataResponse(status: number, body: CaptureMetadataBody | null): CaptureView {
  if (status === 200 && body) {
    const valueFormat: CaptureValueFormat = body.value_format === 'json' ? 'json' : 'string';
    return { kind: 'form', label: body.label ?? null, valueFormat };
  }
  if (status === 410) return { kind: 'gone' };
  if (status === 404) return { kind: 'notfound' };
  return { kind: 'error' };
}

/** Client-side guard before POST: non-empty, and valid JSON when the link expects JSON.
 *  The server re-validates — this is purely for fast, friendly feedback. */
export function validateSubmitValue(value: string, valueFormat: CaptureValueFormat): { ok: true } | { ok: false; error: string } {
  if (value.length === 0) return { ok: false, error: 'Please enter a value.' };
  if (valueFormat === 'json') {
    try {
      JSON.parse(value);
    } catch {
      return { ok: false, error: 'This must be valid JSON.' };
    }
  }
  return { ok: true };
}
