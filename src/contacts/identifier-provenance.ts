// identifier-provenance.ts — find the identifiers that occur in a piece of source text
// (#2061, ADR-047).
//
// An identifier an agent enters is verified only when it occurs in text the model did
// not write: a message a person sent, or the result of a source tool. Matching works on
// keys, not raw substrings, so `416-555-0100` in a message matches a stored
// `+14165550100`, and `Sam@Venue-Co.com.` matches `sam@venue-co.com`.

import { findPhoneNumbersInText } from 'libphonenumber-js';
import { normalizeAgentIdentifier } from './agent-identifier.js';
import { normalizePhone } from './canonical-attribute-guard.js';
import { PHONE_CHANNELS } from './identifier-near-miss.js';

/**
 * Answers whether an identifier occurs in the sources available to the current task.
 * The runtime builds one per task; contact skills read it through `ctx.identifierSources`.
 */
export interface IdentifierSources {
  has(channel: string, identifier: string): Promise<boolean>;
}

const EMAIL_IN_TEXT = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// A run of digits with phone punctuation between them. Its digits are read as a
// number below; the phone library separately finds numbers a run would merge.
const PHONE_RUN_IN_TEXT = /\+?\d[\d\s().-]{5,}\d/g;
// Opaque ids (Slack U…/W…, Telegram @handles and numeric ids). Only tokens with a
// digit or a leading @ are kept: ordinary words are never such an id, and keeping
// them would crowd addresses out of the source index.
const TOKEN_IN_TEXT = /[A-Za-z0-9@_][A-Za-z0-9_.@+-]{2,63}/g;

// JSON escapes (`\n`, `\t`, `\"`): a stringified result glues `n` onto an address that
// started a line, so `\nsam@x.com` would read as `nsam@x.com`.
const JSON_ESCAPE = /\\[nrtbf"\/\\]/g;
// Characters that can start a local part but are, in text, almost always punctuation
// around the address ('sam@x.com', .sam@x.com). The address is read with and without them.
const LEADING_PUNCTUATION = /^[.'+%-]+/;

/** The key an identifier on `channel` is looked up by. */
export function sourceKeyFor(channel: string, identifier: string): string {
  if (channel === 'email') return `email:${identifier.trim().toLowerCase()}`;
  if (PHONE_CHANNELS.has(channel)) {
    const normalized = normalizeAgentIdentifier(channel, identifier);
    return normalized.ok ? `phone:${normalized.identifier}` : `token:${bareToken(identifier)}`;
  }
  return `token:${bareToken(identifier)}`;
}

/** An opaque id without the `@` a mention or handle carries (`@U012AB3CD`, `@sam_r`). */
function bareToken(value: string): string {
  return value.trim().replace(/^@/, '');
}

/** Every key an identifier occurring in `text` would be looked up by. */
export function sourceKeysInText(rawText: string): Set<string> {
  const keys = new Set<string>();
  const text = rawText.replace(JSON_ESCAPE, ' ');

  for (const match of text.matchAll(EMAIL_IN_TEXT)) {
    const address = match[0].toLowerCase();
    keys.add(`email:${address}`);
    const trimmed = address.replace(LEADING_PUNCTUATION, '');
    if (trimmed !== address && !trimmed.startsWith('@')) keys.add(`email:${trimmed}`);
  }

  for (const match of text.matchAll(PHONE_RUN_IN_TEXT)) {
    const run = match[0];
    const digits = run.replace(/\D/g, '');
    if (run.startsWith('+')) keys.add(`phone:+${digits}`);
    else if (digits.length === 10) keys.add(`phone:+1${digits}`);
    else if (digits.length === 11 && digits.startsWith('1')) keys.add(`phone:+${digits}`);
    const parsed = normalizePhone(run);
    if (parsed) keys.add(`phone:${parsed}`);
  }
  for (const found of findPhoneNumbersInText(text, 'US')) {
    keys.add(`phone:${found.number.format('E.164')}`);
  }

  for (const match of text.matchAll(TOKEN_IN_TEXT)) {
    const token = match[0].replace(/[.-]+$/, '');
    if (/\d/.test(token) || token.startsWith('@')) keys.add(`token:${bareToken(token)}`);
  }

  return keys;
}

/**
 * The text of a source tool's result that may verify an identifier: every string in it,
 * except messages Curia wrote. A message whose `from` is one of `selfEmails` (Curia's sent
 * mail, Curia's replies in a thread) and a draft (`is_draft`, or anything under `drafts`)
 * hold addresses a model typed, so they are left out. Walking the values rather than the
 * JSON text also keeps escapes out of the match.
 */
export function provenanceSourceText(data: unknown, selfEmails: readonly string[]): string {
  const self = new Set(selfEmails.map((email) => email.trim().toLowerCase()));
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof value === 'string') {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (record['is_draft'] === true || sentBy(record['from'], self)) return;
      for (const [key, child] of Object.entries(record)) {
        if (key === 'drafts') continue;
        visit(child, depth + 1);
      }
    }
  };
  visit(data, 0);
  return parts.join('\n');
}

/** Whether a message's `from` (a string, `{ email }`, or a list of either) names one of `self`. */
function sentBy(from: unknown, self: ReadonlySet<string>): boolean {
  if (self.size === 0 || from === undefined || from === null) return false;
  const entries = Array.isArray(from) ? from : [from];
  return entries.some((entry) => {
    const address = typeof entry === 'string'
      ? entry
      : entry !== null && typeof entry === 'object' ? (entry as { email?: unknown }).email : undefined;
    if (typeof address !== 'string') return false;
    const bracketed = /<([^>]+)>/.exec(address)?.[1] ?? address;
    return self.has(bracketed.trim().toLowerCase());
  });
}
