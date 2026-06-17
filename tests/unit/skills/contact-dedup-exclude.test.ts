import { describe, it, expect, vi } from 'vitest';
import { ContactDedupExcludeHandler } from '../../../skills/contact-dedup-exclude/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });
const UUID_A = '550e8400-e29b-41d4-a716-446655440000';
const UUID_B = '550e8400-e29b-41d4-a716-446655440001';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<SkillContext>): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('ContactDedupExcludeHandler', () => {
  const handler = new ContactDedupExcludeHandler();

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

  it('fails when contactService is not available', async () => {
    const result = await handler.execute(makeCtx({ contact_a_id: UUID_A, contact_b_id: UUID_B }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('contactService');
  });

  it('fails when entityMemory is not available', async () => {
    const contactService = { getContact: vi.fn() } as unknown as SkillContext['contactService'];
    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('entityMemory');
  });

  it('fails when contact A is not found', async () => {
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) =>
        id === UUID_B ? { id: UUID_B, kgNodeId: 'kg-b' } : undefined,
      ),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: vi.fn() } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(UUID_A);
  });

  it('fails when contact B is not found', async () => {
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) =>
        id === UUID_A ? { id: UUID_A, kgNodeId: 'kg-a' } : undefined,
      ),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: vi.fn() } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(UUID_B);
  });

  it('writes exclusion facts on both KG nodes when both contacts have KG nodes', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : 'kg-b',
        displayName: id === UUID_A ? 'Alice' : 'Bob',
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact_a_excluded).toBe(true);
      expect(result.data.contact_b_excluded).toBe(true);
    }
    expect(storeFactMock).toHaveBeenCalledTimes(2);

    // A's node names B
    const callA = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callA.entityNodeId).toBe('kg-a');
    expect((callA.properties as Record<string, unknown>).value).toBe(UUID_B);

    // B's node names A
    const callB = storeFactMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(callB.entityNodeId).toBe('kg-b');
    expect((callB.properties as Record<string, unknown>).value).toBe(UUID_A);
  });

  it('skips writing on a contact with no KG node', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : null, // B has no KG node
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    const result = await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contact_a_excluded).toBe(true);
      expect(result.data.contact_b_excluded).toBe(false);
    }
    // Only one write — B has no KG node to attach a fact to
    expect(storeFactMock).toHaveBeenCalledTimes(1);
  });

  it('uses ctx.memoryWriteSource as the storeFact source', async () => {
    const storeFactMock = vi.fn().mockResolvedValue({ stored: true, action: 'created' });
    const contactService = {
      getContact: vi.fn().mockImplementation(async (id: string) => ({
        id,
        kgNodeId: id === UUID_A ? 'kg-a' : 'kg-b',
      })),
    } as unknown as SkillContext['contactService'];
    const entityMemory = { storeFact: storeFactMock } as unknown as SkillContext['entityMemory'];

    await handler.execute(makeCtx(
      { contact_a_id: UUID_A, contact_b_id: UUID_B },
      { contactService, entityMemory, memoryWriteSource: 'agent:contacts/task:t1/channel:cli' },
    ));

    const call = storeFactMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.source).toBe('agent:contacts/task:t1/channel:cli');
  });
});
