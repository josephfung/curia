// skills/setup-status/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SetupStatusHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { EntityMemory } from '../../src/memory/entity-memory.js';

// ── EntityMemory mock helpers ────────────────────────────────────────────────
//
// ConfigStore.get() calls:
//   1. findEntities('config:setup_wizard') → returns anchor node(s)
//   2. getFacts(anchor.id) → returns fact nodes
//   It finds the fact whose label === 'deferrals' and reads properties.value.
//
// This mirrors the same pattern used by setup-defer handler tests.

type MinimalEntityMemory = Pick<EntityMemory, 'findEntities' | 'getFacts' | 'storeFact' | 'createEntity'>;

/**
 * Build a minimal EntityMemory double seeded with an optional pre-existing
 * deferrals JSON string (e.g. '["email"]'). The double must satisfy what
 * ConfigStore.get() calls under the hood:
 *   findEntities('config:setup_wizard') → anchor node
 *   getFacts(anchor.id) → fact node with label='deferrals', properties.value=<json>
 */
function makeEntityMemory(existingDeferrals?: string): MinimalEntityMemory {
  const anchorNode = {
    id: 'anchor-1',
    label: 'config:setup_wizard',
    type: 'concept' as const,
    properties: { category: 'config', namespace: 'setup_wizard' },
    aliases: [],
    temporal: {
      lastConfirmedAt: new Date(),
      confidence: 0.7,
      decayClass: 'permanent',
      source: 'system:config-store',
    },
    sensitivity: 'internal' as const,
  };

  const factNode =
    existingDeferrals !== undefined
      ? {
          id: 'fact-1',
          label: 'deferrals',
          properties: { key: 'deferrals', value: existingDeferrals, namespace: 'setup_wizard' },
          type: 'fact' as const,
          aliases: [],
          temporal: {
            lastConfirmedAt: new Date(),
            confidence: 0.9,
            decayClass: 'permanent',
            source: 'system:config-store',
          },
          sensitivity: 'internal' as const,
        }
      : undefined;

  return {
    findEntities: vi.fn().mockResolvedValue([anchorNode]),
    getFacts: vi.fn().mockResolvedValue(factNode ? [factNode] : []),
    storeFact: vi.fn().mockResolvedValue({ stored: true, action: 'created' }),
    createEntity: vi.fn().mockResolvedValue({ entity: anchorNode, created: false }),
  };
}

function makeCtx(overrides: Partial<{
  secrets: Record<string, string>;
  existingDeferrals: string;
  behavioralPreferences: string[];
  activeJobs: Array<{ intentAnchor?: string | null }>;
}> = {}): SkillContext {
  const secrets = overrides.secrets ?? {};
  return {
    input: {},
    entityMemory: makeEntityMemory(overrides.existingDeferrals) as unknown as EntityMemory,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SkillContext['log'],
    secret: vi.fn((name: string) => {
      if (secrets[name] !== undefined) return secrets[name];
      throw new Error(`Secret not found: ${name}`);
    }),
    officeIdentityService: {
      get: () => ({
        behavioralPreferences: overrides.behavioralPreferences ?? [],
        assistant: { name: 'Curia', title: '', emailSignature: '' },
        tone: { baseline: [], verbosity: 50, directness: 50 },
        decisionStyle: { externalActions: 'balanced', internalActions: 'balanced' },
        constraints: [],
      }),
    } as unknown as SkillContext['officeIdentityService'],
    schedulerService: {
      listJobs: vi.fn(async () => (overrides.activeJobs ?? []) as unknown[]),
    } as unknown as SkillContext['schedulerService'],
  } as unknown as SkillContext;
}

const handler = new SetupStatusHandler();

describe('setup-status', () => {
  describe('completion checks', () => {
    it('persona: done when behavioralPreferences is non-empty', async () => {
      const ctx = makeCtx({ behavioralPreferences: ['prefers concise summaries'] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const persona = data.tasks.find(t => t.id === 'persona');
      expect(persona?.status).toBe('done');
    });

    it('persona: pending when behavioralPreferences is empty', async () => {
      const ctx = makeCtx({ behavioralPreferences: [] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const persona = data.tasks.find(t => t.id === 'persona');
      expect(persona?.status).toBe('pending');
    });

    it('debrief: done when an active job with debrief in intentAnchor exists', async () => {
      const ctx = makeCtx({ activeJobs: [{ intentAnchor: 'daily_debrief' }] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const debrief = data.tasks.find(t => t.id === 'debrief');
      expect(debrief?.status).toBe('done');
    });

    it('capability_tour: always done', async () => {
      const ctx = makeCtx();
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const tour = data.tasks.find(t => t.id === 'capability_tour');
      expect(tour?.status).toBe('done');
    });

    it('email: done when all three nylas secrets are present', async () => {
      const ctx = makeCtx({
        secrets: {
          'channel.email.nylas_api_key': 'nyk_v0_abc',
          'channel.email.nylas_grant_id': 'grant-xyz',
          'channel.email.nylas_self_email': 'ceo@example.com',
        },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('done');
    });

    it('email: pending when a required nylas secret is missing', async () => {
      const ctx = makeCtx({
        secrets: { 'channel.email.nylas_grant_id': 'grant-xyz' }, // api_key and self_email absent
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('pending');
    });

    it('email: deferred when no secrets and task_id in deferrals store', async () => {
      // existingDeferrals seeds the EntityMemory fact node's properties.value
      // (the label is 'deferrals', the value is the JSON array string)
      const ctx = makeCtx({ existingDeferrals: JSON.stringify(['email']) });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('deferred');
    });

    it('email: done even when also in the deferrals store (done wins over deferred)', async () => {
      // email secrets are present (done=true) AND email is in the deferrals store
      // The status must be 'done', not 'deferred'
      const ctx = makeCtx({
        secrets: {
          'channel.email.nylas_api_key': 'nyk_v0_abc',
          'channel.email.nylas_grant_id': 'grant-xyz',
          'channel.email.nylas_self_email': 'ceo@example.com',
        },
        existingDeferrals: JSON.stringify(['email']),
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('done');
    });

    it('summary counts are accurate', async () => {
      // persona done, debrief pending, rest pending
      const ctx = makeCtx({ behavioralPreferences: ['concise'] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { summary: { done: number; pending: number } } }).data;
      // capability_tour always done + persona done = 2 done minimum
      expect(data.summary.done).toBeGreaterThanOrEqual(2);
      expect(data.summary.pending).toBeGreaterThanOrEqual(1);
    });

    it('returns error when entityMemory is absent', async () => {
      const ctx = { input: {}, log: { error: vi.fn() } } as unknown as SkillContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('status across simulated restart', () => {
    it('re-derives status correctly without any stored progress', async () => {
      // Simulate restart: no storeData progress object, but vault keys present
      const ctx = makeCtx({
        secrets: {
          'channel.email.nylas_api_key': 'nyk_v0_abc',
          'channel.email.nylas_grant_id': 'grant-xyz',
          'channel.email.nylas_self_email': 'ceo@example.com',
          'user.tavily_api_key': 'tvly-abc',
        },
        behavioralPreferences: ['prefers bullet points'],
        activeJobs: [{ intentAnchor: 'weekly_debrief' }],
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      expect(data.tasks.find(t => t.id === 'persona')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'debrief')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'email')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'web_research')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'signal')?.status).toBe('pending');
      expect(data.tasks.find(t => t.id === 'kg_memory')?.status).toBe('pending');
    });
  });
});
