// Seeded state stays with the run that seeded it when runs overlap (#1980).
import { describe, expect, it, vi } from 'vitest';
import type { BullpenService } from '../../../src/memory/bullpen.js';
import type { OutboundContextRow, OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import { createCaseContext, newAttempt, type CaseAttempt } from '../../shared/case-scope.js';
import type { VerificationRuntime } from '../../../src/verification/index.js';
import type { Verification } from '../../../src/verification/types.js';
import {
  scopedBrowserSessionAlive,
  scopedBullpen,
  scopedOutboundContext,
  scopedPinnedContextReader,
  scopedPrincipalBacklog,
  scopedVerification,
  SCENARIO_IDENTITY_LABEL,
  removeSeededPrincipalIdentities,
  SeedScope,
  seedConflictKeys,
  fixtureSignalConversations,
  seedPrincipalIdentity,
  createOutcomeGate,
} from '../../scenarios/seed.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { ScenarioCase } from '../../scenarios/types.js';

type RunState = CaseAttempt & { scope: SeedScope };

function run(label: string, threadIds: string[], entryIds: string[] = [], verificationIds: string[] = []): RunState {
  const scope = new SeedScope();
  for (const id of threadIds) scope.threadIds.add(id);
  for (const id of entryIds) scope.entryIds.add(id);
  for (const id of verificationIds) scope.verificationIds.add(id);
  return { ...newAttempt(label), scope };
}

describe('scoped views with overlapping runs', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;

  it('show each run only the bullpen threads it seeded', async () => {
    const real = {
      getPendingThreadsForAgent: async () => ['t-a', 't-b', 't-real'].map(threadId => ({ threadId })),
    } as unknown as BullpenService;
    const view = scopedBullpen(real, currentScope);
    const pending = (state: RunState) => context.run(state, async () =>
      (await view.getPendingThreadsForAgent('coordinator', 60)).map(t => t.threadId));

    const [a, b] = await Promise.all([pending(run('A', ['t-a'])), pending(run('B', ['t-b']))]);
    expect(a).toEqual(['t-a']);
    expect(b).toEqual(['t-b']);
    // Outside every run nothing is shown — the dev instance's own threads least of all.
    expect(await view.getPendingThreadsForAgent('coordinator', 60)).toEqual([]);
  });

  it('show each run only the outbound-context entries it seeded', async () => {
    const real = {
      getEntry: async (id: string) => ({ id, createdAt: new Date() }) as unknown as OutboundContextRow,
    } as unknown as OutboundContextService;
    const view = scopedOutboundContext(real, currentScope);
    const active = (state: RunState) => context.run(state, async () => (await view.getActive()).map(r => r.id));
    expect(await active(run('A', [], ['e-a']))).toEqual(['e-a']);
    expect(await view.getActive()).toEqual([]);
  });

  it('match recipients, record replies and list wake replies over the run\'s own entries only (#2261)', async () => {
    const XIAOPU = '1d833dd7-5c5f-4adc-b311-c8347b49a18e';
    const rows: Record<string, OutboundContextRow> = {
      'e-a': { id: 'e-a', agentId: 'coordinator', createdAt: new Date(), recipientContactIds: [XIAOPU], recipientMessages: [{ at: new Date(), from: 'X', preview: 'p' }] } as unknown as OutboundContextRow,
      'e-real': { id: 'e-real', agentId: 'coordinator', createdAt: new Date(), recipientContactIds: [XIAOPU], recipientMessages: [{ at: new Date(), from: 'X', preview: 'p' }] } as unknown as OutboundContextRow,
    };
    const recorded: string[][] = [];
    const real = {
      getEntry: async (id: string) => rows[id] ?? null,
      recordReply: async (ids: string[]) => { recorded.push([...ids]); },
      getActiveForRecipient: async () => { throw new Error('the real query scans every instance\'s entries'); },
      getActiveWithReplies: async () => { throw new Error('the real query scans every instance\'s entries'); },
    } as unknown as OutboundContextService;
    const view = scopedOutboundContext(real, currentScope);

    await context.run(run('A', [], ['e-a']), async () => {
      expect((await view.getActiveForRecipient(XIAOPU)).map(r => r.id)).toEqual(['e-a']);
      expect(await view.getActiveForRecipient('6e99314b-f9b5-4515-bafb-1a52d45b706b')).toEqual([]);
      expect((await view.getActiveWithReplies('coordinator')).map(r => r.id)).toEqual(['e-a']);
      expect(await view.getActiveWithReplies('ceo-inbox')).toEqual([]);
      // Scoped to one contact, as production scopes a wake an outside contact started.
      expect((await view.getActiveWithReplies('coordinator', { recipientContactId: XIAOPU })).map(r => r.id)).toEqual(['e-a']);
      expect(await view.getActiveWithReplies('coordinator', { recipientContactId: '6e99314b-f9b5-4515-bafb-1a52d45b706b' })).toEqual([]);
      await view.recordReply(['e-a', 'e-real'], { from: 'X', contactId: XIAOPU, content: 'c' });
    });
    expect(recorded).toEqual([['e-a']]);
    expect(await view.getActiveForRecipient(XIAOPU)).toEqual([]);
  });

  it('record a failed recipient or wake read on the run, so it fails instead of passing without the block (#2261)', async () => {
    const real = {
      getEntry: async () => { throw new Error('db down'); },
    } as unknown as OutboundContextService;
    const view = scopedOutboundContext(real, currentScope);
    const state = run('A', [], ['e-a']);

    await context.run(state, async () => {
      await expect(view.getActiveForRecipient('1d833dd7-5c5f-4adc-b311-c8347b49a18e')).rejects.toThrow('db down');
      await expect(view.getActiveWithReplies('coordinator')).rejects.toThrow('db down');
    });
    expect(state.scope.errors).toEqual([
      'outbound-context read failed: db down',
      'outbound-context read failed: db down',
    ]);
  });

  it('give each run only its own backlog counts (prompt trim PR 7)', async () => {
    const view = scopedPrincipalBacklog(currentScope);
    const withBacklog = run('A', []);
    withBacklog.scope.backlog = { decayWarnings: 0, pendingApprovals: 2, principalTasks: 0 };
    const none = { decayWarnings: 0, pendingApprovals: 0, principalTasks: 0 };
    const [a, b] = await Promise.all([
      context.run(withBacklog, () => view.counts()),
      context.run(run('B', []), () => view.counts()),
    ]);
    expect(a).toEqual({ decayWarnings: 0, pendingApprovals: 2, principalTasks: 0 });
    expect(b).toEqual(none);
    expect(await view.counts()).toEqual(none);
  });

  it('serve each run only its own pinned documents and settings, never the database\'s (#2339)', async () => {
    const real = {
      warnChars: 123,
      readDoc: vi.fn(async () => ({ status: 'live' as const, version: 9, content: 'the database copy' })),
      readConfig: vi.fn(async () => 'the database value'),
    };
    const view = scopedPinnedContextReader(real, currentScope);
    const withRules = run('A', []);
    withRules.scope.pinned = {
      docs: { '/shared/inbox/rules.md': '## Board mail' },
      configs: { 'ceo_inbox/decision_tagging': '{"enabled": true}' },
      unavailable: ['/shared/calendar/rules.md', 'debrief/config'],
    };
    const [a, b] = await Promise.all([
      context.run(withRules, async () => ({
        inbox: await view.readDoc('/shared/inbox/rules.md'),
        tagging: await view.readConfig('ceo_inbox', 'decision_tagging'),
        unseeded: await view.readConfig('ceo_inbox', 'other'),
      })),
      context.run(run('B', []), async () => ({
        inbox: await view.readDoc('/shared/inbox/rules.md'),
        tagging: await view.readConfig('ceo_inbox', 'decision_tagging'),
      })),
    ]);
    expect(a).toEqual({
      inbox: { status: 'live', version: 1, content: '## Board mail' },
      tagging: '{"enabled": true}',
      unseeded: null,
    });
    expect(b).toEqual({ inbox: null, tagging: null });
    await context.run(withRules, async () => {
      await expect(view.readDoc('/shared/calendar/rules.md')).rejects.toThrow(/fails/);
      await expect(view.readConfig('debrief', 'config')).rejects.toThrow(/fails/);
    });
    expect(await view.readDoc('/shared/inbox/rules.md')).toBeNull();
    expect(view.warnChars).toBe(123);
    expect(real.readDoc).not.toHaveBeenCalled();
    expect(real.readConfig).not.toHaveBeenCalled();
  });
});

