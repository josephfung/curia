import { describe, expect, it } from 'vitest';
import { createSilentLogger } from '../logger.js';
import { FakeSttProvider } from './fake-stt.js';
import { FakeTtsProvider } from './fake-tts.js';
import { SttHttpError, TtsHttpError } from './types.js';
import { SpeechMediaService } from './media-service.js';

describe('SpeechMediaService', () => {
  it('transcribes an audio file via the batch STT provider', async () => {
    const stt = new FakeSttProvider({
      fileTranscript: { text: 'voice note body', confidence: 0.88, durationSeconds: 2 },
    });
    const tts = new FakeTtsProvider();
    const service = new SpeechMediaService({ stt, tts, logger: createSilentLogger() });

    const audio = new Uint8Array([9, 8, 7]);
    const result = await service.transcribe({
      audio,
      contentType: 'audio/ogg',
      language: 'en',
    });

    expect(result).toEqual({
      ok: true,
      value: { text: 'voice note body', confidence: 0.88, durationSeconds: 2 },
    });
    expect(stt.fileRequests).toEqual([{
      audio,
      contentType: 'audio/ogg',
      language: 'en',
      signal: undefined,
    }]);
  });

  it('synthesizes text to an encoded audio file via the batch TTS provider', async () => {
    const bytes = new Uint8Array([0xaa, 0xbb]);
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider({ fileBytes: bytes, sampleRate: 16000 });
    const service = new SpeechMediaService({ stt, tts, logger: createSilentLogger() });

    const result = await service.synthesize({
      text: 'spoken reply',
      format: 'mp3',
      voiceId: 'v1',
      bitRate: 96000,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        bytes,
        format: 'mp3',
        contentType: 'audio/mpeg',
        sampleRate: 16000,
      },
    });
    expect(tts.fileRequests[0]).toMatchObject({
      text: 'spoken reply',
      format: 'mp3',
      voiceId: 'v1',
      bitRate: 96000,
    });
  });

  it('maps SttHttpError to a structured AgentError instead of dropping', async () => {
    const stt = new FakeSttProvider({
      fileError: new SttHttpError(401, 'Deepgram STT request failed with HTTP 401'),
    });
    const service = new SpeechMediaService({
      stt,
      tts: new FakeTtsProvider(),
      logger: createSilentLogger(),
    });

    const result = await service.transcribe({ audio: new Uint8Array([1]) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      type: 'AUTH_FAILURE',
      source: 'stt:fake-stt',
      retryable: false,
      context: { statusCode: 401 },
    });
    expect(result.error.message).toContain('401');
  });

  it('maps TtsHttpError to a structured AgentError instead of dropping', async () => {
    const tts = new FakeTtsProvider({
      fileError: new TtsHttpError(503, 'Cartesia TTS request failed with HTTP 503'),
    });
    const service = new SpeechMediaService({
      stt: new FakeSttProvider(),
      tts,
      logger: createSilentLogger(),
    });

    const result = await service.synthesize({ text: 'hi', format: 'wav' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      type: 'PROVIDER_ERROR',
      source: 'tts:fake-tts',
      retryable: true,
      context: { statusCode: 503 },
    });
  });

  it('maps unexpected errors via classifyError', async () => {
    const stt = new FakeSttProvider({ fileError: new Error('boom') });
    const service = new SpeechMediaService({
      stt,
      tts: new FakeTtsProvider(),
      logger: createSilentLogger(),
    });

    const result = await service.transcribe({ audio: new Uint8Array([1]) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.type).toBe('UNKNOWN');
    expect(result.error.message).toContain('boom');
  });
});
