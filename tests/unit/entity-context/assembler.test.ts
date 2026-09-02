// tests/unit/entity-context/assembler.test.ts
//
// Unit tests for EntityContextAssembler.
// Uses a mock DB pool — no real database required.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { EntityContextAssembler, isRetryableAssemblyError } from '../../../src/entity-context/assembler.js';
import type { DbPool } from '../../../src/db/connection.js';

const logger = pino({ level: 'silent' });

// -- Minimal mock pool --
// query() is a vi.fn() so tests can stub return values per query.

function makeMockPool(): DbPool {
  return {
    query: vi.fn(),
    end: vi.fn(),
    connect: vi.fn(),
    on: vi.fn(),
  } as unknown as DbPool;
}

// Helper: build a pool mock that responds to queries in order.
// Each call to pool.query() returns the next response in the queue, or rejects
// when the step is `{ reject: Error }`.
type SequentialPoolStep = { rows: unknown[] } | { reject: Error };

function makeSequentialPool(steps: SequentialPoolStep[]): DbPool {
  const pool = makeMockPool();
  let callIndex = 0;
  vi.mocked(pool.query).mockImplementation(() => {
    const step = steps[callIndex++];
    if (!step) {
      throw new Error(`Unexpected query call #${callIndex} — add a response to makeSequentialPool`);
    }
    if ('reject' in step) {
      return Promise.reject(step.reject);
    }
    return Promise.resolve({ rows: step.rows } as unknown as ReturnType<DbPool['query']>);
  });
  return pool;
}

// -- KG node row fixture --
const personNodeRow = {
  id: 'node-1',
  type: 'person',
  label: 'Jenna Smith',
  properties: {},
};

// -- Fact node row fixture --
const timezoneFactRow = {
  label: 'timezone',
  properties: { value: 'America/Vancouver', category: 'scheduling' },
  confidence: 0.9,
  last_confirmed_at: new Date('2026-01-01T00:00:00Z'),
};

// -- Contact row fixture --
const contactRow = {
  id: 'contact-1',
  display_name: 'Jenna Smith',
  role: null,
};

// -- Calendar row fixture --
const calendarRow = {
  nylas_calendar_id: 'cal-abc',
  label: 'Work Calendar',
  is_primary: true,
  read_only: false,
  timezone: 'America/Vancouver',
};

// -- Relationship row fixture --
const relationshipRow = {
  edge_type: 'works_on',
  direction: 'outbound',
  related_id: 'node-2',
  related_label: 'Acme Corp',
  related_type: 'organization',
};

// -- Channel identity fixture for email resolution --
const channelIdentityRow = {
  contact_id: 'contact-1',
  kg_node_id: 'node-1',
};

