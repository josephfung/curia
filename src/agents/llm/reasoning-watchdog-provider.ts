// reasoning-watchdog-provider.ts — LLMProvider wrapper that bounds runaway reasoning (#2371).
//
// A watched chat() runs through inner.stream(), counting one reasoning token per
// reasoning_delta. If reasoning reaches half the request's max_tokens, or half the
// usable time window passes, before any output starts, the stream is aborted and
// the call is re-asked once through inner.chat() with the reasoning so far appended
// as a runtime note (the "forced attempt"). An empty finish at the cap after
// reasoning counts as a stop too. Providers without stream() are passed through.
//
// Same wrapping style as TelemetryLlmProvider. Deliberately does not import
// openrouter.ts (or any concrete provider), so no provider can ever cycle back here.

import { classifyError } from '../../errors/classify.js';
import type { Logger } from '../../logger.js';
import type { LLMProvider, LLMResponse, LLMStreamEvent, Message, ToolDefinition, ToolResult } from './provider.js';
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
  /** The watchdog stopped the stream; a forced attempt follows. */
  | { kind: 'stopped'; stop: WatchdogStop; reasoningText: string; reasoningTokens: number }
  /** The stream failed on its own; fall back to a plain inner.chat(). */
  | { kind: 'failed'; detail: unknown };

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
      // handle a reset or idle timeout better than a second stream would.
      this.logger.warn(
        { err: outcome.detail, model: params.model, provider: this.inner.id },
        'Reasoning watchdog: watched stream failed — falling back to chat()',
      );
      return this.inner.chat(params);
    }
    return this.forcedAttempt(params, outcome.stop, outcome.reasoningText, outcome.reasoningTokens);
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
          case 'text_delta':
            standDown();
            break;
          case 'tool_use':
            standDown();
            return { kind: 'done', response: { ...event } };
          case 'message_end':
            standDown();
            if (event.content === '' && reasoningTokens > 0) {
              // Reasoning ate the whole cap: the token estimate was too low. Treat it
              // as a stop rather than returning an empty answer.
              stopWith('cap');
              break;
            }
            return { kind: 'done', response: { ...event, type: 'text' } };
          case 'error':
            if (callerAborted()) return { kind: 'done', response: event };
            if (stop) break; // our own abort surfacing as the provider's cancellation error
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
    return { kind: 'stopped', stop, reasoningText, reasoningTokens };
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
    stop: WatchdogStop,
    reasoningText: string,
    reasoningTokens: number,
  ): Promise<LLMResponse> {
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

    // The stopped attempt's output was billed too: one token per reasoning_delta.
    // Its input tokens are unknowable (the stream was cut before usage arrived),
    // so inputTokens reflects the forced attempt only.
    const usage = response.usage === undefined ? undefined : {
      ...response.usage,
      outputTokens: response.usage.outputTokens + reasoningTokens,
      reasoningTokens: (response.usage.reasoningTokens ?? 0) + reasoningTokens,
    };
    if (response.type === 'error') return usage === undefined ? response : { ...response, usage };
    return {
      ...response,
      usage: usage ?? response.usage,
      provenance: { ...response.provenance, reasoningWatchdog: record },
    };
  }
}

function forcedOutcome(response: LLMResponse): ReasoningWatchdogRecord['forcedOutcome'] {
  if (response.type === 'error') return 'error';
  if (response.type === 'tool_use') return 'acted';
  return response.content.trim().length > 0 ? 'acted' : 'empty';
}
