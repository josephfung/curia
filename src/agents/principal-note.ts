// A note for the principal inside a reply to someone else (#1990, prompt trim PR 5).
//
// A response that goes to a sender who is not the principal can carry a separate note
// for the principal in a <note_for_principal></note_for_principal> block. Code cuts every
// note out before the reply is read, so none of its text reaches the sender, and hands it
// on for the principal. Pointing the model at a place for the note is what works: told
// only "add no note for the principal", it wrote one anyway, inside the reply (#1990).
//
// Two readers:
//   - The delegation-failure reply (src/agents/delegation-failure-reply.ts). Its draft is
//     rejected outright when note markup is left in the reply, and a fallback is sent.
//   - The final response of any turn answering a sender who is not the principal
//     (splitRelayNote). That response has no fallback, so leftover markup is removed
//     instead, and text after a note that was never closed is treated as note.

import { sanitizeOutput } from '../skills/sanitize.js';

// A complete note block. A body never contains another opening tag, so an abandoned
// opener followed by a complete block yields only the latter.
const NOTE_BLOCK = /<note_for_principal>((?:(?!<note_for_principal>)[\s\S])*?)<\/note_for_principal>/gi;
/**
 * Any note tag left in a reply once complete blocks are cut out. Looser than the block
 * pattern on purpose: a variant spelling (`<note_for_principal >`, `<Note-For-Principal>`)
 * is not cut out, so it must be caught here or its text would reach the sender.
 * One whitespace run only (after the optional slash): two adjacent `\s*` around it would
 * backtrack quadratically on a long run of spaces.
 */
export const NOTE_TAG = /<\/?\s*note[\s_-]*for[\s_-]*principal\b[^>]*>/i;
// Every note tag, for stripping.
const NOTE_TAG_ALL = new RegExp(NOTE_TAG.source, 'gi');
// An opening tag left over once complete blocks are cut out: a note never closed, or the
// outer note of a nested pair (its inner block was cut out first).
const UNCLOSED_NOTE_OPEN = /<note_for_principal>/i;
// Where a leftover note's text ends: a reply tag, or the outer note's own closing tag.
const LEFTOVER_NOTE_END = /<\/?reply>|<\/note_for_principal>/i;

export interface PrincipalNoteSplit {
  /** The text with every complete note block replaced by one space. A leftover tag stays in it. */
  rest: string;
  /** Distinct non-empty note texts, trimmed, in source order. Not yet sanitized. */
  notes: string[];
  /**
   * Set when a note was opened and never closed, or is the outer note of a nested pair.
   * Its span in `rest`: from the opening tag to where its text ends, including the closing
   * tag when it has one. Its text is recovered into `notes`.
   */
  unclosed?: { start: number; end: number };
}

/**
 * Cut every note out of `raw` (#1990). Complete blocks go first, wherever they sit, so none
 * of their text can be read as the reply.
 *
 * Distinct non-empty blocks are all kept, in source order: two blocks may be two separate
 * points, and an exact repeat is dropped. A leftover opening tag is a note never closed
 * (most often cut off by the output limit, since it comes last) or the outer note of a
 * nested pair. Its text is recovered from the raw draft up to a reply tag, its own closing
 * tag, or the end, with any inner note tags stripped, so a nested note keeps its words in
 * the order written.
 */
