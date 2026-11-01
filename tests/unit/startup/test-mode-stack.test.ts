// Test-mode no-send guarantees (#1966). These pieces need no database, so they are
// checked here; tests/integration/test-mode-stack.test.ts checks the assembled stack.
//
// Two ways a message could leave a test run, both closed by construction:
//   1. Through the OutboundGateway — it is built with no transport client and no
//      outbound queue, so every send and draft fails inside the gateway.
//   2. Around it — a skill that calls a provider itself with a declared secret
//      (ceo-inbox → Nylas). The test-mode vault withholds those secrets, which also
//      blocks ExecutionLayer's process.env fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { createLogger } from '../../../src/logger.js';
import { ExecutionLayer } from '../../../src/skills/execution.js';
import { EscalationJudgeConfigError } from '../../../src/dispatch/outbound-filter-wiring.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import type { ToolContext, ToolManifest } from '../../../src/skills/types.js';
import type { BullpenService } from '../../../src/memory/bullpen.js';
import { createAgentTask, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { EscalationJudge } from '../../../src/autonomy/escalation-judge.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { BandSendReview } from '../../../src/dispatch/band-send-review.js';
import type { NylasClient } from '../../../src/channels/email/nylas-client.js';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import {
  agentLayerAutonomy,
  createNoSendOutboundGateway,
  describeMissingBandJudge,
  resolveBandReviewJudge,
  runWithAutonomyFixture,
  createTestModeSecrets,
  autonomyFixtureMismatch,
  FixtureAutonomyService,
  readOnlyBullpen,
  readOnlyView,
  reachClientsFrom,
  TEST_MODE_PASSTHROUGH_SECRETS,
} from '../../../src/startup/test-mode-stack.js';

const logger = createLogger('error');

function manifest(name: string, secrets: string[]): ToolManifest {
  return {
    name,
    description: name,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets,
    timeout: 5000,
    inputs: {},
    outputs: {},
  };
}

function gateway() {
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
  } as unknown as ContactService;
  return createNoSendOutboundGateway({
    contactService,
    bus: new EventBus(logger),
    logger,
    principalIdentities: [],
  });
}

describe('createNoSendOutboundGateway', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Any network call from the gateway would go through fetch (Nylas SDK, Slack,
    // Telnyx). Make it loud if one happens.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network call in test mode'));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('has no email account to send from', () => {
    expect(gateway().listAccountIds()).toEqual([]);
  });

  it('fails an email send without touching the network', async () => {
    const result = await gateway().send(
      { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails a Signal send without touching the network', async () => {
    const result = await gateway().send(
      { channel: 'signal', recipient: '+15555550123', message: 'Hello' },
      { humanApproved: true },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails an email draft without touching the network', async () => {
    const result = await gateway().createEmailDraft(
      { channel: 'email', to: 'someone@example.com', subject: 'Hi', body: 'Hello' },
    );
    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createTestModeSecrets', () => {
  it('withholds account credentials', async () => {
    const vault = createTestModeSecrets();
    await expect(vault.get('nylas_api_key')).rejects.toThrow(/withheld in test mode/);
    await expect(vault.get('ceo_nylas_grant_id')).rejects.toThrow(/withheld in test mode/);
    await expect(vault.get('channel.signal.phone_number')).rejects.toThrow(/withheld in test mode/);
  });

  it('withholds user secret names rather than claiming there are none', async () => {
    await expect(createTestModeSecrets().listUserNames()).rejects.toThrow(/withheld in test mode/);
  });

  it('lets read-only lookups fall back to env', async () => {
    const vault = createTestModeSecrets();
    for (const name of TEST_MODE_PASSTHROUGH_SECRETS) {
      await expect(vault.get(name)).resolves.toBeNull();
    }
  });
});

describe('ExecutionLayer with the test-mode vault', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['NYLAS_API_KEY', 'TAVILY_API_KEY']) saved[key] = process.env[key];
    // Production .env values present — the case smoke runs in.
    process.env.NYLAS_API_KEY = 'nylas-key-from-env';
    process.env.TAVILY_API_KEY = 'tavily-key-from-env';
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps an env credential away from a skill that would call a provider directly', async () => {
    const registry = new ToolRegistry();
    const seen: string[] = [];
    registry.register(manifest('mailbox-write', ['nylas_api_key']), {
      execute: async (ctx: ToolContext) => {
        seen.push(ctx.secret('nylas_api_key'));
        return { success: true, data: 'wrote to the mailbox' };
      },
    });
    const layer = new ExecutionLayer(registry, logger, { secretsService: createTestModeSecrets() });

    const result = await layer.invoke('mailbox-write', {});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/withheld in test mode/);
    expect(seen).toEqual([]);
  });

  it('still resolves a pass-through secret from env', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('lookup', ['tavily_api_key']), {
      execute: async (ctx: ToolContext) => ({ success: true, data: ctx.secret('tavily_api_key') }),
    });
    const layer = new ExecutionLayer(registry, logger, { secretsService: createTestModeSecrets() });

    const result = await layer.invoke('lookup', {});
    expect(result).toMatchObject({ success: true, data: 'tavily-key-from-env' });
  });
});

