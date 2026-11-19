// tests/unit/dispatch/task-outreach-capability.test.ts
//
// Who counts as task-bound, how the summary is chosen, and the own-identity match the
// browser backstop uses (#2312).

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  TaskOutreachService,
  outreachScope,
  recordSendOutreach,
  sendSummaryFallback,
  SEND_SUMMARY_MAX_CHARS,
} from '../../../src/dispatch/task-outreach-capability.js';
import type { TaskOutreachRepo, TaskOutreachInput, TaskOutreachRow } from '../../../src/dispatch/task-outreach.js';
import type { ChannelIdentity, TaskOriginator } from '../../../src/contacts/types.js';

const log = pino({ level: 'silent' });

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_ID = '33333333-3333-4333-8333-333333333333';
const CONTACT_ID = '44444444-4444-4444-8444-444444444444';

const principalOriginator: TaskOriginator = {
  contactId: PRINCIPAL_ID, systemRole: 'principal', authenticated: true, channel: 'email', initiatedAt: '2026-10-26T00:00:00Z', tier: 'principal',
};
const outsiderOriginator: TaskOriginator = {
  contactId: CONTACT_ID, systemRole: null, channel: 'email', initiatedAt: '2026-10-26T00:00:00Z', tier: 'known',
} as unknown as TaskOriginator;

function identity(channel: string, channelIdentifier: string): ChannelIdentity {
  return {
    id: `id-${channelIdentifier}`, contactId: PRINCIPAL_ID, channel, channelIdentifier, label: null, verified: true,
    verifiedAt: null, status: 'active', source: 'ceo_stated', createdAt: new Date(), updatedAt: new Date(),
  } as unknown as ChannelIdentity;
}

function makeRepo() {
  const record = vi.fn(async (input: TaskOutreachInput) => ({ id: 'row-1', ...input } as unknown as TaskOutreachRow));
  return { repo: { record } as unknown as TaskOutreachRepo, record };
}

function makeService(opts: { title?: string | null; nonOrgDomains?: ReadonlySet<string> } = {}) {
  const { repo, record } = makeRepo();
  const lookupTask = vi.fn(async (id: string) => (opts.title === null ? null : { title: opts.title ?? 'Book physio', rootTaskId: id === TASK_ID ? ROOT_ID : null }));
  const service = new TaskOutreachService(repo, {
    principalIdentities: [identity('email', 'Joe@Example.com'), identity('sms', '+14165550100')],
    selfEmails: ['curia@office.example'],
    lookupTask,
    ...(opts.nonOrgDomains ? { nonOrgDomains: opts.nonOrgDomains } : {}),
    log,
  });
  return { service, record, lookupTask };
}

describe('outreachScope', () => {
  it('a bound task is task-bound', () => {
    expect(outreachScope({
      taskMetadata: { originator: outsiderOriginator, boundTask: { taskId: TASK_ID } },
      conversationId: 'conv-1', taskEventId: 'evt-1',
    })).toEqual({ taskId: TASK_ID, conversationId: 'conv-1', directingEventId: 'evt-1', originator: outsiderOriginator });
  });

  it('a strongly linked task is task-bound', () => {
    expect(outreachScope({
      taskMetadata: { originator: outsiderOriginator, linkedTask: { taskId: TASK_ID, strength: 'strong' } },
      conversationId: 'conv-1',
    })?.taskId).toBe(TASK_ID);
  });

  it('a weak link binds nothing: an outsider turn may not record outreach on it', () => {
    expect(outreachScope({
      taskMetadata: { originator: outsiderOriginator, linkedTask: { taskId: TASK_ID, strength: 'weak' } },
      conversationId: 'conv-1',
    })).toBeNull();
  });

  it('a live principal turn with no task is scoped to its conversation', () => {
    expect(outreachScope({
      taskMetadata: { originator: principalOriginator }, liveTurn: true, conversationId: 'conv-1', taskEventId: 'evt-1',
    })).toEqual({ taskId: null, conversationId: 'conv-1', directingEventId: 'evt-1', originator: principalOriginator });
  });

  it('an outsider turn with no task is not task-bound', () => {
    expect(outreachScope({ taskMetadata: { originator: outsiderOriginator }, liveTurn: true, conversationId: 'conv-1' })).toBeNull();
  });

  it('principal lineage without a live turn is not task-bound', () => {
    expect(outreachScope({ taskMetadata: { originator: principalOriginator }, conversationId: 'conv-1' })).toBeNull();
  });

  it('a turn with no originator is not task-bound', () => {
    expect(outreachScope({ taskMetadata: { boundTask: { taskId: TASK_ID } }, conversationId: 'conv-1' })).toBeNull();
  });
});