describe('scopedOutboundContext: the ExecutionLayer\'s view (#2027)', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const row = (id: string, subject?: string) =>
    ({ id, createdAt: new Date(), metadata: subject ? { subject } : null }) as unknown as OutboundContextRow;

  function fakeService() {
    const active = new Map<string, OutboundContextRow>([['e-a', row('e-a', 'Offsite')], ['e-real', row('e-real', 'Offsite')]]);
    const released: string[] = [];
    const real = {
      getEntry: async (id: string) => active.get(id) ?? null,
      register: async () => { active.set('e-new', row('e-new')); return 'e-new'; },
      release: async (id: string) => { released.push(id); active.delete(id); },
      releaseEntry: async (id: string) => { released.push(id); active.delete(id); },
      markExchangeOpen: async () => true,
      releaseUnlessKeptOpen: async (id: string) => { released.push(id); active.delete(id); return 'released' as const; },
      clearBySubjects: async () => { throw new Error('the real clearBySubjects scans every instance\'s entries'); },
    } as unknown as OutboundContextService;
    return { view: scopedOutboundContext(real, currentScope), released };
  }

  it('acts only on the run\'s own entries; any other id reads as no active entry', async () => {
    const { view, released } = fakeService();
    const state = run('A', [], ['e-a']);
    await context.run(state, async () => {
      expect(await view.getEntry('e-real')).toBeNull();
      expect(await view.markExchangeOpen('e-real', { agentId: 'x', taskEventId: 't' })).toBe(false);
      expect(await view.releaseUnlessKeptOpen('e-real', 't')).toBe('not_active');
      await view.release('e-real');
      await view.releaseEntry('e-real');
      expect(released).toEqual([]);

      expect(await view.markExchangeOpen('e-a', { agentId: 'x', taskEventId: 't' })).toBe(true);
      expect(await view.releaseUnlessKeptOpen('e-a', 't')).toBe('released');
      expect(released).toEqual(['e-a']);
    });
  });

  it('adds an entry an agent registers to the run, and refuses one outside every run', async () => {
    const { view } = fakeService();
    const state = run('A', [], []);
    const entry = { conversationId: 'scenario-delegate-x', channelId: 'signal', agentId: 'ceo-inbox', content: 'Draft ready?' };
    await context.run(state, async () => {
      expect(await view.register(entry)).toBe('e-new');
    });
    expect(state.scope.entryIds.has('e-new')).toBe(true);
    await expect(view.register(entry)).rejects.toThrow(/outside every run/);
  });

  it('clears by subject among the run\'s entries only', async () => {
    const { view, released } = fakeService();
    const result = await context.run(run('A', [], ['e-a']), () => view.clearBySubjects([' offsite ', 'OFFSITE', 'Budget', '']));
    expect(result).toEqual({ totalReleased: 1, perSubject: [{ subject: 'offsite', released: 1 }], unmatched: ['Budget'] });
    expect(released).toEqual(['e-a']);
  });

  it('refuses the table-wide cleanup', async () => {
    const { view } = fakeService();
    await expect(view.cleanupExpired()).rejects.toThrow(/every instance/);
  });
});

