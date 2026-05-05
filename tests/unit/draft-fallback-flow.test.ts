// tests/unit/draft-fallback-flow.test.ts
//
// Integration test: exercises the full gate → draft → approve path.
// Verifies contracts BETWEEN layers: the gateway's gated result shape,
// the adapter's fallback behavior, and the action_log state machine.
//
// "Medium-weight" integration: real EventBus + real OutboundGateway + real
// EmailAdapter, with mocked external services (Nylas, autonomy DB, contacts).
//
// Lives in tests/unit/ because all external dependencies are mocked (no real
// Postgres / Docker required). Convention: integration/ = real Postgres, unit/ = mocks.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import { EmailAdapter } from '../../src/channels/email/email-adapter.js';
import { AutonomyService } from '../../src/autonomy/autonomy-service.js';
import { createOutboundMessage } from '../../src/bus/events.js';
import { createLogger } from '../../src/logger.js';
import type { NylasClient, NylasMessage } from '../../src/channels/email/nylas-client.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import type { OutboundContentFilter, FilterResult } from '../../src/dispatch/outbound-filter.js';
import type { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = createLogger('error');

/** Minimal NylasMessage stub — only the fields the gateway/adapter actually read. */
function stubMessage(overrides: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'msg-001',
    threadId: 'thread-001',
    subject: 'Test Subject',
    from: [{ email: 'alice@example.com' }],
    to: [{ email: 'curia@company.com' }],
    cc: [],
    bcc: [],
    body: 'hello',
    snippet: 'hello',
    date: Math.floor(Date.now() / 1000),
    unread: true,
    folders: ['INBOX'],
    ...overrides,
  };
}

