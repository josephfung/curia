import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '../../../logger.js';
import { DeepgramSttProvider } from './deepgram-stt.js';
import { SttHttpError, type SttTranscriptEvent } from './types.js';

type MockSocketPayload = string | Uint8Array;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0;
  binaryType?: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: MockSocketPayload[] = [];
  readonly url: string;
  readonly protocols?: string[];

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(data: MockSocketPayload): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(message: string): void {
    this.onerror?.({ message });
  }
}

describe('DeepgramSttProvider', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a Deepgram listen socket with PCM query params and token subprotocol auth', async () => {
    const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
    const sessionPromise = provider.startSession({ sampleRate: 16000, language: 'en' });
    const socket = MockWebSocket.instances[0];

    socket?.open();
    await sessionPromise;

    expect(socket).toBeDefined();
    expect(socket?.protocols).toEqual(['token', 'dg-key']);
    expect(socket?.binaryType).toBe('arraybuffer');

    const url = new URL(socket?.url ?? '');
    expect(url.origin).toBe('wss://api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('endpointing')).toBe('true');
    expect(url.searchParams.get('language')).toBe('en');
  });

  it('maps interim, final, and utterance-end transcript events', async () => {
    const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
    const sessionPromise = provider.startSession({ sampleRate: 16000 });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const session = await sessionPromise;
    const events: SttTranscriptEvent[] = [];
    session.onTranscript(event => events.push(event));

    socket.message(JSON.stringify({
      type: 'Results',
      is_final: false,
      speech_final: false,
      channel: { alternatives: [{ transcript: 'hel', confidence: 0.7 }] },
    }));
    socket.message(JSON.stringify({
      type: 'Results',
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: 'hello', confidence: 0.94 }] },
    }));
    socket.message(JSON.stringify({ type: 'UtteranceEnd' }));

    expect(events).toEqual([
      { text: 'hel', isFinal: false, confidence: 0.7 },
      { text: 'hello', isFinal: true, speechFinal: true, confidence: 0.94 },
      { text: '', isFinal: true, speechFinal: true },
    ]);
  });

  it('sends PCM bytes and closes cleanly on end', async () => {
    const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
    const sessionPromise = provider.startSession({ sampleRate: 16000 });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    const session = await sessionPromise;

    session.sendAudio({ pcm: new Int16Array([1, -2]), sampleRate: 16000, channels: 1 });
    await session.end();

    expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(socket.sent[0] as Uint8Array)).toEqual([1, 0, 254, 255]);
    expect(socket.sent.slice(1)).toEqual([
      JSON.stringify({ type: 'Finalize' }),
      JSON.stringify({ type: 'CloseStream' }),
    ]);
  });

  it('reports dropped connections through onError after the session opens', async () => {
    const onError = vi.fn();
    const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
    const sessionPromise = provider.startSession({ sampleRate: 16000, onError });
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await sessionPromise;

    socket.close(1006, 'network drop');

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('network drop');
  });

  it('rejects startSession when the socket errors before opening', async () => {
    const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
    const sessionPromise = provider.startSession({ sampleRate: 16000 });
    const socket = MockWebSocket.instances[0]!;

    socket.fail('auth failed');

    await expect(sessionPromise).rejects.toThrow('auth failed');
  });

  describe('transcribeFile', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('posts audio bytes to Deepgram prerecorded REST and returns the transcript', async () => {
      const audio = new Uint8Array([1, 2, 3, 4]);
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        metadata: { duration: 1.25 },
        results: {
          channels: [{ alternatives: [{ transcript: 'hello world', confidence: 0.91 }] }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);

      const provider = new DeepgramSttProvider('dg-key', createSilentLogger());
      const result = await provider.transcribeFile({
        audio,
        contentType: 'audio/mp4',
        language: 'en',
      });

      expect(result).toEqual({ text: 'hello world', confidence: 0.91, durationSeconds: 1.25 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      const parsedUrl = new URL(url as string);
      expect(parsedUrl.origin).toBe('https://api.deepgram.com');
      expect(parsedUrl.pathname).toBe('/v1/listen');
      expect(parsedUrl.searchParams.get('model')).toBe('nova-3');
      expect(parsedUrl.searchParams.get('smart_format')).toBe('true');
      expect(parsedUrl.searchParams.get('language')).toBe('en');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Token dg-key',
        'Content-Type': 'audio/mp4',
      });
      expect(init.body).toEqual(audio);
    });

    it('throws SttHttpError on non-2xx responses', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
      const provider = new DeepgramSttProvider('dg-key', createSilentLogger());

      try {
        await provider.transcribeFile({ audio: new Uint8Array([1]) });
        expect.unreachable('expected SttHttpError');
      } catch (err) {
        expect(err).toBeInstanceOf(SttHttpError);
        expect((err as SttHttpError).statusCode).toBe(401);
        expect((err as SttHttpError).message).toBe('Deepgram STT request failed with HTTP 401');
      }
    });

    it('rejects empty audio before calling the network', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const provider = new DeepgramSttProvider('dg-key', createSilentLogger());

      await expect(provider.transcribeFile({ audio: new Uint8Array() }))
        .rejects.toThrow('non-empty audio');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
