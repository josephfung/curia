// service.ts — once-per-install start/resume gate for the deep-dive job (#2362).
// The pipeline (run.ts) does the work; this class owns starting, resuming and the run state.

import { STALL_MINUTES } from './limits.js';
import { runDeepDive, type RunDeps } from './run.js';
import {
  isRunning,
  readDeepDiveState,
  updateRunningDeepDive,
  writeDeepDiveState,
  type DeepDiveState,
} from './state.js';

export interface DeepDiveDeps extends RunDeps {
  /** The pipeline. Defaults to runDeepDive with these deps; overridable in tests. */
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
    this.runPipeline = deps.run ?? ((state) => runDeepDive(deps, state));
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

  /**
   * Fire the pipeline without awaiting it. runDeepDive records its own failures (state, notice,
   * note); this catch is the backstop for anything that escapes it, a synchronous throw included.
   */
  private fire(state: DeepDiveState): void {
    void Promise.resolve()
      .then(() => this.runPipeline(state))
      .catch((err: unknown) => {
        this.deps.logger.error({ err }, 'deep-dive: run failed');
        return this.markFailed(state.startedAt, err).catch((writeErr: unknown) => {
          this.deps.logger.error({ err: writeErr }, 'deep-dive: could not record the failure');
        });
      });
  }

  /** Mark the run failed — only while the stored run is still this one (same startedAt) and running. */
  private async markFailed(startedAt: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const written = await updateRunningDeepDive(this.deps, startedAt, (current) => ({
      ...current,
      status: 'failed',
      error: message,
      updatedAt: this.now().toISOString(),
    }));
    if (written === null) {
      this.deps.logger.warn({ startedAt }, 'deep-dive: a superseded or finished run failed late; state left as is');
    }
  }
}
