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
    // No address; the only "grant" is the console control's name, never an id.
    expect(payload.body).not.toMatch(/@/);
    expect(payload.body.replace(/Replace grant/g, '')).not.toMatch(/grant/i);
  });

  it("names the console's Replace grant control, matching the console wording (R29)", async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false, { authFailure: true });
    const body = sendNotification.mock.calls[0]![0].body as string;
    expect(body).toContain('Replace grant');
    expect(body).toContain("Principal's mailboxes");
  });

  it('gives connectivity guidance, not a reconnect, when the probe failed for another reason', async () => {
    const { n, sendNotification } = make();
    await n.record('work', 'Work', false, { authFailure: false });
    const body = sendNotification.mock.calls[0]![0].body as string;
    expect(body).toContain('Work');
    expect(body).not.toContain('Replace grant');
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
});
