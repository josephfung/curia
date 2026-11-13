// A `from: scheduler` scenario fires the agent with a copy of one of its `schedule:`
// payloads. Nothing ties the copy to the YAML, so a payload edit used to leave the cases
// testing the old text (#2378: the hourly ceo-inbox payload was copied into eight cases).
// Each such case must match one of its agent's declared payloads, whitespace aside.
//
// #2475 removed that hourly triage cron: the inbox heartbeat now creates a system-originated
// `inbox-drain` task and wakes ceo-inbox on it. Triage cases fire as that wake (`from:
// task-wake`), so they carry no payload copy; the checks below keep them on the heartbeat's
// shape instead.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import { loadScenarioCases } from '../../scenarios/loader.js';
import { INBOX_DRAIN_INTENT } from '../../../src/scheduler/inbox-heartbeat.js';

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

  it('finds the copied ceo-inbox payloads (sent-observe; triage has no cron since #2475)', () => {
    expect(scheduled.filter((c) => c.agent === 'ceo-inbox').length).toBeGreaterThan(0);
  });

  it('fires no ceo-inbox case with the retired hourly triage payload (#2475)', () => {
    const triageCron = scheduled.filter((c) => c.agent === 'ceo-inbox' && /tag 'inbox-drain'/.test(c.inbound.content));
    expect(triageCron.map((c) => c.name)).toEqual([]);
  });

  it('fires every inbox-drain wake as the heartbeat does: system-originated (#2475)', () => {
    const drains = cases.filter((c) => c.agent === 'ceo-inbox' && c.inbound.from === 'task-wake' && c.inbound.task?.tags?.includes('inbox-drain'));
    expect(drains.length).toBeGreaterThanOrEqual(13);
    expect(drains.filter((c) => c.inbound.task?.originator !== 'system').map((c) => c.name)).toEqual([]);
  });

  // BR-I4: a case's drain wake is the one InboxHeartbeat.tick creates, and its batch listing is
  // answered only in triage mode, so a run that lists without triage: true cannot pass.
  it('seeds each inbox-drain wake with the heartbeat\'s own task text and a triage-mode list stub (R66)', () => {
    const drains = cases.filter((c) => c.agent === 'ceo-inbox' && c.inbound.from === 'task-wake' && c.inbound.task?.tags?.includes('inbox-drain'));
    expect(drains.filter((c) => c.inbound.task?.intent !== INBOX_DRAIN_INTENT || c.inbound.task?.title !== 'Inbox drain').map((c) => c.name)).toEqual([]);
    const plainListAnswered = drains.filter((c) =>
      (c.toolStubs['ceo-inbox-list'] ?? []).some((s) => Object.keys(s.match).length === 0 && s.error === undefined));
    expect(plainListAnswered.map((c) => c.name)).toEqual([]);
    const noTriageStub = drains.filter((c) => !(c.toolStubs['ceo-inbox-list'] ?? []).some((s) => s.match['triage'] === true));
    expect(noTriageStub.map((c) => c.name)).toEqual([]);
  });

  it.each(scheduled.map((c) => [c.name, c] as const))('%s', (_name, scenario) => {
    const payloads = schedulePayloads(scenario.agent ?? 'coordinator');
    // Agents with no declared schedule (the coordinator's jobs come from scheduler-create)
    // have nothing to drift from.
    if (payloads.length === 0) return;
    expect(payloads).toContain(normalize(scenario.inbound.content));
  });
});
