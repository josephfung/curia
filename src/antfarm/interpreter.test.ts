import { describe, it, expect } from 'vitest';
import type { AuditEventRow } from '@curia/shared-types';
import { buildScript, busEventToAuditRow, interpretEvent } from './interpreter.js';

function row(overrides: Partial<AuditEventRow> & Pick<AuditEventRow, 'eventType'>): AuditEventRow {
  return {
    id: overrides.id ?? 'evt-1',
    timestamp: overrides.timestamp ?? '2026-07-02T12:00:00.000Z',
    eventType: overrides.eventType,
    sourceLayer: overrides.sourceLayer ?? 'agent',
    sourceId: overrides.sourceId ?? 'coordinator',
    conversationId: overrides.conversationId ?? 'conv-1',
    parentEventId: overrides.parentEventId ?? 'parent-1',
    payload: overrides.payload ?? {},
  };
}

describe('interpretEvent', () => {
  it('maps schedule.fired to claw.deliver', () => {
    const result = interpretEvent(row({
      eventType: 'schedule.fired',
      sourceLayer: 'system',
      payload: { jobId: 'job-1', agentId: 'calendar', agentTaskId: 'task-9' },
    }));
    expect(result).toMatchObject({
      kind: 'claw.deliver',
      id: 'evt-1',
      causedBy: 'parent-1',
      jobId: 'job-1',
      agentId: 'calendar',
      taskId: 'task-9',
    });
  });

  it('maps agent.task to agent.state active', () => {
    const result = interpretEvent(row({
      eventType: 'agent.task',
      payload: { agentId: 'research' },
    }));
    expect(result).toMatchObject({
      kind: 'agent.state',
      agentId: 'research',
      state: 'active',
    });
  });

  it('maps delegate tool.invoke to agent.walk and agent.speak', () => {
    const result = interpretEvent(row({
      eventType: 'tool.invoke',
      payload: {
        agentId: 'coordinator',
        toolName: 'delegate',
        input: { agent: 'research', task: 'Find the Q2 report' },
      },
    }));
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      expect.objectContaining({
        kind: 'agent.walk',
        agentId: 'coordinator',
        targetAgentId: 'research',
        id: 'evt-1',
        causedBy: 'parent-1',
      }),
      expect.objectContaining({
        kind: 'agent.speak',
        agentId: 'coordinator',
        content: 'Find the Q2 report',
      }),
    ]);
  });

  it('maps non-delegate tool.invoke to agent.think start', () => {
    const result = interpretEvent(row({
      eventType: 'tool.invoke',
      payload: { agentId: 'calendar', toolName: 'calendar-list-events', input: {} },
    }));
    expect(result).toMatchObject({
      kind: 'agent.think',
      agentId: 'calendar',
      phase: 'start',
      toolName: 'calendar-list-events',
    });
  });

  it('maps tool.result to agent.think stop', () => {
    const result = interpretEvent(row({
      eventType: 'tool.result',
      sourceLayer: 'execution',
      payload: { agentId: 'calendar', toolName: 'calendar-list-events' },
    }));
    expect(result).toMatchObject({
      kind: 'agent.think',
      phase: 'stop',
      toolName: 'calendar-list-events',
    });
  });

  it('maps agent.discuss to agent.speak with threadId', () => {
    const result = interpretEvent(row({
      eventType: 'agent.discuss',
      payload: {
        senderAgentId: 'coordinator',
        threadId: 'thread-42',
        content: 'What do you think?',
      },
    }));
    expect(result).toMatchObject({
      kind: 'agent.speak',
      agentId: 'coordinator',
      threadId: 'thread-42',
      content: 'What do you think?',
    });
  });

  it('maps inbound.message to tube.in', () => {
    const result = interpretEvent(row({
      eventType: 'inbound.message',
      sourceLayer: 'channel',
      payload: { conversationId: 'conv-in', channelId: 'email' },
    }));
    expect(result).toMatchObject({ kind: 'tube.in', conversationId: 'conv-in', channelId: 'email' });
  });

  it('maps outbound.message and outbound.delivered to tube.out', () => {
    for (const eventType of ['outbound.message', 'outbound.delivered'] as const) {
      const result = interpretEvent(row({
        eventType,
        sourceLayer: 'dispatch',
        payload: { conversationId: 'conv-out', agentId: 'coordinator' },
      }));
      expect(result).toMatchObject({ kind: 'tube.out', conversationId: 'conv-out', agentId: 'coordinator' });
    }
  });

  it('maps task.created to task.appear', () => {
    const result = interpretEvent(row({
      eventType: 'task.created',
      sourceLayer: 'execution',
      payload: { taskId: 'task-1', title: 'Review deck' },
    }));
    expect(result).toMatchObject({ kind: 'task.appear', taskId: 'task-1', title: 'Review deck' });
  });

  it('maps task.completed to task.trash', () => {
    const result = interpretEvent(row({
      eventType: 'task.completed',
      sourceLayer: 'execution',
      payload: { taskId: 'task-1' },
    }));
    expect(result).toMatchObject({ kind: 'task.trash', taskId: 'task-1' });
  });

  it('maps agent.error to agent.state error', () => {
    const result = interpretEvent(row({
      eventType: 'agent.error',
      payload: { agentId: 'research', message: 'Budget exceeded' },
    }));
    expect(result).toMatchObject({ kind: 'agent.state', agentId: 'research', state: 'error' });
  });

  it('maps human.decision to badge', () => {
    const result = interpretEvent(row({
      eventType: 'human.decision',
      sourceLayer: 'dispatch',
      payload: { subjectSummary: 'Approve outbound email' },
    }));
    expect(result).toMatchObject({
      kind: 'badge',
      badgeKind: 'human.decision',
      label: 'Approve outbound email',
    });
  });

  it('maps autonomy.*_blocked events to badge', () => {
    for (const eventType of ['autonomy.tool_blocked', 'autonomy.send_blocked'] as const) {
      const result = interpretEvent(row({
        eventType,
        payload: { toolName: 'send-email', reason: 'score too low' },
      }));
      expect(result).toMatchObject({
        kind: 'badge',
        badgeKind: 'autonomy.blocked',
      });
    }
  });

  it('returns null for unmapped event types', () => {
    expect(interpretEvent(row({ eventType: 'memory.store', payload: {} }))).toBeNull();
    expect(interpretEvent(row({ eventType: 'llm.call', payload: {} }))).toBeNull();
  });

  it('includes logicalTs from row timestamp', () => {
    const ts = '2026-07-02T15:30:00.000Z';
    const result = interpretEvent(row({
      eventType: 'agent.task',
      timestamp: ts,
      payload: { agentId: 'coordinator' },
    }));
    expect(result).toMatchObject({
      logicalTs: new Date(ts).getTime(),
    });
  });
});