describe('TaskOutreachService.recordForTurn', () => {
  it('uses the task title and root when asked to, and the fallback otherwise', async () => {
    const { service, record } = makeService();
    const turn = { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c', taskEventId: 'e' };
    await service.recordForTurn(turn, { via: 'web_form', summary: 'Web form submitted', useTaskTitle: true });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: TASK_ID, rootTaskId: ROOT_ID, summary: 'Book physio' }));
    await service.recordForTurn(turn, { via: 'phone', summary: 'Called the clinic' });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'Called the clinic', rootTaskId: ROOT_ID }));
  });

  it('falls back to the given summary when the task cannot be read', async () => {
    const { service, record } = makeService({ title: null });
    await service.recordForTurn(
      { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c' },
      { via: 'web_form', summary: 'Web form submitted', useTaskTitle: true },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Web form submitted', rootTaskId: null }));
  });

  it("never stores the principal's own org domain on a row", async () => {
    const { service, record } = makeService({ nonOrgDomains: new Set(['office.example']) });
    await service.recordForTurn(
      { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c' },
      { via: 'email', summary: 'Asked', domains: ['office.example', 'Acme.example'] },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ domains: ['Acme.example'] }));
  });

  it("never stores the principal's own org domain written with a trailing dot", async () => {
    const { service, record } = makeService({ nonOrgDomains: new Set(['office.example']) });
    await service.recordForTurn(
      { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c' },
      { via: 'email', summary: 'Asked', domains: [' Office.Example. ', 'acme.example'] },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ domains: ['acme.example'] }));
  });

  it('returns null and writes nothing off-task', async () => {
    const { service, record } = makeService();
    const row = await service.recordForTurn({ taskMetadata: { originator: outsiderOriginator } }, { via: 'other', summary: 'x' });
    expect(row).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('TaskOutreachService confirmed (#2312)', () => {
  const principalTask = { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c' };

  it('an explicit act on a principal-originated turn is confirmed', async () => {
    const { service, record } = makeService();
    await service.recordForTurn(principalTask, { via: 'phone', summary: 'Called' });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: true }));
  });

  // GHSA-p49r-jqh2-v668: a forged From or spoofed SMS number is the principal's identity
  // without the principal's authority, so its acts are not confirmed.
  it('an explicit act on an unauthenticated principal turn is not confirmed', async () => {
    const { service, record } = makeService();
    const forged = { ...principalTask, taskMetadata: { ...principalTask.taskMetadata, originator: { ...principalOriginator, channel: 'sms', authenticated: false } } };
    await service.recordForTurn(forged, { via: 'phone', summary: 'Called' });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: false }));
  });

  it('a backstop row is never confirmed, even on a principal turn', async () => {
    const { service, record } = makeService();
    await service.recordForTurn(principalTask, { via: 'web_form', summary: 'Web form submitted', backstop: true });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ confirmed: false }));
  });

  it('a send on an outsider turn bound only by a linked task is not confirmed', async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      {
        turn: { taskMetadata: { originator: outsiderOriginator, linkedTask: { taskId: TASK_ID, strength: 'strong' } }, conversationId: 'c', taskOutreach: service },
        via: 'email',
        addresses: ['bookings@acme.example'],
      },
      { recipientContactIds: [CONTACT_ID], log },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK_ID, confirmed: false }));
  });
});

describe('TaskOutreachService.ownIdentity', () => {
  it('matches the principal email case-insensitively and trimmed', () => {
    const { service } = makeService();
    expect(service.ownIdentity('  joe@example.COM ')).toBe('joe@example.com');
  });

  it("matches Curia's own mailbox", () => {
    const { service } = makeService();
    expect(service.ownIdentity('Curia@office.example')).toBe('curia@office.example');
  });

  it('matches the principal phone across formatting, with or without the country code', () => {
    const { service } = makeService();
    expect(service.ownIdentity('+1 (416) 555-0100')).toBe('+14165550100');
    expect(service.ownIdentity('416-555-0100')).toBe('+14165550100');
  });

  it('does not match other text', () => {
    const { service } = makeService();
    expect(service.ownIdentity('Joe Fung')).toBeNull();
    expect(service.ownIdentity('someone@example.com')).toBeNull();
    expect(service.ownIdentity('5550100')).toBeNull();
    expect(service.ownIdentity('')).toBeNull();
  });
});

