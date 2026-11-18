import { describe, it, expect, vi } from 'vitest';
import { MailboxOutageNotifier } from '../../../src/health/mailbox-outage-notifier.js';

function make(email: string | null = 'owner@example.com', sent = true) {
  const sendNotification = vi.fn().mockResolvedValue(sent);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const n = new MailboxOutageNotifier({
    gateway: { sendNotification },
    principalEmail: () => email ?? undefined,
    logger: logger as never,
  });
  return { n, sendNotification, logger };
}

describe('MailboxOutageNotifier', () => {
  it('notifier alerts once per episode and again after recovery', async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false);
    await n.record('work', 'Work', false);
    await n.record('work', 'Work', false);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    await n.record('work', 'Work', true);
    await n.record('work', 'Work', false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('tracks each mailbox on its own', async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false);
    await n.record('personal', 'Personal', false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('names the label and suggests removing the mailbox, never an address or grant', async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false, { authFailure: true });
    const payload = sendNotification.mock.calls[0]![0];
    expect(payload.notificationType).toBe('principal_mailbox_outage');
    expect(payload.ceoEmail).toBe('owner@example.com');
    expect(payload.body).toContain('Work');
    expect(payload.body.toLowerCase()).toContain('remove');
    // No address; the only "grant" is the instruction to paste a new one, never an id.
    expect(payload.body).not.toMatch(/@/);
    expect(payload.body.replace(/its new grant ID/g, '')).not.toMatch(/grant/i);
  });

  it("names the console's Edit control, matching the console wording (R29, #2600)", async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false, { authFailure: true });
    const body = sendNotification.mock.calls[0]![0].body as string;
    expect(body).toContain('use Edit on the mailbox to paste its new grant ID');
    expect(body).not.toContain('Replace grant');
    expect(body).toContain('Settings → Behaviour → Email & Calendar');
  });

  it('gives connectivity guidance, not a reconnect, when the probe failed for another reason', async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false, { authFailure: false });
    const body = sendNotification.mock.calls[0]![0].body as string;
    expect(body).toContain('Work');
    expect(body).not.toContain('use Edit');
    expect(body).not.toMatch(/reconnect/i);
    expect(body).toContain('Nylas status');
    expect(body).not.toMatch(/@/);
    expect(body).not.toMatch(/grant/i);
  });

  it('retries on the next failure when the alert could not be sent', async () => {
    const { n, sendNotification } = make('owner@example.com', false);
    await n.record('work', 'Work', false);
    await n.record('work', 'Work', false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('does not alert, and retries later, while the principal email is not bound', async () => {
    const { n, sendNotification } = make(null);
    await n.record('work', 'Work', false);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('with no delivering email adapter (none, or not yet subscribed) it is not counted as sent, and retries', async () => {
    const sendNotification = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let delivering = false;
    const n = new MailboxOutageNotifier({
      gateway: { sendNotification },
      principalEmail: () => 'owner@example.com',
      canDeliver: () => delivering,
      logger: logger as never,
    });
    await n.record('work', 'Work', false);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'work' }), expect.stringContaining('no email adapter'));
    // The primary adapter has subscribed: the next failing probe alerts.
    delivering = true;
    await n.record('work', 'Work', false);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  describe('reconnect link (#2361)', () => {
    const URL_ = 'https://curia.example.com/api/mailbox-signin/start/abc123';
    function withLink(mint: (id: string, label: string) => Promise<string | null>) {
      const sendNotification = vi.fn().mockResolvedValue(true);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const n = new MailboxOutageNotifier({
        gateway: { sendNotification },
        principalEmail: () => 'owner@example.com',
        mintReconnectLink: mint,
        logger: logger as never,
      });
      return { n, sendNotification, logger };
    }

    it('an auth failure carries a sign-in link minted for that mailbox', async () => {
      const mint = vi.fn().mockResolvedValue(URL_);
      const { n, sendNotification } = withLink(mint);
      await n.record('work', 'Work', false, { authFailure: true });
      expect(mint).toHaveBeenCalledWith('work', 'Work');
      const body = sendNotification.mock.calls[0]![0].body as string;
      expect(body).toContain(URL_);
      expect(body).toContain('7 days');
      expect(body).not.toContain('paste its new grant ID');
    });

    it('a non-auth failure mints and shows no link', async () => {
      const mint = vi.fn().mockResolvedValue(URL_);
      const { n, sendNotification } = withLink(mint);
      await n.record('work', 'Work', false, { authFailure: false });
      expect(mint).not.toHaveBeenCalled();
      expect(sendNotification.mock.calls[0]![0].body).not.toContain('mailbox-signin');
    });

    it('keeps the grant-paste wording when sign-in is not ready (null)', async () => {
      const { n, sendNotification } = withLink(vi.fn().mockResolvedValue(null));
      await n.record('work', 'Work', false, { authFailure: true });
      const body = sendNotification.mock.calls[0]![0].body as string;
      expect(body).toContain('use Edit on the mailbox to paste its new grant ID');
      expect(body).not.toContain('mailbox-signin');
    });

    it('a mint failure never stops the alert, and logs the error name only', async () => {
      const { n, sendNotification, logger } = withLink(vi.fn().mockRejectedValue(new TypeError('secret-token-xyz')));
      await n.record('work', 'Work', false, { authFailure: true });
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0]![0].body).toContain('paste its new grant ID');
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'work', errorName: 'TypeError' }), expect.any(String));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token-xyz');
    });

    it('does not mint again for later failures in the same episode', async () => {
      const mint = vi.fn().mockResolvedValue(URL_);
      const { n } = withLink(mint);
      await n.record('work', 'Work', false, { authFailure: true });
      await n.record('work', 'Work', false, { authFailure: true });
      expect(mint).toHaveBeenCalledTimes(1);
    });
  });
});
