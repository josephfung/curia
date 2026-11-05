// The message a failing budget test prints (src/agents/budget-report.ts). These tests
// pin its content, not its exact wording, so the next copy edit does not break them.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  formatBudgetFailure,
  formatContributorTable,
  splitMarkdownSections,
  topContributors,
  type BudgetFailure,
} from '../../../src/agents/budget-report.js';
import { measureAgentContext } from '../../../src/agents/prompt-budget.js';
import { renderBreakdown } from '../../../scripts/report-prompt-budget.js';

const failure: BudgetFailure = {
  agent: 'coordinator',
  what: 'the always-on prompt',
  unit: 'tokens',
  measured: 3_412,
  limit: 3_200,
  contributors: [
    { name: 'small', size: 10 },
    { name: 'yaml § Delegation', size: 1_402 },
    { name: 'yaml § Voice', size: 900 },
    { name: 'tasks SKILL.md § Wake', size: 700 },
    { name: 'yaml § Security', size: 200 },
    { name: 'yaml § Intro', size: 150 },
    { name: 'yaml § Tail', size: 50 },
  ],
  command: 'pnpm report:budget --agent coordinator',
  advice: 'Move it up the ladder.',
};

describe('formatBudgetFailure', () => {
  const message = formatBudgetFailure(failure);

  it('states measured against limit with units, and the overage', () => {
    expect(message).toContain('coordinator: the always-on prompt is 3,412 tokens, over its budget of 3,200 tokens');
    expect(message).toContain('by 212 tokens (6.6% over)');
  });

  it('lists the five largest contributors with sizes and shares, largest first', () => {
    const lines = message.split('\n');
    const listed = lines.filter((l) => /\d+ tokens\s+[\d.]+%/.test(l) && !l.startsWith('coordinator:'));
    expect(listed).toHaveLength(5);
    expect(listed[0]).toContain('1,402 tokens');
    expect(listed[0]).toContain('41.1%');
    expect(listed[0]).toContain('yaml § Delegation');
    expect(listed.map((l) => l.split('  ').pop())).toEqual([
      'yaml § Delegation',
      'yaml § Voice',
      'tasks SKILL.md § Wake',
      'yaml § Security',
      'yaml § Intro',
    ]);
    expect(message).toContain('5 of 7');
    expect(message).not.toContain('yaml § Tail');
  });

  it('names the exact command for the full breakdown and the advice', () => {
    expect(message).toContain('Full breakdown: pnpm report:budget --agent coordinator');
    expect(message).toContain('Move it up the ladder.');
  });

  it('keeps the first-line shape curia-deploy greps for', () => {
    expect(message.split('\n')[0]).toMatch(/^coordinator: the always-on prompt is /);
  });

  it('still reads when there are no contributors', () => {
    const bare = formatBudgetFailure({ ...failure, contributors: [] });
    expect(bare).toContain('over its budget of 3,200 tokens');
    expect(bare).not.toContain('Largest contributors');
    expect(bare).toContain('Full breakdown:');
  });

  it('honours a different list length', () => {
    const two = formatBudgetFailure({ ...failure, top: 2 });
    expect(two).toContain('2 of 7');
    expect(two).not.toContain('yaml § Security');
  });
});

describe('topContributors', () => {
  it('sorts descending and keeps input order on ties', () => {
    const sorted = topContributors(
      [
        { name: 'a', size: 5 },
        { name: 'b', size: 9 },
        { name: 'c', size: 5 },
      ],
      3,
    );
    expect(sorted.map((c) => c.name)).toEqual(['b', 'a', 'c']);
  });
});

describe('formatContributorTable', () => {
  it('right-aligns sizes and prints shares of the measured total', () => {
    const table = formatContributorTable(
      [
        { name: 'big', size: 12_000 },
        { name: 'tiny', size: 5 },
      ],
      'bytes',
      12_005,
    );
    expect(table.split('\n')).toEqual([
      '  12,000 bytes  100.0%  big',
      '       5 bytes    0.0%  tiny',
    ]);
  });
});

describe('splitMarkdownSections', () => {
  it('splits on headings, counting the heading line and a leading intro', () => {
    const text = 'intro\n## A\nline\n### B\nmore';
    expect(splitMarkdownSections(text)).toEqual([
      { heading: '(intro)', chars: 'intro\n'.length },
      { heading: 'A', chars: '## A\nline\n'.length },
      { heading: 'B', chars: '### B\nmore'.length },
    ]);
  });

  it('accounts for every character', () => {
    const text = '# One\nx\n## Two\nyy\n';
    expect(splitMarkdownSections(text).reduce((sum, s) => sum + s.chars, 0)).toBe(text.length);
  });

  it('does not split on a # line inside a code fence', () => {
    const text = '## A\n```bash\n# not a heading\n```\n## B\n';
    expect(splitMarkdownSections(text).map((s) => s.heading)).toEqual(['A', 'B']);
  });
});

describe('against the real agents', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const m = measureAgentContext('calendar', {
    agentsDir: resolve(root, 'agents'),
    skillsDir: resolve(root, 'skills'),
    configDir: resolve(root, 'config'),
  });

  it('measures contributors that add up to the totals', () => {
    const prompt = m.contributors.prompt.reduce((sum, c) => sum + c.size, 0);
    // Each section is rounded up to whole tokens, so the sum can exceed the total by at most one token per entry.
    expect(prompt).toBeGreaterThanOrEqual(m.alwaysOnPromptTokens - 5);
    expect(prompt).toBeLessThanOrEqual(m.alwaysOnPromptTokens + m.contributors.prompt.length);
    expect(m.contributors.tools.reduce((sum, c) => sum + c.size, 0)).toBe(m.localToolDefinitionBytes);
    expect(m.contributors.tools).toHaveLength(m.localToolCount);
  });

  it('turns an impossible budget into a message that names a real contributor', () => {
    const message = formatBudgetFailure({
      agent: 'calendar',
      what: 'the local tool definitions',
      unit: 'bytes',
      measured: m.localToolDefinitionBytes,
      limit: 1,
      contributors: m.contributors.tools,
      command: 'pnpm report:budget --agent calendar',
      advice: 'x',
    });
    expect(message).toContain('over its budget of 1 bytes');
    expect(message).toContain('calendar-update-event');
  });

  it('the breakdown command prints every tool and the prompt sections', () => {
    const out = renderBreakdown('calendar', m);
    expect(out).toContain('always-on prompt');
    expect(out).toContain('local tool definitions');
    for (const tool of m.localToolNames) expect(out).toContain(tool);
  });
});
