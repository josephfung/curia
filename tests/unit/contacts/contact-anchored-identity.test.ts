// Contact-anchored KG node identity (ADR-040, #1694).
//
// Before this, a second contact sharing a display name collided on
// idx_contacts_kg_node_unique and was stored with kg_node_id = NULL — unable to hold
// facts, relationships, or entity-context enrichment, and silent about it (#1623).
//
// The migration-level halves (the backfill, the index predicates themselves, and the
// DreamEngine exclusion) are covered in tests/integration/contact-anchored-identity.test.ts,
// which needs a real Postgres.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';

describe('contact-anchored KG node identity (ADR-040)', () => {
  let service: ContactService;
  let entityMemory: EntityMemory;
  let store: KnowledgeGraphStore;
  // Captures warn/info messages. The previous increment of #1694 shipped a diagnostic at
  // `debug` into a production running at `info` and produced no signal for weeks, so the
  // load-bearing lines here are asserted rather than left to review.
  let warnings: string[];
  let logger: Logger;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
    warnings = [];
    const capture = (_obj: unknown, msg?: string) => { if (msg) warnings.push(msg); };
    logger = { ...createSilentLogger(), warn: capture, info: capture } as unknown as Logger;
    service = ContactService.createInMemory(entityMemory, undefined, logger);
  });

  describe('two contacts sharing a display name', () => {
    it('each hold their own node instead of the second going nodeless', async () => {
      const first = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const second = await service.createContact({ displayName: 'Seth Berman', source: 'test' });

      expect(first.kgNodeId).not.toBeNull();
      expect(second.kgNodeId).not.toBeNull();
      expect(second.kgNodeId).not.toBe(first.kgNodeId);
    });

    it('anchors the second node rather than leaving it in the label tier', async () => {
      // The first create adopts the label tier by minting anchored; the second cannot
      // adopt (the match is anchored) and must mint its own anchored node.
      const first = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const second = await service.createContact({ displayName: 'Seth Berman', source: 'test' });

      expect((await store.getNode(first.kgNodeId!))?.identitySource).toBe('contact');
      expect((await store.getNode(second.kgNodeId!))?.identitySource).toBe('contact');
    });

    it('keeps their facts separate — storing on one does not leak onto the namesake', async () => {
      const first = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const second = await service.createContact({ displayName: 'Seth Berman', source: 'test' });

      await entityMemory.storeFact({
        entityNodeId: first.kgNodeId!,
        label: 'Runs the Vancouver office',
        source: 'test',
      });
      await entityMemory.storeFact({
        entityNodeId: second.kgNodeId!,
        label: 'Chairs the audit committee',
        source: 'test',
      });

      const firstFacts = (await entityMemory.getFacts(first.kgNodeId!)).map(f => f.label);
      const secondFacts = (await entityMemory.getFacts(second.kgNodeId!)).map(f => f.label);

      expect(firstFacts).toEqual(['Runs the Vancouver office']);
      expect(secondFacts).toEqual(['Chairs the audit committee']);
    });

    it('gives each an independent relationship graph', async () => {
      const first = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const second = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const acme = await entityMemory.createEntity({
        type: 'organization', label: 'Acme', properties: {}, source: 'test',
      });

      await entityMemory.link(first.kgNodeId!, acme.entity.id, 'member_of', {}, 'test');

      expect(await entityMemory.findEdges(first.kgNodeId!)).toHaveLength(1);
      expect(await entityMemory.findEdges(second.kgNodeId!)).toHaveLength(0);
    });
  });

  describe('adoption', () => {
    it('adopts an unanchored node so the contact inherits what Curia already knew', async () => {
      // Curia learns about Dana from an email body, then Dana emails in.
      const { entity } = await entityMemory.createEntity({
        type: 'person', label: 'Dana Wu', properties: {}, source: 'extraction',
      });
      await entityMemory.storeFact({
        entityNodeId: entity.id, label: 'Prefers morning meetings', source: 'extraction',
      });

      const contact = await service.createContact({ displayName: 'Dana Wu', source: 'test' });

      expect(contact.kgNodeId).toBe(entity.id);
      expect((await store.getNode(entity.id))?.identitySource).toBe('contact');
      expect((await entityMemory.getFacts(entity.id)).map(f => f.label))
        .toEqual(['Prefers morning meetings']);
    });

    it('applies the role to an adopted node that had none', async () => {
      const { entity } = await entityMemory.createEntity({
        type: 'person', label: 'Dana Wu', properties: {}, source: 'extraction',
      });

      await service.createContact({ displayName: 'Dana Wu', role: 'CFO', source: 'test' });

      expect((await store.getNode(entity.id))?.properties['role']).toBe('CFO');
    });

    it('does not overwrite a role the adopted node already carried', async () => {
      const { entity } = await entityMemory.createEntity({
        type: 'person', label: 'Dana Wu', properties: { role: 'Founder' }, source: 'extraction',
      });

      await service.createContact({ displayName: 'Dana Wu', role: 'CFO', source: 'test' });

      expect((await store.getNode(entity.id))?.properties['role']).toBe('Founder');
    });

    it('never takes a node that already belongs to another contact', async () => {
      const owner = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const newcomer = await service.createContact({ displayName: 'Seth Berman', source: 'test' });

      expect(newcomer.kgNodeId).not.toBe(owner.kgNodeId);
      // And the owner keeps theirs.
      const reread = await service.getContact(owner.id);
      expect(reread?.kgNodeId).toBe(owner.kgNodeId);
    });

    it('mints rather than guessing when several unanchored nodes share the label', async () => {
      // Reachable via aliases, which carry no cross-node uniqueness: two person nodes can
      // both answer to "Sam". Picking one would be the silent first-match guess #1705
      // removed from resolveOrCreate.
      const a = await store.createNode({ type: 'person', label: 'Sam Alpha', properties: {}, source: 'test' });
      const b = await store.createNode({ type: 'person', label: 'Sam Beta', properties: {}, source: 'test' });
      await entityMemory.addAlias(a.id, 'Sam');
      await entityMemory.addAlias(b.id, 'Sam');

      const contact = await service.createContact({ displayName: 'Sam', source: 'test' });

      expect(contact.kgNodeId).not.toBe(a.id);
      expect(contact.kgNodeId).not.toBe(b.id);
      expect((await store.getNode(contact.kgNodeId!))?.identitySource).toBe('contact');
      // Neither candidate was quietly claimed.
      expect((await store.getNode(a.id))?.identitySource).toBe('label');
      expect((await store.getNode(b.id))?.identitySource).toBe('label');
    });

    it('ignores nodes of another type — "River" the org is not "River" the person', async () => {
      const { entity: org } = await entityMemory.createEntity({
        type: 'organization', label: 'River', properties: {}, source: 'test',
      });

      const contact = await service.createContact({ displayName: 'River', source: 'test' });

      expect(contact.kgNodeId).not.toBe(org.id);
      expect((await store.getNode(org.id))?.identitySource).toBe('label');
    });

    it('mints a fresh node when the KG lookup fails rather than failing the create', async () => {
      // A KG outage must cost an inheritance, never a contact.
      const failing = new Proxy(entityMemory, {
        get(target, prop, receiver) {
          if (prop === 'findEntities') {
            return async () => { throw new Error('kg unavailable'); };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as EntityMemory;
      const degraded = ContactService.createInMemory(failing);

      const contact = await degraded.createContact({ displayName: 'Dana Wu', source: 'test' });

      expect(contact.kgNodeId).not.toBeNull();
      expect((await store.getNode(contact.kgNodeId!))?.identitySource).toBe('contact');
    });
  });

  describe('link collision recovery', () => {
    it('mints a fresh anchored node instead of storing the contact nodeless', async () => {
      // The 23505 path: the node we resolved was claimed between lookup and INSERT.
      // Forced here by handing createContact a node another contact already holds.
      // Before ADR-040 this produced kg_node_id = NULL and a contact that could hold
      // nothing — the exact failure #1694 exists to remove.
      const owner = await service.createContact({ displayName: 'Seth Berman', source: 'test' });

      const loser = await service.createContact({
        displayName: 'Seth Berman', kgNodeId: owner.kgNodeId!, source: 'test',
      });

      expect(loser.kgNodeId).not.toBeNull();
      expect(loser.kgNodeId).not.toBe(owner.kgNodeId);
      expect((await store.getNode(loser.kgNodeId!))?.identitySource).toBe('contact');
      // The contact is persisted with the replacement, not just returned with it.
      expect((await service.getContact(loser.id))?.kgNodeId).toBe(loser.kgNodeId);
    });

    it('can hold facts on the replacement node', async () => {
      const owner = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const loser = await service.createContact({
        displayName: 'Seth Berman', kgNodeId: owner.kgNodeId!, source: 'test',
      });

      await entityMemory.storeFact({
        entityNodeId: loser.kgNodeId!, label: 'Chairs the audit committee', source: 'test',
      });

      expect((await entityMemory.getFacts(loser.kgNodeId!)).map(f => f.label))
        .toEqual(['Chairs the audit committee']);
      expect(await entityMemory.getFacts(owner.kgNodeId!)).toHaveLength(0);
    });

    it('falls back to a nodeless contact only when minting also fails', async () => {
      const owner = await service.createContact({ displayName: 'Seth Berman', source: 'test' });
      const failing = new Proxy(entityMemory, {
        get(target, prop, receiver) {
          if (prop === 'createAnchoredEntity') {
            return async () => { throw new Error('kg unavailable'); };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as EntityMemory;
      const degraded = ContactService.createInMemory(failing);
      const existing = await degraded.createContact({
        displayName: 'Seth Berman', kgNodeId: owner.kgNodeId!, source: 'test',
      });

      const loser = await degraded.createContact({
        displayName: 'Seth Berman', kgNodeId: existing.kgNodeId ?? owner.kgNodeId!, source: 'test',
      });

      expect(loser.kgNodeId).toBeNull();
    });
  });

  describe('organization contacts', () => {
    it('lets several role addresses at one domain share their organization node', async () => {
      const info = await service.createContact({
        displayName: 'Acme', primaryEmail: 'info@acme.com', source: 'test',
      });
      const support = await service.createContact({
        displayName: 'Acme', primaryEmail: 'support@acme.com', source: 'test',
      });

      expect(info.kind).toBe('organization');
      expect(support.kind).toBe('organization');
      expect(support.kgNodeId).toBe(info.kgNodeId);
      expect(support.kgNodeId).not.toBeNull();
    });

    it('leaves the shared organization node in the label tier', async () => {
      // Org nodes outlive any one contact and are legitimately shared, so they keep
      // label identity and stay deduplicated by (lower(label), type).
      const info = await service.createContact({
        displayName: 'Acme', primaryEmail: 'info@acme.com', source: 'test',
      });

      expect((await store.getNode(info.kgNodeId!))?.identitySource).toBe('label');
    });
  });

  describe('deleteContact', () => {
    it('archives the anchored node — its whole meaning was that contact', async () => {
      const contact = await service.createContact({ displayName: 'Dana Wu', source: 'test' });
      const nodeId = contact.kgNodeId!;

      await service.deleteContact(contact.id);

      expect(await store.getNode(nodeId)).toBeUndefined();
    });

    it('frees the label for reuse — a later namesake can be created cleanly', async () => {
      const first = await service.createContact({ displayName: 'Dana Wu', source: 'test' });
      await service.deleteContact(first.id);

      const second = await service.createContact({ displayName: 'Dana Wu', source: 'test' });

      expect(second.kgNodeId).not.toBeNull();
      expect(second.kgNodeId).not.toBe(first.kgNodeId);
    });

    it('leaves a label-tier node alone — an organization outlives its contacts', async () => {
      const contact = await service.createContact({
        displayName: 'Acme', primaryEmail: 'info@acme.com', source: 'test',
      });
      const nodeId = contact.kgNodeId!;

      await service.deleteContact(contact.id);

      expect(await store.getNode(nodeId)).toBeDefined();
    });

    it('leaves an anchored node alone while another contact still points at it', async () => {
      // Organization contacts are exempt from idx_contacts_kg_node_unique, so several can
      // share one node — including an anchored one minted by migration 085's backfill.
      const shared = await store.createNode({
        type: 'organization', label: 'Acme', properties: {}, source: 'migration_085',
        identitySource: 'contact',
      });
      const a = await service.createContact({
        displayName: 'Acme A', kind: 'organization', kgNodeId: shared.id, source: 'test',
      });
      await service.createContact({
        displayName: 'Acme B', kind: 'organization', kgNodeId: shared.id, source: 'test',
      });

      await service.deleteContact(a.id);

      expect(await store.getNode(shared.id)).toBeDefined();
    });

    it('still deletes the contact when archiving its node fails', async () => {
      const contact = await service.createContact({ displayName: 'Dana Wu', source: 'test' });
      const failing = new Proxy(entityMemory, {
        get(target, prop, receiver) {
          if (prop === 'archiveEntity') {
            return async () => { throw new Error('kg unavailable'); };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }) as EntityMemory;

      // createInMemory builds a fresh backend each call, so `degraded` has its own contact
      // store; the contact under test has to be created inside it.
      const degraded = ContactService.createInMemory(failing, undefined, logger);
      const own = await degraded.createContact({ displayName: 'Dana Wu', source: 'test' });

      await expect(degraded.deleteContact(own.id)).resolves.toBeUndefined();

      // The delete is what must survive — and the failure must be visible, not swallowed.
      expect(await degraded.getContact(own.id)).toBeUndefined();
      expect(warnings.some(w => /node is now orphaned/.test(w))).toBe(true);
      expect(contact.kgNodeId).not.toBeNull();
    });

    it('does not archive the node during orphan cleanup', async () => {
      // The three real deleteContact callers are all orphan cleanup after a failed
      // linkIdentity, and createContact may have ADOPTED a node carrying facts accrued
      // long before this attempt. Archiving cascades to incident edges, so cleaning up
      // would destroy knowledge that was never this contact's to take.
      const { entity } = await entityMemory.createEntity({
        type: 'person', label: 'Dana Wu', properties: {}, source: 'extraction',
      });
      await entityMemory.storeFact({
        entityNodeId: entity.id, label: 'Prefers morning meetings', source: 'extraction',
      });
      const contact = await service.createContact({ displayName: 'Dana Wu', source: 'test' });
      expect(contact.kgNodeId).toBe(entity.id);

      await service.deleteContact(contact.id, { archiveAnchoredNode: false });

      expect(await store.getNode(entity.id)).toBeDefined();
      expect((await entityMemory.getFacts(entity.id)).map(f => f.label))
        .toEqual(['Prefers morning meetings']);
    });

    it('reports the node it deliberately left behind during orphan cleanup', async () => {
      // Skipping the archive leaks an anchored node that no longer decays, so the leak
      // has to be visible rather than silent.
      const svc = ContactService.createInMemory(entityMemory, undefined, logger);
      const contact = await svc.createContact({ displayName: 'Dana Wu', source: 'test' });

      await svc.deleteContact(contact.id, { archiveAnchoredNode: false });

      expect(warnings.some(w => /without archiving its KG node/.test(w))).toBe(true);
    });
  });
});
