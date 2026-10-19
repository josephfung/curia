// spot-check-store.ts — the digest's number-to-action maps (#2159).
//
// A digest may end with a "Spot check" block: a few numbered actions the principal can
// grade by replying "2 good". The numbers mean nothing outside the digest that showed
// them, so each digest's map (number -> audit action id) and the message(s) that carried
// it are kept here. When a reply arrives, the record-spot-check tool resolves the number
// against the right digest: the one on the reply's email thread, or else the most recent
// delivered one within a short window.
//
// Storage is one JSON value, `{ sets: SpotCheckSet[] }`, under reports / spot_checks. The
// config store has no delete or TTL, so every write prunes: sets older than 14 days are
// dropped and at most 30 are kept. A reply outside the 24 hour window (or on a thread two
// weeks old) is not worth matching, and an unbounded list would grow forever.
//
// Failure policy:
//   - Malformed JSON, or a malformed entry inside valid JSON, is warned about and dropped.
//     A corrupt record must degrade to "no match" (the tool then asks the principal), never
//     block the digest or a verdict.
//   - A `get` that throws (an infrastructure error) is NOT caught. add() and bindDelivery()
//     propagate it, as do the finders, and the caller logs it. Swallowing it would make a
//     database outage look like "no digest found", and a read-modify-write on a failed read
//     would overwrite every stored set with a one-element list.
//   - A soft-rejected write (`{ stored: false }`) returns false; the caller decides.
//
// Concurrency: add() and bindDelivery() are read-modify-write on one value. Two of them
// overlapping would each write back the list it read, and one set (or delivery) would be lost.
// They run one at a time through one process-wide chain (see `serialize`), not a per-instance
// lock: the list-spot-checks tool builds a store per call and the boot wiring builds its own,
// so an instance lock would never see the other's writes. The chain lives on globalThis, not in
// a module variable: production runs the tsup bundle (dist/index.js, with its own copy of this
// file) while skill handlers import src/reports/spot-check-store.ts from source, so there are
// two module instances that must still share one queue. Each queued op is bounded by a timeout
// (the config store has none), so one read that never settles cannot stall every later write.

import type { ConfigStore } from '../memory/config-store.js';
import type { Logger } from '../logger.js';

export const SPOT_CHECK_NAMESPACE = 'reports';
export const SPOT_CHECK_KEY = 'spot_checks';

/** A numbered sample shown to the principal. `n` is what they reply with; `actionLogId` is never shown. */
export interface SpotCheckItem {
  n: number;
  actionLogId: number;
  summary: string;
}

/** One message that carried a digest. A digest can be delivered more than once (a resend). */
export interface SpotCheckDelivery {
  channel: string;
  messageId: string;
  threadId?: string;
  /** ISO instant the message was delivered. */
  at: string;
}

export interface SpotCheckSet {
  id: string;
  /** ISO instant the set was created, before delivery. */
  createdAt: string;
  /** Conversation the digest was composed in; delivery is bound back to the set through it. */
  conversationId: string;
  items: SpotCheckItem[];
  deliveries: SpotCheckDelivery[];
}

/**
 * What bindDelivery did. `bound` carries the set (so the caller can mark its rows sampled);
 * `no_set` means no set of that conversation fits the delivered message; `rejected` means the
 * config store soft-rejected the write.
 */
export type BindDeliveryResult =
  | { kind: 'bound'; set: SpotCheckSet }
  | { kind: 'no_set' }
  | { kind: 'rejected' };

const MS_PER_DAY = 86_400_000;
const MAX_AGE_MS = 14 * MS_PER_DAY;
const MAX_SETS = 30;
/** A delivery is bound shortly after the digest is composed; an older set is a different digest. */
const BIND_WINDOW_MS = 2 * 3_600_000;

/** Where the shared queue lives on globalThis. Symbol.for, so every module copy finds the same one. */
const MUTATION_CHAIN_KEY = Symbol.for('curia.spotCheckStore.mutationChain');
/** Longest one queued op may hold the queue. Far above a healthy config-store round trip. */
const MUTATION_TIMEOUT_MS = 10_000;

/** The add/bindDelivery queue. `tail` never rejects, so one failed op cannot stall the rest. */
interface MutationChain {
  tail: Promise<void>;
}