describe('scopedVerification (#2017)', () => {
  const context = createCaseContext<RunState>();
  const currentScope = () => context.current()?.scope;
  const row = (id: string, site: string, status: Verification['status'] = 'pending') =>
    ({ id, site, status, delivery: 'sms', browserSessionId: `s-${id}` }) as unknown as Verification;

  function fakeRuntime() {
    const rows = new Map([['v-a', row('v-a', 'a.ca')], ['v-real', row('v-real', 'real.ca')]]);
    const closed: string[] = [];
    const opened: string[] = [];
    let listed = 0;
    const real = {
      service: {
        config: { emailWaitSeconds: 180 },
        get: async (id: string) => rows.get(id) ?? null,
        liveForTask: async () => rows.get('v-real')!,
      },
      tracker: {},
      open: async (input: { site: string }) => {
        opened.push(input.site);
        const existing = [...rows.values()].find(r => r.site === input.site && r.status === 'pending');
        if (existing) return { verification: existing, reused: true };
        rows.set('v-new', row('v-new', input.site));
        return { verification: rows.get('v-new')!, reused: false };
      },
      listActive: async () => { listed++; return [...rows.values()]; },
      close: async (id: string) => { closed.push(id); return rows.get(id) ?? null; },
      askChannel: () => 'signal',
    } as unknown as VerificationRuntime;
    return { view: scopedVerification(real, currentScope), closed, opened, listed: () => listed };
  }
  const openInput = (site: string) =>
    ({ purpose: 'sign_in', kind: 'code', delivery: 'sms', site, pageDomain: site, browserSessionId: 's' }) as const;

  it('lists only the run\'s rows, through production\'s listActive, and nothing outside a run', async () => {
    const { view, listed } = fakeRuntime();
    const ids = await context.run(run('A', [], [], ['v-a']), async () => (await view.listActive()).map(v => v.id));
    expect(ids).toEqual(['v-a']);
    expect(listed()).toBe(1);
    expect(await view.listActive()).toEqual([]);
    expect(view.service.config.emailWaitSeconds).toBe(180);
    expect(view.askChannel()).toBe('signal');
  });

  it('reads and closes only the run\'s rows', async () => {
    const { view, closed } = fakeRuntime();
    await context.run(run('A', [], [], ['v-a']), async () => {
      expect(await view.service.get('v-real')).toBeNull();
      expect(await view.service.liveForTask('t-1')).toBeNull();
      expect(await view.close('v-real', 'satisfied')).toBeNull();
      expect(await view.close('v-a', 'satisfied')).toMatchObject({ id: 'v-a' });
    });
    expect(closed).toEqual(['v-a']);
    await expect(view.service.listActive()).rejects.toThrow(/through the runtime/);
  });

  it('adds an opened row to the run, and refuses another\'s pending row for the site', async () => {
    const { view } = fakeRuntime();
    const state = run('A', [], [], []);
    await context.run(state, async () => {
      expect((await view.open(openInput('new.ca'))).verification.id).toBe('v-new');
      await expect(view.open(openInput('real.ca'))).rejects.toThrow(/already has a pending verification outside this run/);
    });
    expect([...state.scope.verificationIds]).toEqual(['v-new']);
    await expect(view.open(openInput('x.ca'))).rejects.toThrow(/outside every run/);
  });

  it('refuses another\'s pending row for the site before production open touches it', async () => {
    // Production's reuse refreshes the row's session, page domain, delivery and expiry, so
    // refusing only after open() would already have rewritten another run's challenge.
    const { view, opened } = fakeRuntime();
    await context.run(run('A', [], [], ['v-a']), async () => {
      await expect(view.open(openInput('real.ca'))).rejects.toThrow(/already has a pending verification outside this run/);
      // Matched by registrable domain, so a URL or subdomain for the site is refused too.
      await expect(view.open(openInput('https://login.real.ca/mfa'))).rejects.toThrow(/outside this run/);
      // The run's own pending row is reused through production as before.
      expect((await view.open(openInput('a.ca'))).reused).toBe(true);
    });
    expect(opened).toEqual(['a.ca']);
  });

  it('reads only the run\'s seeded sessions as alive', async () => {
    const alive = scopedBrowserSessionAlive(currentScope);
    const state = run('A', [], [], []);
    state.scope.aliveSessions.add('s-1');
    expect(await context.run(state, async () => [alive('s-1'), alive('s-2')])).toEqual([true, false]);
    expect(alive('s-1')).toBe(false);
  });
});

