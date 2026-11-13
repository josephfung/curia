// skills/setup-status/handler.test.ts
import { stubPrincipalMailboxes, mailboxView } from '../../../_shared/principal-mailboxes-test-helpers.js';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { SetupStatusHandler, parseCatalog } from './handler.js';
import type { ToolContext, EmailChannelStatus, PrincipalMailboxReadiness } from '../../../../src/skills/types.js';
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
function makeEntityMemory(
  existingDeferrals?: string,
  extra?: { sendingValue?: string; readError?: Error },
): MinimalEntityMemory {
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

  // The ceo_inbox/sending setting (#2474). The double returns every fact for any anchor, so
  // a deferrals read sees this one too and ignores it (it matches on properties.key).
  const sendingNode =
    extra?.sendingValue !== undefined
      ? {
          ...anchorNode,
          id: 'fact-sending',
          label: 'sending',
          type: 'fact' as const,
          properties: { key: 'sending', value: extra.sendingValue, namespace: 'ceo_inbox' },
        }
      : undefined;
  const facts = [factNode, sendingNode].filter((f) => f !== undefined);

  // A read failure is scoped to the ceo_inbox namespace so the deferrals read still works.
  const findEntities = extra?.readError
    ? vi.fn(async (label: string) => {
        if (label === 'config:ceo_inbox') throw extra.readError;
        return [anchorNode];
      })
    : vi.fn().mockResolvedValue([anchorNode]);

  return {
    findEntities: findEntities as unknown as MinimalEntityMemory['findEntities'],
    getFacts: vi.fn().mockResolvedValue(facts),
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
  tasks: Array<{ id: string; completion_check: { type: string; keys?: string[] }; optional_upgrade?: { keys: string[] } }>;
};
// Every key the handler reads: completion checks plus optional upgrades (#2445).
const CATALOG_VAULT_KEYS = catalog.tasks.flatMap(t => [
  ...(t.completion_check.type === 'vault_secrets_all' ? (t.completion_check.keys ?? []) : []),
  ...(t.optional_upgrade?.keys ?? []),
]);

function makeCtx(overrides: Partial<{
  secrets: Record<string, string>;
  existingDeferrals: string;
  sendingValue: string;
  sendingReadError: Error;
  behavioralPreferences: string[];
  activeJobs: Array<{ intentAnchor?: string | null; status?: string }>;
  secretError: Error;
  principal: { pronouns: string | null } | null;
  principalLookupError: Error;
  phoneAppReady: () => Promise<boolean>;
  emailChannelStatus: () => Promise<EmailChannelStatus>;
  principalMailboxReady: () => Promise<PrincipalMailboxReadiness>;
  browserContext: object | null;
  liveMailboxIds: string[];
}> = {}): ToolContext {
  const secrets = overrides.secrets ?? {};
  return {
    input: {},
    ...(overrides.liveMailboxIds
      ? { principalMailboxes: stubPrincipalMailboxes({ mailboxes: overrides.liveMailboxIds.map((id, i) => mailboxView(id, id, `${id}@example.com`, i === 0)) }) }
      : {}),
    entityMemory: makeEntityMemory(overrides.existingDeferrals, {
      ...(overrides.sendingValue !== undefined ? { sendingValue: overrides.sendingValue } : {}),
      ...(overrides.sendingReadError ? { readError: overrides.sendingReadError } : {}),
    }) as unknown as EntityMemory,
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
    ...(overrides.principalMailboxReady ? { principalMailboxReady: overrides.principalMailboxReady } : {}),
    ...(overrides.browserContext !== undefined ? { browserService: { browserContext: overrides.browserContext } } : {}),
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
      expect(manifest.optional_capabilities).toEqual(expect.arrayContaining(['phoneAppReady', 'emailChannelStatus', 'principalMailboxReady', 'browserService']));
    });

    it('offers the Tavily key web-search reads as the upgrade', () => {
      const webSearch = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../../web/tools/web-search/tool.json'), 'utf-8'),
      ) as { secrets: string[] };
      const webResearch = catalog.tasks.find(t => t.id === 'web_research');
      expect(webResearch?.optional_upgrade?.keys).toEqual(webSearch.secrets);
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

    it.each([
      ['a browser is attached', { browserContext: {} }, 'done'],
      ['the browser container is down', { browserContext: null }, 'pending'],
      ['there is no browser service', {}, 'pending'],
    ] as const)('web browser: %s → %s', async (_name, overrides, expected) => {
      const result = await handler.execute(makeCtx(overrides));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
      expect(data.tasks.find(t => t.id === 'web_browser')?.status).toBe(expected);
    });

    it.each([
      ['principal_mailbox_ready is complete with one healthy mailbox', { principalMailboxReady: async (): Promise<PrincipalMailboxReadiness> => 'ready' }, 'done'],
      ['the mailbox fails its canary', { principalMailboxReady: async (): Promise<PrincipalMailboxReadiness> => 'pending' }, 'pending'],
      ['calendar still needs a restart', { principalMailboxReady: async (): Promise<PrincipalMailboxReadiness> => 'restart_required' }, 'pending'],
      ['the check throws', { principalMailboxReady: async (): Promise<PrincipalMailboxReadiness> => { throw new Error('db down'); } }, 'pending'],
      ['the check is absent', {}, 'pending'],
    ] as const)('principal mailboxes: %s → %s', async (_name, overrides, expected) => {
      const result = await handler.execute(makeCtx(overrides));
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string; docs_url: string | null; handoff_path?: string }> } }).data;
      const task = data.tasks.find(t => t.id === 'principal_mailboxes');
      expect(task?.status).toBe(expected);
      expect(task?.docs_url).toBe('/get-started/principal-email-calendar');
      expect(task?.handoff_path).toBe('/channels');
    });

    it('principal mailboxes: flags restart_required only while calendar needs a restart (#2475)', async () => {
      const read = async (status: PrincipalMailboxReadiness) => {
        const result = await handler.execute(makeCtx({ principalMailboxReady: async () => status }));
        const data = (result as { success: true; data: { tasks: Array<{ id: string; restart_required?: true }> } }).data;
        return data.tasks.find(t => t.id === 'principal_mailboxes')?.restart_required;
      };
      expect(await read('restart_required')).toBe(true);
      expect(await read('ready')).toBeUndefined();
      expect(await read('pending')).toBeUndefined();
    });

    it('principal mailboxes: the guidance fits a one-mailbox cap and mentions the restart (#2475)', async () => {
      const result = await handler.execute(makeCtx({}));
      const data = (result as { success: true; data: { tasks: Array<{ id: string; label: string; value_prop: string; credential_how_to: string | null }> } }).data;
      const task = data.tasks.find(t => t.id === 'principal_mailboxes')!;
      const text = `${task.label} ${task.value_prop} ${task.credential_how_to ?? ''}`;
      expect(text).toContain('Calendar changes take effect after a restart');
      // Task 33 widens these once more than one mailbox can be connected.
      expect(text).not.toMatch(/accounts|calendars|default|work and personal/i);
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

  describe('config_store_set (#2474)', () => {
    async function inboxSending(ctx: ToolContext): Promise<{ status: string; docs_url: string | null } | undefined> {
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      return (result as { success: true; data: { tasks: Array<{ id: string; status: string; docs_url: string | null }> } })
        .data.tasks.find(t => t.id === 'inbox_sending');
    }

    it('is done when the key has a value', async () => {
      const task = await inboxSending(makeCtx({ sendingValue: '{"default":"routine"}' }));
      expect(task?.status).toBe('done');
    });

    it('is not done when the key is absent', async () => {
      const task = await inboxSending(makeCtx());
      expect(task?.status).toBe('pending');
    });

    it.each(['{}', 'routine', '{"default":"bogus"}', '{"Default":"off"}'])('is not done when the value is %s', async (v) => {
      const task = await inboxSending(makeCtx({ sendingValue: v }));
      expect(task?.status).toBe('pending');
    });

    // #2474 final fixes B3 (final review M4): the parsed object's own key decides, not a text match.
    it('is done when the default key is written with a JSON escape', async () => {
      const task = await inboxSending(makeCtx({ sendingValue: '{"\\u0064efault":"routine"}' }));
      expect(task?.status).toBe('done');
    });

    // #2475 R41: after the rename the level lives under the mailbox's id.
    it('is done when a live mailbox id carries a valid level', async () => {
      const task = await inboxSending(makeCtx({ sendingValue: '{"work":"routine"}', liveMailboxIds: ['work'] }));
      expect(task?.status).toBe('done');
    });

    it('is not done for a key that names no live mailbox, or a bad level', async () => {
      expect((await inboxSending(makeCtx({ sendingValue: '{"gone":"routine"}', liveMailboxIds: ['work'] })))?.status).toBe('pending');
      expect((await inboxSending(makeCtx({ sendingValue: '{"work":"bogus"}', liveMailboxIds: ['work'] })))?.status).toBe('pending');
    });

    // B5/SF6/S-I1: a leftover default counts only while it applies (the migrated sole mailbox).
    it('counts a default key only while it applies to the migrated sole mailbox', async () => {
      expect((await inboxSending(makeCtx({ sendingValue: '{"default":"routine"}', liveMailboxIds: ['work'] })))?.status).toBe('done');
      expect((await inboxSending(makeCtx({ sendingValue: '{"default":"routine"}', liveMailboxIds: ['work', 'personal'] })))?.status).toBe('pending');
      const added = makeCtx({ sendingValue: '{"default":"routine"}' });
      (added as { principalMailboxes?: unknown }).principalMailboxes = stubPrincipalMailboxes({ mailboxes: [{ ...mailboxView('home', 'Home', 'home@example.com', true), triageStartAt: new Date() }] });
      expect((await inboxSending(added))?.status).toBe('pending');
    });

    it('guards the parse and logs a malformed value without echoing it (SF13)', async () => {
      const ctx = makeCtx({ sendingValue: '[1,2]', liveMailboxIds: ['work'] });
      expect((await inboxSending(ctx))?.status).toBe('pending');
      expect(ctx.log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/malformed/));
      expect(JSON.stringify(vi.mocked(ctx.log.warn).mock.calls)).not.toContain('[1,2]');
    });

    it('is not done, and logged, when the read throws', async () => {
      const ctx = makeCtx({ sendingReadError: new Error('kg down') });
      const task = await inboxSending(ctx);
      expect(task?.status).toBe('pending');
      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: 'ceo_inbox', key: 'sending' }),
        expect.stringContaining('config-store'),
      );
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
      expect(typeof task?.optional_upgrade?.credential_how_to).toBe('string');
      expect(task?.optional_upgrade?.credential_how_to).toContain('tavily.com');
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
      tasks: Array<{ completion_check?: { type: string; keys?: string[] }; optional_upgrade?: { keys: string[] } }>;
    };
    const read = catalog.tasks.flatMap((task) => [
      ...(task.completion_check?.type === 'vault_secrets_all' ? (task.completion_check.keys ?? []) : []),
      ...(task.optional_upgrade?.keys ?? []),
    ]);
    expect(read.length).toBeGreaterThan(0);
    const missing = read.filter((key) => !manifest.secrets.includes(key));
    expect(missing).toEqual([]);
  });
});