/** The process-wide queue, created by whichever module copy gets here first. */
function mutationChain(): MutationChain {
  const holder = globalThis as unknown as Record<symbol, MutationChain | undefined>;
  let chain = holder[MUTATION_CHAIN_KEY];
  if (!chain) {
    chain = { tail: Promise.resolve() };
    holder[MUTATION_CHAIN_KEY] = chain;
  }
  return chain;
}

/**
 * Run `op` after every earlier add/bindDelivery has settled. Its result or error goes to this
 * caller only: the chain keeps a settled-either-way copy so the next op starts regardless.
 *
 * The op gets an `abandoned()` check. Past MUTATION_TIMEOUT_MS the caller gets a timeout error
 * and the queue moves on; an op whose read answers after that must not write, or it would put
 * its stale list over whatever the ops after it wrote. So every op checks before writing.
 */
function serialize<T>(logger: Logger, op: (abandoned: () => boolean) => Promise<T>): Promise<T> {
  const chain = mutationChain();
  const run = chain.tail.then(async () => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`spot-check store: config store did not answer within ${MUTATION_TIMEOUT_MS}ms; operation timed out`));
      }, MUTATION_TIMEOUT_MS);
    });
    const work = op(() => timedOut).catch((err: unknown) => {
      // After a timeout the caller has already had its error; this is the only trace left.
      if (timedOut) logger.warn({ err }, 'spot-check store: a timed-out operation failed after it was abandoned');
      throw err;
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  });
  chain.tail = run.then(
    () => undefined,
    // Not swallowed: `run` (returned below) still rejects to the caller, who logs it.
    () => undefined,
  );
  return run;
}

/** Thrown inside an abandoned op instead of writing. Nobody awaits it but the warn above. */
function abandonedError(): Error {
  return new Error('spot-check store: operation abandoned after its timeout; not writing a stale list');
}

/**
 * Whether `content` holds `line` as a whole line's end: followed by a line break or the end of
 * the content. A bare substring check would let "1. Send email to Bob" match inside
 * "1. Send email to Bobby" and bind the other digest's numbers.
 */
