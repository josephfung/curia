// service.ts — once-per-install start/resume gate for the deep-dive job (#2362).
// The real scan/draft pipeline is injected as `run`; this class only owns run state.

import type { ConfigStore } from '../../memory/config-store.js';
import type { PrincipalMailboxes } from '../../principal-mailboxes/service.js';
import type { Logger } from '../../logger.js';
import type { OnboardingStateLock } from '../state.js';
import { STALL_MINUTES } from './limits.js';
import { isRunning, readDeepDiveState, writeDeepDiveState, type DeepDiveState } from './state.js';

export interface DeepDiveDeps {
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  stateLock: OnboardingStateLock;
  mailboxes: Pick<PrincipalMailboxes, 'list' | 'ceoClient' | 'calendarClient'>;
  logger: Logger;
  now?: () => Date;
  /** The pipeline. Overridable in tests; later tasks supply the real one. */
  run?: (state: DeepDiveState) => Promise<void>;
}

export type StartResult =
  | { started: true }
  | { started: false; reason: 'already_ran' | 'running' | 'no_mailbox' };

export class DeepDiveService {
  private readonly now: () => Date;
  private readonly runPipeline: (state: DeepDiveState) => Promise<void>;

  constructor(private readonly deps: DeepDiveDeps) {
    this.now = deps.now ?? (() => new Date());
    // Until the pipeline task lands there is nothing to run: finish quietly rather than pretend.
    this.runPipeline = deps.run ?? (async () => undefined);
  }

  /** Start the run if none has ever happened. `force` re-runs a finished one; a live one is never doubled. */
  async startOnce(opts: { force?: boolean } = {}): Promise<StartResult> {
    const outcome = await this.deps.stateLock(async (): Promise<{ result: StartResult; state?: DeepDiveState }> => {
      const existing = await readDeepDiveState(this.deps.configStore, this.deps.logger);
      if (isRunning(existing)) return { result: { started: false, reason: 'running' } };
      if (existing !== null && opts.force !== true) return { result: { started: false, reason: 'already_ran' } };
      const mailboxIds = (await this.deps.mailboxes.list()).map((m) => m.id);
      if (mailboxIds.length === 0) return { result: { started: false, reason: 'no_mailbox' } };
      const at = this.now().toISOString();
      const state: DeepDiveState = {
        status: 'scanning',
        startedAt: at,
        updatedAt: at,
        mailboxIds,
        summaryPath: null,
        draftPaths: [],
        reviewTaskId: null,
        backfilled: null,
        spendUsd: 0,
        requests: 0,
        rateLimited: 0,
        error: null,
      };
      await writeDeepDiveState(this.deps.configStore, state);
      return { result: { started: true }, state };
    });
    if (outcome.state) this.fire(outcome.state);
    return outcome.result;
  }

  /** Resume a scanning/drafting run whose updatedAt is older than STALL_MINUTES. */
  resumeIfStalled(now: Date): Promise<boolean> {
    const cutoff = now.getTime() - STALL_MINUTES * 60_000;
    return this.resume(now, (s) => {
      const updated = Date.parse(s.updatedAt);
      // An unparseable timestamp can never go fresh again, so treat it as stalled.
      return Number.isNaN(updated) || updated < cutoff;
    });
  }

  /** At boot any scanning/drafting run is orphaned (its process is gone): resume it now. */
  resumeAtBoot(): Promise<boolean> {
    return this.resume(this.now(), () => true);
  }

  private async resume(now: Date, shouldResume: (s: DeepDiveState) => boolean): Promise<boolean> {
    const resumed = await this.deps.stateLock(async () => {
      const current = await readDeepDiveState(this.deps.configStore, this.deps.logger);
      if (current === null || !isRunning(current) || !shouldResume(current)) return null;
      // Touch updatedAt so the next tick does not resume the same run again.
      const next = { ...current, updatedAt: now.toISOString() };
      await writeDeepDiveState(this.deps.configStore, next);
      return next;
    });
    if (resumed === null) return false;
    this.deps.logger.info({ status: resumed.status }, 'deep-dive: resuming run');
    this.fire(resumed);
    return true;
  }

  /** Fire the pipeline without awaiting it; a rejection marks the run failed. */
  private fire(state: DeepDiveState): void {
    void this.runPipeline(state).catch((err: unknown) => {
      this.deps.logger.error({ err }, 'deep-dive: run failed');
      void this.markFailed(err).catch((writeErr: unknown) => {
        this.deps.logger.error({ err: writeErr }, 'deep-dive: could not record the failure');
      });
    });
  }

  private markFailed(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    return this.deps.stateLock(async () => {
      const current = await readDeepDiveState(this.deps.configStore, this.deps.logger);
      if (current === null) return;
      await writeDeepDiveState(this.deps.configStore, {
        ...current,
        status: 'failed',
        error: message,
        updatedAt: this.now().toISOString(),
      });
    });
  }
}