// #2474 final fixes B3: the catalog loader validates what the checks read.
describe('setup-status catalog loading', () => {
  it('loads the real catalog.yaml with the inbox_sending entry as the docs describe it', () => {
    const tasks = parseCatalog(readFileSync(join(import.meta.dirname, 'catalog.yaml'), 'utf-8'));
    expect(tasks.find(t => t.id === 'inbox_sending')).toMatchObject({
      label: 'Replies from your mailbox',
      tier: 'instant',
      handoff: 'in-chat',
      optional: true,
      completion_check: { type: 'config_store_set', namespace: 'ceo_inbox', key: 'sending', valid_as: 'send_level' },
      credential_how_to: null,
      docs_url: '/core-concepts/inbox-sending',
    });
  });

  it('fails loudly on an unknown valid_as, naming the task', () => {
    const raw = [
      'tasks:',
      '  - id: inbox_sending',
      '    label: x',
      '    value_prop: x',
      '    tier: instant',
      '    handoff: in-chat',
      '    completion_check: { type: config_store_set, namespace: ceo_inbox, key: sending, valid_as: send_levle }',
      '    credential_how_to: null',
      '    docs_url: null',
    ].join('\n');
    expect(() => parseCatalog(raw)).toThrow(/inbox_sending.*valid_as 'send_levle'/);
  });
});
