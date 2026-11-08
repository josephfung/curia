// Through-gateway runs (#2312): approvals, outreach and what was sent stay with the run that
// made them when runs overlap, a held send's approval is the one a follow-up "approve" resolves
// (Review Focus 4), and the run's rows are read before, and removed with, the run.
import { describe, expect, it, vi } from 'vitest';
import type { ActionLogRepo } from '../../../src/autonomy/action-log-repo.js';
import type { ActionLogRow, ResolveResult } from '../../../src/autonomy/action-log-types.js';
import { parseSenderVerified } from '../../../src/channels/email/message-converter.js';
import type { TaskOutreachRepo, TaskOutreachRow } from '../../../src/dispatch/task-outreach.js';
import { markdownToHtml } from '../../../src/format/markdown-to-html.js';
import { buildReplyQuote } from '../../../src/skills/_shared/reply-quote.js';
import type { DetectedPii } from '../../../src/dispatch/pii-redactor.js';
import { splitReplyQuote } from '../../../src/skills/principal-send/own-text.js';
import { quoteItemsToReview, threadMessageProof } from '../../../src/skills/principal-send/quote-proof.js';
import type { TestModeStack } from '../../../src/startup/test-mode-stack.js';
import { createCaseContext, newAttempt, type CaseAttempt } from '../../shared/case-scope.js';
import { inboundNylasMessage } from '../../scenarios/harness.js';
import {
  cleanupRun,
  mailboxDraftsOf,
  mirrorPrincipalDraft,
  readGatewayOutcome,
  scopedActionLog,
  scopedOutreachRepo,
  SeedScope,
  SCENARIO_TASK_CREATOR,
  type SeededRun,
} from '../../scenarios/seed.js';
import type { ScenarioCase } from '../../scenarios/types.js';

type RunState = CaseAttempt & { scope: SeedScope };

function run(label: string, conversation: string): RunState {
  const scope = new SeedScope();
  scope.rootConversation = conversation;
  return { ...newAttempt(label), scope };
}

function row(overrides: Partial<ActionLogRow>): ActionLogRow {
  return {
    id: 1, taskId: 'task-event', conversationId: null, toolName: 'email-send', actionRisk: 'medium',
    outcome: 'pending_approval', shortRef: 'aaaa1111', approvalNumber: 1, description: 'Send Pat the quote',
    payload: {}, createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), notificationSentAt: new Date(),
    ...overrides,
  } as ActionLogRow;
}

describe('scopedActionLog: a follow-up approve acts on the run\'s own held send', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const mine = row({ id: 1, conversationId: 'scenario-a', shortRef: 'aaaa1111', approvalNumber: 3 });
  const other = row({ id: 2, conversationId: 'scenario-b', shortRef: 'bbbb2222', approvalNumber: 4 });
  const real = {
    findAllPending: vi.fn(async () => [mine, other]),
    resolvePending: vi.fn(async (ref?: string): Promise<ResolveResult> => {
      if (ref === 'aaaa1111' || ref === '3') return { found: true, row: mine };
      if (ref === 'bbbb2222' || ref === '4') return { found: true, row: other };
      return { found: false, reason: 'ambiguous', error: 'Multiple pending requests', pending: [mine, other] };
    }),
    insert: vi.fn(async () => 7),
  } as unknown as ActionLogRepo;
  const view = scopedActionLog(real, currentScope);

  it('resolves "approve" with no reference to the run\'s sole pending approval, not the table\'s', async () => {
    const result = await context.run(run('A', 'scenario-a'), () => view.resolvePending());
    expect(result).toEqual({ found: true, row: mine });
    // Through production's own lookup on that row, so its expiry checks still apply.
    expect(real.resolvePending).toHaveBeenLastCalledWith('aaaa1111');
  });

  it('resolves the run\'s approval by its number, and reads another run\'s as not found', async () => {
    expect(await context.run(run('A', 'scenario-a'), () => view.resolvePending('3'))).toEqual({ found: true, row: mine });
    const foreign = await context.run(run('A', 'scenario-a'), () => view.resolvePending('4'));
    expect(foreign.found).toBe(false);
    if (!foreign.found) expect(foreign.reason).toBe('not_found');
  });

  it('counts a specialist\'s conversation as the run\'s', async () => {
    const state = run('B', 'scenario-x');
    state.scope.specialistConversations.add('scenario-b');
    expect(await context.run(state, () => view.findAllPending())).toEqual([other]);
  });

  it('finds nothing outside every run, and writes as production does', async () => {
    expect(await view.findAllPending()).toEqual([]);
    expect((await view.resolvePending()).found).toBe(false);
    expect(await view.insert({ toolName: 'email-send', actionRisk: 'medium', outcome: 'pending_approval' } as never)).toBe(7);
  });
});

