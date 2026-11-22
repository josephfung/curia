import { describe, it, expect, vi } from 'vitest';
import { MailboxOutageNotifier, MINT_RECONNECT_LINK_TIMEOUT_MS } from '../../../src/health/mailbox-outage-notifier.js';

function make(sent = true, hasOperator: (() => Promise<boolean>) | undefined = undefined) {
  const sendNotification = vi.fn().mockResolvedValue(sent);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const n = new MailboxOutageNotifier({
    gateway: { sendNotification },
    ...(hasOperator ? { hasOperator } : {}),
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
    // The recipient is the gateway's to resolve from the type (#2710); the notifier states the type only.
    expect(payload.notificationType).toBe('principal_mailbox_outage');
    expect(payload).not.toHaveProperty('ceoEmail');
    expect(payload).not.toHaveProperty('recipient');
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
    // A gateway with no address to resolve answers false (#2710), which is also what happens
    // when no principal email is bound yet: the episode is not recorded as alerted, so the next
    // failing probe tries again.
    const { n, sendNotification } = make(false);
    await n.record('work', 'Work', false);
    await n.record('work', 'Work', false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('with no delivering email adapter (none, or not yet subscribed) it is not counted as sent, and retries', async () => {
    const sendNotification = vi.fn().mockResolvedValue(true);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let delivering = false;
    const n = new MailboxOutageNotifier({
      gateway: { sendNotification },
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

  describe('the operator also hears about it (#2710)', () => {
    it('raises the link-free operator notice when an operator is set', async () => {
      const { n, sendNotification } = make(true, async () => true);
      await n.record('work', 'Work', false, { authFailure: true });
      expect(sendNotification).toHaveBeenCalledTimes(2);

      const [principal, operator] = sendNotification.mock.calls.map((c) => c[0] as {
        notificationType: string; subject: string; body: string;
      });
      expect(principal!.notificationType).toBe('principal_mailbox_outage');
      expect(operator!.notificationType).toBe('mailbox_outage');
      // No recipient is named: the gateway resolves each from its type.
      expect(operator).not.toHaveProperty('recipient');
      // The acceptance rule for this notice: no reconnect link can reach anyone but the principal.
      expect(operator!.body).not.toMatch(/https?:\/\//);
      expect(operator!.body).not.toMatch(/@/);
      expect(operator!.body).not.toMatch(/grant/i);
      expect(operator!.body).toContain('Work');
      // The principal's copy does carry the link when one was minted.
      expect(principal!.body).not.toContain('mailbox_outage');
    });

    it('sends one email only when no operator is set, so the principal is not told twice', async () => {
      const { n, sendNotification } = make(true, async () => false);
      await n.record('work', 'Work', false);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0]![0].notificationType).toBe('principal_mailbox_outage');
    });

    it('a failing operator-notice read counts as no operator, and the principal alert still stands', async () => {
      const { n, sendNotification, logger } = make(true, async () => { throw new Error('db down'); });
      await n.record('work', 'Work', false);
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0]![0].notificationType).toBe('principal_mailbox_outage');
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('whether an operator is set'));
    });

    it('a failed operator send does not hold back the episode record or the principal alert', async () => {
      // True for the principal's notice, false for the operator's.
      const sendNotification = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const n = new MailboxOutageNotifier({
        gateway: { sendNotification },
        hasOperator: async () => true,
        logger: logger as never,
      });
      await n.record('work', 'Work', false);
      await n.record('work', 'Work', false);
      // The principal's alert is one per episode, and the episode is recorded as alerted even
      // though the operator's copy failed: the gateway logs and audits that failure itself.
      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ mailboxId: 'work' }),
        expect.stringContaining('operator notice could not be sent'),
      );
    });
  });

  describe('reconnect link (#2361)', () => {
    const URL_ = 'https://curia.example.com/api/mailbox-signin/start/abc123';
    function withLink(mint: (id: string, label: string) => Promise<string | null>, mintTimeoutMs?: number) {
      const sendNotification = vi.fn().mockResolvedValue(true);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const n = new MailboxOutageNotifier({
        gateway: { sendNotification },
        mintReconnectLink: mint,
        ...(mintTimeoutMs !== undefined ? { mintTimeoutMs } : {}),
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

    it('a stalled mint does not hold the alert: past the deadline it sends the grant-paste wording', async () => {
      const { n, sendNotification, logger } = withLink(() => new Promise<string | null>(() => {}), 20);
      await n.record('work', 'Work', false, { authFailure: true });
      expect(sendNotification).toHaveBeenCalledTimes(1);
      expect(sendNotification.mock.calls[0]![0].body).toContain('paste its new grant ID');
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'work', errorName: 'MintTimeoutError' }), expect.any(String));
    });

    it('defaults the mint deadline to 10 s', () => {
      expect(MINT_RECONNECT_LINK_TIMEOUT_MS).toBe(10_000);
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
