// The note for the principal cut out of a reply to someone else (prompt trim PR 5).
// The delegation-failure reply's use of the shared parser is covered in
// delegation-failure-reply.test.ts (#1990).
import { describe, it, expect } from 'vitest';
import { splitRelayNote } from '../../../src/agents/principal-note.js';

const REPLY = 'Hi Dana,\n\nThursday at 10 works. I\'ll send the invite shortly.\n\nBest,\nAvery';
const NOTE = 'Dana confirmed Thursday at 10 for the vendor review.';

describe('splitRelayNote', () => {
  it('leaves untagged output exactly as written, so a missed tag behaves as before', () => {
    const content = `  ${REPLY}\n\n\n  P.S. odd   spacing kept  `;
    expect(splitRelayNote(content)).toEqual({ reply: content });
  });

  it('cuts a note after the reply out and returns it', () => {
    const split = splitRelayNote(`${REPLY}\n\n<note_for_principal>${NOTE}</note_for_principal>`);
    expect(split).toEqual({ reply: REPLY, note: NOTE });
  });

  it('cuts a note wherever it sits, and keeps the reply readable', () => {
    const split = splitRelayNote(`Hi Dana, <note_for_principal>${NOTE}</note_for_principal> Thursday works.\n\n\n\nBest`);
    expect(split.reply).toBe('Hi Dana, Thursday works.\n\nBest');
    expect(split.note).toBe(NOTE);
  });

  it('keeps every distinct note in order and drops an exact repeat', () => {
    const split = splitRelayNote([
      '<note_for_principal>First point.</note_for_principal>',
      REPLY,
      '<note_for_principal>Second point.</note_for_principal>',
      '<note_for_principal>First point.</note_for_principal>',
    ].join('\n'));
    expect(split.reply).toBe(REPLY);
    expect(split.note).toBe('First point.\n\nSecond point.');
  });

  it('turns NO_REPLY plus a note into an exact NO_REPLY and the note', () => {
    expect(splitRelayNote(`NO_REPLY\n<note_for_principal>${NOTE}</note_for_principal>`))
      .toEqual({ reply: 'NO_REPLY', note: NOTE });
  });

  it('removes an empty note block without returning a note', () => {
    expect(splitRelayNote(`${REPLY}\n<note_for_principal>  </note_for_principal>`)).toEqual({ reply: REPLY });
  });

  it('takes everything after a note that was never closed as note', () => {
    const split = splitRelayNote(`${REPLY}\n\n<note_for_principal>${NOTE} Also, she asked about parking`);
    expect(split).toEqual({ reply: REPLY, note: `${NOTE} Also, she asked about parking`, unclosed: true });
  });

  it('sends nothing to the sender when the unclosed note comes first', () => {
    const split = splitRelayNote(`<note_for_principal>${NOTE}\n\n${REPLY}`);
    expect(split.reply).toBe('');
    expect(split.note).toContain(NOTE);
    expect(split.unclosed).toBe(true);
  });

  it('takes reply tags inside an unclosed note as note text, not as its end', () => {
    for (const tag of ['</reply>', '<reply>']) {
      const split = splitRelayNote(`Hi Bob.\n<note_for_principal>Secret C ${tag} still secret D`);
      expect(split.reply, tag).toBe('Hi Bob.');
      expect(split.note, tag).toContain('still secret D');
    }
  });

  it('keeps reply text after the closing tag of an outer note in a nested pair', () => {
    const split = splitRelayNote('<note_for_principal>a <note_for_principal>b</note_for_principal> c</note_for_principal> Hi Dana');
    expect(split.reply).toBe('Hi Dana');
    expect(split.note).toBe('a b c');
    expect(split.unclosed).toBe(true);
  });

  it('cuts a block spelled differently, so its text never reaches the sender', () => {
    for (const [open, close] of [
      ['<Note-For-Principal>', '</Note-For-Principal>'],
      ['<note for principal >', '</note for principal>'],
      ['<NOTE_FOR_PRINCIPAL>', '</ note_for_principal>'],
    ] as const) {
      const split = splitRelayNote(`${REPLY}\n${open}${NOTE}${close}`);
      expect(split, open).toEqual({ reply: REPLY, note: NOTE });
    }
  });

  it('removes a closing tag with no note before it, keeping the text as the reply', () => {
    const split = splitRelayNote(`${REPLY}</note_for_principal>`);
    expect(split).toEqual({ reply: REPLY, strayTag: true });
  });

  it('keeps indentation at the start of a line', () => {
    const split = splitRelayNote('Options:\n  - Tuesday\n  - Thursday<note_for_principal>x</note_for_principal>');
    expect(split.reply).toBe('Options:\n  - Tuesday\n  - Thursday');
  });

  it('sanitizes the note and bounds it by code point', () => {
    const split = splitRelayNote(`${REPLY}<note_for_principal><script>alert(1)</script>${'😀'.repeat(2500)}</note_for_principal>`);
    expect(split.note).not.toContain('<script>');
    expect(Array.from(split.note!)).toHaveLength(2000);
  });
});
