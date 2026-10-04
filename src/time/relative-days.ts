// relative-days.ts — the bare relative day words, shared by date-resolve and the
// calendar brief check (#1986).
//
// Two places care about these words: the `date-resolve` tool resolves them to a date,
// and `delegate-brief-date-validation` refuses a calendar handoff that uses them
// without a date-resolve result from the same turn. Keeping one list means the check
// can never demand a resolution for a word the tool rejects (which is how "tomorrow"
// ended up blocked: the check knew the word, the tool did not).

/**
 * Day offset from today for each word. A Map rather than an object literal so an
 * input like "constructor" can't hit an inherited property.
 */
export const RELATIVE_DAY_OFFSETS: ReadonlyMap<string, number> = new Map([
  ['yesterday', -1],
  ['today', 0],
  ['tomorrow', 1],
]);
