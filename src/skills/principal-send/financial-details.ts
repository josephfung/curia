// financial-details.ts — the deterministic backstop for bank and card details in an autonomous
// principal-mailbox reply (#2474 final fixes A3, security review M3).
//
// Band review's judge rates stakes, and a payment-details acknowledgement should rate
// financial_or_legal. This backstop does not depend on that rating: a reply Curia sends on its own
// that carries a card number or an IBAN anywhere (its own text or the quote, exempt or not) never
// goes. The principal sends it if it should.

/**
 * PII-detector labels that are financial details. The scrubber's built-in patterns emit only
 * `credit_card` among them (src/pii/scrubber.ts); deployment extra patterns are named `extra_N`
 * and cannot be told apart by label. Compared lowercased.
 */
export const FINANCIAL_PII_LABELS: readonly string[] = ['credit_card'];

/** IBAN shape: country, check digits, then 11–30 letters or digits, optionally in spaced groups. */
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}/g;
const IBAN_MIN = 15;
const IBAN_MAX = 34;

/** ISO 13616 mod-97: move the first four characters to the end, letters to numbers, remainder 1. */
function ibanChecksumValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * Whether the text holds a checksum-valid IBAN. The redactor has no IBAN pattern, so this is the
 * backstop's own. A candidate may run on into following capitals ("… 00 THANKS"), so every
 * length from the start of the candidate is tried; the mod-97 check keeps ordinary text out.
 */
export function containsIban(text: string): boolean {
  // Case-insensitive: an IBAN is the same account however the drafter capitalises it.
  for (const match of text.toUpperCase().matchAll(IBAN_CANDIDATE)) {
    const compact = match[0].replace(/ /g, '');
    for (let len = Math.min(compact.length, IBAN_MAX); len >= IBAN_MIN; len--) {
      if (ibanChecksumValid(compact.slice(0, len))) return true;
    }
  }
  return false;
}

/**
 * Bank or card details in an autonomous reply: a detected item with a financial label, or an
 * IBAN in any of `texts` (the draft's body and subject).
 */
export function hasFinancialDetails(items: ReadonlyArray<{ label: string }>, texts: readonly string[]): boolean {
  return items.some((i) => FINANCIAL_PII_LABELS.includes(i.label.toLowerCase())) || texts.some(containsIban);
}
