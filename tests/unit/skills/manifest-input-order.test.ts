// Input order in tool manifests (#2475): required inputs first, optional ones after, and
// `mailbox` last. Models fill inputs by position as often as by name, so a required input
// that follows an optional one is easy to drop.
//
// Covers the ceo-inbox and calendar bundles. Calendar tools listed in KNOWN_OUT_OF_ORDER
// are fixed by a later task and removed from the list then; the test also fails when an
// allowlisted tool is already in order, so the list cannot go stale.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');
const BUNDLES = ['ceo-inbox', 'calendar'];

// calendar-list-events is fixed in Task 31 of #2475.
const KNOWN_OUT_OF_ORDER = new Set<string>(['calendar-list-events']);

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

  it.each(all.filter((m) => !KNOWN_OUT_OF_ORDER.has(m.name)).map((m) => [m.name, m] as const))(
    '%s lists required inputs before optional ones',
    (_name, m) => {
      expect(firstMisplacedRequired(m.inputs)).toBeNull();
    },
  );

  it('keeps the allowlist honest: every allowlisted tool is still out of order', () => {
    for (const name of KNOWN_OUT_OF_ORDER) {
      const m = all.find((x) => x.name === name);
      expect(m, `${name} not found`).toBeDefined();
      expect(firstMisplacedRequired(m!.inputs), `${name} is in order; drop it from the allowlist`).not.toBeNull();
    }
  });

  it('puts mailbox last on every ceo-inbox tool, as an optional input', () => {
    for (const m of all.filter((x) => x.name.startsWith('ceo-inbox-'))) {
      const keys = m.inputs.map(([k]) => k);
      expect(keys.at(-1), `${m.name} must end with mailbox`).toBe('mailbox');
      expect(isOptional(m.inputs.at(-1)![1]), `${m.name}: mailbox must be optional`).toBe(true);
    }
  });
});
