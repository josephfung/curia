// tests/shared/case-scope.ts — which case a piece of work belongs to, when several run
// at once (#1980).
//
// The behavior suites boot one stack and run several cases on it concurrently. Each case
// attempt runs inside its own AsyncLocalStorage context. The bus delivers an event by
// awaiting every subscriber in the publisher's call chain, so the context follows the
// work wherever it goes: the Dispatcher, the coordinator's turn, a specialist it delegates
// to (a different conversation, same chain), each tool call and each llm.call event. That
// is what lets the stub layer, the cost meter and the scoped database views answer for
// "this case" without the conversation id — which a delegated specialist does not share,
// and which several of those views are never told.
//
// Work started outside any case (boot, a timer the stack set up at start) has no context.
// The harnesses treat that as nobody's: never answered with a case's stubs, never billed
// to a case.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventBus } from '../../src/bus/bus.js';
import type { LlmCallEvent } from '../../src/bus/events.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent } from '../../src/agents/llm/provider.js';
import { UsageLedger } from './usage.js';

/** What every suite tracks for one attempt at a case (a smoke case, or one scenario run). */
export interface CaseAttempt {
  /** For warnings: the case name and attempt. */
  readonly label: string;
  /**
   * Set once the harness gives up on the attempt (its timeout fired). Its later model calls
   * fail at once and its tool calls are refused, so an abandoned turn stops spending and
   * cannot touch anything — the runtime has no way to cancel a turn itself.
   */
  cancelled: boolean;
  /** Model calls made inside this attempt, by agent. The judge adds its own. */
  readonly usage: UsageLedger;
  /** Start time of each of this attempt's model calls still in flight. */
  readonly inFlight: Map<number, number>;
  /** The longest single model call this attempt has made so far, in ms. */
  slowestCallMs: number;
}

export function newAttempt(label: string): CaseAttempt {
  return { label, cancelled: false, usage: new UsageLedger(), inFlight: new Map(), slowestCallMs: 0 };
}

export interface CaseContext<S extends CaseAttempt> {
  /** Run `fn` as `state`'s work: everything it starts, however indirectly, sees `state`. */
  run<T>(state: S, fn: () => Promise<T>): Promise<T>;
  /** The attempt the calling code is running for, if any. */
  current(): S | undefined;
}

export function createCaseContext<S extends CaseAttempt>(): CaseContext<S> {
  const storage = new AsyncLocalStorage<S>();
  return {
    run: (state, fn) => storage.run(state, fn),
    current: () => storage.getStore(),
  };
}

/**
 * How long one model call may run before a timeout is blamed on the provider rather than
 * the model. Calls on the production standard tier normally finish in seconds even with the
 * coordinator's full prompt; a minute-long call is the provider stalling (#1980 saw 180s
 * timeouts that finished in well under the limit on retry).
 */
export const PROVIDER_STALL_MS = 60_000;

/** The longest model call the attempt made, counting one still in flight. */
export function slowestModelCallMs(attempt: CaseAttempt, now = Date.now()): number {
  let slowest = attempt.slowestCallMs;
  for (const started of attempt.inFlight.values()) slowest = Math.max(slowest, now - started);
  return slowest;
}

/** The answer a cancelled attempt's model calls get: non-retryable, so the turn ends now. */
function cancelledResponse(providerId: string, label: string): Extract<LLMResponse, { type: 'error' }> {
  return {
    type: 'error',
    error: {
      // BUDGET_EXCEEDED: never retried by the runtime, and not NOT_FOUND, so no model fallback.
      type: 'BUDGET_EXCEEDED',
      source: providerId,
      message: `test harness: '${label}' passed its timeout, so its turn was stopped`,
      retryable: false,
      context: {},
      timestamp: new Date(),
    },
  };
}

/**
 * Wrap a provider (createTestModeStack's wrapLlmProvider) so each call is timed against
 * the attempt that made it, and a cancelled attempt's calls are refused before they cost
 * anything. The judge's calls run outside any attempt and pass straight through.
 */
export function guardProvider(provider: LLMProvider, current: () => CaseAttempt | undefined): LLMProvider {
  let seq = 0;
  const begin = (attempt: CaseAttempt | undefined): (() => void) => {
    if (!attempt) return () => {};
    const id = ++seq;
    const started = Date.now();
    attempt.inFlight.set(id, started);
    return () => {
      attempt.inFlight.delete(id);
      attempt.slowestCallMs = Math.max(attempt.slowestCallMs, Date.now() - started);
    };
  };

  const guarded: LLMProvider = {
    id: provider.id,
    async chat(params) {
      const attempt = current();
      if (attempt?.cancelled) return cancelledResponse(provider.id, attempt.label);
      const end = begin(attempt);
      try {
        return await provider.chat(params);
      } finally {
        end();
      }
    },
  };
  if (provider.stream) {
    const stream = provider.stream.bind(provider);
    guarded.stream = async function* (params): AsyncIterable<LLMStreamEvent> {
      const attempt = current();
      if (attempt?.cancelled) {
        yield cancelledResponse(provider.id, attempt.label);
        return;
      }
      const end = begin(attempt);
      try {
        yield* stream(params);
      } finally {
        end();
      }
    };
  }
  return guarded;
}

