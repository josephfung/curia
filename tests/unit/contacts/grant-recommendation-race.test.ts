// tests/unit/contacts/grant-recommendation-race.test.ts
//
// Regression tests for issue #1068: approveGrantRecommendation + declineGrantRecommendation
// must be atomic to prevent the race condition where decline wins the status transition but
// approve's auth override is left behind (or vice versa in the future).
//
// Because JS is single-threaded, Promise.all() interleaves the two calls at every `await`
// boundary in deterministic FIFO microtask order. The current (buggy) code has more awaits
// before approveGrantRecommendation writes its status transition than declineGrantRecommendation
// does, so decline ALWAYS wins the race in Promise.all([approve, decline]). This means the
// "concurrent race" test below reliably reproduces the inconsistent state that the fix must
// prevent.

import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('grant recommendation race conditions (issue #1068)', () => {
  let service: ContactService;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    const entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
    service = ContactService.createInMemory(entityMemory);
  });

  it('concurrent approve and decline: exactly one wins and final state is internally consistent', async () => {
    const contact = await service.createContact({ displayName: 'Race Test', source: 'test' });
    const { recommendation: rec } = await service.createGrantRecommendation(
      contact.id, 'schedule_meetings', 'test reasoning',
    );

    // Firing both concurrently. JS's FIFO microtask queue causes decline to win
    // deterministically because it has fewer await points before its status write
    // than approve does (approve validates the contact first).
    const [approveResult, declineResult] = await Promise.all([
      service.approveGrantRecommendation(rec.id, 'actor-approve'),
      service.declineGrantRecommendation(rec.id, 'actor-decline'),
    ]);

    // Exactly one must win — this holds even with the buggy code
    expect(approveResult !== declineResult).toBe(true);

    const finalRec = await service.getGrantRecommendation(rec.id);
    const overrides = await service.getAuthOverrides(contact.id);
    const hasOverride = overrides.some(o => o.permission === 'schedule_meetings');

    if (declineResult && !approveResult) {
      // Decline won: recommendation must be 'declined' and NO auth override may exist.
      // With the buggy code this fails because approve wrote the override before losing
      // the status transition.
      expect(finalRec?.status).toBe('declined');
      expect(hasOverride).toBe(false);
    } else {
      // Approve won: recommendation must be 'approved' and the auth override must exist.
      expect(finalRec?.status).toBe('approved');
      expect(hasOverride).toBe(true);
    }
  });

  it('when decline wins sequentially, no auth override is left behind', async () => {
    const contact = await service.createContact({ displayName: 'Decline Wins', source: 'test' });
    const { recommendation: rec } = await service.createGrantRecommendation(
      contact.id, 'send_emails', 'test reasoning',
    );

    const declineResult = await service.declineGrantRecommendation(rec.id, 'actor-decline');
    expect(declineResult).toBe(true);

    // Approve must short-circuit — recommendation is no longer pending
    const approveResult = await service.approveGrantRecommendation(rec.id, 'actor-approve');
    expect(approveResult).toBe(false);

    // Critically: no orphaned auth override may exist
    const overrides = await service.getAuthOverrides(contact.id);
    expect(overrides.some(o => o.permission === 'send_emails')).toBe(false);
  });

  it('when approve wins sequentially, the auth override and approved status are both present', async () => {
    const contact = await service.createContact({ displayName: 'Approve Wins', source: 'test' });
    const { recommendation: rec } = await service.createGrantRecommendation(
      contact.id, 'read_calendar', 'test reasoning',
    );

    const approveResult = await service.approveGrantRecommendation(rec.id, 'actor-approve');
    expect(approveResult).toBe(true);

    // Decline must short-circuit — recommendation is already approved
    const declineResult = await service.declineGrantRecommendation(rec.id, 'actor-decline');
    expect(declineResult).toBe(false);

    // Auth override must exist (approve won)
    const overrides = await service.getAuthOverrides(contact.id);
    const override = overrides.find(o => o.permission === 'read_calendar');
    expect(override).toBeDefined();
    expect(override?.granted).toBe(true);

    // Recommendation must stay 'approved', not flip to 'declined'
    const finalRec = await service.getGrantRecommendation(rec.id);
    expect(finalRec?.status).toBe('approved');
  });

  it('an approved recommendation always has a corresponding active auth override', async () => {
    const contact = await service.createContact({ displayName: 'Consistency Check', source: 'test' });
    const { recommendation: rec } = await service.createGrantRecommendation(
      contact.id, 'view_reports', 'test reasoning',
    );

    await service.approveGrantRecommendation(rec.id, 'actor');

    const finalRec = await service.getGrantRecommendation(rec.id);
    const overrides = await service.getAuthOverrides(contact.id);

    expect(finalRec?.status).toBe('approved');
    expect(overrides.some(o => o.permission === 'view_reports' && o.granted)).toBe(true);
  });

  it('a declined recommendation never has an active auth override', async () => {
    const contact = await service.createContact({ displayName: 'Decline Check', source: 'test' });
    const { recommendation: rec } = await service.createGrantRecommendation(
      contact.id, 'approve_expenses', 'test reasoning',
    );

    await service.declineGrantRecommendation(rec.id, 'actor');

    const finalRec = await service.getGrantRecommendation(rec.id);
    const overrides = await service.getAuthOverrides(contact.id);

    expect(finalRec?.status).toBe('declined');
    expect(overrides.some(o => o.permission === 'approve_expenses')).toBe(false);
  });
});
