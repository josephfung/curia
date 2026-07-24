import type {
  ActivityScript,
  AuditEventRow,
  SceneDirective,
} from '@curia/shared-types';
import {
  readAuditToolName,
} from '../audit/legacy-tool-events.js';

function baseFields(row: AuditEventRow): Pick<SceneDirective, 'id' | 'logicalTs' | 'causedBy'> {
  return {
    id: row.id,
    logicalTs: new Date(row.timestamp).getTime(),
    causedBy: row.parentEventId,
  };
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function isAutonomyBlockedEvent(eventType: string): boolean {
  return eventType.startsWith('autonomy.') && eventType.endsWith('_blocked');
}

/**
 * Map one audit_log row to zero or more scene directives.
 * Unmapped event types return null.
 */
export function interpretEvent(row: AuditEventRow): SceneDirective | SceneDirective[] | null {
  const base = baseFields(row);
  const payload = row.payload;

  switch (row.eventType) {
    case 'schedule.fired':
      return {
        ...base,
        kind: 'claw.deliver',
        jobId: payloadString(payload, 'jobId') ?? '',
        agentId: payloadString(payload, 'agentId') ?? row.sourceId,
        taskId: payloadString(payload, 'agentTaskId') ?? null,
      };

    case 'agent.task':
      return {
        ...base,
        kind: 'agent.state',
        agentId: payloadString(payload, 'agentId') ?? row.sourceId,
        state: 'active',
      };

    case 'tool.invoke':
    case 'skill.invoke': {
      const toolName = readAuditToolName(payload) ?? '';
      const agentId = payloadString(payload, 'agentId') ?? row.sourceId;
      if (toolName === 'delegate') {
        const input = payload.input;
        const targetAgentId =
          typeof input === 'object' && input !== null && !Array.isArray(input)
            ? payloadString(input as Record<string, unknown>, 'agent')
            : undefined;
        const taskContent =
          typeof input === 'object' && input !== null && !Array.isArray(input)
            ? payloadString(input as Record<string, unknown>, 'task')
            : undefined;
        if (!targetAgentId) {
          return null;
        }
        return [
          {
            ...base,
            kind: 'agent.walk',
            agentId,
            targetAgentId,
          },
          {
            ...base,
            kind: 'agent.speak',
            agentId,
            content: taskContent,
          },
        ];
      }
      return {
        ...base,
        kind: 'agent.think',
        agentId,
        phase: 'start',
        toolName,
      };
    }

    case 'tool.result':
    case 'skill.result':
      return {
        ...base,
        kind: 'agent.think',
        agentId: payloadString(payload, 'agentId') ?? row.sourceId,
        phase: 'stop',
        toolName: readAuditToolName(payload),
      };

    case 'agent.discuss':
      return {
        ...base,
        kind: 'agent.speak',
        agentId: payloadString(payload, 'senderAgentId') ?? row.sourceId,
        threadId: payloadString(payload, 'threadId'),
        content: payloadString(payload, 'content'),
      };

    case 'inbound.message':
      return {
        ...base,
        kind: 'tube.in',
        conversationId: payloadString(payload, 'conversationId') ?? row.conversationId ?? undefined,
        channelId: payloadString(payload, 'channelId'),
      };

    case 'outbound.message':
    case 'outbound.delivered':
      return {
        ...base,
        kind: 'tube.out',
        conversationId: payloadString(payload, 'conversationId') ?? row.conversationId ?? undefined,
        agentId: payloadString(payload, 'agentId'),
      };

    case 'task.created':
      return {
        ...base,
        kind: 'task.appear',
        taskId: payloadString(payload, 'taskId') ?? '',
        title: payloadString(payload, 'title'),
      };

    case 'task.completed':
      return {
        ...base,
        kind: 'task.trash',
        taskId: payloadString(payload, 'taskId') ?? '',
      };

    case 'agent.error':
      return {
        ...base,
        kind: 'agent.state',
        agentId: payloadString(payload, 'agentId') ?? row.sourceId,
        state: 'error',
      };

    case 'human.decision':
      return {
        ...base,
        kind: 'badge',
        badgeKind: 'human.decision',
        label: payloadString(payload, 'subjectSummary') ?? 'Human decision',
      };

    case 'authorization.decision':
      return {
        ...base,
        kind: 'badge',
        badgeKind: 'authorization.decision',
        label: payloadString(payload, 'subjectSummary') ?? 'Authorization decision',
      };

    default:
      if (isAutonomyBlockedEvent(row.eventType)) {
        return {
          ...base,
          kind: 'badge',
          badgeKind: 'autonomy.blocked',
          label: readAuditToolName(payload)
            ?? payloadString(payload, 'reason')
            ?? row.eventType,
        };
      }
      return null;
  }
}

/** Flatten interpretEvent results into an ordered activity script. */
export function buildScript(rows: AuditEventRow[]): ActivityScript {
  const directives: SceneDirective[] = [];
  for (const row of rows) {
    const mapped = interpretEvent(row);
    if (mapped === null) {
      continue;
    }
    if (Array.isArray(mapped)) {
      directives.push(...mapped);
    } else {
      directives.push(mapped);
    }
  }
  return { directives };
}

/** Convert a live bus event to the audit row shape the interpreter expects. */
export function busEventToAuditRow(event: {
  id: string;
  timestamp: Date;
  type: string;
  sourceLayer: string;
  parentEventId?: string | null;
  payload: unknown;
}): AuditEventRow {
  const rawPayload = event.payload;
  const payload: Record<string, unknown> =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as unknown as Record<string, unknown>)
      : {};
  const sourceId =
    typeof payload.agentId === 'string'
      ? payload.agentId
      : typeof payload.channelId === 'string'
        ? payload.channelId
        : event.sourceLayer;
  return {
    id: event.id,
    timestamp: event.timestamp,
    eventType: event.type,
    sourceLayer: event.sourceLayer,
    sourceId,
    conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : null,
    parentEventId: event.parentEventId ?? null,
    payload,
  };
}