describe('EntityContextAssembler', () => {
  describe('assembleOne — person entity via contact ID', () => {
    it('assembles a full EntityContext for a person with facts and calendars', async () => {
      // Queries in order:
      // 1. resolveKgNodeId: contact ID lookup → returns kg_node_id
      // 2. getKgNode: node lookup
      // 3. getFacts: two-part UNION (returns 1 fact via first half)
      // 4. getContactByKgNodeId
      // 5. getConnectedAccounts (calendars)
      // 6. getRelationships: two-part UNION (returns 1 relationship)
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },   // resolveKgNodeId: contact found
        { rows: [personNodeRow] },                // getKgNode
        { rows: [timezoneFactRow] },              // getFacts (UNION result)
        { rows: [contactRow] },                   // getContactByKgNodeId
        { rows: [calendarRow] },                  // getConnectedAccounts
        { rows: [relationshipRow] },              // getRelationships (UNION result)
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('contact-1');

      expect(ctx).toBeDefined();
      expect(ctx!.entityId).toBe('node-1');
      expect(ctx!.entityType).toBe('person');
      expect(ctx!.label).toBe('Jenna Smith');

      // Contact record
      expect(ctx!.contact).toEqual({
        contactId: 'contact-1',
        displayName: 'Jenna Smith',
        role: null,
      });

      // Facts
      expect(ctx!.facts).toHaveLength(1);
      expect(ctx!.facts[0].label).toBe('timezone');
      expect(ctx!.facts[0].value).toBe('America/Vancouver');
      expect(ctx!.facts[0].category).toBe('scheduling');
      expect(ctx!.facts[0].confidence).toBe(0.9);

      // Connected accounts
      expect(ctx!.connectedAccounts).toHaveLength(1);
      expect(ctx!.connectedAccounts[0].type).toBe('calendar');
      expect(ctx!.connectedAccounts[0].serviceId).toBe('cal-abc');
      expect(ctx!.connectedAccounts[0].isPrimary).toBe(true);
      expect(ctx!.connectedAccounts[0].metadata).toEqual({ timezone: 'America/Vancouver' });

      // Relationships
      expect(ctx!.relationships).toHaveLength(1);
      expect(ctx!.relationships[0].type).toBe('works_on');
      expect(ctx!.relationships[0].direction).toBe('outbound');
      expect(ctx!.relationships[0].relatedEntityLabel).toBe('Acme Corp');
    });

    it('returns undefined when the contact has no linked KG node', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: null }] }, // contact found, but no KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('contact-1');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined when the ID does not match any contact or KG node', async () => {
      const pool = makeSequentialPool([
        { rows: [] }, // not a contact
        { rows: [] }, // not a KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('unknown-id');
      expect(ctx).toBeUndefined();
    });
  });

  describe('assembleOne — entity via KG node ID directly', () => {
    it('resolves a KG node ID directly when not a contact', async () => {
      // Non-person entity (org) — no contact record, no connected accounts
      const orgNodeRow = {
        id: 'node-org',
        type: 'organization',
        label: 'Acme Corp',
        properties: {},
      };

      const pool = makeSequentialPool([
        { rows: [] },            // not a contact
        { rows: [{ id: 'node-org' }] }, // is a KG node
        { rows: [orgNodeRow] },  // getKgNode
        { rows: [] },            // getFacts (empty)
        { rows: [] },            // getContactByKgNodeId (no contact)
        // no getConnectedAccounts call since contactRow is undefined
        { rows: [] },            // getRelationships (empty)
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('node-org');

      expect(ctx).toBeDefined();
      expect(ctx!.entityId).toBe('node-org');
      expect(ctx!.entityType).toBe('organization');
      expect(ctx!.contact).toBeNull();
      expect(ctx!.connectedAccounts).toHaveLength(0);
    });
  });

  describe('assembleMany', () => {
    it('returns entities and empty unresolved when all IDs resolve', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },          // facts
        { rows: [contactRow] },
        { rows: [] },          // calendars
        { rows: [] },          // relationships
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved } = await assembler.assembleMany(['contact-1']);

      expect(entities).toHaveLength(1);
      expect(unresolved).toHaveLength(0);
    });

    it('puts unresolvable IDs into unresolved array', async () => {
      const pool = makeSequentialPool([
        { rows: [] }, // not a contact
        { rows: [] }, // not a KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['ghost-id']);

      expect(entities).toHaveLength(0);
      expect(unresolved).toEqual(['ghost-id']);
      // An ID we have never heard of is *unknown*, not nodeless — the two buckets
      // answer different questions and must not be conflated (#1694).
      expect(nodeless).toHaveLength(0);
    });
  });

  // -- Nodeless contacts (#1694 / ADR-040) --
  //
  // A contact with kg_node_id = NULL exists but cannot hold facts, relationships,
  // or context. Before this bucket existed it landed in `unresolved` alongside IDs
  // that match nothing at all, so a caller could not tell "we have never heard of
  // this person" from "this person is structurally unable to hold knowledge".
  describe('assembleMany — nodeless contacts', () => {
    it('reports a contact with no KG node as nodeless, not unresolved', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['contact-2']);

      expect(entities).toHaveLength(0);
      expect(unresolved).toHaveLength(0);
      expect(nodeless).toEqual([
        { inputId: 'contact-2', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' },
      ]);
    });

    it('reports an email that resolves to a nodeless contact as nodeless', async () => {
      const pool = makeSequentialPool([
        { rows: [{ contact_id: 'contact-2', kg_node_id: null, display_name: 'Seth Berman' }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['seth@example.com']);

      expect(entities).toHaveLength(0);
      expect(unresolved).toHaveLength(0);
      // inputId keeps the caller's original string so it can correlate the result
      // back to what it asked for; contactId is what the row actually resolved to.
      expect(nodeless).toEqual([
        { inputId: 'seth@example.com', contactId: 'contact-2', displayName: 'Seth Berman', cause: 'missing' },
      ]);
    });

    it('separates resolved, nodeless, and unknown IDs in one batch', async () => {
      const pool = makeSequentialPool([
        // 'contact-1' — resolves fully
        { rows: [{ kg_node_id: 'node-1', display_name: 'Jenna Smith' }] },
        { rows: [personNodeRow] },
        { rows: [] },                // facts
        { rows: [contactRow] },
        { rows: [] },                // calendars
        { rows: [] },                // relationships
        // 'contact-2' — exists, no KG node
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
        // 'ghost-id' — matches nothing
        { rows: [] },                // not a contact
        { rows: [] },                // not a KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany([
        'contact-1',
        'contact-2',
        'ghost-id',
      ]);

      expect(entities).toHaveLength(1);
      expect(entities[0].entityId).toBe('node-1');
      expect(unresolved).toEqual(['ghost-id']);
      expect(nodeless.map(n => n.contactId)).toEqual(['contact-2']);
    });

    it('leaves assembleOne returning undefined for a nodeless contact', async () => {
      // assembleOne's signature is deliberately unchanged — the classification is
      // only surfaced through assembleMany, which is what every caller uses.
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      expect(await assembler.assembleOne('contact-2')).toBeUndefined();
    });

    it('does not cache nodeless results', async () => {
      // Caching a nodeless verdict would keep a contact context-free for the whole
      // TTL after a backfill or merge gave it a node.
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      await assembler.assembleMany(['contact-2']);
      await assembler.assembleMany(['contact-2']);

      expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(2);
    });
  });

  // -- Archived nodes (#1707) --
  //
  // DreamEngine (and, once ADR-040 increment 3 lands, contact deletion) retires
  // knowledge by setting archived_at. The write path has always respected that;
  // the entity-context read path did not, so retired facts still assembled.
  describe('assembleMany — archived nodes', () => {
    function querySql(pool: DbPool): string[] {
      return vi.mocked(pool.query).mock.calls.map(call => String(call[0]));
    }

    it('reports a contact whose KG node is archived as nodeless, not assembled', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-retired', display_name: 'Retired Person', node_archived: true }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['contact-retired']);

      expect(entities).toHaveLength(0);
      expect(unresolved).toHaveLength(0);
      expect(nodeless).toEqual([
        {
          inputId: 'contact-retired',
          contactId: 'contact-retired',
          displayName: 'Retired Person',
          cause: 'archived',
        },
      ]);
    });

    it('reports an email that resolves to an archived-node contact as nodeless', async () => {
      const pool = makeSequentialPool([
        {
          rows: [{
            contact_id: 'contact-retired',
            kg_node_id: 'node-retired',
            display_name: 'Retired Person',
            node_archived: true,
          }],
        },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['retired@example.com']);

      expect(entities).toHaveLength(0);
      expect(unresolved).toHaveLength(0);
      expect(nodeless).toEqual([
        {
          inputId: 'retired@example.com',
          contactId: 'contact-retired',
          displayName: 'Retired Person',
          cause: 'archived',
        },
      ]);
    });

    it('treats a direct lookup of an archived node ID as unresolved', async () => {
      // No contact was addressed, so this is not a nodeless contact — the node is
      // simply not a live entity. The kg_nodes query must filter archived_at so
      // we do not then log a false referential-integrity warning.
      const pool = makeSequentialPool([
        { rows: [] }, // not a contact
        { rows: [] }, // not a live KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless } = await assembler.assembleMany(['node-retired']);

      expect(entities).toHaveLength(0);
      expect(nodeless).toHaveLength(0);
      expect(unresolved).toEqual(['node-retired']);

      const nodeIdLookup = querySql(pool).find(s =>
        s.includes('FROM kg_nodes') && !s.includes('SELECT id, type, label'),
      );
      expect(nodeIdLookup).toMatch(/archived_at IS NULL/);
    });

    it('does not cache archived-node nodeless results', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-retired', display_name: 'Retired Person', node_archived: true }] },
        { rows: [{ kg_node_id: 'node-retired', display_name: 'Retired Person', node_archived: true }] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      await assembler.assembleMany(['contact-retired']);
      await assembler.assembleMany(['contact-retired']);

      expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(2);
    });

    it('excludes archived entity nodes, facts, and relationship endpoints from the read SQL', async () => {
      // Three cases in one assembly of a live contact:
      //   1. getKgNode must not return an archived entity node
      //   2. getFacts must not return an archived fact hanging off a live node
      //   3. getRelationships must not return an edge whose other end is archived
      // The mock pool does not execute SQL, so the assertions are on the predicates
      // both UNION halves send to Postgres.
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1', display_name: 'Jenna Smith' }] },
        { rows: [personNodeRow] },
        { rows: [timezoneFactRow] },
        { rows: [contactRow] },
        { rows: [calendarRow] },
        { rows: [relationshipRow] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('contact-1');
      expect(ctx).toBeDefined();

      const sql = querySql(pool);

      const nodeLookup = sql.find(s => s.includes('SELECT id, type, label, properties'));
      expect(nodeLookup, 'getKgNode query').toMatch(/archived_at IS NULL/);

      const facts = sql.find(s => s.includes("e.type = 'relates_to'"));
      expect(facts, 'getFacts query').toBeDefined();
      const factHalves = facts!.split(/UNION ALL/i);
      expect(factHalves).toHaveLength(2);
      for (const half of factHalves) {
        expect(half).toMatch(/e\.archived_at IS NULL/);
        expect(half).toMatch(/n\.archived_at IS NULL/);
      }

      const rels = sql.find(s => s.includes("n.type != 'fact'"));
      expect(rels, 'getRelationships query').toBeDefined();
      const relHalves = rels!.split(/UNION ALL/i);
      expect(relHalves).toHaveLength(2);
      for (const half of relHalves) {
        expect(half).toMatch(/e\.archived_at IS NULL/);
        expect(half).toMatch(/n\.archived_at IS NULL/);
      }
    });
  });

  describe('TTL cache', () => {
    // Cache is keyed by the input ID in assembleMany. Direct assembleOne()
    // calls bypass the cache — the cache only applies when going through assembleMany().

    it('returns cached result on second assembleMany call without hitting DB again', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);

      // First call — hits DB
      await assembler.assembleMany(['contact-1']);
      const callsAfterFirst = vi.mocked(pool.query).mock.calls.length;

      // Second call — should hit cache, no additional DB queries
      await assembler.assembleMany(['contact-1']);
      expect(vi.mocked(pool.query).mock.calls.length).toBe(callsAfterFirst);
    });

    it('clears cache for entity on clearCacheForEntity()', async () => {
      const pool = makeSequentialPool([
        // First assembly
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
        // Second assembly after cache clear
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);

      await assembler.assembleMany(['contact-1']);
      const callsAfterFirst = vi.mocked(pool.query).mock.calls.length;

      assembler.clearCacheForEntity('contact-1');

      // After clearing, next call should hit DB again
      await assembler.assembleMany(['contact-1']);
      expect(vi.mocked(pool.query).mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe('includeRelationships=false', () => {
    it('skips relationship query when includeRelationships is false', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },          // facts
        { rows: [contactRow] },
        { rows: [] },          // calendars
        // no relationship query
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities } = await assembler.assembleMany(['contact-1'], { includeRelationships: false });

      expect(entities).toHaveLength(1);
      expect(entities[0].relationships).toHaveLength(0);
    });
  });

  describe('fact value extraction', () => {
    it('extracts value from fact properties', async () => {
      const factWithComplexValue = {
        label: 'dietary preferences',
        properties: { value: ['vegetarian', 'gluten-free'], category: 'preference' },
        confidence: 0.8,
        last_confirmed_at: new Date('2026-01-01T00:00:00Z'),
      };

      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [factWithComplexValue] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('contact-1');

      expect(ctx!.facts[0].value).toEqual(['vegetarian', 'gluten-free']);
      expect(ctx!.facts[0].category).toBe('preference');
    });

    it('falls back to "unknown" category when not present', async () => {
      const factNoCategory = {
        label: 'loyalty number',
        properties: { value: 'ABC123' }, // no category field
        confidence: 1.0,
        last_confirmed_at: new Date('2026-01-01T00:00:00Z'),
      };

      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [factNoCategory] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('contact-1');
      expect(ctx!.facts[0].category).toBe('unknown');
    });
  });

  describe('resolveKgNodeId — email address resolution', () => {
    it('resolves a registered email address to a KG node via contact_channel_identities', async () => {
      // Query order for email path:
      // 1. resolveKgNodeId: email → contact_channel_identities JOIN contacts → contact_id + kg_node_id
      // 2. getKgNode
      // 3. getFacts
      // 4. getContactByKgNodeId
      // 5. getConnectedAccounts
      // 6. getRelationships
      const pool = makeSequentialPool([
        { rows: [channelIdentityRow] },   // email resolution: found
        { rows: [personNodeRow] },         // getKgNode
        { rows: [timezoneFactRow] },       // getFacts
        { rows: [contactRow] },            // getContactByKgNodeId
        { rows: [calendarRow] },           // getConnectedAccounts
        { rows: [relationshipRow] },       // getRelationships
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('jenna@example.com');

      expect(ctx).toBeDefined();
      expect(ctx!.entityId).toBe('node-1');
      expect(ctx!.entityType).toBe('person');
      expect(ctx!.label).toBe('Jenna Smith');
      expect(ctx!.contact).toEqual({
        contactId: 'contact-1',
        displayName: 'Jenna Smith',
        role: null,
      });
    });

    it('returns undefined when email resolves to a contact with no KG node', async () => {
      const pool = makeSequentialPool([
        { rows: [{ contact_id: 'contact-1', kg_node_id: null }] }, // email found, no KG node
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('jenna@example.com');
      expect(ctx).toBeUndefined();
    });

    it('returns undefined for an unregistered email address', async () => {
      const pool = makeSequentialPool([
        { rows: [] }, // email not found in contact_channel_identities
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('stranger@unknown.com');
      expect(ctx).toBeUndefined();
    });

    it('assembleMany resolves a mix of email addresses and contact UUIDs', async () => {
      // putInCache stores under all aliases: inputId ('jenna@example.com'),
      // entityId ('node-1'), and contactId ('contact-1'). So the second
      // lookup for 'contact-1' is a cache hit — no extra DB queries needed.
      const pool = makeSequentialPool([
        // First ID: email address — full resolution + assembly
        { rows: [channelIdentityRow] },    // email resolution
        { rows: [personNodeRow] },          // getKgNode
        { rows: [] },                       // getFacts
        { rows: [contactRow] },             // getContactByKgNodeId
        { rows: [] },                       // getConnectedAccounts
        { rows: [] },                       // getRelationships
        // Second ID 'contact-1': cache hit, no DB queries
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved } = await assembler.assembleMany([
        'jenna@example.com',
        'contact-1',
      ]);

      expect(entities).toHaveLength(2);
      expect(unresolved).toHaveLength(0);
      expect(entities[0].entityId).toBe('node-1');
      // Second entity served from cache — same underlying contact
      expect(entities[1].entityId).toBe('node-1');
    });

    it('resolves a mixed-case email address to the same KG node (case-insensitive)', async () => {
      // Exercises the LOWER() match in the contact_channel_identities query.
      const pool = makeSequentialPool([
        { rows: [channelIdentityRow] },   // email resolution: found (case-insensitive match)
        { rows: [personNodeRow] },         // getKgNode
        { rows: [timezoneFactRow] },       // getFacts
        { rows: [contactRow] },            // getContactByKgNodeId
        { rows: [calendarRow] },           // getConnectedAccounts
        { rows: [relationshipRow] },       // getRelationships
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const ctx = await assembler.assembleOne('Jenna@Example.com');

      expect(ctx).toBeDefined();
      expect(ctx!.entityId).toBe('node-1');
      expect(ctx!.entityType).toBe('person');
      expect(ctx!.label).toBe('Jenna Smith');
      expect(ctx!.contact).toEqual({
        contactId: 'contact-1',
        displayName: 'Jenna Smith',
        role: null,
      });
    });

    it('propagates DB errors from the email query path out of assembleOne', async () => {
      const pool = makeMockPool();
      const dbError = new Error('Connection reset by peer');
      vi.mocked(pool.query).mockRejectedValueOnce(dbError);

      const assembler = new EntityContextAssembler(pool, logger);
      await expect(assembler.assembleOne('jenna@example.com')).rejects.toThrow('Connection reset by peer');
    });

    it('treats email DB errors as failed in assembleMany, not unresolved', async () => {
      const pool = makeMockPool();
      vi.mocked(pool.query).mockRejectedValueOnce(new Error('pool timeout'));

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, failed } = await assembler.assembleMany(['jenna@example.com']);
      expect(entities).toHaveLength(0);
      expect(unresolved).toHaveLength(0);
      expect(failed).toEqual([
        { inputId: 'jenna@example.com', retryable: true },
      ]);
    });

    it('classifies permanent schema errors as non-retryable', async () => {
      const pool = makeMockPool();
      vi.mocked(pool.query).mockRejectedValueOnce(
        Object.assign(new Error('column does not exist'), { code: '42703' }),
      );

      const assembler = new EntityContextAssembler(pool, logger);
      const { failed } = await assembler.assembleMany(['contact-1']);
      expect(failed).toEqual([{ inputId: 'contact-1', retryable: false }]);
    });

    it('returns partial entities plus failed when a mid-batch DB error occurs', async () => {
      const pool = makeSequentialPool([
        { rows: [{ kg_node_id: 'node-1' }] },
        { rows: [personNodeRow] },
        { rows: [] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
        { reject: Object.assign(new Error('too many connections'), { code: '53300' }) },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, failed } = await assembler.assembleMany(['contact-1', 'contact-2']);

      expect(entities).toHaveLength(1);
      expect(entities[0]!.entityId).toBe('node-1');
      expect(unresolved).toHaveLength(0);
      expect(failed).toEqual([{ inputId: 'contact-2', retryable: true }]);
    });
  });

  describe('isRetryableAssemblyError', () => {
    it('treats connection-limit and schema errors differently', () => {
      expect(isRetryableAssemblyError(Object.assign(new Error('limit'), { code: '53300' }))).toBe(true);
      expect(isRetryableAssemblyError(Object.assign(new Error('missing col'), { code: '42703' }))).toBe(false);
      expect(isRetryableAssemblyError(new TypeError('cannot read property'))).toBe(false);
    });
  });

  describe('assembleMany — all four buckets', () => {
    it('places each ID in exactly one bucket in a mixed batch', async () => {
      const pool = makeSequentialPool([
        // contact-1 — resolves fully
        { rows: [{ kg_node_id: 'node-1', display_name: 'Jenna Smith' }] },
        { rows: [personNodeRow] },
        { rows: [] },
        { rows: [contactRow] },
        { rows: [] },
        { rows: [] },
        // contact-2 — nodeless
        { rows: [{ kg_node_id: null, display_name: 'Seth Berman' }] },
        // ghost-id — unknown
        { rows: [] },
        { rows: [] },
        // contact-3 — DB error
        { reject: Object.assign(new Error('too many connections'), { code: '53300' }) },
      ]);

      const assembler = new EntityContextAssembler(pool, logger);
      const { entities, unresolved, nodeless, failed } = await assembler.assembleMany([
        'contact-1',
        'contact-2',
        'ghost-id',
        'contact-3',
      ]);

      expect(entities).toHaveLength(1);
      expect(nodeless.map(n => n.contactId)).toEqual(['contact-2']);
      expect(unresolved).toEqual(['ghost-id']);
      expect(failed).toEqual([{ inputId: 'contact-3', retryable: true }]);
    });
  });
});
