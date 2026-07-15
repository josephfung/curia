// Proactive identity establishment — service/resolver seam (#1382).
// Contact already known / pre-populated; resolver returns tier, attributes, and auth.

import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIf,
  makeRunId,
  createContactStack,
  type ContactTestStack,
} from './harness.js';

function signalForRun(runId: string): string {
  let n = 0;
  for (let i = 0; i < runId.length; i++) n = (n * 31 + runId.charCodeAt(i)) >>> 0;
  return `+1555${String(n % 10_000_000).padStart(7, '0')}`;
}

describeIf('Contact resolution: proactive identity establishment', () => {
  let stack: ContactTestStack;
  const runId = makeRunId();

  beforeAll(async () => {
    stack = await createContactStack();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('resolves a pre-populated CFO contact with known tier and role grants', async () => {
    const email = `proactive-cfo-${runId}@example.com`;
    const signalId = signalForRun(runId);
    const contact = await stack.contactService.createContact({
      displayName: `Proactive CFO ${runId}`,
      role: 'CFO',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'signal',
      channelIdentifier: signalId,
      source: 'ceo_stated',
    });

    // Use signal (high trust) so CFO high-sensitivity grants land in allowed, not trustBlocked.
    const resolved = await stack.resolver.resolve('signal', signalId);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;

    expect(resolved.tier).toBe('known');
    expect(resolved.verified).toBe(true);
    expect(resolved.displayName).toBe(`Proactive CFO ${runId}`);
    expect(resolved.role).toBe('CFO');
    expect(resolved.authorization).not.toBeNull();
    expect(resolved.authorization!.allowed).toEqual(
      expect.arrayContaining([
        'view_financial_reports',
        'view_board_materials',
        'request_action_items',
        'schedule_meetings',
      ]),
    );
    expect(resolved.authorization!.denied).toEqual(
      expect.arrayContaining(['send_on_behalf', 'see_personal_calendar']),
    );

    const emailResolved = await stack.resolver.resolve('email', email);
    expect(emailResolved.resolved).toBe(true);
  });

  it('returns resolved:false when contact has a role but no identity for that channel', async () => {
    const contact = await stack.contactService.createContact({
      displayName: `Partial Mention ${runId}`,
      role: 'Advisor',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    // No linkIdentity — CEO mentioned them but no channel identity yet.

    const result = await stack.resolver.resolve(
      'email',
      `partial-mention-${runId}@example.com`,
    );
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.senderId).toBe(`partial-mention-${runId}@example.com`);
    }
  });

  it('surfaces KG facts in knowledgeSummary for a known contact', async () => {
    const email = `proactive-kg-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `KG Enrich ${runId}`,
      role: 'CFO',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);

    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    if (contact.kgNodeId) {
      await stack.entityMemory.storeFact({
        entityNodeId: contact.kgNodeId,
        label: `Manages Q3 board packet for run ${runId}`,
        source: 'integration-test',
      });
    }

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.knowledgeSummary).toContain(`Q3 board packet for run ${runId}`);
  });
});
