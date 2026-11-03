// skills/setup-status/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { SetupStatusHandler } from './handler.js';
import type { ToolContext, EmailChannelStatus } from '../../../../src/skills/types.js';
import type { EntityMemory } from '../../../../src/memory/entity-memory.js';

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

// The secrets tool.json declares. The ctx double enforces them exactly as the execution
// layer does: an undeclared name throws "not declared in the manifest" (#2409 — a double
// that answered any name hid a catalog key missing from the manifest).
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'tool.json'), 'utf-8')) as {
  secrets: string[];
  optional_capabilities?: string[];
};
const DECLARED = new Set(manifest.secrets);

const catalog = yaml.load(readFileSync(join(import.meta.dirname, 'catalog.yaml'), 'utf-8')) as {
  tasks: Array<{ id: string; completion_check: { type: string; keys?: string[] } }>;
};
const CATALOG_VAULT_KEYS = catalog.tasks.flatMap(t =>
  t.completion_check.type === 'vault_secrets_all' ? (t.completion_check.keys ?? []) : [],
);

function makeCtx(overrides: Partial<{
  secrets: Record<string, string>;
  existingDeferrals: string;
  behavioralPreferences: string[];
  activeJobs: Array<{ intentAnchor?: string | null; status?: string }>;
  secretError: Error;
  principal: { pronouns: string | null } | null;
  principalLookupError: Error;
  phoneAppReady: () => Promise<boolean>;
  emailChannelStatus: () => Promise<EmailChannelStatus>;
}> = {}): ToolContext {
  const secrets = overrides.secrets ?? {};
  return {
    input: {},
    entityMemory: makeEntityMemory(overrides.existingDeferrals) as unknown as EntityMemory,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ToolContext['log'],
    secret: vi.fn((name: string) => {
      if (!DECLARED.has(name)) {
        throw new Error(`Secret '${name}' is not declared in the manifest for skill 'setup-status'`);
      }
      // Vault infrastructure error takes priority — throws for every key, simulating
      // a vault outage rather than a missing specific key.
      if (overrides.secretError) throw overrides.secretError;
      if (secrets[name] !== undefined) return secrets[name];
      // Use the real execution-layer message format so SECRET_ABSENT_MSG matching works in tests.
      throw new Error(`Secret '${name}' is declared but not set in the environment`);
    }),
    officeIdentityService: {
      get: () => ({
        behavioralPreferences: overrides.behavioralPreferences ?? [],
        assistant: { name: 'Curia', title: '', emailSignature: '' },
        tone: { style: 'Professional.', verbosity: 50 },
        constraints: [],
      }),
    } as unknown as ToolContext['officeIdentityService'],
    contactService: {
      findContactBySystemRole: vi.fn(async () => {
        if (overrides.principalLookupError) throw overrides.principalLookupError;
        return overrides.principal ?? null;
      }),
    } as unknown as ToolContext['contactService'],
    schedulerService: {
      // Honor the status filter so future regressions to this filter logic are caught:
      // if a filter is provided, only return jobs matching that status.
      listJobs: vi.fn(async (filters?: { status?: string; agentId?: string }) => {
        const jobs = overrides.activeJobs ?? [];
        if (filters?.status) {
          return jobs.filter((j: { status?: string }) => j.status === filters.status) as unknown[];
        }
        return jobs as unknown[];
      }),
    } as unknown as ToolContext['schedulerService'],
    ...(overrides.phoneAppReady ? { phoneAppReady: overrides.phoneAppReady } : {}),
    ...(overrides.emailChannelStatus ? { emailChannelStatus: overrides.emailChannelStatus } : {}),
  } as unknown as ToolContext;
}

const handler = new SetupStatusHandler();