describe('seed.principal_identities (#2017)', () => {
  /** A pool over an in-memory identity table: just the three statements the seed issues. */
  function fakePool(rows: Array<{ id: string; contact_id: string; channel: string; status: string; label: string | null }>) {
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.startsWith('SELECT')) {
          const [contactId, channel] = params as [string, string];
          return { rows: rows.filter(r => r.contact_id === contactId && r.channel === channel && r.status === 'active') };
        }
        if (sql.startsWith('INSERT')) {
          const [contactId, channel, , label] = params as [string, string, string, string];
          const row = { id: `i-${rows.length}`, contact_id: contactId, channel, status: 'active', label };
          rows.push(row);
          return { rows: [{ id: row.id }] };
        }
        const [ids, label] = params as [string[], string];
        const before = rows.length;
        rows.splice(0, rows.length, ...rows.filter(r => !(ids.includes(r.id) && r.label === label)));
        return { rows: [], rowCount: before - rows.length };
      },
    } as unknown as DbPool;
    return pool;
  }

  it('adds a marked, verified identity only when the principal has none on the channel, and removes only that one', async () => {
    const rows = [{ id: 'real-email', contact_id: 'p', channel: 'email', status: 'active', label: 'primary' }];
    const pool = fakePool(rows);
    const added = await seedPrincipalIdentity(pool, 'p', { channel: 'signal', identifier: '+15555550142' });
    expect(added).toBe('i-1');
    expect(rows[1]).toMatchObject({ channel: 'signal', label: SCENARIO_IDENTITY_LABEL });
    // The principal's own identity on a channel is used as it is.
    expect(await seedPrincipalIdentity(pool, 'p', { channel: 'email', identifier: 'x@example.test' })).toBeNull();
    expect(rows).toHaveLength(2);

    await removeSeededPrincipalIdentities(pool, ['i-1', 'real-email']);
    expect(rows.map(r => r.id)).toEqual(['real-email']);
  });

  it('names the channel, so two cases adding an identity there never overlap', () => {
    const scenario = { seed: { contacts: [], verifications: [], principalIdentities: [{ channel: 'signal', identifier: '+1' }] } } as unknown as ScenarioCase;
    expect(seedConflictKeys(scenario)).toEqual(['principal-identity:signal']);
  });
});

