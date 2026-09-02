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
    failed: result.failed ?? [],
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
        nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);

    const data = expectData(result) as unknown as {
      unresolved: string[];
      nodeless: Array<{ contactId: string; displayName: string; reason: string; cause: string }>;
    };
    expect(data.unresolved).toEqual(['ghost-id']);
    expect(data.nodeless).toHaveLength(1);
    expect(data.nodeless[0].contactId).toBe('contact-2');
    expect(data.nodeless[0].displayName).toBe('Seth Berman');
    expect(data.nodeless[0].cause).toBe('missing');
  });

  it('gives each nodeless contact a reason the LLM cannot read as plain absence', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-2'] },
      { nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' }] },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { nodeless: Array<{ reason: string }> };
    const reason = data.nodeless[0].reason;

    // The wording must state the capability gap, not an empty result. Asserting on
    // the distinction rather than the exact sentence so the copy can be reworded.
    expect(reason).toMatch(/cannot/i);
    expect(reason).not.toMatch(/^no (facts|context|information)/i);
    expect(reason).toMatch(/has no stored profile/i);
    expect(reason).not.toMatch(/retired/i);
  });

  it('gives an archived-node contact a reason that distinguishes retirement from never-had', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-2'] },
      { nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'archived' }] },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as {
      nodeless: Array<{ cause: string; reason: string }>;
    };

    expect(data.nodeless[0].cause).toBe('archived');
    expect(data.nodeless[0].reason).toMatch(/retired/i);
    expect(data.nodeless[0].reason).toMatch(/cannot/i);
    expect(data.nodeless[0].reason).not.toMatch(/has no stored profile/i);
  });

  it('echoes inputId back so the agent can map the answer to what it asked for', async () => {
    // The email case is why this matters: contactId is a UUID the caller never saw,
    // and displayName may not resemble the address it supplied.
    const ctx = makeCtx(
      { entityIds: ['seth@example.com'] },
      { nodeless: [{ inputId: 'seth@example.com', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' }] },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { nodeless: Array<{ inputId: string }> };

    expect(data.nodeless[0].inputId).toBe('seth@example.com');
  });

  it('emits nodeless before entities so head-slice truncation cannot drop it', async () => {
    // The execution layer caps aggregate output by JSON.stringify + slice(0, max),
    // and stringify preserves insertion order. If entities came first, a large batch
    // would truncate away the one signal saying some contacts can hold no knowledge —
    // and they are absent from `unresolved` too, so they would vanish entirely.
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        entities: [makeEntity()],
        nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const keys = Object.keys(expectData(result));

    expect(keys.indexOf('nodeless')).toBeLessThan(keys.indexOf('entities'));
  });

  it('omits the nodeless key entirely when there is nothing to report', async () => {
    // An always-present empty array is prompt noise on the overwhelmingly common
    // path where every contact has a node.
    const ctx = makeCtx({ contactIds: ['contact-1'] }, { entities: [makeEntity()] });
    const result = await new EntityContextHandler().execute(ctx);

    expect(expectData(result)).not.toHaveProperty('nodeless');
  });

  it('reports a failed lookup separately from unresolved', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        entities: [makeEntity()],
        failed: [{ inputId: 'contact-2', retryable: true }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as {
      failed: Array<{ inputId: string; reason: string }>;
      unresolved: string[];
    };

    expect(data.failed).toHaveLength(1);
    expect(data.failed[0].inputId).toBe('contact-2');
    expect(data.failed[0].reason).toMatch(/retry/i);
    expect(data.failed[0].reason).toMatch(/not evidence/i);
    expect(data.unresolved).toEqual([]);
  });

  it('does not describe permanent failures as retryable', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        entities: [makeEntity()],
        failed: [{ inputId: 'contact-2', retryable: false }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { failed: Array<{ reason: string }> };

    expect(data.failed[0].reason).toMatch(/do not retry/i);
    expect(data.failed[0].reason).not.toMatch(/retry the lookup/i);
  });

  it('emits failed before entities so head-slice truncation cannot drop it', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        entities: [makeEntity()],
        failed: [{ inputId: 'contact-2', retryable: true }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const keys = Object.keys(expectData(result));

    expect(keys.indexOf('failed')).toBeLessThan(keys.indexOf('entities'));
  });

  it('omits the failed key entirely when there is nothing to report', async () => {
    const ctx = makeCtx({ contactIds: ['contact-1'] }, { entities: [makeEntity()] });
    const result = await new EntityContextHandler().execute(ctx);

    expect(expectData(result)).not.toHaveProperty('failed');
  });

  it('returns success false when every ID failed and nothing assembled', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      { failed: [{ inputId: 'contact-1', retryable: true }, { inputId: 'contact-2', retryable: true }] },
    );

    const result = await new EntityContextHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/retry/i);
    expect(result.error).toMatch(/not evidence/i);
  });

  it('does not claim all failures were transient when retryability is mixed', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        failed: [
          { inputId: 'contact-1', retryable: true },
          { inputId: 'contact-2', retryable: false },
        ],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/some failures may be transient/i);
    expect(result.error).toMatch(/do not retry those/i);
    expect(result.error).not.toMatch(/due to transient errors\. Retry/i);
  });

  it('returns success true when failed is mixed with unresolved', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'ghost-id'] },
      { failed: [{ inputId: 'contact-1', retryable: true }], unresolved: ['ghost-id'] },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { failed: unknown[]; unresolved: string[] };

    expect(data.failed).toHaveLength(1);
    expect(data.unresolved).toEqual(['ghost-id']);
  });

  it('returns success true when failed is mixed with nodeless', async () => {
    const ctx = makeCtx(
      { contactIds: ['contact-1', 'contact-2'] },
      {
        failed: [{ inputId: 'contact-1', retryable: true }],
        nodeless: [{ inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' }],
      },
    );

    const result = await new EntityContextHandler().execute(ctx);
    const data = expectData(result) as unknown as { failed: unknown[]; nodeless: unknown[] };

    expect(data.failed).toHaveLength(1);
    expect(data.nodeless).toHaveLength(1);
  });

  it('warns when some lookups failed without logging raw input IDs', async () => {
    const warn = vi.fn();
    const spyLogger = { ...logger, warn, child: () => spyLogger } as unknown as typeof logger;
    const ctx = makeCtx(
      { entityIds: ['jenna@example.com'] },
      { failed: [{ inputId: 'jenna@example.com', retryable: true }] },
    );
    ctx.log = spyLogger;

    await new EntityContextHandler().execute(ctx);

    const failedWarn = warn.mock.calls.find(call => /lookups failed/i.test(String(call[1])));
    expect(failedWarn).toBeDefined();
    expect(failedWarn![0]).toEqual({ failedCount: 1, retryableCount: 1 });
    expect(JSON.stringify(failedWarn![0])).not.toContain('jenna@example.com');
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