describe('scopedOutreachRepo: replies link only to the run\'s outreach', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const outreach = (id: string, extra: Partial<TaskOutreachRow>): TaskOutreachRow =>
    ({ id, taskId: null, conversationId: null, confirmed: true, domains: [], addresses: [], ...extra }) as TaskOutreachRow;
  const rows = [
    outreach('seeded', { taskId: null, conversationId: 'scenario-origin-outreach-x' }),
    outreach('by-task', { taskId: 'task-a' }),
    outreach('by-send', { conversationId: 'scenario-a' }),
    outreach('real', { conversationId: 'signal:+15555550199' }),
  ];
  const real = {
    findOpenByAddress: async () => rows,
    findOpenByContact: async () => rows,
    findOpenByDomain: async () => rows,
    findOpen: async () => rows,
  } as unknown as TaskOutreachRepo;
  const view = scopedOutreachRepo(real, currentScope);

  it('keeps the rows the run seeded, its tasks\' rows and its sends\' rows', async () => {
    const state = run('A', 'scenario-a');
    state.scope.seededOutreach.set('seeded', { domains: [], addresses: [] });
    state.scope.taskIds.add('task-a');
    const found = await context.run(state, () => view.findOpenByAddress('pat@vendor.example.test'));
    expect(found.map(r => r.id)).toEqual(['seeded', 'by-task', 'by-send']);
  });

  it('matches nothing for a run without outreach, or outside every run', async () => {
    expect(await context.run(run('B', 'scenario-b'), () => view.findOpenByDomain('vendor.example.test'))).toEqual([]);
    expect(await view.findOpen(10)).toEqual([]);
  });
});

/** A pool that answers each read by the table it names and records every statement. */
function fakeStack(answers: Record<string, unknown[]>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      const table = Object.keys(answers).find(t => sql.includes(`FROM ${t}`) && sql.trim().startsWith('SELECT'));
      return { rows: table ? answers[table] : [], rowCount: 0 };
    }),
  };
  const stack = {
    pool,
    principalIdentities: [{ channel: 'signal', channelIdentifier: '+15555550111' }],
    contactService: { deleteContact: vi.fn(async () => {}) },
  } as unknown as TestModeStack;
  return { stack, statements };
}

const scenario = {
  seed: { contacts: [{ key: 'pat', identifier: 'pat@vendor.example.test' }] },
} as unknown as ScenarioCase;

function seededRun(extra: Partial<SeededRun> = {}): SeededRun {
  return {
    refs: new Map(), contacts: [], entryIds: [], threads: new Map(), verificationIds: [], principalIdentityIds: [],
    taskIds: ['task-a'], outreachIds: ['seeded'], ...extra,
  };
}

describe('readGatewayOutcome', () => {
  it('names recipients as the case does, joins each approval to what it shows, and drops untouched seeded outreach', async () => {
    const { stack } = fakeStack({
      autonomy_action_log: [{ short_ref: 'aaaa1111', approval_number: 3, tool_name: 'email-send', outcome: 'approved', description: 'Send Pat the quote' }],
      task_outreach: [
        { id: 'seeded', domains: ['vendor.example.test'], addresses: [], confirmed: true, via: 'email' },
        { id: 'new', domains: ['vendor.example.test'], addresses: ['pat@vendor.example.test'], confirmed: true, via: 'email' },
      ],
      disclosure_decisions: [{ label: 'SIN', decision: 'yes' }],
    });
    const scope = new SeedScope();
    scope.rootConversation = 'scenario-a';
    scope.seededOutreach.set('seeded', { domains: ['vendor.example.test'], addresses: [] });
    scope.deliveries.push(
      { channel: 'email', kind: 'send', to: ['PAT@vendor.example.test'], cc: [], subject: 'Quote', body: 'Hi', id: 'm1' },
      { channel: 'signal', kind: 'send', to: ['+15555550111'], cc: [], body: 'Approval 3', id: 'm2' },
    );
    scope.approvalDisplays.set('aaaa1111', { preamble: 'Pat asked for your SIN. Share it?', payload: {}, extraLines: ['Reason: personal data'] });

    const outcome = await readGatewayOutcome(stack, scenario, seededRun(), scope);
    expect(outcome.deliveries.map(d => d.toNames)).toEqual([['pat'], ['principal']]);
    expect(outcome.holds).toEqual([{
      shortRef: 'aaaa1111', approvalNumber: 3, toolName: 'email-send', outcome: 'approved', description: 'Send Pat the quote',
      preamble: 'Pat asked for your SIN. Share it?', extraLines: ['Reason: personal data'],
    }]);
    expect(outcome.outreach).toEqual([{ domains: ['vendor.example.test'], addresses: ['pat@vendor.example.test'], confirmed: true, via: 'email', seeded: false }]);
    expect(outcome.decisions).toEqual([{ label: 'SIN', decision: 'yes' }]);
  });
});