function showsWholeLine(content: string, line: string): boolean {
  for (let at = content.indexOf(line); at !== -1; at = content.indexOf(line, at + 1)) {
    const next = content[at + line.length];
    if (next === undefined || next === '\n' || next === '\r') return true;
  }
  return false;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A string that parses as a date. Comparisons use Date.parse, so an unparseable one would silently never match. */
function isIsoString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function isItem(v: unknown): v is SpotCheckItem {
  return (
    isPlainObject(v) &&
    Number.isInteger(v['n']) &&
    typeof v['actionLogId'] === 'number' &&
    typeof v['summary'] === 'string'
  );
}

function isDelivery(v: unknown): v is SpotCheckDelivery {
  return (
    isPlainObject(v) &&
    typeof v['channel'] === 'string' &&
    typeof v['messageId'] === 'string' &&
    (v['threadId'] === undefined || typeof v['threadId'] === 'string') &&
    isIsoString(v['at'])
  );
}

export class SpotCheckStore {
  constructor(
    private readonly configStore: Pick<ConfigStore, 'get' | 'set'>,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Store a new set, pruning old ones. Returns false when the config store soft-rejects the write. */
  async add(set: SpotCheckSet): Promise<boolean> {
    return serialize(this.logger, async (abandoned) => {
      const sets = await this.read();
      if (abandoned()) throw abandonedError();
      // Replace a set re-added under the same id rather than listing it twice.
      const next = sets.filter((s) => s.id !== set.id);
      next.push(set);
      return this.write(next);
    });
  }

  /**
   * Record that a message (`content`) carried a digest composed in `conversationId`.
   *
   * Which set: a conversation can hold more than one recent set (a retried digest draws
   * again), so the set bound is the newest one whose first numbered line (`1. <summary>`)
   * appears in the content as a whole line: the numbers the principal sees must resolve to what they saw.
   * When no set's line appears (the agent reworded the block), the delivery is bound only if
   * the conversation has exactly one set in the window; with several, guessing could bind the
   * wrong numbers, so it returns no_set and writes nothing (the binder warns).
   *
   * A messageId already recorded is a no-op that still returns `bound`: a retry changed nothing.
   */
  async bindDelivery(conversationId: string, delivery: SpotCheckDelivery, content: string): Promise<BindDeliveryResult> {
    return serialize(this.logger, async (abandoned): Promise<BindDeliveryResult> => {
      const sets = await this.read();
      if (abandoned()) throw abandonedError();
      const cutoff = this.now() - BIND_WINDOW_MS;
      const candidates = sets
        .filter((s) => s.conversationId === conversationId && Date.parse(s.createdAt) >= cutoff)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const shown = candidates.find((s) => s.items[0] !== undefined && showsWholeLine(content, `1. ${s.items[0].summary}`));
      const target = shown ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!target) return { kind: 'no_set' };
      if (target.deliveries.some((d) => d.messageId === delivery.messageId)) return { kind: 'bound', set: target };
      target.deliveries.push(delivery);
      return (await this.write(sets)) ? { kind: 'bound', set: target } : { kind: 'rejected' };
    });
  }

  /** The set delivered on this email thread (the newest delivery wins if two sets share one). No time limit. */
  async findByEmailThread(threadId: string): Promise<SpotCheckSet | null> {
    const sets = await this.read();
    let best: { set: SpotCheckSet; at: number } | null = null;
    for (const s of sets) {
      for (const d of s.deliveries) {
        if (d.channel !== 'email' || d.threadId !== threadId) continue;
        const at = Date.parse(d.at);
        if (!best || at > best.at) best = { set: s, at };
      }
    }
    return best?.set ?? null;
  }

  /** The set whose latest delivery is the newest and no older than `withinMs`. */
  async findLatestDelivered(withinMs: number): Promise<SpotCheckSet | null> {
    const sets = await this.read();
    const cutoff = this.now() - withinMs;
    let best: { set: SpotCheckSet; at: number } | null = null;
    for (const s of sets) {
      for (const d of s.deliveries) {
        const at = Date.parse(d.at);
        if (at < cutoff) continue;
        if (!best || at > best.at) best = { set: s, at };
      }
    }
    return best?.set ?? null;
  }

  /** Read and validate the stored sets. Corrupt data yields fewer (or no) sets, never a throw; a `get` error does throw. */
  private async read(): Promise<SpotCheckSet[]> {
    const raw = await this.configStore.get(SPOT_CHECK_NAMESPACE, SPOT_CHECK_KEY);
    if (!raw) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn({ err }, 'spot-check store: stored value is not valid JSON; treating as empty');
      return [];
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed['sets'])) {
      this.logger.warn('spot-check store: stored value has no sets array; treating as empty');
      return [];
    }

    const sets: SpotCheckSet[] = [];
    for (const entry of parsed['sets'] as unknown[]) {
      const set = this.validateSet(entry);
      if (set) sets.push(set);
    }
    return sets;
  }

  /** Per-entry validation: one skewed or hand-edited set must not take the rest down with it. */
  private validateSet(entry: unknown): SpotCheckSet | null {
    if (
      !isPlainObject(entry) ||
      typeof entry['id'] !== 'string' ||
      typeof entry['conversationId'] !== 'string' ||
      !isIsoString(entry['createdAt']) ||
      !Array.isArray(entry['items']) ||
      !Array.isArray(entry['deliveries'])
    ) {
      this.logger.warn('spot-check store: dropping a malformed set');
      return null;
    }
    const items = (entry['items'] as unknown[]).filter(isItem);
    const deliveries = (entry['deliveries'] as unknown[]).filter(isDelivery);
    if (items.length !== entry['items'].length || deliveries.length !== entry['deliveries'].length) {
      this.logger.warn({ setId: entry['id'] }, 'spot-check store: dropped malformed items or deliveries from a set');
    }
    return {
      id: entry['id'],
      createdAt: entry['createdAt'],
      conversationId: entry['conversationId'],
      items,
      deliveries,
    };
  }

  /** Prune (see the file header for why), then write. Returns false on a soft reject. */
  private async write(sets: SpotCheckSet[]): Promise<boolean> {
    const cutoff = this.now() - MAX_AGE_MS;
    const kept = sets
      .filter((s) => Date.parse(s.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-MAX_SETS);
    const result = await this.configStore.set(SPOT_CHECK_NAMESPACE, SPOT_CHECK_KEY, JSON.stringify({ sets: kept }));
    if (!result.stored) {
      this.logger.warn('spot-check store: config store rejected the write');
    }
    return result.stored;
  }
}
