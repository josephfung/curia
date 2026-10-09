// scheduling-email.ts — lift calendar's composed email out of its reply (#2055).
//
// The calendar specialist returns email it composed in a <scheduling_email> block for the
// coordinator to send. The execution layer strips every tag from a skill result, so left in
// the text the block reaches the coordinator as bare prose with no sign it is a draft. The
// delegate skill pulls it out first and returns it as structured `draft_emails`.

export interface SchedulingEmailDraft {
  subject?: string;
  body: string;
}

const OPEN = '<scheduling_email';
const CLOSE = '</scheduling_email>';
const SUBJECT = /\bsubject\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** Index of the `>` that ends the open tag starting at `from`, skipping quoted attribute values
 *  (a subject like "Q3 > Q4" must not end the tag). -1 when there is none. */
function openTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** Drafts in order of appearance, and the text with each block removed. */
export function extractSchedulingEmails(text: string): { drafts: SchedulingEmailDraft[]; text: string } {
  const drafts: SchedulingEmailDraft[] = [];
  let rest = '';
  let cursor = 0;
  // indexOf scanning rather than one regex: model output is untrusted, and a lazy
  // multi-line match over it can backtrack polynomially.
  for (;;) {
    const open = text.indexOf(OPEN, cursor);
    if (open === -1) break;
    const tagEnd = openTagEnd(text, open + OPEN.length);
    const close = tagEnd === -1 ? -1 : text.indexOf(CLOSE, tagEnd + 1);
    if (close === -1) break;
    const attrs = text.slice(open + OPEN.length, tagEnd);
    // `<scheduling_emails>` or similar is not this block.
    if (attrs !== '' && !/^\s/.test(attrs)) {
      rest += text.slice(cursor, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }
    const subjectMatch = SUBJECT.exec(attrs);
    const subject = subjectMatch?.[1] ?? subjectMatch?.[2];
    drafts.push({ ...(subject !== undefined && { subject }), body: text.slice(tagEnd + 1, close).trim() });
    rest += text.slice(cursor, open);
    cursor = close + CLOSE.length;
  }
  if (drafts.length === 0) return { drafts, text };
  return { drafts, text: rest + text.slice(cursor) };
}
