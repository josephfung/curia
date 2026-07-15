// External-source enrichment (CRM/calendar → contact) — service/resolver seam (#1382).

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIf,
  makeRunId,
  signalForRun,
  createContactStack,
  type ContactTestStack,
} from './harness.js';

describeIf('Contact resolution: external source enrichment', () => {
  let stack: ContactTestStack;
  const runId = makeRunId();

  beforeAll(async () => {
    stack = await createContactStack();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('calendar_attendee / crm_import identities auto-verify and resolve', async () => {
    const email = `cal-attendee-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Calendar Guest ${runId}`,
      role: 'Advisor',
      source: 'calendar_attendee',
      tier: 'known',
      organization: 'Acme Corp',
      timezone: 'America/Toronto',
      title: 'VP Ops',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    const identity = await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'calendar_attendee',
    });
    expect(identity.verified).toBe(true);

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.verified).toBe(true);
    expect(resolved.tier).toBe('known');

    // Canonical fields round-trip
    const stored = await stack.contactService.getContact(contact.id);
    expect(stored?.organization).toBe('Acme Corp');
    expect(stored?.timezone).toBe('America/Toronto');
    expect(stored?.title).toBe('VP Ops');
  });

  it('enrichment via crm_import Signal identity + field update is resolvable', async () => {
    const email = `crm-${runId}@example.com`;
    const signalId = signalForRun(runId, 66);

    const contact = await stack.contactService.createContact({
      displayName: `CRM Import ${runId}`,
      source: 'crm_import',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'crm_import',
    });

    // Edge: channel not yet linked → unresolved
    const before = await stack.resolver.resolve('signal', signalId);
    expect(before.resolved).toBe(false);

    const signalIdentity = await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'signal',
      channelIdentifier: signalId,
      source: 'crm_import',
    });
    expect(signalIdentity.verified).toBe(true);

    await stack.contactService.updateContactFields(contact.id, {
      organization: 'Globex',
      timezone: 'America/Vancouver',
      title: 'Partner',
    });

    const after = await stack.resolver.resolve('signal', signalId);
    expect(after.resolved).toBe(true);
    if (!after.resolved) return;
    expect(after.verified).toBe(true);

    const stored = await stack.contactService.getContact(contact.id);
    expect(stored?.organization).toBe('Globex');
    expect(stored?.timezone).toBe('America/Vancouver');
    expect(stored?.title).toBe('Partner');
  });

  it('enriched KG facts surface in knowledgeSummary after external create', async () => {
    const email = `crm-kg-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `CRM KG ${runId}`,
      source: 'crm_import',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'crm_import',
    });

    if (contact.kgNodeId) {
      const factResult = await stack.entityMemory.storeFact({
        entityNodeId: contact.kgNodeId,
        label: `Imported from HubSpot account run ${runId}`,
        source: 'crm_import',
      });
      if (factResult.stored && factResult.nodeId) {
        stack.trackKgNode(factResult.nodeId);
      }
    }

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.knowledgeSummary).toContain(`HubSpot account run ${runId}`);
  });
});
