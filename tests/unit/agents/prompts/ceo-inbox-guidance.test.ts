// ceo-inbox's task-wake steps by tag (#2025, ADR-046 rung 2). The consult-timeout,
// inbox-drain and inbox-follow-up steps used to sit in agents/ceo-inbox.yaml on every
// turn; the scheduler now adds the matching steps to that task's wake body. These tests
// pin the mechanism (who gets the text, and when), and that the YAML no longer restates it.
// Branch A (the consult-reply steps) stays in the YAML: moving it onto the consult-reply
// wake was A/B'd and left out.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../../../../src/agents/loader.js';
import { CEO_INBOX_WAKE_GUIDANCE, ceoInboxWakeGuidance } from '../../../../src/agents/prompts/ceo-inbox-wake-guidance.js';
import { formatTaskWakeContent, WAKE_DISPOSITION_INSTRUCTION } from '../../../../src/scheduler/wake-disposition.js';

describe('task-wake steps by tag', () => {
  it('a ceo-inbox task with one of its tags carries that tag\'s steps', () => {
    expect(ceoInboxWakeGuidance('ceo-inbox', ['consult-timeout'])).toBe(CEO_INBOX_WAKE_GUIDANCE['consult-timeout']);
    expect(ceoInboxWakeGuidance('ceo-inbox', ['inbox-drain'])).toBe(CEO_INBOX_WAKE_GUIDANCE['inbox-drain']);
    expect(ceoInboxWakeGuidance('ceo-inbox', ['x', 'inbox-follow-up'])).toBe(CEO_INBOX_WAKE_GUIDANCE['inbox-follow-up']);
  });

  it('consult-timeout wins over the other tags', () => {
    expect(ceoInboxWakeGuidance('ceo-inbox', ['inbox-follow-up', 'consult-timeout'])).toBe(CEO_INBOX_WAKE_GUIDANCE['consult-timeout']);
  });

  it('nothing for another agent, an untagged task, or another tag', () => {
    expect(ceoInboxWakeGuidance('coordinator', ['consult-timeout'])).toBeUndefined();
    expect(ceoInboxWakeGuidance(undefined, ['inbox-drain'])).toBeUndefined();
    expect(ceoInboxWakeGuidance('ceo-inbox', [])).toBeUndefined();
    expect(ceoInboxWakeGuidance('ceo-inbox', null)).toBeUndefined();
    expect(ceoInboxWakeGuidance('ceo-inbox', ['resumable'])).toBeUndefined();
  });

  it('a late CONSULT REPLY on a consult-timeout wake is handled with Branch A from the instructions', () => {
    expect(CEO_INBOX_WAKE_GUIDANCE['consult-timeout']).toContain('run Branch A in your instructions using that thread');
  });

  it('formatTaskWakeContent puts the steps before the disposition instruction', () => {
    const body = JSON.parse(formatTaskWakeContent(
      { taskId: 't', title: 'Drain principal inbox backlog', progress: null, agentId: 'ceo-inbox', tags: ['inbox-drain'] },
      { type: 'task-wake' },
    )) as Record<string, unknown>;
    expect(body['steps']).toBe(CEO_INBOX_WAKE_GUIDANCE['inbox-drain']);
    expect(Object.keys(body).at(-1)).toBe('instruction');
    expect(body['instruction']).toBe(WAKE_DISPOSITION_INSTRUCTION);

    const other = JSON.parse(formatTaskWakeContent(
      { taskId: 't', title: 'x', progress: null, agentId: 'coordinator', tags: ['inbox-drain'] },
      { type: 'task-wake' },
    )) as Record<string, unknown>;
    expect(other).not.toHaveProperty('steps');
  });
});

describe('agents/ceo-inbox.yaml keeps only the anchor for task wakes', () => {
  const prompt = loadAgentConfig(path.resolve(import.meta.dirname, '../../../../agents/ceo-inbox.yaml')).system_prompt;

  it('names the task-wake trigger where the resume cases are decided, and keeps Branch A', () => {
    expect(prompt).toContain('**Branch B — Task wakes:**');
    expect(prompt).toContain('**Branch A — Calendar consult reply');
  });

  it.each([
    ['the consult-timeout steps', 'Idempotent no-op (already resolved)'],
    ['the inbox-drain steps', 'batch-drain continuation'],
    ['the inbox-follow-up steps', 'resuming a deferred'],
  ])('does not restate %s', (_name, text) => {
    expect(prompt).not.toContain(text);
  });
});