describe('ExecutionLayerWrapper (#1956 stub hook)', () => {
  it('a Proxy can answer stubbed tools and delegate everything else', async () => {
    const registry = new ToolRegistry();
    registry.register(manifest('real-tool', []), {
      execute: async () => ({ success: true, data: 'real' }),
    });
    const base = new ExecutionLayer(registry, logger);

    // The shape the scenario runner will use: intercept invoke, pass the rest through.
    const wrapped = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'invoke') {
          return async (...args: Parameters<ExecutionLayer['invoke']>) =>
            args[0] === 'stubbed-tool'
              ? { success: true as const, data: 'stubbed' }
              : target.invoke(...args);
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    expect(await wrapped.invoke('stubbed-tool', {})).toEqual({ success: true, data: 'stubbed' });
    expect(await wrapped.invoke('real-tool', {})).toMatchObject({ success: true, data: 'real' });
    expect(wrapped.getToolDefinitions(['real-tool']).map(t => t.name)).toEqual(['real-tool']);
  });
});

// Shared-database writes a real instance would act on (#1966 review).
describe('readOnlyView', () => {
  class Score {
    value = 50;
    async getConfig(): Promise<number> { return this.value; }
    async setScore(next: number): Promise<void> { this.value = next; }
  }

  it('passes allowed reads through, bound to the real object', async () => {
    const view = readOnlyView(new Score(), ['getConfig'], 'autonomyService');
    await expect(view.getConfig()).resolves.toBe(50);
  });

  it('refuses every method not on the allowlist', async () => {
    const real = new Score();
    const view = readOnlyView(real, ['getConfig'], 'autonomyService');
    expect(() => view.setScore(95)).toThrow(/autonomyService\.setScore is read-only in test mode/);
    expect(real.value).toBe(50);
  });
});

describe('readOnlyBullpen', () => {
  it('reads threads but never writes read watermarks', async () => {
    const markThreadsSeen = vi.fn();
    const recordUnhandledInjection = vi.fn();
    const getPendingThreadsForAgent = vi.fn().mockResolvedValue([]);
    const real = { markThreadsSeen, recordUnhandledInjection, getPendingThreadsForAgent } as unknown as BullpenService;
    const view = readOnlyBullpen(real);

    await view.getPendingThreadsForAgent('coordinator', 60);
    await view.markThreadsSeen('coordinator', []);
    await view.recordUnhandledInjection('coordinator', []);

    expect(getPendingThreadsForAgent).toHaveBeenCalledOnce();
    expect(markThreadsSeen).not.toHaveBeenCalled();
    expect(recordUnhandledInjection).not.toHaveBeenCalled();
  });
});

