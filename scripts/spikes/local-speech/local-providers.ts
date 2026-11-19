// Prototype providers for the local speech service (#2469). They implement the
// same contracts as DeepgramSttProvider and CartesiaTtsProvider, so the spike
// also tests whether src/speech/types.ts fits a local engine unchanged.
//
// Spike code: enough error handling to measure honestly, not production
// hardening (#2470 owns that).

import {
  SttHttpError,
  TtsHttpError,
  resolveBatchSignal,
  type BatchSpeechToTextProvider,
  type PcmFrame,
  type SpeechToTextProvider,
  type SttSession,
  type SttSessionOptions,
  type SttSpeechStartedEvent,
  type SttTranscriptEvent,
  type TextToSpeechProvider,
  type TranscribeFileOptions,
  type TranscribeFileResult,
  type TtsSynthesizeOptions,
} from '../../../src/speech/types.js';

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;

/** Server → client frames; times are seconds of stream audio (see service/server.py). */
type ServiceMessage =
  | { type: 'SpeechStarted'; timestamp: number }
  | { type: 'Results'; text: string; is_final: boolean; speech_final: boolean; start: number | null; end: number | null; confidence?: number }
  | { type: 'Error'; message: string }
  | { type: 'Closed'; stats: Record<string, number> };

export interface LocalSttOptions {
  /** e.g. http://127.0.0.1:8701 */
  baseUrl: string;
  /** Engine loaded in the service: moonshine-small, zipformer, … */
  engine: string;
}

class LocalSttSession implements SttSession {
  private readonly transcriptCbs: Array<(e: SttTranscriptEvent) => void> = [];
  private readonly speechStartedCbs: Array<(e: SttSpeechStartedEvent) => void> = [];
  private audioSentSeconds = 0;
  private closed = false;
  private ended = false;
  private closeWaiters: Array<() => void> = [];
  /** Server-side processing stats, delivered with the Closed frame. */
  serverStats: Record<string, number> | undefined;

  constructor(
    private readonly socket: WebSocket,
    private readonly onError?: (err: Error) => void,
  ) {}

  sendAudio(frame: PcmFrame): void {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN) return;
    const bytes = new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength).slice();
    this.socket.send(bytes);
    this.audioSentSeconds += frame.pcm.length / frame.sampleRate;
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.ended = true;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // A late last final would be dropped and scored as misheard words.
        this.onError?.(new Error(`local STT did not close within ${CLOSE_TIMEOUT_MS} ms; the last final may be missing`));
        resolve();
      }, CLOSE_TIMEOUT_MS);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onTranscript(cb: (e: SttTranscriptEvent) => void): void {
    this.transcriptCbs.push(cb);
  }

  onSpeechStarted(cb: (e: SttSpeechStartedEvent) => void): void {
    this.speechStartedCbs.push(cb);
  }

  cancel(): void {
    this.ended = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'cancelled');
  }

  handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as ServiceMessage;
    const agoMs = (t: number): number => Math.max(0, Math.round((this.audioSentSeconds - t) * 1000));
    switch (msg.type) {
      case 'SpeechStarted':
        for (const cb of this.speechStartedCbs) cb({ startedAgoMs: agoMs(msg.timestamp) });
        return;
      case 'Results': {
        const event: SttTranscriptEvent = {
          text: msg.text,
          isFinal: msg.is_final,
          ...(msg.speech_final ? { speechFinal: true } : {}),
          ...(msg.confidence !== undefined ? { confidence: msg.confidence } : {}),
          ...(msg.start !== null && msg.end !== null && msg.text
            ? { speechStartedAgoMs: agoMs(msg.start), speechEndedAgoMs: agoMs(msg.end) }
            : {}),
        };
        for (const cb of this.transcriptCbs) cb(event);
        return;
      }
      case 'Error':
        this.onError?.(new Error(`local STT: ${msg.message}`));
        return;
      case 'Closed':
        this.serverStats = msg.stats;
        return;
    }
  }

  handleClose(code?: number, reason?: string): void {
    this.closed = true;
    for (const w of this.closeWaiters.splice(0)) w();
    if (!this.ended) this.onError?.(new Error(`local STT socket closed unexpectedly (${code ?? '?'}${reason ? `: ${reason}` : ''})`));
  }
}

export class LocalSttProvider implements SpeechToTextProvider, BatchSpeechToTextProvider {
  readonly id: string;

  constructor(private readonly opts: LocalSttOptions) {
    this.id = `local:${opts.engine}`;
  }

  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    const url = new URL('/stt/stream', this.opts.baseUrl.replace(/^http/, 'ws'));
    url.searchParams.set('engine', this.opts.engine);
    url.searchParams.set('sample_rate', String(opts.sampleRate));
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const session = new LocalSttSession(socket, opts.onError);
    socket.onmessage = ev => session.handleMessage(String(ev.data));
    socket.onclose = ev => session.handleClose(ev.code, ev.reason);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local STT connect timed out')), CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('local STT connect failed'));
      };
    });
    return session;
  }

  async transcribeFile(opts: TranscribeFileOptions): Promise<TranscribeFileResult> {
    const url = new URL('/stt/batch', this.opts.baseUrl);
    url.searchParams.set('engine', this.opts.engine);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': opts.contentType ?? 'application/octet-stream' },
      body: new Uint8Array(opts.audio),
      signal: resolveBatchSignal(opts.signal),
    });
    if (!res.ok) throw new SttHttpError(res.status, `local STT batch failed with HTTP ${res.status}`);
    const body = (await res.json()) as { text: string };
    return { text: body.text };
  }
}

export interface LocalTtsOptions {
  baseUrl: string;
  engine: string;
  voice?: string;
}

export class LocalTtsProvider implements TextToSpeechProvider {
  readonly id: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly opts: LocalTtsOptions) {
    this.id = `local:${opts.engine}`;
  }

  async *synthesize(opts: TtsSynthesizeOptions): AsyncIterable<PcmFrame> {
    const controller = new AbortController();
    this.controllers.set(opts.streamId, controller);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(new URL('/tts', this.opts.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: this.opts.engine,
          text: opts.text,
          voice: opts.voiceId ?? this.opts.voice,
          sample_rate: opts.sampleRate ?? 24000,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new TtsHttpError(res.status, `local TTS failed with HTTP ${res.status}`);
      const sampleRate = Number(res.headers.get('x-sample-rate') ?? opts.sampleRate ?? 24000);
      const reader = res.body.getReader();
      let carry: Uint8Array | undefined;
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          let bytes = value;
          if (carry) {
            const merged = new Uint8Array(carry.byteLength + value.byteLength);
            merged.set(carry, 0);
            merged.set(value, carry.byteLength);
            bytes = merged;
            carry = undefined;
          }
          const aligned = bytes.byteLength - (bytes.byteLength % 2);
          if (aligned < bytes.byteLength) carry = bytes.slice(aligned);
          if (aligned === 0) continue;
          const pcm = new Int16Array(bytes.slice(0, aligned).buffer);
          yield { pcm, sampleRate, channels: 1 };
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      throw err;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.controllers.delete(opts.streamId);
    }
  }

  cancel(streamId: string): void {
    this.controllers.get(streamId)?.abort();
  }
}
