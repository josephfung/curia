// Schema registry for structured secrets (#1358, ADR-027, ADR-059).
//
// Pure module: no I/O, no logging. It defines the one schema that ships
// (credit_card), validates input for it, splits it into the encrypted part
// (number, CVV) and the public part (brand, last four, expiry, name), and
// projects named fields for form filling. The vault stores only the secret
// doc; the public fields live beside it so viewing a card never decrypts.

export type StructuredSchemaTag = 'credit_card';
export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';

/** What is encrypted in the vault. */
export interface CreditCardSecretDoc {
  _schema: 'credit_card';
  number: string;
  cvv: string;
}

/** What is stored in the clear next to the vault entry. */
export interface CreditCardPublicFields {
  brand: CardBrand;
  last4: string;
  /** Zero-padded "01".."12". */
  expiry_month: string;
  /** Four digits. */
  expiry_year: string;
  cardholder_name: string;
  billing_zip?: string;
}

export interface CreditCardInput {
  number: unknown;
  cvv: unknown;
  expiry_month: unknown;
  expiry_year: unknown;
  cardholder_name: unknown;
  billing_zip?: unknown;
}

export type CardValidationReason =
  | 'number_format'
  | 'number_checksum'
  | 'cvv_format'
  | 'expiry_format'
  | 'expired'
  | 'cardholder_missing'
  | 'billing_zip_format'
  | 'card_missing';

// User-facing copy. Never include the offending value: it may be a card number.
export const CARD_VALIDATION_MESSAGES: Record<CardValidationReason, string> = {
  number_format: 'The card number should be 12 to 19 digits.',
  number_checksum: "That card number doesn't look right. Check it and try again.",
  cvv_format: 'The security code should be 3 digits (4 for American Express).',
  expiry_format: 'Enter the expiry as a month from 1 to 12 and a four-digit year.',
  expired: 'This card has expired.',
  cardholder_missing: 'Enter the name on the card (up to 100 characters).',
  billing_zip_format: 'The billing postal code can use letters, digits, spaces and dashes (up to 12 characters).',
  card_missing: 'The card this link renews has been removed. Ask for a new card link.',
};

type ValidationFailure = { ok: false; reason: CardValidationReason };

const CARDHOLDER_MAX = 100;
const ZIP_PATTERN = /^[A-Za-z0-9 -]{1,12}$/;

// ---------------------------------------------------------------------------
// Brand, number, CVV
// ---------------------------------------------------------------------------