describe('seedConflictKeys', () => {
  const scenario = (
    contacts: Array<{ displayName: string; identifier: string }>,
    verifications: Array<{ site: string; status: string }> = [],
  ) => ({
    seed: {
      contacts: contacts.map((c, i) => ({ key: `c${i}`, tier: 'known', channel: 'email', ...c })),
      outboundContext: [],
      bullpen: [],
      verifications,
      principalIdentities: [],
    },
  }) as unknown as ScenarioCase;

  it('names each seeded identity and display name, case-insensitively', () => {
    expect(seedConflictKeys(scenario([{ displayName: 'Priya Shah', identifier: 'Priya@Example.test' }])))
      .toEqual(['identity:email:priya@example.test', 'name:priya shah']);
    expect(seedConflictKeys(scenario([]))).toEqual([]);
  });

  it('names the site of each seeded verification, whatever its status, by registrable domain (#2017)', () => {
    // Seeding opens every row as pending first, so an expired one collides too.
    expect(seedConflictKeys(scenario([], [
      { site: 'Login.Example-Insurer.ca', status: 'pending' },
      { site: 'aircanada.com', status: 'expired' },
    ]))).toEqual(['verification-site:example-insurer.ca', 'verification-site:aircanada.com']);
  });
});

// A through-gateway Signal reply runs in `signal:<fixture number>`, which carries no prefix of
// the suite's own: the crash sweep finds it by the numbers the loaded cases seed (#2312 review).
describe('fixtureSignalConversations', () => {
  const contact = (channel: string, identifier: string) => ({ key: identifier, channel, identifier, displayName: identifier });
  const scenario = (throughGateway: boolean | undefined, contacts: ReturnType<typeof contact>[]) =>
    ({ throughGateway, seed: { contacts } }) as unknown as ScenarioCase;

  it('names each through-gateway case\'s Signal fixture number once', () => {
    expect(fixtureSignalConversations([
      scenario(true, [contact('signal', '+15195550123'), contact('email', 'priya@northbank.test')]),
      scenario(true, [contact('signal', '+15195550123'), contact('signal', '+15195550188')]),
    ])).toEqual(['signal:+15195550123', 'signal:+15195550188']);
  });

  it('leaves out cases that stub their sends: their turns never run in a signal: conversation', () => {
    expect(fixtureSignalConversations([
      scenario(undefined, [contact('signal', '+15195550999')]),
      scenario(false, [contact('signal', '+15195550998')]),
    ])).toEqual([]);
  });
});

describe('createOutcomeGate (#2312)', () => {
  it('holds a conversation\'s cleanup until its outcome is released, then cleans as before', async () => {
    const clean = vi.fn().mockResolvedValue(undefined);
    const gate = createOutcomeGate(clean);
    gate.hold('scenario-a');
    // A turn settling before the outcome read leaves its approvals and answers in place.
    await gate.clean('scenario-a');
    expect(clean).not.toHaveBeenCalled();
    // Another conversation is not held.
    await gate.clean('scenario-b');
    expect(clean).toHaveBeenCalledWith('scenario-b');
    gate.release(['scenario-a']);
    await gate.clean('scenario-a');
    expect(clean).toHaveBeenCalledWith('scenario-a');
  });
});
