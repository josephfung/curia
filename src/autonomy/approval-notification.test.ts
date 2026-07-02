import { describe, it, expect, vi } from 'vitest';
import {
  buildApprovalDetails,
  buildApprovalNotificationBody,
  enrichGatewayApprovalPayload,
  resolveNotificationRecipientTier,
  SKILL_DETAIL_FIXTURES,
  MAX_DETAIL_FIELD_LENGTH,
  MAX_DETAIL_TOTAL_LENGTH,
} from './approval-notification.js';
import type { ContactService } from '../contacts/contact-service.js';
import { createSilentLogger } from '../logger.js';

describe('buildApprovalDetails', () => {
  it.each(SKILL_DETAIL_FIXTURES)(
    'renders a non-empty block for $skillName fixture payload',
    ({ skillName, payload }) => {
      const details = buildApprovalDetails(skillName, payload);
      expect(details.trim().length).toBeGreaterThan(0);
    },
  );

  it('renders signal-send recipient and message body', () => {
    const details = buildApprovalDetails('signal-send', {
      recipient: '+15550142',
      message: 'Hi Dana, confirming our 3pm sync moved to Thursday.',
    });
    expect(details).toContain('To: +15550142');
    expect(details).toContain('Message: Hi Dana, confirming our 3pm sync moved to Thursday.');
  });

  it('renders send-draft from merged gate-time fields when draft_id is absent', () => {
    const details = buildApprovalDetails('send-draft', {
      account: 'curia',
      to: 'dana@example.com',
      subject: 'Re: Budget',
      body: 'Please review the attached deck.',
    });
    expect(details).toContain('To: dana@example.com');
    expect(details).toContain('Subject: Re: Budget');
    expect(details).toContain('Body: Please review the attached deck.');
    expect(details).not.toContain('Draft:');
  });

  it('renders email-reply body', () => {
    const details = buildApprovalDetails('email-reply', {
      reply_to_message_id: 'msg-abc',
      body: 'Thanks — Thursday works for me.',
    });
    expect(details).toContain('Reply to: msg-abc');
    expect(details).toContain('Message: Thanks — Thursday works for me.');
  });

  it('renders calendar event timing and attendees', () => {
    const details = buildApprovalDetails('calendar-create-event', {
      title: 'Board sync',
      start: '2026-07-02T15:00:00Z',
      end: '2026-07-02T16:00:00Z',
      attendees: [{ name: 'Dana Ruiz', email: 'dana@example.com' }],
    });
    expect(details).toContain('Title: Board sync');
    expect(details).toContain('Start: 2026-07-02T15:00:00Z');
    expect(details).toContain('Attendees: Dana Ruiz (dana@example.com)');
  });

  it('uses generic fields for unknown skills', () => {
    const details = buildApprovalDetails('some-custom-skill', {
      to: 'ops@example.com',
      body: 'Please review the attached report.',
      internal_token: 'should-not-appear',
    });
    expect(details).toContain('To: ops@example.com');
    expect(details).toContain('Body: Please review the attached report.');
    expect(details).not.toContain('internal_token');
  });

  it('skips object-valued fields in the generic path', () => {
    const details = buildApprovalDetails('some-custom-skill', {
      content: { nested: 'secret-shape' },
      body: 'visible text',
    });
    expect(details).toContain('Body: visible text');
    expect(details).not.toContain('nested');
    expect(details).not.toContain('secret-shape');
  });

  it('redacts secrets via sanitizeOutput', () => {
    const details = buildApprovalDetails('signal-send', {
      recipient: '+15550142',
      message: 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
    });
    expect(details).toContain('[REDACTED]');
    expect(details).not.toContain('sk-ant-api03');
  });

  it('enforces per-field length cap', () => {
    const longMessage = 'x'.repeat(MAX_DETAIL_FIELD_LENGTH + 100);
    const details = buildApprovalDetails('signal-send', {
      recipient: '+15550142',
      message: longMessage,
    });
    const messageLine = details.split('\n').find((l) => l.startsWith('Message:'));
    expect(messageLine).toBeDefined();
    expect(messageLine).toContain('[truncated — output exceeded limit]');
  });

  it('enforces total length cap across fields', () => {
    const chunk = 'hello '.repeat(120);
    const details = buildApprovalDetails('some-custom-skill', {
      to: chunk,
      subject: chunk,
      body: chunk,
      message: chunk,
      description: chunk,
    });
    expect(details.length).toBeLessThanOrEqual(MAX_DETAIL_TOTAL_LENGTH + 50);
  });
});

describe('enrichGatewayApprovalPayload', () => {
  it('fills missing send fields without overwriting partialPayload', () => {
    const merged = enrichGatewayApprovalPayload(
      { account: 'curia', draft_id: 'draft-1' },
      { to: 'ceo@example.com', subject: 'Hello', body: 'Body text' },
    );
    expect(merged).toEqual({
      account: 'curia',
      draft_id: 'draft-1',
      to: 'ceo@example.com',
      subject: 'Hello',
      body: 'Body text',
    });
  });

  it('does not overwrite keys already present in partialPayload', () => {
    const merged = enrichGatewayApprovalPayload(
      { to: 'stored@example.com' },
      { to: 'live@example.com', body: 'live body' },
    );
    expect(merged.to).toBe('stored@example.com');
    expect(merged.body).toBe('live body');
  });
});

