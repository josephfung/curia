// tests/unit/entity-context/entity-context-handler.test.ts
//
// Unit tests for the entity-context skill handler.
//
// The handler's job is to hand assembleMany's three buckets to the LLM in a form
// it reads correctly. The bucket that matters here is `nodeless` (#1694 / ADR-040):
// a contact that exists but holds no KG node. Reported as plain absence, an agent
// concludes "we know nothing about this person"; it needs to conclude "this contact
// cannot hold knowledge at all", which is a different and actionable thing.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { EntityContextHandler } from '../../../skills/entity-context/handler.js';
import type { ToolContext, ToolResult } from '../../../src/skills/types.js';
import type { AssembleManyResult } from '../../../src/entity-context/assembler.js';
import type { EntityContext } from '../../../src/entity-context/types.js';

const logger = pino({ level: 'silent' });

function makeEntity(overrides: Partial<EntityContext> = {}): EntityContext {
  return {
    entityId: 'node-1',
    entityType: 'person',
    label: 'Jenna Smith',
    contact: null,
    facts: [],
    connectedAccounts: [],
    relationships: [],
    ...overrides,
  } as EntityContext;
}

function makeCtx(
  input: Record<string, unknown>,
  result: Partial<AssembleManyResult>,
  caller?: { contactId?: string },
): ToolContext {
  const full: AssembleManyResult = {
    entities: result.entities ?? [],
    unresolved: result.unresolved ?? [],
    nodeless: result.nodeless ?? [],
  };
  return {
    input,
    log: logger,
    caller,
    entityContextAssembler: {
      assembleMany: vi.fn().mockResolvedValue(full),
      assembleOne: vi.fn(),
    },
  } as unknown as ToolContext;
}

// ToolResult is a discriminated union. These narrow it by throwing rather than by
// `if (!result.success)`, so a test that unexpectedly fails reports the real error
// instead of quietly skipping its assertions.
function expectData(result: ToolResult): Record<string, unknown> {
  if (!result.success) throw new Error(`expected success, got error: ${result.error}`);
  return result.data as Record<string, unknown>;
}

function expectError(result: ToolResult): string {
  if (result.success) throw new Error('expected failure, got success');
  return result.error;
}

describe('EntityContextHandler', () => {
  it('returns assembled entities', async () => {
    const ctx = makeCtx({ contactIds: ['contact-1'] }, { entities: [makeEntity()] });
    const result = await new EntityContextHandler().execute(ctx);

    const data = expectData(result) as unknown as { entities: EntityContext[] };
    expect(data.entities).toHaveLength(1);
    expect(data.entities[0].entityId).toBe('node-1');
  });

  it('reports a nodeless contact separately from an unresolved ID', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-2', 'ghost-id'] },
      {
        unresolved: ['ghost-id'],
        nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman' }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);

    const data = expectData(result) as unknown as {
      unresolved: string[];
      nodeless: Array<{ contactId: string; displayName: string; reason: string }>;
    };
    expect(data.unresolved).toEqual(['ghost-id']);
    expect(data.nodeless).toHaveLength(1);
    expect(data.nodeless[0].contactId).toBe('contact-2');
    expect(data.nodeless[0].displayName).toBe('Seth Berman');
  });

  it('gives each nodeless contact a reason the LLM cannot read as plain absence', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-2'] },
      { nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman' }] },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { nodeless: Array<{ reason: string }> };
    const reason = data.nodeless[0].reason;

    // The wording must state the capability gap, not an empty result. Asserting on
    // the distinction rather than the exact sentence so the copy can be reworded.
    expect(reason).toMatch(/cannot/i);
    expect(reason).not.toMatch(/^no (facts|context|information)/i);
  });

  it('omits the nodeless key entirely when there is nothing to report', async () => {
    // An always-present empty array is prompt noise on the overwhelmingly common
    // path where every contact has a node.
    const ctx = makeCtx({ contactIds: ['contact-1'] }, { entities: [makeEntity()] });
    const result = await new EntityContextHandler().execute(ctx);

    expect(expectData(result)).not.toHaveProperty('nodeless');
  });

  it('falls back to the caller contact when no IDs are supplied', async () => {
    const ctx = makeCtx({}, { entities: [makeEntity()] }, { contactId: 'caller-contact' });
    await new EntityContextHandler().execute(ctx);

    expect(vi.mocked(ctx.entityContextAssembler!.assembleMany)).toHaveBeenCalledWith(
      ['caller-contact'],
      { includeRelationships: true },
    );
  });

  it('fails cleanly when the assembler is not configured', async () => {
    const ctx = { input: {}, log: logger } as unknown as ToolContext;
    const result = await new EntityContextHandler().execute(ctx);

    expect(expectError(result)).toMatch(/not available/i);
  });

  it('does not leak DB internals into the error string', async () => {
    const ctx = makeCtx({ contactIds: ['contact-1'] }, {});
    vi.mocked(ctx.entityContextAssembler!.assembleMany).mockRejectedValue(
      new Error('relation "contacts" does not exist'),
    );

    const result = await new EntityContextHandler().execute(ctx);

    expect(expectError(result)).not.toMatch(/relation|contacts/);
  });
});
