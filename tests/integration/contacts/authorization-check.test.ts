// Authorization check integration — service seam + dispatch audit events (#1382).
//
// "decision logged" here means dispatch-layer events the dispatcher actually publishes
// (contact.resolved / contact.unknown / message.rejected). AuthorizationService.evaluate
// is a pure function with no bus/logger — a dedicated authz-decision audit row is #1379.

import { it, expect, beforeAll, afterAll } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import {
  createInboundMessage,
  type ContactResolvedEvent,
  type MessageRejectedEvent,
  type AgentTaskEvent,
} from '../../../src/bus/events.js';
import { AuthorizationService } from '../../../src/contacts/authorization.js';
import { loadAuthConfig } from '../../../src/contacts/config-loader.js';
import type { AuthConfig } from '../../../src/contacts/types.js';
import {
  describeIf,
  makeRunId,
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
    const signalId = `+1777${String([...runId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0) % 10_000_000).padStart(7, '0')}`;
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
    const signalId = `+1888${String([...runId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 1) % 10_000_000).padStart(7, '0')}`;
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

  it('dispatch audit: contact.resolved fires for known sender (authz-decision row is #1379)', async () => {
    // AuthorizationService.evaluate cannot emit an audit row (#1379). The evidence
    // we have today is the dispatch-layer contact.resolved event.
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

    const bus = new EventBus(stack.logger);
    const dispatcher = new Dispatcher({
      bus,
      logger: stack.logger,
      contactResolver: stack.resolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    const resolvedEvents: ContactResolvedEvent[] = [];
    const rejectedEvents: MessageRejectedEvent[] = [];
    const taskEvents: AgentTaskEvent[] = [];
    bus.subscribe('contact.resolved', 'system', (e) => { resolvedEvents.push(e as ContactResolvedEvent); });
    bus.subscribe('message.rejected', 'system', (e) => { rejectedEvents.push(e as MessageRejectedEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { taskEvents.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: `email:${email}:authz`,
      channelId: 'email',
      senderId: email,
      content: 'Request board pack',
    }));

    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]!.payload.contactId).toBe(contact.id);
    expect(resolvedEvents[0]!.payload.role).toBe('cfo');
    expect(rejectedEvents).toHaveLength(0);
    expect(taskEvents).toHaveLength(1);
  });
});