describe('buildApprovalNotificationBody', () => {
  const baseOpts = {
    preamble: 'Curia wanted to send a Signal message.',
    shortRef: 'c6fd31ad',
    expiresAt: new Date('2026-07-02T20:53:26.183Z'),
    skillName: 'signal-send',
    payload: {
      recipient: '+15550142',
      message: 'Hi Dana',
    },
    ceoEmail: 'ceo@example.com',
  };

  it('includes detail block for principal recipient', () => {
    const body = buildApprovalNotificationBody({
      ...baseOpts,
      recipientTier: 'principal',
    });
    expect(body).toContain('To: +15550142');
    expect(body).toContain('Message: Hi Dana');
    expect(body).toContain('Reference: c6fd31ad');
    expect(body).toContain('Expires: 2026-07-02T20:53:26.183Z');
    expect(body).toContain('Reply to approve');
  });

  it('omits detail block for sub-principal recipient', () => {
    const logWarn = vi.fn();
    const body = buildApprovalNotificationBody({
      ...baseOpts,
      recipientTier: 'trusted',
      logger: { warn: logWarn } as never,
    });
    expect(body).not.toContain('To: +15550142');
    expect(body).not.toContain('Message: Hi Dana');
    expect(body).toContain('Reference: c6fd31ad');
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ recipientTier: 'trusted', ceoEmail: 'ceo@example.com' }),
      expect.stringContaining('detail block omitted'),
    );
  });

  it('warns when principal recipient has no renderable detail fields', () => {
    const logWarn = vi.fn();
    buildApprovalNotificationBody({
      ...baseOpts,
      recipientTier: 'principal',
      payload: { account: 'curia' },
      skillName: 'send-draft',
      logger: { warn: logWarn } as never,
    });
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'send-draft' }),
      expect.stringContaining('no renderable fields in payload'),
    );
  });

  it('omits detail block when recipient tier is unknown', () => {
    const logWarn = vi.fn();
    const body = buildApprovalNotificationBody({
      ...baseOpts,
      recipientTier: null,
      logger: { warn: logWarn } as never,
    });
    expect(body).not.toContain('To: +15550142');
    expect(logWarn).toHaveBeenCalled();
  });

  it('preserves extra lines between preamble and reference block', () => {
    const body = buildApprovalNotificationBody({
      ...baseOpts,
      recipientTier: 'principal',
      extraLines: ['Autonomy score: 65 (threshold: 70)'],
    });
    expect(body).toContain('Autonomy score: 65 (threshold: 70)');
    expect(body.indexOf('Autonomy score')).toBeLessThan(body.indexOf('Reference:'));
  });
});

describe('resolveNotificationRecipientTier', () => {
  it('returns tier from contact service lookup', async () => {
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ tier: 'principal' }),
    } as unknown as ContactService;

    const tier = await resolveNotificationRecipientTier(
      contactService,
      'ceo@example.com',
      createSilentLogger(),
    );
    expect(tier).toBe('principal');
    expect(contactService.resolveByChannelIdentity).toHaveBeenCalledWith('email', 'ceo@example.com');
  });

  it('returns null and warns when lookup finds no contact', async () => {
    const logWarn = vi.fn();
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    } as unknown as ContactService;

    const tier = await resolveNotificationRecipientTier(
      contactService,
      'ceo@example.com',
      { warn: logWarn } as never,
    );
    expect(tier).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ ceoEmail: 'ceo@example.com' }),
      expect.stringContaining('recipient not found'),
    );
  });

  it('returns null and warns when contact service is absent', async () => {
    const logWarn = vi.fn();
    const tier = await resolveNotificationRecipientTier(
      undefined,
      'ceo@example.com',
      { warn: logWarn } as never,
    );
    expect(tier).toBeNull();
    expect(logWarn).toHaveBeenCalled();
  });

  it('returns null and warns when lookup throws', async () => {
    const logWarn = vi.fn();
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('DB down')),
    } as unknown as ContactService;

    const tier = await resolveNotificationRecipientTier(
      contactService,
      'ceo@example.com',
      { warn: logWarn } as never,
    );
    expect(tier).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), ceoEmail: 'ceo@example.com' }),
      expect.stringContaining('tier lookup failed'),
    );
  });
});

describe('shared notification body — both call sites', () => {
  it('approval-trigger and outbound-gateway use the same builder for equivalent inputs', async () => {
    const { buildApprovalNotificationBody: fromTrigger } = await import('./approval-notification.js');
    const { buildApprovalNotificationBody: fromGateway } = await import('./approval-notification.js');

    const opts = {
      preamble: 'Curia wanted to run signal-send.',
      shortRef: 'abc12345',
      expiresAt: new Date('2026-07-02T12:00:00.000Z'),
      skillName: 'signal-send',
      payload: { recipient: '+1', message: 'hello' },
      recipientTier: 'principal' as const,
    };

    expect(fromTrigger(opts)).toBe(fromGateway(opts));
  });
});