/** Create a mock NylasClient with controlled responses. */
function createMockNylasClient(): NylasClient {
  return {
    listMessages: vi.fn().mockResolvedValue([stubMessage()]),
    getMessage: vi.fn().mockResolvedValue(stubMessage()),
    sendMessage: vi.fn().mockResolvedValue(stubMessage({ id: 'sent-001' })),
    createDraft: vi.fn().mockResolvedValue(stubMessage({ id: 'draft-001' })),
    sendDraft: vi.fn().mockResolvedValue(stubMessage({ id: 'sent-draft-001' })),
    archiveMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as NylasClient;
}

/** Create a mock ContactService that always passes (no blocked contacts). */
function createMockContactService(): ContactService {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    createContact: vi.fn().mockResolvedValue({ id: 'contact-001' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
    setTrustLevel: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
}

/** Create a content filter that always passes. */
function createPassingFilter(): OutboundContentFilter {
  return {
    check: vi.fn().mockResolvedValue({ passed: true, findings: [] } as FilterResult),
  } as unknown as OutboundContentFilter;
}

/** Create a mock AutonomyService that returns a fixed score via mocked pool. */
function createMockAutonomyService(score: number): AutonomyService {
  const band = AutonomyService.bandForScore(score);
  const mockPool = {
    query: vi.fn().mockResolvedValue({
      rows: [{ score, band, updated_at: new Date(), updated_by: 'test' }],
    }),
  } as unknown as import('pg').Pool;
  return new AutonomyService(mockPool, logger);
}

/** Create a mock ActionLogRepo that captures insert/linkPayload calls. */
function createMockActionLogRepo(): ActionLogRepo & {
  _insertedRows: Array<Record<string, unknown>>;
  _linkedPayloads: Array<{ shortRef: string; payload: Record<string, unknown> }>;
} {
  const _insertedRows: Array<Record<string, unknown>> = [];
  const _linkedPayloads: Array<{ shortRef: string; payload: Record<string, unknown> }> = [];
  let insertCounter = 0;

  return {
    _insertedRows,
    _linkedPayloads,
    insert: vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
      _insertedRows.push(row);
      return ++insertCounter;
    }),
    linkPayload: vi.fn().mockImplementation(async (_shortRef: string, _taskEventId: string | undefined, payload: Record<string, unknown>) => {
      _linkedPayloads.push({ shortRef: _shortRef, payload });
      return true;
    }),
    findPendingByTaskAndSkill: vi.fn().mockResolvedValue(null),
    findAllPending: vi.fn().mockResolvedValue([]),
    resolvePending: vi.fn().mockResolvedValue({ found: false, reason: 'not_found', error: 'No pending' }),
    resolveRow: vi.fn().mockResolvedValue(true),
    resolveById: vi.fn().mockResolvedValue(true),
    findUnscoredTerminal: vi.fn().mockResolvedValue([]),
    updateScoringFlags: vi.fn().mockResolvedValue(undefined),
    countScored: vi.fn().mockResolvedValue(0),
    getRecentCompetenceErrorRate: vi.fn().mockResolvedValue(0),
    findAllScored: vi.fn().mockResolvedValue([]),
    setNotificationSentAt: vi.fn().mockResolvedValue(undefined),
    findExpired: vi.fn().mockResolvedValue([]),
    expireRows: vi.fn().mockResolvedValue([]),
    findPendingByPayloadField: vi.fn().mockResolvedValue(null),
  } as unknown as ActionLogRepo & {
    _insertedRows: Array<Record<string, unknown>>;
    _linkedPayloads: Array<{ shortRef: string; payload: Record<string, unknown> }>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Draft Fallback Flow Integration', () => {
  let bus: EventBus;
  let mockNylasClient: NylasClient;
  let mockContactService: ContactService;
  let contentFilter: OutboundContentFilter;

  beforeEach(() => {
    bus = new EventBus(logger);
    mockNylasClient = createMockNylasClient();
    mockContactService = createMockContactService();
    contentFilter = createPassingFilter();
  });

  describe('Test 1: Autonomy-gated flow (full path)', () => {
    it('gates the send, creates a draft, links the action_log row', async () => {
      // Low autonomy score (50) — below the 'medium' threshold of 70
      const autonomyService = createMockAutonomyService(50);
      const actionLogRepo = createMockActionLogRepo();

      const nylasClients = new Map<string, NylasClient>([['curia', mockNylasClient]]);

      const gateway = new OutboundGateway({
        nylasClients,
        contactService: mockContactService,
        contentFilter,
        bus,
        ceoEmail: 'ceo@company.com',
        logger,
        autonomyService,
        actionLogRepo,
      });

      // Create the email adapter with 'direct' policy — it will call gateway.send()
      // which will gate, then the adapter falls back to createEmailDraft + linkGatedAction.
      const adapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'direct',
        bus,
        logger,
        outboundGateway: gateway,
        contactService: mockContactService,
        pollingIntervalMs: 999_999, // no polling in test
        selfEmail: 'curia@company.com',
        observationMode: false,
        excludedSenderEmails: [],
        ceoEmail: 'ceo@company.com',
        contactCreationMaxPerMessage: 10,
        contactCreationMaxPerHour: 100,
      });

      // start() subscribes to bus events — we need it for the outbound.message handler.
      // The initial poll will call listMessages — that's fine, it returns our stub.
      await adapter.start();

      // Publish an outbound.message event as if the dispatcher generated it.
      const outboundEvent = createOutboundMessage({
        conversationId: 'email:thread-001',
        channelId: 'email',
        accountId: 'curia',
        content: 'Here is my reply.',
        taskEventId: 'task-evt-001',
        parentEventId: 'parent-evt-001',
      });

      await bus.publish('dispatch', outboundEvent);

      // Assert: gateway.send() was called and returned gated (the adapter handles it)
      // The adapter should have called createEmailDraft as fallback.
      const createDraftFn = mockNylasClient.createDraft as ReturnType<typeof vi.fn>;
      expect(createDraftFn).toHaveBeenCalledTimes(1);

      // Assert: action_log row was inserted with correct shape
      expect(actionLogRepo._insertedRows).toHaveLength(1);
      const insertedRow = actionLogRepo._insertedRows[0]!;
      expect(insertedRow).toMatchObject({
        taskId: 'task-evt-001',
        // The email adapter passes reExecRecipe with skillName: 'send-draft' so
        // approve-action can invoke the correct skill generically on CEO approval.
        skillName: 'send-draft',
        actionRisk: 'medium',
        outcome: 'pending_approval',
      });
      // account is stored in partialPayload at gate time so approve-action has it
      expect((insertedRow.payload as Record<string, unknown>).account).toBe('curia');

      // Assert: linkGatedAction was called with just the draft_id.
      // account was already stored in partialPayload — no need to link it again.
      expect(actionLogRepo._linkedPayloads).toHaveLength(1);
      expect(actionLogRepo._linkedPayloads[0]!.payload).toEqual({
        draft_id: 'draft-001',
      });

      await adapter.stop();
    });
  });

  describe('Test 2: Score >= threshold sends directly', () => {
    it('sends the email directly when autonomy score is high', async () => {
      // High autonomy score (85) — above the 'medium' threshold of 70
      const autonomyService = createMockAutonomyService(85);
      const actionLogRepo = createMockActionLogRepo();

      const nylasClients = new Map<string, NylasClient>([['curia', mockNylasClient]]);

      const gateway = new OutboundGateway({
        nylasClients,
        contactService: mockContactService,
        contentFilter,
        bus,
        ceoEmail: 'ceo@company.com',
        logger,
        autonomyService,
        actionLogRepo,
      });

      const adapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'direct',
        bus,
        logger,
        outboundGateway: gateway,
        contactService: mockContactService,
        pollingIntervalMs: 999_999,
        selfEmail: 'curia@company.com',
        observationMode: false,
        excludedSenderEmails: [],
        ceoEmail: 'ceo@company.com',
        contactCreationMaxPerMessage: 10,
        contactCreationMaxPerHour: 100,
      });

      await adapter.start();

      const outboundEvent = createOutboundMessage({
        conversationId: 'email:thread-001',
        channelId: 'email',
        accountId: 'curia',
        content: 'Direct reply — score is high.',
        parentEventId: 'parent-evt-002',
      });

      await bus.publish('dispatch', outboundEvent);

      // Assert: sendMessage was called (direct send path)
      const sendMessageFn = mockNylasClient.sendMessage as ReturnType<typeof vi.fn>;
      expect(sendMessageFn).toHaveBeenCalledTimes(1);

      // Assert: no draft created
      const createDraftFn = mockNylasClient.createDraft as ReturnType<typeof vi.fn>;
      expect(createDraftFn).not.toHaveBeenCalled();

      // Assert: no action_log insertion (not gated)
      expect(actionLogRepo._insertedRows).toHaveLength(0);

      await adapter.stop();
    });
  });

  describe('Test 3: draft_gate policy creates draft without action_log', () => {
    it('creates a draft without gateway.send() or action_log', async () => {
      // Score doesn't matter for draft_gate — the adapter bypasses gateway.send() entirely
      const autonomyService = createMockAutonomyService(50);
      const actionLogRepo = createMockActionLogRepo();

      const nylasClients = new Map<string, NylasClient>([['curia', mockNylasClient]]);

      const gateway = new OutboundGateway({
        nylasClients,
        contactService: mockContactService,
        contentFilter,
        bus,
        ceoEmail: 'ceo@company.com',
        logger,
        autonomyService,
        actionLogRepo,
      });

      // draft_gate policy — adapter calls createEmailDraft directly, no gateway.send()
      const adapter = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'draft_gate',
        bus,
        logger,
        outboundGateway: gateway,
        contactService: mockContactService,
        pollingIntervalMs: 999_999,
        selfEmail: 'curia@company.com',
        observationMode: false,
        excludedSenderEmails: [],
        ceoEmail: 'ceo@company.com',
        contactCreationMaxPerMessage: 10,
        contactCreationMaxPerHour: 100,
      });

      await adapter.start();

      const outboundEvent = createOutboundMessage({
        conversationId: 'email:thread-001',
        channelId: 'email',
        accountId: 'curia',
        content: 'This should become a draft, not a send.',
        parentEventId: 'parent-evt-003',
      });

      await bus.publish('dispatch', outboundEvent);

      // Assert: createDraft was called (draft_gate always drafts)
      const createDraftFn = mockNylasClient.createDraft as ReturnType<typeof vi.fn>;
      expect(createDraftFn).toHaveBeenCalledTimes(1);

      // Assert: sendMessage was NOT called (no direct send for draft_gate)
      const sendMessageFn = mockNylasClient.sendMessage as ReturnType<typeof vi.fn>;
      expect(sendMessageFn).not.toHaveBeenCalled();

      // Assert: no action_log insert (draft_gate bypasses autonomy decision entirely)
      expect(actionLogRepo._insertedRows).toHaveLength(0);

      await adapter.stop();
    });
  });

  describe('Test 4: Multi-account — each account creates draft on its own Nylas client', () => {
    it('routes drafts to the correct account when both are gated', async () => {
      const autonomyService = createMockAutonomyService(50); // low score → gated
      const actionLogRepo = createMockActionLogRepo();

      // Two separate Nylas clients for two accounts
      const nylasClientCuria = createMockNylasClient();
      const nylasClientJoseph = createMockNylasClient();

      const nylasClients = new Map<string, NylasClient>([
        ['curia', nylasClientCuria],
        ['joseph', nylasClientJoseph],
      ]);

      const gateway = new OutboundGateway({
        nylasClients,
        contactService: mockContactService,
        contentFilter,
        bus,
        ceoEmail: 'ceo@company.com',
        logger,
        autonomyService,
        actionLogRepo,
      });

      // Adapter for the 'curia' account
      const adapterCuria = new EmailAdapter({
        accountId: 'curia',
        outboundPolicy: 'direct',
        bus,
        logger,
        outboundGateway: gateway,
        contactService: mockContactService,
        pollingIntervalMs: 999_999,
        selfEmail: 'curia@company.com',
        observationMode: false,
        excludedSenderEmails: [],
        ceoEmail: 'ceo@company.com',
        contactCreationMaxPerMessage: 10,
        contactCreationMaxPerHour: 100,
      });

      // Adapter for the 'joseph' account
      const adapterJoseph = new EmailAdapter({
        accountId: 'joseph',
        outboundPolicy: 'direct',
        bus,
        logger,
        outboundGateway: gateway,
        contactService: mockContactService,
        pollingIntervalMs: 999_999,
        selfEmail: 'joseph@company.com',
        observationMode: false,
        excludedSenderEmails: [],
        ceoEmail: 'ceo@company.com',
        contactCreationMaxPerMessage: 10,
        contactCreationMaxPerHour: 100,
      });

      await adapterCuria.start();
      await adapterJoseph.start();

      // Send an outbound.message targeted at the 'curia' account
      const curiaEvent = createOutboundMessage({
        conversationId: 'email:thread-001',
        channelId: 'email',
        accountId: 'curia',
        content: 'Reply from curia account.',
        taskEventId: 'task-evt-curia',
        parentEventId: 'parent-evt-004',
      });

      // Send an outbound.message targeted at the 'joseph' account
      const josephEvent = createOutboundMessage({
        conversationId: 'email:thread-002',
        channelId: 'email',
        accountId: 'joseph',
        content: 'Reply from joseph account.',
        taskEventId: 'task-evt-joseph',
        parentEventId: 'parent-evt-005',
      });

      await bus.publish('dispatch', curiaEvent);
      await bus.publish('dispatch', josephEvent);

      // Assert: each Nylas client got exactly one createDraft call (gated fallback)
      const curiaDraftFn = nylasClientCuria.createDraft as ReturnType<typeof vi.fn>;
      const josephDraftFn = nylasClientJoseph.createDraft as ReturnType<typeof vi.fn>;

      expect(curiaDraftFn).toHaveBeenCalledTimes(1);
      expect(josephDraftFn).toHaveBeenCalledTimes(1);

      // Assert: two action_log rows inserted (one per gated send)
      expect(actionLogRepo._insertedRows).toHaveLength(2);
      const taskIds = actionLogRepo._insertedRows.map((r) => r.taskId);
      expect(taskIds).toContain('task-evt-curia');
      expect(taskIds).toContain('task-evt-joseph');

      await adapterCuria.stop();
      await adapterJoseph.stop();
    });
  });
});
