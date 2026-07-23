// Shared test scaffolding for the relationship-tool handler tests
// (query-relationships, delete-relationship). Both build an in-memory EntityMemory
// and a minimal ToolContext the same way; keep that in one place.
//
// NOTE: this directory has no tool.json, so skill discovery (discoverNestedToolNames)
// skips it — it is not a tool.
import pino from 'pino';
import { KnowledgeGraphStore } from '../../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../../src/memory/embedding.js';
import { EntityMemory } from '../../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../../src/memory/validation.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { ToolContext } from '../../../../src/skills/types.js';

// Returns both mem and store for tests that need direct store access — e.g. to
// simulate pre-migration duplicate data by bypassing upsert logic.
export function makeEntityMemoryWithStore() {
  const embeddingService = EmbeddingService.createForTesting();
  const store = KnowledgeGraphStore.createInMemory(embeddingService);
  const validator = new MemoryValidator(store, embeddingService);
  return { mem: new EntityMemory(store, validator, embeddingService, createSilentLogger()), store };
}

export function makeEntityMemory(): EntityMemory {
  return makeEntityMemoryWithStore().mem;
}

export function makeCtx(entityMemory: EntityMemory, input: Record<string, unknown>): ToolContext {
  return {
    input,
    secret: () => 'test-key',
    log: pino({ level: 'silent' }),
    entityMemory,
  } as unknown as ToolContext;
}
