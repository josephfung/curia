// tag-chars.ts — Unicode tag character (U+E0000–U+E007F) stripping.
//
// Tag characters are invisible in rendered text but legible to an LLM: each
// one encodes an ASCII character (codepoint − 0xE0000). That is the "ASCII
// smuggling" injection — a hidden instruction rides inside an email, a
// forwarded document, or a tool result, unseen by the human reader but read
// by the model (#2093). Nothing benign needs these characters in prose, so
// the inbound scanner and skill-output sanitizer both remove them.
//
// One legitimate use survives: subdivision flags. England, Scotland and
// Wales are written as U+1F3F4 (waving black flag) followed by tag letters
// spelling the subdivision code (e.g. "gbeng") and U+E007F CANCEL TAG.
// Well-formed sequences like that are kept whole; a tag run that is not a
// complete flag sequence is stripped.

export interface TagCharStripResult {
  /** The text with tag characters removed (subdivision flags preserved). */
  text: string;
  /**
   * The printable ASCII the stripped characters decode to, concatenated in
   * order of appearance — i.e. the hidden text, made visible for audit
   * records. Empty when nothing was stripped or the stripped characters
   * decode only to non-printable values.
   */
  decoded: string;
  /** How many tag characters were removed. */
  strippedCount: number;
}

// A well-formed subdivision flag (base + tag letters + CANCEL TAG), or any
// single tag character. The flag alternative is tried first at each
// position, so a complete flag is consumed whole and kept; anything else
// tag-shaped is consumed one character at a time and dropped.
const FLAG_OR_TAG_CHAR =
  /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|[\u{E0000}-\u{E007F}]/gu;

const TAG_BLOCK_OFFSET = 0xE0000;
const PRINTABLE_ASCII_MIN = 0x20;
const PRINTABLE_ASCII_MAX = 0x7e;

/**
 * Remove Unicode tag characters from *text*, preserving well-formed
 * subdivision flag sequences, and report what was hidden in them.
 */
export function stripTagCharacters(text: string): TagCharStripResult {
  let strippedCount = 0;
  const decoded: string[] = [];

  const cleaned = text.replace(FLAG_OR_TAG_CHAR, (match) => {
    // Well-formed subdivision flag — the only match longer than one code
    // point that starts with the flag base. Keep it intact.
    if (match.codePointAt(0) === 0x1f3f4) return match;

    strippedCount += 1;
    const ascii = (match.codePointAt(0) ?? 0) - TAG_BLOCK_OFFSET;
    if (ascii >= PRINTABLE_ASCII_MIN && ascii <= PRINTABLE_ASCII_MAX) {
      decoded.push(String.fromCharCode(ascii));
    }
    return '';
  });

  return { text: cleaned, decoded: decoded.join(''), strippedCount };
}