export function detectCardBrand(digits: string): CardBrand {
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  if (digits.startsWith('4')) return 'visa';
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return 'mastercard';
  if (p2 === 34 || p2 === 37) return 'amex';
  if (p4 === 6011 || (p3 >= 644 && p3 <= 649) || p2 === 65) return 'discover';
  return 'other';
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

export function validateCvv(cvv: unknown, brand: CardBrand): boolean {
  if (typeof cvv !== 'string') return false;
  return (brand === 'amex' ? /^\d{4}$/ : /^\d{3}$/).test(cvv);
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function normalizeMonth(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  if (n < 1 || n > 12) return null;
  return String(n).padStart(2, '0');
}

function normalizeYear(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^\d{4}$/.test(s) ? s : null;
}

/** True when the expiry is before the current UTC month. The expiry month itself is still valid. */
export function isCardExpired(pub: CreditCardPublicFields, now: Date = new Date()): boolean {
  const expiry = Number(pub.expiry_year) * 12 + Number(pub.expiry_month);
  const current = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
  return expiry < current;
}

// ---------------------------------------------------------------------------
// Public-field validators shared by capture and patch
// ---------------------------------------------------------------------------

function normalizeCardholder(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= CARDHOLDER_MAX ? s : null;
}

function normalizeZip(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return ZIP_PATTERN.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Validation entry points
// ---------------------------------------------------------------------------

export function validateCreditCard(
  input: CreditCardInput,
  now: Date = new Date(),
):
  | { ok: true; secret: CreditCardSecretDoc; publicFields: CreditCardPublicFields }
  | ValidationFailure {
  if (typeof input.number !== 'string') return { ok: false, reason: 'number_format' };
  const digits = input.number.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return { ok: false, reason: 'number_format' };
  if (!passesLuhn(digits)) return { ok: false, reason: 'number_checksum' };

  const brand = detectCardBrand(digits);
  if (!validateCvv(input.cvv, brand)) return { ok: false, reason: 'cvv_format' };
  const cvv = input.cvv as string; // validateCvv confirmed it is a string

  const month = normalizeMonth(input.expiry_month);
  const year = normalizeYear(input.expiry_year);
  if (month === null || year === null) return { ok: false, reason: 'expiry_format' };

  const cardholder = normalizeCardholder(input.cardholder_name);
  if (cardholder === null) return { ok: false, reason: 'cardholder_missing' };

  const publicFields: CreditCardPublicFields = {
    brand,
    last4: digits.slice(-4),
    expiry_month: month,
    expiry_year: year,
    cardholder_name: cardholder,
  };
  if (isCardExpired(publicFields, now)) return { ok: false, reason: 'expired' };

  // A blank zip from a form is the same as no zip.
  const zipGiven = input.billing_zip !== undefined && input.billing_zip !== null
    && !(typeof input.billing_zip === 'string' && input.billing_zip.trim() === '');
  if (zipGiven) {
    const zip = normalizeZip(input.billing_zip);
    if (zip === null) return { ok: false, reason: 'billing_zip_format' };
    publicFields.billing_zip = zip;
  }

  return { ok: true, secret: { _schema: 'credit_card', number: digits, cvv }, publicFields };
}

/**
 * Validate an edit to the public fields. Month and year are validated as a pair
 * against `current`, and the expired check runs only when the patch touches
 * either (so renaming an expired card still works). `billing_zip: null` clears it.
 */
export function validateCardPublicPatch(
  patch: { expiry_month?: unknown; expiry_year?: unknown; cardholder_name?: unknown; billing_zip?: unknown },
  current: CreditCardPublicFields,
  now: Date = new Date(),
): { ok: true; publicFields: CreditCardPublicFields } | ValidationFailure {
  const next: CreditCardPublicFields = { ...current };

  const touchesExpiry = patch.expiry_month !== undefined || patch.expiry_year !== undefined;
  if (touchesExpiry) {
    const month = normalizeMonth(patch.expiry_month ?? current.expiry_month);
    const year = normalizeYear(patch.expiry_year ?? current.expiry_year);
    if (month === null || year === null) return { ok: false, reason: 'expiry_format' };
    next.expiry_month = month;
    next.expiry_year = year;
    if (isCardExpired(next, now)) return { ok: false, reason: 'expired' };
  }

  if (patch.cardholder_name !== undefined) {
    const name = normalizeCardholder(patch.cardholder_name);
    if (name === null) return { ok: false, reason: 'cardholder_missing' };
    next.cardholder_name = name;
  }

  if (patch.billing_zip === null) {
    delete next.billing_zip;
  } else if (patch.billing_zip !== undefined) {
    const zip = normalizeZip(patch.billing_zip);
    if (zip === null) return { ok: false, reason: 'billing_zip_format' };
    next.billing_zip = zip;
  }

  return { ok: true, publicFields: next };
}

// ---------------------------------------------------------------------------
// Field projections (ADR-027 vocabulary, in ADR order)
// ---------------------------------------------------------------------------

export const CARD_SECRET_FIELDS = ['number', 'cvv'] as const;

export const CARD_FIELDS: readonly string[] = [
  'number', 'cvv', 'cardholder_name', 'brand', 'billing_zip', 'expiry_month', 'expiry_year',
  'expiry_mm', 'expiry_m', 'expiry_yy', 'expiry_yyyy', 'expiry_mm_yy', 'expiry_mm_yyyy',
  'expiry_month_name', 'expiry_month_short',
];

export function isCardSecretField(field: string): field is 'number' | 'cvv' {
  return field === 'number' || field === 'cvv';
}

// Pinned to en-US and UTC so a "December" option never becomes "décembre" because
// of the host's locale, and Date.UTC(2000, m, 1) never slips a month across zones.
function monthName(month: string, style: 'long' | 'short'): string {
  return new Intl.DateTimeFormat('en-US', { month: style, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, Number(month) - 1, 1)));
}

export function projectCardField(
  field: string,
  pub: CreditCardPublicFields,
  secret: CreditCardSecretDoc | null,
): string {
  switch (field) {
    case 'number':
    case 'cvv':
      if (secret === null) throw new Error(`Card field '${field}' needs the secret document, which was not loaded`);
      return secret[field];
    case 'cardholder_name': return pub.cardholder_name;
    case 'brand': return pub.brand;
    case 'billing_zip': return pub.billing_zip ?? '';
    case 'expiry_month': return pub.expiry_month;
    case 'expiry_year': return pub.expiry_year;
    case 'expiry_mm': return pub.expiry_month;
    case 'expiry_m': return String(Number(pub.expiry_month));
    case 'expiry_yy': return pub.expiry_year.slice(-2);
    case 'expiry_yyyy': return pub.expiry_year;
    case 'expiry_mm_yy': return `${pub.expiry_month}/${pub.expiry_year.slice(-2)}`;
    case 'expiry_mm_yyyy': return `${pub.expiry_month}/${pub.expiry_year}`;
    case 'expiry_month_name': return monthName(pub.expiry_month, 'long');
    case 'expiry_month_short': return monthName(pub.expiry_month, 'short');
    default:
      throw new Error(`Unknown card field '${field}'. Fields: ${CARD_FIELDS.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Refs, tags, display
// ---------------------------------------------------------------------------

/** Split "user.visa_card#cvv" into the key name and optional field. */
export function parseSecretRef(ref: string): { name: string; field: string | null } {
  const parts = ref.split('#');
  if (parts.length > 2) throw new Error("A secret reference can contain only one '#'");
  const [name, field] = parts as [string, string | undefined];
  if (field === undefined) return { name, field: null };
  if (field === '') throw new Error("A secret reference's field after '#' can't be empty");
  return { name, field };
}

export function isStructuredSchemaTag(v: unknown): v is StructuredSchemaTag {
  return v === 'credit_card';
}

const BRAND_LABELS: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  other: 'Card',
};

/** "Visa ••1111 (Personal)" or "Amex ••0005". Public fields only. */
export function describeCard(pub: CreditCardPublicFields, label: string | null): string {
  const base = `${BRAND_LABELS[pub.brand]} ••${pub.last4}`;
  return label ? `${base} (${label})` : base;
}

// ---------------------------------------------------------------------------
// Card labels (#1358)
// ---------------------------------------------------------------------------

export const CARD_LABEL_MAX = 100;

/** A label the principal or agent typed: trimmed, 1 to 100 characters. Null when unusable. */
export function normalizeCardLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= CARD_LABEL_MAX ? s : null;
}

// Words that describe the card rather than name it. Dropped when a label is derived from the
// description the agent gave ("personal visa card" -> "Personal").
const LABEL_DROP_WORDS = new Set([
  'visa', 'mastercard', 'amex', 'discover', 'card', 'cards', 'credit', 'debit',
  'a', 'an', 'the', 'my', 'mine', 'our', 'your', 'for', 'of', 'and', 'user', 's',
]);

/**
 * A default label for a card captured without `card_label`: the description minus brand
 * words, "card"/"cards" and filler, title-cased. Null when nothing is left.
 */
export function deriveCardLabel(secretName: string): string | null {
  const words = secretName
    .toLowerCase()
    .replace(/['\u2018\u2019]s\b/g, '')
    .replace(/american[^a-z0-9]+express/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 0 && !LABEL_DROP_WORDS.has(w));
  if (words.length === 0) return null;
  const label = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return label.slice(0, CARD_LABEL_MAX).trim();
}

// ---------------------------------------------------------------------------
// Resolver error copy (#1358). Shared by the resolver and the browser/chat surfaces
// so the model sees one wording. None of these include a secret value.
// ---------------------------------------------------------------------------

export function BARE_CARD_REF_ERROR(name: string): string {
  return `\`${name}\` is a saved card. Address one field, e.g. \`${name}#number\`. Fields: ${CARD_FIELDS.join(', ')}`;
}

export function CARD_USE_REQUIRED_ERROR(name: string, domain: string): string {
  return `Using \`${name}\` on ${domain} needs the principal's confirmation for this checkout. Call card-use-request with the amount and purpose, wait for the approval, then fill again.`;
}

export const CARD_FILL_LIMIT_ERROR =
  "This confirmation's card-number and CVV fills are used up. Ask the principal again with card-use-request for another checkout.";

export type SecretRefRefusalCode =
  | 'card_use_required' | 'card_fill_limit' | 'bare_card_ref' | 'not_a_card'
  | 'unknown_card_field' | 'no_site' | 'empty_field';

/**
 * A structured-secret refusal from the resolver (#1358). Guidance for the model, not a
 * broken page: the browser skill returns its message as the action error, unchanged, and
 * does not count it toward the click breaker. The message never carries a secret value.
 */
export class SecretRefRefusal extends Error {
  constructor(readonly code: SecretRefRefusalCode, message: string) {
    super(message);
    this.name = 'SecretRefRefusal';
  }
}
