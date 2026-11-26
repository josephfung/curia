import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { RecordOutreachHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { TaskOutreachService } from '../../../../src/dispatch/task-outreach-capability.js';
import type { TaskOutreachInput, TaskOutreachRepo, TaskOutreachRow } from '../../../../src/dispatch/task-outreach.js';

const log = pino({ level: 'silent' });
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const principal = { contactId: 'p', systemRole: 'principal', authenticated: true, channel: 'email', initiatedAt: '2026-10-26T00:00:00Z', tier: 'principal' };
const outsider = { contactId: 'o', systemRole: null, channel: 'email', initiatedAt: '2026-10-26T00:00:00Z', tier: 'known' };

function makeOutreach() {
  const record = vi.fn(async (input: TaskOutreachInput) => ({ id: 'outreach-1', ...input } as unknown as TaskOutreachRow));
  const service = new TaskOutreachService({ record } as unknown as TaskOutreachRepo, {
    principalIdentities: [], selfEmails: [], log,
  });
  return { service, record };
}

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log,
    agentId: 'coordinator',
    conversationId: 'conv-1',
    taskEventId: 'evt-1',
    taskMetadata: { originator: principal, boundTask: { taskId: TASK_ID } },
    ...overrides,
  } as unknown as ToolContext;
}

describe('record-outreach', () => {
  it('records a web form for the bound task, with registrable domains from the website and form', async () => {
    const { service, record } = makeOutreach();
    const result = await new RecordOutreachHandler().execute(makeCtx({
      via: 'web_form',
      org_name: 'Acme Physio',
      website: 'https://www.Acme.example/contact',
      form_url: 'https://form.typeform.com/to/abc123',
      contact_given: "the principal's email",
      summary: 'Asked Acme Physio for a Tuesday appointment',
    }, { taskOutreach: service }));

    expect(result).toEqual({ success: true, data: { recorded: true, outreach_id: 'outreach-1' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      via: 'web_form',
      orgName: 'Acme Physio',
      // The form host is kept: the linker excludes it from org-domain matches (#2312).
      domains: ['acme.example', 'typeform.com'],
      givenContact: "the principal's email",
      summary: 'Asked Acme Physio for a Tuesday appointment',
      // An explicit act on a principal-originated turn (#2312).
      confirmed: true,
    }));
  });

  it('records a call on a live principal turn with no task', async () => {
    const { service, record } = makeOutreach();
    const result = await new RecordOutreachHandler().execute(makeCtx(
      { via: 'phone', org_name: 'Acme Physio', summary: 'Left a voicemail asking for a callback' },
      { taskOutreach: service, liveTurn: true, taskMetadata: { originator: principal } },
    ));
    expect(result.success).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ taskId: null, conversationId: 'conv-1', directingEventId: 'evt-1', domains: [] }));
  });

  it('refuses when the turn is not task-bound', async () => {
    const { service, record } = makeOutreach();
    const result = await new RecordOutreachHandler().execute(makeCtx(
      { via: 'web_form', website: 'acme.example', summary: 'Submitted the contact form' },
      { taskOutreach: service, liveTurn: true, taskMetadata: { originator: outsider } },
    ));
    expect(result).toEqual({ success: false, error: 'Outreach can only be recorded for work the principal or a task directed.' });
    expect(record).not.toHaveBeenCalled();
  });

  it('validates its inputs', async () => {
    const { service } = makeOutreach();
    const handler = new RecordOutreachHandler();
    expect((await handler.execute(makeCtx({ via: 'email', summary: 'x' }, { taskOutreach: service }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ via: 'phone' }, { taskOutreach: service }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ via: 'phone', summary: '  ' }, { taskOutreach: service }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ via: 'web_form', summary: 'x', website: 42 }, { taskOutreach: service }))).success).toBe(false);
    expect((await handler.execute(makeCtx({ via: 'web_form', summary: 'x', website: 'not a host' }, { taskOutreach: service }))).success).toBe(false);
  });

  it('fails cleanly without the capability or when the write fails', async () => {
    expect((await new RecordOutreachHandler().execute(makeCtx({ via: 'phone', summary: 'x' }))).success).toBe(false);
    const { service, record } = makeOutreach();
    record.mockRejectedValueOnce(new Error('db down'));
    const result = await new RecordOutreachHandler().execute(makeCtx({ via: 'phone', summary: 'x' }, { taskOutreach: service }));
    expect(result).toEqual({ success: false, error: 'Could not record the outreach. Try again shortly.' });
  });
});
