import { describe, it, expect, vi } from 'vitest';
import { notifyLearningProposal, resolvePrincipalEmail } from './learning-notify.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';

interface CtxOpts {
  withoutGateway?: boolean;
  withoutContactService?: boolean;
  /** Principal email; '' → findContactBySystemRole returns null (no principal). */
  ceoEmail?: string;
  emailVerified?: boolean;
  emailStatus?: string;
  sendResult?: boolean;
  /** Make the contacts lookup throw, to exercise the best-effort catch. */
  lookupThrows?: boolean;
}

function makeCtx(opts: CtxOpts = {}) {
  const {
    withoutGateway = false,
    withoutContactService = false,
    ceoEmail = 'ceo@example.com',
    emailVerified = true,
    emailStatus = 'active',
    sendResult = true,
    lookupThrows = false,
  } = opts;

  const sendNotificationMock = vi.fn().mockResolvedValue(sendResult);

  // findContactBySystemRole('principal') → getContactWithIdentities(id) → verified+active email.
  // An empty ceoEmail models "no principal on file" (returns null).
  const findContactBySystemRoleMock = lookupThrows
    ? vi.fn().mockRejectedValue(new Error('DB read error'))
    : vi.fn().mockResolvedValue(ceoEmail ? { id: 'principal-1' } : null);
  const getContactWithIdentitiesMock = vi.fn().mockResolvedValue(
    ceoEmail
      ? {
          identities: [
            {
              channel: 'email',
              verified: emailVerified,
              status: emailStatus,
              channelIdentifier: ceoEmail,
            },
          ],
        }
      : { identities: [] },
  );

  const logWarnMock = vi.fn();

  const ctx = {
    log: { info: vi.fn(), warn: logWarnMock, error: vi.fn(), debug: vi.fn() },
    contactService: withoutContactService
      ? undefined
      : ({
          findContactBySystemRole: findContactBySystemRoleMock,
          getContactWithIdentities: getContactWithIdentitiesMock,
        } as unknown as SkillContext['contactService']),
    outboundGateway: withoutGateway
      ? undefined
      : ({ sendNotification: sendNotificationMock } as unknown as OutboundGateway),
  } as unknown as SkillContext;

  return { ctx, sendNotificationMock, findContactBySystemRoleMock, logWarnMock };
}

const NOTIFICATION = { subject: 'Subject', body: 'Body' };

describe('resolvePrincipalEmail', () => {
  it('returns the verified + active email', async () => {
    const { ctx } = makeCtx({ ceoEmail: 'ceo@example.com' });
    expect(await resolvePrincipalEmail(ctx)).toBe('ceo@example.com');
  });

  it('returns null when contactService is absent', async () => {
    const { ctx, logWarnMock } = makeCtx({ withoutContactService: true });
    expect(await resolvePrincipalEmail(ctx)).toBeNull();
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('returns null when there is no principal', async () => {
    const { ctx } = makeCtx({ ceoEmail: '' });
    expect(await resolvePrincipalEmail(ctx)).toBeNull();
  });

  it('returns null when the email is not verified+active (bounced/unverified)', async () => {
    const { ctx } = makeCtx({ emailStatus: 'bounced' });
    expect(await resolvePrincipalEmail(ctx)).toBeNull();
  });

  it('never throws — a contacts-layer error resolves to null', async () => {
    const { ctx, logWarnMock } = makeCtx({ lookupThrows: true });
    expect(await resolvePrincipalEmail(ctx)).toBeNull();
    expect(logWarnMock).toHaveBeenCalled();
  });
});

describe('notifyLearningProposal', () => {
  it('sends a learning_proposal notification with the resolved email + provided subject/body', async () => {
    const { ctx, sendNotificationMock } = makeCtx();
    const result = await notifyLearningProposal(ctx, NOTIFICATION);
    expect(result).toBe(true);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0]![0]).toEqual({
      notificationType: 'learning_proposal',
      ceoEmail: 'ceo@example.com',
      subject: 'Subject',
      body: 'Body',
    });
  });

  it('skips (no send) and returns false when outboundGateway is absent', async () => {
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({ withoutGateway: true });
    expect(await notifyLearningProposal(ctx, NOTIFICATION)).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('skips (no send) and returns false when no principal email is on file', async () => {
    const { ctx, sendNotificationMock } = makeCtx({ ceoEmail: '' });
    expect(await notifyLearningProposal(ctx, NOTIFICATION)).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('returns false (non-fatal) when sendNotification reports a failed send', async () => {
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx({ sendResult: false });
    expect(await notifyLearningProposal(ctx, NOTIFICATION)).toBe(false);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalled();
  });

  it('never throws — an unexpected sendNotification throw resolves to false (non-fatal)', async () => {
    const { ctx, sendNotificationMock, logWarnMock } = makeCtx();
    sendNotificationMock.mockRejectedValue(new Error('bus exploded'));
    await expect(notifyLearningProposal(ctx, NOTIFICATION)).resolves.toBe(false);
    expect(logWarnMock).toHaveBeenCalled();
  });
});
