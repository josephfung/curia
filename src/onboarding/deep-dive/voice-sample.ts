// voice-sample.ts — which sent messages make the writing-voice sample, and how their bodies are
// cleaned (#2362). Shared by the scan (which fetches only the chosen bodies) and `summarise`.
import { htmlToPlainText, type NylasMessageSummary } from '../../channels/email/ceo-nylas-client.js';
import { compareStrings, normaliseAddress } from './summary-util.js';

/** Longest voice-sample body kept, in characters, after HTML and quoted text are stripped. */
export const VOICE_BODY_MAX_CHARS = 4000;

/** A forward: subject starts `Fwd:`, `Fw:` or `FW:` (any case). */
export function isForward(subject: string): boolean {
  return /^\s*fwd?\s*:/i.test(subject);
}

/** The first recipient (To, then Cc) who is not the principal; '' when there is none. */
export function firstOutsideRecipient(
  msg: Pick<NylasMessageSummary, 'to' | 'cc'>,
  principal: ReadonlySet<string>,
): string {
  for (const p of [...msg.to, ...msg.cc]) {
    const email = normaliseAddress(p.email);
    if (email !== '' && !principal.has(email)) return email;
  }
  return '';
}

/**
 * Up to `n` of the principal's sent messages for the voice sample. Forwards (mostly someone
 * else's words) and mail to no one but the principal are skipped. Newest first, one message per
 * distinct first recipient, then the remaining messages newest first to fill up to `n`.
 */
export function pickVoiceCandidates<T extends NylasMessageSummary>(
  sent: readonly T[],
  principal: ReadonlySet<string>,
  n: number,
): T[] {
  const eligible = sent
    .filter((m) => !isForward(m.subject) && firstOutsideRecipient(m, principal) !== '')
    .sort((a, b) => b.date - a.date || compareStrings(a.id, b.id));
  const seenIds = new Set<string>();
  const unique: T[] = [];
  for (const m of eligible) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    unique.push(m);
  }
  const seenRecipients = new Set<string>();
  const first: T[] = [];
  const rest: T[] = [];
  for (const m of unique) {
    const to = firstOutsideRecipient(m, principal);
    if (seenRecipients.has(to)) {
      rest.push(m);
    } else {
      seenRecipients.add(to);
      first.push(m);
    }
  }
  return [...first, ...rest].slice(0, Math.max(0, n));
}

/**
 * Drops quoted history so the sample is the principal's own words: cuts at the first reply or
 * forward header ("On … wrote:", "-----Original Message-----", "---------- Forwarded message",
 * an Outlook "From:" line followed by "Sent:"/"Date:") and removes lines starting with `>`.
 */
export function stripQuotedText(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const next = (lines[i + 1] ?? '').trim();
    if (/^On\s.{0,300}wrote:$/i.test(line)) break;
    if (/^-{2,}\s*(original message|forwarded message)\s*-*$/i.test(line)) break;
    if (/^From:\s/i.test(line) && /^(Sent|Date):\s/i.test(next)) break;
    if (line.startsWith('>')) continue;
    kept.push(lines[i]!.trimEnd());
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML stripped (the repo's `htmlToPlainText`), quoted text removed, capped at VOICE_BODY_MAX_CHARS. */
export function voiceBody(html: string): string {
  return stripQuotedText(htmlToPlainText(html)).slice(0, VOICE_BODY_MAX_CHARS);
}
