// Resolving a notification type to the one address it goes to (#2710, ADR-068), and the
// gateway doing it on every send. These are the two rules the issue fixed:
//
//   - With an operator, operator-routed notices go to the operator only and principal-routed
//     ones to the principal only. No duplication: telling the executive is the operator's call.
//   - With no operator, every type goes to the principal, exactly as before the operator existed.
//
// And the failure rule: a notice with no address is logged and audited, never redirected to the
// other person. A fallback would break the no-duplication rule.
import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../../src/logger.js';
import { OutboundGateway } from '../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../src/contacts/contact-service.js';
import type { OutboundContentFilter } from '../../../src/dispatch/outbound-filter.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent } from '../../../src/bus/events.js';
import { resolveNotificationRecipient } from '../../../src/notifications/recipients.js';
import { operatorNotificationTypes, principalNotificationTypes } from '../../../src/notifications/audience.js';

const PRINCIPAL = 'principal@example.com';
const OPERATOR = 'operator@example.com';

describe('resolveNotificationRecipient', () => {
  const withOperator = {
    principalEmail: () => PRINCIPAL,
    operatorEmail: async () => OPERATOR,
  };

  it('operator-routed: the operator when one is set', async () => {
    await expect(resolveNotificationRecipient('schedule_suspended', withOperator))
      .resolves.toEqual({ email: OPERATOR, audience: 'operator' });
  });

  it('operator-routed with no operator set: the principal, as before the operator existed', async () => {
    await expect(resolveNotificationRecipient('schedule_suspended', { ...withOperator, operatorEmail: async () => undefined }))
      .resolves.toEqual({ email: PRINCIPAL, audience: 'operator' });
  });

  it('principal-routed: the principal even when an operator is set', async () => {
    await expect(resolveNotificationRecipient('inbox_triage_paused', withOperator))
      .resolves.toEqual({ email: PRINCIPAL, audience: 'principal' });
  });

  it('reports no recipient when there is no address at all', async () => {
    await expect(resolveNotificationRecipient('inbox_triage_paused', { ...withOperator, principalEmail: () => undefined }))
      .resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gateway on every sendNotification
// ---------------------------------------------------------------------------

interface Published { event: BusEvent }

function makeGateway(recipients: {
  principalEmail?: () => string | undefined;
  operatorEmail?: () => Promise<string | undefined>;
  canDeliver?: () => boolean;
} | undefined) {
  const published: Published[] = [];
  const bus = {
    publish: vi.fn(async (_layer: string, event: BusEvent) => { published.push({ event }); }),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  const gateway = new OutboundGateway({
    contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
    contentFilter: { check: vi.fn() } as unknown as OutboundContentFilter,
    bus,
    logger: createLogger('error'),
    ...(recipients
      ? {
          notificationRecipients: {
            principalEmail: recipients.principalEmail ?? (() => PRINCIPAL),
            operatorEmail: recipients.operatorEmail ?? (async () => undefined),
            ...(recipients.canDeliver ? { canDeliver: recipients.canDeliver } : {}),
          },
        }
      : {}),
  });
  return { gateway, published, bus };
}

function makeGatewayWithHook(
  onNotificationUndelivered: (type: string, reason: string, recipient: string) => Promise<void>,
  recipients: { principalEmail?: () => string | undefined; canDeliver?: () => boolean },
) {
  const published: Published[] = [];
  const bus = {
    publish: vi.fn(async (_layer: string, event: BusEvent) => { published.push({ event }); }),
    subscribe: vi.fn(),
  } as unknown as EventBus;
  const gateway = new OutboundGateway({
    contactService: { resolveByChannelIdentity: vi.fn().mockResolvedValue(null) } as unknown as ContactService,
    contentFilter: { check: vi.fn() } as unknown as OutboundContentFilter,
    bus,
    logger: createLogger('error'),
    notificationRecipients: {
      principalEmail: recipients.principalEmail ?? (() => PRINCIPAL),
      operatorEmail: async () => undefined,
      ...(recipients.canDeliver ? { canDeliver: recipients.canDeliver } : {}),
    },
    onNotificationUndelivered: onNotificationUndelivered as never,
  });
  return { gateway, published };
}

function notices(published: Published[]) {
  return published
    .map((p) => p.event)
    .filter((e): e is Extract<BusEvent, { type: 'outbound.notification' }> => e.type === 'outbound.notification');
}

function undelivered(published: Published[]) {
  return published
    .map((p) => p.event)
    .filter((e): e is Extract<BusEvent, { type: 'outbound.notification_undelivered' }> => e.type === 'outbound.notification_undelivered');
}

describe('OutboundGateway.sendNotification routing', () => {
  it('sends every operator-routed type to the operator only', async () => {
    for (const type of operatorNotificationTypes()) {
      const { gateway, published } = makeGateway({
        principalEmail: () => PRINCIPAL,
        operatorEmail: async () => OPERATOR,
      });
      const sent = await gateway.sendNotification({ notificationType: type, subject: 's', body: 'b' });
      expect(sent, type).toBe(true);
      const [notice] = notices(published);
      expect(notice!.payload, type).toMatchObject({ notificationType: type, recipient: OPERATOR, audience: 'operator' });
      // One notice, to one person: no copy to the principal.
      expect(notices(published), type).toHaveLength(1);
    }
  });

  it('sends every principal-routed type to the principal only, even with an operator set', async () => {
    for (const type of principalNotificationTypes()) {
      const { gateway, published } = makeGateway({
        principalEmail: () => PRINCIPAL,
        operatorEmail: async () => OPERATOR,
      });
      const sent = await gateway.sendNotification({ notificationType: type, subject: 's', body: 'b' });
      expect(sent, type).toBe(true);
      const [notice] = notices(published);
      expect(notice!.payload, type).toMatchObject({ notificationType: type, recipient: PRINCIPAL, audience: 'principal' });
      expect(notices(published), type).toHaveLength(1);
    }
  });

  it('sends every type to the principal when no operator is set', async () => {
    for (const type of [...operatorNotificationTypes(), ...principalNotificationTypes()]) {
      const { gateway, published } = makeGateway({ principalEmail: () => PRINCIPAL, operatorEmail: async () => undefined });
      const sent = await gateway.sendNotification({ notificationType: type, subject: 's', body: 'b' });
      expect(sent, type).toBe(true);
      const [notice] = notices(published);
      expect(notice!.payload, type).toMatchObject({ notificationType: type, recipient: PRINCIPAL });
    }
  });

  it('drops the miss rather than redirecting it: no address means false, an audit row, and no delivery event', async () => {
    const { gateway, published } = makeGateway({
      principalEmail: () => undefined,
      operatorEmail: async () => undefined,
    });
    const sent = await gateway.sendNotification({ notificationType: 'database_unavailable', subject: 's', body: 'b' });

    expect(sent).toBe(false);
    expect(notices(published)).toEqual([]);
    const [row] = undelivered(published);
    expect(row!.payload).toEqual({
      notificationType: 'database_unavailable',
      audience: 'operator',
      reason: 'no_recipient',
    });
    // The audit row names the type and audience only — never the subject or body.
    expect(JSON.stringify(row!.payload)).not.toContain('"s"');
  });

  it('never falls back to the principal when the operator lookup throws', async () => {
    const { gateway, published } = makeGateway({
      principalEmail: () => PRINCIPAL,
      operatorEmail: async () => { throw new Error('settings read failed'); },
    });
    const sent = await gateway.sendNotification({ notificationType: 'schedule_suspended', subject: 's', body: 'b' });

    expect(sent).toBe(false);
    expect(notices(published)).toEqual([]);
    expect(undelivered(published)).toHaveLength(1);
  });

  it('does not publish, and says so, when no adapter can deliver a notice yet', async () => {
    // One check for every caller (#2710): a publish before the email adapter subscribes reaches
    // no one, so nobody may be told the notice went out.
    const { gateway, published } = makeGateway({ principalEmail: () => PRINCIPAL, canDeliver: () => false });
    expect(await gateway.sendNotification({ notificationType: 'inbox_triage_paused', subject: 's', body: 'b' })).toBe(false);
    expect(notices(published)).toEqual([]);
    expect(undelivered(published)[0]!.payload).toMatchObject({ reason: 'delivery_unavailable' });
  });

  it('answers canDeliverNotifications without publishing anything, for callers that do work first', async () => {
    // The outage notifier mints a single-use sign-in link before it alerts; asking first keeps a
    // hopeless attempt from burning one and writing an audit row per retry (#2710 review).
    const { gateway, published } = makeGateway({ principalEmail: () => PRINCIPAL, canDeliver: () => false });
    expect(gateway.canDeliverNotifications()).toBe(false);
    expect(published).toEqual([]);

    const deliverable = makeGateway({ principalEmail: () => PRINCIPAL });
    expect(deliverable.gateway.canDeliverNotifications()).toBe(true);
  });

  it('publishes once an adapter can deliver', async () => {
    const { gateway, published } = makeGateway({ principalEmail: () => PRINCIPAL, canDeliver: () => true });
    expect(await gateway.sendNotification({ notificationType: 'inbox_triage_paused', subject: 's', body: 'b' })).toBe(true);
    expect(notices(published)).toHaveLength(1);
  });

  it('tells the onNotificationUndelivered hook, so a caller can correct "published" in its own record', async () => {
    const hook = vi.fn(async () => {});
    const { gateway } = makeGatewayWithHook(hook, { principalEmail: () => PRINCIPAL });
    await gateway.reportNotificationUndelivered('operator_configured', 'delivery_refused', { recipient: OPERATOR });
    // The address travels to the hook, so a caller can match the failure to its own record.
    expect(hook).toHaveBeenCalledWith('operator_configured', 'delivery_refused', OPERATOR);
  });

  it('returns false when the adapter refuses the notice during the publish', async () => {
    // bus.publish awaits its subscribers, so the email adapter's refusal arrives before
    // sendNotification returns. Returning true there recorded a mistyped operator address as a
    // sent confirmation for good (#2710 self-review).
    const hook = vi.fn(async () => {});
    const { gateway, published } = makeGatewayWithHook(hook, { principalEmail: () => PRINCIPAL });
    const bus = (gateway as unknown as { bus: EventBus }).bus;
    (bus.publish as ReturnType<typeof vi.fn>).mockImplementation(async (_layer: string, event: BusEvent) => {
      published.push({ event });
      if (event.type === 'outbound.notification') {
        await gateway.reportNotificationUndelivered(event.payload.notificationType, 'delivery_refused', {
          recipient: event.payload.recipient,
          notificationEventId: event.id,
        });
      }
    });

    const sent = await gateway.sendNotification({ notificationType: 'operator_configured', subject: 's', body: 'b' });

    expect(sent).toBe(false);
    expect(undelivered(published)[0]!.payload).toMatchObject({ reason: 'delivery_refused' });
    // The hook still runs: it is the backstop for a report that comes after the return.
    expect(hook).toHaveBeenCalledWith('operator_configured', 'delivery_refused', PRINCIPAL);
  });

  it('a refusal of a different notice during the publish does not fail this one', async () => {
    const { gateway, published } = makeGatewayWithHook(async () => {}, { principalEmail: () => PRINCIPAL });
    const bus = (gateway as unknown as { bus: EventBus }).bus;
    (bus.publish as ReturnType<typeof vi.fn>).mockImplementation(async (_layer: string, event: BusEvent) => {
      published.push({ event });
      if (event.type === 'outbound.notification') {
        await gateway.reportNotificationUndelivered('inbox_triage_paused', 'delivery_failed', {
          notificationEventId: 'some-other-event',
        });
      }
    });

    expect(await gateway.sendNotification({ notificationType: 'operator_configured', subject: 's', body: 'b' })).toBe(true);
  });

  it('a report that arrives after the publish returned leaves that result alone and reaches the hook', async () => {
    const hook = vi.fn(async () => {});
    const { gateway, published } = makeGatewayWithHook(hook, { principalEmail: () => PRINCIPAL });
    expect(await gateway.sendNotification({ notificationType: 'operator_configured', subject: 's', body: 'b' })).toBe(true);
    const [notice] = notices(published);

    await gateway.reportNotificationUndelivered('operator_configured', 'delivery_failed', {
      recipient: PRINCIPAL,
      notificationEventId: notice!.id,
    });

    expect(hook).toHaveBeenCalledWith('operator_configured', 'delivery_failed', PRINCIPAL);
    // Nothing is left tracked: the next notice publishes as sent.
    expect(await gateway.sendNotification({ notificationType: 'operator_configured', subject: 's', body: 'b' })).toBe(true);
  });

  it('a throwing hook does not throw out of the report', async () => {
    const { gateway } = makeGatewayWithHook(async () => { throw new Error('hook broke'); }, { principalEmail: () => PRINCIPAL });
    await expect(gateway.reportNotificationUndelivered('operator_configured', 'delivery_failed')).resolves.toBeUndefined();
  });

  it('sends nothing when the gateway was given no recipient lookup at all', async () => {
    // Production always wires it; a test double or a stripped-down boot may not. Guessing an
    // address is worse than not sending, so this is the same audited miss.
    const { gateway, published } = makeGateway(undefined);
    expect(await gateway.sendNotification({ notificationType: 'inbox_triage_paused', subject: 's', body: 'b' })).toBe(false);
    expect(notices(published)).toEqual([]);
    expect(undelivered(published)).toHaveLength(1);
  });

  it('carries the optional block fields through untouched', async () => {
    const { gateway, published } = makeGateway({ principalEmail: () => PRINCIPAL });
    await gateway.sendNotification({
      notificationType: 'blocked_content',
      subject: 's',
      body: 'b',
      blockId: 'block_1',
      originalChannel: 'email',
      originalRecipientId: 'target@example.com',
    });
    expect(notices(published)[0]!.payload).toMatchObject({
      blockId: 'block_1',
      originalChannel: 'email',
      originalRecipientId: 'target@example.com',
      recipient: PRINCIPAL,
    });
  });

  it('reports false, and does not throw, when the bus refuses the publish', async () => {
    const { gateway, bus, published } = makeGateway({ principalEmail: () => PRINCIPAL });
    (bus.publish as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('bus down'));
    await expect(
      gateway.sendNotification({ notificationType: 'inbox_triage_paused', subject: 's', body: 'b' }),
    ).resolves.toBe(false);
    // The miss is audited as well, so a publish failure is not only a log line. The retried
    // publish is the undelivered row; the second call succeeds.
    expect(undelivered(published)[0]!.payload).toMatchObject({ reason: 'publish_failed' });
  });
});
