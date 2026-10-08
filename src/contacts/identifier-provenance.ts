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

/** The key an identifier on `channel` is looked up by. */
export function sourceKeyFor(channel: string, identifier: string): string {
  if (channel === 'email') return `email:${identifier.trim().toLowerCase()}`;
  if (PHONE_CHANNELS.has(channel)) {
    const normalized = normalizeAgentIdentifier(channel, identifier);
    return normalized.ok ? `phone:${normalized.identifier}` : `token:${identifier.trim()}`;
  }
  return `token:${identifier.trim()}`;
}

/** Every key an identifier occurring in `text` would be looked up by. */
export function sourceKeysInText(text: string): Set<string> {
  const keys = new Set<string>();

  for (const match of text.matchAll(EMAIL_IN_TEXT)) {
    keys.add(`email:${match[0].toLowerCase()}`);
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
    if (/\d/.test(token) || token.startsWith('@')) keys.add(`token:${token}`);
  }

  return keys;
}
