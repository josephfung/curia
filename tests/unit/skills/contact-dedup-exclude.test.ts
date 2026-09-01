// Unit tests for the contact-dedup-exclude tool.
//
// Since #1625 the tool writes a row to contact_dedup_exclusions via ContactService
// instead of a pair of KG facts. The behaviour that matters here: it works for
// contacts with no KG node (the null-node population from #1623), it is idempotent,
// and a persistence failure is reported as failure so the contacts agent leaves the
// review task open (the #1624 prompt gate depends on `success`).

import { describe, it, expect, vi } from 'vitest';
import { ContactDedupExcludeHandler } from '../../../skills/contacts/tools/contact-dedup-exclude/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import { InvalidExclusionPairError } from '../../../src/contacts/dedup-exclusions.js';
import { ContactNotFoundError } from '../../../src/contacts/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return {
    toolName: 'contact-dedup-exclude',
    toolVersion: '0.2.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

/** Minimal ContactService stub exposing only addDedupExclusion. */
function makeContactService(addDedupExclusion: unknown): ToolContext['contactService'] {
  return { addDedupExclusion } as unknown as ToolContext['contactService'];
}

describe('ContactDedupExcludeHandler', () => {
  const handler = new ContactDedupExcludeHandler();

  // -- Input validation --

  it('fails when contact_a_id is missing', async () => {
    const result = await handler.execute(makeCtx({ contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contact_a_id');
  });

  it('fails when contact_b_id is missing', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contact_b_id');
  });

  it('fails when contact_a_id is not a valid UUID', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: 'not-a-uuid', contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('UUID');
  });

  it('fails when both IDs are the same', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_A }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('different');
  });

  it('fails when both IDs are the same but differ only in casing', async () => {
    const result = await handler.execute(
      makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_A.toUpperCase() }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('different');
  });

  it('fails when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  // -- Happy path --

  it('records the exclusion and reports created: true', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(true);
    expect(addDedupExclusion).toHaveBeenCalledWith(UUID_A, UUID_B, 'contacts-dedup');
    if (result.success) {
      expect(result.data).toEqual({
        contact_a_id: UUID_A,
        contact_b_id: UUID_B,
        created: true,
      });
    }
  });

  it('succeeds for a pair where BOTH contacts have no KG node (#1623 regression)', async () => {
    // The whole point of #1625: the handler no longer consults kg_node_id at all,
    // so it cannot fail on the same-display-name null-node population.
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    const contactService = makeContactService(addDedupExclusion);
    // A getContact stub deliberately not provided — the handler must not need it.
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService },
    ));

    expect(result.success).toBe(true);
  });

  it('is idempotent — re-excluding an already-excluded pair still succeeds', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: false,
    });
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { created: boolean }).created).toBe(false);
    }
  });

  it('passes the pair through in the caller-supplied order (service normalizes)', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    await handler.execute(makeCtx(
      { contact_a_id: UUID_B, contact_b_id: UUID_A },
      { contactService: makeContactService(addDedupExclusion) },
    ));
    expect(addDedupExclusion).toHaveBeenCalledWith(UUID_B, UUID_A, 'contacts-dedup');
  });

  it('uses ctx.memoryWriteSource as decided_by provenance when available', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      {
        contactService: makeContactService(addDedupExclusion),
        memoryWriteSource: 'agent:contacts/task:t1/channel:signal',
      },
    ));
    expect(addDedupExclusion).toHaveBeenCalledWith(UUID_A, UUID_B, 'agent:contacts/task:t1/channel:signal');
  });

  // -- Failure reporting (the #1624 prompt gate depends on this) --

  it('reports failure when the exclusion write throws', async () => {
    const addDedupExclusion = vi.fn().mockRejectedValue(new Error('connection terminated'));
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Failed to record dedup exclusion');
      expect(result.error).toContain('connection terminated');
    }
  });

  it('reports a missing contact as failure', async () => {
    const addDedupExclusion = vi.fn().mockRejectedValue(new ContactNotFoundError(UUID_B));
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(UUID_B);
  });

  it('tells the agent not to retry when the exclusions table is missing', async () => {
    // Migration 084 not applied (the app image can lead the DB on a GHCR deploy). A
    // generic "failed to record" reads like a transient blip and the prompt says retry,
    // which would loop forever.
    // Detected by SQLSTATE 42P01, not by the message text — pg messages are localised
    // and version-dependent.
    const addDedupExclusion = vi.fn().mockRejectedValue(
      Object.assign(new Error('relation "contact_dedup_exclusions" does not exist'), { code: '42P01' }),
    );
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('will not resolve on retry');
      expect(result.error).toContain('migration 084');
      expect(result.error).toContain('Leave the review task open');
    }
  });

  it('tells the agent not to retry when contactService predates the tool', async () => {
    const addDedupExclusion = vi.fn().mockRejectedValue(
      new TypeError('ctx.contactService.addDedupExclusion is not a function'),
    );
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('will not resolve on retry');
  });

  it('warns but still records when memoryWriteSource is missing', async () => {
    // decided_by is the row's only audit trail, and the row is never revisited.
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    const warn = vi.fn();
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      {
        contactService: makeContactService(addDedupExclusion),
        log: { ...logger, warn, error: vi.fn(), info: vi.fn() } as never,
      },
    ));

    expect(result.success).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(addDedupExclusion).toHaveBeenCalledWith(UUID_A, UUID_B, 'contacts-dedup');
  });

  it('treats a blank memoryWriteSource as missing rather than storing empty provenance', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion), memoryWriteSource: '   ' },
    ));
    // The column is NOT NULL CHECK (decided_by <> ''), so a blank would be rejected by
    // Postgres — fall back before it gets there.
    expect(addDedupExclusion).toHaveBeenCalledWith(UUID_A, UUID_B, 'contacts-dedup');
  });

  it('echoes the normalized (lowercase) ids so output matches the stored row', async () => {
    const addDedupExclusion = vi.fn().mockResolvedValue({
      pair: { contactAId: UUID_A, contactBId: UUID_B },
      created: true,
    });
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A.toUpperCase(), contact_b_id: UUID_B.toUpperCase() },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { contact_a_id: string; contact_b_id: string };
      expect(data.contact_a_id).toBe(UUID_A);
      expect(data.contact_b_id).toBe(UUID_B);
    }
  });

  it('labels an invalid pair distinctly from an infrastructure failure', async () => {
    const addDedupExclusion = vi.fn().mockRejectedValue(
      new InvalidExclusionPairError('a contact cannot be excluded against itself'),
    );
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService: makeContactService(addDedupExclusion) },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Invalid contact pair');
  });
});
