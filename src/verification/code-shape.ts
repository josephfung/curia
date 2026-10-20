// Code-shape helpers for sign-in verification codes.
//
// A "code-shaped" value is 6-8 characters (after removing at most one internal
// space or dash) that are all digits, or alphanumeric with at least one digit.
// 4-5 character values are only admitted when the caller opts in: the value was
// typed by web-browser, or extractShortRelayedCodes found it in a message that is
// essentially just the code (or names it after a code keyword).
//
// Nothing here logs: code values must never reach logs or error messages.

export interface CodeShapeOptions {
  /** Admit 4-5 character values in addition to 6-8. */
  allowShort?: boolean;
}

const MIN_LEN = 6;
const MIN_LEN_SHORT = 4;
const MAX_LEN = 8;

const SPLIT_CODE = /^([A-Za-z0-9]+)[ -]([A-Za-z0-9]+)$/;

/** Uppercase and strip at most one internal space or dash. */
export function normalizeCode(raw: string): string {
  const trimmed = raw.trim();
  const m = SPLIT_CODE.exec(trimmed);
  return (m ? `${m[1]}${m[2]}` : trimmed).toUpperCase();
}

export function isCodeShaped(raw: string, opts: CodeShapeOptions = {}): boolean {
  const code = normalizeCode(raw);
  const min = opts.allowShort ? MIN_LEN_SHORT : MIN_LEN;
  if (code.length < min || code.length > MAX_LEN) return false;
  if (!/^[A-Z0-9]+$/.test(code)) return false;
  return /\d/.test(code);
}

// Sequences that look like codes but are not. Masked out (replaced by a newline,
// which breaks tokens and can never act as a pair separator) before extraction.
const DATE_PATTERNS = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g, // 2026-10-19
  /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, // 10/19/2026, 19.10.2026
];
const TIME_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
// Digit groups joined by single separators, optionally +-prefixed or parenthesised.
const PHONE_PATTERN = /\+?\(?\d+\)?(?:[ .-]\(?\d+\)?)*/g;

function maskNonCodes(text: string): string {
  let out = text;
  for (const p of DATE_PATTERNS) out = out.replace(p, '\n');
  out = out.replace(TIME_PATTERN, '\n');
  out = out.replace(PHONE_PATTERN, (match) => {
    const digits = match.replace(/\D/g, '');
    return match.startsWith('+') || digits.length >= 9 ? '\n' : match;
  });
  return out;
}

interface Token {
  text: string;
  /** Characters between the previous token and this one ('\n' at the start of the text). */
  before: string;
  /** Characters between this token and the next one ('\n' at the end of the text). */
  after: string;
}

// A single glue character with no whitespace means the run continues into
// something else (email local part, decimal, path, identifier).
function isGlued(sep: string): boolean {
  return sep === '.' || sep === '@' || sep === '_' || sep === '/';
}

function tokenize(text: string): Token[] {
  const matches = [...text.matchAll(/[A-Za-z0-9]+/g)];
  return matches.map((m, i) => {
    const start = m.index;
    const end = start + m[0].length;
    // At the start or end of the text there is no neighbouring run to glue to,
    // so sentence punctuation ("... 482913.") must not read as a glue char.
    const before = i > 0 ? text.slice(matches[i - 1]!.index + matches[i - 1]![0].length, start) : '\n';
    const after = i + 1 < matches.length ? text.slice(end, matches[i + 1]!.index) : '\n';
    return { text: m[0], before, after };
  });
}

const LETTERS_ONLY = /^[A-Za-z]+$/;

function canPair(a: Token, b: Token): boolean {
  if (a.after !== ' ' && a.after !== '-') return false;
  if (LETTERS_ONLY.test(b.text)) return false;
  if (LETTERS_ONLY.test(a.text)) {
    // A short letter prefix joined by a dash: G-482913.
    return a.after === '-' && a.text.length <= 2;
  }
  // Two digit-bearing groups (123 456, 4821 9374). If either half is already a
  // code on its own, it is not a split code.
  return !isCodeShaped(a.text) && !isCodeShaped(b.text);
}

/**
 * Pull code-shaped candidates out of free text: normalized, de-duplicated, in
 * order of appearance, 6-8 characters only. Phone numbers, dates and times are
 * excluded, as are tokens that are part of a longer run.
 */
export function extractCodeCandidates(text: string): string[] {
  const tokens = tokenize(maskNonCodes(text));
  const found: string[] = [];
  const add = (code: string): void => {
    if (!found.includes(code)) found.push(code);
  };

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1];
    const gluedBefore = isGlued(a.before);

    if (b && canPair(a, b) && !gluedBefore && !isGlued(b.after)) {
      const joined = `${a.text}${b.text}`;
      if (isCodeShaped(joined)) {
        add(normalizeCode(joined));
        i++;
        continue;
      }
    }
    if (!gluedBefore && !isGlued(a.after) && isCodeShaped(a.text)) {
      add(normalizeCode(a.text));
    }
  }
  return found;
}

