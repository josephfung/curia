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
