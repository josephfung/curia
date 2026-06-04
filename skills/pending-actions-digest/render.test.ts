// render.test.ts — unit + snapshot tests for the pure digest renderer.
import { describe, it, expect } from 'vitest';
import { humanizeAge, formatDueDate } from './render.js';

// Fixed clock for deterministic spans. 2026-06-03T12:00:00.000Z.
const NOW_MS = Date.parse('2026-06-03T12:00:00.000Z');

describe('humanizeAge', () => {
  it('renders <1h for spans under an hour', () => {
    expect(humanizeAge('2026-06-03T11:30:00.000Z', NOW_MS)).toBe('<1h');
  });

  it('renders hours under a day', () => {
    expect(humanizeAge('2026-06-03T07:00:00.000Z', NOW_MS)).toBe('5h');
  });

  it('renders days under two weeks', () => {
    expect(humanizeAge('2026-05-31T12:00:00.000Z', NOW_MS)).toBe('3d');
  });

  it('renders weeks at and beyond 14 days', () => {
    expect(humanizeAge('2026-05-20T12:00:00.000Z', NOW_MS)).toBe('2w');
  });

  it('clamps future/zero spans to <1h', () => {
    expect(humanizeAge('2026-06-03T13:00:00.000Z', NOW_MS)).toBe('<1h');
  });
});

describe('formatDueDate', () => {
  it('renders the local date portion in the given timezone', () => {
    expect(formatDueDate('2026-06-06T13:00:00.000Z', 'UTC')).toBe('2026-06-06');
  });

  it('renders an em-dash placeholder for null', () => {
    expect(formatDueDate(null, 'UTC')).toBe('—');
  });

  it('shifts the date across timezone boundaries', () => {
    // 00:30 UTC on the 7th is still 20:30 on the 6th in Toronto (UTC-4 in June).
    expect(formatDueDate('2026-06-07T00:30:00.000Z', 'America/Toronto')).toBe('2026-06-06');
  });

  it('renders an em-dash for an invalid IANA timezone', () => {
    expect(formatDueDate('2026-06-06T13:00:00.000Z', 'Invalid/Zone')).toBe('—');
  });
});

import { renderDigestBody, type ApprovalInput } from './render.js';
import type { TaskListRow } from '../../src/db/task-repo.js';

// Minimal TaskListRow factory — only the fields renderDigestBody reads matter.
function task(overrides: Partial<TaskListRow>): TaskListRow {
  return {
    id: 'id', agentId: 'a', intentAnchor: 'i', status: 'open',
    progress: {}, errorBudget: {}, conversationId: null,
    createdAt: '2026-06-01T12:00:00.000Z', updatedAt: '2026-06-01T12:00:00.000Z',
    title: 'Untitled', description: null, owner: 'curia',
    waitingOnContactId: null, waitingOnText: null, parentTaskId: null,
    blockedByTaskId: null, priority: 50, dueAt: null, source: 'agent',
    sourceAgentId: null, createdBy: 'system', tags: [], nextWakeAt: null,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalInput>): ApprovalInput {
  return {
    description: 'Create event: Lunch', skillName: 'create-calendar-event',
    shortRef: 'cal-1', expiresAt: new Date(NOW_MS + 7_200_000), ...overrides,
  };
}

describe('renderDigestBody', () => {
  it('renders approvals only, byte-identical to the legacy format, when backlog empty', () => {
    const body = renderDigestBody({
      approvals: [approval({}), approval({ description: 'Send weekly update', skillName: 'send-email', shortRef: 'email-2' })],
      ceo: [], external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toBe(
      '• Create event: Lunch [create-calendar-event] — 2h remaining [cal-1]\n' +
      '• Send weekly update [send-email] — 2h remaining [email-2]',
    );
  });

  it('renders all three sections after the approvals block', () => {
    const body = renderDigestBody({
      approvals: [approval({})],
      ceo: [task({ owner: 'ceo', title: 'Review the Acme deck', dueAt: '2026-06-06T13:00:00.000Z', createdAt: '2026-05-31T12:00:00.000Z' })],
      external: [task({ owner: 'external', status: 'waiting', title: 'Signed NDA', waitingOnContactId: 'c1', createdAt: '2026-06-02T12:00:00.000Z' })],
      curia: [task({ owner: 'curia', title: 'Draft the board email', createdAt: '2026-06-03T07:00:00.000Z' })],
      resolveName: (id) => (id === 'c1' ? 'Steve Jobs' : undefined),
      nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toBe(
      '• Create event: Lunch [create-calendar-event] — 2h remaining [cal-1]\n' +
      '\n' +
      'For you to do:\n' +
      '• Review the Acme deck · due 2026-06-06 · age 3d\n' +
      '\n' +
      'Waiting on others:\n' +
      '• Signed NDA · waiting on Steve Jobs · since 1d\n' +
      '\n' +
      "What I'm working on:\n" +
      '• Draft the board email · age 5h',
    );
  });

  it('falls back to waiting_on_text then (unknown) for unresolved counterparties', () => {
    const body = renderDigestBody({
      approvals: [],
      ceo: [], curia: [],
      external: [
        task({ owner: 'external', status: 'waiting', title: 'A', waitingOnContactId: 'gone', waitingOnText: 'the lawyer' }),
        task({ owner: 'external', status: 'waiting', title: 'B', waitingOnContactId: null, waitingOnText: null }),
      ],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    expect(body).toContain('• A · waiting on the lawyer · since');
    expect(body).toContain('• B · waiting on (unknown) · since');
  });

  it('caps a section at 5 bullets and appends a +N more footer', () => {
    const ceo: TaskListRow[] = Array.from({ length: 9 }, (_, i) =>
      task({ owner: 'ceo', title: `T${i}`, createdAt: '2026-06-03T07:00:00.000Z' }),
    );
    const body = renderDigestBody({
      approvals: [], ceo, external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    });
    const lines = body.split('\n').filter((l) => l.startsWith('• '));
    expect(lines).toHaveLength(5);
    expect(body).toContain('+4 more');
  });

  it('returns an empty string when there is nothing to render', () => {
    expect(renderDigestBody({
      approvals: [], ceo: [], external: [], curia: [],
      resolveName: () => undefined, nowMs: NOW_MS, timezone: 'UTC',
    })).toBe('');
  });
});