describe('FixtureAutonomyService', () => {
  const stored = { score: 95, band: 'full', updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'ceo' };
  const pool = { query: vi.fn(async () => ({ rows: [stored] })) } as unknown as ConstructorParameters<typeof AutonomyService>[0];

  it('reads the fixture score, its band and its gating, not the database row', async () => {
    const service = new FixtureAutonomyService(pool, logger, { fixture: { score: 74, gating: 'band' } });
    const config = await service.getConfig();
    expect(config).toMatchObject({ score: 74, band: 'approval-required', gating: 'band', updatedBy: 'scenario-fixture' });
    expect(AutonomyService.formatPromptBlock(config!)).toContain('Your current autonomy score is 74');
  });

  it('names tier gating outright, so a stack built band cannot fall back over it', async () => {
    const config = await new FixtureAutonomyService(pool, logger, { fixture: { score: 84, gating: 'tier' }, gating: 'band' }).getConfig();
    expect(config).toMatchObject({ score: 84, band: 'spot-check', gating: 'tier' });
    expect(AutonomyService.formatPromptBlock(config!)).toContain('Your current autonomy score is 84');
  });

  it('reads the database row, with the configured gating, when no fixture is in force', async () => {
    const config = await new FixtureAutonomyService(pool, logger, { gating: 'band' }).getConfig();
    expect(config).toMatchObject({ score: 95, band: 'full', gating: 'band', updatedBy: 'ceo' });
    expect((await new FixtureAutonomyService(pool, logger).getConfig())?.gating).toBeUndefined();
  });

  it('reads the fixture entered for the work in hand over the default', async () => {
    const service = new FixtureAutonomyService(pool, logger, { fixture: { score: 84, gating: 'band' } });
    const inCase = await runWithAutonomyFixture({ score: 74, gating: 'band' }, () => service.getConfig());
    expect(inCase).toMatchObject({ score: 74, gating: 'band' });
    // Entered with no fixture: the default, as a case without `autonomy:` reads.
    const plain = await runWithAutonomyFixture(undefined, () => service.getConfig());
    expect(plain).toMatchObject({ score: 84, gating: 'band' });
    expect(await service.getConfig()).toMatchObject({ score: 84 });
  });
});

// Review Focus 1 (#2312): one stack, cases at once, each under its own autonomy.
describe('per-case autonomy fixtures on one stack', () => {
  const stored = { score: 95, band: 'full', updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'ceo' };
  const pool = { query: vi.fn(async () => ({ rows: [stored] })) } as unknown as ConstructorParameters<typeof AutonomyService>[0];
  const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

  it('gives concurrent attempts their own score and gating through the bus and the execution layer', async () => {
    const service = new FixtureAutonomyService(pool, logger);
    const bus = new EventBus(logger);
    const registry = new ToolRegistry();
    registry.register(
      { ...manifest('calendar-respond', []), action_risk: 'medium' },
      { execute: async () => ({ success: true, data: 'responded' }) },
    );
    // Band Gate C asks the judge; which questions it asks depends on the score's band, and
    // the call names the conversation, so each review is traceable to its attempt.
    const reviews = new Map<string, string[]>();
    const review = vi.fn(async (args: { questions: string[]; conversationId: string }) => {
      reviews.set(args.conversationId, args.questions);
      return { ok: true as const, purpose: 'serving' as const, reason: 'x' };
    });
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: service,
      bus,
      escalationJudge: { isEnabled: () => true, review, classifyAction: vi.fn() } as unknown as EscalationJudge,
      sendEvidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [] }) },
    });

    const seen = new Map<string, Array<string | undefined>>();
    bus.subscribe('agent.task', 'agent', async (event) => {
      const { conversationId } = (event as AgentTaskEvent).payload;
      const reads: Array<string | undefined> = [];
      // Interleave: each attempt reads, yields to the others, and reads again.
      const before = await service.getConfig();
      reads.push(`${before?.score} ${before?.gating ?? 'tier'}`);
      await delay(conversationId === 'conv-a' ? 15 : 5);
      const after = await service.getConfig();
      reads.push(`${after?.score} ${after?.gating ?? 'tier'}`);
      seen.set(conversationId, reads);
      await layer.invoke('calendar-respond', {}, undefined, {
        conversationId,
        taskEventId: event.id,
        taskMetadata: {
          originator: { contactId: 'contact-abc', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'unknown' },
        },
      });
    });

    const publish = (conversationId: string) => bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator', conversationId, channelId: 'email', senderId: 'someone@example.com', content: 'hi', parentEventId: 'p',
    }));
    await Promise.all([
      runWithAutonomyFixture({ score: 84, gating: 'band' }, () => publish('conv-a')),
      runWithAutonomyFixture({ score: 74, gating: 'band' }, () => publish('conv-b')),
      runWithAutonomyFixture({ score: 84, gating: 'tier' }, () => publish('conv-c')),
      // A case without `autonomy:` runs on the database's.
      runWithAutonomyFixture(undefined, () => publish('conv-d')),
    ]);

    expect(seen.get('conv-a')).toEqual(['84 band', '84 band']);
    expect(seen.get('conv-b')).toEqual(['74 band', '74 band']);
    expect(seen.get('conv-c')).toEqual(['84 tier', '84 tier']);
    expect(seen.get('conv-d')).toEqual(['95 tier', '95 tier']);
    // Band gating at 84 asks only purpose of an outsider; below 80 it also asks whether the
    // action speaks for the principal. Tier gating never asks the judge.
    expect(reviews.get('conv-a')).toEqual(['purpose']);
    expect(reviews.get('conv-b')).toEqual(['purpose', 'speaks-as-principal']);
    expect(reviews.has('conv-c')).toBe(false);
    expect(reviews.has('conv-d')).toBe(false);
  });

  it('gives concurrent sends their own gating in the outbound gateway', async () => {
    const service = new FixtureAutonomyService(pool, logger);
    const review = vi.fn(async () => ({ kind: 'send' as const }));
    const nylas = { sendMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }) } as unknown as NylasClient;
    const gw = new OutboundGateway({
      nylasClients: new Map([['curia', nylas]]),
      contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
      contentFilter: { check: vi.fn().mockResolvedValue({ passed: true, findings: [] }) } as unknown as OutboundContentFilter,
      bus: { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() } as unknown as EventBus,
      logger,
      autonomyService: service,
      bandReview: { review: review as unknown as BandSendReview['review'] },
    });
    const send = (to: string) => gw.send({ channel: 'email', to, subject: 'Hi', body: 'Hello' }, { taskEventId: `t-${to}` });
    await Promise.all([
      runWithAutonomyFixture({ score: 84, gating: 'band' }, () => send('band@example.com')),
      runWithAutonomyFixture({ score: 84, gating: 'tier' }, () => send('tier@example.com')),
    ]);
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ score: 84 }));
    expect(JSON.stringify(review.mock.calls[0])).toContain('band@example.com');
  });
});

