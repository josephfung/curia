// reasoning-watchdog-provider.ts — LLMProvider wrapper that bounds runaway reasoning (#2371).
//
// A watched chat() runs through inner.stream(), counting one reasoning token per
// reasoning_delta. If reasoning reaches half the request's max_tokens, or half the
// usable time window passes, before any output starts (text_delta, output_started
// or a final event), the stream is aborted and the call is re-asked once through
// inner.chat() with the reasoning so far appended as a runtime note (the "forced
// attempt"). An empty reply after reasoning counts as a stop too. Providers
// without stream() are passed through.
//
// Same wrapping style as TelemetryLlmProvider. Imports no concrete provider
// class, so no provider can ever cycle back here.

import { classifyError } from '../../errors/classify.js';
import type { Logger } from '../../logger.js';
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamEvent,
  LLMUsage,
  Message,
  ToolDefinition,
  ToolResult,
} from './provider.js';
import {
  forcedAttemptMessage,
  watchdogLimits,
  type ReasoningWatchdogRecord,
  type WatchdogTrigger,
} from './reasoning-watchdog.js';

interface CallParams {
  messages: Message[];
  tools?: ToolDefinition[];
  toolResults?: ToolResult[];
  model?: string;
  options?: Record<string, unknown>;
}

interface WatchdogStop {
  trigger: WatchdogTrigger;
  firedAtReasoningTokens: number;
  firedAfterMs: number;
}

type WatchedOutcome =
  /** The watched stream settled the call: a normal answer, or the caller's cancellation. */
  | { kind: 'done'; response: LLMResponse }
  /**
   * The watchdog stopped the stream; a forced attempt follows. `stoppedUsage` is
   * the stopped attempt's real usage when it finished (a `cap` stop); absent when
   * the stream was cut before usage arrived.
   */
  | { kind: 'stopped'; stop: WatchdogStop; reasoningText: string; reasoningTokens: number; stoppedUsage?: LLMUsage }
  /**
   * Fall back to a plain inner.chat(params): the stream failed on its own, or
   * finished empty with no readable reasoning (so chat()'s own empty-reply retry,
   * #2247, runs). `billedUsage` is the empty attempt's usage, added to the result.
   */
  | { kind: 'failed'; detail: unknown; billedUsage?: LLMUsage };

/** Wrap a registry provider with the reasoning watchdog (#2371). */
export function watchProvider(provider: LLMProvider, logger: Logger): ReasoningWatchdogProvider {
  return new ReasoningWatchdogProvider(provider, logger);
}

export class ReasoningWatchdogProvider implements LLMProvider {
  readonly id: string;
  // `declare` so no own property exists when the inner provider cannot stream:
  // voice checks for stream's presence and must not see one that isn't there.
  declare readonly stream?: (params: CallParams) => AsyncIterable<LLMStreamEvent>;

  constructor(
    private readonly inner: LLMProvider,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.id = inner.id;
    // Streaming callers (voice) are passed straight through, unwatched.
    if (inner.stream) this.stream = inner.stream.bind(inner);
  }

  async chat(params: CallParams): Promise<LLMResponse> {
    const innerStream = this.inner.stream;
    if (!innerStream) return this.inner.chat(params);

    const outcome = await this.watch((p) => innerStream.call(this.inner, p), params);
    if (outcome.kind === 'done') return outcome.response;
    if (outcome.kind === 'failed') {
      // Once, with the original params: the provider's own chat() retries (#2247)
      // handle a reset, idle timeout or empty reply better than a second stream would.
      this.logger.warn(
        { err: outcome.detail, model: params.model, provider: this.inner.id },
        'Reasoning watchdog: watched stream failed — falling back to chat()',
      );
      const response = await this.inner.chat(params);
      if (outcome.billedUsage === undefined) return response;
      return { ...response, usage: addUsage(response.usage, outcome.billedUsage) };
    }
    return this.forcedAttempt(params, outcome);
  }

