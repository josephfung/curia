// Seeded state stays with the run that seeded it when runs overlap (#1980).
import { describe, expect, it } from 'vitest';
import type { BullpenService } from '../../../src/memory/bullpen.js';
import type { OutboundContextRow, OutboundContextService } from '../../../src/dispatch/outbound-context.js';
import { createCaseContext, newAttempt, type CaseAttempt } from '../../shared/case-scope.js';
import { scopedBullpen, scopedOutboundContext, SeedScope, seedConflictKeys } from '../../scenarios/seed.js';
import type { ScenarioCase } from '../../scenarios/types.js';

type RunState = CaseAttempt & { scope: SeedScope };

function run(label: string, threadIds: string[], entryIds: string[] = []): RunState {
  const scope = new SeedScope();
  for (const id of threadIds) scope.threadIds.add(id);
  for (const id of entryIds) scope.entryIds.add(id);
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

describe('seedConflictKeys', () => {
  const scenario = (contacts: Array<{ displayName: string; identifier: string }>) => ({
    seed: { contacts: contacts.map((c, i) => ({ key: `c${i}`, tier: 'known', channel: 'email', ...c })), outboundContext: [], bullpen: [] },
  }) as unknown as ScenarioCase;

  it('names each seeded identity and display name, case-insensitively', () => {
    expect(seedConflictKeys(scenario([{ displayName: 'Priya Shah', identifier: 'Priya@Example.test' }])))
      .toEqual(['identity:email:priya@example.test', 'name:priya shah']);
    expect(seedConflictKeys(scenario([]))).toEqual([]);
  });
});