describe('setup-status', () => {
  describe('manifest', () => {
    it('declares every vault key the catalog checks', () => {
      const undeclared = CATALOG_VAULT_KEYS.filter(k => !DECLARED.has(k));
      expect(undeclared).toEqual([]);
    });

    it('declares the optional capabilities its checks read', () => {
      expect(manifest.optional_capabilities).toEqual(expect.arrayContaining(['phoneAppReady', 'emailChannelStatus']));
    });

    it('checks the Tavily key web-search reads', () => {
      const webSearch = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../../web/tools/web-search/tool.json'), 'utf-8'),
      ) as { secrets: string[] };
      const webResearch = catalog.tasks.find(t => t.id === 'web_research');
      expect(webResearch?.completion_check.keys).toEqual(webSearch.secrets);
    });
  });

  describe('whole checklist', () => {
    it('returns a result when no channel keys are set', async () => {
      const result = await handler.execute(makeCtx());
      expect(result.success).toBe(true);
    });

    it('returns a result with every catalog key set, and marks those tasks done', async () => {
      const secrets = Object.fromEntries(CATALOG_VAULT_KEYS.map(k => [k, 'value']));
      const result = await handler.execute(makeCtx({ secrets }));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      for (const id of ['signal', 'slack', 'sms', 'voice', 'web_research']) {
        expect(data.tasks.find(t => t.id === id)?.status, id).toBe('done');
      }
    });
  });

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

    it.each([
      ['pronouns are set', { principal: { pronouns: 'she/her' } }, 'done'],
      ['pronouns are blank', { principal: { pronouns: '  ' } }, 'pending'],
      ['pronouns are unset', { principal: { pronouns: null } }, 'pending'],
      ['there is no principal', { principal: null }, 'pending'],
      ['the lookup fails', { principalLookupError: new Error('db down') }, 'pending'],
    ] as const)('principal_profile: when %s, status is %s', async (_name, overrides, expected) => {
      const result = await handler.execute(makeCtx(overrides));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; docs_url: string | null }> } }).data;
      const task = data.tasks.find(t => t.id === 'principal_profile');
      expect(task?.status).toBe(expected);
      expect(task?.docs_url).toBe('/core-concepts/how-curia-refers-to-you');
    });

    it('debrief: done when an active job with debrief in intentAnchor exists', async () => {
      const ctx = makeCtx({ activeJobs: [{ intentAnchor: 'daily_debrief', status: 'pending' }] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const debrief = data.tasks.find(t => t.id === 'debrief');
      expect(debrief?.status).toBe('done');
    });

    it('debrief: pending when the debrief job is suspended (not running)', async () => {
      const ctx = makeCtx({ activeJobs: [{ intentAnchor: 'daily_debrief', status: 'suspended' }] });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const debrief = data.tasks.find(t => t.id === 'debrief');
      expect(debrief?.status).toBe('pending');
    });

    it('phone_app: done when a paired phone has a live notification subscription', async () => {
      const result = await handler.execute(makeCtx({ phoneAppReady: async () => true }));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; docs_url: string | null }> } }).data;
      const task = data.tasks.find(t => t.id === 'phone_app');
      expect(task?.status).toBe('done');
      expect(task?.docs_url).toBe('/channels/phone-app');
    });

    it('phone_app: pending when the check is absent or reports no subscription', async () => {
      for (const ctx of [makeCtx(), makeCtx({ phoneAppReady: async () => false })]) {
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        expect(data.tasks.find(t => t.id === 'phone_app')?.status).toBe('pending');
      }
    });

    it('capability_tour: always done', async () => {
      const ctx = makeCtx();
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const tour = data.tasks.find(t => t.id === 'capability_tour');
      expect(tour?.status).toBe('done');
    });

    it('email: done only when an email adapter is running', async () => {
      const result = await handler.execute(makeCtx({ emailChannelStatus: async () => 'running' }));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; restart_required?: boolean }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('done');
      expect(email?.restart_required).toBeUndefined();
    });

    it('email: pending with restart_required when enabled since boot but not yet polling', async () => {
      const result = await handler.execute(makeCtx({ emailChannelStatus: async () => 'restart_required' }));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; restart_required?: boolean }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('pending');
      expect(email?.restart_required).toBe(true);
    });

    it.each([
      ['the check is absent', {}],
      ['the channel is not configured', { emailChannelStatus: async (): Promise<EmailChannelStatus> => 'not_configured' }],
      ['the check fails', { emailChannelStatus: async (): Promise<EmailChannelStatus> => { throw new Error('db down'); } }],
    ] as const)('email: pending without restart_required when %s', async (_name, overrides) => {
      const result = await handler.execute(makeCtx(overrides));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; restart_required?: boolean }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('pending');
      expect(email?.restart_required).toBeUndefined();
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
        emailChannelStatus: async (): Promise<EmailChannelStatus> => 'running',
        existingDeferrals: JSON.stringify(['email']),
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      const email = data.tasks.find(t => t.id === 'email');
      expect(email?.status).toBe('done');
    });

    it('vault_keys are exposed for vault_secrets_all tasks and absent for non-vault tasks', async () => {
      const ctx = makeCtx();
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as {
        success: true;
        data: { tasks: Array<{ id: string; vault_keys?: string[] }> };
      }).data;
      // vault_secrets_all task — keys must be present for agent to call system-secret-capture-request
      // web research works keyless now (#2445); email checks the channel, not keys (#2409)
      expect(data.tasks.find(t => t.id === 'web_research')?.vault_keys).toBeUndefined();
      expect(data.tasks.find(t => t.id === 'email')?.vault_keys).toBeUndefined();
      const persona = data.tasks.find(t => t.id === 'persona');
      expect(persona?.vault_keys).toBeUndefined();
    });

    // Key-based tasks check saved keys only, not that the channel is enabled or running.
    // done_means says so, so the wizard doesn't describe a disabled channel as working.
    it('marks key-based tasks done_means credentials_saved, and no other task', async () => {
      const result = await handler.execute(makeCtx());
      expect(result.success).toBe(true);
      const { tasks } = (result as {
        success: true;
        data: { tasks: Array<{ id: string; vault_keys?: string[]; done_means?: string }> };
      }).data;
      for (const t of tasks) {
        expect(t.done_means, t.id).toBe(t.vault_keys ? 'credentials_saved' : undefined);
      }
      expect(tasks.find(t => t.id === 'signal')?.done_means).toBe('credentials_saved');
      expect(tasks.find(t => t.id === 'email')?.done_means).toBeUndefined();
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
      const ctx = { input: {}, log: { error: vi.fn() } } as unknown as ToolContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('propagates vault infrastructure errors (does not silently treat them as pending)', async () => {
      // secret() throws a non-"absent" error for all keys, simulating a vault outage
      // or decrypt failure. The handler must surface { success: false }, NOT treat
      // every credentialed task as pending and return { success: true }.
      const ctx = makeCtx({
        secretError: new Error('Vault read failed: decrypt operation timed out'),
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('web research (keyless, #2445)', () => {
    type UpgradeTask = {
      id: string;
      status: string;
      vault_keys?: string[];
      optional_upgrade?: { vault_keys: string[]; configured: boolean; value_prop: string; credential_how_to: string };
    };
    async function webResearch(ctx: ToolContext): Promise<UpgradeTask | undefined> {
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      return (result as { success: true; data: { tasks: UpgradeTask[] } }).data.tasks.find(t => t.id === 'web_research');
    }

    it('is done with no Tavily key, and offers the key as an unconfigured optional upgrade', async () => {
      const task = await webResearch(makeCtx());
      expect(task?.status).toBe('done');
      expect(task?.vault_keys).toBeUndefined();
      expect(task?.optional_upgrade?.vault_keys).toEqual(['tavily_api_key']);
      expect(task?.optional_upgrade?.configured).toBe(false);
      expect(task?.optional_upgrade?.credential_how_to).toMatch(/tavily\.com/);
    });

    it('marks the upgrade configured once tavily_api_key is set', async () => {
      const task = await webResearch(makeCtx({ secrets: { tavily_api_key: 'tvly-abc' } }));
      expect(task?.status).toBe('done');
      expect(task?.optional_upgrade?.configured).toBe(true);
    });
  });

  describe('status across simulated restart', () => {
    it('re-derives status correctly without any stored progress', async () => {
      // Simulate restart: no storeData progress object, but vault keys present
      const ctx = makeCtx({
        emailChannelStatus: async (): Promise<EmailChannelStatus> => 'running',
        behavioralPreferences: ['prefers bullet points'],
        activeJobs: [{ intentAnchor: 'weekly_debrief', status: 'pending' }],
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      expect(data.tasks.find(t => t.id === 'persona')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'debrief')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'email')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'web_research')?.status).toBe('done');
      expect(data.tasks.find(t => t.id === 'signal')?.status).toBe('pending');
      expect(data.tasks.find(t => t.id === 'kg_memory')).toBeUndefined();
    });
  });
});

// #2428: catalog.yaml listed Slack, SMS and voice keys the manifest never declared,
// so ctx.secret() threw "not declared" and every setup-status call failed in prod.
describe('setup-status manifest covers the catalog', () => {
  it('declares every vault key a catalog completion check reads', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const yaml = await import('js-yaml');
    const dir = import.meta.dirname;
    const manifest = JSON.parse(await readFile(join(dir, 'tool.json'), 'utf8')) as { secrets: string[] };
    const catalog = yaml.load(await readFile(join(dir, 'catalog.yaml'), 'utf8')) as {
      tasks: Array<{ completion_check?: { type: string; keys?: string[] } }>;
    };
    const read = catalog.tasks.flatMap((task) =>
      task.completion_check?.type === 'vault_secrets_all' ? (task.completion_check.keys ?? []) : [],
    );
    expect(read.length).toBeGreaterThan(0);
    const missing = read.filter((key) => !manifest.secrets.includes(key));
    expect(missing).toEqual([]);
  });
});