describe('autonomyFixtureMismatch', () => {
  const config = { score: 84, band: 'spot-check' as const, updatedAt: new Date(0), updatedBy: 'x', gating: 'band' as const };

  it('passes when the stack reads the fixture', () => {
    expect(autonomyFixtureMismatch({ score: 84, gating: 'band' }, config)).toBeNull();
    expect(autonomyFixtureMismatch({ score: 84, gating: 'tier' }, { ...config, gating: undefined })).toBeNull();
  });

  it('names what the stack reads when the fixture did not reach it', () => {
    // A tier config omits gating: the database's own row, as when the fixture was dropped.
    expect(autonomyFixtureMismatch({ score: 84, gating: 'band' }, { ...config, score: 75, band: 'approval-required', gating: undefined }))
      .toBe('the stack reads autonomy 75 (tier gating); the fixture asked for 84 (band gating)');
    expect(autonomyFixtureMismatch({ score: 84, gating: 'band' }, null)).toMatch(/no autonomy config/);
  });
});

// Band review without its judge fails every detected item closed (#2312 review), so a
// through-gateway run would score the missing key as the agent's error.
describe('resolveBandReviewJudge', () => {
  const deps = (providers: string[], yaml?: { enabled?: boolean; model?: string }) => ({
    yaml,
    modelRegistry: new ModelRegistry(logger),
    providerRegistry: new Map<string, LLMProvider>(providers.map(p => [p, { id: p, chat: vi.fn() } as unknown as LLMProvider])),
    bus: new EventBus(logger),
    logger,
  });

  it('builds the judge when its provider is registered', () => {
    const { judge, missing } = resolveBandReviewJudge({ ...deps(['anthropic']), require: true });
    expect(judge).toBeDefined();
    expect(missing).toBeUndefined();
  });

  it('refuses when required, naming the model, the provider and the vault key', () => {
    expect(() => resolveBandReviewJudge({ ...deps(['openrouter']), require: true }))
      .toThrow("through_gateway cases need the band-review judge: the band-review judge (escalation.judge.model 'claude-haiku-5-5') needs the 'anthropic' provider, which is not registered: add anthropic_api_key to the vault");
  });

  it('reports the gap instead when not required, so each through-gateway run errors', () => {
    const { judge, missing } = resolveBandReviewJudge({ ...deps(['openrouter']), require: false });
    expect(judge).toBeUndefined();
    expect(missing).toMatch(/needs the 'anthropic' provider.*anthropic_api_key/);
  });

  it('counts a judge the config turned off as missing', () => {
    expect(() => resolveBandReviewJudge({ ...deps(['anthropic'], { enabled: false }), require: true }))
      .toThrow(/escalation\.judge\.enabled is false/);
  });

  it('describes a config error that is not a missing provider by its message', () => {
    const err = new EscalationJudgeConfigError('escalation.judge.timeout_ms must be an integer >= 250 (ms)', { timeoutMs: 1 });
    expect(describeMissingBandJudge(err)).toBe('the band-review judge cannot be built: escalation.judge.timeout_ms must be an integer >= 250 (ms)');
  });
});

