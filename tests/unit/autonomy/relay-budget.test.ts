// relay-budget.test.ts — the per-originator cap on relays to the principal (#1320).
import { describe, it, expect } from 'vitest';
import { RelayBudget, RELAY_BUDGET_WINDOW_MS, budgetedOriginator } from '../../../src/autonomy/relay-budget.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('RelayBudget', () => {
  it('allows perHour relays per originator, then reports over', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 3, now: c.now });
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('over');
    // Another originator has its own budget.
    expect(budget.tryAcquire('b')).toBe('allowed');
  });

  it('does not count an over-budget relay', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 1, now: c.now });
    budget.tryAcquire('a');
    budget.tryAcquire('a');
    budget.tryAcquire('a');
    expect(budget.count('a')).toBe(1);
  });

  it('slides: a relay frees up an hour after the oldest one', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 2, now: c.now });
    budget.tryAcquire('a');
    c.advance(10 * 60_000);
    budget.tryAcquire('a');
    expect(budget.tryAcquire('a')).toBe('over');
    c.advance(RELAY_BUDGET_WINDOW_MS - 10 * 60_000); // the first relay is now an hour old
    expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.tryAcquire('a')).toBe('over');
  });

  it('is off at perHour 0', () => {
    const budget = new RelayBudget({ perHour: 0 });
    for (let i = 0; i < 50; i++) expect(budget.tryAcquire('a')).toBe('allowed');
    expect(budget.trackedCount()).toBe(0);
  });

  it('notifies once per window per originator', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 1, now: c.now });
    expect(budget.shouldNotify('a')).toBe(true);
    expect(budget.shouldNotify('a')).toBe(false);
    expect(budget.shouldNotify('b')).toBe(true);
    c.advance(RELAY_BUDGET_WINDOW_MS - 1);
    expect(budget.shouldNotify('a')).toBe(false);
    c.advance(1);
    expect(budget.shouldNotify('a')).toBe(true);
  });

  it('forgets originators that have gone quiet for a window', () => {
    const c = clock();
    const budget = new RelayBudget({ perHour: 3, now: c.now });
    budget.tryAcquire('a');
    budget.shouldNotify('a');
    budget.tryAcquire('b');
    expect(budget.trackedCount()).toBe(2);
    c.advance(RELAY_BUDGET_WINDOW_MS);
    budget.tryAcquire('c'); // any call past a window sweeps idle keys
    expect(budget.trackedCount()).toBe(1);
  });

  it('rejects a negative or fractional perHour', () => {
    expect(() => new RelayBudget({ perHour: -1 })).toThrow(/perHour/);
    expect(() => new RelayBudget({ perHour: 1.5 })).toThrow(/perHour/);
  });
});

describe('budgetedOriginator', () => {
  function originator(over: Partial<TaskOriginator> = {}): TaskOriginator {
    return { contactId: 'c-1', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known', ...over };
  }

  it.each(['known', 'unknown', 'blocked'] as const)('budgets a %s originator', (tier) => {
    expect(budgetedOriginator({ originator: originator({ tier }) })?.contactId).toBe('c-1');
  });

  it('budgets an originator with no tier, as unknown (#1059 fails closed)', () => {
    expect(budgetedOriginator({ originator: originator({ tier: null }) })).not.toBeNull();
    // Originators stamped before #950 carry no tier field at all.
    const noTier = originator();
    delete noTier.tier;
    expect(budgetedOriginator({ originator: noTier })).not.toBeNull();
  });

  it.each(['trusted', 'principal'] as const)('never budgets a %s-tier originator', (tier) => {
    expect(budgetedOriginator({ originator: originator({ tier }) })).toBeNull();
  });

  it.each(['principal', 'system', 'agent'] as const)('never budgets a %s-originated task', (systemRole) => {
    expect(budgetedOriginator({ originator: originator({ systemRole, tier: null }) })).toBeNull();
  });

  it('never budgets a send with no originator', () => {
    expect(budgetedOriginator(undefined)).toBeNull();
    expect(budgetedOriginator({})).toBeNull();
  });

  it.each([
    ['isSystemNotification', { isSystemNotification: true }],
    ['humanApproved', { humanApproved: true }],
    ['principalDirected', { principalDirected: true }],
  ] as const)('never budgets a %s send', (_name, flags) => {
    expect(budgetedOriginator({ ...flags, originator: originator() })).toBeNull();
  });
});