// ── 4-5 character codes the principal relays (#2017) ─────────────────────────────────
//
// Free-text extraction stops at 6 characters because shorter shapes collide with years,
// times and amounts. A principal answering "send me the code" with a 4- or 5-digit code is
// still the common case, so two narrow shapes are admitted on top: a message that is
// essentially just the code, and a token right after a code keyword.

/** Longest message (trimmed) still read as "just the code". */
const SHORT_MESSAGE_MAX_LEN = 24;

/**
 * Words a "just the code" message may carry around the code: apostrophes removed,
 * lowercased. Deliberately not "is", "ok" or "thanks": "is 1430 ok" and "thanks 5000" are
 * answers about a time or an amount ("code is 4821" still registers through the keyword path).
 */
const SHORT_CODE_FILLER: ReadonlySet<string> = new Set([
  'code', 'the', 'its', 'it', 'here', 'heres', 'my',
  'try', 'use', 'sign', 'in', 'signin', 'login', 'verification', 'otp', 'pin', 'passcode',
]);

const SHORT_WORD = /[A-Za-z0-9]+(?:['\u2019][A-Za-z]+)?/g;

// A code keyword, an optional "is"/"was" and separator, then a 4-5 character token that
// is not glued to more text. Not after "zip"/"postal"/"promo" (however spaced), whose codes
// are not sign-in codes.
const KEYWORD_SHORT_CODE =
  /(?<![A-Za-z0-9])(?<!(?:zip|postal|promo)\s+)(?:code|passcode|pin|otp)\s*(?:(?:is|was)\s*)?[:=#-]?\s*([A-Za-z0-9]{4,5})(?![A-Za-z0-9])(?![.,:/@_-][A-Za-z0-9])/gi;

function isShortCode(token: string): boolean {
  return token.length >= MIN_LEN_SHORT && token.length < MIN_LEN && isCodeShaped(token, { allowShort: true });
}

/** A four-digit token that reads as a 24-hour time (0000-2359): "1430", "1200", "0930". */
function looksLikeTime(token: string): boolean {
  const m = /^(\d\d)(\d\d)$/.exec(token);
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** A four-digit token that reads as a year (1900-2099). */
function looksLikeYear(token: string): boolean {
  if (!/^\d{4}$/.test(token)) return false;
  const n = Number(token);
  return n >= 1900 && n <= 2099;
}

/**
 * 4-5 character code candidates in a principal's own message, normalized and
 * de-duplicated, admitted only when (a) the trimmed message is at most 24 characters, is
 * not a question, and its one digit-bearing token is surrounded by filler alone ("4821",
 * "It's 48213", "the code: 4821"), or (b) the token follows "code", "passcode", "pin" or
 * "otp" ("the code is 4821, then grab the notice"). A token that reads as a year
 * (1900-2099) is admitted only as the whole message, and on path (a) so is one that reads
 * as a 24-hour time ("It's 1200" is a time, "1200" alone may be a code). 6-8 character codes are
 * extractCodeCandidates' job and are never returned here.
 */
export function extractShortRelayedCodes(text: string): string[] {
  const trimmed = text.trim();
  const found: string[] = [];
  const add = (token: string): void => {
    const code = normalizeCode(token);
    if (!found.includes(code)) found.push(code);
  };

  // (a) The message is essentially just the code.
  if (trimmed.length <= SHORT_MESSAGE_MAX_LEN && !trimmed.endsWith('?')) {
    const words = [...trimmed.matchAll(SHORT_WORD)];
    const digitWords = words.filter((m) => /\d/.test(m[0]));
    const onlyFiller = words.every(
      (m) => /\d/.test(m[0]) || SHORT_CODE_FILLER.has(m[0].replace(/['\u2019]/g, '').toLowerCase()),
    );
    const sole = digitWords.length === 1 ? digitWords[0]! : null;
    if (sole && onlyFiller && isShortCode(sole[0])) {
      const before = trimmed.slice(0, sole.index);
      const wholeMessage = trimmed.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') === sole[0];
      // A currency sign makes it an amount; a year or a time counts only as the whole message.
      const timeOrYear = looksLikeYear(sole[0]) || looksLikeTime(sole[0]);
      if (!/[$€£¥]\s*$/.test(before) && (wholeMessage || !timeOrYear)) add(sole[0]);
    }
  }

  // (b) The token follows a code keyword.
  for (const m of text.matchAll(KEYWORD_SHORT_CODE)) {
    const token = m[1]!;
    if (isShortCode(token) && !looksLikeYear(token)) add(token);
  }
  return found;
}