export function splitPrincipalNotes(raw: string): PrincipalNoteSplit {
  let notes = [...raw.matchAll(NOTE_BLOCK)].map((m) => ({ at: m.index, text: (m[1] ?? '').trim() }));
  // The reply is read from `rest`, where each block becomes one space. `blanked` keeps
  // every block's length, so a position found in it is the same position in `raw`.
  const rest = raw.replace(NOTE_BLOCK, ' ');
  const blanked = raw.replace(NOTE_BLOCK, (block) => ' '.repeat(block.length));
  const open = UNCLOSED_NOTE_OPEN.exec(blanked);
  let unclosed: PrincipalNoteSplit['unclosed'];
  if (open) {
    const start = open.index + open[0].length;
    const tail = blanked.slice(start).search(LEFTOVER_NOTE_END);
    const end = tail >= 0 ? start + tail : raw.length;
    // Taken from `raw`, so an inner block keeps its place; the inner block itself is then
    // dropped as a separate entry, since its words are already in the recovered text.
    const recovered = raw.slice(start, end).replace(NOTE_TAG_ALL, ' ').trim();
    notes = notes.filter((n) => n.at < open.index || n.at >= end);
    notes.push({ at: open.index, text: recovered });
    // The same note in `rest`. Complete blocks before it are shorter there, so find it again.
    const restOpen = UNCLOSED_NOTE_OPEN.exec(rest)!;
    const restTail = rest.slice(restOpen.index + restOpen[0].length).search(LEFTOVER_NOTE_END);
    const restEnd = restTail < 0
      ? rest.length
      : endOfLeftoverNote(rest, restOpen.index + restOpen[0].length + restTail);
    unclosed = { start: restOpen.index, end: restEnd };
  }
  const ordered = notes.filter((n) => n.text.length > 0).sort((a, b) => a.at - b.at).map((n) => n.text);
  return { rest, notes: [...new Set(ordered)], ...(unclosed && { unclosed }) };
}

// A leftover note ends at its own closing tag (which belongs to it) or at a reply tag
// (which does not).
function endOfLeftoverNote(text: string, at: number): number {
  const closing = /^<\/note_for_principal>/i.exec(text.slice(at));
  return closing ? at + closing[0].length : at;
}

/** Bound a note by code point, so a cut never splits a surrogate pair. */
export function boundNote(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('').trim();
}

// A note on a relayed reply is delivered to the principal by email (prompt trim PR 5).
// Long enough for "who wrote, the subject, and what they said"; bounded because it is
// model-written text sent with no review.
const MAX_RELAY_NOTE = 2000;

export interface RelayNoteSplit {
  /** What goes to the sender. Byte-for-byte the input when it holds no note tag. */
  reply: string;
  /** The note for the principal, sanitized and bounded. Absent when there is none. */
  note?: string;
  /** A note was opened and never closed; everything after its opening tag was taken as note. */
  unclosed?: true;
  /** A closing tag with no note before it was left once blocks were cut out; removed. */
  strayTag?: true;
}

/**
 * Split the final response of a turn answering someone other than the principal into the
 * reply and the note for the principal (prompt trim PR 5).
 *
 * Untagged output is the whole reply, unchanged, so a missed tag behaves as it did before
 * notes existed. Otherwise every complete block is cut out. A note never closed takes the
 * rest of the response with it: what follows an opened note is more likely note than
 * reply, and a reply that loses its end is the safer failure. A variant spelling
 * (`<Note-For-Principal >`) is read as the tag itself first, so its block is cut out too.
 * A closing tag with no note before it is removed, so markup never reaches the sender; the
 * text before it stays in the reply, as an untagged note would.
 */
export function splitRelayNote(content: string): RelayNoteSplit {
  if (!NOTE_TAG.test(content)) return { reply: content };
  const canonical = content.replace(NOTE_TAG_ALL, (tag) => (/^<\s*\//.test(tag) ? '</note_for_principal>' : '<note_for_principal>'));
  const { rest, notes, unclosed } = splitPrincipalNotes(canonical);
  let reply = unclosed ? rest.slice(0, unclosed.start) + rest.slice(unclosed.end) : rest;
  const strayTag = NOTE_TAG.test(reply);
  if (strayTag) reply = reply.replace(NOTE_TAG_ALL, ' ');
  const note = notes.length > 0
    ? boundNote(tidy(sanitizeOutput(notes.join('\n\n'))), MAX_RELAY_NOTE)
    : '';
  return {
    reply: tidy(reply),
    ...(note.length > 0 && { note }),
    ...(unclosed && { unclosed: true as const }),
    ...(strayTag && { strayTag: true as const }),
  };
}

// A cut block leaves a space where it was, and often a blank line around it. Runs of
// spaces inside a line are collapsed; indentation at the start of a line is kept.
function tidy(text: string): string {
  return text
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
