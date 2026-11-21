// console-only-docs.ts — the `editable_by` frontmatter setting (#2360).
//
// A document whose frontmatter carries `editable_by: console` is edited only in the console (the
// documents API). doc-write refuses agents' writes to it; code that relies on a document being
// console-owned checks for the mark with isConsoleOnlyMarked.

/** Frontmatter key marking a document only the console edits: `editable_by: console`. */
export const EDITABLE_BY_KEY = 'editable_by';
/** The one value of the key. */
export const EDITABLE_BY_CONSOLE = 'console';

/** The document's `editable_by` value, the key matched case-insensitively; undefined when absent. */
export function editableBy(frontmatter: Record<string, unknown> | null | undefined): unknown {
  if (!frontmatter || typeof frontmatter !== 'object') return undefined;
  const key = Object.keys(frontmatter).find((k) => k.toLowerCase() === EDITABLE_BY_KEY);
  return key === undefined ? undefined : frontmatter[key];
}

/** Whether the frontmatter carries `editable_by: console` (value compared trimmed, case-insensitively). */
export function isConsoleOnlyMarked(frontmatter: Record<string, unknown> | null | undefined): boolean {
  const value = editableBy(frontmatter);
  return typeof value === 'string' && value.trim().toLowerCase() === EDITABLE_BY_CONSOLE;
}
