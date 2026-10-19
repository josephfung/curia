// spot-check-sampler.ts — draws the digest's "Spot check" block (#2159 Phase 3).
//
// Autonomous actions land in the sample pool (sample-pool.ts) as unscored autonomy_action_log
// rows. Each digest asks this sampler for up to three of them, weighted towards what the spec
// most wants checked (sends that speak for the principal, first contacts, triage). The picks
// are numbered 1..N for the principal and the number-to-row map is stored (SpotCheckStore) so a
// reply like "2 good" can be resolved later.
//
// The rows are NOT marked sampled here. A drawn block may never reach the principal: a quiet
// day's debrief, a failed or held send, an agent that dropped the block. Marking at draw time
// burned those samples for good. SpotCheckBinder marks a set's rows once the digest carrying it
// is delivered and bound, i.e. once its numbers can actually be answered. Until then the rows
// stay in the pool and a later digest may offer them again; an unbound set is pruned by age.
//
// Failure policy: draw() never throws. A digest must go out without samples rather than fail,
// so every error returns null with a log line. The map is stored before the block is returned:
// a block whose numbers could not be resolved is never shown.

import { randomUUID } from 'node:crypto';
import type { ActionLogRepo } from '../autonomy/action-log-repo.js';
import type { ActionLogRow } from '../autonomy/action-log-types.js';
import { formatEmailSummary, sampleWeight, selectSamples, TRIAGE_SKILLS, type SampleSignals } from '../autonomy/sample-pool.js';
import type { SpotCheckItem, SpotCheckStore } from './spot-check-store.js';
import type { Logger } from '../logger.js';

export const SPOT_CHECK_HEADER = 'Spot check (optional, reply with a number):';

const MS_PER_DAY = 86_400_000;
/** How far back a candidate may be. Older actions are stale to ask about. */
const CANDIDATE_WINDOW_MS = 7 * MS_PER_DAY;
/** Rows read per draw. The pool is small; this only bounds a pathological backlog. */
const CANDIDATE_LIMIT = 200;
/** At most three samples per digest (spec). */
const MAX_SAMPLES = 3;
/** One slow mail lookup must not hold up the digest. */
const DESCRIBE_TIMEOUT_MS = 3_000;

/**
 * Looks up the subject and sender of an email so a triage sample reads as more than
 * "Archive an email". Returns null when the message cannot be described.
 */
export type DescribeEmail = (messageId: string, account?: string) => Promise<{ subject?: string; from?: string } | null>;

export interface SpotCheckSamplerDeps {
  actionLogRepo: Pick<ActionLogRepo, 'findSampleCandidates'>;
  store: Pick<SpotCheckStore, 'add'>;
  logger: Logger;
  random?: () => number;
  now?: () => number;
  /** Optional: without it, triage samples keep their stored summary. */
  describeEmail?: DescribeEmail;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `payload.sample`, or null when the payload is not shaped like a pool row's. */
function readSample(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const sample = payload?.['sample'];
  return isPlainObject(sample) ? sample : null;
}

/** The row's signals, or {} on anything malformed. An empty set weighs 1, so a bad row is still drawable. */
function readSignals(payload: Record<string, unknown> | null): SampleSignals {
  const signals = readSample(payload)?.['signals'];
  // Shape checked above; sampleWeight compares each field strictly, so a stray value cannot misweigh.
  return isPlainObject(signals) ? (signals as unknown as SampleSignals) : {};
}

/** Collapse any run of whitespace (line breaks included) to one space: each sample is one numbered line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export class SpotCheckSampler {
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly deps: SpotCheckSamplerDeps) {
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  /** The block to put in a digest, or null when there is nothing to check or the map could not be stored. */
  async draw(conversationId: string): Promise<{ block: string; count: number } | null> {
    try {
      const now = this.now();
      const rows = await this.deps.actionLogRepo.findSampleCandidates(new Date(now - CANDIDATE_WINDOW_MS), CANDIDATE_LIMIT);
      if (rows.length === 0) return null;

      const picked = selectSamples(rows, (r) => sampleWeight(readSignals(r.payload)), MAX_SAMPLES, this.random);
      // Lookups run in parallel and each one settles on its own (see summarize), so a
      // failed or slow lookup costs at most one timeout and never drops a sample.
      const summaries = await Promise.all(picked.map((r) => this.summarize(r)));
      const items: SpotCheckItem[] = picked.map((r, i) => ({ n: i + 1, actionLogId: r.id, summary: summaries[i]! }));

      const stored = await this.deps.store.add({
        id: randomUUID(),
        createdAt: new Date(now).toISOString(),
        conversationId,
        items,
        deliveries: [],
      });
      if (!stored) {
        // The rows were never shown, so a later digest can offer them again.
        this.deps.logger.warn({ conversationId, count: items.length }, 'spot-check sampler: the map could not be stored; digest goes out without samples');
        return null;
      }

      return {
        block: [SPOT_CHECK_HEADER, ...items.map((i) => `${i.n}. ${i.summary}`)].join('\n'),
        count: items.length,
      };
    } catch (err) {
      this.deps.logger.error({ err, conversationId }, 'spot-check sampler: draw failed; digest goes out without samples');
      return null;
    }
  }

  /**
   * The line the principal reads for a row. A triage row's stored summary ("Archive an email")
   * cannot be graded on its own, so when a mail lookup is wired, the subject and sender are
   * added. Any lookup failure keeps the stored summary: it is a nicety, not a requirement.
   */
  private async summarize(row: ActionLogRow): Promise<string> {
    const base = oneLine(row.description ?? row.toolName);
    const describeEmail = this.deps.describeEmail;
    if (!describeEmail || !TRIAGE_SKILLS.has(row.toolName)) return base;
    // The tool returned the subject when it ran (ceo-inbox-*, whose mail the gateway lookup
    // cannot reach), so the stored summary already names the email: no lookup, no warning.
    const stored = readSample(row.payload)?.['email'];
    if (isPlainObject(stored) && typeof stored['subject'] === 'string' && stored['subject'].trim()) return base;

    const input = readSample(row.payload)?.['input'];
    if (!isPlainObject(input) || typeof input['message_id'] !== 'string') return base;
    const messageId = input['message_id'];
    const account = typeof input['account'] === 'string' ? input['account'] : undefined;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), DESCRIBE_TIMEOUT_MS);
      });
      const described = await Promise.race([describeEmail(messageId, account), timeout]);
      if (described === 'timeout') {
        this.deps.logger.warn({ actionLogId: row.id, toolName: row.toolName }, 'spot-check sampler: email lookup timed out; keeping the stored summary');
        return base;
      }
      const enriched = formatEmailSummary(base, described?.subject, described?.from);
      if (enriched === base) {
        this.deps.logger.warn({ actionLogId: row.id, toolName: row.toolName }, 'spot-check sampler: email lookup found nothing to add; keeping the stored summary');
      }
      return enriched;
    } catch (err) {
      this.deps.logger.warn({ err, actionLogId: row.id, toolName: row.toolName }, 'spot-check sampler: email lookup failed; keeping the stored summary');
      return base;
    } finally {
      clearTimeout(timer);
    }
  }
}