describe('buildScript', () => {
  it('produces ordered directives skipping unmapped rows', () => {
    const script = buildScript([
      row({ id: 'a', eventType: 'task.created', payload: { taskId: 't1', title: 'A' } }),
      row({ id: 'b', eventType: 'memory.store', payload: {} }),
      row({ id: 'c', eventType: 'task.completed', payload: { taskId: 't1' } }),
    ]);

    expect(script.directives).toHaveLength(2);
    expect(script.directives[0]).toMatchObject({ kind: 'task.appear', id: 'a' });
    expect(script.directives[1]).toMatchObject({ kind: 'task.trash', id: 'c' });
  });

  it('expands multi-directive events in order', () => {
    const script = buildScript([
      row({
        id: 'd',
        eventType: 'tool.invoke',
        payload: {
          agentId: 'coordinator',
          toolName: 'delegate',
          input: { agent: 'research', task: 'Go' },
        },
      }),
    ]);

    expect(script.directives).toHaveLength(2);
    expect(script.directives[0]!.kind).toBe('agent.walk');
    expect(script.directives[1]!.kind).toBe('agent.speak');
  });
});

describe('busEventToAuditRow', () => {
  it('handles null payload without throwing', () => {
    const row = busEventToAuditRow({
      id: 'evt-null',
      timestamp: new Date('2026-07-02T12:00:00.000Z'),
      type: 'heartbeat',
      sourceLayer: 'system',
      payload: null,
    });
    expect(row.sourceId).toBe('system');
    expect(row.payload).toEqual({});
  });

  it('extracts agentId from object payload', () => {
    const row = busEventToAuditRow({
      id: 'evt-1',
      timestamp: new Date('2026-07-02T12:00:00.000Z'),
      type: 'agent.task',
      sourceLayer: 'agent',
      payload: { agentId: 'calendar' },
    });
    expect(row.sourceId).toBe('calendar');
  });
});
