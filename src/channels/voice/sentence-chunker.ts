// sentence-chunker.ts — accumulate streamed text deltas and emit complete
// sentences for TTS as soon as they are terminated.
//
// The voice cascade needs to start speaking before the LLM has finished its
// whole reply, otherwise time-to-first-audio tracks the full generation
// latency. We buffer incoming deltas and flush a chunk whenever a sentence
// terminator (`.`, `!`, `?`) is followed by whitespace or the end of input.
// The remainder is flushed by flush() when the stream ends.

/** A sentence terminator followed by trailing whitespace marks a boundary. */
const SENTENCE_BOUNDARY = /[.!?]+["')\]]*\s/;

export class SentenceChunker {
  private buffer = '';

  /**
   * Feed a text delta. Returns any complete sentences that became available.
   * A single delta may complete zero, one, or several sentences.
   */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;

    const chunks: string[] = [];
    // Repeatedly slice off the earliest complete sentence. This is a naive
    // boundary: any terminator followed by whitespace commits a split, so
    // abbreviations like "Mr. Smith" DO get split ("Mr." then "Smith ...").
    // Acceptable for Phase 1 TTS chunking (worst case is a tiny extra pause);
    // there is no abbreviation list.
    for (;;) {
      const match = SENTENCE_BOUNDARY.exec(this.buffer);
      if (!match || match.index === undefined) break;
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) chunks.push(sentence);
    }
    return chunks;
  }

  /**
   * Flush the remaining buffered text (called once the stream ends). Returns
   * the trailing partial sentence, or null if nothing is buffered.
   */
  flush(): string | null {
    const remainder = this.buffer.trim();
    this.buffer = '';
    return remainder.length > 0 ? remainder : null;
  }

  /** Discard buffered text without emitting it (used on barge-in / abort). */
  reset(): void {
    this.buffer = '';
  }
}