describe('cleanupRun: what through-gateway sends wrote', () => {
  it('removes the run\'s approvals, decisions and outreach by its conversations, then its seeded rows', async () => {
    const { stack, statements } = fakeStack({});
    const scope = new SeedScope();
    scope.specialistConversations.add('scenario-delegate-1');
    await cleanupRun(stack, seededRun(), scope, 'scenario-a');
    const deletes = statements.filter(s => s.sql.trim().startsWith('DELETE'));
    const on = (table: string) => deletes.filter(s => s.sql.includes(`DELETE FROM ${table} `));
    // Each conversation is cleaned whole (cleanupScenarioConversation), the specialist's included.
    for (const table of ['autonomy_action_log', 'disclosure_decisions']) {
      expect(on(table).map(s => s.params[0]), table).toEqual(['scenario-a', 'scenario-delegate-1']);
    }
    expect(on('task_outreach').map(s => s.params[0])).toEqual(['scenario-a', 'scenario-delegate-1', ['seeded']]);
    // Only rows the suite made: the creator marker guards a task delete.
    expect(on('tasks')).toEqual([{ sql: expect.stringContaining('created_by = $2'), params: [['task-a'], SCENARIO_TASK_CREATOR] }]);
  });
});

describe('inboundNylasMessage', () => {
  it('passes authentication only when the case says the sender was verified', () => {
    const verified = inboundNylasMessage('scenario-msg-1', 'pat@vendor.example.test', { content: 'Hi', email: { senderVerified: true } }, undefined);
    expect(parseSenderVerified(verified.headers)).toBe(true);
    expect(verified.to).toEqual([{ email: 'curia@example.test' }]);
    const unverified = inboundNylasMessage('scenario-msg-2', 'pat@vendor.example.test', { content: 'Hi' }, { to: ['curia@example.test'], cc: ['lee@vendor.example.test'] });
    expect(parseSenderVerified(unverified.headers)).toBe(false);
    expect(unverified.cc).toEqual([{ email: 'lee@vendor.example.test' }]);
  });
});

describe('seedRun: the seeds a through-gateway case needs', () => {
  it('grants trusted after creation, writes a standing task with its originator and an outreach row, and scopes both', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.includes('INSERT INTO kg_nodes')) return { rows: [{ id: 'node-1' }] };
        if (sql.includes('INSERT INTO tasks')) return { rows: [{ id: 'task-1' }] };
        if (sql.includes('INSERT INTO task_outreach')) return { rows: [{ id: 'outreach-1', domains: ['vendor.example.test'], addresses: [] }] };
        return { rows: [] };
      }),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn(async () => null),
      createContact: vi.fn(async () => ({ id: 'contact-1' })),
      linkIdentity: vi.fn(async () => {}),
      setTier: vi.fn(async () => ({})),
    };
    const stack = { pool, contactService, principalContactId: 'principal-1' } as unknown as TestModeStack;
    const scope = new SeedScope();
    const { seedRun } = await import('../../scenarios/seed.js');
    const c = {
      seed: {
        contacts: [{ key: 'pat', displayName: 'Pat Okafor', tier: 'trusted', channel: 'email', identifier: 'pat@vendor.example.test' }],
        outboundContext: [], bullpen: [], verifications: [], principalIdentities: [],
        tasks: [{ key: 'onboarding', title: 'Vendor forms', originator: 'principal', agent: 'coordinator' }],
        outreach: [{ key: 'forms', task: 'onboarding', via: 'email', domains: ['vendor.example.test'], addresses: [], contacts: ['pat'], summary: 'Sent forms', confirmed: true }],
      },
    } as unknown as ScenarioCase;

    const seeded = await seedRun(c, { stack, outboundContext: {} as never, scope });
    expect(contactService.createContact).toHaveBeenCalledWith(expect.objectContaining({ tier: 'known' }));
    expect(contactService.setTier).toHaveBeenCalledWith('contact-1', 'trusted');
    const task = statements.find(s => s.sql.includes('INSERT INTO tasks'))!;
    expect(task.params[4]).toBe(SCENARIO_TASK_CREATOR);
    expect(JSON.parse(task.params[5] as string)).toMatchObject({ contactId: 'principal-1', systemRole: 'principal', tier: 'principal', authenticated: true });
    const outreach = statements.find(s => s.sql.includes('INSERT INTO task_outreach'))!;
    expect(outreach.params[0]).toBe('task-1');
    expect(outreach.params[7]).toEqual(['contact-1']);
    expect(seeded.refs.get('task:onboarding')).toBe('task-1');
    expect(seeded.refs.get('outreach:forms')).toBe('outreach-1');
    expect([...scope.taskIds]).toEqual(['task-1']);
    expect([...scope.seededOutreach.keys()]).toEqual(['outreach-1']);
    // A stubbed compose names contacts by ID; the mirror resolves them through these (#2474 PR 2).
    expect([...scope.contactAddresses]).toEqual([['contact-1', 'pat@vendor.example.test']]);
  });
});

