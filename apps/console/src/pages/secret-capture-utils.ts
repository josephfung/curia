// secret-capture-utils.ts — pure view/validation logic for the public SecretCapturePage.
//
// Extracted from the component so it can be unit-tested under the project's node test env
// (the console has no jsdom render harness; logic lives in *-utils.ts, mirroring wizard-utils).

export type CaptureValueFormat = 'string' | 'json';

/** Metadata returned by GET /api/secret-capture/:token for a live token. */
export interface CaptureMetadataBody {
  label?: string | null;
  value_format?: string;
  /** Present only on a card link (#1358). */
  capture_template?: string;
  /** Renewal links only: public fields of the card being renewed. */
  card?: { brand?: string; last4?: string; label?: string | null };
}

export type CaptureTemplate = 'credit_card' | 'credit_card_renewal';

export interface CaptureCardInfo { brand: string; last4: string; label: string | null }

/** The form's top-level view state, derived from the metadata fetch. */
export type CaptureView =
  | { kind: 'loading' }
  | {
      kind: 'form';
      label: string | null;
      valueFormat: CaptureValueFormat;
      /** Set on a card link; absent for a plain secret. */
      template?: CaptureTemplate;
      /** Set on a renewal link. */
      card?: CaptureCardInfo;
    }
  | { kind: 'gone' }       // 410 — expired or already used
  | { kind: 'notfound' }   // 404 — never valid
  | { kind: 'error' }      // network / 5xx
  | { kind: 'success' };   // value submitted

/** Map a metadata-fetch result to a view state. 200 → form, 410 → gone, 404 → notfound,
 *  anything else → a generic error (so a 5xx doesn't masquerade as a usable form). */
export function classifyMetadataResponse(status: number, body: CaptureMetadataBody | null): CaptureView {
  if (status === 200 && body) {
    const valueFormat: CaptureValueFormat = body.value_format === 'json' ? 'json' : 'string';
    const template: CaptureTemplate | undefined =
      body.capture_template === 'credit_card' || body.capture_template === 'credit_card_renewal'
        ? body.capture_template
        : undefined;
    const card: CaptureCardInfo | undefined =
      template === 'credit_card_renewal' && body.card?.brand && body.card.last4
        ? { brand: body.card.brand, last4: body.card.last4, label: body.card.label ?? null }
        : undefined;
    return {
      kind: 'form',
      label: body.label ?? null,
      valueFormat,
      ...(template ? { template } : {}),
      ...(card ? { card } : {}),
    };
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
