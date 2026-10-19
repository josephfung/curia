/// <reference lib="dom" />
//
// verification-detect.ts — heuristic detection of a sign-in verification screen (#2017,
// design §2). web-browser adds `verification_suspected` to its result when this finds
// signals, nudging the coordinator to open a `verification` before it asks the principal
// for a code. It nudges; it does not decide.
//
// collectVerificationSignals runs *inside the browser* via page.evaluate(), so (as in
// dom-extract.ts) it must stay self-contained: no imports, no module-scope references,
// no named inner functions (prod's keepNames transpile wraps those in a __name helper
// the page does not have). It never reads input values, so nothing it returns or throws
// can carry a typed code.

import type { Page } from 'playwright';
import type { ToolContext } from '../../../../src/skills/types.js';

/** Signal names, in the order they are reported. */
export const VERIFICATION_SIGNALS = [
  'one-time-code-input',
  'short-numeric-input-with-code-wording',
  'delivery-choice',
] as const;

export type VerificationSignal = (typeof VERIFICATION_SIGNALS)[number];

const KNOWN_SIGNALS: ReadonlySet<string> = new Set(VERIFICATION_SIGNALS);

/**
 * In-page: which verification-screen signals the current document shows.
 * - `one-time-code-input`: an input with autocomplete="one-time-code".
 * - `short-numeric-input-with-code-wording`: a numeric/tel input with maxlength ≤ 10 on a
 *   page whose text asks for a code.
 * - `delivery-choice`: page text offering to send a code by email, text or SMS.
 */
export function collectVerificationSignals(): string[] {
  let oneTimeCode = false;
  let shortNumeric = false;
  const inputs = document.querySelectorAll('input');
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden') continue;
    const autocomplete = (input.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    if (autocomplete.includes('one-time-code')) oneTimeCode = true;
    const inputMode = (input.getAttribute('inputmode') ?? '').toLowerCase();
    const maxAttr = input.getAttribute('maxlength');
    const maxLength = maxAttr === null ? NaN : Number(maxAttr);
    if ((inputMode === 'numeric' || type === 'tel' || type === 'number') && maxLength >= 1 && maxLength <= 10) {
      shortNumeric = true;
    }
  }

  const body = document.body;
  const text = body ? (body.innerText || body.textContent || '') : '';
  const codeWording =
    /verification code|security code|sign-in code|login code|authentication code|confirmation code|one[- ]time (?:code|pass(?:code|word)?)|enter (?:the|your) code|\b\d-digit\b/i;
  const deliveryChoice = [
    // "Send code by email", "Text me a code", "Email me the code", "Send a verification code"
    /\b(?:send|text|e-?mail)\s+(?:me\s+)?(?:a\s+|the\s+|my\s+)?(?:new\s+)?(?:verification\s+|security\s+|one-time\s+)?code\b/i,
    // "Get a code by text message", "code via SMS"
    /\bcode\s+(?:by|via)\s+(?:e-?mail|text|sms|phone)\b/i,
    // "How would you like to receive your code?"
    /\b(?:receive|get)\s+(?:your|a|the)\s+(?:verification\s+|security\s+)?code\b/i,
  ];

  const signals: string[] = [];
  if (oneTimeCode) signals.push('one-time-code-input');
  if (shortNumeric && codeWording.test(text)) signals.push('short-numeric-input-with-code-wording');
  for (let i = 0; i < deliveryChoice.length; i++) {
    if (deliveryChoice[i]!.test(text)) {
      signals.push('delivery-choice');
      break;
    }
  }
  return signals;
}

/**
 * Detect a verification screen on the page's main frame. Returns the known signal names
 * found, or [] when there are none or the page could not be evaluated (a detached or
 * navigating page is ordinary, so that is logged at debug and never fails the call).
 */
export async function detectVerificationScreen(page: Page, log?: ToolContext['log']): Promise<string[]> {
  let raw: unknown;
  try {
    raw = await page.evaluate(collectVerificationSignals);
  } catch (err) {
    // The in-page function reads no input values, so the message carries no code.
    log?.debug({ errMessage: err instanceof Error ? err.message : String(err) }, 'Verification screen detection failed — no hint');
    return [];
  }
  // The page can tamper with its own globals; accept only known signal names.
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is VerificationSignal => typeof s === 'string' && KNOWN_SIGNALS.has(s));
}
