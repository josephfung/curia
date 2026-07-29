import { describe, expect, it } from 'vitest';
import { classifyError } from '../errors/classify.js';
import type {
  BatchSpeechToTextProvider,
  BatchTextToSpeechProvider,
  PcmFrame,
  SpeechToTextProvider,
  SttSession,
  SttTranscriptEvent,
  TextToSpeechProvider,
} from './types.js';
import {
  AUDIO_FILE_CONTENT_TYPE,
  SpeechHttpError,
  SttHttpError,
  TtsHttpError,
  resolveBatchSignal,
} from './types.js';

describe('speech provider types', () => {
  it('are structural and do not require concrete provider classes', async () => {
    const frame: PcmFrame = {
      pcm: new Int16Array([1, -1]),
      sampleRate: 16000,
      channels: 1,
    };

    const events: SttTranscriptEvent[] = [];
    const session: SttSession = {
      sendAudio(sentFrame) {
        expect(sentFrame).toBe(frame);
      },
      async end() {},
      onTranscript(cb) {
        cb({ text: 'hello', isFinal: true, speechFinal: true, confidence: 0.9 });
      },
      cancel() {},
    };

    const stt: SpeechToTextProvider = {
      id: 'structural-stt',
      async startSession() {
        return session;
      },
    };

    const tts: TextToSpeechProvider = {
      id: 'structural-tts',
      async *synthesize() {
        yield frame;
      },
      cancel() {},
    };

    const batchStt: BatchSpeechToTextProvider = {
      id: 'structural-batch-stt',
      async transcribeFile() {
        return { text: 'from file', confidence: 0.8 };
      },
    };

    const batchTts: BatchTextToSpeechProvider = {
      id: 'structural-batch-tts',
      async synthesizeToFile(opts) {
        return {
          bytes: new Uint8Array([1]),
          format: opts.format,
          contentType: AUDIO_FILE_CONTENT_TYPE[opts.format],
          sampleRate: 24000,
        };
      },
    };

    const started = await stt.startSession({ sampleRate: 16000 });
    started.onTranscript(event => events.push(event));
    started.sendAudio(frame);

    const frames: PcmFrame[] = [];
    for await (const synthesized of tts.synthesize({ text: 'hello', streamId: 's1' })) {
      frames.push(synthesized);
    }

    expect(events).toEqual([{ text: 'hello', isFinal: true, speechFinal: true, confidence: 0.9 }]);
    expect(frames).toEqual([frame]);
    expect(await batchStt.transcribeFile({ audio: new Uint8Array([1]) })).toEqual({
      text: 'from file',
      confidence: 0.8,
    });
    expect(await batchTts.synthesizeToFile({ text: 'hi', format: 'wav' })).toMatchObject({
      format: 'wav',
      contentType: 'audio/wav',
    });
  });

  it('SpeechHttpError exposes status for classifyError and statusCode for callers', () => {
    const sttErr = new SttHttpError(401, 'Deepgram STT request failed with HTTP 401');
    const ttsErr = new TtsHttpError(503, 'Cartesia TTS request failed with HTTP 503');

    expect(sttErr).toBeInstanceOf(SpeechHttpError);
    expect(sttErr.status).toBe(401);
    expect(sttErr.statusCode).toBe(401);
    expect(ttsErr.status).toBe(503);
    expect(ttsErr.statusCode).toBe(503);

    expect(classifyError(sttErr, 'stt:deepgram')).toMatchObject({
      type: 'AUTH_FAILURE',
      context: { status: 401 },
    });
    expect(classifyError(ttsErr, 'tts:cartesia')).toMatchObject({
      type: 'PROVIDER_ERROR',
      context: { status: 503 },
    });
  });

  it('resolveBatchSignal always returns a signal (default timeout when caller omits)', () => {
    const signal = resolveBatchSignal();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const controller = new AbortController();
    const combined = resolveBatchSignal(controller.signal);
    expect(combined).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });
});
