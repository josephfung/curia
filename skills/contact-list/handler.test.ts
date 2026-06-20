// handler.test.ts — tests for contact-list skill.
// Covers: no filters, limit, offset, role (existing), invalid limit, invalid offset,
// kind filter. Status filter removed along with ContactStatus (#955).
import { describe, it, expect, vi } from 'vitest';
import { ContactListHandler } from './handler.js';
import type { SkillContext, SkillResult } from '../../src/skills/types.js';
import type { Contact } from '../../src/contacts/types.js';
import { createSilentLogger } from '../../src/logger.js';

// Factory for minimal Contact objects — only fields the handler reads.
// Defaults kind to 'person' and tier to 'known' so contacts pass the default kind filter.
function makeContact(overrides: Partial<Contact> & { id: string; displayName: string }): Contact {
  return {
    kgNodeId: null,
    role: null,
    systemRole: null,
    tier: 'known',
    kind: 'person',
    contactConfidence: 0.5,
    lastSeenAt: null,
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    notes: null,
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

const alice = makeContact({ id: 'a1', displayName: 'Alice', tier: 'known', createdAt: new Date('2026-01-01') });
const bob = makeContact({ id: 'b2', displayName: 'Bob', tier: 'unknown', createdAt: new Date('2026-02-01') });
const carol = makeContact({ id: 'c3', displayName: 'Carol', tier: 'unknown', createdAt: new Date('2026-03-01') });
const dave = makeContact({ id: 'd4', displayName: 'Dave', tier: 'blocked', createdAt: new Date('2026-04-01') });

const allContacts = [alice, bob, carol, dave];

function makeCtx(input: Record<string, unknown> = {}, contacts: Contact[] = allContacts): SkillContext {
  return {
    input,
    log: createSilentLogger(),
    contactService: {
      listContacts: vi.fn().mockImplementation((filters?: { tier?: string; kind?: string[]; limit?: number; offset?: number }) => {
        let results = [...contacts];
        if (filters?.tier) {
          results = results.filter((c) => c.tier === filters.tier);
        }
        // Filter by kind when specified — mirrors the backend's inclusion semantics
        if (filters?.kind != null && filters.kind.length > 0) {
          results = results.filter((c) => filters.kind!.includes(c.kind));
        }
        // Sort ascending by createdAt to match real backend
        results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const offset = filters?.offset ?? 0;
        const end = filters?.limit != null ? offset + filters.limit : undefined;
        results = results.slice(offset, end);
        return Promise.resolve(results);
      }),
      findContactByRole: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SkillContext;
}

/** Extract contacts array from a successful result. */
function getContacts(result: SkillResult): Array<{ contact_id: string; display_name: string; tier: string }> {
  if (!result.success) throw new Error(`Expected success, got: ${result.error}`);
  return (result.data as { contacts: Array<{ contact_id: string; display_name: string; tier: string }> }).contacts;
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
      kind: ['person', 'principal', 'organization'],
      limit: undefined,
      offset: undefined,
    });
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

  // --- Offset pagination ---

  it('offset=0 returns same results as no offset', async () => {
    const ctx = makeCtx({ offset: 0 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
  });

  it('offset skips leading contacts', async () => {
    const ctx = makeCtx({ offset: 2, limit: 10 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    // allContacts sorted by createdAt: alice, bob, carol, dave — offset 2 skips alice+bob
    const contacts = getContacts(result);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]!.display_name).toBe('Carol');
    expect(contacts[1]!.display_name).toBe('Dave');
  });

  it('offset past end returns empty array', async () => {
    const ctx = makeCtx({ offset: 10, limit: 10 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(0);
  });

  it('two consecutive limit+offset pages return disjoint sets', async () => {
    const ctx1 = makeCtx({ limit: 2, offset: 0 });
    const ctx2 = makeCtx({ limit: 2, offset: 2 });
    const page1 = getContacts(await handler.execute(ctx1)).map((c) => c.contact_id);
    const page2 = getContacts(await handler.execute(ctx2)).map((c) => c.contact_id);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1.some((id) => page2.includes(id))).toBe(false);
    expect([...page1, ...page2].sort()).toEqual(['a1', 'b2', 'c3', 'd4'].sort());
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

  it('rejects combining role with limit', async () => {
    const ctx = makeCtx({ role: 'CFO', limit: 5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot combine role');
  });

  it('rejects combining role with offset', async () => {
    const ctx = makeCtx({ role: 'CFO', offset: 5, limit: 10 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot combine role');
  });

  it('rejects negative offset', async () => {
    const ctx = makeCtx({ offset: -1 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-negative integer');
  });

  it('rejects offset > 0 without limit (unbounded pagination guard)', async () => {
    const ctx = makeCtx({ offset: 5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Offset requires limit');
  });

  it('allows offset=0 without limit (same as no offset)', async () => {
    const ctx = makeCtx({ offset: 0 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(getContacts(result)).toHaveLength(4);
  });

  it('rejects non-integer offset', async () => {
    const ctx = makeCtx({ offset: 1.5 });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-negative integer');
  });

  // --- Output shape ---

  it('includes tier field in each contact output', async () => {
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    const contacts = getContacts(result);
    expect(contacts[0]).toHaveProperty('tier');
    expect(contacts[0]!.tier).toBe('known');
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

// ---- kind filter tests ----
//
// Uses a lighter-weight makeCtx that accepts raw objects so the kind field can
// be set freely without satisfying the full Contact interface.

function makeKindCtx(input: Record<string, unknown>, contacts: unknown[]): SkillContext {
  return {
    input,
    log: createSilentLogger(),
    contactService: {
      findContactByRole: async () => [],
      listContacts: async (filters?: { kind?: string[]; tier?: string; limit?: number; offset?: number }) => {
        // Return only contacts whose kind is in the filter (or all if no filter)
        return contacts.filter((c: unknown) => {
          const contact = c as { kind?: string };
          return !filters?.kind || filters.kind.includes(contact.kind ?? '');
        });
      },
    },
  } as unknown as SkillContext;
}

const personContact = { id: '1', displayName: 'Alice', role: null, tier: 'known', kgNodeId: null, kind: 'person' };
const automatedContact = { id: '2', displayName: 'GitHub Notifications', role: null, tier: 'known', kgNodeId: null, kind: 'automated' };
const agentContact = { id: '3', displayName: 'Curia Agent', role: null, tier: 'known', kgNodeId: null, kind: 'agent' };
const orgContact = { id: '4', displayName: 'Stripe', role: null, tier: 'known', kgNodeId: null, kind: 'organization' };

describe('ContactListHandler — kind filter', () => {
  it('excludes automated and agent contacts by default (no kind param)', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeKindCtx({}, [personContact, automatedContact, agentContact, orgContact]));
    expect(result.success).toBe(true);
    const ids = (result as { success: true; data: { contacts: Array<{ contact_id: string }> } }).data.contacts.map((c) => c.contact_id);
    expect(ids).toContain('1'); // person
    expect(ids).toContain('4'); // organization
    expect(ids).not.toContain('2'); // automated excluded
    expect(ids).not.toContain('3'); // agent excluded
  });

  it('returns automated contacts when kind=automated is explicitly requested', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeKindCtx({ kind: 'automated' }, [personContact, automatedContact]));
    expect(result.success).toBe(true);
    const ids = (result as { success: true; data: { contacts: Array<{ contact_id: string }> } }).data.contacts.map((c) => c.contact_id);
    expect(ids).toContain('2');
    expect(ids).not.toContain('1'); // person not in automated filter
  });

  it('rejects an invalid kind value', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeKindCtx({ kind: 'invisible' }, []));
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/Invalid kind/);
  });

  it('accepts comma-separated kind values and filters to each requested kind', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeKindCtx({ kind: 'person,automated' }, [personContact, automatedContact, agentContact, orgContact]));
    expect(result.success).toBe(true);
    const ids = (result as { success: true; data: { contacts: Array<{ contact_id: string }> } }).data.contacts.map((c) => c.contact_id);
    expect(ids).toContain('1'); // person
    expect(ids).toContain('2'); // automated
    expect(ids).not.toContain('3'); // agent not requested
    expect(ids).not.toContain('4'); // organization not requested
  });

  it('rejects an empty kind list', async () => {
    const handler = new ContactListHandler();
    const result = await handler.execute(makeKindCtx({ kind: [] }, []));
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/kind must not be empty/);
  });

  it('role lookup post-filters by effective kind (excludes automated/agent by default)', async () => {
    // findContactByRole returns contacts of mixed kinds; handler must exclude automated/agent.
    const handler = new ContactListHandler();
    const roleContact = { id: '5', displayName: 'Support Bot', role: 'support', tier: 'known', kgNodeId: null, kind: 'automated' };
    const roleHuman = { id: '6', displayName: 'Support Human', role: 'support', tier: 'known', kgNodeId: null, kind: 'person' };
    const ctx = {
      input: { role: 'support' },
      log: createSilentLogger(),
      contactService: {
        findContactByRole: async () => [roleContact, roleHuman],
        listContacts: vi.fn(),
      },
    } as unknown as SkillContext;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const ids = (result as { success: true; data: { contacts: Array<{ contact_id: string }> } }).data.contacts.map((c) => c.contact_id);
    expect(ids).not.toContain('5'); // automated excluded by default kind filter
    expect(ids).toContain('6'); // person passes through
  });
});