describe('scopedActionLog: approval delivery reads and writes stay in the run', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const mine = row({ id: 1, conversationId: 'scenario-a', shortRef: 'aaaa1111', approvalNumber: 3 });
  const other = row({ id: 2, conversationId: 'scenario-b', shortRef: 'bbbb2222', approvalNumber: 4 });
  const byRef = new Map([[mine.shortRef!, mine], [other.shortRef!, other]]);
  const real = {
    findPendingByShortRef: vi.fn(async (ref: string) => byRef.get(ref) ?? null),
    findPendingByApprovalNumber: vi.fn(async (n: number) => [mine, other].find(r => r.approvalNumber === n) ?? null),
    claimNotification: vi.fn(async () => true),
    releaseNotification: vi.fn(async () => {}),
    bindDeliveryMessage: vi.fn(async () => true),
    insert: vi.fn(async () => 9),
  } as unknown as ActionLogRepo;
  const view = scopedActionLog(real, currentScope);

  it('reads a foreign short ref or number as not found, and never claims, releases or binds its row', async () => {
    await context.run(run('A', 'scenario-a'), async () => {
      expect(await view.findPendingByShortRef('bbbb2222')).toBeNull();
      expect(await view.findPendingByApprovalNumber(4)).toBeNull();
      expect(await view.claimNotification(2)).toBe(false);
      await view.releaseNotification(2);
      expect(await view.bindDeliveryMessage(2, 'signal', 'ts-1')).toBe(false);
    });
    expect(real.claimNotification).not.toHaveBeenCalled();
    expect(real.releaseNotification).not.toHaveBeenCalled();
    expect(real.bindDeliveryMessage).not.toHaveBeenCalled();
  });

  it('delivers the run\'s own approval: found by ref, then claimed and bound', async () => {
    await context.run(run('A', 'scenario-a'), async () => {
      expect(await view.findPendingByShortRef('aaaa1111')).toBe(mine);
      expect(await view.claimNotification(1)).toBe(true);
      expect(await view.bindDeliveryMessage(1, 'signal', 'ts-1')).toBe(true);
    });
    expect(real.claimNotification).toHaveBeenCalledWith(1);
  });

  it('counts a row the run inserts as its own', async () => {
    const state = run('A', 'scenario-a');
    await context.run(state, async () => {
      await view.insert({ taskId: 't', conversationId: 'scenario-a', toolName: 'email-send', actionRisk: 'medium', outcome: 'pending_approval' } as never);
      expect(await view.claimNotification(9)).toBe(true);
    });
    // Outside every run nothing is the caller's.
    expect(await view.claimNotification(9)).toBe(false);
  });
});

describe('an org-domain outreach link on a distinct .test name', () => {
  it('links a reply from vendorco.test to the run\'s outreach for vendorco.test, and not another organization\'s', async () => {
    const { OutreachMatcher } = await import('../../../src/dispatch/outreach-matcher.js');
    const context = createCaseContext<RunState>();
    const seeded = { id: 'o1', taskId: null, rootTaskId: null, conversationId: 'scenario-origin-outreach-x', directingEventId: null,
      originator: {}, via: 'email', orgName: 'VendorCo', domains: ['vendorco.test'], addresses: [], contactIds: [], givenContact: null,
      summary: 'Sent the forms', confirmed: true } as unknown as TaskOutreachRow;
    const real = {
      findOpenByAddress: async () => [],
      findOpenByContact: async () => [],
      findOpenByDomain: async (d: string) => (seeded.domains.includes(d) ? [seeded] : []),
      findOpen: async () => [],
      learnCounterparty: async () => {},
    } as unknown as TaskOutreachRepo;
    const matcher = new OutreachMatcher({
      repo: scopedOutreachRepo(real, () => context.current()?.scope),
      infraLlm: undefined,
      logger: createLoggerForTest(),
      nonOrgDomains: new Set(['example.test']),
      taskStatus: async () => null,
    });
    const state = run('A', 'scenario-a');
    state.scope.seededOutreach.set('o1', { domains: ['vendorco.test'], addresses: [] });
    const reply = (address: string) => context.run(state, () => matcher.match({
      senderAddress: address, senderAuthenticated: true, bodyStart: 'Here is the form back', autoGenerated: false,
    }));
    expect(await reply('pat@vendorco.test')).toMatchObject({ outreachId: 'o1', linkKind: 'org-domain', strength: 'strong' });
    expect(await reply('kim@othervendor.test')).toBeNull();
  });
});

function createLoggerForTest() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => createLoggerForTest() } as never;
}

