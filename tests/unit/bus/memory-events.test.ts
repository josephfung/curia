import { describe, it, expect } from 'vitest';
import {
  createMemoryStore,
  createMemoryQuery,
} from '../../../src/bus/events.js';

describe('Memory bus events', () => {
  it('creates a memory.store event with provenance', () => {
    const event = createMemoryStore({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      nodeId: 'node-123',
      nodeType: 'fact',
      label: 'Joseph is CEO',
      source: 'agent:coordinator/task:task-1/channel:cli',
      parentEventId: 'task-event-id',
    });
    expect(event.type).toBe('memory.store');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.nodeId).toBe('node-123');
    expect(event.id).toBeDefined();
  });

  it('creates a memory.query event', () => {
    const event = createMemoryQuery({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      queryType: 'entity',
      queryParams: { entityId: 'node-456' },
      resultCount: 5,
      parentEventId: 'task-event-id',
    });
    expect(event.type).toBe('memory.query');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.queryType).toBe('entity');
  });
});
