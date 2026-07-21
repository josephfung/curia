import { describe, it, expect } from 'vitest';
import {
  TASK_MANAGEMENT_TOOLS,
  TASK_MANAGEMENT_BLOCK,
} from '../../../src/agents/task-management.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task-management skill constants', () => {
  it('exposes exactly the four task tools', () => {
    expect([...TASK_MANAGEMENT_TOOLS]).toEqual([
      'task-create',
      'task-list',
      'task-update',
      'task-complete',
    ]);
  });

  it('SKILL.md body includes the task-management discipline block', () => {
    const skillMd = readFileSync(
      resolve(import.meta.dirname, '../../../skills/task-management/SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toContain('name: task-management');
    expect(skillMd).toContain('heartbeat: true');
    expect(skillMd).toContain('document_workspace: true');
    for (const tool of TASK_MANAGEMENT_TOOLS) {
      expect(skillMd).toContain(tool);
    }
    // Prose parity — the constant is the Task Management section of SKILL.md.
    expect(skillMd).toContain(TASK_MANAGEMENT_BLOCK);
  });
});