describe('the run\'s band-review fail-open cap', () => {
  it('trips per run, and the run\'s gateway outcome says so', async () => {
    const { PerRunFailOpenLimiter } = await import('../../../src/startup/test-mode-sends.js');
    const context = createCaseContext<RunState>();
    const limiter = new PerRunFailOpenLimiter(() => context.current()?.scope.failOpen);
    const a = run('A', 'scenario-a');
    const b = run('B', 'scenario-b');
    await context.run(a, async () => {
      for (let i = 0; i < 5; i++) expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire()).toEqual({ allowed: false, justTripped: true });
    });
    // B's sends are reviewed as usual.
    await context.run(b, async () => {
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.isTripped()).toBe(false);
    });
    const { stack } = fakeStack({});
    expect((await readGatewayOutcome(stack, scenario, seededRun(), a.scope)).reviewerFailedOpen).toBe(true);
    expect((await readGatewayOutcome(stack, scenario, seededRun(), b.scope)).reviewerFailedOpen).toBe(false);
  });
});

describe('acceptsRelay', () => {
  it('relays only a through-gateway run\'s own conversations, and its notifications', async () => {
    const { acceptsRelay } = await import('../../scenarios/seed.js');
    const opted = run('A', 'email:scenario-a');
    opted.scope.throughGateway = true;
    opted.scope.followOnConversations.add('approval-delivery:aaaa1111');
    expect(acceptsRelay(opted.scope, 'email:scenario-a')).toBe(true);
    expect(acceptsRelay(opted.scope, 'approval-delivery:aaaa1111')).toBe(true);
    expect(acceptsRelay(opted.scope)).toBe(true);
    expect(acceptsRelay(opted.scope, 'email:scenario-b')).toBe(false);
    // A case without through_gateway, and work outside every run, relay nothing.
    const plain = run('B', 'email:scenario-b');
    expect(acceptsRelay(plain.scope, 'email:scenario-b')).toBe(false);
    expect(acceptsRelay(plain.scope)).toBe(false);
    expect(acceptsRelay(undefined, 'email:scenario-b')).toBe(false);
  });
});

