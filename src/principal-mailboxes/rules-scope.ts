// Mailbox scope of the standing inbox rules (#2475, D1/D4). Pure text functions, no I/O:
// the caller reads and writes /shared/inbox/rules.md. A rule is a `## Title` section; an
// optional `- Mailbox: <id>[, <id>]` line scopes it, and no such line means every mailbox.
// Everything outside the edited sections is left byte-for-byte as it was.

export interface RuleScope {
  title: string;
  /** Mailbox ids the rule is scoped to; null = applies to every mailbox. */
  mailboxes: string[] | null;
  /** Offset of the section's `##` line. */
  start: number;
  /** Offset just past the section (the start of the next `##` line, or the document's end). */
  end: number;
}

export type RuleRemovalAction = 'delete' | { rescopeTo: string };

const HEADING_RE = /^##[ \t]+(.+?)[ \t]*\r?$/gm;
// A top-level `- Mailbox:` bullet (no indent: a nested bullet inside a multi-line Do: is text, SEC-L8).
// The list is everything after the colon up to the line end (a trailing \r is kept apart).
const MAILBOX_LINE_RE = /^([-*][ \t]*Mailbox[ \t]*:[ \t]*)([^\r\n]*?)([ \t]*)(\r?)$/gim;
const FENCE_RE = /^[ \t]{0,3}(```|~~~)/;

/** [start, end) offsets of fenced code blocks; an unclosed fence runs to the end (SEC-L8). */
function fencedRanges(doc: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open: { at: number; marker: string } | null = null;
  let offset = 0;
  for (const line of doc.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (!open) open = { at: offset, marker: m[1]! };
      else if (m[1] === open.marker) {
        ranges.push([open.at, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.at, doc.length]);
  return ranges;
}

const inside = (ranges: Array<[number, number]>, at: number): boolean => ranges.some(([s, e]) => at >= s && at < e);

function sectionsOf(doc: string): Array<{ title: string; start: number; end: number }> {
  const fences = fencedRanges(doc);
  const heads = [...doc.matchAll(new RegExp(HEADING_RE.source, 'gm'))].filter((m) => !inside(fences, m.index!));
  return heads.map((m, i) => ({
    title: m[1]!,
    start: m.index!,
    end: i + 1 < heads.length ? heads[i + 1]!.index! : doc.length,
  }));
}

/** The section's first top-level Mailbox line outside fenced code, with its offset in the section. */
function mailboxLine(section: string): RegExpExecArray | null {
  const fences = fencedRanges(section);
  for (const m of section.matchAll(new RegExp(MAILBOX_LINE_RE.source, 'gim'))) {
    if (!inside(fences, m.index!)) return m as RegExpExecArray;
  }
  return null;
}

function parseIds(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

export function parseRuleScopes(doc: string): RuleScope[] {
  return sectionsOf(doc).map((s) => {
    const m = mailboxLine(doc.slice(s.start, s.end));
    const ids = m ? parseIds(m[2]!) : [];
    return { ...s, mailboxes: ids.length > 0 ? [...new Set(ids)] : null };
  });
}

/**
 * Apply a mailbox removal to the rules document. A rule scoped to several mailboxes just
 * loses the removed id; a rule scoped only to it is deleted or rescoped. Rules with no
 * Mailbox line are never touched.
 */
export function applyRemoval(doc: string, removedId: string, action: RuleRemovalAction): string {
  const hits = parseRuleScopes(doc).filter((r) => r.mailboxes?.includes(removedId));
  let out = doc;
  // Back to front, so earlier offsets stay valid.
  for (const rule of hits.reverse()) {
    const remaining = rule.mailboxes!.filter((id) => id !== removedId);
    if (remaining.length === 0 && action === 'delete') {
      out = out.slice(0, rule.start) + out.slice(rule.end);
      continue;
    }
    const next = remaining.length === 0 ? [(action as { rescopeTo: string }).rescopeTo] : remaining;
    const section = out.slice(rule.start, rule.end);
    const m = mailboxLine(section)!;
    const [all, lead, , , cr] = m as unknown as [string, string, string, string, string];
    const edited = section.slice(0, m.index) + `${lead}${next.join(', ')}${cr}` + section.slice(m.index + all.length);
    out = out.slice(0, rule.start) + edited + out.slice(rule.end);
  }
  return out;
}
