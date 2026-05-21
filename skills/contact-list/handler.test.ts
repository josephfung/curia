// handler.test.ts — tests for contact-list skill.
// Covers: no filters, status filter, limit, status+limit, role (existing),
// invalid status, invalid limit.
import { describe, it, expect, vi } from 'vitest';
import { ContactListHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { Contact } from '../../src/contacts/types.js';
import { createSilentLogger } from '../../src/logger.js';

// Factory for minimal Contact objects — only fields the handler reads
function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    systemRole: null,
    status: 'confirmed',
    contactConfidence: 0.5,
    trustLevel: null,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    notes: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const alice = makeContact({ id: 'a1', displayName: 'Alice', status: 'confirmed', createdAt: new Date('2026-01-01') });
const bob = makeContact({ id: 'b2', displayName: 'Bob', status: 'provisional', createdAt: new Date('2026-02-01') });
const carol = makeContact({ id: 'c3', displayName: 'Carol', status: 'provisional', createdAt: new Date('2026-03-01') });
const dave = makeContact({ id: 'd4', displayName: 'Dave', status: 'blocked', createdAt: new Date('2026-04-01') });

const allContacts = [alice, bob, carol, dave];

function makeCtx(input: Record<string, unknown> = {}, contacts: Contact[] = allContacts): SkillContext {
  return {
    input,
    log: createSilentLogger(),
    contactService: {
      listContacts: vi.fn().mockImplementation((filters?: { status?: string; limit?: number }) => {
        let results = [...contacts];
        if (filters?.status) {
          results = results.filter((c) => c.status === filters.status);
        }
        // Sort ascending by createdAt to match real backend
        results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (filters?.limit != null) {
          results = results.slice(0, filters.limit);
        }
        return Promise.resolve(results);
      }),
      findContactByRole: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SkillContext;
}

/** Extract contacts array from a successful result. */
function getContacts(result: SkillResult): Array<{ contact_id: string; display_name: string; status: string }> {
  if (!result.success) throw new Error(`Expected success, got: ${result.error}`);
  return (result.data as { contacts: Array<{ contact_id: string; display_name: string; status: string }> }).contacts;
}

describe('ContactListHandler', () => {
  const handler = new ContactListHandler();

  // --- No filters (existing behavior) ---

  it('returns all contacts when no filters provided', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
    expect(ctx.contactService!.listContacts).toHaveBeenCalledWith({
      status: undefined,
      limit: undefined,
    });
  });

  // --- Status filter ---

  it('filters by status=provisional', async () => {
    const ctx = makeCtx({ status: 'provisional' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(2);
    expect(contacts.every((c) => c.status === 'provisional')).toBe(true);
  });

  it('filters by status=confirmed', async () => {
    const ctx = makeCtx({ status: 'confirmed' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].display_name).toBe('Alice');
  });

  it('filters by status=blocked', async () => {
    const ctx = makeCtx({ status: 'blocked' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].display_name).toBe('Dave');
  });

  // --- Limit ---

  it('caps results with limit', async () => {
    const ctx = makeCtx({ limit: 2 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(2);
  });

  it('returns all contacts when limit exceeds total', async () => {
    const ctx = makeCtx({ limit: 100 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
  });

  // --- Status + limit combined ---

  it('filters by status and caps with limit', async () => {
    const ctx = makeCtx({ status: 'provisional', limit: 1 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].status).toBe('provisional');
  });

  // --- Role filter (existing behavior, regression check) ---

  it('uses findContactByRole when role is provided', async () => {
    const cfo = makeContact({ id: 'r1', displayName: 'CFO Person', role: 'CFO' });
    const ctx = makeCtx({ role: 'CFO' }, allContacts);
    (ctx.contactService!.findContactByRole as ReturnType<typeof vi.fn>).mockResolvedValue([cfo]);
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(1);
    expect(getContacts(result)[0].display_name).toBe('CFO Person');
    // Should NOT have called listContacts
    expect(ctx.contactService!.listContacts).not.toHaveBeenCalled();
  });

  // --- Validation ---

  it('rejects invalid status value', async () => {
    const ctx = makeCtx({ status: 'invalid' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid status');
  });

  it('rejects limit of zero', async () => {
    const ctx = makeCtx({ limit: 0 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects negative limit', async () => {
    const ctx = makeCtx({ limit: -5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects non-integer limit', async () => {
    const ctx = makeCtx({ limit: 2.5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('positive integer');
  });

  it('rejects role exceeding 200 characters', async () => {
    const ctx = makeCtx({ role: 'x'.repeat(201) });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('200 characters');
  });

  it('rejects combining role with status', async () => {
    const ctx = makeCtx({ role: 'CFO', status: 'provisional' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot combine role');
  });

  it('rejects combining role with limit', async () => {
    const ctx = makeCtx({ role: 'CFO', limit: 5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot combine role');
  });

  // --- Output shape ---

  it('includes status field in each contact output', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    const contacts = getContacts(result);
    expect(contacts[0]).toHaveProperty('status');
    expect(contacts[0].status).toBe('confirmed');
  });

  // --- Error handling ---

  it('returns error when contactService throws', async () => {
    const ctx = makeCtx();
    (ctx.contactService!.listContacts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('DB down');
  });

  it('returns error when contactService is missing', async () => {
    const ctx = {
      input: {},
      log: createSilentLogger(),
      contactService: undefined,
    } as unknown as SkillContext;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('contactService not available');
  });
});
