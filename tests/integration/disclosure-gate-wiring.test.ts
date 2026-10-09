// Integration test for #1870: the Stage 2.5 disclosure gate is reachable through the
// production wiring path.
//
// The Stage 2.5 unit tests inject an EscalationJudge straight into the filter
// constructor. Production never built that configuration: index.ts constructed the
// filter without the judge, so the gate never ran and the unit tests kept passing.
// This suite builds the filter with the same functions index.ts calls
// (buildEscalationJudge + buildOutboundContentFilter) from the repo's default.yaml.
// Only the LLM provider is stubbed.
//
// The first block needs nothing external. The second drives a real send through
// ExecutionLayer → signal-send → OutboundGateway → filter with the write-ahead
// AuditLogger, and asserts what lands in audit_log. It needs DATABASE_URL.

import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { AuditLogger } from '../../src/audit/logger.js';
import { EventBus } from '../../src/bus/bus.js';
import type { BusEvent } from '../../src/bus/events.js';
import { loadYamlConfig } from '../../src/config.js';
import { createSilentLogger } from '../../src/logger.js';
import { ModelRegistry } from '../../src/agents/llm/model-registry.js';
import type { LLMProvider, LLMResponse } from '../../src/agents/llm/provider.js';
import type { DisclosureClass } from '../../src/autonomy/escalation-policy.js';
import { buildEscalationJudge, buildOutboundContentFilter } from '../../src/dispatch/outbound-filter-wiring.js';
import type { OutboundContentFilter } from '../../src/dispatch/outbound-filter.js';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolManifest } from '../../src/skills/types.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { ContactTier } from '../../src/contacts/types.js';
import type { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import type { SignalRpcClient } from '../../src/channels/signal/signal-rpc-client.js';
import { SignalSendHandler } from '../../skills/signal-send/handler.js';
import signalSendManifest from '../../skills/signal-send/tool.json' with { type: 'json' };

const logger = createSilentLogger();
const CONFIG_DIR = path.resolve(import.meta.dirname, '../../config');

// The 2026-09-17 shape (#1815): a third party's surname, sent to an external `known` contact.
const THIRD_PARTY_BODY = "Sarah's surname is Okafor, for the guest list.";

/** A provider that answers every disclosure classification with `cls`. */
function stubProvider(cls: DisclosureClass): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  const response: LLMResponse = {
    type: 'text',
    content: JSON.stringify({ class: cls, reason: 'stub classification' }),
    usage: { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    provenance: { requestedModel: 'claude-haiku-4-5', actualModel: 'claude-haiku-4-5', providerRequestId: 'stub' },
  };
  return { id: 'anthropic', chat: vi.fn(async () => response) } as unknown as LLMProvider & { chat: ReturnType<typeof vi.fn> };
}

/** Build the filter exactly as src/index.ts does, from the repo's default.yaml. */
function buildProductionFilter(bus: EventBus, provider: LLMProvider): OutboundContentFilter {
  const yamlConfig = loadYamlConfig(CONFIG_DIR);
  const escalationJudge = buildEscalationJudge({
    yaml: yamlConfig.escalation?.judge,
    modelRegistry: new ModelRegistry(logger),
    providerRegistry: new Map([['anthropic', provider]]),
    bus,
    logger,
  });
  return buildOutboundContentFilter({
    systemPromptMarkers: ['You are Test Agent'],
    ceoEmail: 'ceo@example.com',
    // Stage 2 is not under test here; leaving it out keeps the stub answering only Stage 2.5.
    judge: undefined,
    escalationJudge,
    logger,
  });
}

function filterInput(recipientTier: ContactTier, extra: { principalDirected?: boolean } = {}) {
  return {
    content: THIRD_PARTY_BODY,
    recipientEmail: 'guest@external.com',
    conversationId: '',
    channelId: 'email',
    recipientTier,
    ...extra,
  };
}

describe('Stage 2.5 production wiring (#1870)', () => {
  const bus = { publish: vi.fn(async () => undefined) } as unknown as EventBus;

  it('default config produces a filter with Stage 2.5 active', () => {
    expect(buildProductionFilter(bus, stubProvider('public')).disclosureGateStatus()).toBe('active');
  });

  it('blocks an autonomous third-party disclosure to a known contact', async () => {
    const provider = stubProvider('third-party');
    const result = await buildProductionFilter(bus, provider).check(filterInput('known'));
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      passed: false,
      stage: 'disclosure-gate',
      findings: [{ rule: 'disclosure-tier-gate', detail: "Disclosure class 'third-party' not permitted for tier 'known'" }],
    });
  });

  it('passes the same disclosure when the principal directed it, without classifying', async () => {
    const provider = stubProvider('third-party');
    const result = await buildProductionFilter(bus, provider).check(filterInput('known', { principalDirected: true }));
    expect(result.passed).toBe(true);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it.each(['principal', 'trusted'] as const)('makes no classification call for %s recipients', async (tier) => {
    const provider = stubProvider('confidential');
    const result = await buildProductionFilter(bus, provider).check(filterInput(tier));
    expect(result.passed).toBe(true);
    expect(provider.chat).not.toHaveBeenCalled();
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

// signal-send addresses contacts by UUID (#2041); the gateway resolves the number.
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555';
const RECIPIENT_PHONE = '+15555550170';

describeIfDb('Stage 2.5 end to end: signal-send → gateway → audit_log (#1870)', () => {
  let pool: pg.Pool;
  let auditLogger: AuditLogger;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    auditLogger = new AuditLogger(pool, logger);
    await auditLogger.seedHashChain();
  });

  afterAll(async () => {
    // audit_log is append-only; the rows this suite writes stay (see audit-log.test.ts).
    await pool.end();
  });

  function buildStack(provider: LLMProvider) {
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );
    const published: BusEvent[] = [];
    bus.subscribe('outbound.blocked', 'system', async (evt) => { published.push(evt); });
    bus.subscribe('outbound.delivered', 'system', async (evt) => { published.push(evt); });

    const signalClient = {
      send: vi.fn().mockResolvedValue('1700000000123'),
      listGroups: vi.fn().mockResolvedValue([]),
      isConnected: vi.fn().mockReturnValue(true),
    } as unknown as SignalRpcClient & { send: ReturnType<typeof vi.fn> };

    // A `known` contact with a verified Signal number.
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: RECIPIENT_ID, displayName: 'Guest', role: null, tier: 'known', kgNodeId: null, verified: true,
      }),
      getContactWithIdentities: vi.fn(async (id: string) => (id === RECIPIENT_ID ? {
        contact: { id, displayName: 'Guest', primaryEmail: null, primaryPhone: RECIPIENT_PHONE, tier: 'known' },
        identities: [{ id: 'identity-1870', contactId: id, channel: 'signal', channelIdentifier: RECIPIENT_PHONE, label: null,
          verified: true, verifiedAt: new Date(), status: 'active', source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date() }],
      } : undefined)),
    } as unknown as ContactService;

    const outboundContextService = {
      defaultExpiryHours: 6,
      explicitExpiryHours: 24,
      defaultExpiryHoursFor: () => 6,
      register: vi.fn().mockResolvedValue('ctx-entry-1870'),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as OutboundContextService;

    const outboundGateway = new OutboundGateway({
      signalClient,
      signalPhoneNumber: '+15550001111',
      contactService,
      contentFilter: buildProductionFilter(bus, provider),
      bus,
      principalIdentities: [],
      logger,
      // The #1818 identity gate is a separate check; keep it out of this test's way.
      identityGate: 'off',
    });

    const registry = new ToolRegistry();
    registry.register(signalSendManifest as ToolManifest, new SignalSendHandler());
    const executionLayer = new ExecutionLayer(registry, logger, {
      bus, outboundGateway, contactService, outboundContextService,
    });
    return { executionLayer, signalClient, published };
  }

  function originator(systemRole: 'principal' | 'agent') {
    return {
      originator: {
        contactId: systemRole === 'principal' ? 'principal-contact' : 'agent',
        systemRole,
        channel: 'signal',
        initiatedAt: new Date().toISOString(),
        tier: systemRole === 'principal' ? 'principal' : null,
      },
    };
  }

  it('an autonomous third-party disclosure is blocked and the finding is written to audit_log', async () => {
    const { executionLayer, signalClient, published } = buildStack(stubProvider('third-party'));

    const result = await executionLayer.invoke(
      'signal-send',
      { recipient: RECIPIENT_ID, message: THIRD_PARTY_BODY },
      undefined,
      { agentId: 'coordinator', taskEventId: 'task-1870-auto', conversationId: 'conv-1870-auto', taskMetadata: originator('agent') },
    );

    expect(result.success).toBe(false);
    expect(signalClient.send).not.toHaveBeenCalled();
    const blocked = published.filter((e) => e.type === 'outbound.blocked');
    expect(blocked).toHaveLength(1);

    const row = await pool.query<{ payload: { findings: Array<{ rule: string; detail: string }> } }>(
      'SELECT payload FROM audit_log WHERE id = $1',
      [blocked[0]!.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.payload.findings).toEqual([
      { rule: 'disclosure-tier-gate', detail: "Disclosure class 'third-party' not permitted for tier 'known'" },
    ]);
  });

  it('the same disclosure is delivered when the principal directed it (the 2026-09-17 case)', async () => {
    const provider = stubProvider('third-party');
    const { executionLayer, signalClient, published } = buildStack(provider);

    const result = await executionLayer.invoke(
      'signal-send',
      { recipient: RECIPIENT_ID, message: THIRD_PARTY_BODY },
      undefined,
      { agentId: 'coordinator', taskEventId: 'task-1870-principal', conversationId: 'conv-1870-principal', taskMetadata: originator('principal') },
    );

    expect(result.success).toBe(true);
    expect(signalClient.send).toHaveBeenCalledTimes(1);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(published.filter((e) => e.type === 'outbound.blocked')).toHaveLength(0);
    expect(published.filter((e) => e.type === 'outbound.delivered')).toHaveLength(1);
  });
});
