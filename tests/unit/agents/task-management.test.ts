import { describe, it, expect } from 'vitest';
import {
  applyTaskManagement,
  TASK_MANAGEMENT_SKILLS,
  TASK_MANAGEMENT_BLOCK,
} from '../../../src/agents/task-management.js';
import type { AgentYamlConfig } from '../../../src/agents/loader.js';

function cfg(overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig {
  return {
    name: 'test-agent',
    model: { tier: 'standard' },
    system_prompt: 'BASE PROMPT',
    ...overrides,
  };
}

describe('applyTaskManagement', () => {
  it('is a no-op when the flag is absent', () => {
    const r = applyTaskManagement(cfg(), 'BASE PROMPT', ['a', 'b']);
    expect(r.systemPrompt).toBe('BASE PROMPT');
    expect(r.pinnedSkills).toEqual(['a', 'b']);
    expect(r.heartbeatEligible).toBe(false);
  });

  it('is a no-op when the flag is explicitly false', () => {
    const r = applyTaskManagement(cfg({ enable_task_management: false }), 'BASE PROMPT', []);
    expect(r.systemPrompt).toBe('BASE PROMPT');
    expect(r.pinnedSkills).toEqual([]);
    expect(r.heartbeatEligible).toBe(false);
  });

  it('appends the block, adds the four skills, and marks eligible when true', () => {
    const r = applyTaskManagement(cfg({ enable_task_management: true }), 'BASE PROMPT', ['x']);
    expect(r.systemPrompt).toBe(`BASE PROMPT\n\n${TASK_MANAGEMENT_BLOCK}`);
    expect(r.pinnedSkills).toEqual(['x', ...TASK_MANAGEMENT_SKILLS]);
    expect(r.heartbeatEligible).toBe(true);
  });

  it('does not duplicate skills already pinned', () => {
    const base = ['task-list', 'other'];
    const r = applyTaskManagement(cfg({ enable_task_management: true }), 'P', base);
    // task-list kept once, the other three appended
    expect(r.pinnedSkills.filter((s) => s === 'task-list')).toHaveLength(1);
    expect(r.pinnedSkills).toEqual(['task-list', 'other', 'task-create', 'task-update', 'task-complete']);
  });

  it('exposes exactly the four task skills', () => {
    expect([...TASK_MANAGEMENT_SKILLS]).toEqual(['task-create', 'task-list', 'task-update', 'task-complete']);
  });
});
