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

/** Stub EntityMemory with in-memory storage. */
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
      // Check if an entity with this label already exists (mimics upsert behaviour)
      for (const e of entities.values()) {
        if (e.label.toLowerCase() === opts.label.toLowerCase()) {
          return { entity: e, created: false };
        }
      }
      const id = `entity-${nextId++}`;
      const entity = { id, label: opts.label, properties: opts.properties };
      entities.set(id, entity);
      facts.set(id, []);
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
    });
  });

  describe('generate', () => {
    it('rejects when required inputs are missing', async () => {
      const result = await handler.execute(makeCtx({ action: 'generate', sender_name: 'CEO', proposed_times: 'Monday 10am' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('recipient_name');
    });

    it('returns guidelines + context with default policy when no KG', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Alice',
        sender_name: 'Joseph',
        proposed_times: 'Monday 10am, Tuesday 2pm',
        meeting_purpose: 'Q3 Planning',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          guidelines: { required_elements: string[]; tone: string; structure: string; constraints: string[]; example: string };
          context: Record<string, string>;
          source: string;
          instructions: string;
        };
        // Returns structured guidelines, NOT a pre-filled email
        expect(data.source).toBe('default');
        expect(data.guidelines.required_elements).toBeInstanceOf(Array);
        expect(data.guidelines.tone).toBeDefined();
        expect(data.guidelines.structure).toBeDefined();
        expect(data.guidelines.constraints).toBeInstanceOf(Array);
        expect(data.guidelines.example).toContain('Subject:');
        expect(data.instructions).toContain('guidelines');

        // Context passes through the input variables for the LLM
        expect(data.context.recipient_name).toBe('Alice');
        expect(data.context.sender_name).toBe('Joseph');
        expect(data.context.proposed_times).toBe('Monday 10am, Tuesday 2pm');
        expect(data.context.meeting_purpose).toBe('Q3 Planning');
        expect(data.context.agent_signature).toContain('Nathan Curia');
      }
    });

    it('returns custom policy from KG when available', async () => {
      const em = makeEntityMemory();
      const { entity: anchor } = await em.createEntity({
        type: 'concept', label: 'template:meeting-request',
        properties: { category: 'email-policy' }, source: 'test',
      });
      const customPolicy = JSON.stringify({
        required_elements: ['Keep it short', 'Include a joke'],
        tone: 'Casual and friendly',
      });
      await em.storeFact({
        entityNodeId: anchor.id, label: 'email policy',
        properties: { policy: customPolicy },
        confidence: 1.0, decayClass: 'permanent', source: 'test',
      });

      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Carol', sender_name: 'CEO', proposed_times: 'Thursday 11am',
        },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { guidelines: { tone: string }; source: string };
        expect(data.source).toBe('custom');
        expect(data.guidelines.tone).toBe('Casual and friendly');
      }
    });

    it('handles plain-text custom policy (non-JSON)', async () => {
      const em = makeEntityMemory();
      const { entity: anchor } = await em.createEntity({
        type: 'concept', label: 'template:meeting-request',
        properties: {}, source: 'test',
      });
      await em.storeFact({
        entityNodeId: anchor.id, label: 'email policy',
        properties: { policy: 'Always mention the CEO loves coffee meetings.' },
        confidence: 1.0, decayClass: 'permanent', source: 'test',
      });

      const result = await handler.execute(makeCtx(
        {
          action: 'generate',
          recipient_name: 'Dan', sender_name: 'CEO', proposed_times: 'Friday 2pm',
        },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { guidelines: { custom_guidelines: string }; source: string };
        expect(data.source).toBe('custom');
        expect(data.guidelines.custom_guidelines).toContain('coffee meetings');
      }
    });

    it('includes optional context fields when provided', async () => {
      const result = await handler.execute(makeCtx({
        action: 'generate',
        recipient_name: 'Dave', sender_name: 'CEO', proposed_times: 'Friday 9am',
        meeting_purpose: 'Product Demo', meeting_duration: '45 minutes', meeting_location: 'Zoom',
      }));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { context: Record<string, string> };
        expect(data.context.meeting_duration).toBe('45 minutes');
        expect(data.context.meeting_location).toBe('Zoom');
      }
    });

    it('uses custom emailSignature when configured', async () => {
      const customPersona: AgentPersona = {
        displayName: 'Alex Helper', title: 'Executive Assistant',
        emailSignature: 'Alex Helper, Executive Assistant, Acme Corp',
      };
      const result = await handler.execute(makeCtx(
        { action: 'generate', recipient_name: 'Frank', sender_name: 'CEO', proposed_times: 'Tuesday 3pm' },
        { agentPersona: customPersona },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { context: { agent_signature: string } };
        expect(data.context.agent_signature).toContain('Acme Corp');
        expect(data.context.agent_signature).not.toContain('Nathan Curia');
      }
    });
  });

  describe('save', () => {
    it('rejects when custom_policy is missing', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx({ action: 'save' }, { entityMemory: em as never }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('custom_policy');
    });

    it('rejects when entityMemory is not available', async () => {
      const result = await handler.execute(makeCtx({ action: 'save', custom_policy: 'My policy' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Knowledge graph');
    });

    it('saves a new custom policy', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx(
        { action: 'save', custom_policy: '{"tone": "Very casual"}' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(true);
      expect(em.createEntity).toHaveBeenCalled();
      expect(em.storeFact).toHaveBeenCalled();
    });
  });

  describe('update (natural language refinement)', () => {
    it('rejects when refinement is missing', async () => {
      const em = makeEntityMemory();
      const result = await handler.execute(makeCtx({ action: 'update' }, { entityMemory: em as never }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('refinement');
    });

    it('rejects when entityMemory is not available', async () => {
      const result = await handler.execute(makeCtx({ action: 'update', refinement: 'make it casual' }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Knowledge graph');
    });

    it('stores a refinement and returns it in generate', async () => {
      const em = makeEntityMemory();
      // Store a refinement
      const updateResult = await handler.execute(makeCtx(
        { action: 'update', refinement: 'Always mention that my assistant can help with scheduling' },
        { entityMemory: em as never },
      ));
      expect(updateResult.success).toBe(true);
      if (updateResult.success) {
        const data = updateResult.data as { updated: boolean; refinement: string };
        expect(data.updated).toBe(true);
      }

      // Generate should now include the refinement
      const genResult = await handler.execute(makeCtx(
        { action: 'generate', recipient_name: 'Alice', sender_name: 'CEO', proposed_times: 'Monday 9am' },
        { entityMemory: em as never },
      ));
      expect(genResult.success).toBe(true);
      if (genResult.success) {
        const data = genResult.data as { guidelines: { refinements: string[] }; source: string };
        expect(data.source).toBe('refined');
        expect(data.guidelines.refinements).toContain('Always mention that my assistant can help with scheduling');
      }
    });

    it('accumulates multiple refinements', async () => {
      const em = makeEntityMemory();
      await handler.execute(makeCtx(
        { action: 'update', refinement: 'Make these less formal' },
        { entityMemory: em as never },
      ));
      // Small delay so the timestamp-based label is unique (the real KG
      // uses dedup by label similarity, not exact match, but our test stub
      // deduplicates by exact label — same-millisecond timestamps collide).
      await new Promise((r) => setTimeout(r, 2));
      await handler.execute(makeCtx(
        { action: 'update', refinement: 'Keep them under 3 sentences' },
        { entityMemory: em as never },
      ));

      const result = await handler.execute(makeCtx(
        { action: 'generate', recipient_name: 'Bob', sender_name: 'CEO', proposed_times: 'Tuesday 2pm' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { guidelines: { refinements: string[] } };
        expect(data.guidelines.refinements).toHaveLength(2);
        expect(data.guidelines.refinements[0]).toContain('less formal');
        expect(data.guidelines.refinements[1]).toContain('3 sentences');
      }
    });
  });

  describe('reset', () => {
    it('succeeds without entityMemory (no-op)', async () => {
      const result = await handler.execute(makeCtx({ action: 'reset' }));
      expect(result.success).toBe(true);
    });

    it('resets refinements so generate returns default source', async () => {
      const em = makeEntityMemory();
      // Add a refinement
      await handler.execute(makeCtx(
        { action: 'update', refinement: 'Keep it short' },
        { entityMemory: em as never },
      ));
      // Reset
      await handler.execute(makeCtx({ action: 'reset' }, { entityMemory: em as never }));
      // Generate should be default, not refined
      const result = await handler.execute(makeCtx(
        { action: 'generate', recipient_name: 'Frank', sender_name: 'CEO', proposed_times: 'Friday 3pm' },
        { entityMemory: em as never },
      ));
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { source: string };
        expect(data.source).toBe('default');
      }
    });

    it('resets custom policy so generate falls back to default', async () => {
      const em = makeEntityMemory();
      await handler.execute(makeCtx(
        { action: 'save', custom_policy: '{"tone": "Very casual"}' },
        { entityMemory: em as never },
      ));
      await handler.execute(makeCtx({ action: 'reset' }, { entityMemory: em as never }));

      const result = await handler.execute(makeCtx(
        { action: 'generate', recipient_name: 'Eve', sender_name: 'CEO', proposed_times: 'Monday 9am' },
        { entityMemory: em as never },
      ));

      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { source: string };
        expect(data.source).toBe('default');
      }
    });
  });
});
