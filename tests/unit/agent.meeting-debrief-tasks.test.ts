// tests/unit/agent.meeting-debrief-tasks.test.ts
//
// Guards the #839 migration: meeting-debrief tracks debrief work as platform
// tasks (not bespoke pendingDebriefs/judgedEvents maps), runs detection 3x/day,
// and judges meetings YES/NO (no DEFER). Parses the agent YAML, asserts on its
// structure. Companion to agent.meeting-debrief-idempotency.test.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

let parsed: Record<string, unknown>;
let prompt: string;
let pinnedSkills: string[];

beforeAll(() => {
  const agentPath = path.resolve(import.meta.dirname, '../../agents/meeting-debrief.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(agentPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot load meeting-debrief.yaml from ${agentPath}: ${(err as Error).message}. ` +
      `Is the test running from the repo root?`,
    );
  }
  parsed = yaml.load(raw) as Record<string, unknown>;
  if (typeof parsed.system_prompt !== 'string') {
    throw new Error('meeting-debrief.yaml is missing a system_prompt string field');
  }
  prompt = parsed.system_prompt;
  pinnedSkills = (parsed.pinned_skills as string[]) ?? [];
});

describe('meeting-debrief tasks migration (#839)', () => {
  it('declares all three operating modes', () => {
    expect(prompt).toMatch(/Scheduled mode/);
    expect(prompt).toMatch(/Task wake-up mode/i);
    expect(prompt).toMatch(/Delegated mode/i);
  });

  it('pins the four task-* skills', () => {
    for (const skill of ['task-create', 'task-list', 'task-update', 'task-complete']) {
      expect(pinnedSkills).toContain(skill);
    }
  });

  it('no longer pins scheduler-report or scheduler-list', () => {
    expect(pinnedSkills).not.toContain('scheduler-report');
    expect(pinnedSkills).not.toContain('scheduler-list');
  });

  it('removes all bespoke state-map references from the prompt', () => {
    for (const token of [
      'pendingDebriefs',
      'judgedEvents',
      'deferredEvents',
      'lastScanTimestamp',
    ]) {
      expect(prompt).not.toContain(token);
    }
  });

  it('runs detection 3x/day via cron', () => {
    const schedule = parsed.schedule as Array<{ cron?: string }> | undefined;
    expect(schedule).toBeDefined();
    expect(schedule!.length).toBeGreaterThan(0);
    expect(schedule![0]!.cron).toBe('0 7,12,16 * * *');
  });

  it('creates no task for not-worthy meetings (guard-only)', () => {
    expect(prompt).toMatch(/seen:/);
    expect(prompt).toMatch(/[Cc]reate no task/);
  });

  it('keeps binary judgment with a YES lean and removes DEFER', () => {
    expect(prompt).toMatch(/lean YES/i);
    expect(prompt).not.toMatch(/\bDEFER\b/);
  });

  it('flips owner to ceo at the prompt wake', () => {
    expect(prompt).toMatch(/flips? to .?ceo/i);
  });

  it('declares a version field', () => {
    expect(typeof parsed.version).toBe('string');
  });
});
