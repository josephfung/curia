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
// The list is everything after the colon up to the line end (a trailing \r is kept apart).
const MAILBOX_LINE_RE = /^([ \t]*[-*][ \t]*Mailbox[ \t]*:[ \t]*)([^\r\n]*?)([ \t]*)(\r?)$/im;

function sectionsOf(doc: string): Array<{ title: string; start: number; end: number }> {
  const heads = [...doc.matchAll(new RegExp(HEADING_RE.source, 'gm'))];
  return heads.map((m, i) => ({
    title: m[1]!,
    start: m.index!,
    end: i + 1 < heads.length ? heads[i + 1]!.index! : doc.length,
  }));
}

function parseIds(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

export function parseRuleScopes(doc: string): RuleScope[] {
  return sectionsOf(doc).map((s) => {
    const m = MAILBOX_LINE_RE.exec(doc.slice(s.start, s.end));
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
    const edited = section.replace(
      MAILBOX_LINE_RE,
      (_all, lead: string, _list: string, _trail: string, cr: string) => `${lead}${next.join(', ')}${cr}`,
    );
    out = out.slice(0, rule.start) + edited + out.slice(rule.end);
  }
  return out;
}