// Review Focus 3 (#2312 review): the layer agents call keeps its pre-#2312 Gate C (tier) under a
// band fixture, unless the work in hand is a through-gateway run. The fixture's score still applies.
describe('agentLayerAutonomy', () => {
  const stored = { score: 95, band: 'full', updated_at: new Date('2026-10-01T00:00:00Z'), updated_by: 'ceo' };
  const pool = { query: vi.fn(async () => ({ rows: [stored] })) } as unknown as ConstructorParameters<typeof AutonomyService>[0];

  function bandGateCLayer(followsFixtureGating: () => boolean) {
    const registry = new ToolRegistry();
    registry.register(
      { ...manifest('calendar-respond', []), action_risk: 'medium' },
      { execute: async () => ({ success: true, data: 'responded' }) },
    );
    const review = vi.fn(async () => ({ ok: true as const, purpose: 'serving' as const, reason: 'x' }));
    const classifyAction = vi.fn(async () => ({ verdict: 'serving' as const, reason: 'x' }));
    const layer = new ExecutionLayer(registry, logger, {
      autonomyService: agentLayerAutonomy(new FixtureAutonomyService(pool, logger), followsFixtureGating),
      bus: new EventBus(logger),
      escalationJudge: { isEnabled: () => true, review, classifyAction } as unknown as EscalationJudge,
      sendEvidence: { collect: vi.fn().mockResolvedValue({ unavailable: false, toolResults: [] }) },
    });
    const invoke = () => runWithAutonomyFixture({ score: 84, gating: 'band' }, () => layer.invoke('calendar-respond', {}, undefined, {
      conversationId: 'conv-1',
      taskEventId: 'task-1',
      taskMetadata: {
        originator: { contactId: 'contact-abc', systemRole: null, channel: 'email', initiatedAt: new Date().toISOString(), tier: 'unknown' },
      },
    }));
    return { invoke, review };
  }

  it('reads the fixture score without its gating, so Gate C stays tier with no band review', async () => {
    const service = agentLayerAutonomy(new FixtureAutonomyService(pool, logger), () => false);
    const config = await runWithAutonomyFixture({ score: 84, gating: 'band' }, () => service.getConfig());
    expect(config).toMatchObject({ score: 84, band: 'spot-check' });
    expect(config?.gating).toBeUndefined();

    const { invoke, review } = bandGateCLayer(() => false);
    await invoke();
    expect(review).not.toHaveBeenCalled();
  });

  it('follows the fixture\'s band gating in a through-gateway run', async () => {
    const { invoke, review } = bandGateCLayer(() => true);
    await invoke();
    expect(review).toHaveBeenCalledOnce();
  });
});

describe('reachClientsFrom', () => {
  const none = {
    signalSocketPath: undefined,
    signalPhoneNumber: undefined,
    smsApiKey: undefined,
    smsFromNumber: undefined,
    smsWebhookPublicKey: undefined,
    slackBotToken: undefined,
    slackAppToken: undefined,
    nylasApiKey: undefined,
  };

  it('needs every credential production builds a client from', () => {
    expect(reachClientsFrom(none)).toEqual({ signal: false, sms: false, slack: false, email: false });
    // A Signal number alone is not a client: production also needs the socket.
    expect(reachClientsFrom({ ...none, signalPhoneNumber: '+15550003333' }).signal).toBe(false);
    expect(reachClientsFrom({ ...none, smsApiKey: 'k', smsFromNumber: '+15550004444' }).sms).toBe(false);
    expect(reachClientsFrom({ ...none, slackBotToken: 'xoxb-1' }).slack).toBe(false);
    expect(reachClientsFrom({
      signalSocketPath: '/run/signal-cli/socket',
      signalPhoneNumber: '+15550003333',
      smsApiKey: 'k',
      smsFromNumber: '+15550004444',
      smsWebhookPublicKey: 'pk',
      slackBotToken: 'xoxb-1',
      slackAppToken: 'xapp-1',
      nylasApiKey: 'nyk',
    })).toEqual({ signal: true, sms: true, slack: true, email: true });
  });
});
