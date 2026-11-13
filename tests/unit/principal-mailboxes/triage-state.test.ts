import { describe, it, expect } from 'vitest';
import { TriageState } from '../../../src/principal-mailboxes/triage-state.js';
import { dueMailboxes } from '../../../src/principal-mailboxes/triage-due.js';
import { parseCadence, TRIAGE_DAILY_CEILING } from '../../../src/principal-mailboxes/triage-cadence.js';

function fakeCfg() {
  const m = new Map<string, string>();
  return {
    m,
    get: async (ns: string, k: string) => m.get(`${ns}/${k}`) ?? null,
    set: async (ns: string, k: string, v: string) => { m.set(`${ns}/${k}`, v); return { stored: true, action: 'created' }; },
  };
}
const TZ = 'America/Toronto';
const make = () => { const cfg = fakeCfg(); return { cfg, st: new TriageState(cfg, () => TZ) }; };

describe('TriageState', () => {
  it('batch counter resets on a new local day', async () => {
    const { st, cfg } = make();
    // 2026-06-10 23:30 EDT and 00:30 EDT the next day: UTC dates 06-11 and 06-11 straddle local midnight
    const lateEvening = new Date('2026-06-11T03:30:00Z');
    const afterMidnight = new Date('2026-06-11T04:30:00Z');
    expect(await st.batchesToday(lateEvening)).toBe(0);
    expect(await st.addBatch(lateEvening)).toBe(1);
    expect(await st.addBatch(lateEvening)).toBe(2);
    expect(await st.batchesToday(lateEvening)).toBe(2);
    expect(await st.batchesToday(afterMidnight)).toBe(0);
    expect(await st.addBatch(afterMidnight)).toBe(1);
    expect(cfg.m.get('ceo_inbox/triage.batches.2026-06-10')).toBe('2');
    expect(cfg.m.get('ceo_inbox/triage.batches.2026-06-11')).toBe('1');
  });

  it('state is per mailbox', async () => {
    const { st, cfg } = make();
    const t = new Date('2026-06-10T14:00:00Z');
    await st.markDrained('work', t);
    await st.setDraining('work', true);
    await st.setBacklogAlarmed('work', true);
    expect(await st.lastDrainedAt('work')).toEqual(t);
    expect(await st.lastDrainedAt('home')).toBeNull();
    expect(await st.isDraining('work')).toBe(true);
    expect(await st.isDraining('home')).toBe(false);
    expect(await st.backlogAlarmed('work')).toBe(true);
    expect(await st.backlogAlarmed('home')).toBe(false);
    await st.setDraining('work', false);
    await st.setBacklogAlarmed('work', false);
    expect(await st.isDraining('work')).toBe(false);
    expect(await st.backlogAlarmed('work')).toBe(false);
    expect(cfg.m.has('ceo_inbox/triage.work.last_drained_at')).toBe(true);
    expect(cfg.m.has('ceo_inbox/triage.work.draining')).toBe(true);
    expect(cfg.m.has('ceo_inbox/triage.work.backlog_alarmed')).toBe(true);
  });

  it('a corrupt last_drained_at reads as null (so the mailbox is due)', async () => {
    const { st, cfg } = make();
    cfg.m.set('ceo_inbox/triage.work.last_drained_at', 'yesterday-ish');
    expect(await st.lastDrainedAt('work')).toBeNull();
  });

  it('a corrupt batch count reads as the ceiling (triage stops)', async () => {
    const { st, cfg } = make();
    const now = new Date('2026-06-10T14:00:00Z');
    for (const bad of ['abc', '-3', '1.5', '', '12x']) {
      cfg.m.set('ceo_inbox/triage.batches.2026-06-10', bad);
      expect(await st.batchesToday(now)).toBe(TRIAGE_DAILY_CEILING);
    }
  });
});

describe('dueMailboxes', () => {
  const tz = 'America/Toronto';
  const hourly = parseCadence('hourly 06:00-23:00')!;
  const now = new Date('2026-06-10T14:00:00Z'); // 10:00 EDT

  it('returns mailboxes whose cadence says due', async () => {
    const { st } = make();
    await st.markDrained('work', new Date('2026-06-10T12:00:00Z'));
    await st.markDrained('home', new Date('2026-06-10T13:45:00Z'));
    const due = await dueMailboxes({ mailboxIds: ['work', 'home'], cadences: { work: hourly, home: hourly }, state: st, now, tz });
    expect(due).toEqual(['work']);
  });

  it('a draining mailbox is due even outside its window or interval', async () => {
    const { st } = make();
    await st.markDrained('home', new Date('2026-06-10T13:59:00Z'));
    await st.setDraining('home', true);
    const night = new Date('2026-06-10T07:00:00Z'); // 03:00 EDT
    expect(await dueMailboxes({ mailboxIds: ['home'], cadences: { home: hourly }, state: st, now: night, tz })).toEqual(['home']);
    expect(await dueMailboxes({ mailboxIds: ['home'], cadences: { home: hourly }, state: st, now, tz })).toEqual(['home']);
  });

  it('a mailbox with no cadence entry uses the default, and order follows mailboxIds', async () => {
    const { st } = make();
    const due = await dueMailboxes({ mailboxIds: ['b', 'a'], cadences: {}, state: st, now, tz });
    expect(due).toEqual(['b', 'a']);
  });

  it('returns nothing for no mailboxes', async () => {
    const { st } = make();
    expect(await dueMailboxes({ mailboxIds: [], cadences: {}, state: st, now, tz })).toEqual([]);
  });
});
