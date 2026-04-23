import { describe, it, expect, vi } from 'vitest';
import { ContextForEmailHandler } from '../../../skills/context-for-email/handler.js';
import type { SkillContext, AgentPersona } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

const TEST_PERSONA: AgentPersona = {
  displayName: 'Test Agent',
  title: 'Agent Chief of Staff',
};

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    agentPersona: TEST_PERSONA,
    ...overrides,
  };
}

function makeEntityMemory() {
  const entities = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
  const facts = new Map<string, Array<{ id: string; label: string; properties: Record<string, unknown>; temporal: { lastConfirmedAt: Date; confidence: number; decayClass: string; source: string; createdAt: Date } }>>();
  let nextId = 1;

  return {
    findEntities: vi.fn(async (label: string) => {
      const matches: Array<{ id: string; label: string; properties: Record<string, unknown> }> = [];
      for (const e of entities.values()) {
        if (e.label.toLowerCase() === label.toLowerCase()) matches.push(e);
      }
      return matches;
    }),
    createEntity: vi.fn(async (opts: { type: string; label: string; properties: Record<string, unknown>; source: string }) => {
      const id = `entity-${nextId++}`;
      const entity = { id, label: opts.label, properties: opts.properties };
      entities.set(id, entity);
      facts.set(id, []);
      // Return the new { entity, created } shape matching the updated createEntity API
      return { entity, created: true };
    }),
    storeFact: vi.fn(async (opts: { entityNodeId: string; label: string; properties: Record<string, unknown>; confidence: number; decayClass: string; source: string }) => {
      const entityFacts = facts.get(opts.entityNodeId) ?? [];
      const existing = entityFacts.find((f) => f.label === opts.label);
      if (existing) {
        existing.properties = opts.properties;
        existing.temporal.lastConfirmedAt = new Date();
        return { stored: true, nodeId: existing.id };
      }
      const factId = `fact-${nextId++}`;
      const now = new Date();
      entityFacts.push({
        id: factId, label: opts.label, properties: opts.properties,
        temporal: { lastConfirmedAt: now, confidence: opts.confidence, decayClass: opts.decayClass, source: opts.source, createdAt: now },
      });
      facts.set(opts.entityNodeId, entityFacts);
      return { stored: true, nodeId: factId };
    }),
    getFacts: vi.fn(async (entityNodeId: string) => facts.get(entityNodeId) ?? []),
  };
}

function makeContactService() {
  return {
    findContactByName: vi.fn(async () => []),
    getContactWithIdentities: vi.fn(async () => undefined),
  };
}

describe('ContextForEmailHandler', () => {
  const handler = new ContextForEmailHandler();

  describe('input validation', () => {
    it('rejects invalid email_type', async () => {
      const result = await handler.execute(makeCtx({ email_type: 'spam', recipient_name: 'Alice' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('email_type');
    });

    it('rejects missing recipient_name', async () => {
      const result = await handler.execute(makeCtx({ email_type: 'meeting-request' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('recipient_name');
    });
  });

  describe('context assembly', () => {
    it('returns default guidelines and agent signature with no KG or contacts', async () => {
      const result = await handler.execute(makeCtx({
        email_type: 'meeting-request',
        recipient_name: 'Alice',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          guidelines: { required_elements: string[] };
          guidelines_source: string;
          recipient: unknown;
          agent_signature: string;
          instructions: string;
        };
        expect(data.guidelines_source).toBe('default');
        expect(data.guidelines.required_elements).toBeInstanceOf(Array);
        expect(data.agent_signature).toContain('Test Agent');
        expect(data.recipient).toBeNull();
        expect(data.instructions).toContain('meeting-request');
      }
    });

    it('includes contact info when contact service finds a match', async () => {
      const cs = makeContactService();
      cs.findContactByName.mockResolvedValue([
        { id: 'c1', displayName: 'Alice Smith', role: 'cfo', kgNodeId: null, status: 'confirmed', notes: null, createdAt: new Date(), updatedAt: new Date() },
      ]);
      cs.getContactWithIdentities.mockResolvedValue({
        contact: { id: 'c1', displayName: 'Alice Smith', role: 'cfo', kgNodeId: null, status: 'confirmed', notes: null, createdAt: new Date(), updatedAt: new Date() },
        identities: [
          { id: 'i1', contactId: 'c1', channel: 'email', channelIdentifier: 'alice@example.com', label: null, verified: true, verifiedAt: new Date(), source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date() },
        ],
      });

      const result = await handler.execute(makeCtx(
        { email_type: 'cancel', recipient_name: 'Alice' },
        { contactService: cs as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { recipient: { display_name: string; role: string; email: string } };
        expect(data.recipient.display_name).toBe('Alice Smith');
        expect(data.recipient.role).toBe('cfo');
        expect(data.recipient.email).toBe('alice@example.com');
      }
    });

    it('includes meeting link when found in KG', async () => {
      const em = makeEntityMemory();
      // Set up a meeting-links anchor with Alice's Zoom link
      const { entity: anchor } = await em.createEntity({
        type: 'concept', label: 'meeting-links',
        properties: {}, source: 'test',
      });
      await em.storeFact({
        entityNodeId: anchor.id, label: 'alice zoom link',
        properties: { person_name: 'Alice Smith', platform: 'zoom', link: 'https://zoom.us/j/alice123' },
        confidence: 1.0, decayClass: 'slow_decay', source: 'test',
      });

      const result = await handler.execute(makeCtx(
        { email_type: 'meeting-request', recipient_name: 'Alice' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { recipient: { meeting_link: string } };
        expect(data.recipient.meeting_link).toBe('https://zoom.us/j/alice123');
      }
    });

    it('works for all 4 email types', async () => {
      for (const emailType of ['meeting-request', 'reschedule', 'cancel', 'doc-request']) {
        const result = await handler.execute(makeCtx({
          email_type: emailType,
          recipient_name: 'Bob',
        }));
        expect(result.success).toBe(true);
        if (result.success) {
          const data = result.data as { guidelines_source: string };
          expect(data.guidelines_source).toBe('default');
        }
      }
    });
  });
});