/**
 * Bill every agent's llm.call to the attempt it was made in. A call made outside any
 * attempt goes to `unattributed`, which the CLI reports if it is ever non-zero.
 */
export function meterAgentCalls(bus: EventBus, current: () => CaseAttempt | undefined, unattributed: UsageLedger): void {
  bus.subscribe('llm.call', 'system', async (event) => {
    const { payload } = event as LlmCallEvent;
    (current()?.usage ?? unattributed).addAgentCall(payload.agentId, payload, payload.estimatedCostUsd);
  });
}

/** How a turn that did not complete ended (tests/shared/turn-capture.ts). */
export type TurnErrorKind = 'timeout' | 'agent_error' | 'error_response' | 'fallback' | 'delivery';

/** Agent error types that come from the provider, not from anything the model decided. */
const PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set(['PROVIDER_ERROR', 'TIMEOUT', 'RATE_LIMIT']);

/**
 * Why an attempt that did not complete is the provider's failure rather than the model's,
 * or undefined when it is the model's (or unknown). A provider failure is retried without
 * using the case's one gated retry, and reported apart.
 *
 * - A model fallback ran the case on a different model than the run is labelled with.
 * - An agent error of a provider type (5xx, provider timeout, rate limit).
 * - A timeout during which one model call ran for PROVIDER_STALL_MS or more. A model that
 *   loops makes many quick calls instead; that timeout stays the model's.
 */
export function providerFailure(failure: {
  kind?: TurnErrorKind;
  errorType?: string;
  slowestModelCallMs: number;
}): string | undefined {
  if (failure.kind === 'fallback') return 'model fallback';
  if ((failure.kind === 'agent_error' || failure.kind === 'error_response') && failure.errorType && PROVIDER_ERROR_TYPES.has(failure.errorType)) {
    return `provider error (${failure.errorType})`;
  }
  if (failure.kind === 'timeout' && failure.slowestModelCallMs >= PROVIDER_STALL_MS) {
    return `provider stall (one model call ran ${Math.round(failure.slowestModelCallMs / 1000)}s)`;
  }
  return undefined;
}

/**
 * Cases run at once unless --concurrency says otherwise: enough to cut a release run's
 * wall-clock several-fold, few enough to stay under OpenRouter's rate limits (#1980).
 */
export const DEFAULT_CONCURRENCY = 4;

/** A --concurrency value: a positive integer, or an error naming the flag. */
export function parseConcurrency(value: string, flag = '--concurrency'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got '${value}')`);
  return n;
}

/** Provider failures retried per attempt before the failure stands (and the gated retry applies). */
export const PROVIDER_RETRIES = 2;

/**
 * Run `items` through `worker`, at most `concurrency` at a time, results in input order.
 * `canStart` lets a caller keep two items apart (scenario cases that seed the same
 * contact): an item waits until it returns true for the items then running.
 */
export async function runConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  canStart: (item: T, running: readonly T[]) => boolean = () => true,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a positive integer (got ${concurrency})`);
  const results = new Array<R>(items.length);
  const waiting = items.map((item, index) => ({ item, index }));
  const running = new Set<{ item: T; index: number }>();
  let failure: { error: unknown } | undefined;

  return new Promise<R[]>((resolve, reject) => {
    const pump = (): void => {
      if (failure) {
        // Let what is running finish (its turns hold the pool), then report the first error.
        if (running.size === 0) reject(failure.error);
        return;
      }
      if (waiting.length === 0 && running.size === 0) {
        resolve(results);
        return;
      }
      while (running.size < concurrency) {
        const runningItems = [...running].map(r => r.item);
        const next = waiting.findIndex(w => canStart(w.item, runningItems));
        if (next === -1) break;
        const entry = waiting.splice(next, 1)[0]!;
        running.add(entry);
        worker(entry.item, entry.index).then(
          (result) => { results[entry.index] = result; },
          (error: unknown) => { failure ??= { error }; },
        ).finally(() => {
          running.delete(entry);
          pump();
        });
      }
      if (running.size === 0 && waiting.length > 0) {
        // Nothing running and nothing may start: canStart refuses every item against an
        // empty set, which would hang the run.
        reject(new Error('runConcurrently: no item can start'));
      }
    };
    pump();
  });
}
