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