// #2474: the principal's mailbox a through-gateway run sends from. Its drafts are the case's
// seeds plus every stubbed ceo-inbox draft write, so the real ceo-inbox-send-draft finds them.
describe('the run\'s principal mailbox (#2474)', () => {
  const CLOCK = new Date('2026-11-07T15:00:00.000Z');
  const seededCase = (byCuria: false | 'same_task' | 'earlier', extra: Record<string, unknown> = {}) => ({
    seed: {
      contacts: [], outboundContext: [], bullpen: [], verifications: [], principalIdentities: [], tasks: [], outreach: [],
      principalMailbox: {
        sendLevel: 'off',
        drafts: [{
          id: 'draft-30z-acme', thread: 'thr-30z-acme', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [],
          subject: 'Offsite', body: 'Venue: [venue TBD]', modified: '2026-11-07T09:00:00.000-05:00', byCuria,
        }],
        threads: [],
        ...extra,
      },
    },
  }) as unknown as ScenarioCase;
  const stack = {
    pool: { query: vi.fn(async () => ({ rows: [] })) },
    principalContactId: 'principal-1',
    principalIdentities: [
      { channel: 'signal', channelIdentifier: '+15555550100', verified: true },
      { channel: 'email', channelIdentifier: 'avery@example.test', verified: true },
    ],
  } as unknown as TestModeStack;
  const clocked = (): SeedScope => {
    const scope = new SeedScope();
    scope.clockNow = CLOCK;
    return scope;
  };

  it('seeds the drafts, their authorship and the send level', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase(false), { stack, outboundContext: {} as never, scope });
    expect(scope.sendLevel).toBe('off');
    expect(scope.principalDrafts.get('draft-30z-acme')).toMatchObject({
      id: 'draft-30z-acme', threadId: 'thr-30z-acme', subject: 'Offsite', body: 'Venue: [venue TBD]',
      to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], bcc: [], folders: ['DRAFT'],
      date: Date.parse('2026-11-07T14:00:00.000Z') / 1000,
    });
    expect([...scope.curiaDraftIds]).toEqual([]);
    expect([...scope.curiaTaskDraftIds]).toEqual([]);
    expect(mailboxDraftsOf(scope)).toEqual([{ id: 'draft-30z-acme', subject: 'Offsite', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], body: 'Venue: [venue TBD]' }]);
  });

  it('reads earlier as Curia\'s draft from another task, and same_task as one from this task (PR 2)', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const earlier = clocked();
    await seedRun(seededCase('earlier'), { stack, outboundContext: {} as never, scope: earlier });
    expect([...earlier.curiaDraftIds]).toEqual(['draft-30z-acme']);
    expect([...earlier.curiaTaskDraftIds]).toEqual([]);
    const sameTask = clocked();
    await seedRun(seededCase('same_task'), { stack, outboundContext: {} as never, scope: sameTask });
    expect([...sameTask.curiaDraftIds]).toEqual(['draft-30z-acme']);
    expect([...sameTask.curiaTaskDraftIds]).toEqual(['draft-30z-acme']);
  });

  it('dates a draft with no modified time by the run clock, not the wall clock', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    const c = seededCase('same_task');
    delete (c.seed.principalMailbox!.drafts[0] as { modified?: string }).modified;
    await seedRun(c, { stack, outboundContext: {} as never, scope });
    expect(scope.principalDrafts.get('draft-30z-acme')!.date).toBe(CLOCK.getTime() / 1000);
  });

  it('seeds each thread\'s messages with folders, Authentication-Results and List-Id as the case says', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase('same_task', {
      threads: [{
        id: 'thr-30z-acme',
        messages: [
          { id: 'msg-1', from: 'principal', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], subject: 'Offsite', body: 'Venue?', date: '2026-11-06T15:00:00.000Z' },
          { id: 'msg-2', from: { name: 'Jo Park', email: 'jo.park@acme.example.test' }, to: ['principal'], cc: [{ email: 'lee@acme.example.test' }], subject: 'Re: Offsite', body: 'Harbour Room?', date: '2026-11-07T13:00:00.000Z', senderVerified: true },
          { id: 'msg-3', from: { email: 'sam@other.test' }, to: ['principal'], cc: [], subject: 'Re: Offsite', body: 'Me too', date: '2026-11-07T14:00:00.000Z', senderVerified: false, listId: 'offsite.other.test' },
        ],
      }],
    }), { stack, outboundContext: {} as never, scope });
    const [m1, m2, m3] = scope.principalThreads.get('thr-30z-acme')!;
    expect(m1).toMatchObject({ id: 'msg-1', threadId: 'thr-30z-acme', from: [{ email: 'avery@example.test' }], folders: ['SENT'], date: Date.parse('2026-11-06T15:00:00.000Z') / 1000 });
    expect(m1!.headers ?? []).toEqual([]);
    expect(m2).toMatchObject({ from: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], to: [{ email: 'avery@example.test' }], cc: [{ email: 'lee@acme.example.test' }], folders: ['INBOX'] });
    expect(parseSenderVerified(m2!.headers)).toBe(true);
    expect(parseSenderVerified(m3!.headers)).toBe(false);
    expect(m3!.headers).toContainEqual({ name: 'List-Id', value: 'offsite.other.test' });
    expect(m2!.headers?.some(h => h.name === 'List-Id')).toBe(false);
  });

  it('fails a thread that names the principal when the stack has no principal email', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const bare = { ...stack, principalIdentities: [] } as unknown as TestModeStack;
    const c = seededCase(false, { threads: [{ id: 't', messages: [{ id: 'm', from: 'principal', to: [{ email: 'jo@acme.example.test' }], cc: [], subject: 'S', body: 'B', date: '2026-11-07T13:00:00.000Z' }] }] });
    await expect(seedRun(c, { stack: bare, outboundContext: {} as never, scope: clocked() })).rejects.toThrow(/no verified email/);
  });

  it('adds a draft Curia wrote, dated by the run clock, and marks it Curia\'s in this task', () => {
    const scope = clocked();
    mirrorPrincipalDraft(scope, { id: 'draft-0002', subject: 'Agenda', to: [{ email: 'sam@older.test' }], cc: [], body: 'Here is the agenda.' }, true);
    expect(scope.principalDrafts.get('draft-0002')).toMatchObject({ subject: 'Agenda', to: [{ email: 'sam@older.test' }], body: 'Here is the agenda.', folders: ['DRAFT'], date: CLOCK.getTime() / 1000 });
    expect(scope.curiaDraftIds.has('draft-0002')).toBe(true);
    expect(scope.curiaTaskDraftIds.has('draft-0002')).toBe(true);
  });

  it('puts a stubbed reply on the thread of the seeded message it answers', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase(false, {
      threads: [{ id: 'thr-other', messages: [{ id: 'msg-9', from: { email: 'jo.park@acme.example.test' }, to: ['principal'], cc: [], subject: 'Q', body: 'Q?', date: '2026-11-07T13:00:00.000Z' }] }],
    }), { stack, outboundContext: {} as never, scope });
    mirrorPrincipalDraft(scope, { id: 'draft-r1', subject: 'Re: Q', to: [{ email: 'jo.park@acme.example.test' }], cc: [], body: 'A.', replyTo: 'msg-9' }, true);
    expect(scope.principalDrafts.get('draft-r1')).toMatchObject({ threadId: 'thr-other' });
    expect(scope.errors).toEqual([]);
    // A reply to a message the case did not seed is a case error (a typo in the stub's id).
    mirrorPrincipalDraft(scope, { id: 'draft-r2', subject: 'Re: ?', to: [{ email: 'jo.park@acme.example.test' }], cc: [], body: 'A.', replyTo: 'msg-unknown' }, true);
    expect(scope.errors).toEqual([expect.stringMatching(/draft-r2.*msg-unknown/)]);
  });

  it('keeps a known thread when a later write repeats an unseeded reply id', () => {
    const scope = clocked();
    mirrorPrincipalDraft(scope, { id: 'draft-30z-acme', subject: 'A', to: [], cc: [], body: 'B' }, true);
    scope.principalDrafts.get('draft-30z-acme')!.threadId = 'thr-30z-acme';
    mirrorPrincipalDraft(scope, { id: 'draft-30z-acme', subject: 'A', to: [], cc: [], body: 'C', replyTo: 'msg-unknown' }, false, true);
    expect(scope.principalDrafts.get('draft-30z-acme')).toMatchObject({ threadId: 'thr-30z-acme' });
    expect(scope.errors).toEqual([]);
  });

  it('resolves the principal\'s own contact UUID to their verified email', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase(false), { stack, outboundContext: {} as never, scope });
    mirrorPrincipalDraft(scope, { id: 'draft-c3', subject: 'Hi', to: [], cc: [], body: 'B', contactIds: { to: ['principal-1'], cc: [] } }, true);
    expect(scope.principalDrafts.get('draft-c3')).toMatchObject({ to: [{ email: 'avery@example.test' }] });
    expect(scope.errors).toEqual([]);
  });

  it('resolves a compose\'s contact IDs through the seeded contacts, and fails the run on one it cannot', () => {
    const scope = clocked();
    scope.principalAddress = 'avery@example.test';
    scope.contactAddresses.set('contact-pat', 'pat@vendor.example.test');
    mirrorPrincipalDraft(scope, {
      id: 'draft-c1', subject: 'Hi', to: [{ email: 'lee@vendor.example.test' }], cc: [], body: 'B',
      contactIds: { to: ['contact-pat#work'], cc: ['principal'] },
    }, true);
    expect(scope.principalDrafts.get('draft-c1')).toMatchObject({
      to: [{ email: 'lee@vendor.example.test' }, { email: 'pat@vendor.example.test' }], cc: [{ email: 'avery@example.test' }],
    });
    expect(scope.errors).toEqual([]);
    mirrorPrincipalDraft(scope, { id: 'draft-c2', subject: 'Hi', to: [], cc: [], body: 'B', contactIds: { to: ['contact-nobody'], cc: [] } }, true);
    expect(scope.errors).toEqual([expect.stringContaining('contact-nobody')]);
  });

  it('applies an edit to the principal\'s draft without making it Curia\'s', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase(false), { stack, outboundContext: {} as never, scope });
    mirrorPrincipalDraft(scope, { id: 'draft-30z-acme', subject: 'Offsite', to: [{ name: 'Jo Park', email: 'jo.park@acme.example.test' }], cc: [], body: 'Venue: the Harbour Room' }, false, true);
    expect(scope.principalDrafts.get('draft-30z-acme')).toMatchObject({ threadId: 'thr-30z-acme', body: 'Venue: the Harbour Room' });
    expect(scope.curiaDraftIds.has('draft-30z-acme')).toBe(false);
    expect(scope.curiaTaskDraftIds.has('draft-30z-acme')).toBe(false);
    // ...but marks it edited, so the send reviews it as curia-edited (final review S1).
    expect(scope.curiaEditedDraftIds.has('draft-30z-acme')).toBe(true);
  });

  it('does not mark a draft-reply that returned an existing draft as edited', () => {
    const scope = clocked();
    mirrorPrincipalDraft(scope, { id: 'draft-0003', subject: 'A', to: [], cc: [], body: 'B' }, false);
    expect(scope.curiaEditedDraftIds.size).toBe(0);
    expect(scope.curiaTaskDraftIds.size).toBe(0);
    // No seeded draft has that id: the stub claims a draft the mailbox never held.
    expect(scope.principalDrafts.has('draft-0003')).toBe(false);
    expect(scope.errors).toEqual([expect.stringMatching(/already_exists.*draft-0003/)]);
  });

  it('leaves a seeded draft\'s body, recipients and date as they were on an already_exists reply', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    await seedRun(seededCase(false), { stack, outboundContext: {} as never, scope });
    const before = { ...scope.principalDrafts.get('draft-30z-acme')! };
    mirrorPrincipalDraft(scope, { id: 'draft-30z-acme', subject: 'Re: X', to: [{ email: 'other@acme.example.test' }], cc: [], body: 'Curia wrote this.', replyTo: 'msg-unknown' }, false);
    expect(scope.principalDrafts.get('draft-30z-acme')).toEqual(before);
    expect(scope.curiaTaskDraftIds.has('draft-30z-acme')).toBe(false);
    expect(scope.errors).toEqual([]);
  });

  it('gives a new reply the quote the real draft-reply appends, so the review meets it', async () => {
    const { seedRun } = await import('../../scenarios/seed.js');
    const scope = clocked();
    scope.clockTimezone = 'America/Toronto';
    await seedRun(seededCase(false, {
      threads: [{ id: 'thr-q', messages: [{ id: 'msg-q', from: { name: 'Jo Park', email: 'jo.park@acme.example.test' }, to: ['principal'], cc: [], subject: 'Deck', body: "I'll bring the deck.\n\nJo Park\n+1 416 555 0142", date: '2026-11-07T13:00:00.000Z', senderVerified: true }] }],
    }), { stack, outboundContext: {} as never, scope });
    mirrorPrincipalDraft(scope, { id: 'draft-q', subject: 'Re: Deck', to: [{ email: 'jo.park@acme.example.test' }], cc: [], body: 'Thanks, Jo.', replyTo: 'msg-q' }, true);
    const original = scope.principalThreads.get('thr-q')![0]!;
    const stored = scope.principalDrafts.get('draft-q')!;
    expect(stored.body).toBe(markdownToHtml('Thanks, Jo.', { wrap: true }) + buildReplyQuote(original, 'America/Toronto', { format: 'html' }));
    expect(stored.body).toContain('<blockquote');
    expect(stored.body).toContain('+1 416 555 0142');
    // The gateway's own helpers find the quote and prove the sender already had the phone.
    const split = splitReplyQuote(stored.body);
    expect(split.quote).toContain('+1 416 555 0142');
    const phone = { label: 'phone_us', start: 0, end: 0, matched: '+1 416 555 0142' } as DetectedPii;
    expect(quoteItemsToReview([phone], split.quote, [threadMessageProof(original)], ['jo.park@acme.example.test'])).toEqual([]);
    // An edit that changes only recipients keeps the quote; one that rewrites the text drops it,
    // as the real edit replaces the whole body.
    mirrorPrincipalDraft(scope, { id: 'draft-q', subject: 'Re: Deck', to: [{ email: 'jo.park@acme.example.test' }, { email: 'lee@acme.example.test' }], cc: [], body: 'Thanks, Jo.', replyTo: 'msg-q' }, false, true);
    expect(scope.principalDrafts.get('draft-q')!.body).toBe(stored.body);
    mirrorPrincipalDraft(scope, { id: 'draft-q', subject: 'Re: Deck', to: [{ email: 'jo.park@acme.example.test' }], cc: [], body: 'Thanks!', replyTo: 'msg-q' }, false, true);
    expect(scope.principalDrafts.get('draft-q')!.body).toBe('Thanks!');
  });

  it('refuses to mirror without the run clock', () => {
    expect(() => mirrorPrincipalDraft(new SeedScope(), { id: 'd', subject: 'A', to: [], cc: [], body: 'B' }, true)).toThrow(/run clock/);
  });

  it('reads the run\'s principal-mailbox ledger into its gateway outcome', async () => {
    const { stack: fake } = fakeStack({});
    const scope = new SeedScope();
    scope.rootConversation = 'scenario-a';
    scope.principalSends.push({ draftId: 'd1', threadId: 't1', recipients: ['jo@acme.example.test'], mode: 'autonomous', at: '2026-11-07T15:00:00.000Z', outcome: 'held', reason: 'Not on the thread.' });
    scope.mailboxDigests.push('Left as a draft in your mailbox: Re: Q to Jo. Not on the thread.');
    const outcome = await readGatewayOutcome(fake, scenario, seededRun(), scope);
    expect(outcome.principalSends).toEqual([expect.objectContaining({ draftId: 'd1', outcome: 'held', reason: 'Not on the thread.' })]);
    expect(outcome.mailboxDigests).toEqual(['Left as a draft in your mailbox: Re: Q to Jo. Not on the thread.']);
  });

  it('is cleared with the run', () => {
    const scope = clocked();
    mirrorPrincipalDraft(scope, { id: 'draft-0002', subject: 'A', to: [], cc: [], body: 'B' }, true);
    mirrorPrincipalDraft(scope, { id: 'draft-0002', subject: 'A', to: [], cc: [], body: 'C' }, false, true);
    scope.sendLevel = 'all';
    scope.principalThreads.set('t', []);
    scope.principalSends.push({ draftId: 'd', threadId: 't', recipients: [], mode: 'autonomous', at: '', outcome: 'held' });
    scope.contactAddresses.set('c', 'a@b.test');
    scope.principalAddress = 'avery@example.test';
    scope.principalContactId = 'principal-1';
    scope.mailboxDigests.push('Left as a draft in your mailbox: x');
    scope.clear();
    expect(scope.principalContactId).toBeUndefined();
    expect(scope.mailboxDigests).toEqual([]);
    expect(scope.principalDrafts.size).toBe(0);
    expect(scope.curiaDraftIds.size).toBe(0);
    expect(scope.curiaTaskDraftIds.size).toBe(0);
    expect(scope.curiaEditedDraftIds.size).toBe(0);
    expect(scope.principalThreads.size).toBe(0);
    expect(scope.principalSends).toEqual([]);
    expect(scope.contactAddresses.size).toBe(0);
    expect(scope.principalAddress).toBeUndefined();
    expect(scope.clockNow).toBeUndefined();
    expect(scope.sendLevel).toBeUndefined();
  });
});
