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

import type { Frame, Page } from 'playwright';
import type { ToolContext } from '../../../../src/skills/types.js';
import { registrableDomain } from '../../../../src/verification/domain.js';
import { isBlockedFrameUrl } from './frame-url.js';

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
 * Detect a verification screen in one document: the page's main frame, or a given frame.
 * Returns the known signal names found, or [] when there are none or the document could
 * not be evaluated (a detached or navigating page is ordinary, so that is logged at debug
 * and never fails the call).
 */
export async function detectVerificationScreen(scope: Page | Frame, log?: ToolContext['log']): Promise<string[]> {
  let raw: unknown;
  try {
    raw = await scope.evaluate(collectVerificationSignals);
  } catch (err) {
    // The in-page function reads no input values, so the message carries no code.
    log?.debug({ errMessage: err instanceof Error ? err.message : String(err) }, 'Verification screen detection failed — no hint');
    return [];
  }
  // The page can tamper with its own globals; accept only known signal names.
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is VerificationSignal => typeof s === 'string' && KNOWN_SIGNALS.has(s));
}

/** Signals that mean "the code is typed into this document" (a delivery choice is not one). */
const CODE_ENTRY_SIGNALS: ReadonlySet<string> = new Set<VerificationSignal>([
  'one-time-code-input',
  'short-numeric-input-with-code-wording',
]);

async function hasCodeEntry(scope: Page | Frame, log?: ToolContext['log']): Promise<boolean> {
  return (await detectVerificationScreen(scope, log)).some((s) => CODE_ENTRY_SIGNALS.has(s));
}

/** Which child frames may stand in for the top page as the code's destination. */
export interface CodeEntryTrust {
  /** Registrable domains of identity providers a site may embed (verification.identityProviderDomains). */
  identityProviderDomains: readonly string[];
}

/**
 * The URL of the document the sign-in code will be typed into (#2017). The verification's
 * page_domain is taken from it, and the browser guard judges a typed code by the field's
 * own frame, so the two must agree.
 *
 * The top-level page, unless the main frame has no code input and exactly one child frame
 * does whose registrable domain is the top page's own or a configured identity provider's
 * (an IdP embedded in the site's page), and which the SSRF frame guard allows. The anchor
 * is the live top page, never the model's `site` argument, so a confused or injected
 * coordinator cannot name a third party into trust. A frame's DOM is
 * supplied by whoever serves it, so a code input alone never makes a frame trusted: a
 * chat or ad iframe, or two competing candidates, leave the top page as the destination,
 * and the guard then refuses a code typed into the stray frame (fail closed). The main
 * frame wins when it has its own code input.
 */
export async function codeEntryPageUrl(page: Page, trust: CodeEntryTrust, log?: ToolContext['log']): Promise<string> {
  const topUrl = page.url();
  const main = page.mainFrame();
  if (await hasCodeEntry(main, log)) return topUrl;
  const topDomain = registrableDomain(topUrl);
  const trusted = new Set(trust.identityProviderDomains);
  if (topDomain !== null) trusted.add(topDomain);
  const candidates: string[] = [];
  for (const frame of page.frames()) {
    if (frame === main) continue;
    const url = frame.url();
    if (!/^https?:/i.test(url) || isBlockedFrameUrl(url)) continue;
    const domain = registrableDomain(url);
    if (domain === null || !trusted.has(domain)) continue;
    if (await hasCodeEntry(frame, log)) candidates.push(url);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    log?.info({ candidates: candidates.length }, 'Several trusted frames hold a code input; keeping the top-level page');
  }
  return topUrl;
}