describe('recordSendOutreach', () => {
  const wake = { taskMetadata: { originator: principalOriginator, boundTask: { taskId: TASK_ID } }, conversationId: 'c', taskEventId: 'e' };

  it('records recipients, contact ids and org domains (webmail excluded) on a task wake', async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { ...wake, taskOutreach: service }, via: 'email', addresses: ['Bookings@Acme.example', 'pal@gmail.com'] },
      { recipientContactIds: [CONTACT_ID], log },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      via: 'email',
      addresses: ['bookings@acme.example', 'pal@gmail.com'],
      contactIds: [CONTACT_ID],
      domains: ['acme.example'],
      summary: 'Book physio',
      originator: principalOriginator,
    }));
  });

  it("leaves out a principal domain configured as a full host before reducing to the org domain", async () => {
    const { service, record } = makeService({ nonOrgDomains: new Set(['mail.corp.example']) });
    await recordSendOutreach(
      { turn: { ...wake, taskOutreach: service }, via: 'email', addresses: ['dana@mail.corp.example', 'bookings@acme.example'] },
      { recipientContactIds: [CONTACT_ID], log },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ domains: ['acme.example'] }));
  });

  it('never stores the message body: with no task, an SMS is labelled by channel (#2312)', async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { taskMetadata: { originator: principalOriginator }, liveTurn: true, conversationId: 'conv-9', taskEventId: 'evt-9', taskOutreach: service }, via: 'sms', addresses: ['+14165550199'] },
      { recipientContactIds: [CONTACT_ID], log },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      taskId: null, conversationId: 'conv-9', directingEventId: 'evt-9', summary: 'SMS message', domains: [],
    }));
  });

  it('with no task title, an email uses its subject, else names the first org domain (#2312)', async () => {
    const live = { taskMetadata: { originator: principalOriginator }, liveTurn: true, conversationId: 'conv-9', taskEventId: 'evt-9' };
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { ...live, taskOutreach: service }, via: 'email', addresses: ['bookings@acme.example'], subject: '  Re: Tuesday appointment ' },
      { recipientContactIds: [], log },
    );
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'Re: Tuesday appointment' }));
    await recordSendOutreach(
      { turn: { ...live, taskOutreach: service }, via: 'email', addresses: ['pal@gmail.com', 'bookings@acme.example'] },
      { recipientContactIds: [], log },
    );
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'Email to acme.example' }));
    await recordSendOutreach(
      { turn: { ...live, taskOutreach: service }, via: 'email', addresses: ['pal@gmail.com'], subject: ' ' },
      { recipientContactIds: [], log },
    );
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ summary: 'Email to a contact' }));
  });

  it('a bound task title still wins over the subject', async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { ...wake, taskOutreach: service }, via: 'email', addresses: ['bookings@acme.example'], subject: 'Hello there' },
      { recipientContactIds: [], log },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Book physio' }));
  });

  it.each([
    ['signal', 'Signal message'], ['slack', 'Slack message'], ['sms', 'SMS message'],
  ] as const)('labels a %s send with no task title as %j', (via, label) => {
    expect(sendSummaryFallback(via, undefined, [])).toBe(label);
  });

  it('caps a long subject', () => {
    expect(sendSummaryFallback('email', 's'.repeat(300), [])).toBe('s'.repeat(SEND_SUMMARY_MAX_CHARS));
  });

  it("leaves out the principal and Curia's own addresses, and writes nothing when no one else is left", async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { ...wake, taskOutreach: service }, via: 'email', addresses: ['joe@example.com'] },
      { recipientContactIds: [PRINCIPAL_ID], log },
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('writes nothing on an outsider turn with no task', async () => {
    const { service, record } = makeService();
    await recordSendOutreach(
      { turn: { taskMetadata: { originator: outsiderOriginator }, liveTurn: true, conversationId: 'c', taskOutreach: service }, via: 'email', addresses: ['bookings@acme.example'] },
      { recipientContactIds: [CONTACT_ID], log },
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('never throws when the write fails', async () => {
    const { service, record } = makeService();
    record.mockRejectedValueOnce(new Error('db down'));
    await expect(recordSendOutreach(
      { turn: { ...wake, taskOutreach: service }, via: 'email', addresses: ['bookings@acme.example'] },
      { recipientContactIds: [CONTACT_ID], log },
    )).resolves.toBeUndefined();
  });

  it('is a no-op without the capability', async () => {
    await expect(recordSendOutreach(
      { turn: wake, via: 'email', addresses: ['bookings@acme.example'] },
      { recipientContactIds: [], log },
    )).resolves.toBeUndefined();
  });
});
