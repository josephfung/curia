// Regression for issue #1067: createGrantRecommendation can throw when ON CONFLICT
// skips the insert and the winner vanishes before re-fetch. The scan loop must
// treat that like the other per-contact failures so earlier creates still report.
//
// #2129: every pending recommendation is filed as a principal-owned task, the only
// path by which a scheduled scan's recommendation reaches the principal.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ScanGrantRecommendationsHandler } from '../../../skills/contacts/tools/scan-grant-recommendations/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import type { Contact } from '../../../src/contacts/types.js';
import type { GrantRecommendation } from '../../../src/contacts/types.js';

const logger = pino({ level: 'silent' });

function makeContact(id: string, displayName: string): Contact {
  return {
    id,
    kgNodeId: null,
    displayName,
    role: 'Advisor',
    systemRole: null,
    tier: 'known',
    kind: 'person',
    contactConfidence: 0.9,
    lastSeenAt: null,
    inboundMessageCount: 12,
    outboundMessageCount: 8,
    notes: null,
    preferredName: null,
    title: null,
    organization: null,
    primaryEmail: null,
    primaryPhone: null,
    timezone: null,
    locale: null,
    location: null,
    pronouns: null,
    linkedinUrl: null,
    bio: null,
    birthday: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTaskRepo(existing: Array<{ tags: string[] }> = []) {
  return {
    listTasks: vi.fn().mockResolvedValue(existing),
    createTask: vi.fn().mockResolvedValue({}),
  };
}

function makeRec(id: string, contactId: string, status: GrantRecommendation['status'] = 'pending'): GrantRecommendation {
  return {
    id,
    contactId,
    permission: 'schedule_meetings',
    reasoning: 'Regular calendar coordination.',
    status,
    suggestedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
  };
}

function makeCtx(contactService: unknown, taskRepo: unknown = makeTaskRepo()): ToolContext {
  return {
    toolName: 'scan-grant-recommendations',
    toolVersion: '0.1.1',
    input: { cadence_ceiling: 3, max_candidates: 20 },
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    contactService: contactService as ToolContext['contactService'],
    taskRepo: (taskRepo ?? undefined) as ToolContext['taskRepo'],
    infraLlm: {
      classify: vi.fn(),
      extract: vi.fn().mockResolvedValue({
        ok: true,
        text: JSON.stringify({ recommend: true, reasoning: 'Regular calendar coordination.' }),
      }),
    },
  };
}

describe('ScanGrantRecommendationsHandler create failures (issue #1067)', () => {
  it('skips a throwing create and still reports recommendations created earlier in the run', async () => {
    const first = makeContact('11111111-1111-4111-8111-111111111111', 'First Contact');
    const second = makeContact('22222222-2222-4222-8222-222222222222', 'Second Contact');
    const persisted: GrantRecommendation = {
      id: '33333333-3333-4333-8333-333333333333',
      contactId: first.id,
      permission: 'schedule_meetings',
      reasoning: 'Regular calendar coordination.',
      status: 'pending',
      suggestedAt: new Date(),
      resolvedAt: null,
      resolvedBy: null,
    };

    const contactService = {
      listContacts: vi.fn().mockResolvedValue([first, second]),
      listGrantRecommendations: vi.fn().mockResolvedValue([]),
      getAuthOverrides: vi.fn().mockResolvedValue([]),
      createGrantRecommendation: vi.fn()
        .mockResolvedValueOnce({ created: true, recommendation: persisted })
        .mockRejectedValueOnce(new Error(
          `Grant recommendation conflict for ${second.id}/schedule_meetings but no existing row found`,
        )),
    };

    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(contactService));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as {
      evaluated: number;
      created: number;
      skipped_errors: number;
      skipped_existing: number;
      skipped_judge: number;
      recommendations_created: Array<{
        id: string;
        contact_id: string;
        contact_name: string;
        permission: string;
        reasoning: string;
      }>;
    };
    expect(data).toMatchObject({
      evaluated: 2,
      created: 1,
      skipped_errors: 1,
      skipped_existing: 0,
      skipped_judge: 0,
    });
    expect(data.recommendations_created).toEqual([
      {
        id: persisted.id,
        contact_id: first.id,
        contact_name: first.displayName,
        permission: 'schedule_meetings',
        reasoning: 'Regular calendar coordination.',
      },
    ]);
    expect(contactService.createGrantRecommendation).toHaveBeenCalledTimes(2);
  });
});

describe('ScanGrantRecommendationsHandler principal tasks (#2129)', () => {
  const contact = makeContact('11111111-1111-4111-8111-111111111111', 'Dana Whitfield');
  const recId = '33333333-3333-4333-8333-333333333333';

  function serviceCreating(existingRecs: GrantRecommendation[] = [], contacts: Contact[] = [contact]) {
    return {
      listContacts: vi.fn().mockResolvedValue(contacts),
      listGrantRecommendations: vi.fn().mockResolvedValue(existingRecs),
      getAuthOverrides: vi.fn().mockResolvedValue([]),
      getContact: vi.fn().mockImplementation(async (id: string) => contacts.find(c => c.id === id)),
      createGrantRecommendation: vi.fn().mockResolvedValue({ created: true, recommendation: makeRec(recId, contact.id) }),
    };
  }

  it('files a principal-owned task for each new recommendation', async () => {
    const taskRepo = makeTaskRepo();
    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(serviceCreating(), taskRepo));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ created: 1, tasks_filed: 1, task_failures: 0 });
    expect(taskRepo.listTasks).toHaveBeenCalledWith(expect.objectContaining({ tag: 'grant-recommendation' }));
    // Every status: a closed task (answered or deferred) must keep the recommendation filed.
    expect(taskRepo.listTasks.mock.calls[0]![0]).not.toHaveProperty('statuses');
    expect(taskRepo.createTask).toHaveBeenCalledTimes(1);
    const params = taskRepo.createTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({
      agentId: 'contacts',
      owner: 'ceo',
      sourceAgentId: 'contacts',
      title: 'Grant Dana Whitfield scheduling access?',
      tags: ['grant-recommendation', 'contacts', `grant-rec:${recId}`],
    });
    expect(params['description']).toContain(`Recommendation ID: ${recId}`);
    expect(params['progressNote']).toContain('Regular calendar coordination.');
  });

  it('files a pending recommendation that has no task yet, and skips one that has', async () => {
    const other = makeContact('44444444-4444-4444-8444-444444444444', 'Omar Haddad');
    const filedRecId = '55555555-5555-4555-8555-555555555555';
    const orphanRecId = '66666666-6666-4666-8666-666666666666';
    const resolvedRecId = '77777777-7777-4777-8777-777777777777';
    const existingRecs = [
      makeRec(filedRecId, contact.id),
      makeRec(orphanRecId, other.id),
      makeRec(resolvedRecId, other.id, 'declined'),
    ];
    // Both contacts already have a recommendation, so the scan creates none.
    const svc = serviceCreating(existingRecs, [contact, other]);
    const taskRepo = makeTaskRepo([{ tags: ['grant-recommendation', 'contacts', `grant-rec:${filedRecId}`] }]);

    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(svc, taskRepo));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ created: 0, tasks_filed: 1, task_failures: 0 });
    expect(svc.createGrantRecommendation).not.toHaveBeenCalled();
    expect(taskRepo.createTask).toHaveBeenCalledTimes(1);
    expect(taskRepo.createTask.mock.calls[0]![0]).toMatchObject({
      title: 'Grant Omar Haddad scheduling access?',
      tags: ['grant-recommendation', 'contacts', `grant-rec:${orphanRecId}`],
    });
  });

  it('counts a failed filing and keeps filing the rest', async () => {
    const other = makeContact('44444444-4444-4444-8444-444444444444', 'Omar Haddad');
    const svc = serviceCreating([makeRec('66666666-6666-4666-8666-666666666666', other.id)], [contact, other]);
    const taskRepo = makeTaskRepo();
    taskRepo.createTask.mockRejectedValueOnce(new Error('insert failed')).mockResolvedValueOnce({});

    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(svc, taskRepo));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ created: 1, tasks_filed: 1, task_failures: 1 });
    expect(taskRepo.createTask).toHaveBeenCalledTimes(2);
  });

  it('fails before creating any recommendation when taskRepo is missing', async () => {
    const svc = serviceCreating();
    const result = await new ScanGrantRecommendationsHandler().execute(makeCtx(svc, null));

    expect(result.success).toBe(false);
    expect(svc.createGrantRecommendation).not.toHaveBeenCalled();
  });
});
