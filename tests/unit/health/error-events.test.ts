import { describe, it, expect } from 'vitest';
import { createLlmError, createEmbeddingError } from '../../../src/bus/events.js';

describe('llm.error event factory', () => {
  it('creates a valid llm.error event', () => {
    const event = createLlmError({
      agentId: 'system:drift-detector',
      conversationId: 'system',
      requestedModel: 'claude-haiku-4-5',
      provider: 'anthropic',
      errorType: 'AUTH_FAILURE',
      parentEventId: 'system',
    });
    expect(event.type).toBe('llm.error');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.requestedModel).toBe('claude-haiku-4-5');
    expect(event.payload.errorType).toBe('AUTH_FAILURE');
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});

describe('embedding.error event factory', () => {
  it('creates a valid embedding.error event', () => {
    const event = createEmbeddingError({
      model: 'text-embedding-3-small',
      errorType: 'FETCH_FAILED',
    });
    expect(event.type).toBe('embedding.error');
    // embedding.error fires from infrastructure paths (same as embedding.call), not agent tasks
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.model).toBe('text-embedding-3-small');
  });
});
