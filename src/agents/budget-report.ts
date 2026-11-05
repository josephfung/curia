// src/agents/budget-report.ts — make a budget failure explain itself (ADR-046).
//
// A budget test that only says "expected 3,412 to be <= 3,200" sends the author on a
// hunt for what grew. These helpers turn a measurement into the message that answers
// it: measured against limit with units, the overage, the largest contributors, and
// the command that prints everything.
//
// Pure formatting only. prompt-budget.ts produces the contributor lists, and the
// callers (tests/unit/agents/prompt-budget.test.ts here, scripts/check-agent-budgets.mjs
// in curia-deploy) own the budgets, which this file never reads or changes.

/** One named slice of a measured total, in the same unit as the budget it counts toward. */
export interface Contributor {
  name: string;
  size: number;
}

export type BudgetUnit = 'tokens' | 'bytes';

export interface BudgetFailure {
  agent: string;
  /** What was measured, as a noun phrase: "the always-on prompt". */
  what: string;
  unit: BudgetUnit;
  measured: number;
  limit: number;
  contributors: Contributor[];
  /** The exact command that prints the full breakdown. */
  command: string;
  /** Where to move the content instead of raising the budget. */
  advice: string;
  /** How many contributors to list. Default 5. */
  top?: number;
}

const TOP_DEFAULT = 5;

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%';
}

/** The largest contributors first; ties keep their input order so output is stable. */
export function topContributors(contributors: Contributor[], count = TOP_DEFAULT): Contributor[] {
  return contributors
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.size - a.c.size || a.index - b.index)
    .slice(0, count)
    .map(({ c }) => c);
}

/**
 * The full breakdown, every contributor, largest first. Printed by the breakdown
 * command and reused for the short list in a failure.
 */
export function formatContributorTable(contributors: Contributor[], unit: BudgetUnit, measured: number): string {
  const rows = topContributors(contributors, contributors.length);
  const width = Math.max(1, ...rows.map((r) => n(r.size).length));
  return rows
    .map((r) => `  ${n(r.size).padStart(width)} ${unit}  ${percent(r.size, measured).padStart(6)}  ${r.name}`)
    .join('\n');
}

/**
 * The failure message for one over-budget measurement. The first line keeps the
 * `<agent>: <what> is <measured> ..., over its budget of <limit>` shape that
 * curia-deploy's negative control greps for.
 */
export function formatBudgetFailure(f: BudgetFailure): string {
  const over = f.measured - f.limit;
  const top = topContributors(f.contributors, f.top ?? TOP_DEFAULT);
  const lines = [
    `${f.agent}: ${f.what} is ${n(f.measured)} ${f.unit}, over its budget of ${n(f.limit)} ${f.unit} ` +
      `by ${n(over)} ${f.unit} (${percent(over, f.limit)} over).`,
  ];
  if (top.length > 0) {
    const listed = top.reduce((sum, c) => sum + c.size, 0);
    lines.push(
      `Largest contributors (${top.length} of ${f.contributors.length}, ${n(listed)} ${f.unit} ` +
        `= ${percent(listed, f.measured)} of the total):`,
      formatContributorTable(top, f.unit, f.measured),
    );
  }
  lines.push(`Full breakdown: ${f.command}`, f.advice);
  return lines.join('\n');
}

/**
 * Split markdown into its headed sections so a prompt overage can name the section
 * that grew. Headings inside code fences are text, not boundaries. Text before the
 * first heading is the section `(intro)`. Sizes are characters, heading line included.
 */
export function splitMarkdownSections(text: string): Array<{ heading: string; chars: number }> {
  const sections: Array<{ heading: string; chars: number }> = [];
  let current = { heading: '(intro)', chars: 0 };
  let inFence = false;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const eol = index < lines.length - 1 ? 1 : 0;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^#{1,6}\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      if (current.chars > 0) sections.push(current);
      current = { heading: heading[1] ?? line, chars: 0 };
    }
    current.chars += line.length + eol;
  });
  if (current.chars > 0) sections.push(current);
  return sections;
}
