// triage-state.ts — per-mailbox triage state over ConfigStore namespace `ceo_inbox` (#2475, D4).
//
// Keys (values are strings, as ConfigStore stores them):
//   triage.<id>.last_drained_at   ISO-8601 instant of the last completed drain
//   triage.<id>.draining          'true' | 'false' — a drain returned has_more last batch
//   triage.batches.<YYYY-MM-DD>   batches run that LOCAL day (principal's timezone), all mailboxes
//   triage.<id>.drain_started_at  ISO-8601 start of the current drain episode (R52), '' when none
//   triage.<id>.backlog_alarmed   'true' | 'false' — the backlog alarm fired this episode
//   triage.<id>.settle_pending    'true' | 'false' — the last batch was listed, not yet known settled (R68)
//
// Corrupt stored values fail safe, preferring to stop over running past the budget:
//   - a bad last_drained_at reads as null, which makes the mailbox due (one extra drain at worst);
//   - a bad batch count reads as TRIAGE_DAILY_CEILING, which stops triage for the day;
//   - a draining / backlog_alarmed value other than exactly 'true' reads as false.
// Store errors propagate. Read-modify-write on the batch counter is not atomic; only the single
// inbox-drain owner calls addBatch.
import { DateTime } from 'luxon';
import type { ConfigStore } from '../memory/config-store.js';
import { TRIAGE_DAILY_CEILING } from './triage-cadence.js';

export const TRIAGE_NAMESPACE = 'ceo_inbox';

export class TriageState {
  constructor(
    private readonly cfg: Pick<ConfigStore, 'get' | 'set'>,
    private readonly tz: () => string,
  ) {}

  private async read(key: string): Promise<string | null> {
    return this.cfg.get(TRIAGE_NAMESPACE, key);
  }

  private async write(key: string, value: string): Promise<void> {
    await this.cfg.set(TRIAGE_NAMESPACE, key, value);
  }

  async lastDrainedAt(id: string): Promise<Date | null> {
    const raw = await this.read(`triage.${id}.last_drained_at`);
    if (raw === null) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async markDrained(id: string, at: Date): Promise<void> {
    await this.write(`triage.${id}.last_drained_at`, at.toISOString());
  }

  /** When the current drain episode began (R52); null when none is recorded or the value is bad. */
  async drainStartedAt(id: string): Promise<Date | null> {
    const raw = await this.read(`triage.${id}.drain_started_at`);
    if (raw === null || raw === '') return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Record the start of a drain episode, or clear it with null. */
  async setDrainStartedAt(id: string, at: Date | null): Promise<void> {
    await this.write(`triage.${id}.drain_started_at`, at ? at.toISOString() : '');
  }

  async isDraining(id: string): Promise<boolean> {
    return (await this.read(`triage.${id}.draining`)) === 'true';
  }

  async setDraining(id: string, v: boolean): Promise<void> {
    await this.write(`triage.${id}.draining`, v ? 'true' : 'false');
  }

  private batchesKey(now: Date): string {
    const local = DateTime.fromJSDate(now, { zone: this.tz() });
    if (!local.isValid) throw new Error(`TriageState: invalid timezone "${this.tz()}"`);
    return `triage.batches.${local.toFormat('yyyy-MM-dd')}`;
  }

  async batchesToday(now: Date): Promise<number> {
    const raw = await this.read(this.batchesKey(now));
    if (raw === null) return 0;
    return /^\d+$/.test(raw) ? Number(raw) : TRIAGE_DAILY_CEILING;
  }

  /** True once today's batches reach the ceiling; a corrupt count counts as reached. */
  async ceilingReached(now: Date): Promise<boolean> {
    return (await this.batchesToday(now)) >= TRIAGE_DAILY_CEILING;
  }

  /** Count one batch for the local day of `now`; returns the new count. */
  async addBatch(now: Date): Promise<number> {
    const next = (await this.batchesToday(now)) + 1;
    await this.write(this.batchesKey(now), String(next));
    return next;
  }

  /**
   * The drain listed this mailbox's last messages and nothing remained (R68). The episode stays
   * open (draining) until the run that triages them is known to have finished, so a failed run's
   * retry still finds the mailbox due and gets the same messages back. The heartbeat closes it
   * once no drain task of its own is open.
   */
  async settlePending(id: string): Promise<boolean> {
    return (await this.read(`triage.${id}.settle_pending`)) === 'true';
  }

  async setSettlePending(id: string, v: boolean): Promise<void> {
    await this.write(`triage.${id}.settle_pending`, v ? 'true' : 'false');
  }

  /**
   * Close the drain episode: stamp last_drained_at with the episode's start (R52; `now` when none
   * was recorded), and clear draining, the start, the settle marker and the backlog alarm.
   */
  async closeEpisode(id: string, now: Date): Promise<void> {
    const startedAt = (await this.isDraining(id) ? await this.drainStartedAt(id) : null) ?? now;
    await this.markDrained(id, startedAt);
    await this.setDraining(id, false);
    await this.setDrainStartedAt(id, null);
    if (await this.settlePending(id)) await this.setSettlePending(id, false);
    if (await this.backlogAlarmed(id)) await this.setBacklogAlarmed(id, false);
  }

  async backlogAlarmed(id: string): Promise<boolean> {
    return (await this.read(`triage.${id}.backlog_alarmed`)) === 'true';
  }

  async setBacklogAlarmed(id: string, v: boolean): Promise<void> {
    await this.write(`triage.${id}.backlog_alarmed`, v ? 'true' : 'false');
  }
}
