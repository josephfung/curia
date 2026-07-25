// Authorization check integration — service seam + dispatch audit events (#1382 / #1379).
//
// AuthorizationService.evaluate stays pure; the dispatcher publishes authorization.decision
// after resolution so every allow/deny/escalate snapshot lands in audit_log.

import { it, expect, beforeAll, afterAll } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { AuditLogger } from '../../../src/audit/logger.js';
import {
  createInboundMessage,
  type ContactResolvedEvent,
  type MessageRejectedEvent,
  type AgentTaskEvent,
  type AuthorizationDecisionEvent,
} from '../../../src/bus/events.js';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { loadAuthConfig } from '../../../src/contacts/config-loader.js';
import type { AuthConfig } from '../../../src/contacts/types.js';
import {
  describeIf,
  makeRunId,
  signalForRun,
  createContactStack,
  CONFIG_DIR,
  type ContactTestStack,
} from './harness.js';

describeIf('Contact resolution: authorization check integration', () => {
  let stack: ContactTestStack;
  const runId = makeRunId();

  beforeAll(async () => {
    stack = await createContactStack();
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('CFO known-tier: allowed/denied/escalate/trustBlocked match three-layer config', async () => {
    const email = `authz-cfo-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Authz CFO ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    // Low-trust channel (email): high-sensitivity CFO grants are trust-blocked.
    const onEmail = await stack.resolver.resolve('email', email);
    expect(onEmail.resolved).toBe(true);
    if (!onEmail.resolved) return;
    expect(onEmail.authorization).not.toBeNull();
    const emailAuth = onEmail.authorization!;
    expect(emailAuth.allowed).toEqual(
      expect.arrayContaining(['schedule_meetings', 'request_action_items']),
    );
    expect(emailAuth.denied).toEqual(
      expect.arrayContaining(['send_on_behalf', 'see_personal_calendar']),
    );
    expect(emailAuth.trustBlocked).toEqual(
      expect.arrayContaining(['view_financial_reports', 'view_board_materials']),
    );
    expect(emailAuth.escalate).toEqual(
      expect.arrayContaining(['book_travel', 'manage_personal_appointments', 'access_internal_docs']),
    );

    // High-trust channel: same role grants without trust block.
    const signalId = signalForRun(runId, 77);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'signal',
      channelIdentifier: signalId,
      source: 'ceo_stated',
    });
    const onSignal = await stack.resolver.resolve('signal', signalId);
    expect(onSignal.resolved).toBe(true);
    if (!onSignal.resolved) return;
    expect(onSignal.authorization!.allowed).toEqual(
      expect.arrayContaining([
        'view_financial_reports',
        'view_board_materials',
        'schedule_meetings',
        'request_action_items',
      ]),
    );
    expect(onSignal.authorization!.trustBlocked).not.toContain('view_financial_reports');
  });

  it('override wins: grant role-denied and deny role-granted', async () => {
    const email = `authz-override-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Authz Override ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    // Grant a role-denied perm; deny a role-granted perm.
    await stack.contactService.grantPermission(contact.id, 'send_on_behalf', true, 'ceo');
    await stack.contactService.grantPermission(contact.id, 'schedule_meetings', false, 'ceo');

    // send_on_behalf is high sensitivity — use signal so override grant is not trust-blocked.
    const signalId = signalForRun(runId, 88);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'signal',
      channelIdentifier: signalId,
      source: 'ceo_stated',
    });

    const resolved = await stack.resolver.resolve('signal', signalId);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    expect(resolved.authorization!.allowed).toContain('send_on_behalf');
    expect(resolved.authorization!.denied).toContain('schedule_meetings');
  });

  it('free-text role falls back to tier_defaults', async () => {
    const email = `authz-sister-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Sister ${runId}`,
      role: 'Sister',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.setTier(contact.id, 'trusted');
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    // tier_defaults.trusted grants calendar/travel/meetings; deny financials/board/internal
    expect(resolved.authorization!.allowed).toEqual(
      expect.arrayContaining([
        'see_personal_calendar',
        'book_travel',
        'schedule_meetings',
        'request_action_items',
        'request_meeting_notes',
      ]),
    );
    expect(resolved.authorization!.denied).toEqual(
      expect.arrayContaining([
        'view_financial_reports',
        'view_board_materials',
        'access_internal_docs',
      ]),
    );
  });

  it('effective trust: trusted tier on email does not trust-block high-sensitivity grants', async () => {
    const email = `authz-trusted-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Trusted CFO ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.setTier(contact.id, 'trusted');
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    const resolved = await stack.resolver.resolve('email', email);
    expect(resolved.resolved).toBe(true);
    if (!resolved.resolved) return;
    // effectiveTrustRank = max(email=low=0, trusted=2) = 2 >= high sensitivity → allowed
    expect(resolved.authorization!.trustBlocked).not.toContain('view_financial_reports');
    expect(resolved.authorization!.allowed).toContain('view_financial_reports');
  });

  it('edge: no tier_defaults entry falls through to unknown role deny-all', () => {
    const base = loadAuthConfig(CONFIG_DIR);
    const { known: _removed, ...rest } = base.tierDefaults ?? {};
    void _removed;
    const configWithoutKnown: AuthConfig = {
      ...base,
      tierDefaults: rest,
    };
    const auth = new AuthorizationService(configWithoutKnown);
    // Free-text role → no role match → missing tierDefaults['known'] → roles.unknown → deny-all
    const result = auth.evaluate({
      role: 'Head Instructor',
      tier: 'known',
      channel: 'email',
      overrides: [],
    });
    expect(result.allowed).toEqual([]);
    expect(result.denied).toContain('*');
  });

  it('edge: Gate-1 deny-all for unknown and blocked tiers regardless of role/overrides', async () => {
    const unknownEmail = `authz-gate-unknown-${runId}@example.com`;
    const blockedEmail = `authz-gate-blocked-${runId}@example.com`;

    const unknown = await stack.contactService.createContact({
      displayName: `Gate Unknown ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'unknown',
    });
    stack.trackContact(unknown.id, unknown.kgNodeId);
    await stack.contactService.grantPermission(unknown.id, 'schedule_meetings', true, 'ceo');
    await stack.contactService.linkIdentity({
      contactId: unknown.id,
      channel: 'email',
      channelIdentifier: unknownEmail,
      source: 'ceo_stated',
    });

    const blocked = await stack.contactService.createContact({
      displayName: `Gate Blocked ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(blocked.id, blocked.kgNodeId);
    await stack.contactService.setTier(blocked.id, 'blocked');
    await stack.contactService.grantPermission(blocked.id, 'schedule_meetings', true, 'ceo');
    await stack.contactService.linkIdentity({
      contactId: blocked.id,
      channel: 'email',
      channelIdentifier: blockedEmail,
      source: 'ceo_stated',
    });

    const u = await stack.resolver.resolve('email', unknownEmail);
    expect(u.resolved).toBe(true);
    if (!u.resolved) return;
    expect(u.authorization!.allowed).toEqual([]);
    expect(u.authorization!.denied).toContain('*');

    const b = await stack.resolver.resolve('email', blockedEmail);
    expect(b.resolved).toBe(true);
    if (!b.resolved) return;
    expect(b.authorization!.allowed).toEqual([]);
    expect(b.authorization!.denied).toContain('*');
  });

  it('dispatch audit: authorization.decision flows through bus → audit_log (#1379)', async () => {
    const email = `authz-logged-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Authz Logged ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    const auditLogger = new AuditLogger(stack.pool, stack.logger);
    const bus = new EventBus(
      stack.logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );
    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: stack.resolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    const resolvedEvents: ContactResolvedEvent[] = [];
    const authzEvents: AuthorizationDecisionEvent[] = [];
    const rejectedEvents: MessageRejectedEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];
    bus.subscribe('contact.resolved', 'system', (e) => { resolvedEvents.push(e as ContactResolvedEvent); });
    bus.subscribe('authorization.decision', 'system', (e) => { authzEvents.push(e as AuthorizationDecisionEvent); });
    bus.subscribe('message.rejected', 'system', (e) => { rejectedEvents.push(e as MessageRejectedEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });

    const inbound = createInboundMessage({
      conversationId: `email:${email}:authz`,
      channelId: 'email',
      senderId: email,
      content: 'Request board pack',
    });
    await bus.publish('channel', inbound);

    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]!.payload.contactId).toBe(contact.id);
    expect(resolvedEvents[0]!.payload.role).toBe('cfo');
    expect(rejectedEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(1);

    // AuthorizationService path: CFO on email escalates (unlisted perms) and trust-blocks highs.
    expect(authzEvents).toHaveLength(1);
    const authz = authzEvents[0]!;
    expect(authz.type).toBe('authorization.decision');
    expect(authz.sourceLayer).toBe('dispatch');
    expect(authz.parentEventId).toBe(inbound.id);
    expect(authz.payload.gate).toBe('authorization');
    expect(authz.payload.contactId).toBe(contact.id);
    expect(authz.payload.tier).toBe('known');
    expect(authz.payload.channel).toBe('email');
    expect(authz.payload.decision).toBe('escalate');
    expect(authz.payload.subjectSummary).toMatch(/Authorization escalate/);
    expect(authz.payload.allowed).toEqual(
      expect.arrayContaining(['schedule_meetings', 'request_action_items']),
    );
    expect(authz.payload.denied).toEqual(
      expect.arrayContaining(['send_on_behalf', 'see_personal_calendar']),
    );

    // Write-ahead audit_log row is queryable and human-readable.
    const auditRow = await stack.pool.query<{
      event_type: string;
      source_layer: string;
      payload: Record<string, unknown>;
      acknowledged: boolean;
    }>(
      `SELECT event_type, source_layer, payload, acknowledged FROM audit_log WHERE id = $1`,
      [authz.id],
    );
    expect(auditRow.rows).toHaveLength(1);
    expect(auditRow.rows[0]!.event_type).toBe('authorization.decision');
    expect(auditRow.rows[0]!.source_layer).toBe('dispatch');
    expect(auditRow.rows[0]!.acknowledged).toBe(true);
    expect(auditRow.rows[0]!.payload['decision']).toBe('escalate');
    expect(auditRow.rows[0]!.payload['subjectSummary']).toEqual(
      expect.stringContaining('Authorization escalate'),
    );
    expect(auditRow.rows[0]!.payload['contactId']).toBe(contact.id);
  });

  it('dispatch audit: Gate-1 deny publishes authorization.decision deny', async () => {
    const email = `authz-gate1-audit-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Gate1 Audit ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'unknown',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    const bus = new EventBus(stack.logger);
    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: stack.resolver,
      // allow so the message reaches authz emit before unknown-sender hold/reject.
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    const authzEvents: AuthorizationDecisionEvent[] = [];
    bus.subscribe('authorization.decision', 'system', (e) => {
      authzEvents.push(e as AuthorizationDecisionEvent);
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:gate1`,
      channelId: 'email',
      senderId: email,
      content: 'hello',
    }));

    expect(authzEvents).toHaveLength(1);
    expect(authzEvents[0]!.payload.decision).toBe('deny');
    expect(authzEvents[0]!.payload.denied).toContain('*');
    expect(authzEvents[0]!.payload.tier).toBe('unknown');
    expect(authzEvents[0]!.payload.subjectSummary).toMatch(/Authorization deny/);
  });

  it('dispatch audit: evaluation failure emits fail-closed authorization.decision deny', async () => {
    const email = `authz-eval-fail-${runId}@example.com`;
    const contact = await stack.contactService.createContact({
      displayName: `Eval Fail ${runId}`,
      role: 'cfo',
      source: 'ceo_stated',
      tier: 'known',
    });
    stack.trackContact(contact.id, contact.kgNodeId);
    await stack.contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: email,
      source: 'ceo_stated',
    });

    const throwingAuth = {
      evaluate: () => {
        throw new Error('forced auth eval failure');
      },
    } as unknown as AuthorizationService;
    const failResolver = new ContactResolver(
      stack.contactService,
      stack.entityMemory,
      throwingAuth,
      stack.logger,
    );

    const bus = new EventBus(stack.logger);
    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: failResolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    const authzEvents: AuthorizationDecisionEvent[] = [];
    bus.subscribe('authorization.decision', 'system', (e) => {
      authzEvents.push(e as AuthorizationDecisionEvent);
    });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:eval-fail`,
      channelId: 'email',
      senderId: email,
      content: 'hello',
    }));

    expect(authzEvents).toHaveLength(1);
    expect(authzEvents[0]!.payload.decision).toBe('deny');
    expect(authzEvents[0]!.payload.denied).toContain('*');
    expect(authzEvents[0]!.payload.contactId).toBe(contact.id);
    expect(authzEvents[0]!.payload.subjectSummary).toMatch(/evaluation failed \(fail-closed\)/);
  });
});