  private async watch(
    stream: (params: CallParams) => AsyncIterable<LLMStreamEvent>,
    params: CallParams,
  ): Promise<WatchedOutcome> {
    const options = params.options ?? {};
    const callerSignal = options.signal instanceof AbortSignal ? options.signal : undefined;
    const deadlineAt = typeof options.deadlineAt === 'number' && Number.isFinite(options.deadlineAt)
      ? options.deadlineAt
      : undefined;
    const internal = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, internal.signal]) : internal.signal;
    const callStartMs = this.now();

    let reasoningTokens = 0;
    let reasoningText = '';
    let watching = true;
    let tokenThreshold: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: WatchdogStop | undefined;
    let stoppedUsage: LLMUsage | undefined;

    const stopWith = (trigger: WatchdogTrigger): void => {
      if (stop) return;
      stop = { trigger, firedAtReasoningTokens: reasoningTokens, firedAfterMs: this.now() - callStartMs };
    };
    const fire = (trigger: 'tokens' | 'time'): void => {
      if (!watching || stop) return;
      stopWith(trigger);
      internal.abort(new Error(`Reasoning watchdog stop (${trigger})`));
    };
    const standDown = (): void => {
      // Output has started: never cut a reply in progress.
      watching = false;
      clearTimeout(timer);
      timer = undefined;
    };
    const callerAborted = (): boolean => callerSignal?.aborted === true;

    const iterator = stream({ ...params, options: { ...options, signal } })[Symbol.asyncIterator]();
    // The next event, or 'stopped' as soon as the watchdog aborts, so a stream stalled
    // mid-reasoning is abandoned at once even if the provider is slow to honour the
    // signal. A fresh promise per event, with its abort listener removed when the event
    // arrives: racing one long-lived "stopped" promise (Promise.race) would pin a
    // reaction, and the event it resolved with, for every event of the call.
    const nextOrStop = (): Promise<IteratorResult<LLMStreamEvent> | 'stopped'> => {
      if (internal.signal.aborted) return Promise.resolve('stopped');
      return new Promise((resolve, reject) => {
        const onAbort = (): void => resolve('stopped');
        internal.signal.addEventListener('abort', onAbort, { once: true });
        iterator.next().then(
          (result) => {
            internal.signal.removeEventListener('abort', onAbort);
            resolve(result);
          },
          (err: unknown) => {
            internal.signal.removeEventListener('abort', onAbort);
            // A no-op when the watchdog already resolved this promise with 'stopped'.
            reject(err);
          },
        );
      });
    };
    // True once the iterator has finished on its own (done or threw), so it needs no closing.
    let finished = false;

    try {
      for (;;) {
        const next = await nextOrStop();
        if (next === 'stopped') break;
        if (next.done) {
          finished = true;
          return { kind: 'failed', detail: new Error('Stream ended without a final event') };
        }
        const event = next.value;
        switch (event.type) {
          case 'request_started': {
            if (!watching) break;
            const limits = watchdogLimits({
              maxTokens: event.maxTokens,
              callStartMs,
              ...(deadlineAt !== undefined ? { deadlineAt } : {}),
            });
            tokenThreshold = limits.tokenThreshold;
            clearTimeout(timer);
            timer = setTimeout(() => fire('time'), Math.max(0, limits.fireAtMs - this.now()));
            break;
          }
          case 'reasoning_delta':
            reasoningTokens += 1;
            reasoningText += event.text;
            if (tokenThreshold !== undefined && reasoningTokens >= tokenThreshold) fire('tokens');
            break;
          case 'output_started':
          case 'text_delta':
            // output_started covers tool calls, whose argument chunks yield no event.
            standDown();
            break;
          case 'tool_use':
            standDown();
            return { kind: 'done', response: { ...event } };
          case 'message_end':
            standDown();
            if (event.content === '') {
              if (reasoningTokens > 0) {
                // An empty reply after reasoning: reasoning ate the cap before the
                // token trigger fired. Treat it as a stop, not an empty answer.
                stopWith('cap');
                stoppedUsage = event.usage;
                break;
              }
              // Empty with no readable reasoning (encrypted, omitted, or none): let
              // chat() retry it as it did before streaming (#2247). No forced message.
              return { kind: 'failed', detail: new Error('Stream ended with an empty reply'), billedUsage: event.usage };
            }
            return { kind: 'done', response: { ...event, type: 'text' } };
          case 'error':
            if (callerAborted()) return { kind: 'done', response: event };
            if (stop) break; // our own abort surfacing as the provider's cancellation error
            // A 400/401/404 would fail the same way through chat(): return it as is.
            if (!event.error.retryable) return { kind: 'done', response: event };
            return { kind: 'failed', detail: event.error };
        }
        if (stop) break;
      }
    } catch (err) {
      finished = true;
      if (callerAborted()) {
        return { kind: 'done', response: { type: 'error', error: classifyError(err, this.inner.id) } };
      }
      if (!stop) return { kind: 'failed', detail: err };
      // Thrown by our own abort: carry on to the forced attempt.
    } finally {
      clearTimeout(timer);
      if (!finished) this.closeIterator(iterator, params.model);
    }

    if (!stop) {
      // Unreachable: the loop only exits by return or once stop is set.
      return { kind: 'failed', detail: new Error('Reasoning watchdog left the stream without a stop') };
    }
    if (callerAborted()) {
      // The caller cancelled while the watchdog was stopping: no forced attempt.
      return { kind: 'done', response: { type: 'error', error: classifyError(callerSignal?.reason, this.inner.id) } };
    }
    return {
      kind: 'stopped',
      stop,
      reasoningText,
      reasoningTokens,
      ...(stoppedUsage !== undefined ? { stoppedUsage } : {}),
    };
  }

  /**
   * Close the inner stream so it releases its response buffers (#1648/#1651).
   * Not awaited: a stream stalled mid-await only finishes once the abort lands.
   */
  private closeIterator(iterator: AsyncIterator<LLMStreamEvent>, model: string | undefined): void {
    const closing = iterator.return?.();
    if (!closing) return;
    closing.catch((err: unknown) => {
      // The call's result does not depend on this; it is stream hygiene only.
      this.logger.warn({ err, model, provider: this.inner.id }, 'Reasoning watchdog: closing the stopped stream failed');
    });
  }

  private async forcedAttempt(
    params: CallParams,
    stopped: Extract<WatchedOutcome, { kind: 'stopped' }>,
  ): Promise<LLMResponse> {
    const { stop, reasoningText, reasoningTokens, stoppedUsage } = stopped;
    // deadlineAt only positions the watchdog; the forced attempt is not watched.
    let forcedOptions: Record<string, unknown> | undefined;
    if (params.options !== undefined) {
      forcedOptions = { ...params.options };
      delete forcedOptions.deadlineAt;
    }
    const response = await this.inner.chat({
      ...params,
      messages: [...params.messages, { role: 'user', content: forcedAttemptMessage(reasoningText) }],
      ...(forcedOptions !== undefined ? { options: forcedOptions } : {}),
    });

    const record: ReasoningWatchdogRecord = { ...stop, forcedOutcome: forcedOutcome(response) };
    this.logger.warn(
      { reasoningWatchdog: record, model: params.model, provider: this.inner.id },
      'Reasoning watchdog fired — forced attempt',
    );

    // The stopped attempt was billed too. A `cap` stop finished, so its real usage
    // is known and added whole. A cut stream never reported usage: count one
    // output token per reasoning_delta, and inputTokens reflects the forced attempt only.
    let usage: LLMUsage | undefined;
    if (stoppedUsage !== undefined) {
      usage = addUsage(response.usage, stoppedUsage);
    } else if (response.usage !== undefined) {
      usage = {
        ...response.usage,
        outputTokens: response.usage.outputTokens + reasoningTokens,
        reasoningTokens: (response.usage.reasoningTokens ?? 0) + reasoningTokens,
      };
    }
    if (response.type === 'error') return usage === undefined ? response : { ...response, usage };
    return {
      ...response,
      usage: usage ?? response.usage,
      provenance: { ...response.provenance, reasoningWatchdog: record },
    };
  }
}

/** Sum two usages; `a` may be absent (an error response without usage). */
function addUsage(a: LLMUsage | undefined, b: LLMUsage): LLMUsage {
  if (a === undefined) return { ...b };
  const reasoningTokens = a.reasoningTokens === undefined && b.reasoningTokens === undefined
    ? undefined
    : (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function forcedOutcome(response: LLMResponse): ReasoningWatchdogRecord['forcedOutcome'] {
  if (response.type === 'error') return 'error';
  if (response.type === 'tool_use') return 'acted';
  return response.content.trim().length > 0 ? 'acted' : 'empty';
}
