// A `from: scheduler` scenario fires the agent with a copy of one of its `schedule:`
// payloads. Nothing ties the copy to the YAML, so a payload edit used to leave the cases
// testing the old text (#2378: the hourly ceo-inbox payload is copied into eight cases).
// Each such case must match one of its agent's declared payloads, whitespace aside.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { loadScenarioCases } from '../../scenarios/loader.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const cases = loadScenarioCases(path.join(ROOT, 'tests/scenarios/cases'));

// A payload's `${principal_contact_id}` is filled by the scheduler at fire time; a case
// spells the same placeholder `{{principal_contact_id}}` for the harness to fill.
const normalize = (text: string): string =>
  text.replace(/\$\{(\w+)\}/g, '{{$1}}').replace(/\s+/g, ' ').trim();

function schedulePayloads(agent: string): string[] {
  const file = path.join(ROOT, 'agents', `${agent}.yaml`);
  if (!fs.existsSync(file)) return [];
  return (loadAgentConfig(file).schedule ?? []).map((entry) => normalize(entry.task));
}

describe('scheduler scenario payloads match the agent YAML', () => {
  const scheduled = cases.filter((c) => c.inbound.from === 'scheduler');

  it('finds the copied ceo-inbox payloads', () => {
    expect(scheduled.filter((c) => c.agent === 'ceo-inbox').length).toBeGreaterThan(0);
  });

  it.each(scheduled.map((c) => [c.name, c] as const))('%s', (_name, scenario) => {
    const payloads = schedulePayloads(scenario.agent ?? 'coordinator');
    // Agents with no declared schedule (the coordinator's jobs come from scheduler-create)
    // have nothing to drift from.
    if (payloads.length === 0) return;
    expect(payloads).toContain(normalize(scenario.inbound.content));
  });
});
