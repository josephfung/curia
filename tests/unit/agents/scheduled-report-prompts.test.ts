// tests/unit/agents/scheduled-report-prompts.test.ts
//
// #1831 — scheduled-task prompts must name scheduler-report (not unbound "report"),
// route structured counts into context, set expectedDurationSeconds, and include an
// explicit negative list so pinned bullpen is not used as a delivery channel.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig, type AgentYamlConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

function scheduleEntryByCron(
  config: AgentYamlConfig,
  cron: string,
): { task: string; expectedDurationSeconds?: number } {
  const schedule = config.schedule;
  if (!schedule || schedule.length === 0) {
    throw new Error(`${config.name}: missing schedule`);
  }
  // Fail loudly if a second cron is added without coverage — do not silently
  // grab schedule[0] and leave the new entry untested.
  const matches = schedule.filter((e) => e.cron === cron);
  expect(matches).toHaveLength(1);
  const entry = matches[0]!;
  if (typeof entry.task !== 'string') {
    throw new Error(`${config.name}: schedule entry for ${cron} has no string task`);
  }
  return {
    task: entry.task,
    expectedDurationSeconds: entry.expectedDurationSeconds,
  };
}

describe('scheduled-task prompts name scheduler-report (#1831)', () => {
  it('calendar holds-sweep: names tool, context counts, negative list, duration, pin', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'calendar.yaml'));
    expect(config.pinned_skills).toContain('scheduler-report');
    expect(config.pinned_skills).toContain('bullpen'); // still available for consults
    expect(config.schedule).toHaveLength(1);

    const { task, expectedDurationSeconds } = scheduleEntryByCron(config, '0 1 * * *');
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/);
    expect(task).toMatch(/context set to/);
    expect(task).toMatch(/scanned, expired, failed, and calendarErrors/);
    expect(task).toMatch(/do NOT post to the bullpen/);
    expect(task).toMatch(/do NOT message the CEO/);
    expect(task).toMatch(/silent maintenance run/);
    expect(expectedDurationSeconds).toBe(120);
  });

  it('coordinator approval-expiry: names tool, context counts, negative list, duration', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    // Full scheduler bundle already includes scheduler-report
    expect(config.pinned_skills).toContain('scheduler');
    expect(config.schedule).toHaveLength(1);

    const { task, expectedDurationSeconds } = scheduleEntryByCron(config, '0 * * * *');
    expect(task).toMatch(/approval-expiry-sweep/);
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/);
    expect(task).toMatch(/context set to/);
    expect(task).toMatch(/expired and notified/);
    expect(task).toMatch(/do NOT post to the bullpen/);
    expect(task).toMatch(/silent maintenance run/);
    expect(expectedDurationSeconds).toBe(360);
  });

  it('meeting-debrief detection: names tool, context counts, negative list, duration, pin', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'meeting-debrief.yaml'));
    expect(config.pinned_skills).toContain('scheduler-report');
    expect(config.pinned_skills).not.toContain('scheduler-list');
    expect(config.pinned_skills).toContain('bullpen'); // still for task wake-up prompts
    expect(config.schedule).toHaveLength(1);

    const { task, expectedDurationSeconds } = scheduleEntryByCron(config, '0 7,12,16 * * *');
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/);
    expect(task).toMatch(/context set to/);
    expect(task).toMatch(/scanned, scheduled, and skipped/);
    expect(task).toMatch(/Whether or not any debriefs were scheduled, always call/);
    expect(task).toMatch(/do NOT post to the bullpen/);
    expect(task).toMatch(/do NOT prompt or message the CEO/);
    expect(task).toMatch(/silent maintenance run/);
    expect(expectedDurationSeconds).toBe(120);

    // Zero-candidate path must route through scheduler-report, not "simply exit"
    expect(config.system_prompt).toMatch(
      /If any step yields zero\s+candidates, skip to the `scheduler-report` call in Step 5 and exit/,
    );
    expect(config.system_prompt).not.toMatch(/simply exit/);
  });
});
