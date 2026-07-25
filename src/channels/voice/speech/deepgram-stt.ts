import type { Logger } from '../../../logger.js';
import type {
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttSessionOptions,
  SttTranscriptEvent,
} from './types.js';

interface ProviderWebSocketMessageEvent {
  data: unknown;
}

interface ProviderWebSocketCloseEvent {
  code?: number;
  reason?: string;
}

interface ProviderWebSocket {
  readyState: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: ProviderWebSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: ProviderWebSocketCloseEvent) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

type ProviderWebSocketConstructor = new (url: string, protocols?: string[]) => ProviderWebSocket;

const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

function getWebSocketConstructor(): ProviderWebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: ProviderWebSocketConstructor }).WebSocket;
  if (!ctor) {
    throw new Error('Deepgram STT requires a global WebSocket implementation');
  }
  return ctor;
}

function buildDeepgramUrl(opts: SttSessionOptions): string {
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(opts.sampleRate));
  url.searchParams.set('channels', '1');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('endpointing', 'true');
  url.searchParams.set('utterance_end_ms', '1000');
  url.searchParams.set('vad_events', 'true');
  if (opts.language) {
    url.searchParams.set('language', opts.language);
  }
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseConfidence(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseDeepgramTranscript(data: unknown): SttTranscriptEvent | undefined {
  const payload = asRecord(data);
  if (!payload) return undefined;

  if (payload.type === 'UtteranceEnd') {
    return { text: '', isFinal: true, speechFinal: true };
  }

  if (payload.type !== undefined && payload.type !== 'Results') {
    return undefined;
  }

  const channel = asRecord(payload.channel);
  const alternatives = Array.isArray(channel?.alternatives) ? channel.alternatives : [];
  const firstAlternative = asRecord(alternatives[0]);
  const transcript = typeof firstAlternative?.transcript === 'string' ? firstAlternative.transcript : '';
  const speechFinal = payload.speech_final === true;

  if (!transcript && !speechFinal) {
    return undefined;
  }

  return {
    text: transcript,
    isFinal: payload.is_final === true || speechFinal,
    ...(speechFinal ? { speechFinal } : {}),
    ...(parseConfidence(firstAlternative?.confidence) !== undefined
      ? { confidence: parseConfidence(firstAlternative?.confidence) }
      : {}),
  };
}

function normalizeSocketError(event: unknown): Error {
  const record = asRecord(event);
  const message = typeof record?.message === 'string' ? record.message : 'Deepgram STT socket error';
  return new Error(message);
}

function closeDescription(event: ProviderWebSocketCloseEvent): string {
  const code = event.code ?? 'unknown';
  const reason = event.reason ? `: ${event.reason}` : '';
  return `Deepgram STT socket closed unexpectedly (${code}${reason})`;
}

class DeepgramSttSession implements SttSession {
  private readonly transcriptCallbacks: Array<(e: SttTranscriptEvent) => void> = [];
  private readonly closeWaiters: Array<() => void> = [];
  private ended = false;
  private cancelled = false;
  private closed = false;

  constructor(
    private readonly socket: ProviderWebSocket,
    private readonly logger: Logger,
    private readonly onConnectionError?: (err: Error) => void,
  ) {}

  sendAudio(frame: PcmFrame): void {
    if (this.cancelled || this.ended || this.socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }

    const bytes = new Uint8Array(frame.pcm.byteLength);
    bytes.set(new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength));
    this.socket.send(bytes);
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.ended = true;

    if (this.socket.readyState === WEBSOCKET_OPEN) {
      this.socket.send(JSON.stringify({ type: 'Finalize' }));
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }

    if (this.socket.readyState === WEBSOCKET_OPEN || this.socket.readyState === WEBSOCKET_CLOSING) {
      this.socket.close(1000, 'stt session ended');
    }

    await this.waitForClose();
  }

  onTranscript(cb: (e: SttTranscriptEvent) => void): void {
    this.transcriptCallbacks.push(cb);
  }

  cancel(): void {
    if (this.closed) return;
    this.cancelled = true;
    if (this.socket.readyState === WEBSOCKET_OPEN || this.socket.readyState === WEBSOCKET_CLOSING) {
      this.socket.close(1000, 'stt session cancelled');
    }
  }

  handleMessage(data: unknown): void {
    if (this.cancelled) return;

    let parsed: unknown = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data) as unknown;
      } catch (err) {
        this.logger.warn({ err }, 'Deepgram STT returned non-JSON message');
        return;
      }
    }

    const event = parseDeepgramTranscript(parsed);
    if (!event) return;

    for (const cb of this.transcriptCallbacks) {
      try {
        cb(event);
      } catch (err) {
        this.logger.warn({ err }, 'Deepgram STT transcript callback failed');
      }
    }
  }

  handleError(event: unknown): Error {
    const err = normalizeSocketError(event);
    if (!this.ended && !this.cancelled) {
      this.onConnectionError?.(err);
    }
    return err;
  }

  handleClose(event: ProviderWebSocketCloseEvent): void {
    this.closed = true;
    for (const resolve of this.closeWaiters.splice(0)) {
      resolve();
    }

    if (!this.ended && !this.cancelled) {
      this.onConnectionError?.(new Error(closeDescription(event)));
    }
  }

  private waitForClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise(resolve => {
      this.closeWaiters.push(resolve);
    });
  }
}

export class DeepgramSttProvider implements SpeechToTextProvider {
  readonly id = 'deepgram';

  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
  ) {}

  async startSession(opts: SttSessionOptions): Promise<SttSession> {
    const WebSocketCtor = getWebSocketConstructor();
    const socket = new WebSocketCtor(buildDeepgramUrl(opts), ['token', this.apiKey]);
    socket.binaryType = 'arraybuffer';

    const session = new DeepgramSttSession(socket, this.logger, opts.onError);

    return await new Promise<SttSession>((resolve, reject) => {
      let settled = false;

      socket.onopen = () => {
        settled = true;
        resolve(session);
      };

      socket.onmessage = event => {
        session.handleMessage(event.data);
      };

      socket.onerror = event => {
        const err = session.handleError(event);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      socket.onclose = event => {
        session.handleClose(event);
        if (!settled) {
          settled = true;
          reject(new Error(closeDescription(event)));
        }
      };
    });
  }
}
