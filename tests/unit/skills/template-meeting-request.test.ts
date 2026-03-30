import { describe, it, expect, vi } from 'vitest';
import { TemplateMeetingRequestHandler } from '../../../skills/template-meeting-request/handler.js';
import type { SkillContext, AgentPersona } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

const TEST_PERSONA: AgentPersona = {
  displayName: 'Nathan Curia',
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

/** Stub EntityMemory that stores/retrieves from a simple in-memory map. */
function makeEntityMemory() {
  const entities = new Map<string, { id: string; label: string; properties: Record<string, unknown> }>();
  const facts = new Map<string, Array<{ id: string; label: string; properties: Record<string, unknown>; temporal: { lastConfirmedAt: Date; confidence: number; decayClass: string; source: string; createdAt: Date } }>>();
  let nextId = 1;

  return {
    findEntities: vi.fn(async (label: string) => {
      const matches: Array<{ id: string; label: string; properties: Record<string, unknown> }> = [];
      for (const e of entities.values()) {
        if (e.label.toLowerCase() === label.toLowerCase()) {
          matches.push(e);
        }
      }
      return matches;
    }),
    createEntity: vi.fn(async (opts: { type: string; label: string; properties: Record<string, unknown>; source: string }) => {
      const id = `entity-${nextId++}`;
      const entity = { id, label: opts.label, properties: opts.properties };
      entities.set(id, entity);
      facts.set(id, []);
      return entity;
    }),
    storeFact: vi.fn(async (opts: { entityNodeId: string; label: string; properties: Record<string, unknown>; confidence: number; decayClass: string; source: string }) => {
      const entityFacts = facts.get(opts.entityNodeId) ?? [];
      // Simulate dedup: update existing fact with same label
      const existing = entityFacts.find((f) => f.label === opts.label);
      if (existing) {
        existing.properties = opts.properties;
        existing.temporal.lastConfirmedAt = new Date();
        return { stored: true, nodeId: existing.id };
      }
      const factId = `fact-${nextId++}`;
      const now = new Date();
      entityFacts.push({
        id: factId,
        label: opts.label,
        properties: opts.properties,
        temporal: { lastConfirmedAt: now, confidence: opts.confidence, decayClass: opts.decayClass, source: opts.source, createdAt: now },
      });
      facts.set(opts.entityNodeId, entityFacts);
      return { stored: true, nodeId: factId };
    }),
    getFacts: vi.fn(async (entityNodeId: string) => {
      return facts.get(entityNodeId) ?? [];
    }),
  };
}

describe('TemplateMeetingRequestHandler', () => {
  const handler = new TemplateMeetingRequestHandler();

  describe('action validation', () => {
    it('rejects missing action', async () => {
      const result = await handler.execute(makeCtx({}));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('action');
    });

    it('rejects invalid action', async () => {
      const result = await handler.execute(makeCtx({ action: 'invalid' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('action');
    });
  });

  describe('generate', () => {
    it('rejects when recipient_name is missing', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        sender_name: 'CEO',
        proposed_times: 'Monday 10am',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('recipient_name');
    });

    it('rejects when sender_name is missing', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Alice',
        proposed_times: 'Monday 10am',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('sender_name');
    });

    it('rejects when proposed_times is missing', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Alice',
        sender_name: 'CEO',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('proposed_times');
    });

    it('generates with default template when no entityMemory', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Alice',
        sender_name: 'Joseph',
        proposed_times: 'Monday 10am, Tuesday 2pm',
        meeting_purpose: 'Q3 Planning',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { subject: string; body: string; template_source: string };
        expect(data.template_source).toBe('default');
        expect(data.subject).toContain('Q3 Planning');
        expect(data.body).toContain('Alice');
        expect(data.body).toContain('Joseph');
        expect(data.body).toContain('Monday 10am');
        expect(data.body).toContain('Tuesday 2pm');
      }
    });

    it('generates with default template when entityMemory has no custom template', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Bob',
          sender_name: 'CEO',
          proposed_times: 'Wednesday 3pm',
        },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { subject: string; body: string; template_source: string };
        expect(data.template_source).toBe('default');
        expect(data.body).toContain('Bob');
      }
    });

    it('generates with custom template from KG', async () => {
      const em = makeEntityMemory();
      // Pre-populate a custom template
      const anchor = await em.createEntity({
        type: 'concept',
        label: 'template:meeting-request',
        properties: { category: 'email-template' },
        source: 'test',
      });
      await em.storeFact({
        entityNodeId: anchor.id,
        label: 'template body',
        properties: { body: 'Subject: Custom — {{meeting_purpose}}\n\nDear {{recipient_name}}, let us meet. Times: {{proposed_times}}' },
        confidence: 1.0,
        decayClass: 'permanent',
        source: 'test',
      });

      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Carol',
          sender_name: 'CEO',
          proposed_times: 'Thursday 11am',
          meeting_purpose: 'Budget Review',
        },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { subject: string; body: string; template_source: string };
        expect(data.template_source).toBe('custom');
        expect(data.subject).toContain('Budget Review');
        expect(data.body).toContain('Carol');
      }
    });

    it('includes optional fields when provided', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Dave',
        sender_name: 'CEO',
        proposed_times: 'Friday 9am',
        meeting_purpose: 'Product Demo',
        meeting_duration: '45 minutes',
        meeting_location: 'Zoom',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { subject: string; body: string; template_source: string };
        expect(data.body).toContain('45 minutes');
        expect(data.body).toContain('Zoom');
      }
    });

    it('uses agent persona for signature in default template', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Eve',
        sender_name: 'CEO',
        proposed_times: 'Monday 9am',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { body: string };
        expect(data.body).toContain('Nathan Curia');
        expect(data.body).toContain('Agent Chief of Staff');
      }
    });

    it('uses custom emailSignature when configured', async () => {
      const customPersona: AgentPersona = {
        displayName: 'Alex Helper',
        title: 'Executive Assistant',
        emailSignature: 'Alex Helper\nExecutive Assistant\nAcme Corp',
      };
      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Frank',
          sender_name: 'CEO',
          proposed_times: 'Tuesday 3pm',
        },
        { agentPersona: customPersona },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { body: string };
        expect(data.body).toContain('Alex Helper');
        expect(data.body).toContain('Acme Corp');
        // Should NOT contain the default persona
        expect(data.body).not.toContain('Nathan Curia');
      }
    });

    it('omits signature when no persona is provided', async () => {
      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Grace',
          sender_name: 'CEO',
          proposed_times: 'Wednesday 1pm',
        },
        { agentPersona: undefined },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { body: string };
        // The signature placeholder should be filled with empty string
        // and no hardcoded name should appear
        expect(data.body).not.toContain('Nathan Curia');
      }
    });
  });

  describe('save', () => {
    it('rejects when custom_template is missing', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'save' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('custom_template');
    });

    it('rejects when entityMemory is not available', async () => {
      const result = await handler.execute(makeCtx({
        action: 'save',
        custom_template: 'My template',
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Knowledge graph');
    });

    it('saves a new custom template', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'save', custom_template: 'Subject: New\n\nHello {{recipient_name}}' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { saved: boolean };
        expect(data.saved).toBe(true);
      }
      expect(em.createEntity).toHaveBeenCalled();
      expect(em.storeFact).toHaveBeenCalled();
    });

    it('updates an existing custom template', async () => {
      const em = makeEntityMemory();
      // First save
      await handler.execute(makeCtx(
        { action: 'save', custom_template: 'V1 template' },
        { entityMemory: em as never },
      ));
      // Second save — should update, not create new anchor
      const result = await handler.execute(makeCtx(
        { action: 'save', custom_template: 'V2 template' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      // createEntity should only be called once (for the first save)
      expect(em.createEntity).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('succeeds even without entityMemory (no-op)', async () => {
      const result = await handler.execute(makeCtx({ action: 'reset' }));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { reset: boolean };
        expect(data.reset).toBe(true);
      }
    });

    it('resets custom template so generate falls back to default', async () => {
      const em = makeEntityMemory();
      // Save a custom template
      await handler.execute(makeCtx(
        { action: 'save', custom_template: 'Subject: Custom\n\nCustom body {{recipient_name}}' },
        { entityMemory: em as never },
      ));
      // Reset it
      await handler.execute(makeCtx(
        { action: 'reset' },
        { entityMemory: em as never },
      ));
      // Generate should use default
      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Eve',
          sender_name: 'CEO',
          proposed_times: 'Monday 9am',
        },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { template_source: string };
        expect(data.template_source).toBe('default');
      }
    });
  });
});
