// tests/unit/agents/scheduled-report-prompts.test.ts
//
// #1831 — scheduled-task prompts must name scheduler-report (not unbound "report"),
// route structured counts into context, set expectedDurationSeconds, and include an
// explicit negative list so pinned bullpen is not used as a delivery channel.

import { describe, it, expect } from 'vitest';
import { loadAgentConfig } from '../../../src/agents/loader.js';
import * as path from 'node:path';

const agentsDir = path.resolve(import.meta.dirname, '../../../agents');

function loadScheduleTask(agentFile: string): { task: string; expectedDurationSeconds?: number } {
  const config = loadAgentConfig(path.join(agentsDir, agentFile));
  const schedule = config.schedule;
  if (!schedule || schedule.length === 0) {
    throw new Error(`${agentFile}: missing schedule`);
  }
  const entry = schedule[0]!;
  if (typeof entry.task !== 'string') {
    throw new Error(`${agentFile}: schedule[0].task must be a string`);
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

    const { task, expectedDurationSeconds } = loadScheduleTask('calendar.yaml');
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/i);
    expect(task).toMatch(/context/);
    expect(task).toMatch(/scanned/);
    expect(task).toMatch(/expired/);
    expect(task).toMatch(/failed/);
    expect(task).toMatch(/calendarErrors/);
    expect(task).toMatch(/do NOT post to the bullpen/i);
    expect(task).toMatch(/do NOT message the CEO/i);
    expect(task).toMatch(/silent maintenance run/i);
    expect(expectedDurationSeconds).toBe(60);
  });

  it('coordinator approval-expiry: names tool, context counts, negative list, duration', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'coordinator.yaml'));
    // Full scheduler bundle already includes scheduler-report
    expect(config.pinned_skills).toContain('scheduler');

    const { task, expectedDurationSeconds } = loadScheduleTask('coordinator.yaml');
    expect(task).toMatch(/approval-expiry-sweep/);
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/i);
    expect(task).toMatch(/context/);
    expect(task).toMatch(/expired/);
    expect(task).toMatch(/notified/);
    expect(task).toMatch(/do NOT post to the bullpen/i);
    expect(task).toMatch(/silent maintenance run/i);
    expect(expectedDurationSeconds).toBe(360);
  });

  it('meeting-debrief detection: names tool, context counts, negative list, duration, pin', () => {
    const config = loadAgentConfig(path.join(agentsDir, 'meeting-debrief.yaml'));
    expect(config.pinned_skills).toContain('scheduler-report');
    expect(config.pinned_skills).not.toContain('scheduler-list');
    expect(config.pinned_skills).toContain('bullpen'); // still for task wake-up prompts

    const { task, expectedDurationSeconds } = loadScheduleTask('meeting-debrief.yaml');
    expect(task).toMatch(/scheduler-report/);
    expect(task).toMatch(/exactly once/i);
    expect(task).toMatch(/context/);
    expect(task).toMatch(/scanned/);
    expect(task).toMatch(/scheduled/);
    expect(task).toMatch(/skipped/);
    expect(task).toMatch(/do NOT post to the bullpen/i);
    expect(task).toMatch(/do NOT prompt or\s+message the CEO/i);
    expect(task).toMatch(/silent maintenance run/i);
    expect(expectedDurationSeconds).toBe(120);
  });
});
