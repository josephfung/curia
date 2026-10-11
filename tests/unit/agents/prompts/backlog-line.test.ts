// The backlog line on principal turns (prompt trim PR 7).

import { describe, expect, it } from 'vitest';
import {
  BACKLOG_INSTRUCTION_LINES,
  hasBacklog,
  parsePrincipalBacklog,
  renderBacklogLine,
} from '../../../../src/agents/prompts/backlog-line.js';

describe('renderBacklogLine', () => {
  it('renders nothing when nothing is waiting', () => {
    expect(renderBacklogLine({ decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 })).toBeNull();
  });

  it('names only the kinds with something waiting, each with the tool that lists it', () => {
    const line = renderBacklogLine({ decayWarnings: 0, pendingApprovals: 2, principalTasks: 0 })!;
    expect(line.split('\n')[0]).toBe('Waiting on the principal: 2 actions awaiting their approval (list-pending-actions).');
    expect(line).not.toContain('decay-warnings-list');
    expect(line).not.toContain('task-list');
  });

  it('lists every kind, singular where the count is one', () => {
    const first = renderBacklogLine({ decayWarnings: 1, pendingApprovals: 1, principalTasks: 3 })!.split('\n')[0];
    expect(first).toBe(
      'Waiting on the principal: 1 action awaiting their approval (list-pending-actions); '
      + '1 stored fact to re-confirm before archiving (decay-warnings-list); '
      + '3 open tasks they own (task-list: owner ceo, status open,in_progress,blocked,waiting).',
    );
  });

  it('ends with the fixed instruction', () => {
    const line = renderBacklogLine({ decayWarnings: 0, pendingApprovals: 0, principalTasks: 1 })!;
    expect(line.endsWith(BACKLOG_INSTRUCTION_LINES.join('\n'))).toBe(true);
  });
});

describe('hasBacklog', () => {
  it('is true when any count is positive', () => {
    expect(hasBacklog({ decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 })).toBe(false);
    expect(hasBacklog({ decayWarnings: 0, pendingApprovals: 0, principalTasks: 1 })).toBe(true);
    expect(hasBacklog({ decayWarnings: 1, pendingApprovals: 0, principalTasks: 0 })).toBe(true);
  });
});

describe('parsePrincipalBacklog', () => {
  it('keeps three non-negative integers', () => {
    expect(parsePrincipalBacklog({ decayWarnings: 1, pendingApprovals: 0, principalTasks: 2 }))
      .toEqual({ decayWarnings: 1, pendingApprovals: 0, principalTasks: 2 });
  });

  it('drops the whole value when any count is missing or not a count', () => {
    expect(parsePrincipalBacklog(undefined)).toBeNull();
    expect(parsePrincipalBacklog('3')).toBeNull();
    expect(parsePrincipalBacklog({ decayWarnings: 1, pendingApprovals: 0 })).toBeNull();
    expect(parsePrincipalBacklog({ decayWarnings: -1, pendingApprovals: 0, principalTasks: 0 })).toBeNull();
    expect(parsePrincipalBacklog({ decayWarnings: 1.5, pendingApprovals: 0, principalTasks: 0 })).toBeNull();
    expect(parsePrincipalBacklog({ decayWarnings: '1', pendingApprovals: 0, principalTasks: 0 })).toBeNull();
  });
});
