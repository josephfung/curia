// Code-shape helpers for sign-in verification codes.
//
// A "code-shaped" value is 6-8 characters (after removing at most one internal
// space or dash) that are all digits, or alphanumeric with at least one digit.
// 4-5 character values are only admitted when the caller opts in (the value
// was typed by web-browser, so there is no free-text ambiguity).
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
  /** Characters between the previous token and this one. */
  before: string;
  /** Characters between this token and the next one (or end of text). */
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
    const prevEnd = i > 0 ? matches[i - 1]!.index + matches[i - 1]![0].length : 0;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    return { text: m[0], before: text.slice(prevEnd, start), after: text.slice(end, nextStart) };
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
