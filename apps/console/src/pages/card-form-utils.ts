// card-form-utils.ts — pure logic for the credit-card form (#1358): validation mirrors, payload build.
//
// The client rules exist for fast inline messages only. The server (structured-secret-schema.ts)
// is the authority and re-validates everything; keep these in step with it.

export type CardFormMode = 'full' | 'renewal' | 'edit-public';

export interface CardFormState {
  label: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  cardholderName: string;
  billingZip: string;
}

export const EMPTY_CARD_FORM: CardFormState = {
  label: '',
  number: '',
  expiryMonth: '',
  expiryYear: '',
  cvv: '',
  cardholderName: '',
  billingZip: '',
};

const ZIP_PATTERN = /^[A-Za-z0-9 -]{1,12}$/;
const CARDHOLDER_MAX = 100;
const LABEL_MAX = 100;

/** Digits only: the server strips spaces and dashes the same way. */
function digitsOf(number: string): string {
  return number.replace(/[\s-]/g, '');
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Brand name for the hint under the number field; '' until the number says anything. */
export function detectBrandForDisplay(number: string): string {
  const digits = digitsOf(number);
  if (digits.length === 0) return '';
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  if (digits.startsWith('4')) return 'Visa';
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return 'Mastercard';
  if (p2 === 34 || p2 === 37) return 'Amex';
  if (p4 === 6011 || (p3 >= 644 && p3 <= 649) || p2 === 65) return 'Discover';
  return '';
}

/** What an edit-public form started from, so it can leave unchanged fields out of the PATCH and
 *  tell a cleared field ('' clears) from one the page never knew ("keep"). */
export interface CardEditOriginal {
  label: string;
  expiryMonth: string;
  expiryYear: string;
  /** The billing postal code had a value, so a blank field clears it. The list summary does not
   *  carry the postal code, so the Secrets page can only say false. */
  hadBillingZip: boolean;
}

function expiryUnchanged(state: CardFormState, original: CardEditOriginal | undefined): boolean {
  return original !== undefined
    && state.expiryMonth.trim().padStart(2, '0') === original.expiryMonth
    && state.expiryYear.trim() === original.expiryYear;
}

export function validateCardForm(
  state: CardFormState,
  mode: CardFormMode,
  now: Date = new Date(),
  original?: CardEditOriginal,
): Partial<Record<keyof CardFormState, string>> {
  const errors: Partial<Record<keyof CardFormState, string>> = {};

  if (mode === 'full') {
    const digits = digitsOf(state.number);
    if (!/^\d{12,19}$/.test(digits)) {
      errors.number = 'The card number should be 12 to 19 digits.';
    } else if (!passesLuhn(digits)) {
      errors.number = "That card number doesn't look right. Check it and try again.";
    }
  }

  if (mode === 'full' || mode === 'renewal') {
    // A renewal does not know the number, so it cannot tell Amex from the rest; accept 3 or 4.
    const amex = mode === 'full' && detectBrandForDisplay(state.number) === 'Amex';
    const ok = mode === 'renewal' ? /^\d{3,4}$/.test(state.cvv) : (amex ? /^\d{4}$/ : /^\d{3}$/).test(state.cvv);
    if (!ok) errors.cvv = 'The security code should be 3 digits (4 for American Express).';
  }

  const month = /^\d{1,2}$/.test(state.expiryMonth.trim()) ? Number(state.expiryMonth) : NaN;
  const yearOk = /^\d{4}$/.test(state.expiryYear.trim());
  // An edit that leaves the expiry as it was is not asked about it again: an expired card must
  // still be able to take a new label.
  const skipExpiry = mode === 'edit-public' && expiryUnchanged(state, original);
  if (!skipExpiry && !(month >= 1 && month <= 12)) {
    errors.expiryMonth = 'Choose the expiry month.';
  }
  if (!skipExpiry && !yearOk) {
    errors.expiryYear = 'Choose the expiry year.';
  } else if (!skipExpiry && month >= 1 && month <= 12) {
    // Expired means before the current UTC month; the expiry month itself is still valid.
    const expiry = Number(state.expiryYear) * 12 + month;
    const current = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
    if (expiry < current) errors.expiryMonth = 'This card has expired.';
  }

  if (mode === 'full' || mode === 'edit-public') {
    const name = state.cardholderName.trim();
    // The saved name is not shown back, so a blank name in an edit means "keep it".
    if ((name.length === 0 && mode === 'full') || name.length > CARDHOLDER_MAX) {
      errors.cardholderName = 'Enter the name on the card (up to 100 characters).';
    }
    const zip = state.billingZip.trim();
    if (zip.length > 0 && !ZIP_PATTERN.test(zip)) {
      errors.billingZip = 'The billing postal code can use letters, digits, spaces and dashes (up to 12 characters).';
    }
  }

  // The label is optional here: an edit may clear it, and the capture page has none. Create
  // requires one itself, because the label names the secret.
  if (state.label.trim().length > LABEL_MAX) errors.label = 'The label can be up to 100 characters.';

  return errors;
}

/** The request fields for a mode; fields the mode does not send are left out. `label` goes out in
 *  full mode when filled (Create asks for one; the capture page has no label field). In
 *  edit-public with `original`, only what changed goes out: a cleared label or postal code is ''. */
export function buildCardPayload(
  state: CardFormState,
  mode: CardFormMode,
  original?: CardEditOriginal,
): Record<string, string> {
  const payload: Record<string, string> = {};
  if (mode === 'full') payload['number'] = digitsOf(state.number);
  if (mode === 'full' || mode === 'renewal') payload['cvv'] = state.cvv;
  if (!(mode === 'edit-public' && expiryUnchanged(state, original))) {
    payload['expiry_month'] = state.expiryMonth.trim().padStart(2, '0');
    payload['expiry_year'] = state.expiryYear.trim();
  }
  const label = state.label.trim();
  const zip = state.billingZip.trim();
  if (mode === 'full') {
    payload['cardholder_name'] = state.cardholderName.trim();
    if (zip !== '') payload['billing_zip'] = zip;
    if (label !== '') payload['label'] = label;
  }
  if (mode === 'edit-public') {
    const name = state.cardholderName.trim();
    if (name !== '') payload['cardholder_name'] = name;
    if (zip !== '') payload['billing_zip'] = zip;
    else if (original?.hadBillingZip) payload['billing_zip'] = '';
    if (original === undefined) {
      if (label !== '') payload['label'] = label;
    } else if (label !== original.label) {
      payload['label'] = label; // '' clears
    }
  }
  return payload;
}
