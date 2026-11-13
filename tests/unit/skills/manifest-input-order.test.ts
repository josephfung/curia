// Input order in tool manifests (#2475): required inputs first, optional ones after, and
// `mailbox` last. Models fill inputs by position as often as by name, so a required input
// that follows an optional one is easy to drop.
//
// Covers the ceo-inbox and calendar bundles. Every tool is in order since Task 31 of #2475,
// which reordered calendar-list-events; there is no allowlist.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');
const BUNDLES = ['ceo-inbox', 'calendar'];

/** "string? (...)", "string[]? (...)", "object[]? (...)" mark an optional input. */
function isOptional(spec: unknown): boolean {
  return typeof spec === 'string' && /^[^\s(]*\?(\s|$)/.test(spec);
}

function manifests(): Array<{ name: string; inputs: Array<[string, unknown]> }> {
  const out: Array<{ name: string; inputs: Array<[string, unknown]> }> = [];
  for (const bundle of BUNDLES) {
    const toolsDir = path.join(SKILLS_DIR, bundle, 'tools');
    for (const tool of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      const file = path.join(toolsDir, tool.name, 'tool.json');
      if (!tool.isDirectory() || !fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; inputs?: Record<string, unknown> };
      out.push({ name: json.name, inputs: Object.entries(json.inputs ?? {}) });
    }
  }
  return out;
}

/** Name of the first required input that follows an optional one, or null. */
function firstMisplacedRequired(inputs: Array<[string, unknown]>): string | null {
  let seenOptional = false;
  for (const [key, spec] of inputs) {
    if (isOptional(spec)) seenOptional = true;
    else if (seenOptional) return key;
  }
  return null;
}

describe('tool manifest input order', () => {
  const all = manifests();

  it('finds the ceo-inbox and calendar tools', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.map((m) => [m.name, m] as const))(
    '%s lists required inputs before optional ones',
    (_name, m) => {
      expect(firstMisplacedRequired(m.inputs)).toBeNull();
    },
  );

  it('puts mailbox last on every ceo-inbox and calendar tool, as an optional input', () => {
    for (const m of all.filter((x) => x.name.startsWith('ceo-inbox-') || x.name.startsWith('calendar-'))) {
      const keys = m.inputs.map(([k]) => k);
      expect(keys.at(-1), `${m.name} must end with mailbox`).toBe('mailbox');
      expect(isOptional(m.inputs.at(-1)![1]), `${m.name}: mailbox must be optional`).toBe(true);
    }
  });
});
